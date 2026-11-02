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

// addressUtxo follows the indexer's keyset pages: at most 1,000 rows in (height, txid, vout) order, the next page
// is ?after=<block_height>:<txid>:<vout> of the last row, a short page is the end (csd-indexer /address/:a/utxo).
{
  const A = "0x" + "aa".repeat(20);
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
    txid: "0x" + (i >> 2).toString(16).padStart(64, "0"), vout: i & 3, value: 1000 + i, status: { confirmed: true, block_height: 100 + (i >> 4) },
  }));
  const key = (r: { txid: string; vout: number; status: { block_height: number } }) => `${r.status.block_height}:${r.txid}:${r.vout}`;
  // paged: the server pages as csd-indexer does; unpaged: an indexer that predates paging (ignores ?after=).
  const server = (all: ReturnType<typeof rows>, mode: "paged" | "unpaged" | "stuck") => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(urlOf(input));
      calls.push(url.pathname + url.search);
      if (url.pathname !== `/explorer/api/address/${A}/utxo`) return new Response("nf", { status: 404 });
      if (mode === "unpaged") return jsonRes(all);
      const after = url.searchParams.get("after");
      const from = after === null ? 0 : all.findIndex((r) => key(r) === after) + 1;
      return jsonRes(mode === "stuck" && after !== null ? all.slice(1000, 2000) : all.slice(from, from + 1000));
    }) as unknown as typeof globalThis.fetch;
    return { cairn: new Cairn({ baseUrls: { cairn: "https://x.test" }, fetch }), calls };
  };
  {
    const all = rows(2345);
    const { cairn, calls } = server(all, "paged");
    const got = await cairn.index.addressUtxo(A) as typeof all;
    ok("2,345 unspent outputs: all returned in order over 3 pages (was the first 1,000 only)",
      got.length === 2345 && got.every((r, i) => key(r) === key(all[i]!)) && calls.length === 3);
    ok("each next page asks ?after= the previous page's last row",
      calls[1] === `/explorer/api/address/${A}/utxo?after=${encodeURIComponent(key(all[999]!))}` && calls[2] === `/explorer/api/address/${A}/utxo?after=${encodeURIComponent(key(all[1999]!))}`);
  }
  {
    const { cairn, calls } = server(rows(12), "paged");
    const got = await cairn.index.addressUtxo(A);
    ok("happy: a short first page is the whole set, one request with no cursor", got.length === 12 && calls.length === 1 && calls[0] === `/explorer/api/address/${A}/utxo`);
  }
  {
    const { cairn, calls } = server(rows(4589), "unpaged");
    ok("an indexer that predates paging (4,589 rows in one answer): one request, every row", (await cairn.index.addressUtxo(A)).length === 4589 && calls.length === 1);
    const exact = server(rows(1000), "unpaged");
    const got = await exact.cairn.index.addressUtxo(A);
    ok("one that predates paging with exactly 1,000 rows: the repeated answer ends the read, no duplicates", got.length === 1000 && exact.calls.length === 2);
  }
  {
    // A server that cycles between two pages makes a fresh cursor each time; the order check still stops it.
    const all = rows(3500);
    let n = 0;
    const fetch: typeof globalThis.fetch = (async () => { n++; return jsonRes(n === 1 ? all.slice(0, 1000) : n % 2 === 0 ? all.slice(2000, 3000) : all.slice(1000, 2000)); }) as unknown as typeof globalThis.fetch;
    const e = await grab(() => new Cairn({ baseUrls: { cairn: "https://x.test" }, fetch }).index.addressUtxo(A));
    ok("pages that cycle back throw HttpError instead of looping", e instanceof HttpError && /do not advance/.test(String((e as Error).message)) && n <= 4);
  }
  {
    const { cairn, calls } = server(rows(3500), "stuck");
    const e = await grab(() => cairn.index.addressUtxo(A));
    ok("pages that stop advancing throw HttpError instead of looping", e instanceof HttpError && /do not advance/.test(String((e as Error).message)) && calls.length === 3);
  }
}

console.log(`\nindexer-address-reads: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
