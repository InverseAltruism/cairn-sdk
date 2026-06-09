// Live READ e2e — exercises every cairn-sdk read surface against mainnet
// (cairn-substrate.com) plus adversarial verification. No wallet, no key, no cost.
//   node test/e2e/e2e-read.mjs
import { Cairn, ContentVerificationError } from "../../dist/index.js";
import { makeHarness, until } from "./harness.mjs";

const h = makeHarness("read");
const cairn = new Cairn({ network: "mainnet" });

h.section("chain (node RPC via the public proxy)");
const tip = await cairn.chain.tip();
h.ok("chain.tip returns a height", Number(tip.height) > 0, `height ${tip.height}`);
h.ok("chain.tip returns a tip hash", /^0x[0-9a-f]{64}$/.test(String(tip.tip)));

h.section("indexer (L2)");
const ih = await cairn.index.health();
h.ok("index.health ok", ih.ok === true, `indexed ${ih.indexed_height}, ${ih.proposals} proposals`);
const itipH = await cairn.index.tipHeight();
h.ok("index.tipHeight is a number near the tip", Number.isFinite(itipH) && Math.abs(itipH - tip.height) < 50, `idx ${itipH} vs node ${tip.height}`);

h.section("board (signal board + work graph)");
const board = await cairn.board.top({ window: "all" });
h.ok("board.top returns items", Array.isArray(board.items) && board.count >= 0, `${board.count} items`);
const domains = await cairn.board.domains();
h.ok("board.domains returns domains", Array.isArray(domains.domains));
const sample = board.items[0];
h.ok("board has at least one item to drill into", !!sample, sample ? `"${sample.title}"` : "none");
let proposalId = sample?.id;
if (proposalId) {
  const item = await cairn.board.item(proposalId);
  h.ok("board.item returns the item + integrity flag", item.ok !== false && !!item.item);
  if (sample.proposer) {
    // profile() throws HttpError(404) for an address with no registered profile — a
    // normal, catchable outcome (the SDK's contract: non-2xx → typed HttpError).
    try {
      const prof = await cairn.board.profile(sample.proposer);
      h.ok("board.profile resolves a proposer", prof.ok !== false);
    } catch (e) {
      h.ok("board.profile throws a catchable HttpError(404) when no profile exists", e?.name === "HttpError" && e.status === 404);
    }
  }
}
const lb = await cairn.board.leaderboard();
h.ok("board.leaderboard returns a list", Array.isArray(lb.leaderboard));
const net = await cairn.board.network();
h.ok("board.network returns a snapshot", net && typeof net === "object");

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

  h.section("content (self-certifying)");
  const prop2 = await cairn.index.proposal(proposalId);
  const ph = prop2.payload_hash;
  const got = await cairn.content.get(ph);
  h.ok("content.get fetches + verifies the on-chain payload", got && typeof got === "object", JSON.stringify(got).slice(0, 60));
  h.ok("content.hash(obj) reproduces the on-chain payload_hash", cairn.content.hash(got) === String(ph).toLowerCase(), "byte-identical canonicalization");
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
if (proposalId) {
  const ph = (await cairn.index.proposal(proposalId)).payload_hash;
  const realBytes = await cairn.content.getBytes(ph);
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
