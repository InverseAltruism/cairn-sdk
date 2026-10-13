// dApp API guards (cairn-sdk 0.4.7): ContentClient tries the next source after a mismatching one (W21) and
// gives a typed error for verified non-JSON content; Http's maxBytes and retries reject NaN (M-67). Offline.
import { ContentClient } from "../src/content.js";
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
const src = (serve: Uint8Array | null | "down", log?: string[], name = "") => new Http({
  baseUrl: `https://${name || "s"}.test`,
  fetch: (async () => {
    log?.push(name);
    if (serve === "down") throw new TypeError("fetch failed");
    return serve ? new Response(serve, { status: 200 }) : new Response("nope", { status: 404 });
  }) as unknown as typeof fetch,
});

console.log("ContentClient (W21, typed get error):");
{
  const log: string[] = [];
  const cc = new ContentClient({ swarm: src(bad, log, "swarm"), indexer: src(good, log, "indexer"), cairn: src(good, log, "cairn") });
  const got = await cc.getBytes(h).catch((e: unknown) => e);
  ok("W21: a mismatching first source no longer hides good content at the next one", got instanceof Uint8Array && new TextDecoder().decode(got) === canonicalJson(obj));
  ok("W21: it stopped at the first verified source (swarm, indexer; cairn not asked)", log.join(",") === "swarm,indexer");

  const allBad = new ContentClient({ swarm: src(bad), cairn: src(bad) });
  ok("W21: every source mismatching still throws ContentVerificationError", (await caught(() => allBad.getBytes(h))) instanceof ContentVerificationError);
  const badThenMissing = new ContentClient({ swarm: src(bad), indexer: src("down"), cairn: src(null) });
  ok("W21: a mismatch followed only by unreachable or 404 sources throws (tamper is reported, not hidden as null)", (await caught(() => badThenMissing.getBytes(h))) instanceof ContentVerificationError);
  const missing = new ContentClient({ swarm: src("down"), cairn: src(null) });
  ok("W21 honest: no source holds it -> null", (await missing.getBytes(h)) === null);
  const one = new ContentClient({ cairn: src(good) });
  ok("W21 honest: the single-source happy path returns the parsed object", (await one.get<typeof obj>(h))?.title === "t");

  const raw = new TextEncoder().encode("not json at all");
  const rawHash = "0x" + Buffer.from(await crypto.subtle.digest("SHA-256", raw)).toString("hex");
  const notJson = new ContentClient({ cairn: src(raw) });
  const e = await caught(() => notJson.get(rawHash));
  ok("get(): verified non-JSON bytes throw a CairnError with code CONTENT_NOT_JSON (was a raw SyntaxError)", e instanceof CairnError && errorCode(e) === "CONTENT_NOT_JSON" && !(e instanceof SyntaxError));
  ok("get(): the parse error is kept as the cause", e instanceof CairnError && (e as Error & { cause?: unknown }).cause instanceof SyntaxError);
  ok("get() honest: getBytes() still returns those verified raw bytes", (await notJson.getBytes(rawHash))?.length === raw.length);
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
  const tiny = await caught(() => new Http({ baseUrl: "https://x.test", fetch: small, maxBytes: 4 }).getJson("/x"));
  ok("M-67 honest: a finite maxBytes is still enforced", tiny instanceof HttpError);
}

console.log(`\ndapp-guards: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
