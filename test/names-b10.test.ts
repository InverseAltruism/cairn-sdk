// B10 surfaces (Plan 57): the names/CairnX read namespace, native wallet error-code mapping,
// and the http hardening (opt-in GET retry + typed malformed-JSON errors). All offline.
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
  console.log("— NamesClient (mocked front door) —");
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

  console.log("— native wallet error codes (0.2.46) preferred over string matching —");
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

  console.log("— http: opt-in GET retry + typed malformed-JSON —");
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
