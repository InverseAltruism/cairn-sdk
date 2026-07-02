// .csd names + CairnX market READS for third parties (Plan 56 item 20 / Plan 57 B10).
//
// Before this module the facade had NO CairnX surface at all — a third party would conclude
// Cairn is a signal board plus explorer and miss the names/trading product entirely. This is
// the read side: resolution, name detail/history, primary names, tokens, offers, bids, state.
//
// TRUST MODEL (read this before building on it — same honesty bar as registry.ts):
// these are SERVER-TRUSTED reads over the public front door (`/trade/api/cairnx/*`, the same
// GET-allowlisted proxy the Cairn UI renders from). They are the right tool for DISPLAY and
// discovery. They are NOT proof: nothing here merkle-verifies a name→address binding, and a
// compromised/withholding server could lie. Anything that SPENDS against a name must verify in
// the signer (the Cairn Wallet's send path runs full SPV name verification on-device; this SDK's
// `verifyInclusion` covers content/tx inclusion). Do not wire `resolve()` output straight into a
// payment target you sign elsewhere.
//
// Input names are pre-validated with cairnx-core's own NAME_RE (the consensus grammar), so a
// malformed input fails fast client-side instead of round-tripping to a 404.
import { NAME_RE, RESERVED_NAMES } from "@inversealtruism/cairnx-core";
import type { Http } from "./http.js";

/** `/cairnx/resolve/:name` — the display-path name→address resolution. */
export interface NameResolution {
  ok: boolean;
  name: string;
  /** Resolved recipient address (owner, or the nset target). ABSENT/undefined when not resolvable. */
  addr?: string;
  /** How the address was derived (e.g. "owner", "nset"). */
  via?: string;
  lapsed?: boolean;
  owner?: string;
  tipHeight?: number;
}

/** `/cairnx/name/:name` — full name detail (lease, lock, resting offer, recapture window). */
export interface NameDetail {
  name: string;
  owner: string;
  claimId: string;
  height: number;
  effectiveHeight: number;
  locked: boolean;
  paidThroughEpoch: number;
  offer: unknown | null;
  recapture: unknown | null;
  tipHeight: number;
  tipEpoch: number;
  /** v2.5+: a revealed-but-unfinalized registration (no lease yet; not actionable). */
  pending?: boolean;
  lease: {
    leased: boolean;
    paidThroughEpoch: number;
    graceEndEpoch: number;
    epochsLeft: number;
    graceEpochsLeft: number;
    inGrace: boolean;
    lapsed: boolean;
  } | null;
}

/** One row of `/cairnx/tokens`. Amounts are DECIMAL STRINGS of base units (may exceed 2^53). */
export interface TokenInfo {
  ticker: string;
  deployId: string;
  deployer: string;
  name?: string;
  decimals: number;
  supply: string;
  minted: string;
  mint?: string;
  mintLimit?: string;
  height: number;
}

export interface PrimaryName { ok: boolean; address: string; name?: string | null }

const nameOk = (n: unknown): n is string =>
  typeof n === "string" && NAME_RE.test(n) && !RESERVED_NAMES.has(n);

/**
 * Read client for the CairnX convention (names + token market) over a Cairn front door.
 * Construct via the main `Cairn` class (`cairn.names`); all methods are read-only.
 */
export class NamesClient {
  constructor(private readonly http: Http) {}

  /** Resolve a .csd name for DISPLAY (server-trusted; see the module trust note). null = unknown/invalid name. */
  async resolve(name: string): Promise<NameResolution | null> {
    if (!nameOk(name)) return null;
    try { return await this.http.getJson<NameResolution>(`/trade/api/cairnx/resolve/${name}`); }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
  }

  /** Full detail for one name (lease, lock, resting offer, recapture). null = not registered/invalid. */
  async name(name: string): Promise<NameDetail | null> {
    if (!nameOk(name)) return null;
    try { return await this.http.getJson<NameDetail>(`/trade/api/cairnx/name/${name}`); }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
  }

  /** The event history of one name (registrations, transfers, sets, renewals). null = invalid name. */
  async nameHistory(name: string): Promise<unknown[] | null> {
    if (!nameOk(name)) return null;
    try { return await this.http.getJson<unknown[]>(`/trade/api/cairnx/name-history/${name}`); }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
  }

  /** Reverse lookup: an address's chosen primary .csd name (null name = none set). */
  async primary(addr: string): Promise<PrimaryName | null> {
    if (typeof addr !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
    try { return await this.http.getJson<PrimaryName>(`/trade/api/cairnx/primary/${addr.toLowerCase()}`); }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
  }

  /** All names an address owns (plus its primary), as served by `/cairnx/address/:addr`. */
  async namesOf(addr: string): Promise<unknown | null> {
    if (typeof addr !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
    try { return await this.http.getJson<unknown>(`/trade/api/cairnx/address/${addr.toLowerCase()}`); }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
  }

  /** All registered names (display list; short-edge-cached server-side). */
  names(): Promise<unknown[]> { return this.http.getJson<unknown[]>(`/trade/api/cairnx/names`); }

  /** All deployed tokens. */
  tokens(): Promise<TokenInfo[]> { return this.http.getJson<TokenInfo[]>(`/trade/api/cairnx/tokens`); }

  /** One token by ticker. null = unknown/invalid ticker. */
  async token(ticker: string): Promise<TokenInfo | null> {
    if (typeof ticker !== "string" || !/^[A-Z][A-Z0-9]{2,11}$/.test(ticker)) return null;
    try { return await this.http.getJson<TokenInfo>(`/trade/api/cairnx/token/${ticker}`); }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
  }

  /** Open offers (the market's display list). */
  offers(): Promise<unknown[]> { return this.http.getJson<unknown[]>(`/trade/api/cairnx/offers`); }

  /** Open bids. */
  bids(): Promise<unknown[]> { return this.http.getJson<unknown[]>(`/trade/api/cairnx/bids`); }

  /** The full canonical CairnX state (large; prefer the scoped reads above). */
  state(): Promise<unknown> { return this.http.getJson<unknown>(`/trade/api/cairnx/state`); }
}
