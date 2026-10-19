// The indexer's address reads run over the SDK's hardened Http: a typed HttpError with the status kept, the
// 16 MiB streamed cap on a body with no content-length, and an encoded address path segment. These cases ran
// against the registry client until 0.7.0 removed it; they are pinned here on reputation() and address(), which
// take the same caller-supplied address segment, through the facade's default indexer base.
import { Cairn, HttpError } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };
const grab = async (fn: () => Promise<unknown>): Promise<unknown> => { try { return await fn(); } catch (e) { return e; } };
const jsonRes = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const urlOf = (input: RequestInfo | URL) => String(typeof input === "string" ? input : (input as Request).url ?? input);

console.log("indexer address reads:");

// Honest path on the production call shape: the facade's default indexer base is <cairn>/explorer/api.
{
  const stub = (async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (/\/explorer\/api\/address\/0xabc\/reputation$/.test(url)) return jsonRes({ address: "0xabc", score: 7 });
    if (/\/explorer\/api\/address\/0xabc$/.test(url)) return jsonRes({ address: "0xabc", tx_count: 3 });
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://x.test" }, fetch: stub });
  const rep = await cairn.index.reputation("0xabc");
  const adr = await cairn.index.address("0xabc");
  ok("happy: reputation('0xabc') hits /address/0xabc/reputation and returns the object", (rep as { score?: number })?.score === 7);
  ok("happy: address('0xabc') hits /address/0xabc and returns the object", (adr as { tx_count?: number })?.tx_count === 3);
  const e = await grab(() => cairn.index.reputation("0xnobody"));
  ok("a 404 throws HttpError with status 404", e instanceof HttpError && (e as HttpError).status === 404);
}

// A 500 rejects with the typed HttpError, status preserved, not a bare Error.
{
  const stub = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://x.test" }, fetch: stub });
  const e = await grab(() => cairn.index.reputation("0xabc"));
  ok("a 500 rejects with a typed HttpError carrying status 500", e instanceof HttpError && (e as HttpError).status === 500);
}

// A 17 MiB body with no content-length is refused by the 16 MiB streamed cap.
{
  const big = JSON.stringify({ data: "x".repeat(17 * 1024 * 1024) });
  const stub = (async () => new Response(big, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://x.test" }, fetch: stub });
  const e = await grab(() => cairn.index.reputation("0xabc"));
  ok("a 17 MiB streamed body is refused by the byte cap with a typed HttpError", e instanceof HttpError && /response (too large|exceeded)/.test(String((e as Error).message)));
}

// The address segment is encoded, so a traversal payload stays inside one path segment.
{
  const calls: string[] = [];
  const stub = (async (input: RequestInfo | URL) => {
    calls.push(urlOf(input));
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://x.test" }, fetch: stub });
  await grab(() => cairn.index.reputation("0x../../api/rpc/tip"));
  await grab(() => cairn.index.address("0x../../api/rpc/tip"));
  ok("each read issues exactly one request", calls.length === 2);
  ok("reputation(): the address segment is URL-encoded (no traversal above the base)",
    calls[0]?.endsWith("/explorer/api/address/0x..%2F..%2Fapi%2Frpc%2Ftip/reputation") === true);
  ok("address(): the address segment is URL-encoded (no traversal above the base)",
    calls[1]?.endsWith("/explorer/api/address/0x..%2F..%2Fapi%2Frpc%2Ftip") === true);
}

console.log(`\nindexer-address-reads: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
