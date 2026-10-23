// B10 surfaces (Plan 57): the names/CairnX read namespace, native wallet error-code mapping,
// and the http hardening (opt-in GET retry + typed malformed-JSON errors). All offline.
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { MAX_AMOUNT } from "@inversealtruism/cairnx-core";
import { NamesClient } from "../src/names.js";
import { Http } from "../src/http.js";
import { mapProviderError, UserRejectedError, WalletLockedError, UnsupportedMethodError, CairnError, HttpError } from "../src/errors.js";

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

type Route = (url: string) => { status: number; body: string } | undefined;
function mockFetch(route: Route): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: any) => {
    const u = String(url);
    calls.push(u);
    const r = route(u) ?? { status: 404, body: JSON.stringify({ ok: false, error: "not found" }) };
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

async function main() {
  console.log("NamesClient (mocked front door)");
  {
    const { fetch, calls } = mockFetch((u) => {
      if (u.endsWith("/trade/api/cairnx/resolve/cairn")) return { status: 200, body: JSON.stringify({ ok: true, name: "cairn", addr: "0x" + "aa".repeat(20), via: "owner", lapsed: false }) };
      if (u.endsWith("/trade/api/cairnx/name/gone")) return { status: 404, body: JSON.stringify({ ok: false }) };
      if (u.endsWith("/trade/api/cairnx/token/BTC")) return { status: 200, body: JSON.stringify({ ticker: "BTC", deployId: "0x00", deployer: "0x00", decimals: 8, supply: "1", minted: "1", height: 1 }) };
      if (u.endsWith("/trade/api/cairnx/tokens")) return { status: 200, body: "[]" };
      return undefined;
    });
    const names = new NamesClient(new Http({ baseUrl: "https://x.example", fetch }));
    const r = await names.resolve("cairn");
    check("resolve() hits /trade/api/cairnx/resolve/<name> and returns the typed body", r?.addr === "0x" + "aa".repeat(20) && r?.via === "owner");
    check("an INVALID name never leaves the client (no fetch, null)", (await names.resolve("Not A Name!")) === null && !calls.some((c) => c.includes("Not")));
    check("a RESERVED name never leaves the client", (await names.resolve("csd")) === null);
    check("404 -> null (unregistered name is a value, not an exception)", (await names.name("gone")) === null);
    const t = await names.token("BTC");
    check("token() typed read works; invalid ticker -> null without a fetch", t?.ticker === "BTC" && (await names.token("btc")) === null);
    check("tokens() list passthrough", Array.isArray(await names.tokens()));
    let threw: unknown;
    const { fetch: f500 } = mockFetch(() => ({ status: 500, body: "boom" }));
    try { await new NamesClient(new Http({ baseUrl: "https://x.example", fetch: f500 })).names(); } catch (e) { threw = e; }
    check("a 5xx surfaces as a typed HttpError (outage != null)", threw instanceof HttpError && (threw as HttpError).status === 500);
  }

  console.log("W37: shape guards on the reads a dApp does arithmetic or iteration on");
  {
    const good = { ticker: "BTC", deployId: "0x00", deployer: "0x00", decimals: 8, supply: "2100000000000000", minted: "0", height: 1 };
    let body = "";
    const { fetch } = mockFetch((u) => (u.includes("/trade/api/cairnx/") ? { status: 200, body } : undefined));
    const names = new NamesClient(new Http({ baseUrl: "https://x.example", fetch }));
    const throwsMalformed = async (label: string, json: unknown, call: () => Promise<unknown>, needle: RegExp) => {
      body = JSON.stringify(json);
      let threw: unknown;
      try { await call(); } catch (e) { threw = e; }
      check(label, threw instanceof HttpError && /malformed response/.test(String((threw as Error).message)) && needle.test(String((threw as Error).message)));
    };
    await throwsMalformed("tokens(): an error object served with 200 is refused (was cast to TokenInfo[])", { ok: false, error: "cairnx backend unavailable" }, () => names.tokens(), /expected an array/);
    await throwsMalformed("tokens(): decimals as a string is refused", [{ ...good, decimals: "8" }], () => names.tokens(), /token row 0: bad decimals/);
    await throwsMalformed("tokens(): a fractional decimals is refused", [good, { ...good, decimals: 1.5 }], () => names.tokens(), /token row 1: bad decimals/);
    await throwsMalformed("token(): a negative decimals is refused", { ...good, decimals: -1 }, () => names.token("BTC"), /bad decimals/);
    await throwsMalformed("token(): supply as a float number is refused", { ...good, supply: 1e30 }, () => names.token("BTC"), /supply/);
    await throwsMalformed("token(): minted with a decimal point is refused", { ...good, minted: "1.5" }, () => names.token("BTC"), /minted/);
    await throwsMalformed("token(): decimals above the consensus range (9) is refused", { ...good, decimals: 9 }, () => names.token("BTC"), /bad decimals \(9\)/);
    await throwsMalformed("token(): a record for another ticker is refused", { ...good, ticker: "BBB" }, () => names.token("BTC"), /ticker is "BBB", expected "BTC"/);
    await throwsMalformed("token(): minted above MAX_AMOUNT is refused", { ...good, minted: String(MAX_AMOUNT + 1n) }, () => names.token("BTC"), /minted .*MAX_AMOUNT/);
    await throwsMalformed("tokens(): supply above MAX_AMOUNT is refused", [good, { ...good, supply: String(MAX_AMOUNT + 1n) }], () => names.tokens(), /token row 1: supply/);
    await throwsMalformed("offers(): a non-array is refused", { offers: [] }, () => names.offers(), /expected an array/);
    await throwsMalformed("bids(): a non-array is refused", null, () => names.bids(), /expected an array/);
    await throwsMalformed("names(): a non-array is refused", "names", () => names.names(), /expected an array/);

    body = JSON.stringify([good, { ...good, ticker: "CAIRN", decimals: 0, supply: "0", mintLimit: "1000", mint: "open" }]);
    const list = await names.tokens();
    check("W37 honest: well-formed token rows pass unchanged", list.length === 2 && list[1]!.ticker === "CAIRN" && list[0]!.decimals === 8);
    body = JSON.stringify(good);
    check("W37 honest: a well-formed token() body passes", (await names.token("BTC"))?.supply === "2100000000000000");
    body = JSON.stringify({ ...good, decimals: 0, supply: String(MAX_AMOUNT) });
    check("honest: decimals 0 and supply at MAX_AMOUNT pass", (await names.token("BTC"))?.supply === String(MAX_AMOUNT));
    // Captured from https://cairn-substrate.com/trade/api/cairnx/tokens and /token/BTC (read-only GETs, 2026-10-23).
    const LIVE = JSON.parse(readFileSync(new URL("./fixtures/cairnx-tokens-live.json", import.meta.url), "utf8")) as { tokens: unknown[]; token: { BTC: unknown } };
    body = JSON.stringify(LIVE.tokens);
    check(`honest: the ${LIVE.tokens.length} live token rows pass unchanged`, isDeepStrictEqual(await names.tokens(), LIVE.tokens));
    body = JSON.stringify(LIVE.token.BTC);
    check("honest: the live token(\"BTC\") body passes unchanged", isDeepStrictEqual(await names.token("BTC"), LIVE.token.BTC));
    body = "[]";
    check("W37 honest: empty lists pass", (await names.offers()).length === 0 && (await names.bids()).length === 0 && (await names.names()).length === 0);
  }

  console.log("offers()/bids(): open rows by default, from a server that serves every status");
  {
    const offerRows = ["open", "filled", "cancelled", "expired"].map((status, i) => ({ id: `o${i}`, status }));
    const bidRows = ["done", "open", "cancelled", "expired"].map((status, i) => ({ id: `b${i}`, status }));
    const { fetch, calls } = mockFetch((u) => {
      const p = new URL(u).pathname;
      if (p === "/trade/api/cairnx/offers") return { status: 200, body: JSON.stringify(offerRows) };
      if (p === "/trade/api/cairnx/bids") return { status: 200, body: JSON.stringify(bidRows) };
      return undefined;
    });
    const names = new NamesClient(new Http({ baseUrl: "https://x.example", fetch }));
    const ids = (rows: unknown[]) => rows.map((r) => (r as { id: string }).id).join(",");
    const statusAsked = () => new URL(calls.at(-1)!).searchParams.get("status");
    check("offers() returns only the open offer and asks the server for status=open", ids(await names.offers()) === "o0" && statusAsked() === "open");
    check("bids() returns only the open bid and asks the server for status=open", ids(await names.bids()) === "b1" && statusAsked() === "open");
    check("offers({ status: \"filled\" }) returns the filled rows", ids(await names.offers({ status: "filled" })) === "o1" && statusAsked() === "filled");
    check("honest: offers({ status: \"all\" }) returns every row without a status filter", ids(await names.offers({ status: "all" })) === "o0,o1,o2,o3" && statusAsked() === null);
  }

  console.log("nameHistory(): the cairnx object shape, guarded");
  {
    // Captured verbatim from 127.0.0.1:8794/cairnx/name-history/{cairn,6} (read-only GET, 2026-10-13).
    const LIVE = JSON.parse(readFileSync(new URL("./fixtures/name-history-8794.json", import.meta.url), "utf8")) as Record<string, any>;
    let body = "";
    let status = 200;
    const { fetch } = mockFetch((u) => (u.includes("/trade/api/cairnx/name-history/") ? { status, body } : undefined));
    const names = new NamesClient(new Http({ baseUrl: "https://x.example", fetch }));
    body = JSON.stringify(LIVE.cairn);
    const a = await names.nameHistory("cairn");
    check("nameHistory honest: the live body for `cairn` passes with its events and resolution", a?.events.length === 1 && a.events[0]!.kind === "name" && a.resolve.owner === LIVE.cairn.resolve.owner && a.scopedReplaySufficient === true);
    body = JSON.stringify(LIVE["6"]);
    const b = await names.nameHistory("6");
    check("nameHistory honest: the live body for `6` keeps scopedReplaySufficient false and its caveat", b?.scopedReplaySufficient === false && typeof b.caveat === "string" && b.events.length === 10);
    status = 404; body = JSON.stringify({ ok: false });
    check("nameHistory honest: 404 -> null", (await names.nameHistory("cairn")) === null);
    status = 200;
    const bad = async (label: string, json: unknown, needle: RegExp) => {
      body = JSON.stringify(json);
      let threw: unknown;
      try { await names.nameHistory("cairn"); } catch (e) { threw = e; }
      check(label, threw instanceof HttpError && /malformed response/.test(String((threw as Error).message)) && needle.test(String((threw as Error).message)));
    };
    await bad("nameHistory: a bare array (the old declared type) is refused", LIVE.cairn.events, /not an object/);
    await bad("nameHistory: a body for another name is refused", { ...LIVE.cairn, name: "other" }, /expected "cairn"/);
    await bad("nameHistory: a missing events array is refused", { ...LIVE.cairn, events: undefined }, /events is not an array/);
    await bad("nameHistory: scopedReplaySufficient as a string is refused", { ...LIVE.cairn, scopedReplaySufficient: "false" }, /scopedReplaySufficient/);
    await bad("nameHistory: an event with a malformed txid is refused", { ...LIVE.cairn, events: [{ ...LIVE.cairn.events[0], txid: "0x12" }] }, /event 0 is malformed/);
    await bad("nameHistory: a missing resolve is refused", { ...LIVE.cairn, resolve: null }, /resolve/);
  }

  console.log("native wallet error codes (0.2.46) preferred over string matching");
  {
    check("code USER_REJECTED -> UserRejectedError even with novel UX copy", mapProviderError("the human copy changed!", "USER_REJECTED") instanceof UserRejectedError);
    check("code APPROVAL_CLOSED maps to the user-rejection class", mapProviderError("window closed", "APPROVAL_CLOSED") instanceof UserRejectedError);
    check("code WALLET_LOCKED -> WalletLockedError", mapProviderError("x", "WALLET_LOCKED") instanceof WalletLockedError);
    check("code UNKNOWN_KIND -> UnsupportedMethodError", mapProviderError("x", "UNKNOWN_KIND") instanceof UnsupportedMethodError);
    const rl = mapProviderError("too many pending", "RATE_LIMITED");
    check("code RATE_LIMITED -> CairnError with the native code", rl instanceof CairnError && rl.code === "RATE_LIMITED");
    check("fallback: pre-0.2.46 wallet (no code) still string-matches", mapProviderError("rejected by user") instanceof UserRejectedError);
    check("fallback: unknown string without code stays generic UNKNOWN", mapProviderError("weird").code === "UNKNOWN");
  }

  console.log("http: opt-in GET retry + typed malformed-JSON");
  {
    let n = 0;
    const flaky = (async () => { n++; return n < 3 ? new Response("boom", { status: 503 }) : new Response("{\"ok\":true}", { status: 200 }); }) as typeof fetch;
    const h = new Http({ baseUrl: "https://x.example", fetch: flaky, retries: 3 });
    const j = await h.getJson<{ ok: boolean }>("/x");
    check("retries:3 rides out two 5xx and succeeds on the third attempt", j.ok === true && n === 3);

    let n4 = 0;
    const teapot = (async () => { n4++; return new Response("no", { status: 404 }); }) as typeof fetch;
    let threw4: unknown;
    try { await new Http({ baseUrl: "https://x.example", fetch: teapot, retries: 5 }).getJson("/x"); } catch (e) { threw4 = e; }
    check("4xx is TERMINAL: one attempt even with a retry budget", n4 === 1 && threw4 instanceof HttpError && (threw4 as HttpError).status === 404);

    let n0 = 0;
    const down = (async () => { n0++; throw new TypeError("fetch failed"); }) as typeof fetch;
    let threw0: unknown;
    try { await new Http({ baseUrl: "https://x.example", fetch: down }).getJson("/x"); } catch (e) { threw0 = e; }
    check("default retries=0 keeps today's single-attempt behavior", n0 === 1 && threw0 instanceof TypeError);

    const junk = (async () => new Response("<html>cf error</html>", { status: 200 })) as typeof fetch;
    let threwJ: unknown;
    try { await new Http({ baseUrl: "https://x.example", fetch: junk }).getJson("/x"); } catch (e) { threwJ = e; }
    check("a malformed 2xx body surfaces as a TYPED HttpError, not a leaked SyntaxError",
      threwJ instanceof HttpError && !(threwJ instanceof SyntaxError) && String((threwJ as Error).message).includes("invalid JSON body"));
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
