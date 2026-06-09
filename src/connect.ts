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

/** The raw provider object the extension injects at `window.cairn`. */
export interface CairnProvider {
  isCairn: true;
  version: string;
  connect(): Promise<ProviderReply<ConnectResult>>;
  getAddress(): Promise<ProviderReply<ConnectResult>>;
  signIn(): Promise<ProviderReply<SignInResult>>;
  propose(p: ProposeParams): Promise<ProviderReply<TxResult>>;
  attest(p: AttestParams): Promise<ProviderReply<TxResult>>;
  send(p: SendParams): Promise<ProviderReply<TxResult>>;
  sealClaim(p: SealClaimParams): Promise<ProviderReply<TxResult>>;
  revealClaim(txid: string): Promise<ProviderReply<TxResult>>;
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

  /** Passwordless sign-in: a signature over a login nonce (always prompts; structurally cannot sign a tx). */
  signIn(): Promise<SignInResult> {
    return Promise.resolve(this.provider.signIn()).then(unwrap);
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
