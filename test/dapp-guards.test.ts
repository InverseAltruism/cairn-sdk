// dApp API guards: ContentClient reads the cairn origin only and reports tampering with a typed error, also for
// verified non-JSON content; the Cairn facade asks no other content source; Http's maxBytes and retries reject NaN
// (M-67). Offline.
import { ContentClient } from "../src/content.js";
import { Cairn } from "../src/index.js";
import { Http } from "../src/http.js";
import { CairnError, ContentVerificationError, HttpError, errorCode } from "../src/errors.js";
import { payloadHash, canonicalJson } from "../src/chain.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };
const caught = async (fn: () => Promise<unknown>): Promise<unknown> => { try { await fn(); return undefined; } catch (e) { return e; } };

const obj = { v: 1, domain: "d", title: "t", body: "b", links: [] };
const h = payloadHash(obj);
const good = new TextEncoder().encode(canonicalJson(obj));
const bad = new TextEncoder().encode('{"v":1,"evil":true}');
const src = (serve: Uint8Array | null | "down") => new Http({
  baseUrl: "https://s.test",
  fetch: (async () => {
    if (serve === "down") throw new TypeError("fetch failed");
    return serve ? new Response(serve as Uint8Array<ArrayBuffer>, { status: 200 }) : new Response("nope", { status: 404 });
  }) as unknown as typeof fetch,
});

console.log("ContentClient (one origin, typed get error):");
{
  ok("an origin serving mismatching bytes throws ContentVerificationError", (await caught(() => new ContentClient({ cairn: src(bad) }).getBytes(h))) instanceof ContentVerificationError);
  ok("a 404 reads as null", (await new ContentClient({ cairn: src(null) }).getBytes(h)) === null);
  ok("an unreachable origin reads as null, as 0.6.0 did when every source failed", (await new ContentClient({ cairn: src("down") }).getBytes(h)) === null);
  const one = new ContentClient({ cairn: src(good) });
  ok("honest: the origin's verified bytes parse to the object", (await one.get<typeof obj>(h))?.title === "t");

  const raw = new TextEncoder().encode("not json at all");
  const rawHash = "0x" + Buffer.from(await crypto.subtle.digest("SHA-256", raw)).toString("hex");
  const notJson = new ContentClient({ cairn: src(raw) });
  const e = await caught(() => notJson.get(rawHash));
  ok("get(): verified non-JSON bytes throw a CairnError with code CONTENT_NOT_JSON (was a raw SyntaxError)", e instanceof CairnError && errorCode(e) === "CONTENT_NOT_JSON" && !(e instanceof SyntaxError));
  ok("get(): the parse error is kept as the cause", e instanceof CairnError && (e as Error & { cause?: unknown }).cause instanceof SyntaxError);
  ok("get() honest: getBytes() still returns those verified raw bytes", (await notJson.getBytes(rawHash))?.length === raw.length);
}

console.log("ContentClient construction and hash normalization:");
{
  for (const [label, opts] of [["only swarm", { swarm: src(good) }], ["only indexer", { indexer: src(good) }], ["no options", {}]] as const) {
    const e = (() => { try { new ContentClient(opts as never); return undefined; } catch (err) { return err; } })();
    ok(`a client without \`cairn\` (${label}) throws a TypeError at construction instead of reading null`, e instanceof TypeError);
  }
  const asked: string[] = [];
  const rec = new Http({ baseUrl: "https://s.test", fetch: (async (u: unknown) => { asked.push(new URL(String(u)).pathname); return new Response(good as Uint8Array<ArrayBuffer>, { status: 200 }); }) as unknown as typeof fetch });
  const bare = h.slice(2).toUpperCase();
  const read = await new ContentClient({ cairn: rec }).get<typeof obj>(bare).catch((e: unknown) => e);
  ok("honest: a client with `cairn` reads a bare upper-case hash", (read as typeof obj | null)?.title === "t");
  ok("the hash is normalized to 0x and lower case before it is put in the path", asked.length === 1 && asked[0] === `/content/${h}`);
}

console.log("Cairn facade content reads:");
{
  const seen: string[] = [];
  const f = (async (u: unknown) => {
    const url = new URL(String(u));
    seen.push(url.origin + url.pathname);
    return url.pathname === `/content/${h}` ? new Response(good as Uint8Array<ArrayBuffer>, { status: 200 }) : new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  const cairn = new Cairn({ network: "mainnet", fetch: f });
  ok("honest: cairn.content.get returns the verified object from the cairn origin", (await cairn.content.get<typeof obj>(h))?.title === "t");
  ok("it asks the origin's /content and no other source (no indexer or swarm round trip)", seen.length === 1 && seen[0] === `https://cairn-substrate.com/content/${h}`);
}

console.log("Http clamps (M-67):");
{
  // retries: NaN made `attempt >= this.retries` never true, so a failing GET retried forever. The stub
  // succeeds on its 4th call so the pre-fix loop terminates; the fixed client must give up after one attempt.
  let calls = 0;
  const flaky = (async () => { calls++; if (calls < 4) throw new TypeError("fetch failed"); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  const e = await caught(() => new Http({ baseUrl: "https://x.test", fetch: flaky, retries: NaN }).getJson("/x"));
  ok("M-67: retries NaN reads as 0 (one attempt, the error surfaces)", e instanceof TypeError && calls === 1);
  calls = 0;
  const viaString = await caught(() => new Http({ baseUrl: "https://x.test", fetch: flaky, retries: "two" as unknown as number }).getJson("/x"));
  ok("M-67: a non-number retries reads as 0", viaString instanceof TypeError && calls === 1);

  // maxBytes: NaN made both size checks false, so the 16 MiB cap was off.
  const huge = (async () => new Response("{}", { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } })) as unknown as typeof fetch;
  for (const v of [NaN, Infinity, 0, -5]) {
    const err = await caught(() => new Http({ baseUrl: "https://x.test", fetch: huge, maxBytes: v }).getJson("/x"));
    ok(`M-67: maxBytes ${v} falls back to the default cap (a declared 64 MiB body is refused)`, err instanceof HttpError && /too large/.test((err as Error).message));
  }

  let n = 0;
  const flaky2 = (async () => { n++; return n < 3 ? new Response("boom", { status: 503 }) : new Response('{"ok":true}', { status: 200 }); }) as unknown as typeof fetch;
  const body = await new Http({ baseUrl: "https://x.test", fetch: flaky2, retries: 3 }).getJson<{ ok: boolean }>("/x");
  ok("M-67 honest: a finite retries budget still retries", body.ok === true && n === 3);
  const small = (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
  ok("M-67 honest: a finite maxBytes still accepts a small body", (await new Http({ baseUrl: "https://x.test", fetch: small, maxBytes: 1024 }).getJson<{ ok: boolean }>("/x")).ok === true);
  const half = await caught(() => new Http({ baseUrl: "https://x.test", fetch: small, maxBytes: 0.5 }).getJson<{ ok: boolean }>("/x"));
  ok("maxBytes 0.5 (below 1 byte) falls back to the default cap instead of refusing every body", half === undefined);
  const tiny = await caught(() => new Http({ baseUrl: "https://x.test", fetch: small, maxBytes: 4 }).getJson("/x"));
  ok("M-67 honest: a finite maxBytes is still enforced", tiny instanceof HttpError);
}

console.log(`\ndapp-guards: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
