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
import { Chain, LightClient } from "./chain.js";
import { BoardClient } from "./board.js";
import { IndexerClient } from "./indexer.js";
import { ContentClient } from "./content.js";
import { RegistryClient } from "./registry.js";
import { WalletConnection, connect as connectWallet, type DetectOptions } from "./connect.js";

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

// The ecosystem SPV checkpoint (identical to cairn /trade swapguard's baked anchor). A consensus
// block hash, not a trusted server's word — the light client re-verifies every header forward from
// here. Pin a newer one via config.spvCheckpoint as the chain grows.
const DEFAULT_SPV_CHECKPOINT = { height: 31310, hash: "0x000000000000138bd3eee4b8d2fbacb8d5433ac3040ddbf1c45a5e3e0cc9e814" };

const DEFAULT_CAIRN = "https://cairn-substrate.com";


export class Cairn {
  readonly config: CairnConfig;
  readonly chain: Chain;
  readonly index: IndexerClient;
  readonly content: ContentClient;
  readonly registry: RegistryClient;
  board: BoardClient;
  wallet?: WalletConnection;

  private readonly cairnHttp: Http;
  // Lazily-seeded SPV light client + its checkpoint (audit M3 — PoW-verified header source).
  private _spvLight: LightClient | null = null;
  private _spvSeeded = false;
  private readonly _spvCp: { height: number; hash: string };

  constructor(config: CairnConfig = {}) {
    this.config = config;
    const fetch = config.fetch;
    const timeoutMs = config.timeoutMs;

    const cairn = (config.baseUrls?.cairn ?? DEFAULT_CAIRN).replace(/\/+$/, "");
    const rpc = config.baseUrls?.rpc ?? `${cairn}/api/rpc`;
    const indexer = (config.baseUrls?.indexer ?? `${cairn}/explorer/api`).replace(/\/+$/, "");

    this.cairnHttp = new Http({ baseUrl: cairn, fetch, timeoutMs });
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
    if (!this._spvLight) this._spvLight = new LightClient({ client: this.chain.client, checkpoints: { [this._spvCp.height]: this._spvCp.hash } });
    const lc = this._spvLight;
    if (!this._spvSeeded) { await lc.syncFromCheckpoint(this._spvCp.height, this._spvCp.hash); this._spvSeeded = true; }
    const haveTo = lc.baseHeight + lc.chain.length - 1;
    if (haveTo < height) await lc.sync(height);
    const vh = lc.chain[height - lc.baseHeight];
    if (!vh) throw new Error(`light client has no verified header at ${height}`);
    return String(vh.header.merkle);
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
export {
  CairnError,
  NotInstalledError,
  UserRejectedError,
  WalletLockedError,
  UnsupportedMethodError,
  HttpError,
  ContentVerificationError,
} from "./errors.js";
