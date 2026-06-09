// Runnable read-only example — works TODAY against live mainnet, no wallet, no build.
//   node examples/read-only.mjs
// Demonstrates the read surfaces: chain tip, board, indexer health, trust-minimized
// merkle inclusion, registry, and verified content fetch.
import { Cairn } from "../dist/index.js";

const cairn = new Cairn({ network: "mainnet" });

const tip = await cairn.chain.tip();
console.log(`chain tip:        height ${tip.height}  ${String(tip.tip).slice(0, 18)}…`);

const health = await cairn.index.health();
console.log(`indexer:          height ${health.indexed_height}  ${health.proposals} proposals  ${health.attestations} attestations`);

const board = await cairn.board.top({ window: "all" });
console.log(`board:            ${board.count} items  (top: "${board.items[0]?.title ?? "—"}")`);

const gateways = await cairn.registry.gateways();
console.log(`registry:         ${gateways.length} gateway(s)`);

const id = board.items[0]?.id;
if (id) {
  // verified inclusion: the merkle proof's root is cross-checked against the on-chain header
  const incl = await cairn.index.verifyInclusion(id);
  console.log(`inclusion:        ${incl.trustLevel} (block ${incl.blockHeight})`);

  // self-certifying content fetch (sha256(bytes) === payload_hash, enforced client-side)
  const prop = await cairn.index.proposal(id);
  const content = await cairn.content.get(prop.payload_hash);
  console.log(`content (verified): ${JSON.stringify(content)}`);
}

console.log("\nOK — all reads served from cairn-substrate.com, content + inclusion verified client-side.");
