// Register a swarm node in the on-chain csd:peers registry (the decentralized bootnode list).
// Anyone running a csd-swarm node runs this to ANNOUNCE themselves on-chain, so other nodes can
// discover + dial them by reading the chain — no hardcoded IPs, no central server. We're just one
// registered entry; every node that registers becomes another permissionless entry point.
//
//   PEER_ID=<your libp2p peer id> MULTIADDR=/ip4/<your-public-ip>/tcp/8792 \
//   node examples/register-swarm-peer.mjs
//
// Also refreshes a csd:gateways record (your public content gateway). Spends ~0.5 CSD in fees.
// Robust to slow/erratic blocks: it waits for confirmed funds before each Propose and polls until
// the proposal is mined before registering the record's exact canonical bytes.
import { readFileSync } from "node:fs";
import { Cairn, WalletConnection } from "../dist/index.js";
import { makeKeyWallet } from "./node-signer.mjs";
import { buildPeerRecord, buildGatewayRecord } from "../dist/registry.js";
import { canonicalJson, addrFromPriv } from "../dist/chain.js";

const priv = JSON.parse(readFileSync(process.env.CAIRN_KEY || `${process.env.HOME}/.config/cairn/key.json`, "utf8")).privkey;
const addr = addrFromPriv(priv);
const PEER_ID = process.env.PEER_ID || "12D3KooWCmgwHCmAZ6CJqTz81XPuPvCJenbQXEN5WUQoU51ZEty4";
const MULTIADDR = process.env.MULTIADDR || "/ip4/162.55.132.151/tcp/8792";
const GATEWAY_URL = process.env.GATEWAY_URL || "https://cairn-substrate.com/content/0x{hash}";

const cairn = new Cairn({ network: "mainnet" });
const wallet = new WalletConnection(makeKeyWallet(priv, cairn));
cairn.attachWallet(wallet);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// records are deterministic (no ts, RFC6979 sig) → re-running reproduces the same payloadHash,
// so an interrupted run can be resumed safely.
const records = [
  { label: "peers", rec: buildPeerRecord({ priv, peer_id: PEER_ID, multiaddrs: [MULTIADDR], caps: ["gateway"], address: addr }) },
  { label: "gateways", rec: buildGatewayRecord({ priv, url: GATEWAY_URL, kind: "gateway", address: addr }) },
];

async function txidFor(domain, ph) {
  const list = await cairn.index.domainProposals(domain).catch(() => []);
  return (list || []).find((p) => String(p.payload_hash).toLowerCase() === ph.toLowerCase())?.txid || null;
}
async function waitFunds() {
  for (let i = 0; i < 90; i++) { const b = (await cairn.chain.utxos(addr)).confirmed_balance; if (b > 1_00000000) return b; await sleep(8000); }
  return 0;
}

for (const { label, rec } of records) {
  // 1) propose on-chain if not already (wait for confirmed funds — a prior Propose may hold the UTXO)
  let txid = await txidFor(rec.domain, rec.payloadHash);
  if (!txid) {
    if (!(await waitFunds())) { console.log(`[${label}] no confirmed funds — skipping`); continue; }
    const tip = await cairn.chain.tip();
    const r = await wallet.propose({ domain: rec.domain, payloadHash: rec.payloadHash, uri: `csd:reg:${rec.payloadHash.slice(2, 14)}`, expiresEpoch: Math.floor(tip.height / 30) + 720, fee: 25_000_000 });
    txid = String(r.txid);
    console.log(`[${label}] proposed ${txid.slice(0, 18)}…`);
  } else {
    console.log(`[${label}] already proposed ${txid.slice(0, 18)}…`);
  }
  // 2) wait until mined+indexed, then register the EXACT canonical bytes (sha256==payload_hash)
  let mined = txid && (await txidFor(rec.domain, rec.payloadHash));
  for (let i = 0; i < 90 && !mined; i++) { await sleep(8000); mined = await txidFor(rec.domain, rec.payloadHash); }
  if (!mined) { console.log(`[${label}] still mining — re-run later to register`); continue; }
  const bytes = canonicalJson(rec.content);
  let ok = false;
  for (let i = 0; i < 8 && !ok; i++) {
    const resp = await fetch("https://cairn-substrate.com/api/content", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bytes, txid: mined }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }));
    ok = !!resp.ok;
    console.log(`[${label}] register: ${ok ? "✅ anchored" : resp.error}`);
    if (!ok) await sleep(6000);
  }
}

await sleep(12000);
console.log("\nregistry/peers:", JSON.stringify((await cairn.registry.peers().catch(() => [])).map((p) => ({ peer_id: p.peer_id, addr: p.multiaddrs?.[0] }))));
console.log("registry/gateways:", JSON.stringify((await cairn.registry.gateways().catch(() => [])).map((g) => g.url)));
