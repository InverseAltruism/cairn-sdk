// SDK-B1 hardening regression tests: DESER-3 (verifyInclusion fail-closed on a malformed proof),
// DESER-4 (response size cap), CONTENT-HASH-PATH-1 (id path-injection rejected), CAIRN-SPV-3 (equivocation
// discriminant). Pure unit tests with a routing mock fetch — no network.
import { Http, IndexerClient, ContentClient } from "../src/index.js";
import { merkleRoot, merkleBranch, sha256d } from "../src/chain.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };
type Route = (url: URL) => Response | undefined;
function routerFetch(routes: Route[], log?: { urls: string[] }): typeof fetch {
  return (async (input: any) => {
    const urlStr = typeof input === "string" ? input : input.url;
    log?.urls.push(urlStr);
    const url = new URL(urlStr);
    for (const r of routes) { const res = r(url); if (res) return res; }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

console.log("=== DESER-3: verifyInclusion fail-closed on a malformed merkle proof ===");
for (const bad of [{ merkle: "notarray" }, { pos: "x", merkle: [123], merkle_root: null }, {}, { block_height: 1, pos: 0, merkle: ["nothex"], merkle_root: "0x" + "a".repeat(64) }]) {
  const ix = new IndexerClient(new Http({ baseUrl: "https://c.com", fetch: routerFetch([(u) => u.pathname.endsWith("/merkle-proof") ? json(bad) : undefined]) }));
  let threw = false, r: any = null;
  try { r = await ix.verifyInclusion("0x" + "1".repeat(64)); } catch { threw = true; }
  ok(`malformed proof ${JSON.stringify(bad).slice(0, 28)} → not-found (no throw)`, !threw && r?.trustLevel === "not-found");
}

console.log("=== verifyInclusion: a position the branch cannot hold, or a height that is not a safe integer, is not-found ===");
{
  // csd-codec's fold reads only the low bits of pos that the branch has levels for, so a tx at position 0 of a
  // two-transaction block folds as well with pos 2, 2^32 or 2^53; the header matches the root, so the forged pos
  // came back as verified-inclusion.
  const txids = ["0x" + "10".repeat(32), "0x" + "20".repeat(32)];
  const root = merkleRoot(txids), branch = merkleBranch(txids, 0);
  const at = (proof: object) => new IndexerClient(
    new Http({ baseUrl: "https://c.com", fetch: routerFetch([(u) => u.pathname.endsWith("/merkle-proof") ? json(proof) : undefined]) }),
    { headerMerkleAt: async () => root });
  const bad: string[] = [];
  for (const pos of [2, 3, 2 ** 32, 2 ** 53]) {
    const r: any = await at({ block_height: 145_600, pos, merkle: branch, merkle_root: root }).verifyInclusion(txids[0]!);
    if (!(r.included === false && r.trustLevel === "not-found" && /malformed merkle proof/.test(r.reason ?? ""))) bad.push(`pos ${pos}: ${r.trustLevel} pos=${r.pos}`);
  }
  for (const block_height of [1e21, 2 ** 53]) {
    const r: any = await at({ block_height, pos: 0, merkle: branch, merkle_root: root }).verifyInclusion(txids[0]!);
    if (!(r.included === false && r.trustLevel === "not-found")) bad.push(`height ${block_height}: ${r.trustLevel}`);
  }
  ok("a forged pos (2, 3, 2^32, 2^53) for position 0 of a two-transaction block, or a height of 1e21 or 2^53, is not-found",
    bad.length === 0 || (console.log(`    ${bad.join("; ")}`), false));
  // Honest: every position of blocks of 1 to 9 transactions verifies with its real branch.
  const misses: string[] = [];
  let proofs = 0;
  for (let n = 1; n <= 9; n++) {
    const ids = Array.from({ length: n }, (_, i) => "0x" + (i + 1).toString(16).padStart(2, "0").repeat(32));
    const r0 = merkleRoot(ids);
    for (let pos = 0; pos < n; pos++) {
      proofs++;
      const proof = { block_height: 145_600, pos, merkle: merkleBranch(ids, pos), merkle_root: r0 };
      const ix = new IndexerClient(new Http({ baseUrl: "https://c.com", fetch: routerFetch([(u) => u.pathname.endsWith("/merkle-proof") ? json(proof) : undefined]) }),
        { headerMerkleAt: async () => r0 });
      const r: any = await ix.verifyInclusion(ids[pos]!);
      if (!(r.included === true && r.trustLevel === "verified-inclusion" && r.pos === pos)) misses.push(`n=${n} pos=${pos}: ${r.trustLevel}`);
    }
  }
  ok(`honest: every position of blocks of 1 to 9 transactions is verified-inclusion at its own pos (${proofs} proofs)`,
    proofs === 45 && (misses.length === 0 || (console.log(`    ${misses.join("; ")}`), false)));
  // The depth cap: a branch of 31 levels (the most csd-codec's 32-bit fold reads exactly) folds; 32 is refused.
  const deep = (levels: number) => {
    const sibs = Array.from({ length: levels }, (_, i) => "0x" + (i % 250 + 3).toString(16).padStart(2, "0").repeat(32));
    let cur = Buffer.from("aa".repeat(32), "hex");
    for (const s of sibs) cur = Buffer.from(sha256d(new Uint8Array([...cur, ...Buffer.from(s.slice(2), "hex")])));
    return { sibs, root: "0x" + cur.toString("hex") };
  };
  const out = await Promise.all([31, 32].map(async (levels) => {
    const { sibs, root: r0 } = deep(levels);
    const proof = { block_height: 145_600, pos: 0, merkle: sibs, merkle_root: r0 };
    const ix = new IndexerClient(new Http({ baseUrl: "https://c.com", fetch: routerFetch([(u) => u.pathname.endsWith("/merkle-proof") ? json(proof) : undefined]) }),
      { headerMerkleAt: async () => r0 });
    return (await ix.verifyInclusion("0x" + "aa".repeat(32)) as any).trustLevel;
  }));
  ok("a 31-level branch at pos 0 is verified-inclusion; a 32-level one is not-found", out[0] === "verified-inclusion" && out[1] === "not-found");
}

console.log("=== CAIRN-SPV-3: chain-disagreement flagged as equivocation (distinct from absence) ===");
{
  const txids = ["0x" + "1".repeat(64), "0x" + "2".repeat(64), "0x" + "3".repeat(64), "0x" + "4".repeat(64)];
  const pos = 1, root = merkleRoot(txids), branch = merkleBranch(txids, pos);
  const proof = { block_height: 10, pos, merkle: branch, merkle_root: root };
  const ix = new IndexerClient(
    new Http({ baseUrl: "https://c.com", fetch: routerFetch([(u) => u.pathname.endsWith("/merkle-proof") ? json(proof) : undefined]) }),
    { headerMerkleAt: async () => "0x" + "f".repeat(64) }, // on-chain header disagrees with the (folding) proof
  );
  const r: any = await ix.verifyInclusion(txids[pos]!);
  ok("disagreement → trustLevel not-found", r.trustLevel === "not-found");
  ok("disagreement → equivocation:true (distinct from absence)", r.equivocation === true);
  // and a matching header → verified-inclusion, no equivocation flag
  const ix2 = new IndexerClient(
    new Http({ baseUrl: "https://c.com", fetch: routerFetch([(u) => u.pathname.endsWith("/merkle-proof") ? json(proof) : undefined]) }),
    { headerMerkleAt: async () => root },
  );
  const r2: any = await ix2.verifyInclusion(txids[pos]!);
  ok("matching header → verified-inclusion, no equivocation", r2.trustLevel === "verified-inclusion" && !r2.equivocation);
}

console.log("=== CONTENT-HASH-PATH-1: id path-injection is rejected / encoded ===");
{
  const h = new Http({ baseUrl: "https://c.com/explorer/api", fetch: routerFetch([]) });
  let threw = false;
  try { h.url("/tx/../../../api/rpc/tip"); } catch { threw = true; } // 3× .. escapes /explorer/api → /api/rpc/tip
  ok("Http.url escaping the base path → throws", threw);
  // content hash must be 64-hex
  let chThrew = false;
  try { await new ContentClient({ cairn: new Http({ baseUrl: "https://c.com", fetch: routerFetch([]) }) }).get("x/../../api/treasury"); } catch { chThrew = true; }
  ok("ContentClient.get with a non-64hex 'hash' → throws (no path-walk)", chThrew);
  // indexer methods encode the id so a '..' segment can't traverse
  const log = { urls: [] as string[] };
  const ix = new IndexerClient(new Http({ baseUrl: "https://c.com/explorer/api", fetch: routerFetch([() => json({})], log) }));
  await ix.tx("../../api/rpc/tip").catch(() => {});
  ok("indexer.tx('../../…') stays under base (id encoded)", log.urls.every((u) => new URL(u).pathname.startsWith("/explorer/api/tx/")));
}

console.log("=== DESER-4: response larger than maxBytes is rejected ===");
{
  const big = "x".repeat(5000);
  const fetchImpl = routerFetch([(u) => u.pathname.startsWith("/tx/") ? new Response(big, { status: 200, headers: { "content-type": "application/json", "content-length": String(big.length) } }) : undefined]);
  const ix = new IndexerClient(new Http({ baseUrl: "https://c.com", fetch: fetchImpl, maxBytes: 1000 }));
  let threw = false;
  try { await ix.tx("0x" + "1".repeat(64)); } catch { threw = true; }
  ok("getJson over a >maxBytes response → throws (no OOM)", threw);
}

console.log(`\nhardening: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
