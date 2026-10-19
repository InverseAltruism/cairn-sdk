// ContentClient: self-certifying content from the cairn origin's `/content` store.
//
// Content is addressed by `payloadHash` = sha256(canonicalJson(obj)). Retrieval is
// ALWAYS verified client-side: bytes that don't hash to the requested hash are
// rejected (ContentVerificationError), so the transport cannot serve tampered
// content. Publishing is anchored on-chain by a Propose carrying the payload hash
// (`wallet.propose`); `put()` here computes the hash/bytes for that.

import { payloadHash, canonicalJson, verifyContentBytes } from "@inversealtruism/csd-codec";
import type { Http } from "./http.js";
import { CairnError, ContentVerificationError } from "./errors.js";

export interface ContentClientOptions {
  /** Cairn origin HTTP client; it serves `/content/<hash>`. */
  cairn: Http;
}

export interface PreparedContent {
  /** The 0x-prefixed sha256 payload hash that goes on-chain. */
  payloadHash: string;
  /** The exact canonical JSON string that was hashed. */
  canonical: string;
  /** UTF-8 bytes of the canonical JSON (what the origin stores and serves). */
  bytes: Uint8Array;
}

export class ContentClient {
  private readonly cairn: Http;

  constructor(opts: ContentClientOptions) {
    // A plain-JS 0.6.0 caller passing only `swarm` or `indexer` would otherwise read null for every hash, with no
    // tamper check: refuse at construction instead.
    if (!opts?.cairn || typeof opts.cairn.getBytes !== "function") {
      throw new TypeError("ContentClient needs a `cairn` Http client (the swarm and indexer sources were removed in 0.7.0)");
    }
    this.cairn = opts.cairn;
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

  /** Alias for `prepare()`. It does not publish anything; anchor the hash with a Propose. */
  put(obj: unknown): PreparedContent {
    return this.prepare(obj);
  }

  /** Just the payload hash for an object. */
  hash(obj: unknown): string {
    return payloadHash(obj);
  }

  /**
   * Fetch content by hash and VERIFY it self-certifies (sha256(bytes) == hash).
   * Returns the verified bytes, or null when the origin does not hold the content
   * or cannot be reached (as 0.6.0 did when every source failed). Throws
   * ContentVerificationError when the origin serves bytes that don't match the hash.
   */
  async getBytes(hash: string): Promise<Uint8Array | null> {
    const h = normalizeHash(hash);
    let got: { bytes: Uint8Array; headers: Headers } | null = null;
    try {
      got = await this.cairn.getBytes(`/content/${h}`);
    } catch {
      return null; // origin unreachable: not found, as 0.6.0 reported it when every source failed
    }
    if (!got) return null; // 404
    if (!verifyContentBytes(got.bytes, h)) throw new ContentVerificationError(h);
    return got.bytes;
  }

  /** Fetch + verify + parse as UTF-8 JSON. Returns null if not found. Throws a CairnError with code
   *  CONTENT_NOT_JSON when the verified bytes are not JSON. */
  async get<T = unknown>(hash: string): Promise<T | null> {
    const bytes = await this.getBytes(hash);
    if (!bytes) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch (e) {
      throw new CairnError(`Content ${normalizeHash(hash)} verified against its hash but is not JSON; use getBytes() for raw content.`, { code: "CONTENT_NOT_JSON", cause: e });
    }
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
