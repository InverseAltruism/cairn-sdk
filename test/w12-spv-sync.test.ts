// W12 (REBIND B7c) SPV sync wiring: seededSpvLight must reach tip WITHOUT a per-height request flood, so
// it passes a headersBatchProvider backed by the cairn server's /api/headers/:from/:count. Fixing the sync
// WITHOUT the batch provider converts a fast wrong answer into a multi-thousand-request flood (the audit's
// mandatory constraint). This suite pins that the batch provider is wired and targets /api/headers on the
// cairn base (the B7d / CORS-relevant endpoint), by driving the SPV seed with a recording fetch stub and
// asserting a batch request was issued.
//
// The batch endpoint carries ZERO trust (the LightClient re-verifies every header's PoW/prev-link/LWMA), so
// this test's stub deliberately serves a non-verifying batch: the seed then fails, but the point is WHICH
// transport it reached for. RED-FIRST at authoring (observed, restored): dropping the headersBatchProvider
// from the LightClient options makes the seed fall back to per-height /api/rpc block fetches, no /api/headers
// request is issued, and the first assertion reds.
import { Cairn } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };

const seen: string[] = [];
const fetchStub: typeof fetch = async (url: RequestInfo | URL) => {
  const u = String(url);
  seen.push(u);
  // a well-formed but NON-DENSE batch: the provider rejects it (length !== count), the seed cannot verify;
  // we only care that the batch transport was REACHED for, which proves the headersBatchProvider is wired.
  if (/\/api\/headers\/\d+\/\d+$/.test(u))
    return new Response(JSON.stringify({ ok: true, headers: [] }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ ok: false, error: "stub" }), { status: 404, headers: { "content-type": "application/json" } });
};

console.log("W12 SPV sync (seededSpvLight batch provider):");

const cairn = new Cairn({ baseUrls: { cairn: "https://example.test" }, fetch: fetchStub });
// verifyOfferForFill awaits seededSpvLight() first (syncFromCheckpoint + advance-to-tip); the stubbed seed
// cannot verify, so it rejects - we swallow that and inspect the transport it used.
try { await cairn.verifyOfferForFill("0x" + "ab".repeat(32)); } catch { /* expected: the stub seed can't verify */ }

const headersCalls = seen.filter((u) => /\/api\/headers\/\d+\/\d+$/.test(u));
ok("an /api/headers batch request was issued during the SPV seed (the headersBatchProvider is wired)", headersCalls.length > 0);
ok("every batch request targets the cairn base /api/headers, not /api/rpc (the B7d/CORS-relevant endpoint)",
  headersCalls.length > 0 && headersCalls.every((u) => u.startsWith("https://example.test/api/headers/")));

console.log(`\nw12-spv-sync: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
