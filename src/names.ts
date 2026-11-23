// .csd names + CairnX market READS for third parties (Plan 56 item 20 / Plan 57 B10).
//
// Before this module the facade had NO CairnX surface at all; a third party would conclude
// Cairn is a signal board plus explorer and miss the names/trading product entirely. This is
// the read side: resolution, name detail/history, primary names, tokens, offers, bids, state.
//
// TRUST MODEL (read this before building on it: same honesty bar as the indexer reads):
// these are SERVER-TRUSTED reads over the public front door (`/trade/api/cairnx/*`, the same
// GET-allowlisted proxy the Cairn UI renders from). They are the right tool for DISPLAY and
// discovery. They are NOT proof: nothing here merkle-verifies a name→address binding, and a
// compromised/withholding server could lie. Anything that SPENDS against a name must verify in
// the signer (the Cairn Wallet's send path runs full SPV name verification on-device; this SDK's
// `verifyInclusion` covers content/tx inclusion). Do not wire `resolve()` output straight into a
// payment target you sign elsewhere.
//
// Input names are pre-validated with cairnx-core's own isName (the consensus grammar), so a
// malformed input fails fast client-side instead of round-tripping to a 404. Responses that a dApp does
// arithmetic or iteration on (token amounts and decimals, the list reads) are shape-checked before they are
// returned; a body that does not match throws a typed HttpError instead of reaching the caller as a typed lie.
import { ROUTE_TABLE, type At, type CursorCodec, type NameRow, type NameStatus, type OrderOf, type Query } from "@inversealtruism/cairnx-api";
import { isName, resolveNameIn, TICKER_RE, HASH_RE, MAX_TOKEN_DECIMALS, parseAmount, type BidStatus, type NameState, type OfferStatus, type ResolvedName } from "@inversealtruism/cairnx-core";
import type { Http } from "./http.js";
import { CairnError, HttpError } from "./errors.js";
import { atParam, checkedQuery, legacyAnswers, readV1, type AtParam, type ListPage, type PageSource } from "./apiv1.js";

/** `/cairnx/resolve/:name`: the display-path name→address resolution. */
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

/** `/cairnx/name/:name`: full name detail (lease, lock, resting offer, recapture window). */
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

/**
 * A read of the names list (`names` of the CairnX read API, version 1). The parameters are those of
 * `@inversealtruism/cairnx-api` 1.0, the API's contract.
 */
export interface NamesPageOptions {
  /** 1 to 32 names: their rows only, in name order. Excludes every option but `at`. */
  keys?: readonly string[];
  /** A page's `next`: the page after it. */
  after?: string | null;
  /** Rows per page, 1 to 200 (the server's default is 100). */
  limit?: number;
  /** A page's `at`: read the same snapshot. A server that no longer holds it answers 409; start the walk again. */
  at?: AtParam | null;
  /** Names this address owns, reservations included. */
  owner?: string;
  /** `held` (neither pending nor lapsed), `pending` (a reservation) or `lapsed`. */
  status?: NameStatus;
  /** `name` (the default, bytewise), `newest` (height descending, then name) or `length` (shortest first, then name). */
  order?: OrderOf<"names">;
}

/** A page of the names list. Rows are cairnx-api's `NameRow` (cairnx-core's `NameState`). `source` is `"legacy"`
 *  when the front door has no read API and the legacy list answered: no snapshot (`at` null) and a `total` the SDK
 *  counted from that list. */
export type NamesPage = ListPage<NameRow>;

/** What `allNames` reads: the list's order and filters, and the walk's bounds. */
export interface NamesWalkOptions {
  order?: OrderOf<"names">;
  owner?: string;
  status?: NameStatus;
  /** Rows per page, 1 to 200; default 200. */
  limit?: number;
  /** Pages read in one attempt before the walk stops with `WALK_LIMIT`; default `WALK_MAX_PAGES`. */
  maxPages?: number;
  /** Rows held before the walk stops with `WALK_LIMIT`; default `WALK_MAX_ROWS`. */
  maxRows?: number;
  /** Walks started again after a 409 before `WALK_RESTARTS`; default `WALK_RESTARTS_MAX`. */
  restarts?: number;
}

// A walk bound as a number: a non-negative safe integer, or the same written in digits (a JavaScript caller's "5",
// which 0.9.0 took). NaN or an infinity would make every comparison against it false and leave the walk unbounded.
function walkBound(k: string, v: unknown): number {
  const n = typeof v === "string" && /^(0|[1-9]\d*)$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
    throw new CairnError(`invalid names walk: ${k} must be a whole number of 0 or more`, { code: "INVALID_QUERY" });
  return n;
}

/** Every row of the names list from one state (`source: "v1"`, `at` that state), or the legacy list of a front door
 *  without the read API (`source: "legacy"`, `at` null, one read of the whole list). */
export interface NamesWalk {
  source: PageSource;
  rows: NameRow[];
  at: At | null;
}

// The names list held 179 rows on 2026-11-23 (`total` of /api/cairnx/v1/names). 100,000 rows leaves room for growth
// of more than 500 times that; 1,000 pages reads them at the default limit and bounds a server that pages one row at a
// time to 1,000 requests.
export const WALK_MAX_ROWS = 100_000;
export const WALK_MAX_PAGES = 1_000;
export const WALK_RESTARTS_MAX = 3;

/** One name for display, read over `names?keys=`. Server-trusted, like every names read: never a payment target. */
export interface NameLookup {
  name: string;
  /** The name's row as the server holds it; null when it holds none. */
  row: NameRow | null;
  /** cairnx-core's `resolveNameIn` over `row`: the `nset` address, else the owner; null for no row or a pending
   *  reservation. `lapsed: true` is a lease that ran out, which a sender refuses. */
  resolved: ResolvedName | null;
  /** The snapshot the row describes; null when the legacy list answered. */
  at: At | null;
}

const nameRowOk = (r: unknown): r is NameRow =>
  !!r && typeof r === "object" && typeof (r as Record<string, unknown>).name === "string" && typeof (r as Record<string, unknown>).owner === "string";
/** A legacy row the SDK can sort in `order`: a name row, with a height for `newest` (whose cursor is `<height>:<name>`). */
const legacyRowOk = (order: OrderOf<"names">) => (r: unknown): r is NameRow =>
  nameRowOk(r) && (order !== "newest" || heightOk((r as unknown as Record<string, unknown>).height));
const codecOf = (order: OrderOf<"names">) => (ROUTE_TABLE.names.orders as Record<string, unknown>)[order] as CursorCodec<unknown, NameRow>;
/** True when `c` is a cursor of `order`'s grammar (cairnx-api's codec). */
const cursorOf = (order: OrderOf<"names">) => (c: string): boolean => codecOf(order).decode(c) !== null;
const sameAt = (a: At, b: At): boolean => a.height === b.height && a.hash === b.hash && a.rev === b.rev;

/** The query of a names read, in a fixed order; an unset option is left out. */
function namesParams(o: NamesPageOptions): URLSearchParams {
  const p = new URLSearchParams();
  if (o.keys !== undefined) {
    // A comma would split one key into two in the query; cairnx-api's parser checks each key's grammar.
    if (!Array.isArray(o.keys) || o.keys.some((k) => typeof k !== "string" || k.includes(","))) {
      throw new CairnError("invalid names read: keys must be names", { code: "INVALID_QUERY" });
    }
    p.set("keys", o.keys.join(","));
  }
  if (o.at != null) p.set("at", atParam(o.at));
  if (o.after != null) p.set("after", o.after);
  if (o.limit !== undefined) p.set("limit", String(o.limit));
  if (o.order !== undefined) p.set("order", o.order);
  if (o.owner !== undefined) p.set("owner", o.owner);
  if (o.status !== undefined) p.set("status", o.status);
  return p;
}

/** The page `q` asks for, from the legacy whole list: sorted and paged with cairnx-api's codec for the order, so it
 *  holds the rows a v1 server gives for the same query. Names are distinct, so a page never splits a key. */
function legacyNamesPage(sorted: readonly NameRow[], q: Query<"names">): NamesPage {
  const codec = codecOf(q.order);
  if (q.keys !== null) {
    const want = new Set(q.keys);
    const hit = sorted.filter((r) => want.has(r.name));
    return { source: "legacy", rows: hit, next: null, at: null, total: hit.length };
  }
  const after = q.after;
  const found = after === null ? 0 : sorted.findIndex((r) => codec.compare(codec.of(r), after) > 0);
  const start = found < 0 ? sorted.length : found;
  const page = sorted.slice(start, start + q.limit);
  const last = page[page.length - 1];
  const next = start + q.limit < sorted.length && last !== undefined ? codec.encode(codec.of(last)) : null;
  return { source: "legacy", rows: page, next, at: null, total: sorted.length };
}

// parseAmount applies cairnx-core's MAX_AMOUNT; minted and served amounts may be zero.
const amountOk = (v: unknown): v is string => parseAmount(v, { allowZero: true }) !== null;
const decimalsOk = (d: unknown): d is number =>
  Number.isSafeInteger(d) && (d as number) >= 0 && (d as number) <= MAX_TOKEN_DECIMALS;
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

/** Why a served token record is unusable, or null. `ticker` is the one the caller asked for, when it asked for one. */
function tokenProblem(t: unknown, ticker?: string): string | null {
  if (!t || typeof t !== "object") return "not an object";
  const r = t as Record<string, unknown>;
  if (typeof r.ticker !== "string" || !TICKER_RE.test(r.ticker)) return "bad ticker";
  if (ticker !== undefined && r.ticker !== ticker) return `ticker is ${JSON.stringify(r.ticker)}, expected ${JSON.stringify(ticker)}`;
  if (!decimalsOk(r.decimals)) return `bad decimals (${String(r.decimals)}), not an integer in the consensus range`;
  if (!amountOk(r.supply)) return "supply is not a base-unit integer string within MAX_AMOUNT";
  if (!amountOk(r.minted)) return "minted is not a base-unit integer string within MAX_AMOUNT";
  if (r.mintLimit !== undefined && !amountOk(r.mintLimit)) return "mintLimit is not a base-unit integer string within MAX_AMOUNT";
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

  private async list(path: string, query?: Record<string, string>): Promise<unknown[]> {
    const body = await this.http.getJson<unknown>(path, query);
    if (!Array.isArray(body)) throw this.malformed(path, "expected an array");
    return body;
  }

  /** Rows of a market list with one status, or every row for "all". */
  private async byStatus(path: string, status: string): Promise<unknown[]> {
    if (status === "all") return this.list(path);
    const rows = await this.list(path, { status });
    // Filtered here as well, so a server that ignores ?status cannot hand back rows of another status.
    return rows.filter((r) => (r as { status?: unknown } | null)?.status === status);
  }

  /** Resolve a .csd name for DISPLAY (server-trusted; see the module trust note). null = unknown/invalid name. */
  async resolve(name: string): Promise<NameResolution | null> {
    if (!isName(name)) return null;
    try { return await this.http.getJson<NameResolution>(`/trade/api/cairnx/resolve/${encodeURIComponent(name)}`); }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
  }

  /** Full detail for one name (lease, lock, resting offer, recapture). null = not registered/invalid. */
  async name(name: string): Promise<NameDetail | null> {
    if (!isName(name)) return null;
    try { return await this.http.getJson<NameDetail>(`/trade/api/cairnx/name/${encodeURIComponent(name)}`); }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
  }

  /** The event history of one name (registrations, transfers, sets, renewals) with the server's current
   *  claim. null = invalid or unregistered name. Throws a typed HttpError on a malformed body. */
  async nameHistory(name: string): Promise<NameHistory | null> {
    if (!isName(name)) return null;
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

  /** All registered names (display list; short-edge-cached server-side). The legacy whole list, in the server's
   *  order; `namesPage` reads it by page with typed rows. */
  names(): Promise<unknown[]> { return this.list(`/trade/api/cairnx/names`); }

  /**
   * A page of the names list from the read API (`/api/cairnx/v1/names`), typed. `allNames` is the walk over every
   * page. On a front door without the read API (a 404), a read without `at`, `owner` or `status` is answered from the
   * legacy list in the same order and paging (`source: "legacy"`, `at: null`); every other answer that is not a page
   * throws the read API's error (an `HttpError`, 409 for a snapshot no longer held). An option outside the read's
   * grammar throws a `CairnError` with code `INVALID_QUERY` before any request.
   */
  async namesPage(opts: NamesPageOptions = {}): Promise<NamesPage> {
    const params = namesParams(opts);
    const q = checkedQuery("names", params);
    const v1 = await readV1(this.http, "names", params, nameRowOk, cursorOf(q.order));
    if (v1.ok) return v1.page;
    if (!v1.absent || !legacyAnswers(q)) throw v1.error;
    return legacyNamesPage(await this.legacySorted(q.order), q);
  }

  /** The legacy whole list, every row checked for what `order` sorts on, in cairnx-api's order. */
  private async legacySorted(order: OrderOf<"names">): Promise<NameRow[]> {
    const path = `/trade/api/cairnx/names`;
    const rows = await this.list(path);
    const ok = legacyRowOk(order);
    rows.forEach((r, i) => { if (!ok(r)) throw this.malformed(path, `name row ${i} is not a name record${order === "newest" ? " with a height" : ""}`); });
    const codec = codecOf(order);
    return (rows as NameRow[]).sort((a, b) => codec.compare(codec.of(a), codec.of(b)));
  }

  /**
   * Every row of the names list from one state: page 1's `at` is sent with every later page. A 409 (the server no
   * longer holds that state) starts the walk again from page 1 under the newest state, at most `restarts` times, then
   * throws a `CairnError` `WALK_RESTARTS`. A page with an empty `rows` and a `next`, a `next` equal to the cursor just
   * sent or to an earlier cursor of the walk, or a later page naming another `at` throws an `HttpError` (malformed
   * response). More than `maxPages` pages or `maxRows` rows throws `WALK_LIMIT`; a `maxPages`, `maxRows` or `restarts`
   * that is not a whole number of 0 or more (or one written in digits) throws `INVALID_QUERY` before any request. A
   * page 1 whose `at` the SDK cannot
   * send back throws `SNAPSHOT_UNPINNED`. A front door without the read API (a 404) answers from one read of the legacy
   * list, `source: "legacy"` and `at` null; a read with `owner` or `status` has no legacy answer and throws the 404.
   */
  async allNames(opts: NamesWalkOptions = {}): Promise<NamesWalk> {
    const maxPages = walkBound("maxPages", opts.maxPages ?? WALK_MAX_PAGES);
    const maxRows = walkBound("maxRows", opts.maxRows ?? WALK_MAX_ROWS);
    const restarts = walkBound("restarts", opts.restarts ?? WALK_RESTARTS_MAX);
    const base: NamesPageOptions = { limit: opts.limit ?? 200 };
    if (opts.order !== undefined) base.order = opts.order;
    if (opts.owner !== undefined) base.owner = opts.owner;
    if (opts.status !== undefined) base.status = opts.status;
    const params = namesParams(base);
    const q = checkedQuery("names", params);
    const path = "/api/cairnx/v1/names";
    const malformed = (what: string) => new HttpError(200, this.http.url(path, Object.fromEntries(params)), `malformed v1 walk: ${what}`);
    const tooMany = (what: string) => new CairnError(`names walk stopped: more than ${what}`, { code: "WALK_LIMIT" });
    for (let attempt = 0; ; attempt++) {
      const v1 = await readV1(this.http, "names", params, nameRowOk, cursorOf(q.order));
      if (!v1.ok) {
        if (!v1.absent || !legacyAnswers(q)) throw v1.error;
        const rows = await this.legacySorted(q.order);
        if (rows.length > maxRows) throw tooMany(`${maxRows} rows`);
        return { source: "legacy", rows, at: null };
      }
      let page = v1.page;
      const at = page.at;
      if (at === null) throw new CairnError("names walk: the server's snapshot cannot be pinned (its at is not one the SDK can send back)", { code: "SNAPSHOT_UNPINNED" });
      const rows = [...page.rows];
      const seen = new Set<string>();
      let after: string | null = null, pages = 1, restart = false;
      while (page.next !== null) {
        const next: string = page.next;
        if (page.rows.length === 0) throw malformed(`an empty page with next ${JSON.stringify(next)}`);
        if (next === after || seen.has(next)) throw malformed(`next ${JSON.stringify(next)} repeats a cursor of this walk`);
        if (rows.length > maxRows) throw tooMany(`${maxRows} rows`);
        if (pages >= maxPages) throw tooMany(`${maxPages} pages`);
        seen.add(next);
        after = next;
        try {
          page = await this.namesPage({ ...base, after, at });
        } catch (e) {
          if (e instanceof HttpError && e.status === 409) { restart = true; break; }
          throw e;
        }
        pages++;
        if (page.at === null || !sameAt(page.at, at)) throw malformed("a pinned page names another snapshot");
        rows.push(...page.rows);
      }
      if (!restart) {
        if (rows.length > maxRows) throw tooMany(`${maxRows} rows`);
        return { source: "v1", rows, at };
      }
      if (attempt >= restarts) throw new CairnError(`names walk: the server dropped the snapshot ${restarts + 1} times (409)`, { code: "WALK_RESTARTS" });
    }
  }

  /** One name for display over `names?keys=<name>`, with cairnx-core's forward resolution (server-trusted; see the
   *  module trust note). null = not a name (the input is checked with cairnx-core's `isName`; nothing is sent). Falls
   *  back as `namesPage` does: on a host without the read API each lookup reads the whole legacy list, bounded by the
   *  HTTP client's byte cap (16 MiB by default) and timeout. */
  async lookup(name: string): Promise<NameLookup | null> {
    if (!isName(name)) return null;
    const page = await this.namesPage({ keys: [name] });
    const row = page.rows.find((r) => r.name === name) ?? null;
    const held: Record<string, NameState> = Object.create(null);
    if (row) held[name] = row;
    return { name, row, resolved: row ? resolveNameIn(held, name) : null, at: page.at };
  }

  /** All deployed tokens. Throws a typed HttpError if any row has a malformed ticker, decimals or amount. */
  async tokens(): Promise<TokenInfo[]> {
    const path = `/trade/api/cairnx/tokens`;
    const rows = await this.list(path);
    rows.forEach((t, i) => { const p = tokenProblem(t); if (p) throw this.malformed(path, `token row ${i}: ${p}`); });
    return rows as TokenInfo[];
  }

  /** One token by ticker. null = unknown/invalid ticker. Throws a typed HttpError on a malformed body or a
   *  record for another ticker. */
  async token(ticker: string): Promise<TokenInfo | null> {
    if (typeof ticker !== "string" || !TICKER_RE.test(ticker)) return null;
    const path = `/trade/api/cairnx/token/${ticker}`;
    let t: unknown;
    try { t = await this.http.getJson<unknown>(path); }
    catch (e: any) { if (e?.status === 404) return null; throw e; }
    const p = tokenProblem(t, ticker);
    if (p) throw this.malformed(path, p);
    return t as TokenInfo;
  }

  /** Offers with one status, open ones by default (the market's display list). `{ status: "all" }` returns every
   *  offer the server holds, filled, cancelled and expired ones included. */
  offers(opts: { status?: OfferStatus | "all" } = {}): Promise<unknown[]> {
    return this.byStatus(`/trade/api/cairnx/offers`, opts.status ?? "open");
  }

  /** Bids with one status, open ones by default. `{ status: "all" }` returns every bid the server holds, done,
   *  cancelled and expired ones included. */
  bids(opts: { status?: BidStatus | "all" } = {}): Promise<unknown[]> {
    return this.byStatus(`/trade/api/cairnx/bids`, opts.status ?? "open");
  }

  /** The full canonical CairnX state (large; prefer the scoped reads above). */
  state(): Promise<unknown> { return this.http.getJson<unknown>(`/trade/api/cairnx/state`); }
}
