// @inversealtruism/cairn-sdk: the Compute Substrate dApp kit.
//
// One cohesive `Cairn` object that composes everything we built on CSD:
//   cairn.wallet   : connect the Cairn Wallet, sign things (clear-signed approvals)
//   cairn.chain    : node RPC + tx builders + verifying light client
//   cairn.index    : the L2 explorer/indexer: REST + merkle proofs + live SSE/WS
//   cairn.content  : self-certifying content (fetched and verified against its hash)
//   cairn.names    : .csd names + CairnX market reads
//
// Quick start:
//   import { Cairn } from "@inversealtruism/cairn-sdk";
//   const cairn = new Cairn({ network: "mainnet" });
//   const tip = await cairn.chain.tip();
//   await cairn.connect();                       // prompts the wallet once

import { Http, readCapped, retryAfterMs, RetryWaitBudget, type FetchLike } from "./http.js";
import { Chain, LightClient, type BlockHeader } from "./chain.js";
import { IndexerClient } from "./indexer.js";
import { ContentClient } from "./content.js";
import { NamesClient } from "./names.js";
import { WalletConnection, connect as connectWallet, type DetectOptions } from "./connect.js";
import { preverifyOffer, type OfferFillCheck } from "./fillverify.js";

export interface CairnBaseUrls {
  /** Cairn server (/api/rpc proxy, /api/headers, /content origin, /trade/api names reads). Default https://cairn-substrate.com */
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

// The ecosystem SPV checkpoint: a consensus block hash, not a trusted server's word; the light client re-verifies
// every header forward from here. It is picked in cairn (`scripts/bump-swapguard-cp.mjs`) and copied from
// cairn/public/trade/swapguard.js's CP in the same cycle, never bumped here alone. test/spv-checkpoint.test.ts
// checks it is a real block against a committed header capture; the cairn copies (swapguard.js and
// `deploy/spv-checkpoint`) are checked in the cairn repo. Pin a newer one via config.spvCheckpoint.
export const DEFAULT_SPV_CHECKPOINT = { height: 115403, hash: "0x00000000000052e29166597d598827b137af1dea7542123b848637fee0b67347" };

const DEFAULT_CAIRN = "https://cairn-substrate.com";

// W12: SPV header-batch transport tuning (mirrors cairn/public/trade/swapguard.js's headersBatch). The
// per-attempt timeout sits ABOVE the cairn server's 10s /api/headers whole-request deadline so a clean 502
// is retried rather than raced; the retry budget bounds 429/502/503 + transport errors, then THROWS so the
// light client sync fails CLOSED. Every retried header is re-verified downstream, so retrying carries no trust.
// MF-13: the attempt now spans headers PLUS the body read (the timer stays armed through readCapped), so a
// never-ending or oversize 200 stream is aborted instead of hanging past the cleared timer.
const SPV_HTTP_TIMEOUT_MS = 15000;
const SPV_HTTP_MAX_RETRIES = 4;
// MF-13: cap on one /api/headers batch response body. An honest worst-case batch is 512 rows
// (csd-light slices batches at 512) at ~330 bytes of JSON per row, ~170 KB total; 2 MiB is ~12x
// headroom, so no legitimate batch is ever declined, while a hostile or MITM'd 200 stream is
// bounded instead of OOMing the client. Do NOT route this call through Http (its retry and error
// semantics are different by design); the capped reader is shared instead.
const SPV_MAX_BATCH_BYTES = 2 * 1024 * 1024;
// MF-03: transient-vs-STRUCTURAL classifier for SPV sync failures, ported from the WALLET's widened
// form (cairn-wallet namespv.ts M8/B5e), NOT swapguard's older twin: the 50[0-9] arm plus the
// JSON-parse arm, because fetchHeadersBatch parses the response body, so a CF 200-HTML interstitial
// surfaces as "Unexpected token ..." - a transport fault, never a chain fault (structural errors say
// prev/PoW/bits/hash, never json). Misclassifying it re-authors the DOS-HDR-3 reseed storm.
const SPV_TRANSIENT_RE = /\b(429|50[0-9]|timeout|timed out|abort|aborted|headers|non-dense|failed to fetch|fetch failed|networkerror|load failed)\b/i;
const SPV_TRANSIENT_JSON_RE = /unexpected (token|end)|json/i;
const spvIsTransient = (e: unknown): boolean => {
  const msg = String((e as Error)?.message || e);
  return SPV_TRANSIENT_RE.test(msg) || SPV_TRANSIENT_JSON_RE.test(msg);
};
const spvSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Own backoff ladder (0.7, 1.4, 2.1, 2.8 s). A server Retry-After wins when longer, because retrying inside the
// server's window spends an attempt it will refuse again, but only while it fits SPV_RETRY_WAIT_BUDGET_MS.
const spvBackoffMs = (attempt: number) => Math.min(4000, 700 * (attempt + 1));
// Total retry sleep for one /api/headers request: 16 s is the 0.4.6 worst case (four retries at its 4 s cap).
// A longer hint fails the request at once as transient, so the read degrades instead of waiting out a window.
const SPV_RETRY_WAIT_BUDGET_MS = 16_000;
// A cached header at most this many blocks below the cached tip is re-checked against the served chain before it
// backs a "verified-inclusion"; anything deeper is treated as final. 12 is the deepest finality used in the stack
// (cairnx's scanner; the indexer finalizes at 6). The hosted cairn server edge-caches /api/headers rows at or
// below its tip - 6 as immutable, so against cairn-substrate.com the re-check only sees reorgs of up to 6
// blocks; a self-hosted base without that cache gets the full 12.
const SPV_RECHECK_DEPTH = 12;
const spvTipOf = (lc: LightClient): number => lc.baseHeight + lc.chain.length - 1;


export class Cairn {
  readonly config: CairnConfig;
  readonly chain: Chain;
  readonly index: IndexerClient;
  readonly content: ContentClient;
  /** .csd names + CairnX market READS (server-trusted display reads; see names.ts trust note). */
  readonly names: NamesClient;
  wallet?: WalletConnection;

  private readonly cairnHttp: Http;
  // Lazily-seeded SPV light client + its checkpoint (audit M3 — PoW-verified header source).
  private _spvLight: LightClient | null = null;
  // MF-14: the in-flight seed promise. Concurrent first callers share ONE seed instead of racing two
  // syncFromCheckpoint calls onto the same client (the loser would hit "seedTrusted must be called on a
  // fresh client"). Cleared when the seed settles; a failure leaves no cached state, so the next call retries.
  private _spvSeedInflight: Promise<LightClient> | null = null;
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

    this._spvCp = config.spvCheckpoint ?? DEFAULT_SPV_CHECKPOINT;
    this.chain = new Chain({ rpcUrl: rpc, fetch, timeoutMs });
    this.wallet = config.wallet;
    // "verified-inclusion" requires a PoW-VERIFIED header to check the proof root against (audit M3).
    // A raw `blockByHeight(h).header.merkle` read is NOT that; a lying node serves a fake header
    // whose merkle matches a fake proof (and the same-origin case lets ONE server control both). So
    // we wire a headerMerkleAt backed by the verifying light client: it returns a header merkle only
    // after re-verifying the chain (PoW + LWMA + chainwork) forward from a pinned checkpoint, and
    // THROWS otherwise; the IndexerClient then degrades to the honest "proof-consistent" (never an
    // over-claimed "verified-inclusion"). Heights ≥ the checkpoint are genuinely trust-minimized.
    this.index = new IndexerClient(indexerHttp, {
      fetch,
      WebSocketImpl: config.WebSocketImpl,
      headerMerkleAt: (h: number) => this.verifiedHeaderMerkleAt(h),
    });
    this.content = new ContentClient({ cairn: this.cairnHttp });
    this.names = new NamesClient(this.cairnHttp);
  }

  /**
   * PoW-VERIFIED header merkle at a height (audit M3 — the no-PoW half). Lazily seeds a light
   * client from the pinned SPV checkpoint and verifies the header chain FORWARD (PoW + LWMA +
   * chainwork) to `height`, then returns that header's merkle root. THROWS for a height below the
   * checkpoint (can't verify backward) or if verification fails — the IndexerClient then degrades
   * to the honest "proof-consistent" instead of over-claiming "verified-inclusion". The verified
   * header chain is cached across calls; the first call near tip syncs the post-checkpoint span.
   * MF-03: a STRUCTURAL forward-sync break (a reorg orphaned the cached tip) reseeds ONCE via
   * withSpvReseed. A height within SPV_RECHECK_DEPTH of the cached tip is re-checked against the served
   * chain first (recheckCachedHeader), so a block orphaned after it was cached stops backing
   * "verified-inclusion". Deeper heights answer from the cache with no network touch.
   */
  private async verifiedHeaderMerkleAt(height: number): Promise<string> {
    if (!Number.isInteger(height) || height < this._spvCp.height)
      throw new Error(`height ${height} is below the SPV checkpoint ${this._spvCp.height} (cannot PoW-verify backward)`);
    return this.withSpvReseed(async (lc) => {
      const haveTo = spvTipOf(lc);
      if (haveTo < height) await lc.sync(height);
      else await this.recheckCachedHeader(lc, height, haveTo);
      const vh = lc.chain[height - lc.baseHeight];
      if (!vh) throw new Error(`light client has no verified header at ${height}`);
      return String(vh.header.merkle);
    });
  }

  // MF-03: run an SPV read; on a STRUCTURAL failure (a reorg orphaned our cached tip: broken
  // prev-link / bad PoW / hash mismatch) reseed ONCE from the pinned checkpoint into a LOCAL fresh
  // client, retry the read on it, and commit the fresh client ONLY when both succeed (never null
  // this._spvLight first - the wallet G8 lesson, same shape as the MF-14 seed). A TRANSIENT failure
  // (rate limit / gateway / timeout / non-dense / CF 200-HTML) keeps the cache and rethrows: wiping
  // on those turns one /api/headers 429 into a reseed storm (DOS-HDR-3). A second structural
  // failure propagates fail-closed; there is no loop. recheckCachedHeader feeds this path: a near-tip
  // cached header that the served chain no longer carries is a structural failure.
  private async withSpvReseed<T>(op: (lc: LightClient) => Promise<T>): Promise<T> {
    const lc = await this.seededSpvLight();
    try { return await op(lc); }
    catch (e) {
      if (spvIsTransient(e)) throw e;
      const fresh = await this.seedFreshSpvLight();
      const out = await op(fresh);
      this._spvLight = fresh;
      return out;
    }
  }

  // A near-tip cached header the served chain no longer carries is a reorg: throw a structural error so
  // withSpvReseed rebuilds. The message must not match SPV_TRANSIENT_RE, or it would be retried on the stale cache.
  private async recheckCachedHeader(lc: LightClient, height: number, haveTo: number): Promise<void> {
    if (height <= haveTo - SPV_RECHECK_DEPTH) return;
    const cached = lc.chain[height - lc.baseHeight];
    if (!cached) return;   // the caller reports the missing header
    const [served] = await this.fetchHeadersBatch(height, 1);
    if (String(served?.hash ?? "").toLowerCase() !== String(cached.hash).toLowerCase())
      throw new Error(`SPV cached block at height ${height} is no longer on the served chain (reorg); reseeding`);
  }

  // Build + seed + tip-advance a FRESH light client into a LOCAL. Never touches this._spvLight:
  // the caller commits the result only on success (MF-14; the wallet G8 posture - never null or
  // dirty the shared field while an attempt is in flight).
  private async seedFreshSpvLight(): Promise<LightClient> {
    // W12: pass a BATCH header provider (checkpoint..tip in a few batched requests, each header re-verified
    // so it carries ZERO trust). Fixing the sync WITHOUT this converts a fast wrong answer into a
    // multi-thousand-request flood, so the provider is MANDATORY, not an optimization.
    const lc = new LightClient({
      client: this.chain.client,
      checkpoints: { [this._spvCp.height]: this._spvCp.hash },
      headersBatchProvider: (from, count) => this.fetchHeadersBatch(from, count),
    });
    await lc.syncFromCheckpoint(this._spvCp.height, this._spvCp.hash);
    // W12: ADVANCE TO THE LIVE TIP after the seed. Before B7c the SDK's SPV only seeded the checkpoint
    // window and never reached tip, so a near-tip offer never merkle-proved and every downstream fill
    // bind was dead (the inertness that hid the SDK's want-type hole; this is why B7c lands AFTER B7b's
    // binds are on). A transient tip/sync failure must NOT brick the seed: verifyTxInclusion self-syncs
    // (also batched) to a tx's height on demand, so fall soft and keep the seeded client usable.
    try {
      const tipHeight = Number((await this.chain.tip()).height);
      const have = spvTipOf(lc);
      if (Number.isFinite(tipHeight) && tipHeight > have) await lc.sync(tipHeight);
    } catch { /* keep the seeded client; on-demand batched sync covers what this pre-warm missed */ }
    return lc;
  }

  /** The PoW-verifying SPV light client, seeded from the pinned checkpoint and cached across calls
   *  (shared by the M3 header-merkle bind and the F13 offer pre-verify). The client is committed to
   *  the field ONLY after a fully successful seed (MF-14): a failed seed leaves NO cached state, so
   *  the next call retries on a fresh client instead of wedging on "seedTrusted must be called on a
   *  fresh client". Concurrent first callers share ONE in-flight seed. Re-seeded only when a
   *  structural (reorg) break is detected, see withSpvReseed. */
  private seededSpvLight(): Promise<LightClient> {
    if (this._spvLight) return Promise.resolve(this._spvLight);
    if (!this._spvSeedInflight) {
      this._spvSeedInflight = this.seedFreshSpvLight()
        .then((lc) => { this._spvLight = lc; return lc; })
        .finally(() => { this._spvSeedInflight = null; });
    }
    return this._spvSeedInflight;
  }

  /**
   * W12 batch header transport for the checkpoint..tip forward sync, backed by the cairn server's
   * `/api/headers/:from/:count`. Carries ZERO trust: the LightClient re-verifies every header's PoW /
   * prev-link / LWMA, so a forged or stale row fails closed and retrying transport proves nothing new.
   * Retry budget: a 429 (per-IP header budget) or 502/503 (a height past the lagging indexer, or the
   * server's 10s deadline), a transport/timeout error, or a body-read fault (an oversize stream past the
   * SPV_MAX_BATCH_BYTES cap, or a non-JSON 200 body such as a CF interstitial) is a transient
   * data-availability hiccup; back off (honouring Retry-After) a bounded number of times, then THROW so
   * `sync()` fails closed. A non-dense range is rejected terminally (never retried).
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
    const budget = new RetryWaitBudget(SPV_RETRY_WAIT_BUDGET_MS);
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let parsed: unknown;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), SPV_HTTP_TIMEOUT_MS);
      try {
        res = await doFetch(url, { signal: ctrl.signal });
        if (res.ok) {
          // MF-13: ONE controller bounds headers AND body (the timer stays armed through the read),
          // and the body goes through the shared capped reader so a never-ending or oversize 200
          // stream fails bounded. A 200 with a non-JSON body (a CF interstitial) throws here and is
          // retried below within the same bounded budget, then fails closed.
          parsed = JSON.parse(new TextDecoder().decode(await readCapped(res, SPV_MAX_BATCH_BYTES)));
        }
      } catch (e) {
        const waitMs = attempt < SPV_HTTP_MAX_RETRIES ? budget.take(spvBackoffMs(attempt), 0) : null;
        if (waitMs === null) throw e;   // transport / timeout / oversize / bad body: bounded retry, then fail closed
        await spvSleep(waitMs);
        continue;
      } finally { clearTimeout(timer); }
      if (res!.ok) {
        // ZERO trust in the row shape: the LightClient re-verifies every header (PoW / prev-link / LWMA)
        // against the pinned checkpoint, so a wrong `header` fails closed downstream, not here.
        const rows = (parsed as { headers?: { header: BlockHeader; hash: string }[] })?.headers;
        if (!Array.isArray(rows) || rows.length !== count) throw new Error(`/api/headers: non-dense range (${from}/${count})`);
        return rows.map((r) => ({ header: r.header, hash: r.hash }));
      }
      if ((res!.status === 429 || res!.status === 502 || res!.status === 503) && attempt < SPV_HTTP_MAX_RETRIES) {
        res!.body?.cancel?.().catch(() => {});   // drain the discarded body (undici holds the socket otherwise)
        const waitMs = budget.take(spvBackoffMs(attempt), retryAfterMs(res!));
        if (waitMs === null) throw new Error(`/api/headers ${res!.status}: Retry-After exceeds the remaining retry budget`);
        await spvSleep(waitMs);
        continue;
      }
      throw new Error(`/api/headers ${res!.status}`);
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
   *
   * Pass opts.pay (the CSD base units you intend to pay) to receive the PROVEN outputPlan for a whole fill of a
   * non-partial offer, and opts.plannedOutputs to bind your planned per-address sums to it before signing; build
   * EXACTLY the outputPlan, never resolver-served outputs.
   */
  async verifyOfferForFill(
    offerId: string,
    servedOffer?: unknown,
    opts?: { pay?: bigint | string | number; plannedOutputs?: Record<string, bigint | string | number> },
  ): Promise<OfferFillCheck> {
    // MF-03: the reseed also covers the fill path. preverifyOffer's own catch (fillverify.ts) otherwise
    // eats a structural (reorg) throw and reports transient forever, so we hand it a light handle whose
    // verifyTxInclusion reseeds ONCE on a structural break. Structurally typed, so fillverify.ts is untouched.
    // A verified inclusion answered from a cached near-tip header gets the same reorg re-check as verifyInclusion.
    const light = {
      verifyTxInclusion: (txidHex: string) => this.withSpvReseed(async (lc) => {
        const haveTo = spvTipOf(lc);
        const r = await lc.verifyTxInclusion(txidHex);
        if (r.trustLevel === "verified-inclusion" && typeof r.blockHeight === "number" && r.blockHeight <= haveTo)
          await this.recheckCachedHeader(lc, r.blockHeight, haveTo);
        return r;
      }),
    };
    return preverifyOffer({ light, client: this.chain.client, offerId, servedOffer, pay: opts?.pay, plannedOutputs: opts?.plannedOutputs });
  }

  /**
   * Detect + connect the Cairn Wallet (browser only) and attach it as `cairn.wallet`.
   * Resolves to the connected address.
   */
  async connect(opts: DetectOptions = {}): Promise<string> {
    const { wallet, address } = await connectWallet(opts);
    this.attachWallet(wallet);
    return address;
  }

  /** Attach an already-connected wallet (e.g. one you constructed yourself). */
  attachWallet(wallet: WalletConnection): void {
    this.wallet = wallet;
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
export type { NameResolution, NameDetail, TokenInfo, PrimaryName, NameHistory, NameHistoryEntry } from "./names.js";
export { IndexerClient } from "./indexer.js";
export type { MerkleProof, InclusionResult, IndexEvent, StreamHandlers, StreamHandle, TrustLevel } from "./indexer.js";
export { ContentClient } from "./content.js";
export type { PreparedContent, ContentClientOptions } from "./content.js";
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
export type { OfferFillCheck, ProvenOfferTerms, MintedProvenOfferTerms, FillEndorsement, FillOutputPlan, FillSafety, FillPreview } from "./fillverify.js";
