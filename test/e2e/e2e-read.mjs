// Live READ e2e — exercises every cairn-sdk read surface against mainnet
// (cairn-substrate.com) plus adversarial verification. No wallet, no key, no cost.
//   node test/e2e/e2e-read.mjs
import { Cairn, ContentVerificationError } from "../../dist/index.js";
import { makeHarness, until } from "./harness.mjs";

const h = makeHarness("read");
// CAIRN_BASE points every read at another cairn front door (e.g. http://127.0.0.1:7777); default is mainnet.
const base = process.env.CAIRN_BASE;
const cairn = new Cairn({ network: "mainnet", ...(base ? { baseUrls: { cairn: base } } : {}) });

h.section("chain (node RPC via the public proxy)");
const tip = await cairn.chain.tip();
h.ok("chain.tip returns a height", Number(tip.height) > 0, `height ${tip.height}`);
h.ok("chain.tip returns a tip hash", /^0x[0-9a-f]{64}$/.test(String(tip.tip)));

h.section("indexer (L2)");
const ih = await cairn.index.health();
h.ok("index.health ok", ih.ok === true, `indexed ${ih.indexed_height}, ${ih.proposals} proposals`);
const itipH = await cairn.index.tipHeight();
h.ok("index.tipHeight is a number near the tip", Number.isFinite(itipH) && Math.abs(itipH - tip.height) < 50, `idx ${itipH} vs node ${tip.height}`);

h.section("indexer proposals");
const domains = await cairn.index.domains();
h.ok("index.domains returns domains", Array.isArray(domains) && domains.length > 0, `${domains.length} domains`);
// The newest proposal across the busiest domains sits above the SPV checkpoint, so verified-inclusion is reachable.
let newest = null;
for (const d of domains.slice(0, 3)) for (const p of await cairn.index.domainProposals(d.domain)) if (!newest || p.height > newest.height) newest = p;
h.ok("a recent proposal to drill into", !!newest, newest ? `${newest.domain} @ ${newest.height}` : "none");
const proposalId = newest?.txid;
// A proposal whose payload some content source stores (not every domain stores its payloads).
let contentHash = null;
for (const d of domains.slice(0, 10)) {
  for (const p of (await cairn.index.domainProposals(d.domain)).slice(0, 3)) {
    if (await cairn.content.getBytes(p.payload_hash)) { contentHash = p.payload_hash; break; }
  }
  if (contentHash) break;
}
h.ok("a proposal with stored content", !!contentHash, contentHash ? String(contentHash).slice(0, 14) : "none");

h.section("indexer drill-down + trust-minimized inclusion");
if (proposalId) {
  const prop = await cairn.index.proposal(proposalId);
  h.ok("index.proposal returns the proposal", !!prop && !!prop.payload_hash, `payload ${String(prop.payload_hash).slice(0, 12)}…`);
  const atts = await cairn.index.attestations(proposalId);
  h.ok("index.attestations returns an array", Array.isArray(atts));
  const status = await cairn.index.txStatus(proposalId);
  h.ok("index.txStatus shows confirmed", status.confirmed === true, `${status.confirmations} confs`);
  const proof = await cairn.index.txMerkleProof(proposalId);
  h.ok("index.txMerkleProof returns {block_height,pos,merkle,merkle_root}", Number.isFinite(proof.block_height) && Array.isArray(proof.merkle) && /^0x[0-9a-f]{64}$/.test(proof.merkle_root));
  const incl = await cairn.index.verifyInclusion(proposalId);
  h.ok("verifyInclusion → VERIFIED-INCLUSION (proof root == on-chain header merkle)", incl.trustLevel === "verified-inclusion" && incl.included === true, `block ${incl.blockHeight}`);
}
{
  // A tx a couple of blocks under the tip: inside the light client's re-check window, so this leg also runs
  // the near-tip reorg re-check against the live chain.
  const nearH = Number(tip.height) - 2;
  const txids = await cairn.index.blockTxids(await cairn.index.blockHashAtHeight(nearH));
  const near = await cairn.index.verifyInclusion(txids[0]);
  h.ok("verifyInclusion of a near-tip tx → VERIFIED-INCLUSION (re-checked against the served chain)", near.trustLevel === "verified-inclusion" && near.included === true, `block ${near.blockHeight}`);
}
if (contentHash) {
  h.section("content (self-certifying)");
  const got = await cairn.content.get(contentHash);
  h.ok("content.get fetches + verifies the on-chain payload", got && typeof got === "object", JSON.stringify(got).slice(0, 60));
  h.ok("content.hash(obj) reproduces the on-chain payload_hash", cairn.content.hash(got) === String(contentHash).toLowerCase(), "byte-identical canonicalization");
}

h.section("registry (L3)");
const gws = await cairn.registry.gateways();
h.ok("registry.gateways resolves", Array.isArray(gws), `${gws.length} gateway(s)`);
const peers = await cairn.registry.peers();
h.ok("registry.peers resolves (may be empty by design)", Array.isArray(peers));

h.section("adversarial — verification actually rejects bad inputs");
const bogus = await cairn.index.verifyInclusion("0x" + "00".repeat(32));
h.ok("verifyInclusion of a bogus txid → not included", bogus.included === false && bogus.trustLevel === "not-found");
const missing = await cairn.content.getBytes("0x" + "ab".repeat(32));
h.ok("content.get of an unknown hash → null", missing === null);
// fetch real bytes for a known hash, then assert verify() fails them against a DIFFERENT hash
if (contentHash) {
  const realBytes = await cairn.content.getBytes(contentHash);
  h.ok("content.verify(realBytes, wrongHash) === false (tamper detection)", realBytes && cairn.content.verify(realBytes, "0x" + "cd".repeat(32)) === false);
}
// a ContentClient pointed at a source that serves mismatched bytes must THROW
{
  const liar = new Cairn({ network: "mainnet", baseUrls: { cairn: "https://cairn-substrate.com" } });
  // monkey-free check: getBytes on a hash whose bytes won't match — simulate by asking for a hash
  // that the origin doesn't have (404→null) is covered above; the throwing path is unit-tested.
  h.ok("ContentVerificationError is exported for callers to catch", typeof ContentVerificationError === "function");
  void liar;
}

h.section("live SSE stream connects + delivers");
const streamOk = await new Promise((resolve) => {
  let opened = false;
  const handle = cairn.index.streamAll({
    onOpen: () => { opened = true; },
    onEvent: () => { handle.close(); resolve("event"); },
  });
  setTimeout(() => { handle.close(); resolve(opened ? "opened" : false); }, 12000);
});
h.ok("index.streamAll opens an SSE connection (and may deliver an event)", streamOk !== false, `state: ${streamOk}`);

process.exit(h.done() ? 0 : 1);
