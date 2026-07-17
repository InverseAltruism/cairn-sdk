// F13 offer pre-verify tests — the diligent-dApp on-chain corroboration `preverifyOffer` (and the
// `Cairn.verifyOfferForFill` method that wraps it). A mock PoW light client returns a canned verified-inclusion
// for a REAL signed offer Propose (real txid, real record commitment); a mock tx reader returns the funding
// source tx so the prevout-owner author bind resolves. We assert: an honest offer verifies (payto/seller/terms
// derived); each served-field lie (payto / seller / feeBps / spurious min) is REFUSED; and a below-checkpoint /
// unprovable-author view fails SOFT (transient), never a hard decline. Pure unit test, no network.
import { addrFromPriv, signDigest, buildScriptSig } from "@inversealtruism/csd-crypto";
import { txid, sighash, canonicalJson, payloadHash, rpcTxToTx } from "../src/chain.js";
import { preverifyOffer, feeBpsAt, bindOfferTerms } from "../src/index.js";

let pass = 0, fail = 0;
const ok = async (n: string, fn: () => Promise<boolean> | boolean) => {
  try { const r = await fn(); r ? pass++ : fail++; console.log(`  ${r ? "PASS" : "FAIL"} ${n}`); }
  catch (e) { fail++; console.log(`  FAIL ${n}\n      ${(e as Error).message}`); }
};

const K = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32).slice(0, 64);
const SELLER_KEY = K(0x11), ATTACKER_KEY = K(0x22);
const SELLER = addrFromPriv(SELLER_KEY).toLowerCase();
const ATTACKER = addrFromPriv(ATTACKER_KEY).toLowerCase();
const DOMAIN = "cairnx:v1";
const H = 40000; // > V16 (33600) so feeBps = 150

// a REAL signed Propose tx committing `rec`; its funding prevout owner is registered as `owner`.
const prevoutOf = new Map<string, { value: number; script_pubkey: string }>();
function proposeTx(priv: string, rec: object, nonce = 1) {
  const a = addrFromPriv(priv);
  const uri = canonicalJson(rec);
  const phash = payloadHash(rec);
  const prev = "0x" + nonce.toString(16).padStart(2, "0").repeat(32).slice(0, 64);
  const stripped = { version: 1, inputs: [{ prevTxid: prev, vout: 0, scriptSig: "0x" }], outputs: [{ value: 1000, scriptPubkey: a }], locktime: 0, app: { type: "Propose", domain: DOMAIN, payloadHash: phash, uri, expiresEpoch: 9_000_000 } };
  const { sig64, pub33 } = signDigest(sighash(stripped), priv);
  const scriptSig = buildScriptSig(sig64, pub33);
  const id = txid(stripped);
  const json = { txid: id, version: 1, locktime: 0, inputs: [{ prev_txid: prev, vout: 0, script_sig: scriptSig }], outputs: [{ value: 1000, script_pubkey: a }], app: { type: "Propose", domain: DOMAIN, payload_hash: phash, uri, expires_epoch: 9_000_000 } };
  // the funding source tx (a coinbase-like body whose output[0] the offer input spends), owner = the signer
  const srcStripped = { version: 1, inputs: [{ prevTxid: "0x" + "00".repeat(32), vout: 0xffffffff, scriptSig: "0x" + nonce.toString(16).padStart(8, "0") }], outputs: [{ value: 5_000_000_000, scriptPubkey: a }], locktime: 0, app: { type: "None" } };
  const srcId = txid(srcStripped);
  // rewire the offer input to spend the real source tx's output[0]
  json.inputs[0].prev_txid = srcId;
  const srcJson = { txid: srcId, version: 1, locktime: 0, inputs: [{ prev_txid: "0x" + "00".repeat(32), vout: 0xffffffff, script_sig: "0x" + nonce.toString(16).padStart(8, "0") }], outputs: [{ value: 5_000_000_000, script_pubkey: a }], app: { type: "None" } };
  // recompute the offer txid AFTER rewiring the input (txid blanks scriptSig, so re-sign is not needed for id)
  const rewired = rpcTxToTx(json);
  const newId = txid(rewired);
  json.txid = newId;
  prevoutOf.set(srcId.toLowerCase(), srcJson as never);
  return { json, id: newId.toLowerCase(), author: a.toLowerCase(), phash, uri };
}

const mockClient = { async tx(id: string) { const b = prevoutOf.get(String(id).toLowerCase()); return b ? { ok: true, tx: b } : { ok: false }; } };
const mockLight = (tx: object, appPayloadHash: string, blockHeight = H, trustLevel = "verified-inclusion", included = true) => ({
  async verifyTxInclusion(_id: string) { return { included, trustLevel, blockHeight, confirmations: 10, tx, appPayloadHash } as never; },
});
const servedFor = (extra: object = {}) => ({ id: "", seller: SELLER, feeBps: 150, height: H, want: { value: "500000000", payto: SELLER }, give: { ticker: "AAA", amount: "10" }, ...extra });

console.log("F13 offer pre-verify (preverifyOffer):");

// unit: the local bindOfferTerms/feeBpsAt copies match cairnx-core's behaviour
await ok("feeBpsAt: <V11 -> 0, [V11,V16) -> 100, >=V16 -> 150", () => feeBpsAt(1) === 0 && feeBpsAt(29960) === 100 && feeBpsAt(40000) === 150);
await ok("bindOfferTerms: honest == no mismatch; a lie -> mismatch", () => {
  const t = { height: H, feeBps: 150, value: "500000000" as string | undefined, taker: undefined, bid: undefined, min: undefined };
  return bindOfferTerms(servedFor(), t) === false && bindOfferTerms(servedFor({ feeBps: 0 }), t) === true;
});

// honest CSD offer -> verified, payto/seller/terms derived
{
  const rec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } };
  const tx = proposeTx(SELLER_KEY, rec, 1);
  await ok("honest offer -> ok, trust=verified, payto=seller=author, feeBps=150", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id }) });
    return r.ok === true && r.trust === "verified" && r.payto === SELLER && r.seller === SELLER && r.terms?.feeBps === 150 && r.terms?.value === "500000000";
  });
  await ok("honest offer with NO servedOffer still returns the proven payto/seller/terms", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id });
    return r.ok === true && r.payto === SELLER && r.seller === SELLER;
  });
  await ok("[served payto lie] a served want.payto != the proven author is REFUSED", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, want: { value: "500000000", payto: ATTACKER } }) });
    return r.ok === false && /payment recipient/.test(r.reason ?? "") && r.seller === SELLER;
  });
  await ok("[served seller lie] a swapped served seller (rebate leg) is REFUSED", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, seller: ATTACKER }) });
    return r.ok === false && /seller/.test(r.reason ?? "");
  });
  await ok("[deflated feeBps] a served feeBps=0 (proven 150) is REFUSED", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, feeBps: 0 }) });
    return r.ok === false && /fee\/rebate\/partial terms/.test(r.reason ?? "");
  });
  await ok("[spurious min] a min added to a whole-fill offer is REFUSED", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, min: "1" }) });
    return r.ok === false && /terms/.test(r.reason ?? "");
  });
  await ok("[not merkle-proven] a below-checkpoint/rpc-trusted view fails SOFT (transient), not a hard decline", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash, H, "rpc-trusted", false), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id }) });
    return r.ok === false && r.transient === true && r.trust === "unverified";
  });
  await ok("[unprovable author] a chain that can't return the funding source tx fails SOFT (transient)", async () => {
    const noSrc = { async tx() { return { ok: false }; } };
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: noSrc, offerId: tx.id, servedOffer: servedFor({ id: tx.id }) });
    return r.ok === false && r.transient === true;
  });
  await ok("[commitment mismatch] a served appPayloadHash that the record does not hash to is REFUSED (unverified)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, "0x" + "de".repeat(32)), client: mockClient, offerId: tx.id });
    return r.ok === false && r.trust === "unverified";
  });
  await ok("[wrong offer id] a proven tx whose recomputed txid != the requested offer id is REFUSED", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: "0x" + "ab".repeat(32) });
    return r.ok === false && r.trust === "unverified" && /doesn't match the offer id/.test(r.reason ?? "");
  });
}

// honest payto-LESS offer -> payto defaults to the proven author
{
  const rec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000" } };
  const tx = proposeTx(SELLER_KEY, rec, 2);
  await ok("payto-less offer defaults payto to the proven author", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id });
    return r.ok === true && r.payto === SELLER && r.seller === SELLER;
  });
}

console.log(`\nfillverify (F13): ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
