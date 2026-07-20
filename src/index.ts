// @inversealtruism/cairn-sdk — the Compute Substrate dApp kit.
//
// One cohesive `Cairn` object that composes everything we built on CSD:
//   cairn.wallet    — connect the Cairn Wallet, sign things (clear-signed approvals)
//   cairn.chain     — node RPC + tx builders + verifying light client
//   cairn.board     — the signal board + work graph (reads public; writes wallet-signed)
//   cairn.index     — the L2 explorer/indexer: REST + merkle proofs + live SSE/WS
//   cairn.content   — self-certifying content (publish via board, fetch verified)
//   cairn.registry  — L3 peer/gateway/identity resolution
//
// Quick start:
//   import { Cairn } from "@inversealtruism/cairn-sdk";
//   const cairn = new Cairn({ network: "mainnet" });
//   await cairn.connect();                       // prompts the wallet once
//   const top = await cairn.board.top({ domain: "csd:apps" });
//   await cairn.board.propose({ domain: "csd:apps", title: "My dApp", body: "…" });

import { Http, type FetchLike } from "./http.js";
import { Chain, LightClient, type BlockHeader } from "./chain.js";
import { BoardClient } from "./board.js";
import { IndexerClient } from "./indexer.js";
import { ContentClient } from "./content.js";
import { RegistryClient } from "./registry.js";
import { NamesClient } from "./names.js";
import { WalletConnection, connect as connectWallet, type DetectOptions } from "./connect.js";
import { preverifyOffer, type OfferFillCheck } from "./fillverify.js";

export interface CairnBaseUrls {
  /** Cairn board server (board + /api/rpc proxy + /content origin). Default https://cairn-substrate.com */
  cairn?: string;
  /** Node RPC base. Default `${cairn}/api/rpc` (the public proxy — no local node needed). */
  rpc?: string;
  /**
   * csd-indexer base. Default `${cairn}/explorer/api` — the cairn server's existing
   * hardened, read-only, rate-limited reverse proxy to the localhost indexer (the
   * same one the block explorer uses). SSE works through it; WebSocket subscribe()
   * needs a direct indexer endpoint (set this to a localhost/private indexer URL).
   */
  indexer?: string;
  /**
   * Optional direct csd-swarm gateway base. Not set by default — content is reached
   * via the indexer proxy (which fronts the swarm) and the cairn origin, both verified.
   * Set this only if you run a public swarm gateway.
   */
  swarm?: string;
}

export interface CairnConfig {
  /** Currently only "mainnet". Selects the default base URLs. */
  network?: "mainnet";
  baseUrls?: CairnBaseUrls;
  /** Custom fetch (defaults to global fetch). */
  fetch?: FetchLike;
  /** Per-request HTTP timeout in ms (default 15000). */
  timeoutMs?: number;
  /** A pre-connected wallet (otherwise call `cairn.connect()` in the browser). */
  wallet?: WalletConnection;
  /** WebSocket implementation for indexer subscriptions (defaults to global). */
  WebSocketImpl?: typeof WebSocket;
  /**
   * SPV trust anchor for genuine "verified-inclusion" (audit M3). A merkle inclusion proof is only
   * "verified-inclusion" when its block header is PoW-verified — otherwise a lying node can serve a
   * fake header whose merkle matches a fake proof. The light client verifies the header chain
   * (PoW + LWMA + chainwork) forward from this pinned checkpoint; inclusion at a height ≥ the
   * checkpoint is then trust-minimized. Defaults to the ecosystem checkpoint (same hash swapguard
   * ships). Pin your own for full control. Txs BELOW the checkpoint degrade to "proof-consistent".
   */
  spvCheckpoint?: { height: number; hash: string };
}

// The ecosystem SPV checkpoint (CAIRN-SDK-SPV-CKPT-DUP-1: MUST stay identical to cairn /trade swapguard's
// baked anchor — `cairn/public/trade/swapguard.js` CP; test/spv-checkpoint.test.ts asserts equality so the
// two literals can't silently drift). A consensus block hash, not a trusted server's word — the light client
// re-verifies every header forward from here. Pin a newer one via config.spvCheckpoint as the chain grows.
// B7c (REBIND W12) note on the forward-bump: a 38,142 anchor costs every consumer a checkpoint..tip header
// sync (now batched + retried by seededSpvLight below, so it is a few requests, not a per-height flood).
// Moving the anchor forward shrinks that span, but the checkpoint is a SHARED cross-repo literal that MUST
// land at the SAME value in swapguard.js's CP AND cairn/deploy/spv-checkpoint IN THE SAME change
// (spv-checkpoint.test.ts fails on any drift). So the bump is a COORDINATED runbook step, not a unilateral
// SDK edit; the recipe (pick a well-buried height, read its consensus block hash, update all three literals
// together, re-run the pin) is in this campaign's b7bc-record. Until then this stays at swapguard's live value.
export const DEFAULT_SPV_CHECKPOINT = { height: 38142, hash: "0x00000000000140f023cc0ee1457a40833f2fcb4de44291b9d373e50f17b97232" };

const DEFAULT_CAIRN = "https://cairn-substrate.com";

// W12: SPV header-batch transport tuning (mirrors cairn/public/trade/swapguard.js's headersBatch). The
// per-attempt timeout sits ABOVE the cairn server's 10s /api/headers whole-request deadline so a clean 502
// is retried rather than raced; the retry budget bounds 429/502/503 + transport errors, then THROWS so the
// light client sync fails CLOSED. Every retried header is re-verified downstream, so retrying carries no trust.
const SPV_HTTP_TIMEOUT_MS = 15000;
const SPV_HTTP_MAX_RETRIES = 4;
const spvSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const spvRetryDelayMs = (attempt: number, retryAfterSecs: number) => Math.min(4000, Math.max(700 * (attempt + 1), retryAfterSecs * 1000));


export class Cairn {
  readonly config: CairnConfig;
  readonly chain: Chain;
  readonly index: IndexerClient;
  readonly content: ContentClient;
  readonly registry: RegistryClient;
  /** .csd names + CairnX market READS (server-trusted display reads; see names.ts trust note). */
  readonly names: NamesClient;
  board: BoardClient;
  wallet?: WalletConnection;

  private readonly cairnHttp: Http;
  // Lazily-seeded SPV light client + its checkpoint (audit M3 — PoW-verified header source).
  private _spvLight: LightClient | null = null;
  private _spvSeeded = false;
  private readonly _spvCp: { height: number; hash: string };
  // W12: the cairn base the SPV header-batch provider fetches /api/headers from (same base the rest of the SDK uses).
  private readonly _cairnBase: string;

  constructor(config: CairnConfig = {}) {
    this.config = config;
    const fetch = config.fetch;
    const timeoutMs = config.timeoutMs;

    const cairn = (config.baseUrls?.cairn ?? DEFAULT_CAIRN).replace(/\/+$/, "");
    const rpc = config.baseUrls?.rpc ?? `${cairn}/api/rpc`;
    const indexer = (config.baseUrls?.indexer ?? `${cairn}/explorer/api`).replace(/\/+$/, "");

    this.cairnHttp = new Http({ baseUrl: cairn, fetch, timeoutMs });
    this._cairnBase = cairn;
    const indexerHttp = new Http({ baseUrl: indexer, fetch, timeoutMs });
    // Optional direct swarm gateway (not public by default — the indexer fronts it).
    const swarmHttp = config.baseUrls?.swarm
      ? new Http({ baseUrl: config.baseUrls.swarm.replace(/\/+$/, ""), fetch, timeoutMs })
      : undefined;

    this._spvCp = config.spvCheckpoint ?? DEFAULT_SPV_CHECKPOINT;
    this.chain = new Chain({ rpcUrl: rpc, fetch, timeoutMs });
    this.wallet = config.wallet;
    this.board = new BoardClient(this.cairnHttp, this.wallet);
    // "verified-inclusion" requires a PoW-VERIFIED header to check the proof root against (audit M3).
    // A raw `blockByHeight(h).header.merkle` read is NOT that — a lying node serves a fake header
    // whose merkle matches a fake proof (and the same-origin case lets ONE server control both). So
    // we wire a headerMerkleAt backed by the verifying light client: it returns a header merkle only
    // after re-verifying the chain (PoW + LWMA + chainwork) forward from a pinned checkpoint, and
    // THROWS otherwise — the IndexerClient then degrades to the honest "proof-consistent" (never an
    // over-claimed "verified-inclusion"). Heights ≥ the checkpoint are genuinely trust-minimized.
    this.index = new IndexerClient(indexerHttp, {
      fetch,
      WebSocketImpl: config.WebSocketImpl,
      headerMerkleAt: (h: number) => this.verifiedHeaderMerkleAt(h),
    });
    // Content sources tried in order: direct swarm (if set) → indexer (fronts swarm) → cairn origin.
    this.content = new ContentClient({ swarm: swarmHttp, indexer: indexerHttp, cairn: this.cairnHttp });
    this.registry = new RegistryClient({ baseUrl: indexer, fetch });
    this.names = new NamesClient(this.cairnHttp);
  }

  /**
   * PoW-VERIFIED header merkle at a height (audit M3 — the no-PoW half). Lazily seeds a light
   * client from the pinned SPV checkpoint and verifies the header chain FORWARD (PoW + LWMA +
   * chainwork) to `height`, then returns that header's merkle root. THROWS for a height below the
   * checkpoint (can't verify backward) or if verification fails — the IndexerClient then degrades
   * to the honest "proof-consistent" instead of over-claiming "verified-inclusion". The verified
   * header chain is cached across calls; the first call near tip syncs the post-checkpoint span.
   */
  private async verifiedHeaderMerkleAt(height: number): Promise<string> {
    if (!Number.isInteger(height) || height < this._spvCp.height)
      throw new Error(`height ${height} is below the SPV checkpoint ${this._spvCp.height} (cannot PoW-verify backward)`);
    const lc = await this.seededSpvLight();
    const haveTo = lc.baseHeight + lc.chain.length - 1;
    if (haveTo < height) await lc.sync(height);
    const vh = lc.chain[height - lc.baseHeight];
    if (!vh) throw new Error(`light client has no verified header at ${height}`);
    return String(vh.header.merkle);
  }

  /** The PoW-verifying SPV light client, seeded ONCE from the pinned checkpoint (shared by the M3 header-merkle
   *  bind and the F13 offer pre-verify). Reused across calls; the first call near tip syncs the post-checkpoint span. */
  private async seededSpvLight(): Promise<LightClient> {
    // W12: pass a BATCH header provider (checkpoint..tip in a few batched requests, each header re-verified
    // so it carries ZERO trust). Fixing the sync WITHOUT this converts a fast wrong answer into a
    // multi-thousand-request flood, so the provider is MANDATORY, not an optimization.
    if (!this._spvLight) this._spvLight = new LightClient({
      client: this.chain.client,
      checkpoints: { [this._spvCp.height]: this._spvCp.hash },
      headersBatchProvider: (from, count) => this.fetchHeadersBatch(from, count),
    });
    if (!this._spvSeeded) {
      await this._spvLight.syncFromCheckpoint(this._spvCp.height, this._spvCp.hash);
      // W12: ADVANCE TO THE LIVE TIP after the seed. Before B7c the SDK's SPV only seeded the checkpoint
      // window and never reached tip, so a near-tip offer never merkle-proved and every downstream fill
      // bind was dead (the inertness that hid the SDK's want-type hole; this is why B7c lands AFTER B7b's
      // binds are on). A transient tip/sync failure must NOT brick the seed: verifyTxInclusion self-syncs
      // (also batched) to a tx's height on demand, so fall soft and keep the seeded client usable.
      try {
        const tipHeight = Number((await this.chain.tip()).height);
        const have = this._spvLight.baseHeight + this._spvLight.chain.length - 1;
        if (Number.isFinite(tipHeight) && tipHeight > have) await this._spvLight.sync(tipHeight);
      } catch { /* keep the seeded client; on-demand batched sync covers what this pre-warm missed */ }
      this._spvSeeded = true;
    }
    return this._spvLight;
  }

  /**
   * W12 batch header transport for the checkpoint..tip forward sync, backed by the cairn server's
   * `/api/headers/:from/:count`. Carries ZERO trust: the LightClient re-verifies every header's PoW /
   * prev-link / LWMA, so a forged or stale row fails closed and retrying transport proves nothing new.
   * Retry budget: a 429 (per-IP header budget) or 502/503 (a height past the lagging indexer, or the
   * server's 10s deadline) is a transient data-availability hiccup; back off (honouring Retry-After) a
   * bounded number of times, then THROW so `sync()` fails closed. A non-dense range is rejected.
   *
   * B7d / F6 DEPENDENCY: `/api/headers` serves no Access-Control-Allow-Origin today (`corsPublic` is
   * mounted on `/explorer/api`, `/trade/api` and `/api/rpc`, not here). A SAME-ORIGIN dApp (hosted on the
   * cairn base) reaches it now; a CROSS-ORIGIN third-party dApp cannot until B7d adds the CORS mount and
   * restarts the cairn service. This code is correct as written; it becomes reachable cross-origin only
   * once B7d ships. This is a recorded dependency, not a blocker for authoring/testing.
   */
  private async fetchHeadersBatch(from: number, count: number): Promise<{ header: BlockHeader; hash: string }[]> {
    const g = this.config.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!g) throw new Error("No fetch available for SPV header sync - pass `fetch` in the SDK options.");
    const doFetch: FetchLike = this.config.fetch ? this.config.fetch : (g.bind(globalThis) as FetchLike);
    const url = `${this._cairnBase}/api/headers/${from}/${count}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), SPV_HTTP_TIMEOUT_MS);
      try { res = await doFetch(url, { signal: ctrl.signal }); }
      catch (e) {
        if (attempt >= SPV_HTTP_MAX_RETRIES) throw e;   // transport error / timeout: bounded retry, then fail closed
        await spvSleep(spvRetryDelayMs(attempt, 0));
        continue;
      } finally { clearTimeout(timer); }
      if (res.ok) {
        // ZERO trust in the row shape: the LightClient re-verifies every header (PoW / prev-link / LWMA)
        // against the pinned checkpoint, so a wrong `header` fails closed downstream, not here.
        const rows = ((await res.json()) as { headers?: { header: BlockHeader; hash: string }[] })?.headers;
        if (!Array.isArray(rows) || rows.length !== count) throw new Error(`/api/headers: non-dense range (${from}/${count})`);
        return rows.map((r) => ({ header: r.header, hash: r.hash }));
      }
      if ((res.status === 429 || res.status === 502 || res.status === 503) && attempt < SPV_HTTP_MAX_RETRIES) {
        res.body?.cancel?.().catch(() => {});   // drain the discarded body (undici holds the socket otherwise)
        await spvSleep(spvRetryDelayMs(attempt, Number(res.headers.get("retry-after")) || 0));
        continue;
      }
      throw new Error(`/api/headers ${res.status}`);
    }
  }

  /**
   * F13 — corroborate an offer ON-CHAIN before building a `fillOffer` payment's `outputs`. Merkle-proves the
   * offer into the PoW-verified header chain (from the pinned SPV checkpoint), binds the record to its on-chain
   * commitment, derives the payment recipient + seller from the offer's on-chain AUTHOR (the funding input's
   * prevout owner, txid-committed, NOT the malleable scriptSig), and, if you pass the resolver-SERVED `offer`
   * object, binds its payto/seller + fee/rebate/partial terms to the proven ones. Returns a TRUST-LABELED result
   * (fail-closed on a positive mismatch, fail-soft `transient` on a lagging / below-checkpoint chain view).
   *
   * This is best-effort corroboration, NOT the payment-grade boundary: the Cairn Wallet's OWN on-device
   * fill-SPV (0.2.60+, fails-closed before signing) is that. A dApp settling real value should still clear this
   * before building `outputs`, so it never hands the wallet a payment a lying resolver would redirect.
   */
  async verifyOfferForFill(offerId: string, servedOffer?: unknown): Promise<OfferFillCheck> {
    const light = await this.seededSpvLight();
    return preverifyOffer({ light, client: this.chain.client, offerId, servedOffer });
  }

  /**
   * Detect + connect the Cairn Wallet (browser only). Wires the wallet into
   * `cairn.board` for signed writes. Resolves to the connected address.
   */
  async connect(opts: DetectOptions = {}): Promise<string> {
    const { wallet, address } = await connectWallet(opts);
    this.attachWallet(wallet);
    return address;
  }

  /** Attach an already-connected wallet (e.g. one you constructed yourself). */
  attachWallet(wallet: WalletConnection): void {
    this.wallet = wallet;
    this.board = new BoardClient(this.cairnHttp, wallet);
  }

  /** True if a wallet is attached. */
  get connected(): boolean {
    return !!this.wallet;
  }
}

// Re-export the building blocks for direct use.
export { Http } from "./http.js";
export type { FetchLike, HttpOptions } from "./http.js";
export { Chain } from "./chain.js";
export { NamesClient } from "./names.js";
export type { NameResolution, NameDetail, TokenInfo, PrimaryName } from "./names.js";
export { BoardClient } from "./board.js";
export type { BoardWindow, RankedItem, BoardItemContent, ProposeInput, ProposeResult, SupportInput } from "./board.js";
export { IndexerClient } from "./indexer.js";
export type { MerkleProof, InclusionResult, IndexEvent, StreamHandlers, StreamHandle, TrustLevel } from "./indexer.js";
export { ContentClient } from "./content.js";
export type { PreparedContent, ContentClientOptions } from "./content.js";
export { RegistryClient } from "./registry.js";
export {
  WalletConnection,
  connect,
  getWallet,
  detectProvider,
  discoverProviders,
  isInstalled,
} from "./connect.js";
export type {
  CairnProvider,
  ConnectResult,
  TxResult,
  SignInResult,
  SiwcParams,
  SiwcResult,
  FillParams,
  WalletCapabilities,
  WalletPermission,
  ProviderInfo,
  ProviderDetail,
  ProposeParams,
  AttestParams,
  SendParams,
  SealClaimParams,
  DetectOptions,
} from "./connect.js";
export { CairnController } from "./controller.js";
export type { CairnState, CairnControllerOptions } from "./controller.js";
export {
  CairnError,
  NotInstalledError,
  UserRejectedError,
  WalletLockedError,
  UnsupportedMethodError,
  HttpError,
  ContentVerificationError,
  SubmitInFlightError,
  mapProviderError,
  mapSubmitResultError,
  errorCode,
  SDK_VERSION,
} from "./errors.js";
export type { CairnErrorCode, CairnErrorOptions } from "./errors.js";
// F13 offer pre-verify (diligent-dApp on-chain corroboration before building a fillOffer's outputs). The
// standalone `preverifyOffer` takes an injected light client + tx reader; `Cairn.verifyOfferForFill` wires the
// checkpoint-anchored SPV light client for you. `bindOfferTerms`/`feeBpsAt` are the pure term-bind primitives.
// B7b: also surfaces the discriminated fill-safety successors `fillEndorsement` (endorsed/refused/
// not-endorsable - a token want is HONEST NON-ENDORSEMENT, never a refusal) and `fillOutputPlan`
// (csd-outputs/token-settled/undeliverable), with the deprecated, behavior-frozen `fillIsSafe` /
// `requiredFillOutputs` / `previewFill` kept for existing third-party consumers.
export {
  preverifyOffer, bindOfferTerms, feeBpsAt,
  fillEndorsement, fillOutputPlan, fillIsSafe, requiredFillOutputs, previewFill,
} from "./fillverify.js";
export type { OfferFillCheck, ProvenOfferTerms, FillEndorsement, FillOutputPlan, FillSafety, FillPreview } from "./fillverify.js";
