// C-6: the shared transport's timeout must bound the BODY read, not just time-to-headers. A 200
// that then DRIPS the body must abort at timeoutMs, not hang the read forever (the MF-13 class,
// fixed in index.ts for the SPV batcher but never applied to the shared transport every client
// uses). Red-first: on the old code the read is still pending long past the timeout. Pure unit
// test with a signal-respecting mock fetch - no network.
import { Http } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };

// A fetch whose 200 body enqueues one chunk then stalls; the stream is tied to the request's abort
// signal so an abort mid-read rejects the reader (as a real fetch body would).
const dripFetch = (async (_input: any, opts?: any) => {
  const signal = opts?.signal;
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("{\"partial\":"));
      const onAbort = () => { try { c.error(new DOMException("aborted", "AbortError")); } catch { /* already errored */ } };
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

console.log("C-6: the shared transport bounds the body read");
{
  const h = new Http({ baseUrl: "https://c.com", fetch: dripFetch, timeoutMs: 500, retries: 0 });
  const started = Date.now();
  let threw = false;
  try { await h.getJson("/x"); } catch { threw = true; }
  const elapsed = Date.now() - started;
  ok("a 200-then-drip body aborts at the timeout (bounded), never hangs", threw && elapsed >= 400 && elapsed < 5000);
}

// Paired happy-path: a normal fast body still resolves correctly (the timeout never fires).
{
  const fastFetch = (async () => new Response(JSON.stringify({ ok: true, height: 5 }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const h = new Http({ baseUrl: "https://c.com", fetch: fastFetch, timeoutMs: 5000, retries: 0 });
  let r: any = null;
  let threw = false;
  try { r = await h.getJson("/tip"); } catch { threw = true; }
  ok("a fast 200 body resolves normally (no false abort)", !threw && r?.height === 5);
}

console.log(`\nhttp-body-timeout: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
