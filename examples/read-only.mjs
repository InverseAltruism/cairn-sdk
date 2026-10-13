// Runnable read-only example: works against live mainnet, no wallet, no build step beyond `pnpm build`.
//   node examples/read-only.mjs
// Demonstrates the read surfaces: chain tip, indexer health and proposals, trust-minimized
// merkle inclusion, registry, and verified content fetch.
import { Cairn } from "../dist/index.js";

const cairn = new Cairn({ network: "mainnet" });

const tip = await cairn.chain.tip();
console.log(`chain tip:        height ${tip.height}  ${String(tip.tip).slice(0, 18)}...`);

const health = await cairn.index.health();
console.log(`indexer:          height ${health.indexed_height}  ${health.proposals} proposals  ${health.attestations} attestations`);

const domains = await cairn.index.domains();
const busiest = domains[0]?.domain;
console.log(`domains:          ${domains.length} (busiest: ${busiest ?? "none"})`);

const gateways = await cairn.registry.gateways();
console.log(`registry:         ${gateways.length} gateway(s)`);

const proposals = busiest ? await cairn.index.domainProposals(busiest) : [];
const newest = proposals.reduce((a, p) => (!a || p.height > a.height ? p : a), null);
if (newest) {
  // verified inclusion: the merkle proof's root is checked against a PoW-verified header
  const incl = await cairn.index.verifyInclusion(newest.txid);
  console.log(`inclusion:        ${incl.trustLevel} (block ${incl.blockHeight})${incl.included ? "" : `  reason: ${incl.reason}`}`);

  // self-certifying content fetch (sha256(bytes) === payload_hash, enforced client-side); null if no source stores it
  const content = await cairn.content.get(newest.payload_hash);
  console.log(`content (verified): ${content === null ? "not stored by any source" : JSON.stringify(content).slice(0, 120)}`);
}

console.log("\nOK: all reads served from cairn-substrate.com; content and inclusion verified client-side.");
