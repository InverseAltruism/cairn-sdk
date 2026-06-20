// ContentClient — self-certifying content over the L1 swarm + cairn origin.
//
// Content is addressed by `payloadHash` = sha256(canonicalJson(obj)). Retrieval is
// ALWAYS verified client-side: bytes that don't hash to the requested hash are
// rejected (ContentVerificationError), so an untrusted gateway/transport cannot
// serve tampered content. Publishing is anchored on-chain via a board Propose
// (see BoardClient.propose) — `put()` here computes the hash/bytes for that.

import { payloadHash, canonicalJson, verifyContentBytes } from "@inversealtruism/csd-codec";
import type { Http } from "./http.js";
import { ContentVerificationError } from "./errors.js";

export interface ContentClientOptions {
  /** Swarm gateway HTTP client (e.g. https://cairn-substrate.com/swarm). */
  swarm?: Http;
  /** Cairn origin HTTP client (serves /content as origin + fallback). */
  cairn?: Http;
  /** Indexer HTTP client (also joins the swarm gateway at /content). */
  indexer?: Http;
}

export interface PreparedContent {
  /** The 0x-prefixed sha256 payload hash that goes on-chain. */
  payloadHash: string;
  /** The exact canonical JSON string that was hashed. */
  canonical: string;
  /** UTF-8 bytes of the canonical JSON (what the swarm stores / serves). */
  bytes: Uint8Array;
}

export class ContentClient {
  private readonly sources: { name: string; http: Http; path: (hash: string) => string }[];

  constructor(opts: ContentClientOptions) {
    this.sources = [];
    // Preference order: swarm gateway → indexer → cairn origin. Each is verified anyway.
    if (opts.swarm) this.sources.push({ name: "swarm", http: opts.swarm, path: (h) => `/content/${h}` });
    if (opts.indexer) this.sources.push({ name: "indexer", http: opts.indexer, path: (h) => `/content/${h}` });
    if (opts.cairn) this.sources.push({ name: "cairn", http: opts.cairn, path: (h) => `/content/${h}` });
  }

  /**
   * Compute the canonical hash + bytes for an object, ready to anchor on-chain.
   * This is byte-identical to what the cairn server and wallet compute.
   */
  prepare(obj: unknown): PreparedContent {
    const canonical = canonicalJson(obj);
    return {
      payloadHash: payloadHash(obj),
      canonical,
      bytes: new TextEncoder().encode(canonical),
    };
  }

  /** Alias for `prepare()` — emphasises this does not itself publish (anchor via board.propose). */
  put(obj: unknown): PreparedContent {
    return this.prepare(obj);
  }

  /** Just the payload hash for an object. */
  hash(obj: unknown): string {
    return payloadHash(obj);
  }

  /**
   * Fetch content by hash and VERIFY it self-certifies (sha256(bytes) == hash).
   * Tries each configured source in order. Returns raw bytes, or null if no
   * source holds it. Throws ContentVerificationError if a source returns bytes
   * that don't match the hash (tampering / wrong object).
   */
  async getBytes(hash: string): Promise<Uint8Array | null> {
    const h = normalizeHash(hash);
    for (const src of this.sources) {
      let got: { bytes: Uint8Array; headers: Headers } | null = null;
      try {
        got = await src.http.getBytes(src.path(h));
      } catch {
        continue; // source unreachable — try the next
      }
      if (!got) continue; // 404 from this source
      if (!verifyContentBytes(got.bytes, h)) {
        throw new ContentVerificationError(h);
      }
      return got.bytes;
    }
    return null;
  }

  /** Fetch + verify + parse as UTF-8 JSON. Returns null if not found. */
  async get<T = unknown>(hash: string): Promise<T | null> {
    const bytes = await this.getBytes(hash);
    if (!bytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  /** Verify already-fetched bytes against a hash (no network). */
  verify(bytes: Uint8Array, hash: string): boolean {
    return verifyContentBytes(bytes, normalizeHash(hash));
  }
}

function normalizeHash(hash: string): string {
  const h = (hash.startsWith("0x") || hash.startsWith("0X") ? hash : `0x${hash}`).toLowerCase();
  // CAIRNSDK-CONTENT-HASH-PATH-1: a content hash is interpolated raw into `/content/${h}`. Reject anything
  // that isn't a 0x+64-hex hash so a "hash" like `x/../../api/treasury` can't path-walk to another endpoint.
  if (!/^0x[0-9a-f]{64}$/.test(h)) throw new Error(`invalid content hash: ${hash}`);
  return h;
}
