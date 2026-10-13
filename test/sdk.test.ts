// SDK tests: HTTP clients + content self-certification + merkle inclusion + the
// retired board client staying gone. Pure unit tests: a routing mock `fetch`, no network.
import { readFileSync } from "node:fs";
import * as sdk from "../src/index.js";
import {
  Cairn,
  Http,
  ContentClient,
  IndexerClient,
  ContentVerificationError,
} from "../src/index.js";
import { payloadHash, canonicalJson, merkleRoot, merkleBranch } from "../src/chain.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };
const okThrows = async (n: string, fn: () => Promise<unknown>, ctor: new (...a: any[]) => Error) => {
  try { await fn(); ok(n, false); } catch (e) { ok(n, e instanceof ctor); }
};

// --- routing mock fetch ---------------------------------------------------
type Route = (url: URL, init: RequestInit | undefined) => Response | undefined;
function routerFetch(routes: Route[], log?: { calls: { url: string; method: string; body?: string }[] }): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const urlStr = typeof input === "string" ? input : input.url;
    const url = new URL(urlStr);
    log?.calls.push({ url: urlStr, method: init?.method ?? "GET", body: init?.body as string | undefined });
    for (const r of routes) {
      const res = r(url, init);
      if (res) return res;
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const bytes = (b: Uint8Array, status = 200) => new Response(b, { status });

console.log("=== Http: url building ===");
{
  const h = new Http({ baseUrl: "https://example.com/", fetch: routerFetch([]) });
  ok("strips trailing slash from baseUrl", h.baseUrl === "https://example.com");
  ok("joins path + query", h.url("/api/board", { domain: "csd:apps", window: "7d" }) === "https://example.com/api/board?domain=csd%3Aapps&window=7d");
  ok("omits undefined query params", h.url("/x", { a: 1, b: undefined }) === "https://example.com/x?a=1");
}

console.log("=== the board client is retired (0.4.7) ===");
{
  const cairn = new Cairn({ baseUrls: { cairn: "https://c.com" }, fetch: routerFetch([]) });
  ok("Cairn has no `board` namespace", !("board" in cairn));
  ok("BoardClient is no longer exported", !("BoardClient" in sdk));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; scripts: Record<string, string> };
  ok("package.json has no ./board subpath export and does not build src/board.ts", !("./board" in pkg.exports) && !pkg.scripts.build!.includes("board"));
}

console.log("=== ContentClient: self-certification ===");
{
  const obj = { v: 1, domain: "d", title: "t", body: "b", links: [] };
  const h = payloadHash(obj);
  const canonicalBytes = new TextEncoder().encode(canonicalJson(obj));

  const cc = new ContentClient({ cairn: new Http({ baseUrl: "https://c.com", fetch: routerFetch([
    (u) => u.pathname === `/content/${h}` ? bytes(canonicalBytes) : undefined,
  ]) }) });
  ok("prepare().payloadHash matches csd-codec", cc.prepare(obj).payloadHash === h);
  const got = await cc.get<typeof obj>(h);
  ok("get() returns the verified object", !!got && got.title === "t");

  // tampered source returns bytes that don't hash to h
  const tampered = new ContentClient({ cairn: new Http({ baseUrl: "https://c.com", fetch: routerFetch([
    (u) => u.pathname === `/content/${h}` ? bytes(new TextEncoder().encode('{"v":1,"evil":true}')) : undefined,
  ]) }) });
  await okThrows("get() throws ContentVerificationError on tampered bytes", () => tampered.getBytes(h), ContentVerificationError);

  const missing = new ContentClient({ cairn: new Http({ baseUrl: "https://c.com", fetch: routerFetch([]) }) });
  ok("get() returns null when no source holds it (404)", (await missing.getBytes(h)) === null);
}

console.log("=== IndexerClient: merkle inclusion (real fixture) ===");
{
  // Build a self-consistent merkle proof from real txids via csd-codec.
  const txids = [
    "0x" + "11".repeat(32),
    "0x" + "22".repeat(32),
    "0x" + "33".repeat(32),
    "0x" + "44".repeat(32),
  ];
  const pos = 1;
  const root = merkleRoot(txids);
  const branch = merkleBranch(txids, pos);
  const target = txids[pos]!;
  const proof = { block_height: 100, pos, merkle: branch, merkle_root: root };

  const proofFetch = (overrideRoot?: string) => routerFetch([
    (u) => u.pathname === `/tx/${target}/merkle-proof` ? json(overrideRoot ? { ...proof, merkle_root: overrideRoot } : proof) : undefined,
  ]);

  // (a) no header cross-check → proof-consistent
  const idx1 = new IndexerClient(new Http({ baseUrl: "https://i.com", fetch: proofFetch() }));
  const r1 = await idx1.verifyInclusion(target);
  // 0.4.7 contract (A4): a branch that folds without a matched verified header is NOT `included`; it is
  // proof-consistent with a reason. Through 0.4.6 this asserted included === true.
  ok("verifyInclusion folds the branch but no header source → included false", r1.included === false);
  ok("without headerMerkleAt → trustLevel proof-consistent, with a reason", r1.trustLevel === "proof-consistent" && /no header source/.test(r1.reason ?? ""));

  // (b) header cross-check matching → verified-inclusion
  const idx2 = new IndexerClient(new Http({ baseUrl: "https://i.com", fetch: proofFetch() }), { headerMerkleAt: async () => root });
  const r2 = await idx2.verifyInclusion(target);
  ok("matching on-chain header merkle → verified-inclusion", r2.trustLevel === "verified-inclusion" && r2.included === true);

  // (c) header cross-check disagreeing → not-found
  const idx3 = new IndexerClient(new Http({ baseUrl: "https://i.com", fetch: proofFetch() }), { headerMerkleAt: async () => "0x" + "ff".repeat(32) });
  const r3 = await idx3.verifyInclusion(target);
  ok("header disagreement → rejected (not-found)", r3.included === false && r3.trustLevel === "not-found");

  // (d) tampered proof (root that the branch doesn't fold to) → rejected
  const idx4 = new IndexerClient(new Http({ baseUrl: "https://i.com", fetch: proofFetch("0x" + "ab".repeat(32)) }));
  const r4 = await idx4.verifyInclusion(target);
  ok("branch not folding to claimed root → rejected", r4.included === false);

  // (e) M3: a headerMerkleAt that THROWS (e.g. the PoW light client can't verify this height —
  //     below the SPV checkpoint, or unreachable) must DEGRADE to the honest "proof-consistent",
  //     never crash and never silently claim "verified-inclusion". This is the guarantee the M3
  //     fix relies on: the facade wires a PoW-verifying headerMerkleAt that throws when it cannot
  //     PoW-verify, so the over-claim is impossible.
  const idx5 = new IndexerClient(new Http({ baseUrl: "https://i.com", fetch: proofFetch() }), { headerMerkleAt: async () => { throw new Error("below SPV checkpoint"); } });
  const r5 = await idx5.verifyInclusion(target);
  ok("M3: headerMerkleAt throwing → degrades to proof-consistent (no over-claim, no crash)", r5.included === false && r5.trustLevel === "proof-consistent" && /below SPV checkpoint/.test(r5.reason ?? ""));
}

console.log(`\nsdk.test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
