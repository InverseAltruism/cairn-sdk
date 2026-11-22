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

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

// Type-level proof: the page's row is cairnx-api's NameRow, not a widening of it, and a row with addr, profile and
// viaFill is one. `pnpm typecheck` compiles this file.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const rowIsNameRow: Exact<NamesPage["rows"][number], NameRow> = true;
const rowIsNotUnknown: Exact<NamesPage["rows"][number], unknown> = false;
const lookupRow: Exact<NonNullable<NameLookup["row"]>, NameRow> = true;
const full: NameRow = {
  name: "alice", owner: `0x${"11".repeat(20)}`, claimId: `0x${"22".repeat(32)}`, height: 1, effectiveHeight: 1, locked: false,
  addr: `0x${"33".repeat(20)}`, profile: { display: "Alice" }, viaFill: true,
};
const asState: NameState = full;
const typed: NamesPage = { rows: [full], next: null, at: null };
check("type proof: a row with addr, profile and viaFill is a NameRow and a page row (compiled by pnpm typecheck)",
  rowIsNameRow && !rowIsNotUnknown && lookupRow && asState === full && typed.rows[0] === full);

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
    check("page 1: the recorded rows, next, at and total, typed", isDeepStrictEqual(a, { rows: p1.rows, next: "0xinverse", at: p1.at, total: 174 }));
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
    check("a malformed at is INVALID_QUERY", (await code({ at: { height: 1, hash: "0x12" } })) === "INVALID_QUERY");
    check("an after that is not a names cursor of the order is INVALID_QUERY", (await code({ order: "newest", after: "m" })) === "INVALID_QUERY");
    check("nothing was sent", calls.length === 0);
  }

  console.log("fallback: each failure of the v1 read is answered from the legacy list, in the v1 order");
  const kinds: Array<[string, Router, number?]> = [
    ["404 (a host without the v1 mount)", (u) => (v1Path(u.pathname) ? new Response("Cannot GET", { status: 404 }) : undefined)],
    ["the proxy's 404 refusal (recorded)", (u) => (v1Path(u.pathname) ? json(404, JSON.parse(rec("/api/cairnx/v1/nope").body)) : undefined)],
    ["5xx", (u) => (v1Path(u.pathname) ? json(502, { ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "x" } }) : undefined)],
    ["a body that is not JSON", (u) => (v1Path(u.pathname) ? new Response("<!doctype html><title>Cairn</title>", { status: 200, headers: { "content-type": "text/html" } }) : undefined)],
    ["a timeout", (u) => (v1Path(u.pathname) ? "hang" : undefined), 50],
    ["a network error", (u) => (v1Path(u.pathname) ? "throw" : undefined)],
    ["ok: false", (u) => (v1Path(u.pathname) ? json(200, { ok: false, error: { code: "INTERNAL", message: "x" } }) : undefined)],
    ["rows not an array", (u) => (v1Path(u.pathname) ? json(200, { ok: true, level: 1, at: p1.at, rows: {}, next: null }) : undefined)],
  ];
  for (const [kind, route, timeoutMs] of kinds) {
    const { names, calls } = client(route, timeoutMs);
    const a = await grab(() => names.namesPage({ limit: 2 })) as NamesPage;
    const b = await grab(() => names.namesPage({ limit: 2, after: a.next })) as NamesPage;
    const k = await grab(() => names.lookup("6")) as NameLookup | null;
    check(`${kind}: pages 1 and 2 equal the recorded v1 pages with at null; lookup resolves; the legacy list was read`,
      isDeepStrictEqual(a, { rows: p1.rows, next: "0xinverse", at: null, total: 174 })
      && isDeepStrictEqual(b, { rows: p2.rows, next: "10", at: null, total: 174 })
      && k?.resolved?.addr === "0x44d92872a5b65d37d60ed532f41efe7c5aed59ec" && k.at === null
      && calls.filter((c) => c === LEGACY).length === 3 && calls.filter(v1Path).length === 3);
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
    const both = client((u) => (v1Path(u.pathname) || u.pathname === LEGACY ? json(500, { ok: false }) : undefined));
    const le = await grab(() => both.names.namesPage());
    check("when the legacy read fails too, its error is the caller's", le instanceof HttpError && le.status === 500 && both.calls.at(-1) === LEGACY);
  }

  console.log("a page's at is kept only when cairnx-api's parser takes it back");
  {
    const row = keyRows[0]!;
    for (const [label, at, kept] of [
      ["a 16-hex rev", { ...p1.at }, true],
      ["a rev in another form", { ...p1.at, rev: "v2-0123456789abcdef" }, false],
      ["a 20-digit rev", { ...p1.at, rev: "0123456789abcdef0123" }, false],
      ["an uppercase rev", { ...p1.at, rev: "A123456789ABCDEF" }, false],
      ["a height that is a string", { ...p1.at, height: String(p1.at.height) }, false],
    ] as const) {
      const { names, calls } = client((u) => (v1Path(u.pathname) ? json(200, { ok: true, level: 1, at, rows: [row], next: u.searchParams.has("after") ? null : row.name, total: 2 }) : undefined));
      const a = await names.namesPage({ limit: 1 });
      const b = await grab(() => names.namesPage({ limit: 1, after: a.next, at: a.at }));
      const sent = calls[1] === undefined ? null : new URL(ORIGIN + calls[1]).searchParams.get("at");
      check(`${label}: page 1 from v1 with at ${kept ? "kept" : "null"}; page 2 is sent${kept ? " pinned" : " unpinned"}, no INVALID_QUERY`,
        isDeepStrictEqual(a.rows, [row]) && (kept ? isDeepStrictEqual(a.at, p1.at) : a.at === null) && !calls.includes(LEGACY)
        && !(b instanceof Error) && calls.length === 2 && sent === (kept ? `${p1.at.height}:${p1.at.hash}:${p1.at.rev}` : null));
    }
  }

  console.log("a walk that mixes two states, and the guide's readAllNames");
  {
    // The guide's example, run as written (its fenced block holds plain JavaScript).
    const guide = readFileSync(new URL("../docs/SDK-GUIDE.md", import.meta.url), "utf8");
    const block = guide.split("```").find((b) => b.includes("async function readAllNames"));
    if (block === undefined) throw new Error("docs/SDK-GUIDE.md has no readAllNames block");
    const code = block.replace(/^ts\n/, "").split("\nconst all = await")[0]!;
    const readAllNames = new Function(`${code}\nreturn readAllNames;`)() as (n: NamesClient, o?: { limit?: number; restarts?: number }) => Promise<NameRow[]>;
    // v1 is cairnx-api's handler over the full list; the legacy list lacks a row of page 1's range (a cached copy).
    const at = { height: 146981, hash: `0x${"00".repeat(31)}01` };
    const viewOf = (rows: readonly NameRow[]) => prepareView({ tipHeight: at.height, names: Object.fromEntries(rows.map((r) => [r.name, r])), offers: {}, bids: {}, tokens: {}, balances: {}, events: [] } as unknown as CairnXState, { height: at.height, hash: at.hash, input: "walk", core: "0.2.9" });
    const fresh = viewOf(legacyRows);
    const victim = [...legacyRows].sort((a, b) => (a.name < b.name ? -1 : 1))[1]!.name;
    const stale = legacyRows.filter((r) => r.name !== victim);
    const v1Down = (first: number) => { let n = 0; return (u: URL) => {
      if (u.pathname === LEGACY) return json(200, stale);
      if (!v1Path(u.pathname)) return undefined;
      if (n++ < first) return json(502, { ok: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "x" } });
      const r = answer([fresh], "names", u.searchParams); return json(r.status, r.body);
    }; };
    // The reviewer's reproduction: page 1 from the legacy list, the later pages pinned on v1.
    const raw = client(v1Down(1));
    let page = await raw.names.namesPage({ limit: 50 });
    const ats = [page.at];
    const mixed = [...page.rows];
    while (page.next !== null) { page = await raw.names.namesPage({ limit: 50, after: page.next, at: page.at }); ats.push(page.at); mixed.push(...page.rows); }
    check("the transition: page 1 at null (legacy), page 2 on v1 with an at; a walk that ignores it misses a row of the state",
      ats[0] === null && ats[1]?.hash === at.hash && ats.slice(1).every((a) => isDeepStrictEqual(a, ats[1])) && mixed.length === legacyRows.length - 1 && page.total === legacyRows.length);
    const names = (rows: NameRow[]) => rows.map((r) => r.name);
    const healed = client(v1Down(1));
    const all = await readAllNames(healed.names, { limit: 50 });
    check("readAllNames starts again at the null at and returns the v1 state whole, once each, in name order",
      isDeepStrictEqual(names(all), names([...legacyRows].sort((a, b) => (a.name < b.name ? -1 : 1)))) && healed.calls.filter((c) => c === LEGACY).length === 1);
    const ok = client(v1Down(0));
    const direct = await readAllNames(ok.names, { limit: 50 });
    check("honest path: v1 healthy, one attempt, four pages pinned", direct.length === legacyRows.length && ok.calls.length === 4 && ok.calls.slice(1).every((c) => c.includes("at=")));
    const legacyOnly = client((u) => (v1Path(u.pathname) ? json(404, {}) : u.pathname === LEGACY ? json(200, legacyRows) : undefined));
    const e = await grab(() => readAllNames(legacyOnly.names, { limit: 50, restarts: 2 }));
    check("a host without the read API and more than one page: readAllNames gives up after its restarts (3 reads)",
      e instanceof Error && /names\(\) once/.test(e.message) && legacyOnly.calls.length === 6);
    const single = await readAllNames(legacyOnly.names, { limit: 200 });
    check("a single legacy page is one read of one list and is returned", single.length === legacyRows.length);
  }

  console.log("the legacy page against cairnx-api's own handler over the same rows");
  {
    // The oracle: answer() over prepareView() of a state holding the recorded legacy rows; independent of the SDK's paging.
    const state = { tipHeight: 1, names: Object.fromEntries(legacyRows.map((r) => [r.name, r])), offers: {}, bids: {}, tokens: {}, balances: {}, events: [] } as unknown as CairnXState;
    const view = prepareView(state, { height: 1, hash: `0x${"00".repeat(32)}`, input: "oracle", core: "0.2.9" });
    const { names } = client((u) => (v1Path(u.pathname) ? json(404, {}) : undefined));
    let walks = 0, same = 0;
    for (const order of ["name", "newest"] as const) {
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
    check(`every page of every walk (orders name and newest, limits 1, 2, 7, 100, 200) equals the handler's: ${same} of ${walks}`, walks > 300 && same === walks);
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
