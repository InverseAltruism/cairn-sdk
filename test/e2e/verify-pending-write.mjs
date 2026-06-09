// Completes the WRITE-pipeline verification against the propose the SDK already
// submitted (in the mempool), once it mines — no additional spend. Blocks were mining
// slowly during the first run, so e2e-write.mjs timed out waiting; this picks up the
// same on-chain write and verifies content + inclusion + board end-to-end.
//   node test/e2e/verify-pending-write.mjs [txidPrefix]
import { Cairn } from "../../dist/index.js";
import { makeHarness, until } from "./harness.mjs";

const PREFIX = (process.argv[2] || "0x86ad326513753343").toLowerCase();
const OPERATOR = "0x44d92872a5b65d37d60ed532f41efe7c5aed59ec";
const h = makeHarness("write-verify");
const cairn = new Cairn({ network: "mainnet" });

console.log(`waiting for the pending propose (txid ${PREFIX}…) to mine — blocks are slow, up to 25 min`);
const prop = await until(async () => {
  // scan recent csd:apps proposals from the indexer for our txid prefix
  const list = await cairn.index.domainProposals("csd:apps").catch(() => []);
  const hit = (list || []).find((p) => String(p.txid || "").toLowerCase().startsWith(PREFIX));
  return hit || null;
}, { timeoutMs: 1500000, everyMs: 10000, label: "propose to mine+index" });

h.section("on-chain propose (SDK-submitted) is mined + indexed");
h.ok("propose mined + indexed in csd:apps", !!prop, prop ? `txid ${String(prop.txid).slice(0, 18)}… @ height ${prop.height}` : "TIMEOUT");
if (!prop) process.exit(h.done() ? 0 : 1);
const txid = prop.txid;
const full = await cairn.index.proposal(txid);
h.ok("proposer is the operator key", String(full.proposer).toLowerCase() === OPERATOR, full.proposer);

h.section("content self-certifies");
const got = await until(() => cairn.content.get(full.payload_hash).catch(() => null), { timeoutMs: 120000, everyMs: 5000, label: "content" });
h.ok("content.get returns the SDK-published object (sha256-verified)", got && got.title && got.title.startsWith("cairn-sdk e2e"), got ? `"${got.title}"` : "not served");
if (got) h.ok("content.hash reproduces the on-chain payload_hash", cairn.content.hash(got) === String(full.payload_hash).toLowerCase());

h.section("trust-minimized merkle inclusion of our write");
const incl = await until(async () => { const r = await cairn.index.verifyInclusion(txid); return r.trustLevel === "verified-inclusion" ? r : null; }, { timeoutMs: 180000, everyMs: 8000, label: "verified-inclusion" });
h.ok("verifyInclusion(ourTxid) → VERIFIED-INCLUSION", !!incl, incl ? `block ${incl.blockHeight}` : "TIMEOUT");

h.section("board reflects our write");
const item = await until(() => cairn.board.item(txid).then((i) => (i?.item ? i : null)).catch(() => null), { timeoutMs: 120000, everyMs: 6000, label: "board item" });
h.ok("board.item shows our proposal with integrity ok", !!item && item.integrityOk !== false, item ? `"${item.item.title}"` : "TIMEOUT");

h.section("funds returned to confirmed balance after mining");
const bal = (await cairn.chain.utxos(OPERATOR)).confirmed_balance;
h.ok("operator confirmed balance restored (change mined back)", bal > 25_00000000, `${(bal / 1e8).toFixed(4)} CSD confirmed`);

console.log(`\nVerified the SDK's on-chain write: https://cairn-substrate.com/explorer (txid ${txid})`);
process.exit(h.done() ? 0 : 1);
