// RegistryClient — L3 self-certifying registries (peers / gateways / identity)
// built on the Propose/Attest primitive. Wraps @inversealtruism/csd-registry's
// indexer-discovery helpers, and re-exports the deterministic `fromRecords`
// resolvers so a caller can recompute resolution locally from raw chain records.

import {
  discoverPeers,
  discoverGateways,
  resolveName,
  reverseName,
  fromRecords,
  verifyPeer,
  verifyGateway,
  verifyIdentitySig,
  DOMAINS,
} from "@inversealtruism/csd-registry";
import type { FetchLike } from "./http.js";

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
  private readonly src: { baseUrl: string; fetch?: FetchLike };

  constructor(opts: RegistryClientOptions) {
    this.src = { baseUrl: opts.baseUrl.replace(/\/+$/, ""), fetch: opts.fetch };
  }

  /** Discover ranked content/pin gateways (GET /registry/gateways). */
  gateways() {
    return discoverGateways(this.src);
  }

  /** Discover ranked libp2p peers (GET /registry/peers). */
  peers() {
    return discoverPeers(this.src);
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
  resolveName(handle: string) {
    return resolveName(this.src, handle);
  }

  /** Reverse-resolve an address → identity (GET /address/:addr/identity).
   *  ⚠ Same indexer-trust caveat as resolveName — `verified` is the indexer's claim, not a client proof. */
  reverseName(address: string) {
    return reverseName(this.src, address);
  }

  /** The deterministic, client-side resolvers (recompute from raw ChainRecord[]). */
  get fromRecords() {
    return fromRecords;
  }
}
