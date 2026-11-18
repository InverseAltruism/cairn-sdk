// A stand-in for the Cairn Wallet's `window.cairn` provider, for an integrator's own tests. It answers with the
// envelopes of the wallet's docs/PROVIDER.md and performs its discovery handshake. It holds no key and signs
// nothing: every txid, signature and public key it returns is a placeholder that no verifier accepts.
// Only type imports from the rest of the SDK, so this entry adds nothing to the main bundle.

import type {
  CairnProvider,
  ConnectResult,
  ProviderReply,
  SiwcResult,
  TxResult,
  WalletCapabilities,
  WalletPermission,
} from "./connect.js";
import type { CairnErrorCode } from "./errors.js";

/** The methods the wallet lists in `getCapabilities().methods`; each can be scripted. */
export type MockMethod =
  | "connect" | "getAddress" | "signInWithCsd" | "getPermissions" | "requestPermissions" | "revokePermissions"
  | "propose" | "attest" | "send" | "fillOffer" | "sealClaim" | "revealClaim";

// The mock's one method list: getCapabilities() returns it, and test/testing.test.ts pins it to the wallet's.
const METHODS: readonly MockMethod[] = ["connect", "getAddress", "signInWithCsd", "getPermissions", "requestPermissions",
  "revokePermissions", "propose", "attest", "send", "fillOffer", "sealClaim", "revealClaim"];
const SUBMITS = new Set<MockMethod>(["propose", "attest", "send", "fillOffer", "sealClaim"]);

/**
 * One answer of a method.
 * - `approve`: the user approved. A transaction method answers `{ ok: true, result: { ok: true, txid, sighashMatch:
 *   true } }`; `result` replaces the whole inner result of any method.
 * - `reject`: the outer refusal `{ ok: false, error, code }` (`USER_REJECTED`, `WALLET_LOCKED`, `RATE_LIMITED`, ...).
 * - `refuse`: approved, then refused by the wallet: `{ ok: true, result: { ok: false, code, error, sighashMatch:
 *   false, txid? } }` (`FILL_UNSAFE`, `INSUFFICIENT`, `SUBMIT_MAYBE_INFLIGHT` with its txid, ...).
 * - `reply`: this envelope, sent as given.
 */
export type MockAnswer =
  | { kind: "approve"; txid?: string; result?: unknown }
  | { kind: "reject"; code: CairnErrorCode; error?: string }
  | { kind: "refuse"; code: CairnErrorCode; error?: string; txid?: string }
  | { kind: "reply"; reply: ProviderReply<unknown> };

export interface MockCairnOptions {
  /** The account's address (default `0x` and forty `1`s). */
  address?: string;
  /** `provider.version` and `getCapabilities().version` (default "0.3.3-mock"). */
  version?: string;
  /** The `invoker` of the permission grant (default "https://app.example"). */
  origin?: string;
  /** The sign-in `chainId` (default the CSD mainnet CAIP-2 id). */
  chainId?: string;
  /** Start as a site the user already connected: getPermissions returns the grant before any connect. */
  connected?: boolean;
  /** The txid of every approved transaction; by default each gets its own placeholder. */
  txid?: string;
  /** A standing answer per method, used when no `next()` answer is queued (default: approve). */
  answers?: Partial<Record<MockMethod, MockAnswer>>;
}

export interface MockCall {
  method: MockMethod | "signIn" | "getCapabilities";
  /** Present when the method was called with an argument (the params object, or revealClaim's txid). */
  params?: unknown;
}

export type DisconnectReason = "locked" | "idle-lock" | "disconnected" | "revoked";

export interface MockCapabilities extends WalletCapabilities {
  siwc: string;
  discovery: "csd";
  events: string[];
  methods: MockMethod[];
}

export interface MockCairnProvider extends CairnProvider {
  getCapabilities(): Promise<MockCapabilities>;
  getPermissions(): Promise<ProviderReply<WalletPermission[]>>;
  requestPermissions(): Promise<ProviderReply<WalletPermission[]>>;
  revokePermissions(): Promise<ProviderReply<{ revoked: boolean }>>;
  on(event: string, handler: (data: unknown) => void): void;
  removeListener(event: string, handler: (data: unknown) => void): void;
  /** The address the mock answers with. */
  readonly address: string;
  /** Every call made, in order. */
  readonly calls: MockCall[];
  /** Queue the next answer of `method`; queued answers are used once each, in order. */
  next(method: MockMethod, answer: MockAnswer): void;
  /** Send an event to the handlers added with `on`: `accountsChanged` always carries `[]`, as the wallet's does. */
  emit(event: "accountsChanged"): void;
  emit(event: "disconnect", reason: DisconnectReason): void;
}

// csd-siwc's CSD_CHAIN_MAINNET; csd-siwc is not a runtime dependency, so test/testing.test.ts pins this copy.
const CSD_MAINNET_CHAIN_ID = "csd:00000052c2821f71b19c3d79dfabfb12";

/**
 * A mock of the Cairn Wallet's provider for tests, not a wallet: it holds no key and signs nothing. It answers
 * every method with the wallet's envelope, records each call and approves unless an answer is scripted. A plain,
 * unfrozen object, so a test may also replace one of its methods.
 */
export function mockCairnProvider(options: MockCairnOptions = {}): MockCairnProvider {
  const address = options.address ?? `0x${"11".repeat(20)}`;
  const version = options.version ?? "0.3.3-mock";
  const origin = options.origin ?? "https://app.example";
  const calls: MockCall[] = [];
  const queued = new Map<MockMethod, MockAnswer[]>();
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  let grantedAt: number | null = options.connected ? Date.now() : null;
  let txCount = 0;

  const record = (method: MockCall["method"], args: unknown[]) => {
    calls.push(args.length ? { method, params: args[0] } : { method });
  };
  const fire = (event: string, data: unknown) => {
    for (const h of [...(handlers.get(event) ?? [])]) {
      // As in the wallet, a throwing handler does not stop the others.
      try { h(data); } catch (e) { console.error(`[cairn-sdk/testing] a handler for ${event} threw`, e); }
    }
  };
  const grant = (): WalletPermission[] => (grantedAt === null ? [] : [{ invoker: origin, accounts: [address], grantedAt }]);

  // `approved` builds the inner result and applies the method's effect on consent; it runs only for `approve`.
  const answer = <T>(method: MockMethod, args: unknown[], approved: (a: { txid?: string }) => unknown): Promise<ProviderReply<T>> => {
    record(method, args);
    const a = queued.get(method)?.shift() ?? options.answers?.[method] ?? { kind: "approve" };
    let reply: ProviderReply<unknown>;
    if (a.kind === "reply") reply = a.reply;
    else if (a.kind === "reject") reply = { ok: false, error: a.error ?? a.code, code: a.code };
    else if (a.kind === "refuse") {
      reply = { ok: true, result: { ok: false, error: a.error ?? a.code, code: a.code, sighashMatch: false, ...(a.txid === undefined ? {} : { txid: a.txid }) } };
    } else {
      const inner = approved(a);
      reply = { ok: true, result: a.result ?? inner };
    }
    return Promise.resolve(reply as ProviderReply<T>);
  };
  const submit = (method: MockMethod) => (...args: unknown[]) => answer<TxResult>(method, args, (a) => {
    if (!SUBMITS.has(method)) return { ok: true };
    return { ok: true, txid: a.txid ?? options.txid ?? `0x${(++txCount).toString(16).padStart(64, "0")}`, sighashMatch: true };
  });
  const consent = (): void => { grantedAt ??= Date.now(); };

  const provider: MockCairnProvider = {
    isCairn: true,
    version,
    address,
    calls,
    connect: (...args: unknown[]) => answer<ConnectResult>("connect", args, () => { consent(); return { addr: address }; }),
    getAddress: (...args: unknown[]) => answer<ConnectResult>("getAddress", args, () => { consent(); return { addr: address }; }),
    requestPermissions: (...args: unknown[]) => answer<WalletPermission[]>("requestPermissions", args, () => { consent(); return grant(); }),
    getPermissions: (...args: unknown[]) => answer<WalletPermission[]>("getPermissions", args, grant),
    revokePermissions: (...args: unknown[]) => answer<{ revoked: boolean }>("revokePermissions", args, () => {
      const revoked = grantedAt !== null;
      grantedAt = null;
      // The wallet sends both events before it answers.
      fire("accountsChanged", []);
      fire("disconnect", { reason: "revoked" });
      return { revoked };
    }),
    signInWithCsd: (...args: unknown[]) => answer<SiwcResult>("signInWithCsd", args, () => ({
      account: address,
      pub33: `0x02${"00".repeat(32)}`,
      sig64: `0x${"00".repeat(64)}`,
      message: `mock sign-in, not signed (nonce ${String((args[0] as { nonce?: unknown } | undefined)?.nonce)})`,
      chainId: options.chainId ?? CSD_MAINNET_CHAIN_ID,
    })),
    signIn: (...args: unknown[]) => {
      record("signIn", args);
      return Promise.resolve({ ok: false, error: "signIn is first-party only; use signInWithCsd", code: "FIRST_PARTY_ONLY" });
    },
    propose: submit("propose"),
    attest: submit("attest"),
    send: submit("send"),
    fillOffer: submit("fillOffer"),
    sealClaim: submit("sealClaim"),
    revealClaim: submit("revealClaim"),
    getCapabilities: (...args: unknown[]) => {
      record("getCapabilities", args);
      return Promise.resolve({ version, siwc: "1", discovery: "csd", events: ["accountsChanged", "disconnect"], methods: [...METHODS] });
    },
    on: (event, handler) => {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      set.add(handler);
    },
    removeListener: (event, handler) => { handlers.get(event)?.delete(handler); },
    next: (method, a) => {
      const q = queued.get(method);
      if (q) q.push(a); else queued.set(method, [a]);
    },
    emit: (event: "accountsChanged" | "disconnect", reason?: DisconnectReason) => {
      fire(event, event === "accountsChanged" ? [] : { reason });
    },
  };
  return provider;
}

/** A window or any object that dispatches events like one; its own `Event`/`CustomEvent` are used when present. */
export interface MockCairnTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  dispatchEvent(event: Event): boolean;
  Event?: typeof Event;
  CustomEvent?: typeof CustomEvent;
}

// crypto.randomUUID exists only in a secure context (not on an http page other than localhost); getRandomValues does.
const randomUuid = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const MOCK_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="18" fill="#0e1116"/></svg>')}`;

/**
 * Put `provider` at `target.cairn` and announce it as the wallet does: `cairn#initialized`, then
 * `csd:announceProvider` (rdns `com.cairn-substrate.wallet`, one uuid per install) at install and on each
 * `csd:requestProvider`. Touches only `target`. Returns the uninstall function, which removes the listener and
 * restores whatever `target.cairn` was before. Throws when `target.cairn` cannot be replaced (a real wallet's
 * provider is not configurable).
 */
export function installMockCairn(target: MockCairnTarget, provider: CairnProvider): () => void {
  const before = Object.getOwnPropertyDescriptor(target, "cairn");
  if (before && !before.configurable) throw new Error("installMockCairn: target.cairn is not configurable (is a wallet installed?)");
  const Ev = target.Event ?? Event;
  const Custom = target.CustomEvent ?? CustomEvent;
  Object.defineProperty(target, "cairn", { value: provider, writable: false, configurable: true, enumerable: true });
  target.dispatchEvent(new Ev("cairn#initialized"));
  const info = Object.freeze({ uuid: randomUuid(), name: "Cairn Wallet", icon: MOCK_ICON, rdns: "com.cairn-substrate.wallet" });
  const detail = Object.freeze({ info, provider });
  const announce = () => { target.dispatchEvent(new Custom("csd:announceProvider", { detail })); };
  target.addEventListener("csd:requestProvider", announce);
  announce();
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    target.removeEventListener("csd:requestProvider", announce);
    if (before) Object.defineProperty(target, "cairn", before);
    else delete (target as { cairn?: unknown }).cairn;
  };
}
