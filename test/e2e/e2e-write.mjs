// Live WRITE e2e — spends real CSD. Proves the FULL pipeline through the SDK:
//   build+sign+submit (chain) → board.propose → content register → indexer index
//   → content self-cert → trust-minimized merkle inclusion → board.support (attest).
//
// Uses the operator key via the node-signer adapter (the same cairn.board.* code paths
// a browser dApp drives through the wallet). Run:
//   node test/e2e/e2e-write.mjs            (needs ~/.config/cairn/key.json or CAIRN_KEY)
import { readFileSync } from "node:fs";
import { Cairn, WalletConnection } from "../../dist/index.js";
import { makeKeyWallet } from "../../examples/node-signer.mjs";
import { makeHarness, until } from "./harness.mjs";

const h = makeHarness("write");
const keyPath = process.env.CAIRN_KEY || `${process.env.HOME}/.config/cairn/key.json`;
let priv;
try { priv = JSON.parse(readFileSync(keyPath, "utf8")).privkey; }
catch { console.log(`SKIP: no signing key at ${keyPath} (set CAIRN_KEY). This test spends CSD.`); process.exit(0); }

const cairn = new Cairn({ network: "mainnet" });
const wallet = new WalletConnection(makeKeyWallet(priv, cairn));
cairn.attachWallet(wallet);

h.section("setup");
const addr = await wallet.connect();
// Wait for spendable funds — a prior pending tx may have the big UTXO reserved until it
// mines (mainnet blocks are slow/erratic). Poll up to 25 min so this run self-sequences.
const before = await until(async () => { const b = (await cairn.chain.utxos(addr)).confirmed_balance; return b > 1_00000000 ? b : null; }, { timeoutMs: 1500000, everyMs: 10000, label: "spendable funds (≥1 CSD)" });
h.ok("node-signer connected + funded", before && before > 1_00000000, before ? `${addr.slice(0, 10)}… ${(before / 1e8).toFixed(4)} CSD` : "no funds");
if (!before) process.exit(h.done() ? 0 : 1);

// unique content so this run is distinguishable on-chain
const stamp = `${Math.floor(Date.now() / 1000)}-${Math.floor(Math.random() * 1e6)}`;
const input = { domain: "csd:apps", title: `cairn-sdk e2e ${stamp}`, body: `Live full-pipeline e2e test. stamp=${stamp}` };

h.section("board.propose — real on-chain Propose + content registration");
const res = await cairn.board.propose(input);
h.ok("propose returned a txid", /^0x[0-9a-f]{64}$/.test(res.txid), res.txid.slice(0, 18) + "…");
h.ok("SDK payloadHash matches content.hash", res.payloadHash === cairn.content.hash(res.content));
const txid = res.txid;

h.section("wait for the Propose to mine + index (~1-3 min)");
const prop = await until(() => cairn.index.proposal(txid).catch(() => null), { timeoutMs: 1200000, everyMs: 8000, label: "Propose to mine+index" });
h.ok("Propose mined + indexed (visible via indexer)", !!prop && String(prop.payload_hash).toLowerCase() === res.payloadHash, prop ? `block-indexed, payload ${String(prop.payload_hash).slice(0, 12)}…` : "TIMEOUT");

h.section("content registration + self-certifying fetch");
// re-register now that the proposal is on-chain (propose() tried earlier, before mining)
const reg = await cairn.board.registerContent(res.content, txid);
h.ok("content registered with the cairn origin", reg.ok === true || reg.error === undefined, reg.error || "ok");
const fetched = await until(() => cairn.content.get(res.payloadHash).catch(() => null), { timeoutMs: 60000, everyMs: 4000, label: "content to be served" });
h.ok("content.get returns the exact published object (sha256-verified)", fetched && fetched.title === input.title && fetched.body === input.body, "self-certified");

h.section("trust-minimized merkle inclusion of our own write");
const incl = await until(async () => { const r = await cairn.index.verifyInclusion(txid); return r.trustLevel === "verified-inclusion" ? r : null; }, { timeoutMs: 120000, everyMs: 5000, label: "verified inclusion" });
h.ok("verifyInclusion(ourTxid) → VERIFIED-INCLUSION", !!incl, incl ? `block ${incl.blockHeight}` : "TIMEOUT");

h.section("board reflects our write");
const item = await until(() => cairn.board.item(txid).then((i) => (i && i.item ? i : null)).catch(() => null), { timeoutMs: 120000, everyMs: 5000, label: "board to show item" });
h.ok("board.item shows our proposal with integrity ok", !!item && item.integrityOk !== false, item ? `"${item.item.title}"` : "TIMEOUT");

h.section("board.support — real on-chain Attest");
const att = await cairn.board.support(txid, { score: 90, confidence: 80 });
h.ok("support returned an attest txid", /^0x[0-9a-f]{64}$/.test(String(att.txid)), String(att.txid).slice(0, 18) + "…");
const attSeen = await until(async () => { const a = await cairn.index.attestations(txid).catch(() => []); return a.some((x) => String(x.txid || x.attestation_txid || "").toLowerCase() === String(att.txid).toLowerCase()) ? a : null; }, { timeoutMs: 1200000, everyMs: 8000, label: "Attest to mine+index" });
h.ok("our attestation mined + indexed against the proposal", !!attSeen, attSeen ? `${attSeen.length} attestation(s)` : "TIMEOUT (may still mine)");

h.section("accounting");
const after = (await cairn.chain.utxos(addr)).confirmed_balance;
h.ok("balance decreased by fees (real spend occurred)", after < before, `${(before / 1e8).toFixed(4)} → ${(after / 1e8).toFixed(4)} CSD (spent ${((before - after) / 1e8).toFixed(4)})`);

console.log(`\nProposal: https://cairn-substrate.com/explorer  (txid ${txid})`);
process.exit(h.done() ? 0 : 1);
