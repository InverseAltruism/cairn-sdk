// P75-5 SPV fault tolerance: MF-14 (seed commit-on-success, dirty-seed recovery + concurrent seed) and
// MF-03 (transient-vs-structural split + reseed-once). Drives the REAL Cairn facade through a routing fetch
// stub over the REAL 38097..38152 header fixture (self-verifying: LightClient.seedTrusted re-checks PoW /
// prev-links / the 38142 checkpoint hash on every run, so a bad capture reds this suite immediately). No
// network. The exact real-caller shape is `new Cairn({ baseUrls, fetch })` then `cairn.index.verifyInclusion`.
import { readFileSync } from "node:fs";
import { Cairn } from "../src/index.js";
import { headerHash } from "../src/chain.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };

const FIX = JSON.parse(readFileSync(new URL("./fixtures/spv-headers-38097-56.json", import.meta.url), "utf8")) as {
  headers: { height: number; header: { version: number; prev: string; merkle: string; time: number; bits: number; nonce: number }; hash: string }[];
};
const ROWS = FIX.headers;              // 38097..38152
const BASE = ROWS[0].height;           // 38097
const M = ROWS.find((r) => r.height === 38150)!.header.merkle;   // target txid == that block's merkle root

type Row = (typeof ROWS)[number];
const sliceRows = (from: number, count: number): Row[] => ROWS.slice(from - BASE, from - BASE + count);
const cloneRows = (rows: Row[]): Row[] => rows.map((r) => ({ ...r, header: { ...r.header } }));
const jsonRes = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// A routing stub. `onHeaders(from,count)` may return a Response to inject a fault, or undefined for a normal
// dense batch. Serves the merkle-proof (single-tx block: empty branch folds to the txid itself), rpc/tip, and
// (for the fill path) rpc/tx + rpc/block/height. Records every URL in `seen`.
function mkStub(opts: { tip: number; seen: string[]; onHeaders?: (from: number, count: number) => Response | undefined; txHeight?: number }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : (input as Request).url ?? input);
    opts.seen.push(url);
    let m: RegExpMatchArray | null;
    if ((m = url.match(/\/api\/headers\/(\d+)\/(\d+)$/))) {
      const from = Number(m[1]), count = Number(m[2]);
      const custom = opts.onHeaders?.(from, count);
      if (custom) return custom;
      return jsonRes({ ok: true, headers: sliceRows(from, count) });
    }
    if (/\/api\/rpc\/tip$/.test(url)) return jsonRes({ height: opts.tip });
    if (/\/merkle-proof$/.test(url)) return jsonRes({ block_height: 38150, pos: 0, merkle: [], merkle_root: M });
    if (/\/api\/rpc\/block\/height\/(\d+)$/.test(url)) return jsonRes({ ok: true, txs: [] });
    if (/\/api\/rpc\/tx\//.test(url)) return jsonRes({ ok: true, height: opts.txHeight ?? 38150 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}
const seedCount = (seen: string[]) => seen.filter((u) => /\/api\/headers\/38097\/46$/.test(u)).length;

console.log("P75-5 SPV fault tolerance (MF-14 seed + MF-03 reseed):");

// A0 / C0 (PAIRED HAPPY-PATH): clean stub, single call -> verified-inclusion at 38150, rides the batch lane.
{
  const seen: string[] = [];
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: mkStub({ tip: 38152, seen }) });
  const r = await cairn.index.verifyInclusion(M);
  ok("A0 happy: clean seed -> verified-inclusion at 38150 (exact real-caller shape)", r.trustLevel === "verified-inclusion" && r.included === true);
  ok("A0 happy: zero /api/rpc/block per-height fallbacks (the seed rides the batch lane)", seen.filter((u) => /\/api\/rpc\/block\//.test(u)).length === 0);
}

// A1 (MF-14): dirty-seed recovery. The FIRST seed batch is corrupted (PoW invalid at 38127 -> seedTrusted
// pushes 30 rows then throws), every later request is clean. Pre-fix the dirty client wedges forever on
// "seedTrusted must be called on a fresh client"; the fix seeds a FRESH client per attempt.
{
  const seen: string[] = [];
  let seedReq = 0;
  const onHeaders = (from: number, count: number): Response | undefined => {
    if (from === 38097) {
      seedReq++;
      if (seedReq === 1) {
        const bad = cloneRows(sliceRows(from, count));
        const i = 38127 - BASE;                                  // row 30
        bad[i].header.nonce = (bad[i].header.nonce ^ 0x5f5f5f) >>> 0;
        bad[i].hash = headerHash(bad[i].header);                 // self-consistent hash -> fails on PoW, not hash-mismatch
        return jsonRes({ ok: true, headers: bad });
      }
    }
    return undefined;
  };
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: mkStub({ tip: 38152, seen, onHeaders }) });
  const r1 = await cairn.index.verifyInclusion(M);
  const r2 = await cairn.index.verifyInclusion(M);
  ok("A1: call 1 honestly degrades (corrupt seed -> proof-consistent, no over-claim, no crash)", r1.trustLevel === "proof-consistent");
  ok("A1: call 2 RECOVERS to verified-inclusion (fresh client per attempt, no permanent wedge)", r2.trustLevel === "verified-inclusion");
  ok("A1: exactly 2 seed requests (38097/46) issued (call 1 corrupted, call 2 clean)", seedCount(seen) === 2);
}

// A2 (MF-14): concurrent first seed. Two concurrent first calls must share ONE in-flight seed. Pre-fix both
// enter the seed branch and run syncFromCheckpoint on the SAME client; the loser hits the fresh-client throw.
{
  const seen: string[] = [];
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: mkStub({ tip: 38152, seen }) });
  const [a, b] = await Promise.all([cairn.index.verifyInclusion(M), cairn.index.verifyInclusion(M)]);
  ok("A2: BOTH concurrent first calls reach verified-inclusion (shared in-flight seed)", a.trustLevel === "verified-inclusion" && b.trustLevel === "verified-inclusion");
  ok("A2: exactly ONE seed request (38097/46) for two concurrent callers", seedCount(seen) === 1);
}

// C1 (MF-03): a CF 200-HTML interstitial for from>=38143 is TRANSIENT (JSON-parse fault), NOT structural: the
// cache is kept and rethrown, NO reseed burst. Two calls stay proof-consistent, the seed count stays 1, and a
// later HEALED call recovers on the SAME cached client (still 1 seed).
{
  const seen: string[] = [];
  let healed = false;
  const onHeaders = (from: number): Response | undefined => {
    if (from >= 38143 && !healed) return new Response("<!DOCTYPE html><html>cf</html>", { status: 200, headers: { "content-type": "text/html" } });
    return undefined;
  };
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: mkStub({ tip: 38152, seen, onHeaders }) });
  const r1 = await cairn.index.verifyInclusion(M);
  const r2 = await cairn.index.verifyInclusion(M);
  ok("C1: a CF 200-HTML for from>=38143 degrades BOTH calls to proof-consistent (transient, no crash)", r1.trustLevel === "proof-consistent" && r2.trustLevel === "proof-consistent");
  ok("C1: NO reseed burst - exactly ONE seed request across both transient failures (DOS-HDR-3 not re-authored)", seedCount(seen) === 1);
  healed = true;
  const r3 = await cairn.index.verifyInclusion(M);
  ok("C1: a subsequent HEALED read recovers to verified-inclusion on the KEPT cache (still 1 seed)", r3.trustLevel === "verified-inclusion" && seedCount(seen) === 1);
}

// C2 (MF-03): a STRUCTURAL reorg break (broken prev-link at 38143) reseeds ONCE and commits the fresh client.
// tip==38142 so the seed's tip-advance is a no-op and the op's own forward sync is what hits the corruption.
{
  const seen: string[] = [];
  let hdr143 = 0;
  const onHeaders = (from: number, count: number): Response | undefined => {
    if (from === 38143) {
      hdr143++;
      if (hdr143 === 1) {
        const bad = cloneRows(sliceRows(from, count));
        bad[0].header.prev = "0x" + "00".repeat(32);            // orphan the cached tip -> broken prev link at 38143
        bad[0].hash = headerHash(bad[0].header);
        return jsonRes({ ok: true, headers: bad });
      }
    }
    return undefined;
  };
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: mkStub({ tip: 38142, seen, onHeaders }) });
  const r1 = await cairn.index.verifyInclusion(M);
  ok("C2: call 1 already reaches verified-inclusion (reseed retried the op on the fresh client and committed)", r1.trustLevel === "verified-inclusion");
  ok("C2: exactly one reseed - seed count (38097/46) == 2", seedCount(seen) === 2);
  const r2 = await cairn.index.verifyInclusion(M);
  const r3 = await cairn.index.verifyInclusion(M);
  ok("C2: the fresh client is committed - no per-call reseeding (count still 2 after 3 calls)", r2.trustLevel === "verified-inclusion" && r3.trustLevel === "verified-inclusion" && seedCount(seen) === 2);
}

// C3 (MF-03): the FILL path unwedges too. The offer id does not exist on the stub, so the check cannot succeed;
// assert instead on the reseed evidence (the structural break under verifyTxInclusion triggers withSpvReseed).
{
  const seen: string[] = [];
  let hdr143 = 0;
  const onHeaders = (from: number, count: number): Response | undefined => {
    if (from === 38143) {
      hdr143++;
      if (hdr143 === 1) {
        const bad = cloneRows(sliceRows(from, count));
        bad[0].header.prev = "0x" + "00".repeat(32);
        bad[0].hash = headerHash(bad[0].header);
        return jsonRes({ ok: true, headers: bad });
      }
    }
    return undefined;
  };
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: mkStub({ tip: 38142, seen, onHeaders, txHeight: 38150 }) });
  const r = await cairn.verifyOfferForFill("0x" + "ab".repeat(32));
  ok("C3: verifyOfferForFill drove withSpvReseed under verifyTxInclusion - seed count reached 2 (one reseed)", seedCount(seen) === 2);
  ok("C3: the returned check is NOT wedged on the structural (reorg) error", !/broken prev link/.test(r.reason ?? ""));
}

console.log(`\nspv-fault-tolerance: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
