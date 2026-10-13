// SPV trust honesty (cairn-sdk 0.4.7): the reorg re-check on cached near-tip headers (MF-03), the
// `included` contract and the proof-consistent `reason` (A4, C-11), and Retry-After (W18). Drives the
// REAL Cairn facade over the REAL 101953..102032 header fixture through a routing fetch stub; no network.
// Fixture capture: one read-only `GET 127.0.0.1:7777/api/headers/101953/80`, stored verbatim; its first
// 56 rows are byte-identical to spv-headers-101953-56.json.
import { readFileSync } from "node:fs";
import { Cairn, Http, IndexerClient } from "../src/index.js";
import { retryAfterMs, MAX_RETRY_AFTER_MS } from "../src/http.js";
import { headerHash } from "../src/chain.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };

type Row = { height: number; header: { version: number; prev: string; merkle: string; time: number; bits: number; nonce: number }; hash: string };
const ROWS = (JSON.parse(readFileSync(new URL("./fixtures/spv-headers-101953-80.json", import.meta.url), "utf8")) as { headers: Row[] }).headers;
const BASE = ROWS[0]!.height;                 // 101953
const TIP = ROWS[ROWS.length - 1]!.height;    // 102032
const rowAt = (h: number): Row => ROWS[h - BASE]!;
const sliceRows = (from: number, count: number): Row[] => ROWS.slice(from - BASE, from - BASE + count);
const jsonRes = (obj: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });

// The stub answers merkle proofs for `txid` = the merkle root of block `proofHeight` (a single-tx block:
// an empty branch whose root is the txid, which only a PoW-matched header can upgrade). `orphanFrom`, once
// set, makes the server serve a different branch from that height up: same rows with the nonce flipped, so
// the hashes differ and the rows fail PoW (no valid competing branch can be mined in a unit test, and the
// honest outcome on a failed re-verify is a downgrade, which is what is asserted).
function mkStub(opts: { seen: string[]; proofHeight: number; orphanFrom?: () => number | undefined; onHeaders?: (from: number, count: number) => Response | undefined }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : (input as Request).url ?? input);
    opts.seen.push(url);
    let m: RegExpMatchArray | null;
    if ((m = url.match(/\/api\/headers\/(\d+)\/(\d+)$/))) {
      const from = Number(m[1]), count = Number(m[2]);
      const custom = opts.onHeaders?.(from, count);
      if (custom) return custom;
      const cut = opts.orphanFrom?.();
      const rows = sliceRows(from, count).map((r) => {
        if (cut === undefined || r.height < cut) return r;
        const header = { ...r.header, nonce: (r.header.nonce ^ 0x5a5a5a) >>> 0 };
        return { ...r, header, hash: headerHash(header) };
      });
      return jsonRes({ ok: true, headers: rows });
    }
    if (/\/api\/rpc\/tip$/.test(url)) return jsonRes({ height: TIP });
    if (/\/merkle-proof$/.test(url)) return jsonRes({ block_height: opts.proofHeight, pos: 0, merkle: [], merkle_root: rowAt(opts.proofHeight).header.merkle });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}
const seedCount = (seen: string[]) => seen.filter((u) => /\/api\/headers\/101953\/46$/.test(u)).length;
const singleRowReads = (seen: string[], h: number) => seen.filter((u) => u.endsWith(`/api/headers/${h}/1`)).length;

console.log("SPV trust honesty:");

// MF-03 red: a tx in a block orphaned after the header was cached. Before the fix, the second read answered
// from the cached branch with no network touch and still said verified-inclusion.
{
  const H = TIP - 2;   // 102030: inside the re-check window of the cached tip
  const seen: string[] = [];
  let reorgAt: number | undefined;
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: mkStub({ seen, proofHeight: H, orphanFrom: () => reorgAt }) });
  const before = await cairn.index.verifyInclusion(rowAt(H).header.merkle);
  ok("MF-03 setup: the first read is verified-inclusion from a fresh seed", before.trustLevel === "verified-inclusion" && before.included === true);
  reorgAt = H - 1;     // the server now serves another branch from 102029 up
  const after = await cairn.index.verifyInclusion(rowAt(H).header.merkle);
  ok("MF-03: after the reorg the cached near-tip header no longer backs verified-inclusion", after.trustLevel !== "verified-inclusion" && after.included === false);
  ok("MF-03: the re-check asked the server for that one header", singleRowReads(seen, H) >= 1);
  ok("MF-03: the mismatch was structural, so a reseed from the checkpoint ran (seed count 2)", seedCount(seen) === 2);
}

// MF-03 paired honest path: no reorg. A near-tip read stays verified-inclusion on the cached client, costs one
// single-header request per read, and never reseeds; a read deeper than the window adds no request at all.
{
  const H = TIP - 2;
  const seen: string[] = [];
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: mkStub({ seen, proofHeight: H }) });
  const r1 = await cairn.index.verifyInclusion(rowAt(H).header.merkle);
  const r2 = await cairn.index.verifyInclusion(rowAt(H).header.merkle);
  ok("MF-03 honest: repeated near-tip reads stay verified-inclusion", r1.trustLevel === "verified-inclusion" && r2.trustLevel === "verified-inclusion" && r2.included === true);
  ok("MF-03 honest: one seed, no reseed", seedCount(seen) === 1);
  ok("MF-03 honest: one single-header re-check per cached near-tip read (2 reads, 2 requests)", singleRowReads(seen, H) === 2);
}
{
  const D = TIP - 26;  // 102006: deeper than the window
  const seen: string[] = [];
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: mkStub({ seen, proofHeight: D }) });
  const r1 = await cairn.index.verifyInclusion(rowAt(D).header.merkle);
  const r2 = await cairn.index.verifyInclusion(rowAt(D).header.merkle);
  ok("MF-03 honest: a deep (final) height stays verified-inclusion", r1.trustLevel === "verified-inclusion" && r2.trustLevel === "verified-inclusion");
  ok("MF-03 honest: a deep height costs no re-check request", singleRowReads(seen, D) === 0);
}

// MF-03 transient: the re-check request fails (a 404 from a lagging indexer); the read degrades honestly, the cache is kept
// (no reseed storm), then recovers once the server answers again.
{
  const H = TIP - 2;
  const seen: string[] = [];
  let limited = false;
  const onHeaders = (from: number, count: number) => (limited && count === 1 ? jsonRes({ ok: false }, 404) : undefined);
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: mkStub({ seen, proofHeight: H, onHeaders }) });
  await cairn.index.verifyInclusion(rowAt(H).header.merkle);
  limited = true;
  const r = await cairn.index.verifyInclusion(rowAt(H).header.merkle);
  ok("MF-03 transient: a failed re-check degrades to proof-consistent, never verified-inclusion", r.trustLevel === "proof-consistent" && r.included === false);
  limited = false;
  const r2 = await cairn.index.verifyInclusion(rowAt(H).header.merkle);
  ok("MF-03 transient: the next read recovers on the kept cache (seed count 1)", r2.trustLevel === "verified-inclusion" && seedCount(seen) === 1);
}

// MF-03 fill path: verifyOfferForFill gets the same re-check. The committed client's verifyTxInclusion is
// replaced with one that reports a cached verified inclusion at a near-tip height (a real offer body cannot
// be forged to fold into a real header); the reorg must then force a reseed instead of passing it through.
{
  const H = TIP - 2;
  const seen: string[] = [];
  let reorgAt: number | undefined;
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: mkStub({ seen, proofHeight: H, orphanFrom: () => reorgAt }) });
  await cairn.index.verifyInclusion(rowAt(H).header.merkle);   // seeds and commits the client
  const lc = (cairn as unknown as { _spvLight: { verifyTxInclusion: (id: string) => Promise<unknown> } })._spvLight;
  lc.verifyTxInclusion = async () => ({ trustLevel: "verified-inclusion", included: true, blockHeight: H });
  await cairn.verifyOfferForFill("0x" + "ab".repeat(32));
  ok("MF-03 fill honest: no reorg, no reseed (seed count 1) and the near-tip height was re-checked", seedCount(seen) === 1 && singleRowReads(seen, H) === 2);
  reorgAt = H - 1;
  const r = await cairn.verifyOfferForFill("0x" + "ab".repeat(32));
  ok("MF-03 fill: after the reorg the cached verified inclusion is re-checked and a reseed runs (seed count 2)", seedCount(seen) === 2);
  ok("MF-03 fill: the check is not trusted", r.ok === false && r.trust !== "verified");
}

// A4 + C-11: `included` is true only behind a matched verified header; the fallback carries a reason.
{
  const H = TIP - 26;
  const txid = rowAt(H).header.merkle;
  const proofFetch = mkStub({ seen: [], proofHeight: H });
  const bare = new IndexerClient(new Http({ baseUrl: "https://stub.test", fetch: proofFetch }));
  const r1 = await bare.verifyInclusion(txid);
  ok("A4: an empty branch whose root is the txid, no header source -> included false", r1.included === false && r1.trustLevel === "proof-consistent");
  ok("C-11: the fallback names why (no header source; empty branch)", /no header source/.test(r1.reason ?? "") && /empty branch/.test(r1.reason ?? ""));
  const failing = new IndexerClient(new Http({ baseUrl: "https://stub.test", fetch: proofFetch }), { headerMerkleAt: async () => { throw new Error("below the SPV checkpoint"); } });
  const r2 = await failing.verifyInclusion(txid);
  ok("A4: a header source that cannot verify -> proof-consistent, included false", r2.included === false && r2.trustLevel === "proof-consistent");
  ok("C-11: the reason carries the header source's error", /below the SPV checkpoint/.test(r2.reason ?? ""));
  const matched = new IndexerClient(new Http({ baseUrl: "https://stub.test", fetch: proofFetch }), { headerMerkleAt: async () => txid });
  const r3 = await matched.verifyInclusion(txid);
  ok("A4 honest: the same empty branch behind a matched header (a single-tx block) -> verified-inclusion, included true", r3.included === true && r3.trustLevel === "verified-inclusion" && r3.reason === undefined);
}

// W18: Retry-After is honoured up to the server's window instead of being cut at 4 s.
{
  const hdr = (v: string | null) => new Response(null, { status: 503, headers: v === null ? {} : { "retry-after": v } });
  ok("W18: retryAfterMs reads delta-seconds", retryAfterMs(hdr("7")) === 7000);
  ok("W18: retryAfterMs clamps to the 60 s window", retryAfterMs(hdr("600")) === MAX_RETRY_AFTER_MS && MAX_RETRY_AFTER_MS === 60_000);
  ok("W18: absent, HTTP-date and junk read as 0", retryAfterMs(hdr(null)) === 0 && retryAfterMs(hdr("Wed, 21 Oct 2026 07:28:00 GMT")) === 0 && retryAfterMs(hdr("NaN")) === 0 && retryAfterMs(hdr("-3")) === 0);

  // SPV batch: one 429 saying 5 s on the seed batch. Before the fix the wait was cut to 4 s.
  const seen: string[] = [];
  let first = true;
  const onHeaders = (from: number) => {
    if (from === 101953 && first) { first = false; return jsonRes({ ok: false }, 429, { "retry-after": "5" }); }
    return undefined;
  };
  const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: mkStub({ seen, proofHeight: TIP - 26, onHeaders }) });
  const t0 = Date.now();
  const r = await cairn.index.verifyInclusion(rowAt(TIP - 26).header.merkle);
  const waited = Date.now() - t0;
  ok("W18: the SPV seed waited the server's 5 s (>= 4.9 s) before retrying", waited >= 4900);
  ok("W18 honest: the retried seed still reaches verified-inclusion", r.trustLevel === "verified-inclusion");

  // Http.getJson (opt-in GET retries): a 503 with Retry-After 2 waits about 2 s, not the 250 ms first-attempt jitter.
  let calls = 0;
  const http = new Http({ baseUrl: "https://stub.test", retries: 1, fetch: (async () => (++calls === 1 ? jsonRes({}, 503, { "retry-after": "2" }) : jsonRes({ ok: true }))) as unknown as typeof fetch });
  const t1 = Date.now();
  const body = await http.getJson<{ ok: boolean }>("/x");
  ok("W18: Http waited the 503's Retry-After (>= 1.9 s)", Date.now() - t1 >= 1900);
  ok("W18 honest: the retried GET returns the body", body.ok === true && calls === 2);
  calls = 0;
  const quick = new Http({ baseUrl: "https://stub.test", retries: 1, fetch: (async () => (++calls === 1 ? jsonRes({}, 503) : jsonRes({ ok: true }))) as unknown as typeof fetch });
  const t2 = Date.now();
  await quick.getJson("/x");
  ok("W18 honest: without Retry-After the first retry keeps the short jitter (< 1 s)", Date.now() - t2 < 1000);
}

console.log(`\nspv-trust-honesty: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
