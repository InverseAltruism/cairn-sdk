// The indexer's identity reads (identity, reverseIdentity) run over the SDK's hardened Http: typed HttpError
// with the status kept (a 404 throws, it does not resolve null), the 16 MiB streamed cap with no
// content-length, and an encoded path segment. These cases ran against the registry client until 0.7.0
// removed it; the transport is the same Http, reached here through the facade's indexer.
import { Cairn, HttpError } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };
const grab = async (fn: () => Promise<unknown>): Promise<unknown> => { try { return await fn(); } catch (e) { return e; } };
const jsonRes = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const urlOf = (input: RequestInfo | URL) => String(typeof input === "string" ? input : (input as Request).url ?? input);

console.log("indexer identity reads:");

// Honest path on the production call shape: the facade's default indexer base is <cairn>/explorer/api.
{
  const calls: string[] = [];
  const stub = (async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    calls.push(url);
    if (/\/explorer\/api\/identity\/alice$/.test(url)) return jsonRes({ handle: "alice", address: "0xa", verified: true });
    if (/\/explorer\/api\/address\/0xabc\/identity$/.test(url)) return jsonRes({ handle: "bob", address: "0xabc", verified: true });
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://x.test" }, fetch: stub });
  const rn = await cairn.index.identity("alice");
  const rv = await cairn.index.reverseIdentity("0xabc");
  ok("happy: identity('alice') hits /identity/alice and returns the object", (rn as { handle?: string })?.handle === "alice");
  ok("happy: reverseIdentity('0xabc') hits /address/0xabc/identity and returns the object", (rv as { handle?: string })?.handle === "bob");
  const e1 = await grab(() => cairn.index.identity("nobody"));
  const e2 = await grab(() => cairn.index.reverseIdentity("0xnobody"));
  ok("an unresolved handle throws HttpError 404 (it does not resolve null)", e1 instanceof HttpError && (e1 as HttpError).status === 404);
  ok("an unresolved address throws HttpError 404", e2 instanceof HttpError && (e2 as HttpError).status === 404);
}

// A 500 rejects with the typed HttpError, status preserved, not a bare Error.
{
  const stub = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://x.test" }, fetch: stub });
  const e = await grab(() => cairn.index.identity("alice"));
  ok("a 500 rejects with a typed HttpError carrying status 500", e instanceof HttpError && (e as HttpError).status === 500);
}

// A 17 MiB body with no content-length is refused by the 16 MiB streamed cap, never parsed.
{
  const big = JSON.stringify({ data: "x".repeat(17 * 1024 * 1024) });
  const stub = (async () => new Response(big, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://x.test" }, fetch: stub });
  const e = await grab(() => cairn.index.identity("alice"));
  ok("a 17 MiB streamed body is refused by the byte cap with a typed HttpError", e instanceof HttpError && /response (too large|exceeded)/.test(String((e as Error).message)));
}

// The address segment is encoded, so a traversal payload cannot walk above the base.
{
  const calls: string[] = [];
  const stub = (async (input: RequestInfo | URL) => {
    calls.push(urlOf(input));
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://x.test" }, fetch: stub });
  await grab(() => cairn.index.reverseIdentity("0x../../api/rpc/tip"));
  ok("reverseIdentity issues exactly one request", calls.length === 1);
  ok("the address segment is URL-encoded (no traversal above the base)",
    calls[0]?.includes("/explorer/api/address/0x..%2F..%2Fapi%2Frpc%2Ftip/identity") === true);
}

console.log(`\nindexer-identity: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
