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
// malformed input fails fast client-side instead of round-tripping to a 404. Responses that a dApp does
// arithmetic or iteration on (token amounts and decimals, the list reads) are shape-checked before they are
// returned; a body that does not match throws a typed HttpError instead of reaching the caller as a typed lie.
import { NAME_RE, RESERVED_NAMES, TICKER_RE, AMOUNT_RE, HASH_RE, type NameState } from "@inversealtruism/cairnx-core";
import type { Http } from "./http.js";
import { HttpError } from "./errors.js";

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

/** One `/cairnx/name-history` event: the txid a wallet fetches and merkle-verifies. `kind` is diagnostic only. */
export interface NameHistoryEntry {
  txid: string;
  height: number;
  pos: number;
  kind: string;
}

/** `/cairnx/name-history/:name`: the server's current claim plus the UNTRUSTED txid hints a verifier replays. */
export interface NameHistory {
  ok: boolean;
  name: string;
  tipHeight: number;
  /** the server's forward resolution (what a verifier recomputes and must match) */
  resolve: Omit<NameResolution, "ok">;
  /** the server's full name record */
  record?: NameState;
  events: NameHistoryEntry[];
  /** `false`: replaying only `events` cannot prove this name's owner (see `caveat`); never treat a match as verified. */
  scopedReplaySufficient: boolean;
  caveat?: string;
}

const nameOk = (n: unknown): n is string =>
  typeof n === "string" && NAME_RE.test(n) && !RESERVED_NAMES.has(n);

const amountOk = (v: unknown): v is string => typeof v === "string" && AMOUNT_RE.test(v);
// The upper bound on decimals is enforced by cairnx-core's deploy parser and not exported, so it is not
// re-declared here; the guard keeps decimals a usable non-negative integer.
const heightOk = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
function nameHistoryProblem(h: unknown, name: string): string | null {
  if (!h || typeof h !== "object" || Array.isArray(h)) return "not an object";
  const r = h as Record<string, unknown>;
  if (r.name !== name) return `name is ${JSON.stringify(r.name)}, expected ${JSON.stringify(name)}`;
  if (!heightOk(r.tipHeight)) return "bad tipHeight";
  if (!r.resolve || typeof r.resolve !== "object") return "resolve is not an object";
  if (typeof r.scopedReplaySufficient !== "boolean") return "scopedReplaySufficient is not a boolean";
  if (!Array.isArray(r.events)) return "events is not an array";
  for (const [i, e] of r.events.entries()) {
    const ev = e as Record<string, unknown> | null;
    if (!ev || typeof ev.txid !== "string" || !HASH_RE.test(ev.txid) || !heightOk(ev.height) || !heightOk(ev.pos) || typeof ev.kind !== "string")
      return `event ${i} is malformed`;
  }
  return null;
}

function tokenProblem(t: unknown): string | null {
  if (!t || typeof t !== "object") return "not an object";
  const r = t as Record<string, unknown>;
  if (typeof r.ticker !== "string" || !TICKER_RE.test(r.ticker)) return "bad ticker";
  if (!Number.isSafeInteger(r.decimals) || (r.decimals as number) < 0) return `bad decimals (${String(r.decimals)})`;
  if (!amountOk(r.supply)) return "supply is not a base-unit integer string";
  if (!amountOk(r.minted)) return "minted is not a base-unit integer string";
  if (r.mintLimit !== undefined && !amountOk(r.mintLimit)) return "mintLimit is not a base-unit integer string";
  return null;
}

/**
 * Read client for the CairnX convention (names + token market) over a Cairn front door.
 * Construct via the main `Cairn` class (`cairn.names`); all methods are read-only.
 */
export class NamesClient {
  constructor(private readonly http: Http) {}

  private malformed(path: string, what: string): HttpError {
    return new HttpError(200, this.http.url(path), `malformed response: ${what}`);
  }

  private async list(path: string): Promise<unknown[]> {
    const body = await this.http.getJson<unknown>(path);
    if (!Array.isArray(body)) throw this.malformed(path, "expected an array");
    return body;
  }

  /** Resolve a .csd name for DISPLAY (server-trusted; see the module trust note). null = unknown/invalid name. */
  async resolve(name: string): Promise<NameResolution | null> {
    if (!nameOk(name)) return null;
    try { return await this.http.getJson<NameResolution>(`/trade/api/cairnx/resolve/${encodeURIComponent(name)}`); }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
  }

  /** Full detail for one name (lease, lock, resting offer, recapture). null = not registered/invalid. */
  async name(name: string): Promise<NameDetail | null> {
    if (!nameOk(name)) return null;
    try { return await this.http.getJson<NameDetail>(`/trade/api/cairnx/name/${encodeURIComponent(name)}`); }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
  }

  /** The event history of one name (registrations, transfers, sets, renewals) with the server's current
   *  claim. null = invalid or unregistered name. Throws a typed HttpError on a malformed body. */
  async nameHistory(name: string): Promise<NameHistory | null> {
    if (!nameOk(name)) return null;
    const path = `/trade/api/cairnx/name-history/${encodeURIComponent(name)}`;
    let h: unknown;
    try { h = await this.http.getJson<unknown>(path); }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
    const p = nameHistoryProblem(h, name);
    if (p) throw this.malformed(path, p);
    return h as NameHistory;
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
  names(): Promise<unknown[]> { return this.list(`/trade/api/cairnx/names`); }

  /** All deployed tokens. Throws a typed HttpError if any row has a malformed ticker, decimals or amount. */
  async tokens(): Promise<TokenInfo[]> {
    const path = `/trade/api/cairnx/tokens`;
    const rows = await this.list(path);
    rows.forEach((t, i) => { const p = tokenProblem(t); if (p) throw this.malformed(path, `token row ${i}: ${p}`); });
    return rows as TokenInfo[];
  }

  /** One token by ticker. null = unknown/invalid ticker. Throws a typed HttpError on a malformed body. */
  async token(ticker: string): Promise<TokenInfo | null> {
    if (typeof ticker !== "string" || !TICKER_RE.test(ticker)) return null;
    const path = `/trade/api/cairnx/token/${ticker}`;
    let t: unknown;
    try { t = await this.http.getJson<unknown>(path); }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
    const p = tokenProblem(t);
    if (p) throw this.malformed(path, p);
    return t as TokenInfo;
  }

  /** Open offers (the market's display list). */
  offers(): Promise<unknown[]> { return this.list(`/trade/api/cairnx/offers`); }

  /** Open bids. */
  bids(): Promise<unknown[]> { return this.list(`/trade/api/cairnx/bids`); }

  /** The full canonical CairnX state (large; prefer the scoped reads above). */
  state(): Promise<unknown> { return this.http.getJson<unknown>(`/trade/api/cairnx/state`); }
}
