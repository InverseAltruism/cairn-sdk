// Wallet connector — a thin, typed, documented wrapper over the Cairn Wallet's
// injected `window.cairn` provider. This is the source of truth for the dApp-facing
// wallet API contract.
//
// SECURITY MODEL (mirrors how MetaMask actually works — see the wallet's boundary):
//   • connect()/getAddress() grant ADDRESS VISIBILITY. After the user approves an
//     origin once, the wallet may answer these silently (per-origin "connected sites").
//   • Every signing / fund-moving call — signIn, send, propose, attest, sealClaim,
//     revealClaim — ALWAYS opens the wallet's clear-signing approval window, every
//     time, regardless of connection state. Connection NEVER auto-approves a signature.
// This module cannot weaken that: it only relays calls to the extension, which owns
// the keys and the approval flow. The private key is never exposed to the page.

import {
  NotInstalledError,
  UnsupportedMethodError,
  mapProviderError,
} from "./errors.js";

/** Result of `connect()` / `getAddress()`. */
export interface ConnectResult {
  addr: string;
}

/** Generic on-chain submit result returned by signing methods (shape from the node/proxy). */
export interface TxResult {
  ok?: boolean;
  txid?: string;
  [k: string]: unknown;
}

/** Sign-in (passwordless auth) result — a signature over a login nonce, never a tx sighash. */
export interface SignInResult {
  addr?: string;
  pub33?: string;
  sig64?: string;
  nonce?: string;
  [k: string]: unknown;
}

/** Low-level Propose params (matches the wallet exactly). Prefer `cairn.board.propose()` for ergonomics. */
export interface ProposeParams {
  domain: string;
  payloadHash: string;
  uri: string;
  expiresEpoch: number;
  fee: number;
}

/** Attest (support) params. */
export interface AttestParams {
  proposalId: string;
  score: number;
  confidence: number;
  fee: number;
}

/** Plain CSD transfer. The wallet always selects its own inputs and returns change to itself. */
export type SendParams =
  | { to: string; amount: number; fee?: number }
  | { outputs: { to: string; value: number }[]; fee?: number };

/** Commit-reveal sealed claim. The salt is generated inside the wallet and never leaves it. */
export interface SealClaimParams {
  domain?: string;
  claim: string;
  fee?: number;
}

/** Atomic fill (CairnX delivery-vs-payment): an Attest + payment outputs in ONE tx. */
export interface FillParams {
  proposalId: string;
  outputs: { to: string; value: number }[];
  score?: number;
  confidence?: number;
  fee?: number;
}

/**
 * Audience-bound "Sign in with CSD" (SIWC) params — the secure third-party login. The wallet binds
 * the REAL requesting origin as the message `domain` (from the unforgeable sender.origin, NEVER this
 * field) plus your server `nonce`, chain id, and a validity window, and returns only the signed
 * artifact. The relying party MUST verify it server-side (see below).
 */
export interface SiwcParams {
  /** Server-issued, single-use, >=8 alphanumeric (use `generateNonce()` from @inversealtruism/csd-siwc). */
  nonce: string;
  /** Optional one-line human statement shown in the wallet (no newline). */
  statement?: string;
  /** Subject URI; defaults to the origin root. If given, MUST be on the requesting site. */
  uri?: string;
  /** Validity window in seconds (wallet clamps 60..3600, default 600). */
  expirationSecs?: number;
  notBeforeSecs?: number;
  requestId?: string;
  resources?: string[];
  /** Optional cross-check only — if set it MUST equal the requesting origin's host, else refused. */
  domain?: string;
}

/**
 * SIWC result — the signed artifact. VERIFY SERVER-SIDE with `verifySiwc` from
 * `@inversealtruism/csd-siwc` (check domain==your-origin, nonce==your-issued-single-use-nonce,
 * chainId, time window, signature, hash160(pub33)==account), THEN issue your OWN session. The
 * signature is proof-of-control, NEVER a bearer token.
 */
export interface SiwcResult {
  account: string;
  pub33: string;
  sig64: string;
  /** The exact canonical SIWC message that was signed (verify the signature over this). */
  message: string;
  /** CAIP-2 chain id the sign-in is bound to. */
  chainId: string;
}

/** Wallet feature/capability descriptor (feature-detection; older wallets may not expose it). */
export interface WalletCapabilities {
  version: string;
  /** SIWC byte-contract version, e.g. "1", when audience-bound sign-in is supported. */
  siwc?: string;
  methods?: string[];
  [k: string]: unknown;
}

/** The raw provider object the extension injects at `window.cairn`. */
export interface CairnProvider {
  isCairn: true;
  version: string;
  connect(): Promise<ProviderReply<ConnectResult>>;
  getAddress(): Promise<ProviderReply<ConnectResult>>;
  /** @deprecated First-party-only legacy login. Third parties MUST use `signInWithCsd`. */
  signIn(): Promise<ProviderReply<SignInResult>>;
  /** Audience-bound "Sign in with CSD" — the secure third-party login. */
  signInWithCsd(p: SiwcParams): Promise<ProviderReply<SiwcResult>>;
  propose(p: ProposeParams): Promise<ProviderReply<TxResult>>;
  attest(p: AttestParams): Promise<ProviderReply<TxResult>>;
  send(p: SendParams): Promise<ProviderReply<TxResult>>;
  fillOffer(p: FillParams): Promise<ProviderReply<TxResult>>;
  sealClaim(p: SealClaimParams): Promise<ProviderReply<TxResult>>;
  revealClaim(txid: string): Promise<ProviderReply<TxResult>>;
  /** Feature/capability detection (optional; absent on older wallets). */
  getCapabilities?(): Promise<WalletCapabilities>;
}

/** Every provider call resolves to this discriminated reply (never rejects). */
export type ProviderReply<T> = { ok: true; result: T } | { ok: false; error: string };

declare global {
  interface Window {
    cairn?: CairnProvider;
  }
}

export interface DetectOptions {
  /** How long to wait for the provider to announce itself (ms, default 3000). */
  timeoutMs?: number;
}

/**
 * Resolve `window.cairn`, waiting for the wallet's `cairn#initialized` event if the
 * content script hasn't injected yet. Throws `NotInstalledError` on timeout or
 * outside a browser.
 */
export function detectProvider(opts: DetectOptions = {}): Promise<CairnProvider> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new NotInstalledError("Not running in a browser — `window.cairn` is unavailable."));
      return;
    }
    if (window.cairn?.isCairn) {
      resolve(window.cairn);
      return;
    }
    let done = false;
    const onInit = () => {
      if (done) return;
      if (window.cairn?.isCairn) {
        done = true;
        cleanup();
        resolve(window.cairn);
      }
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new NotInstalledError());
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("cairn#initialized", onInit);
    };
    window.addEventListener("cairn#initialized", onInit);
    // Race: the event may have fired before this listener attached.
    onInit();
  });
}

/** True if the Cairn Wallet is already present (no waiting). */
export function isInstalled(): boolean {
  return typeof window !== "undefined" && !!window.cairn?.isCairn;
}

/** Unwrap a provider reply, throwing a typed error on `{ ok:false }`. */
function unwrap<T>(reply: ProviderReply<T>): T {
  if (reply && reply.ok) return reply.result;
  throw mapProviderError(reply?.error ?? "Unknown wallet error");
}

/**
 * High-level, typed wallet handle. Construct via `connect()` or `new WalletConnection(provider)`.
 * Methods throw `UserRejectedError` / `WalletLockedError` / `UnsupportedMethodError` on failure.
 */
export class WalletConnection {
  readonly provider: CairnProvider;
  private _addr: string | null = null;

  constructor(provider: CairnProvider) {
    this.provider = provider;
  }

  /** The wallet's version string (e.g. "0.2.x"). */
  get version(): string {
    return this.provider.version;
  }

  /** The connected address, if `connect()`/`getAddress()` has resolved. */
  get address(): string | null {
    return this._addr;
  }

  /** Request connection. First time per origin prompts the user; afterwards may be silent. */
  async connect(): Promise<string> {
    const { addr } = unwrap(await this.provider.connect());
    this._addr = addr;
    return addr;
  }

  /** Get the connected address (does not force a new connection prompt if already consented). */
  async getAddress(): Promise<string> {
    const { addr } = unwrap(await this.provider.getAddress());
    this._addr = addr;
    return addr;
  }

  /**
   * @deprecated First-party-only legacy login (it authenticates against the wallet's own configured
   * server and is rejected from third-party origins). Use {@link signInWithCsd} for any site.
   * Passwordless sign-in: a signature over a login nonce (always prompts; structurally cannot sign a tx).
   */
  signIn(): Promise<SignInResult> {
    return Promise.resolve(this.provider.signIn()).then(unwrap);
  }

  /**
   * Audience-bound "Sign in with CSD" (SIWC) — the secure, replay-resistant third-party login.
   * The wallet binds the REAL requesting origin + your single-use server `nonce` into the signed
   * message and returns the artifact; it never mints a session. VERIFY the result SERVER-SIDE with
   * `verifySiwc` from `@inversealtruism/csd-siwc` (domain/nonce/chain/time/signature/account), then
   * issue your OWN session. The signature is proof-of-control, NOT a bearer token. Always prompts.
   */
  signInWithCsd(params: SiwcParams): Promise<SiwcResult> {
    if (!params || typeof params.nonce !== "string" || !params.nonce) {
      return Promise.reject(new UnsupportedMethodError("signInWithCsd requires a server-issued { nonce }"));
    }
    if (typeof this.provider.signInWithCsd !== "function") {
      return Promise.reject(new UnsupportedMethodError("this wallet predates Sign-in-with-CSD — ask the user to update the Cairn Wallet"));
    }
    return Promise.resolve(this.provider.signInWithCsd(params)).then(unwrap);
  }

  /** True if this wallet supports audience-bound SIWC (safe to call `signInWithCsd`). */
  get supportsSiwc(): boolean {
    return typeof this.provider.signInWithCsd === "function";
  }

  /** Feature/capability detection. Returns null if the wallet predates `getCapabilities`. */
  async getCapabilities(): Promise<WalletCapabilities | null> {
    if (typeof this.provider.getCapabilities !== "function") return null;
    try { return await this.provider.getCapabilities(); } catch { return null; }
  }

  /** Atomic fill (CairnX DvP): pay + attest in ONE tx. Always prompts with clear-signing. */
  fillOffer(params: FillParams): Promise<TxResult> {
    return Promise.resolve(this.provider.fillOffer(params)).then(unwrap);
  }

  /** Send CSD (always prompts with clear-signing; wallet picks inputs + returns change to itself). */
  send(params: SendParams): Promise<TxResult> {
    return Promise.resolve(this.provider.send(params)).then(unwrap);
  }

  /** Low-level Propose (always prompts). Prefer `cairn.board.propose()` which computes the hash/uri/expiry. */
  propose(params: ProposeParams): Promise<TxResult> {
    return Promise.resolve(this.provider.propose(params)).then(unwrap);
  }

  /** Attest/support a proposal (always prompts). */
  attest(params: AttestParams): Promise<TxResult> {
    return Promise.resolve(this.provider.attest(params)).then(unwrap);
  }

  /** Seal a commit-reveal claim (always prompts; salt stays inside the wallet). */
  sealClaim(params: SealClaimParams): Promise<TxResult> {
    return Promise.resolve(this.provider.sealClaim(params)).then(unwrap);
  }

  /** Reveal a previously sealed claim by its sealing txid (always prompts). */
  revealClaim(txid: string): Promise<TxResult> {
    if (typeof txid !== "string" || !txid) {
      return Promise.reject(new UnsupportedMethodError("revealClaim requires the sealing txid"));
    }
    return Promise.resolve(this.provider.revealClaim(txid)).then(unwrap);
  }
}

/** Detect the wallet and return a ready `WalletConnection` (does not auto-call connect()). */
export async function getWallet(opts: DetectOptions = {}): Promise<WalletConnection> {
  return new WalletConnection(await detectProvider(opts));
}

/** Detect + connect in one step; resolves to the connected address. */
export async function connect(opts: DetectOptions = {}): Promise<{ wallet: WalletConnection; address: string }> {
  const wallet = await getWallet(opts);
  const address = await wallet.connect();
  return { wallet, address };
}
