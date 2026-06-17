// Framework-agnostic reactive connection store for the Cairn Wallet (Phase 3 DX). Wraps a
// WalletConnection, tracks {status, account, error} as an immutable snapshot, and stays in sync with
// the wallet's provider events. Exposes a useSyncExternalStore-compatible subscribe/getSnapshot, so a
// React/Vue/Svelte adapter (or vanilla JS) is a thin veneer — all the logic lives + is tested here.
//
// F11-safe by construction: the wallet only ever emits `accountsChanged([])` (lock / account-switch /
// revoke), so this store drops to "disconnected" on those — it never silently adopts a new address.
import { getWallet, type WalletConnection, type SiwcParams, type SiwcResult, type DetectOptions } from "./connect.js";

export interface CairnState {
  readonly status: "disconnected" | "connecting" | "connected";
  readonly account: string | null;
  readonly error: string | null;
}

const DISCONNECTED: CairnState = Object.freeze({ status: "disconnected", account: null, error: null });

export interface CairnControllerOptions extends DetectOptions {
  /** Override how the WalletConnection is obtained (custom transport / tests). Defaults to getWallet. */
  getWallet?: (opts?: DetectOptions) => Promise<WalletConnection>;
}

export class CairnController {
  private state: CairnState = DISCONNECTED;
  private conn: WalletConnection | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly getWalletFn: (opts?: DetectOptions) => Promise<WalletConnection>;
  private readonly detectOpts: DetectOptions;

  constructor(opts: CairnControllerOptions = {}) {
    const { getWallet: gw, ...detect } = opts;
    this.getWalletFn = gw ?? getWallet;
    this.detectOpts = detect;
  }

  /** useSyncExternalStore-compatible. Returns an unsubscribe fn. */
  subscribe = (cb: () => void): (() => void) => { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; };

  /** useSyncExternalStore-compatible snapshot — stable reference until the state actually changes. */
  getSnapshot = (): CairnState => this.state;

  /** The underlying WalletConnection (for advanced use: send/propose/permissions/…). Null until connect(). */
  get connection(): WalletConnection | null { return this.conn; }

  private setState(patch: Partial<CairnState>): void {
    const next = { ...this.state, ...patch };
    // No-op if nothing changed → keeps getSnapshot's reference stable (avoids useSyncExternalStore loops).
    if (next.status === this.state.status && next.account === this.state.account && next.error === this.state.error) return;
    this.state = Object.freeze(next);
    for (const l of [...this.listeners]) l();
  }

  private onAccounts = (accounts: unknown): void => {
    if (!Array.isArray(accounts) || accounts.length === 0) this.setState({ status: "disconnected", account: null });
    else this.setState({ status: "connected", account: String(accounts[0]), error: null });
  };
  private onDisconnect = (): void => { this.setState({ status: "disconnected", account: null }); };

  /** Detect + connect (prompts the user the first time per origin). Resolves the connected address. */
  connect = async (): Promise<string> => {
    this.setState({ status: "connecting", error: null });
    try {
      if (!this.conn) {
        this.conn = await this.getWalletFn(this.detectOpts);
        this.conn.on("accountsChanged", this.onAccounts);
        this.conn.on("disconnect", this.onDisconnect);
      }
      const addr = await this.conn.connect();
      this.setState({ status: "connected", account: addr, error: null });
      return addr;
    } catch (e) {
      this.setState({ status: "disconnected", account: null, error: (e as Error)?.message ?? String(e) });
      throw e;
    }
  };

  /** Forget the connection locally AND revoke this origin's wallet-side permission (best-effort). */
  disconnect = async (): Promise<void> => {
    try { await this.conn?.revokePermissions(); } catch { /* best-effort; still drop local state */ }
    this.setState({ status: "disconnected", account: null, error: null });
  };

  /** Audience-bound sign-in (must connect() first). Returns the signed artifact to verify server-side. */
  signInWithCsd = (params: SiwcParams): Promise<SiwcResult> => {
    if (!this.conn) return Promise.reject(new Error("call connect() before signInWithCsd()"));
    return this.conn.signInWithCsd(params);
  };
}
