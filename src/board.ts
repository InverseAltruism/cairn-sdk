// BoardClient — the Cairn signal board + work graph.
//
// Reads hit the public cairn endpoints (no auth). Writes go through the user's
// WALLET (build+sign+submit + clear-signing approval) and then register the
// off-chain content via the PUBLIC, self-certifying POST /api/content. The
// operator-only token endpoints (/api/propose, /api/support) are deliberately
// NOT used — a dApp acts as the user, never as the operator.

import { payloadHash } from "@inversealtruism/csd-codec";
import { MIN_FEE_PROPOSE, MIN_FEE_ATTEST, EPOCH_LEN } from "@inversealtruism/csd-codec";
import type { Http } from "./http.js";
import type { WalletConnection, TxResult } from "./connect.js";
import { CairnError } from "./errors.js";

export type BoardWindow = "24h" | "7d" | "30d" | "all";

/** A ranked board item (loose — the server returns a rich object). */
export interface RankedItem {
  id: string;
  title: string;
  body: string;
  domain: string;
  proposer: string;
  score: number;
  totalWeight: number;
  [k: string]: unknown;
}

export interface BoardItemContent {
  v: 1;
  domain: string;
  title: string;
  body: string;
  links: string[];
}

export interface ProposeInput {
  domain: string;
  title: string;
  body?: string;
  links?: string[];
  /** Fee in base units (default MIN_FEE_PROPOSE = 0.25 CSD). */
  fee?: number;
  /** Lifetime in epochs before expiry (default 720 ≈ 30 days, matching cairn). */
  lifetimeEpochs?: number;
}

export interface ProposeResult {
  txid: string;
  payloadHash: string;
  content: BoardItemContent;
  /** Whether the off-chain content was registered with the cairn origin yet. */
  registered: boolean;
  /** If registration is still pending, call `registerContent(content, txid)` again later. */
  registerError?: string;
}

export interface SupportInput {
  /** 0–100 quality score (default 80). */
  score?: number;
  /** 0–100 confidence (default 70). */
  confidence?: number;
  /** Fee in base units (default MIN_FEE_ATTEST = 0.05 CSD). */
  fee?: number;
}

export class BoardClient {
  private readonly http: Http;
  private readonly wallet?: WalletConnection;

  constructor(http: Http, wallet?: WalletConnection) {
    this.http = http;
    this.wallet = wallet;
  }

  private requireWallet(): WalletConnection {
    if (!this.wallet) {
      throw new CairnError("This action needs a connected wallet. Construct Cairn with a wallet, or call cairn.connect() first.");
    }
    return this.wallet;
  }

  // ---- reads (public) ----------------------------------------------------

  /** Ranked board for a domain + time window. */
  board(opts: { domain?: string; window?: BoardWindow } = {}): Promise<{ window: string; domain: string; count: number; items: RankedItem[] }> {
    return this.http.getJson("/api/board", { domain: opts.domain ?? "all", window: opts.window ?? "all" });
  }

  /** Alias for `board()` — the top items. */
  top(opts: { domain?: string; window?: BoardWindow } = {}) {
    return this.board(opts);
  }

  /** A single item with its supports + pledges + integrity flag. */
  item(id: string): Promise<{ ok: boolean; item: RankedItem; supports: unknown[]; pledges: unknown[]; integrityOk: boolean }> {
    return this.http.getJson(`/api/item/${encodeURIComponent(id)}`);
  }

  /** Known + discovered domains. */
  domains(): Promise<{ prefix: string; total: number; domains: unknown[]; discovered: unknown[] }> {
    return this.http.getJson("/api/domains");
  }

  /** All quests (work-graph items). */
  quests(): Promise<{ count: number; quests: unknown[] }> {
    return this.http.getJson("/api/quests");
  }

  /** A single quest with claims/submissions/payouts. */
  quest(id: string): Promise<{ ok: boolean; quest: unknown }> {
    return this.http.getJson(`/api/quest/${encodeURIComponent(id)}`);
  }

  /** An address's on-chain-derived profile + identity + reputation. */
  profile(addr: string, opts: { live?: boolean } = {}): Promise<{ ok: boolean; profile: unknown; identity: unknown; reputation: unknown }> {
    return this.http.getJson(`/api/profile/${encodeURIComponent(addr)}`, opts.live ? { live: 1 } : undefined);
  }

  /** Reputation leaderboard (top 50). */
  leaderboard(): Promise<{ count: number; leaderboard: unknown[] }> {
    return this.http.getJson("/api/leaderboard");
  }

  /** Network dashboard snapshot. */
  network(): Promise<unknown> {
    return this.http.getJson("/api/network");
  }

  /** Network time-series for charts. */
  networkSeries(range: "24h" | "1w" | "1m" | "all" = "24h"): Promise<unknown> {
    return this.http.getJson("/api/network/series", { range });
  }

  /** Recent blocks with miner/reward. */
  networkBlocks(limit = 15): Promise<unknown> {
    return this.http.getJson("/api/network/blocks", { limit });
  }

  /** Per-miner hashrate estimate. */
  miner(addr: string): Promise<unknown> {
    return this.http.getJson(`/api/miner/${encodeURIComponent(addr)}`);
  }

  /** Recent activity feed. */
  activity(): Promise<{ activity: unknown[] }> {
    return this.http.getJson("/api/activity");
  }

  /** The gamified cairn wall. */
  wall(): Promise<unknown> {
    return this.http.getJson("/api/wall");
  }

  /** Server health + chain reachability. */
  health(): Promise<unknown> {
    return this.http.getJson("/api/health");
  }

  // ---- writes (wallet-signed) -------------------------------------------

  /**
   * Publish a board item: compute the canonical payload hash, have the WALLET
   * build/sign/submit the Propose (clear-signed approval), then register the
   * off-chain content. The payload hash is byte-identical to what the cairn
   * server verifies (csd-codec.payloadHash over { v:1, domain, title, body, links }).
   */
  async propose(input: ProposeInput): Promise<ProposeResult> {
    const wallet = this.requireWallet();
    const content: BoardItemContent = {
      v: 1,
      domain: input.domain,
      title: input.title,
      body: input.body ?? "",
      links: input.links ?? [],
    };
    const ph = payloadHash(content);
    const uri = `cairn:v1:${ph.slice(2, 14)}`;
    const lifetime = input.lifetimeEpochs ?? 720;
    const height = await this.tipHeight();
    const expiresEpoch = Math.floor(height / EPOCH_LEN) + lifetime;
    const fee = input.fee ?? MIN_FEE_PROPOSE;

    // 1. Wallet signs + submits the Propose tx (opens the clear-signing window).
    const r: TxResult = await wallet.propose({ domain: content.domain, payloadHash: ph, uri, expiresEpoch, fee });
    const txid = String(r.txid ?? "");
    if (!txid) throw new CairnError("Propose submitted but no txid was returned by the wallet.");

    // 2. Register the off-chain content (public, self-certifying). The cairn
    //    server needs to see the proposal first, so retry briefly.
    const reg = await this.tryRegister(content, txid);
    return { txid, payloadHash: ph, content, registered: reg.ok, registerError: reg.error };
  }

  /**
   * Register off-chain content for an already-submitted proposal txid. Idempotent.
   * Returns { ok } — the cairn server verifies sha256(canonical) == on-chain payload_hash.
   */
  async registerContent(content: BoardItemContent, txid: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.http.postJson<{ ok: boolean; error?: string }>("/api/content", {
        domain: content.domain,
        title: content.title,
        body: content.body,
        links: content.links,
        txid,
      });
      return { ok: !!res.ok, error: res.ok ? undefined : res.error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Support/attest a proposal (wallet-signed; always clear-signed). */
  async support(proposalId: string, opts: SupportInput = {}): Promise<TxResult> {
    const wallet = this.requireWallet();
    return wallet.attest({
      proposalId,
      score: opts.score ?? 80,
      confidence: opts.confidence ?? 70,
      fee: opts.fee ?? MIN_FEE_ATTEST,
    });
  }

  // ---- internal ----------------------------------------------------------

  private async tipHeight(): Promise<number> {
    const tip = await this.http.getJson<{ height?: number }>("/api/rpc/tip");
    const h = Number(tip?.height);
    if (!Number.isFinite(h)) throw new CairnError("Could not read chain tip height for expiry computation.");
    return h;
  }

  private async tryRegister(content: BoardItemContent, txid: string): Promise<{ ok: boolean; error?: string }> {
    // The proposal may not be visible to the origin immediately after submit.
    const delays = [0, 1500, 3000, 5000];
    let last: { ok: boolean; error?: string } = { ok: false, error: "not attempted" };
    for (const d of delays) {
      if (d) await sleep(d);
      last = await this.registerContent(content, txid);
      if (last.ok) return last;
      if (!/not found yet|not found/i.test(last.error ?? "")) return last; // a real error, don't keep retrying
    }
    return last;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
