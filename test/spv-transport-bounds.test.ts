// P75-5 MF-13: bounded batch transport. The SPV header batch read must bound BOTH the response headers AND
// the body (one AbortController spanning the whole attempt) and stream the body through a capped reader, so a
// hostile/MITM'd 200 that is oversize or never-ending fails BOUNDED instead of OOMing or hanging the client.
// Drives the REAL Cairn facade through a routing fetch stub over the REAL header fixture. No network.
import { readFileSync } from "node:fs";
import { Cairn } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };

const FIX = JSON.parse(readFileSync(new URL("./fixtures/spv-headers-38097-56.json", import.meta.url), "utf8")) as {
  headers: { height: number; header: Record<string, unknown>; hash: string }[];
};
const ROWS = FIX.headers;
const BASE = ROWS[0].height;
const M = ROWS.find((r) => r.height === 38150)!.header.merkle as string;
type Row = (typeof ROWS)[number];
const sliceRows = (from: number, count: number): Row[] => ROWS.slice(from - BASE, from - BASE + count);
const jsonRes = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function baseRoutes(url: string, tip: number): Response | undefined {
  if (/\/api\/rpc\/tip$/.test(url)) return jsonRes({ height: tip });
  if (/\/merkle-proof$/.test(url)) return jsonRes({ block_height: 38150, pos: 0, merkle: [], merkle_root: M });
  if (/\/api\/rpc\/block\/height\/(\d+)$/.test(url)) return jsonRes({ ok: true, txs: [] });
  if (/\/api\/rpc\/tx\//.test(url)) return jsonRes({ ok: true, height: 38150 });
  return undefined;
}
const seedCount = (seen: string[]) => seen.filter((u) => /\/api\/headers\/38097\/46$/.test(u)).length;

console.log("P75-5 MF-13 bounded batch transport:");

// B0 (PAIRED HAPPY-PATH): clean stub, honest ~170 KB max batches -> verified-inclusion, zero decline/latency.
{
  const seen: string[] = [];
  const stub = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : (input as Request).url ?? input);
    seen.push(url);
    let m: RegExpMatchArray | null;
    if ((m = url.match(/\/api\/headers\/(\d+)\/(\d+)$/))) return jsonRes({ ok: true, headers: sliceRows(Number(m[1]), Number(m[2])) });
    return baseRoutes(url, 38152) ?? new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: stub });
  const r = await cairn.index.verifyInclusion(M);
  ok("B0 happy: an honest batch (~170 KB max, 12x under the cap) still verifies (no decline, no latency)", r.trustLevel === "verified-inclusion" && r.included === true);
}

// B1 (size cap): the first from>=38143 batch is a VALID dense batch bloated with ~300 KB/row of pad (>2 MiB);
// every later hit 404s. The oversize batch is REFUSED, the seed survives, the client degrades to proof-consistent.
{
  const seen: string[] = [];
  let bigHit = 0;
  const stub = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : (input as Request).url ?? input);
    seen.push(url);
    let m: RegExpMatchArray | null;
    if ((m = url.match(/\/api\/headers\/(\d+)\/(\d+)$/))) {
      const from = Number(m[1]), count = Number(m[2]);
      if (from < 38143) return jsonRes({ ok: true, headers: sliceRows(from, count) });
      bigHit++;
      if (bigHit === 1) {
        const padded = sliceRows(from, count).map((r) => ({ header: r.header, hash: r.hash, pad: "x".repeat(300 * 1024) }));
        return jsonRes({ ok: true, headers: padded });   // >2 MiB total; LightClient would ignore `pad`, so pre-fix this VERIFIES
      }
      return new Response("gone", { status: 404 });
    }
    return baseRoutes(url, 38152) ?? new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: stub });
  const r = await cairn.index.verifyInclusion(M);
  ok("B1 size cap: an oversize (>2 MiB) 200 batch is REFUSED, the seed survives, degrade to proof-consistent", r.trustLevel === "proof-consistent");
  ok("B1 size cap: the seed itself was NOT re-fetched (bounded degrade, not a reseed storm)", seedCount(seen) === 1);
}

// B2 (whole-attempt abort): the first from>=38143 batch returns a 200 whose body enqueues `{"headers":` then
// STALLS forever; the runtime ties the body stream to the AbortSignal. The attempt-spanning timer aborts the
// in-flight body read (pre-fix the timer is cleared at headers and res.json() hangs). Every later hit 404s.
{
  const seen: string[] = [];
  let stallHit = 0;
  let abortFired = false;
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : (input as Request).url ?? input);
    seen.push(url);
    let m: RegExpMatchArray | null;
    if ((m = url.match(/\/api\/headers\/(\d+)\/(\d+)$/))) {
      const from = Number(m[1]), count = Number(m[2]);
      if (from < 38143) return jsonRes({ ok: true, headers: sliceRows(from, count) });
      stallHit++;
      if (stallHit === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"headers":'));   // then stall forever
            init?.signal?.addEventListener("abort", () => { abortFired = true; try { controller.error(new Error("aborted")); } catch { /* already errored */ } });
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("gone", { status: 404 });
    }
    return baseRoutes(url, 38152) ?? new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: stub });
  const t0 = Date.now();
  const r = await cairn.index.verifyInclusion(M);
  const elapsed = Date.now() - t0;
  ok("B2 abort: the attempt-spanning timer ABORTED the stalled in-flight body read (abort fired)", abortFired === true);
  ok("B2 abort: the stalled batch does not hang - the call completes as proof-consistent", r.trustLevel === "proof-consistent");
  ok("B2 abort: bounded wall-clock (< 60s; one 15s abort + a fast 404 retry)", elapsed < 60000);
}

console.log(`\nspv-transport-bounds: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
