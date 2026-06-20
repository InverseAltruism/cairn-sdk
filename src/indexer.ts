// IndexerClient — the L2 explorer/indexer: Esplora-style REST + merkle proofs
// (L0-verifiable) + live SSE/WS feeds with reorg events.
//
// Streaming is portable: SSE is parsed over fetch (works in browser, Node 18+,
// and MV3 workers) with auto-reconnect; WS uses the global WebSocket if present.

import { verifyMerkleProof } from "@inversealtruism/csd-codec";
import type { Http, FetchLike } from "./http.js";

export interface MerkleProof {
  block_height: number;
  pos: number;
  merkle: string[];
  merkle_root: string;
}

export type TrustLevel = "verified-inclusion" | "proof-consistent" | "not-found";

export interface InclusionResult {
  included: boolean;
  trustLevel: TrustLevel;
  blockHeight?: number;
  pos?: number;
  merkleRoot?: string;
  reason?: string;
  /** CAIRN-SPV-3: set true when a folding proof's root conflicts with the PoW-verified on-chain header
   *  merkle (active indexer↔chain equivocation/tamper) — distinct from an honest tx-absence. Consumers that
   *  retry on `not-found` MUST check this and treat it as a detected attack, NOT a benign miss. */
  equivocation?: boolean;
}

// CAIRNSDK-DESER-3 / CAIRN-SPV-2: validate an indexer-supplied merkle proof BEFORE folding it. The proof
// source is untrusted; csd-codec's verifyMerkleProof THROWS (not returns false) on wrong-typed fields, and
// the fold is outside the fetch try/catch — so a malformed proof escaped as an unhandled rejection (fail-
// BROKEN) instead of a clean {trustLevel:"not-found"} (fail-closed). This never affects a VALID proof.
const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const MAX_SSE_BUF = 1024 * 1024; // CAIRNSDK-DESER-1: cap the SSE inter-frame buffer (untrusted source → OOM)
function isValidMerkleProof(p: unknown): p is MerkleProof {
  if (!p || typeof p !== "object") return false;
  const m = p as Record<string, unknown>;
  return Number.isInteger(m.block_height) && (m.block_height as number) >= 0
    && Number.isInteger(m.pos) && (m.pos as number) >= 0
    && typeof m.merkle_root === "string" && HEX64.test(m.merkle_root)
    && Array.isArray(m.merkle) && m.merkle.every((x) => typeof x === "string" && HEX64.test(x));
}

/** A live index event ({ kind: "block" | "proposal" | "attestation" | "reorg", ... }). */
export interface IndexEvent {
  kind: "block" | "proposal" | "attestation" | "reorg";
  [k: string]: unknown;
}

export interface IndexerClientOptions {
  fetch?: FetchLike;
  /** A WebSocket implementation (defaults to globalThis.WebSocket). */
  WebSocketImpl?: typeof WebSocket;
  /**
   * Optional: given a block height, return its on-chain header merkle root. verifyInclusion()
   * cross-checks the indexer's proof root against this and, on a match, labels the result
   * "verified-inclusion". IMPORTANT: that label is only as strong as THIS source — it is fully
   * trust-minimized ONLY if the header is independently verified (e.g. a PoW-checking light client,
   * or at least a node on a DIFFERENT trust domain than the indexer). A header fetched by raw RPC
   * from the SAME server that serves the proof proves nothing (one compromised server controls
   * both); for that case prefer no headerMerkleAt → an honest "proof-consistent".
   */
  headerMerkleAt?: (height: number) => Promise<string>;
}

export class IndexerClient {
  private readonly http: Http;
  private readonly opts: IndexerClientOptions;

  constructor(http: Http, opts: IndexerClientOptions = {}) {
    this.http = http;
    this.opts = opts;
  }

  // ---- REST --------------------------------------------------------------

  health(): Promise<unknown> {
    return this.http.getJson("/health");
  }

  tipHeight(): Promise<number> {
    return this.http.getJson<number>("/blocks/tip/height");
  }

  tipHash(): Promise<string> {
    return this.http.getJson<string>("/blocks/tip/hash");
  }

  blockHashAtHeight(h: number): Promise<string> {
    return this.http.getJson<string>(`/block-height/${h}`);
  }

  // CAIRNSDK-CONTENT-HASH-PATH-1: encode every caller-supplied id segment. Raw interpolation let an id like
  // `../../api/rpc/tip` walk `new URL` to a DIFFERENT same-origin endpoint whose body was then returned
  // verbatim as the requested object (worse than the content case, which discards the walked-to response).
  block(hash: string): Promise<unknown> {
    return this.http.getJson(`/block/${encodeURIComponent(hash)}`);
  }

  blockTxids(hash: string): Promise<string[]> {
    return this.http.getJson<string[]>(`/block/${encodeURIComponent(hash)}/txids`);
  }

  tx(id: string): Promise<unknown> {
    return this.http.getJson(`/tx/${encodeURIComponent(id)}`);
  }

  txStatus(id: string): Promise<{ confirmed: boolean; block_height: number; confirmations: number; final: boolean }> {
    return this.http.getJson(`/tx/${encodeURIComponent(id)}/status`);
  }

  txMerkleProof(id: string): Promise<MerkleProof> {
    return this.http.getJson<MerkleProof>(`/tx/${encodeURIComponent(id)}/merkle-proof`);
  }

  address(a: string): Promise<unknown> {
    return this.http.getJson(`/address/${encodeURIComponent(a)}`);
  }

  addressTxs(a: string): Promise<unknown[]> {
    return this.http.getJson<unknown[]>(`/address/${encodeURIComponent(a)}/txs`);
  }

  addressUtxo(a: string): Promise<unknown[]> {
    return this.http.getJson<unknown[]>(`/address/${encodeURIComponent(a)}/utxo`);
  }

  reputation(a: string): Promise<unknown> {
    return this.http.getJson(`/address/${encodeURIComponent(a)}/reputation`);
  }

  domains(): Promise<unknown[]> {
    return this.http.getJson<unknown[]>("/domains");
  }

  domainProposals(d: string): Promise<unknown[]> {
    return this.http.getJson<unknown[]>(`/domain/${encodeURIComponent(d)}/proposals`);
  }

  proposal(id: string): Promise<unknown> {
    return this.http.getJson(`/proposal/${encodeURIComponent(id)}`);
  }

  attestations(id: string): Promise<unknown[]> {
    return this.http.getJson<unknown[]>(`/proposal/${encodeURIComponent(id)}/attestations`);
  }

  registryPeers(): Promise<unknown[]> {
    return this.http.getJson<unknown[]>("/registry/peers");
  }

  registryGateways(): Promise<unknown[]> {
    return this.http.getJson<unknown[]>("/registry/gateways");
  }

  identity(handle: string): Promise<unknown> {
    return this.http.getJson(`/identity/${encodeURIComponent(handle)}`);
  }

  reverseIdentity(addr: string): Promise<unknown> {
    return this.http.getJson(`/address/${encodeURIComponent(addr)}/identity`);
  }

  // ---- trust-minimized inclusion ----------------------------------------

  /**
   * Verify a tx is included in a block by folding its merkle branch to the root
   * with csd-codec.verifyMerkleProof. If `headerMerkleAt` was provided, the
   * proof's root is cross-checked against the header merkle at that height →
   * trustLevel "verified-inclusion" (only as trustworthy as that header source —
   * see headerMerkleAt). Otherwise the proof is only internally consistent →
   * "proof-consistent" (still useful, but the indexer is trusted). INDEXER-DOC-STALE-1: the Cairn facade now
   * wires headerMerkleAt UNCONDITIONALLY via a PoW-verifying checkpoint light client (index.ts), so the
   * default reaches "verified-inclusion" when the proof root matches the PoW-verified header — what makes a
   * same-origin RPC safe is the forward PoW re-verification, not an origin gate (which no longer exists).
   * Fails closed: a malformed proof or a chain-disagreement returns "not-found" (the latter with equivocation:true).
   */
  async verifyInclusion(txid: string): Promise<InclusionResult> {
    let proof: MerkleProof;
    try {
      proof = await this.txMerkleProof(txid);
    } catch {
      return { included: false, trustLevel: "not-found", reason: "no merkle proof (tx not indexed)" };
    }
    // CAIRNSDK-DESER-3 / CAIRN-SPV-2: fail CLOSED on a malformed proof (validate before folding) — never let
    // verifyMerkleProof throw past the documented Promise<InclusionResult> contract.
    if (!isValidMerkleProof(proof)) {
      return { included: false, trustLevel: "not-found", reason: "malformed merkle proof" };
    }
    let folds = false;
    try {
      folds = verifyMerkleProof(txid, proof.pos, proof.merkle, proof.merkle_root);
    } catch {
      return { included: false, trustLevel: "not-found", blockHeight: proof.block_height, reason: "malformed merkle proof" };
    }
    if (!folds) {
      return { included: false, trustLevel: "not-found", blockHeight: proof.block_height, reason: "merkle branch does not fold to the claimed root" };
    }
    if (this.opts.headerMerkleAt) {
      try {
        const onchain = await this.opts.headerMerkleAt(proof.block_height);
        if (norm(onchain) !== norm(proof.merkle_root)) {
          // CAIRN-SPV-3: a folding proof whose root != the PoW-verified header is active equivocation, not
          // absence — flag it distinctly so chain↔indexer disagreement monitoring isn't lost in "not-found".
          return { included: false, trustLevel: "not-found", equivocation: true, blockHeight: proof.block_height, reason: "proof root != on-chain header merkle (indexer disagrees with chain)" };
        }
        return { included: true, trustLevel: "verified-inclusion", blockHeight: proof.block_height, pos: proof.pos, merkleRoot: proof.merkle_root };
      } catch {
        // fall through to proof-consistent if the header couldn't be fetched
      }
    }
    return { included: true, trustLevel: "proof-consistent", blockHeight: proof.block_height, pos: proof.pos, merkleRoot: proof.merkle_root };
  }

  // ---- live streams ------------------------------------------------------

  /** Stream all events (blocks, proposals, attestations, reorgs) via SSE. */
  streamAll(handlers: StreamHandlers): StreamHandle {
    return this.sse("/stream/all", handlers);
  }

  /** Stream blocks + reorgs only. */
  streamBlocks(handlers: StreamHandlers): StreamHandle {
    return this.sse("/stream/blocks", handlers);
  }

  /** Stream proposals (+ reorgs) for a domain. */
  streamDomain(domain: string, handlers: StreamHandlers): StreamHandle {
    return this.sse(`/stream/domain/${encodeURIComponent(domain)}`, handlers);
  }

  /**
   * Subscribe over WebSocket with selective tracking. Returns a handle with
   * `.close()`. `onEvent` receives every matching IndexEvent (incl. reorgs).
   *
   * WS-NORECONNECT-1: unlike the SSE feeds (streamAll/streamBlocks/streamDomain, which auto-reconnect with
   * backoff), this WebSocket subscription does NOT auto-reconnect — it surfaces a terminal error via
   * `onError` (when provided) and stops. A consumer tracking reorgs over WS MUST re-`subscribe()` on error
   * to avoid a silently-stale view; for built-in reconnect prefer the SSE `stream*` methods.
   */
  subscribe(sub: { all?: boolean; domains?: string[]; addresses?: string[]; proposals?: string[] }, onEvent: (e: IndexEvent) => void, onError?: (err: unknown) => void): StreamHandle {
    const WS = this.opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) {
      throw new Error("No WebSocket available — pass WebSocketImpl in the indexer options (e.g. in older Node).");
    }
    const wsUrl = this.http.url("/ws").replace(/^http/, "ws");
    let closed = false;
    const ws = new WS(wsUrl);
    ws.addEventListener("open", () => {
      const msg: Record<string, unknown> = {};
      if (sub.all) msg["track-all"] = true;
      if (sub.domains?.length) msg["track-domain"] = sub.domains;
      if (sub.addresses?.length) msg["track-address"] = sub.addresses;
      if (sub.proposals?.length) msg["track-proposal"] = sub.proposals;
      ws.send(JSON.stringify(Object.keys(msg).length ? msg : { "track-all": true }));
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      try {
        const data = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        if (data && data.kind) onEvent(data as IndexEvent);
      } catch {
        /* ignore non-JSON / hello / ack frames */
      }
    });
    if (onError) ws.addEventListener("error", (e: Event) => onError(e));
    return {
      close() {
        if (closed) return;
        closed = true;
        try { ws.close(); } catch { /* no-op */ }
      },
    };
  }

  // ---- internal SSE over fetch (portable + auto-reconnect) ---------------

  private sse(path: string, handlers: StreamHandlers): StreamHandle {
    const fetchImpl = this.opts.fetch ?? (globalThis.fetch as FetchLike);
    const url = this.http.url(path);
    let closed = false;
    let ctrl: AbortController | null = null;

    const run = async () => {
      while (!closed) {
        ctrl = new AbortController();
        try {
          const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: "text/event-stream" } });
          if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
          handlers.onOpen?.();
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              dispatchFrame(frame, handlers);
            }
            // CAIRNSDK-DESER-1: cap the inter-delimiter buffer. The SSE source is untrusted (indexer.ts header);
            // a source that withholds "\n\n" otherwise grows `buf` to the full byte count sent → client OOM.
            // Abort (→ caught below → onError + reconnect) instead of buffering unboundedly.
            if (buf.length > MAX_SSE_BUF) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error(`SSE buffer exceeded ${MAX_SSE_BUF} bytes with no frame delimiter — aborting`); }
          }
        } catch (err) {
          if (closed) return;
          handlers.onError?.(err);
        }
        if (closed) return;
        await new Promise((r) => setTimeout(r, 2000)); // reconnect backoff
      }
    };
    void run();

    return {
      close() {
        if (closed) return;
        closed = true;
        try { ctrl?.abort(); } catch { /* no-op */ }
      },
    };
  }
}

export interface StreamHandlers {
  onEvent?: (e: IndexEvent) => void;
  onBlock?: (e: IndexEvent) => void;
  onProposal?: (e: IndexEvent) => void;
  onAttestation?: (e: IndexEvent) => void;
  onReorg?: (e: IndexEvent) => void;
  onOpen?: () => void;
  onError?: (err: unknown) => void;
}

export interface StreamHandle {
  close(): void;
}

function dispatchFrame(frame: string, h: StreamHandlers): void {
  // Parse "event: <kind>\ndata: <json>" SSE frames; ignore ": ping" comments + "hello".
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // comment / ping
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (event === "hello" || dataLines.length === 0) return;
  let parsed: IndexEvent;
  try {
    parsed = JSON.parse(dataLines.join("\n")) as IndexEvent;
  } catch {
    return;
  }
  h.onEvent?.(parsed);
  if (parsed.kind === "block") h.onBlock?.(parsed);
  else if (parsed.kind === "proposal") h.onProposal?.(parsed);
  else if (parsed.kind === "attestation") h.onAttestation?.(parsed);
  else if (parsed.kind === "reorg") h.onReorg?.(parsed);
}

function norm(h: string): string {
  return String(h).toLowerCase().replace(/^0x/, "");
}
