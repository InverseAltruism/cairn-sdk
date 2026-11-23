// The names reads on the CairnX read API, version 1: NamesClient.namesPage (a typed page: keys, after, limit, at,
// owner, status, order) and NamesClient.lookup (one name over `names?keys=`, forward-resolved with cairnx-core's
// resolveNameIn), with the legacy whole list as the fallback. Bodies are the live answers recorded on 2026-11-22 in
// test/fixtures/apiv1-names-2026-11-22.json; the lookup bodies for one key are those rows, filtered. Offline.
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { At, NameRow } from "@inversealtruism/cairnx-api";
import { answer, prepareView } from "@inversealtruism/cairnx-api/handlers";
import type { CairnXState, NameState } from "@inversealtruism/cairnx-core";
import { NamesClient, type NameLookup, type NamesPage } from "../src/names.js";
import { Http } from "../src/http.js";
import { CairnError, HttpError } from "../src/errors.js";
import { WALK_MAX_PAGES, WALK_MAX_ROWS, WALK_RESTARTS_MAX } from "../src/names.js";
import type { NameRow as RootNameRow } from "../src/index.js";

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

// Type-level proof: the page's row is cairnx-api's NameRow, not a widening of it, and a row with addr, profile and
// viaFill is one. `pnpm typecheck` compiles this file.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const rowIsNameRow: Exact<NamesPage["rows"][number], NameRow> = true;
const rowIsNotUnknown: Exact<NamesPage["rows"][number], unknown> = false;
const lookupRow: Exact<NonNullable<NameLookup["row"]>, NameRow> = true;
const rootTypes: Exact<RootNameRow, NameRow> = true;
const full: NameRow = {
  name: "alice", owner: `0x${"11".repeat(20)}`, claimId: `0x${"22".repeat(32)}`, height: 1, effectiveHeight: 1, locked: false,
  addr: `0x${"33".repeat(20)}`, profile: { display: "Alice" }, viaFill: true,
};
const asState: NameState = full;
const typed: NamesPage = { source: "v1", rows: [full], next: null, at: null };
check("type proof: a row with addr, profile and viaFill is a NameRow and a page row; the root entry's NameRow is cairnx-api's (compiled by pnpm typecheck)",
  rowIsNameRow && !rowIsNotUnknown && lookupRow && rootTypes && asState === full && typed.rows[0] === full);

interface Recorded { status: number; contentType: string; body: string }
const fixture = JSON.parse(readFileSync(new URL("./fixtures/apiv1-names-2026-11-22.json", import.meta.url), "utf8")) as { answers: Record<string, Recorded> };
const ORIGIN = "https://cairn-substrate.com";
/** A request's identity: its path and its decoded parameters, sorted (the SDK encodes `,` and `:`; the recording does not). */
const ident = (u: string): string => { const x = new URL(u); return `${x.pathname}?${[...x.searchParams].map(([k, v]) => `${k}=${v}`).sort().join("&")}`; };
const recorded = new Map(Object.entries(fixture.answers).map(([k, v]) => [ident(k.slice(4)), v]));
const rec = (path: string): Recorded => { const r = recorded.get(ident(ORIGIN + path)); if (!r) throw new Error(`no recording for ${path}`); return r; };
const body = (path: string) => JSON.parse(rec(path).body);

const PAGE1 = "/api/cairnx/v1/names?limit=2";
const KEYS = "/api/cairnx/v1/names?keys=commonplace,6,m,notregistered9";
const LEGACY = "/trade/api/cairnx/names";
const p1 = body(PAGE1) as { at: At; rows: NameRow[]; next: string; total: number };
const p2 = body(`/api/cairnx/v1/names?limit=2&after=0xinverse&at=${p1.at.height}:${p1.at.hash}:${p1.at.rev}`) as typeof p1;
const keyRows = (body(KEYS) as typeof p1).rows;
const legacyRows = body(LEGACY) as NameRow[];

type Reply = Response | "hang" | "throw";
type Router = (u: URL) => Reply | undefined;
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
/** Recorded answers first, then `route`; anything else is the resolver's legacy 404. */
function client(route: Router = () => undefined, timeoutMs = 2000): { names: NamesClient; calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(`${u.pathname}${u.search}`);
    const r = route(u) ?? (recorded.has(ident(u.href)) ? (() => { const x = recorded.get(ident(u.href))!; return new Response(x.body, { status: x.status, headers: { "content-type": x.contentType } }); })() : json(404, { ok: false, error: "not found" }));
    if (r === "throw") throw new TypeError("fetch failed");
    if (r === "hang") return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    return r;
  }) as typeof fetch;
  return { names: new NamesClient(new Http({ baseUrl: ORIGIN, fetch: f, timeoutMs })), calls };
}
/** One key's v1 answer, derived from the recorded keys answer. */
const oneKey: Router = (u) => {
  const k = u.searchParams.get("keys");
  if (u.pathname !== "/api/cairnx/v1/names" || k === null || k.includes(",")) return undefined;
  const rows = keyRows.filter((r) => r.name === k);
  return json(200, { ok: true, level: 1, at: p1.at, rows, next: null, total: rows.length });
};
const grab = async (fn: () => Promise<unknown>): Promise<unknown> => { try { return await fn(); } catch (e) { return e; } };
const v1Path = (c: string) => c.startsWith("/api/cairnx/v1/");

async function main() {
  console.log("namesPage on the recorded v1 answers");
  {
    const { names, calls } = client();
    const a = await names.namesPage({ limit: 2 });
    check("page 1: the recorded rows, next, at and total, typed", isDeepStrictEqual(a, { source: "v1", rows: p1.rows, next: "0xinverse", at: p1.at, total: 174 }));
    const b = await names.namesPage({ limit: 2, after: a.next, at: a.at });
    check("page 2 pinned with page 1's at and next: the recorded rows ['1', '10'], next '10', the same at",
      isDeepStrictEqual(b.rows.map((r) => r.name), ["1", "10"]) && b.next === "10" && isDeepStrictEqual(b.at, a.at));
    check("the two reads went to the v1 route only, cursor and at on the second", calls.length === 2 && calls.every(v1Path)
      && new URL(ORIGIN + calls[1]).searchParams.get("after") === "0xinverse"
      && new URL(ORIGIN + calls[1]).searchParams.get("at") === `${p1.at.height}:${p1.at.hash}:${p1.at.rev}`);
    const k = await names.namesPage({ keys: ["commonplace", "6", "m", "notregistered9"] });
    check("keys: the rows held, in name order, an unregistered key absent", isDeepStrictEqual(k.rows.map((r) => r.name), ["6", "commonplace", "m"]) && k.next === null);
    const six = k.rows[0]!;
    check("a recorded row keeps addr, viaFill and profile", six.viaFill === true && six.addr === "0x44d92872a5b65d37d60ed532f41efe7c5aed59ec"
      && k.rows[1]!.profile?.contenthash?.startsWith("ipfs://") === true);
  }

  console.log("lookup: one name over names?keys=, resolved with cairnx-core's resolveNameIn");
  {
    const { names, calls } = client(oneKey);
    const served = body("/trade/api/cairnx/resolve/6") as Record<string, unknown>;
    const six = await names.lookup("6");
    check("an nset name resolves to the address the server's own /resolve/6 gave (recorded the same minute)",
      isDeepStrictEqual(six?.resolved, { name: "6", addr: served.addr, via: served.via, lapsed: served.lapsed, owner: served.owner }));
    check("lookup reads names?keys=<name> on v1 and carries the page's at", isDeepStrictEqual(six?.at, p1.at) && calls[0] === "/api/cairnx/v1/names?keys=6");
    const cp = await names.lookup("commonplace");
    check("a name with a profile resolves to its nset address", cp?.resolved?.via === "nset" && cp.resolved.addr === cp.row?.addr && typeof cp.row?.profile?.contenthash === "string");
    const zero = await client((u) => (v1Path(u.pathname) ? json(404, {}) : undefined)).names.lookup("0");
    check("a name without an nset address resolves to its owner (recorded legacy row '0')", zero?.resolved?.via === "owner" && zero.resolved.addr === zero.row?.owner && zero.row?.addr === undefined);
    const none = await names.lookup("notregistered9");
    check("an unregistered name: row and resolved null, at set", none !== null && none.row === null && none.resolved === null && isDeepStrictEqual(none.at, p1.at));
    const before = calls.length;
    check("an invalid or reserved name is null without a request", (await names.lookup("Not A Name")) === null && (await names.lookup("csd")) === null && calls.length === before);
    const pending = client((u) => (u.pathname.startsWith("/api/cairnx/v1/") ? json(200, { ok: true, level: 1, at: p1.at, rows: [{ ...keyRows[1]!, name: "res", pending: true, finalizeBy: 1 }], next: null }) : undefined));
    const r = await pending.names.lookup("res");
    check("a pending reservation: the row, and no address", r?.row?.pending === true && r.resolved === null);
  }

  console.log("refused before a request");
  {
    const { names, calls } = client();
    const code = async (o: Parameters<NamesClient["namesPage"]>[0]) => { const e = await grab(() => names.namesPage(o)); return e instanceof CairnError ? e.code : String(e); };
    check("limit 201 is INVALID_QUERY", (await code({ limit: 201 })) === "INVALID_QUERY");
    check("a key holding a comma is INVALID_QUERY", (await code({ keys: ["a,b"] })) === "INVALID_QUERY");
    check("keys with after is INVALID_QUERY", (await code({ keys: ["m"], after: "m" })) === "INVALID_QUERY");
    check("keys with order is INVALID_QUERY", (await code({ keys: ["m"], order: "length" })) === "INVALID_QUERY");
    check("a length cursor whose length is not its name's is INVALID_QUERY", (await code({ order: "length", after: "5:m" })) === "INVALID_QUERY");
    check("a malformed at is INVALID_QUERY", (await code({ at: { height: 1, hash: "0x12" } })) === "INVALID_QUERY");
    check("an after that is not a names cursor of the order is INVALID_QUERY", (await code({ order: "newest", after: "m" })) === "INVALID_QUERY");
    check("nothing was sent", calls.length === 0);
  }

  console.log("fallback: a host without the v1 mount (a 404) is answered from the legacy list, in the v1 order");
  const absent: Array<[string, Router]> = [
    ["express's 404 (a host older than the read API)", (u) => (v1Path(u.pathname) ? new Response("Cannot GET /api/cairnx/v1/names", { status: 404, headers: { "content-type": "text/html" } }) : undefined)],
    ["the proxy's 404 refusal (recorded; a resolver without the v1 mount)", (u) => (v1Path(u.pathname) ? json(404, JSON.parse(rec("/api/cairnx/v1/nope").body)) : undefined)],
  ];
  for (const [kind, route] of absent) {
    const { names, calls } = client(route);
    const a = await grab(() => names.namesPage({ limit: 2 })) as NamesPage;
    const b = await grab(() => names.namesPage({ limit: 2, after: a.next })) as NamesPage;
    const k = await grab(() => names.lookup("6")) as NameLookup | null;
    check(`${kind}: pages 1 and 2 equal the recorded v1 pages with source legacy and at null; lookup resolves; the legacy list was read`,
      isDeepStrictEqual(a, { source: "legacy", rows: p1.rows, next: "0xinverse", at: null, total: 174 })
      && isDeepStrictEqual(b, { source: "legacy", rows: p2.rows, next: "10", at: null, total: 174 })
      && k?.resolved?.addr === "0x44d92872a5b65d37d60ed532f41efe7c5aed59ec" && k.at === null
      && calls.filter((c) => c === LEGACY).length === 3 && calls.filter(v1Path).length === 3);
  }

  console.log("no fallback on a refusal or a failure: the v1 read's error is thrown and the legacy list is not read");
  const refusals: Array<[string, Router, number, number?]> = [
    ["400 INVALID_QUERY", (u) => (v1Path(u.pathname) ? json(400, { ok: false, error: { code: "INVALID_QUERY", param: "limit", message: "x" } }) : undefined), 400],
    ["409 SNAPSHOT_NOT_HELD", (u) => (v1Path(u.pathname) ? json(409, { ok: false, error: { code: "SNAPSHOT_NOT_HELD", message: "x" }, at: p1.at }) : undefined), 409],
    ["429 RATE_LIMITED", (u) => (v1Path(u.pathname) ? json(429, { ok: false, error: { code: "RATE_LIMITED", message: "x", retryAfter: 5 } }) : undefined), 429],
    ["a code this release does not know (418)", (u) => (v1Path(u.pathname) ? json(418, { ok: false, error: { code: "TEAPOT", message: "x" } }) : undefined), 418],
    ["502 UPSTREAM_UNAVAILABLE", (u) => (v1Path(u.pathname) ? json(502, { ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "x" } }) : undefined), 502],
    ["a 200 that is not JSON", (u) => (v1Path(u.pathname) ? new Response("<!doctype html><title>Cairn</title>", { status: 200, headers: { "content-type": "text/html" } }) : undefined), -1],
    ["ok: false in a 200", (u) => (v1Path(u.pathname) ? json(200, { ok: false, error: { code: "INTERNAL", message: "x" } }) : undefined), 200],
    ["rows not an array", (u) => (v1Path(u.pathname) ? json(200, { ok: true, level: 1, at: p1.at, rows: {}, next: null }) : undefined), 200],
    ["a timeout", (u) => (v1Path(u.pathname) ? "hang" : undefined), -1, 50],
    ["a network error", (u) => (v1Path(u.pathname) ? "throw" : undefined), -1],
  ];
  for (const [kind, route, status, timeoutMs] of refusals) {
    const { names, calls } = client(route, timeoutMs);
    const e = await grab(() => names.namesPage({ limit: 2 }));
    const l = await grab(() => names.lookup("6"));
    const w = await grab(() => names.allNames());
    const byStatus = (x: unknown) => (status < 0 ? x instanceof Error && !(x instanceof CairnError && x.code === "INVALID_QUERY") : x instanceof HttpError && x.status === status);
    check(`${kind}: namesPage, lookup and allNames throw${status > 0 ? ` (status ${status})` : ""}; no legacy read`, byStatus(e) && byStatus(l) && byStatus(w) && !calls.includes(LEGACY));
  }

  console.log("validation at the door");
  {
    const bad = client((u) => (v1Path(u.pathname) ? json(200, { ok: true, level: 1, at: p1.at, rows: p1.rows, next: "BAD CURSOR!" }) : undefined));
    const e = await grab(() => bad.names.namesPage({ limit: 2 }));
    check("a v1 next that is not a cursor of the order asked is a malformed answer (HttpError 200), not the caller's INVALID_QUERY",
      e instanceof HttpError && e.status === 200 && /next is neither a cursor of the order asked/.test(e.message) && bad.calls.length === 1);
    const nameCursor = client((u) => (v1Path(u.pathname) ? json(200, { ok: true, level: 1, at: p1.at, rows: p1.rows, next: "alice" }) : undefined));
    const n = await grab(() => nameCursor.names.namesPage({ limit: 2, order: "newest" }));
    check("a name cursor answered to order=newest is malformed too", n instanceof HttpError && n.status === 200);
    const honest = client((u) => (v1Path(u.pathname) ? json(200, { ok: true, level: 1, at: p1.at, rows: p1.rows, next: "49694:0" }) : undefined));
    const h = await honest.names.namesPage({ limit: 2, order: "newest" });
    check("honest path: a newest cursor answered to order=newest is kept", h.next === "49694:0" && h.source === "v1");
    const noHeight = legacyRows.slice(0, 3).map(({ height: _h, ...r }) => r);
    const legacyNoHeight: Router = (u) => (v1Path(u.pathname) ? json(404, {}) : u.pathname === LEGACY ? json(200, noHeight) : undefined);
    const lh = await grab(() => client(legacyNoHeight).names.namesPage({ limit: 1, order: "newest" }));
    check("a legacy row without a height, read in order newest, makes the answer malformed (HttpError), not a cursor 'undefined:<name>'",
      lh instanceof HttpError && lh.status === 200 && /with a height/.test(lh.message));
    const ln = await client(legacyNoHeight).names.namesPage({ limit: 1, order: "name" });
    check("honest path: the same rows read in order name page as before", ln.source === "legacy" && ln.rows.length === 1 && ln.next === ln.rows[0]!.name);
  }

  console.log("no fallback where the legacy list has no answer");
  {
    const down: Router = (u) => (v1Path(u.pathname) ? json(503, { ok: false, error: { code: "NOT_READY", message: "x" } }) : undefined);
    for (const [label, o] of [["at", { at: p1.at }], ["owner", { owner: legacyRows[0]!.owner }], ["status", { status: "held" as const }]] as const) {
      const { names, calls } = client(down);
      const e = await grab(() => names.namesPage(o));
      check(`a read with ${label} throws the v1 error (503) and does not read the legacy list`, e instanceof HttpError && e.status === 503 && !calls.includes(LEGACY));
    }
    const { names, calls } = client();
    const stale = { ...p1.at, rev: "0000000000000000" };
    const e = await grab(() => names.namesPage({ limit: 2, at: stale }));
    check("a snapshot no longer held: the recorded 409 is thrown, no legacy read", e instanceof HttpError && e.status === 409 && /SNAPSHOT_NOT_HELD/.test(String(e.body)) && !calls.includes(LEGACY));
    const both = client((u) => (v1Path(u.pathname) ? json(404, {}) : u.pathname === LEGACY ? json(500, { ok: false }) : undefined));
    const le = await grab(() => both.names.namesPage());
    check("a host without the read API whose legacy read fails: the legacy error (500) is the caller's", le instanceof HttpError && le.status === 500 && both.calls.at(-1) === LEGACY);
  }

  console.log("a page's at is kept only when cairnx-api's parser takes it back");
  {
    const row = keyRows[0]!;
    for (const [label, at, kept] of [
      // cairnx-api 1.0.0: rev is an opaque token of 1 to 64 ASCII letters, digits, ".", "_" and "-", echoed unchanged.
      ["a 16-hex rev", { ...p1.at }, true],
      ["a rev in another form", { ...p1.at, rev: "v2-0123456789abcdef" }, true],
      ["a 20-digit rev", { ...p1.at, rev: "0123456789abcdef0123" }, true],
      ["an uppercase rev", { ...p1.at, rev: "A123456789ABCDEF" }, true],
      ["a 64-character rev with every allowed sign", { ...p1.at, rev: `a.b_c-D${"9".repeat(57)}` }, true],
      ["a 65-character rev", { ...p1.at, rev: "a".repeat(65) }, false],
      ["a rev with a colon", { ...p1.at, rev: "ab:cd" }, false],
      ["an empty rev", { ...p1.at, rev: "" }, false],
      ["a height that is a string", { ...p1.at, height: String(p1.at.height) }, false],
    ] as const) {
      const { names, calls } = client((u) => (v1Path(u.pathname) ? json(200, { ok: true, level: 1, at, rows: [row], next: u.searchParams.has("after") ? null : row.name, total: 2 }) : undefined));
      const a = await names.namesPage({ limit: 1 });
      const b = await grab(() => names.namesPage({ limit: 1, after: a.next, at: a.at }));
      const sent = calls[1] === undefined ? null : new URL(ORIGIN + calls[1]).searchParams.get("at");
      check(`${label}: page 1 from v1 with at ${kept ? "kept" : "null"}; page 2 is sent${kept ? " pinned" : " unpinned"}, no INVALID_QUERY`,
        isDeepStrictEqual(a.rows, [row]) && (kept ? isDeepStrictEqual(a.at, at) : a.at === null) && !calls.includes(LEGACY)
        && !(b instanceof Error) && calls.length === 2 && sent === (kept ? `${at.height}:${at.hash}:${at.rev}` : null));
    }
  }

  console.log("allNames: the walk, with the contract's rules inside it");
  {
    const at = { height: 146981, hash: `0x${"00".repeat(31)}01` };
    const viewOf = (rows: readonly NameRow[], input = "walk") => prepareView({ tipHeight: at.height, names: Object.fromEntries(rows.map((r) => [r.name, r])), offers: {}, bids: {}, tokens: {}, balances: {}, events: [] } as unknown as CairnXState, { height: at.height, hash: at.hash, input, core: "0.2.10" });
    const view = viewOf(legacyRows);
    const atOf = (v: ReturnType<typeof viewOf>) => (answer([v], "names", "").body as { at: At }).at;
    const handler = (): Router => (u) => { if (!v1Path(u.pathname)) return undefined; const r = answer([view], "names", u.searchParams); return json(r.status, r.body); };
    for (const order of ["name", "newest", "length"] as const) {
      const { names, calls } = client(handler());
      const w = await names.allNames({ order, limit: 50 });
      const want = (answer([view], "names", new URLSearchParams({ order, limit: "200" })).body as { rows: NameRow[] }).rows;
      check(`honest walk, order ${order}: the handler's ${want.length} rows in its order, four pages, every later page pinned`,
        w.source === "v1" && isDeepStrictEqual(w.rows, want) && w.rows.length === legacyRows.length && isDeepStrictEqual(w.at, atOf(view))
        && calls.length === 4 && calls.slice(1).every((c) => c.includes("at=")) && !calls.includes(LEGACY));
    }
    // The review's three inputs, each on a constant valid at: a cursor cycle, a repeated cursor, an empty page with a next.
    type Scripted = { rows: NameRow[]; next: string | null };
    const scripted = (pages: Scripted[]): Router => { let i = 0; return (u) => {
      if (!v1Path(u.pathname)) return undefined;
      const pg = pages[Math.min(i++, pages.length - 1)]!;
      return json(200, { ok: true, level: 1, at: p1.at, rows: pg.rows, next: pg.next });
    }; };
    const r1 = p1.rows.slice(0, 1), r2 = p1.rows.slice(1, 2);
    const inputs: Array<[string, Scripted[]]> = [
      ["a cursor cycle (a, b, a)", [{ rows: r1, next: "a" }, { rows: r2, next: "b" }, { rows: r1, next: "a" }]],
      ["a repeated cursor (after a answers next a)", [{ rows: r1, next: "a" }, { rows: r2, next: "a" }]],
      ["an empty page with a next", [{ rows: r1, next: "a" }, { rows: [], next: "b" }]],
      ["empty pages from page 1", [{ rows: [], next: "a" }]],
    ];
    for (const [label, pages] of inputs) {
      const { names, calls } = client(scripted(pages));
      const e = await grab(() => names.allNames());
      check(`${label}: a malformed answer (HttpError 200) after ${calls.length} reads, never a loop`, e instanceof HttpError && e.status === 200 && /malformed v1 walk/.test(e.message) && calls.length <= 3);
    }
    let n = 0;
    const advancing = client((u) => (v1Path(u.pathname) ? json(200, { ok: true, level: 1, at: p1.at, rows: n === 0 ? r1 : [], next: `c${n++}` }) : undefined));
    const ea = await grab(() => advancing.names.allNames());
    check("empty pages whose next advances (c0, c1, ...): a malformed answer after 2 reads, never a walk to maxPages",
      ea instanceof HttpError && ea.status === 200 && /an empty page/.test(ea.message) && advancing.calls.length === 2);
    const otherAt = client((u) => (v1Path(u.pathname) ? json(200, { ok: true, level: 1, at: u.searchParams.has("at") ? { ...p1.at, rev: "ffffffffffffffff" } : p1.at, rows: r1, next: u.searchParams.has("at") ? null : "a" }) : undefined));
    const oa = await grab(() => otherAt.names.allNames());
    check("a pinned page naming another at is malformed", oa instanceof HttpError && oa.status === 200 && /another snapshot/.test(oa.message));
    // A 409 on every later page: page 1 under the newest state, then a 409, each attempt.
    const always409 = () => client((u) => {
      if (!v1Path(u.pathname)) return undefined;
      if (u.searchParams.has("at")) return json(409, { ok: false, error: { code: "SNAPSHOT_NOT_HELD", message: "x" }, at: p1.at });
      return json(200, { ok: true, level: 1, at: p1.at, rows: r1, next: r1[0]!.name });
    });
    const a2 = always409();
    const e2 = await grab(() => a2.names.allNames({ restarts: 2 }));
    check("a 409 on every later page: three attempts (restarts 2), then WALK_RESTARTS",
      e2 instanceof CairnError && e2.code === "WALK_RESTARTS" && a2.calls.length === 6 && a2.calls.filter((c) => !c.includes("at=")).length === 3);
    const a3 = always409();
    const e3 = await grab(() => a3.names.allNames());
    check(`the default restarts bound is WALK_RESTARTS_MAX (${WALK_RESTARTS_MAX}): ${WALK_RESTARTS_MAX + 1} attempts`,
      e3 instanceof CairnError && e3.code === "WALK_RESTARTS" && a3.calls.length === 2 * (WALK_RESTARTS_MAX + 1));
    // One 409, then the newest state is walked whole from page 1.
    const newer = viewOf(legacyRows, "newer");
    let dropped = false;
    const once = client((u) => {
      if (!v1Path(u.pathname)) return undefined;
      if (u.searchParams.has("at") && !dropped) { dropped = true; return json(409, { ok: false, error: { code: "SNAPSHOT_NOT_HELD", message: "x" }, at: atOf(newer) }); }
      const r = answer([dropped ? newer : view], "names", u.searchParams); return json(r.status, r.body);
    });
    const w1 = await once.names.allNames({ limit: 50 });
    check("one 409: the walk starts again from page 1 under the newest at and returns that state whole",
      w1.source === "v1" && w1.rows.length === legacyRows.length && w1.at?.rev === atOf(newer).rev && once.calls.filter((c) => !c.includes("at=")).length === 2);
    const unpin = client((u) => (v1Path(u.pathname) ? json(200, { ok: true, level: 1, at: { ...p1.at, rev: "ab:cd" }, rows: r1, next: "a" }) : undefined));
    const eu = await grab(() => unpin.names.allNames());
    check("page 1 whose at the SDK cannot send back: SNAPSHOT_UNPINNED, one read", eu instanceof CairnError && eu.code === "SNAPSHOT_UNPINNED" && unpin.calls.length === 1);
    const pagesCap = client(handler());
    const ep = await grab(() => pagesCap.names.allNames({ limit: 10, maxPages: 3 }));
    check("over maxPages: WALK_LIMIT after 3 reads", ep instanceof CairnError && ep.code === "WALK_LIMIT" && /3 pages/.test(ep.message) && pagesCap.calls.length === 3);
    const rowsCap = client(handler());
    const er = await grab(() => rowsCap.names.allNames({ limit: 50, maxRows: 60 }));
    check("over maxRows: WALK_LIMIT before a third page", er instanceof CairnError && er.code === "WALK_LIMIT" && /60 rows/.test(er.message) && rowsCap.calls.length === 2);
    check(`the defaults: ${WALK_MAX_PAGES} pages, ${WALK_MAX_ROWS} rows`, WALK_MAX_PAGES === 1000 && WALK_MAX_ROWS === 100000);
    const legacyOnly = client((u) => (v1Path(u.pathname) ? json(404, {}) : u.pathname === LEGACY ? json(200, legacyRows) : undefined));
    const lw = await legacyOnly.names.allNames({ order: "newest", limit: 50 });
    const wantNewest = (answer([view], "names", new URLSearchParams({ order: "newest", limit: "200" })).body as { rows: NameRow[] }).rows;
    check("a host without the read API: one legacy read, source legacy, at null, the handler's order",
      lw.source === "legacy" && lw.at === null && isDeepStrictEqual(lw.rows, wantNewest) && legacyOnly.calls.filter((c) => c === LEGACY).length === 1 && legacyOnly.calls.length === 2);
    const lo = await grab(() => legacyOnly.names.allNames({ owner: legacyRows[0]!.owner }));
    check("a filtered walk on a host without the read API throws the 404", lo instanceof HttpError && lo.status === 404);
  }

  console.log("the legacy page against cairnx-api's own handler over the same rows");
  {
    // The oracle: answer() over prepareView() of a state holding the recorded legacy rows; independent of the SDK's paging.
    const state = { tipHeight: 1, names: Object.fromEntries(legacyRows.map((r) => [r.name, r])), offers: {}, bids: {}, tokens: {}, balances: {}, events: [] } as unknown as CairnXState;
    const view = prepareView(state, { height: 1, hash: `0x${"00".repeat(32)}`, input: "oracle", core: "0.2.9" });
    const { names } = client((u) => (v1Path(u.pathname) ? json(404, {}) : undefined));
    let walks = 0, same = 0;
    for (const order of ["name", "newest", "length"] as const) {
      for (const limit of [1, 2, 7, 100, 200]) {
        let after: string | null = null;
        // Bounded: a cursor that does not advance must fail the walk, not loop (174 rows at 1 a page is the longest).
        for (let n = 0; n < 400; n++) {
          const q = new URLSearchParams({ limit: String(limit), order, ...(after === null ? {} : { after }) });
          const want = answer([view], "names", q).body as { rows: NameRow[]; next: string | null; total: number };
          const got = await names.namesPage({ limit, order, after });
          walks++;
          if (isDeepStrictEqual(got.rows, want.rows) && got.next === want.next && got.total === want.total) same++;
          if (want.next === null || got.next === null) break;
          after = got.next;
        }
      }
    }
    check(`every page of every walk (orders name, newest and length, limits 1, 2, 7, 100, 200) equals the handler's: ${same} of ${walks}`, walks > 300 && same === walks);
  }

  console.log("0.8.8's calls are unchanged");
  {
    const { names, calls } = client();
    const all = await names.names();
    check("names() reads only the legacy list and returns its body as served, in its order", calls.length === 1 && calls[0] === LEGACY && isDeepStrictEqual(all, legacyRows));
  }

  console.log(`\nnames-v1: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); console.log(`\nnames-v1: threw after ${pass} passed, ${fail} failed`); process.exit(1); });
