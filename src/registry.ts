// RegistryClient — L3 self-certifying registries (peers / gateways / identity)
// built on the Propose/Attest primitive. MF-12: the indexer reads (peers / gateways /
// identity / reverse-identity) run LOCALLY over the SDK's hardened Http (15s timeout,
// 16 MiB streamed cap, typed HttpError, base-escape backstop) instead of csd-registry's
// raw fetch helpers; only the deterministic `fromRecords` resolvers + record builders +
// types still come from @inversealtruism/csd-registry (re-exported so a caller can
// recompute resolution locally from raw chain records). The four indexer paths are
// transport routes, not consensus values, so declaring them locally keeps the
// no-local-consensus invariant intact.

import { fromRecords } from "@inversealtruism/csd-registry";
import type { RankedGateway, RankedPeer, ResolvedIdentity } from "@inversealtruism/csd-registry";
import { Http, type FetchLike } from "./http.js";
import { HttpError } from "./errors.js";

// Re-export the deterministic resolvers + record builders + types for advanced use.
export {
  fromRecords,
  verifyPeer,
  verifyGateway,
  verifyIdentitySig,
  DOMAINS,
  buildPeerRecord,
  buildGatewayRecord,
  buildIdentityCommit,
  buildIdentityReveal,
  epochOf,
} from "@inversealtruism/csd-registry";
export type {
  RankedPeer,
  RankedGateway,
  ResolvedIdentity,
  ChainRecord,
  ResolveOpts,
  BuiltRecord,
} from "@inversealtruism/csd-registry";

export interface RegistryClientOptions {
  /** Indexer base URL exposing /registry/* + /identity/* (e.g. https://cairn-substrate.com/indexer). */
  baseUrl: string;
  fetch?: FetchLike;
}

export class RegistryClient {
  private readonly http: Http;
  /** Accepts the SDK's hardened Http directly (the Cairn facade path) or the legacy
   *  { baseUrl, fetch } options (kept for direct constructors; they now get the same
   *  hardened transport, built internally). */
  constructor(src: Http | RegistryClientOptions) {
    this.http = src instanceof Http ? src : new Http({ baseUrl: src.baseUrl, fetch: src.fetch });
  }

  /** Discover ranked content/pin gateways (GET /registry/gateways). */
  gateways(): Promise<RankedGateway[]> {
    return this.http.getJson<RankedGateway[]>("/registry/gateways");
  }

  /** Discover ranked libp2p peers (GET /registry/peers). */
  peers(): Promise<RankedPeer[]> {
    return this.http.getJson<RankedPeer[]>("/registry/peers");
  }

  /**
   * Resolve a handle → identity (GET /identity/:handle). Returns null if unresolved.
   *
   * ⚠ TRUST (CAIRN-SDK-RESOLVE-VERIFIED-FOOTGUN): the returned `verified` flag is the INDEXER's assertion,
   * NOT a client-side proof. A hostile/compromised indexer (or a MITM of the read proxy) can return
   * `verified:true` for a wrong address. Do NOT use this directly as a payee/login target without either (a)
   * recomputing from raw records via `fromRecords.name(...)`, or (b) cross-checking a second independent
   * source (the wallet's namespv union cure). Treat `verified` here as a hint, not a guarantee.
   */
  resolveName(handle: string): Promise<ResolvedIdentity | null> {
    return this.getOr404Null<ResolvedIdentity>(`/identity/${encodeURIComponent(handle)}`);
  }

  /** Reverse-resolve an address → identity (GET /address/:addr/identity).
   *  ⚠ Same indexer-trust caveat as resolveName — `verified` is the indexer's claim, not a client proof. */
  reverseName(address: string): Promise<ResolvedIdentity | null> {
    return this.getOr404Null<ResolvedIdentity>(`/address/${encodeURIComponent(address)}/identity`);
  }

  // MF-12: 404 → null (the preserved csd-registry contract for both name resolvers); every other
  // failure rethrows the typed HttpError/CairnError the hardened Http raises.
  private async getOr404Null<T>(path: string): Promise<T | null> {
    try { return await this.http.getJson<T>(path); }
    catch (e) { if (e instanceof HttpError && e.status === 404) return null; return Promise.reject(e); }
  }

  /** The deterministic, client-side resolvers (recompute from raw ChainRecord[]). */
  get fromRecords() {
    return fromRecords;
  }
}
