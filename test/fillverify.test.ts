// F13 offer pre-verify tests: the diligent-dApp on-chain corroboration `preverifyOffer` (and the
// `Cairn.verifyOfferForFill` method that wraps it). A mock PoW light client returns a canned verified-inclusion
// for a REAL signed offer Propose (real txid, real record commitment); a mock tx reader returns the funding
// source tx so the prevout-owner author bind resolves. We assert: an honest offer verifies (payto/seller/terms
// derived); each served-field lie (payto / seller / feeBps / spurious min) is REFUSED; and a below-checkpoint /
// unprovable-author view fails SOFT (transient), never a hard decline. Pure unit test, no network.
import { readFileSync } from "node:fs";
import { addrFromPriv, signDigest, buildScriptSig } from "@inversealtruism/csd-crypto";
import { provenOfferTerms, epochOf } from "@inversealtruism/cairnx-core";
import { txid, sighash, canonicalJson, payloadHash, rpcTxToTx, merkleRoot } from "../src/chain.js";
import {
  Cairn,
  preverifyOffer, feeBpsAt, bindOfferTerms,
  fillEndorsement, fillOutputPlan, fillIsSafe, requiredFillOutputs, previewFill,
} from "../src/index.js";

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
function proposeTx(priv: string, rec: object, nonce = 1, domain = DOMAIN, expiresEpoch = 9_000_000) {
  const a = addrFromPriv(priv);
  const uri = canonicalJson(rec);
  const phash = payloadHash(rec);
  const prev = "0x" + nonce.toString(16).padStart(2, "0").repeat(32).slice(0, 64);
  const stripped = { version: 1, inputs: [{ prevTxid: prev, vout: 0, scriptSig: "0x" }], outputs: [{ value: 1000, scriptPubkey: a }], locktime: 0, app: { type: "Propose" as const, domain, payloadHash: phash, uri, expiresEpoch } };
  const id = txid(stripped);
  const json = { txid: id, version: 1, locktime: 0, inputs: [{ prev_txid: prev, vout: 0, script_sig: "0x" }], outputs: [{ value: 1000, script_pubkey: a }], app: { type: "Propose" as const, domain, payload_hash: phash, uri, expires_epoch: expiresEpoch } };
  // the funding source tx (a coinbase-like body whose output[0] the offer input spends), owner = the signer
  const srcStripped = { version: 1, inputs: [{ prevTxid: "0x" + "00".repeat(32), vout: 0xffffffff, scriptSig: "0x" + nonce.toString(16).padStart(8, "0") }], outputs: [{ value: 5_000_000_000, scriptPubkey: a }], locktime: 0, app: { type: "None" as const } };
  const srcId = txid(srcStripped);
  // rewire the offer input to spend the real source tx's output[0]
  json.inputs[0]!.prev_txid = srcId;
  const srcJson = { txid: srcId, version: 1, locktime: 0, inputs: [{ prev_txid: "0x" + "00".repeat(32), vout: 0xffffffff, script_sig: "0x" + nonce.toString(16).padStart(8, "0") }], outputs: [{ value: 5_000_000_000, script_pubkey: a }], app: { type: "None" } };
  // recompute the offer txid AFTER rewiring the input, then sign the rewired body: the sighash commits the prevout
  const rewired = rpcTxToTx(json);
  const newId = txid(rewired);
  json.txid = newId;
  const { sig64, pub33 } = signDigest(sighash(rewired), priv);
  json.inputs[0]!.script_sig = buildScriptSig(sig64, pub33);
  prevoutOf.set(srcId.toLowerCase(), srcJson as never);
  return { json, id: newId.toLowerCase(), author: a.toLowerCase(), phash, uri };
}

const mockClient = { async tx(id: string) { const b = prevoutOf.get(String(id).toLowerCase()); return b ? { ok: true, tx: b } : { ok: false }; } };
const mockLight = (tx: object, appPayloadHash: string, blockHeight = H, trustLevel = "verified-inclusion", included = true) => ({
  async verifyTxInclusion(_id: string) { return { included, trustLevel, blockHeight, confirmations: 10, tx, appPayloadHash } as never; },
});
// The resolver's served offer shape (cairnx-core OfferState), including the `status` every served offer carries.
const servedFor = (extra: object = {}) => ({ id: "", seller: SELLER, feeBps: 150, height: H, status: "open", want: { value: "500000000", payto: SELLER }, give: { ticker: "AAA", amount: "10" }, ...extra });

console.log("F13 offer pre-verify (preverifyOffer):");

// unit: the re-exported bindOfferTerms/feeBpsAt behave as cairnx-core's
await ok("feeBpsAt: <V11 -> 0, [V11,V16) -> 100, >=V16 -> 150", () => feeBpsAt(1) === 0 && feeBpsAt(29960) === 100 && feeBpsAt(40000) === 150);
const LEGACY = { give: false, wantType: false } as const;
await ok("bindOfferTerms opted out on hand-built terms: honest == no mismatch; a lie -> mismatch", () => {
  const t = { height: H, feeBps: 150, value: "500000000" as string | undefined, taker: undefined, bid: undefined, min: undefined };
  return bindOfferTerms(servedFor(), t, LEGACY) === false && bindOfferTerms(servedFor({ feeBps: 0 }), t, LEGACY) === true;
});
await ok("bindOfferTerms default on hand-built terms (a JS caller; TypeScript refuses the call): REFUSED, even an honest offer", () => {
  const t = { height: H, feeBps: 150, value: "500000000" as string | undefined, taker: undefined, bid: undefined, min: undefined };
  return bindOfferTerms(servedFor(), t as never) === true;
});

// The give legs (W7) + symmetric want-type refusal over BRANDED proven terms: on by default since cairnx-core 0.2.0.
await ok("bindOfferTerms: an honest give+type match -> no mismatch (default, explicit legs and opted out)", () => {
  const t = provenOfferTerms({ t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } } as never, H);
  return bindOfferTerms(servedFor(), t) === false && bindOfferTerms(servedFor(), t, { give: true, wantType: true }) === false
      && bindOfferTerms(servedFor(), t, LEGACY) === false;
});
await ok("[W7 give shortchange] a served give.amount inflated a millionfold is REFUSED by default (only the opt-out misses it)", () => {
  const t = provenOfferTerms({ t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } } as never, H);
  const lie = servedFor({ give: { ticker: "AAA", amount: "10000000000" } });
  return bindOfferTerms(lie, t) === true && bindOfferTerms(lie, t, { give: true, wantType: true }) === true
      && bindOfferTerms(lie, t, LEGACY) === false; // the opt-out is the pre-B6 verdict: it does NOT catch the give
});
await ok("[want-type flip] a proven TOKEN offer served as CSD is REFUSED by default by the wantType leg (the reverse the legacy value leg misses)", () => {
  const t = provenOfferTerms({ t: "offer", give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5", payto: SELLER } } as never, H);
  // served as CSD (want.value, no ticker): the legacy value leg does NOT fire (a proven token has no value)
  return bindOfferTerms(servedFor(), t) === true && bindOfferTerms(servedFor(), t, { give: true, wantType: true }) === true
      && bindOfferTerms(servedFor(), t, LEGACY) === false;
});

// B7b: the discriminated successors are surfaced; the deprecated funcs stay exported + behavior-frozen.
await ok("fillEndorsement / fillOutputPlan surfaced; fillIsSafe / requiredFillOutputs / previewFill still exported", () =>
  [fillEndorsement, fillOutputPlan, fillIsSafe, requiredFillOutputs, previewFill].every((f) => typeof f === "function"));
await ok("fillEndorsement: a token want is NOT-ENDORSABLE (honest non-endorsement, NEVER a refusal - the B7f trap)", () => {
  const offer = { id: "0x" + "00".repeat(32), seller: SELLER, give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5", payto: SELLER }, status: "open", expiresEpoch: 0, height: H, feeBps: 150 };
  const e = fillEndorsement(offer as never, SELLER, "5", H);
  return e.verdict === "not-endorsable";
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

  // S-B4: records the chain's own resolver REJECTS at creation must be REFUSED, not ok:true.
  {
    const TREASURY = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016";
    // payto == the protocol treasury (resolve.ts rejects it): the fill's give would be a no-op.
    const recT = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: TREASURY } };
    const txT = proposeTx(SELLER_KEY, recT, 1);
    await ok("[S-B4] an offer paying the protocol treasury is REFUSED (a chain-rejected record)", async () => {
      const r = await preverifyOffer({ light: mockLight(txT.json, txT.phash), client: mockClient, offerId: txT.id, servedOffer: servedFor({ id: txT.id, want: { value: "500000000", payto: TREASURY } }) });
      return r.ok === false && /treasury/.test(r.reason ?? "");
    });
    // expired at anchor: expires_epoch 1000 < epochOf(H=40000)=1333. The resolver rejects it at creation.
    const recX = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } };
    const txX = proposeTx(SELLER_KEY, recX, 1, DOMAIN, 1000);
    await ok("[S-B4] an already-expired-at-anchor offer is REFUSED (a chain-rejected record)", async () => {
      const r = await preverifyOffer({ light: mockLight(txX.json, txX.phash), client: mockClient, offerId: txX.id, servedOffer: servedFor({ id: txX.id }) });
      return r.ok === false && /expired/.test(r.reason ?? "");
    });
    // the expiry boundary (resolve.ts: an offer mined in its expiry epoch is live; one epoch later it is rejected).
    // epochOf(H=40000) = 1333.
    const recE = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } };
    const txE = proposeTx(SELLER_KEY, recE, 1, DOMAIN, epochOf(H));
    await ok("[S-B4] an offer mined in its own expiry epoch is accepted (boundary, honest path)", async () => {
      const r = await preverifyOffer({ light: mockLight(txE.json, txE.phash), client: mockClient, offerId: txE.id, servedOffer: servedFor({ id: txE.id }) });
      return r.ok === true && r.payto === SELLER;
    });
    const txE1 = proposeTx(SELLER_KEY, recE, 1, DOMAIN, epochOf(H) - 1);
    await ok("[S-B4] an offer mined one epoch after its expiry is REFUSED (boundary)", async () => {
      const r = await preverifyOffer({ light: mockLight(txE1.json, txE1.phash), client: mockClient, offerId: txE1.id, servedOffer: servedFor({ id: txE1.id }) });
      return r.ok === false && /expired/.test(r.reason ?? "");
    });
    // non-safe-integer expiry (>= 2^53): the codec's u64 refuses to even RE-DERIVE such a tx
    // (txid throws), so preverifyOffer fails closed at the re-derivation step - never ok:true. The
    // resolver also rejects a non-safe-integer expiresEpoch outright, and provenOfferRefusal applies
    // that same rule to a bigint epoch from an exact parse.
    {
      const badJson = { txid: K(0x99), version: 1, locktime: 0, inputs: [{ prev_txid: K(0x01), vout: 0, script_sig: "0x" }], outputs: [{ value: 1000, script_pubkey: SELLER }], app: { type: "Propose", domain: DOMAIN, payload_hash: "0x" + "0".repeat(64), uri: "x", expires_epoch: 9007199254740992 } };
      await ok("[S-B4] a non-safe-integer expires_epoch offer is REFUSED (fail-closed)", async () => {
        const r = await preverifyOffer({ light: mockLight(badJson, "0x" + "0".repeat(64)), client: mockClient, offerId: K(0x99) });
        return r.ok === false;
      });
    }
    // The v1.3 open CSD offer ban (anchors in [V13 31100, V17 34000)): the resolver rejects an untaken CSD-priced
    // offer there, so a fill pays for nothing. The taker-bound offer at the same height is admitted.
    const H13 = 33000;
    const open13 = proposeTx(SELLER_KEY, { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } }, 14);
    await ok("[admission] an open CSD-priced offer mined under the v1.3 ban is REFUSED (the resolver rejects it)", async () => {
      const r = await preverifyOffer({ light: mockLight(open13.json, open13.phash, H13), client: mockClient, offerId: open13.id });
      return r.ok === false && r.trust === "verified" && r.blockHeight === H13 && /v1\.3: CSD-priced offers must be taker-bound/.test(r.reason ?? "");
    });
    const bound13 = proposeTx(SELLER_KEY, { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER }, taker: ATTACKER }, 15);
    await ok("[admission honest] the taker-bound offer at the same height verifies", async () => {
      const r = await preverifyOffer({ light: mockLight(bound13.json, bound13.phash, H13), client: mockClient, offerId: bound13.id });
      return r.ok === true && r.trust === "verified" && r.seller === SELLER;
    });
  }
  await ok("[deflated feeBps] a served feeBps=0 (proven 150) is REFUSED", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, feeBps: 0 }) });
    return r.ok === false && /terms don't match the offer's on-chain record/.test(r.reason ?? "");
  });
  await ok("[spurious min] a min added to a whole-fill offer is REFUSED", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, min: "1" }) });
    return r.ok === false && /terms/.test(r.reason ?? "");
  });
  await ok("[give shortchange via preverifyOffer] a served give.amount lie is REFUSED (proves the 3-arg give flip is wired in)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, give: { ticker: "AAA", amount: "999999999" } }) });
    return r.ok === false && /terms don't match the offer's on-chain record/.test(r.reason ?? "");
  });

  // B7b sums seam (W3/M1): a WHOLE fill of this non-partial CSD offer returns the PROVEN CSD output plan.
  await ok("[sums] passing `pay` returns the proven outputPlan (single-sourced fillOutputPlan)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id }), pay: "500000000" });
    return r.ok === true && Array.isArray(r.outputPlan) && r.outputPlan.length > 0 && r.outputPlan.some((o) => o.to === SELLER) && r.outputPlan.every((o) => typeof o.value === "bigint");
  });
  // The amounts themselves, against fixed numbers: at H=40,000 the fee is 150 bps of 500,000,000 (7,500,000 to the
  // treasury) and an untaken offer at or above V17 earns the maker rebate of 25,000,000 + 50 bps (27,500,000), which
  // merges into the seller's leg because payto is the seller.
  await ok("[sums amounts] the whole-fill plan at H=40,000 is seller 527,500,000 then treasury 7,500,000", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id }), pay: "500000000" });
    const legs = (r.outputPlan ?? []).map((o) => `${o.to}:${o.value.toString()}`);
    return r.ok === true && legs.length === 2 && legs[0] === `${SELLER}:527500000` && legs[1] === "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016:7500000";
  });
  await ok("[sums honest] plannedOutputs equal to the proven plan is ACCEPTED (no false refusal)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id }), pay: "500000000" });
    const planned = Object.fromEntries((r.outputPlan ?? []).map((o) => [o.to, o.value.toString()]));
    const r2 = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id }), pay: "500000000", plannedOutputs: planned });
    return r2.ok === true && r2.planBound === true && Object.keys(planned).length > 0;
  });
  await ok("[W3 overpay] a planned leg above the proven plan is REFUSED (N26 smuggle / overpay class)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id }), pay: "500000000" });
    const planned = Object.fromEntries((r.outputPlan ?? []).map((o) => [o.to, o.value.toString()]));
    planned[SELLER] = (BigInt(planned[SELLER] ?? "0") + 100000n).toString();   // overpay the recipient leg
    const r2 = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id }), pay: "500000000", plannedOutputs: planned });
    return r2.ok === false && /proven fill outputs/.test(r2.reason ?? "");
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
  await ok("[author = csd-crypto authorOf] only the funding output's owner, signing this Propose, is the author; any other body fails SOFT", async () => {
    const withSig = (scriptSig: string) => ({ ...tx.json, inputs: [{ ...tx.json.inputs[0]!, script_sig: scriptSig }] });
    const signedBy = (key: string) => { const { sig64, pub33 } = signDigest(sighash(rpcTxToTx(tx.json)), key); return buildScriptSig(sig64, pub33); };
    const verdict = async (json: object, client: { tx(id: string): Promise<unknown> } = mockClient) => {
      const r = await preverifyOffer({ light: mockLight(json, tx.phash), client, offerId: tx.id });
      return r.ok === false && r.transient === true && /prove the offer's on-chain author/.test(r.reason ?? "") ? "soft" : r.ok ? `ok:${r.seller}` : `refused:${r.reason}`;
    };
    const srcId = String(tx.json.inputs[0]!.prev_txid).toLowerCase();
    const forgedSrc = { async tx() { return { ok: true, tx: { ...prevoutOf.get(srcId)!, outputs: [{ value: 5_000_000_000, script_pubkey: ATTACKER }] } }; } };
    const got = [
      await verdict(withSig(signedBy(SELLER_KEY))),     // honest: the owner's signature, the production call shape
      await verdict(withSig(signedBy(ATTACKER_KEY))),   // another key's valid signature: the txid does not commit it
      await verdict(withSig("0x")),                     // unsigned
      await verdict(withSig("0x" + "ab".repeat(99))),   // not a signature
      await verdict(withSig(signedBy(ATTACKER_KEY)), forgedSrc),   // re-signed, and a source body paying that key whose txid is not the outpoint
    ];
    return got[0] === `ok:${SELLER}` && got.slice(1).every((v) => v === "soft");
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
  // The payee of a payto-less record is the proven author, never the served want.payto: a resolver serving
  // another address there must not reach the plan.
  await ok("[payto-less, served payto lie] a served want.payto = ATTACKER is REFUSED and no plan leg pays ATTACKER", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, want: { value: "500000000", payto: ATTACKER } }), pay: "500000000" });
    return r.ok === false && /payment recipient/.test(r.reason ?? "") && r.payto === SELLER && !(r.outputPlan ?? []).some((o) => o.to === ATTACKER);
  });
  await ok("[payto-less, honest] the resolver's own default (want.payto = the author) verifies and the plan pays the author", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id }), pay: "500000000" });
    return r.ok === true && r.payto === SELLER && (r.outputPlan ?? []).some((o) => o.to === SELLER);
  });
}

console.log("\nP75-5 fill-surface guards:");

// MF-06: a token-priced offer's served price is bound to the merkle-bound record (cairnx-core bindOfferTerms' want leg)
{
  const rec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5", payto: SELLER } };
  const tx = proposeTx(SELLER_KEY, rec, 3);
  const servedTok = (want: object) => ({ id: tx.id, seller: SELLER, feeBps: 150, height: H, give: { ticker: "AAA", amount: "10" }, want });
  await ok("[MF-06 happy] an honestly served token want (ticker+amount+payto) still verifies", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedTok({ ticker: "BBB", amount: "5", payto: SELLER }) });
    return r.ok === true && r.trust === "verified";
  });
  await ok("[MF-06] a served want.amount bait-and-switch on a token-priced offer is REFUSED", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedTok({ ticker: "BBB", amount: "5000000", payto: SELLER }) });
    return r.ok === false && /want's type or token price/.test(r.reason ?? "");
  });
  await ok("[MF-06] a served want.ticker swap on a token-priced offer is REFUSED", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedTok({ ticker: "SCAM", amount: "5", payto: SELLER }) });
    return r.ok === false && /want's type or token price/.test(r.reason ?? "");
  });
}

// MF-07: settlement-domain bind + no asserted liveness
{
  const rec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } };
  const wrong = proposeTx(SELLER_KEY, rec, 4, "board:v1");
  await ok("[MF-07] a Propose from a non-cairnx:v1 settlement domain is REFUSED by the admission check", async () => {
    const r = await preverifyOffer({ light: mockLight(wrong.json, wrong.phash), client: mockClient, offerId: wrong.id });
    return r.ok === false && r.trust === "verified" && /not a cairnx:v1 Propose \(domain "board:v1"\)/.test(r.reason ?? "");
  });
  const tx = proposeTx(SELLER_KEY, rec, 5);
  await ok("[MF-07 happy] the cairnx:v1 domain still verifies (zero false-refuse)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id });
    return r.ok === true;
  });
  await ok("[MF-07] a served non-open status is refused (no asserted liveness)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, status: "cancelled" }), pay: "500000000" });
    return r.ok === false && /serves this offer as cancelled, not open/.test(r.reason ?? "") && r.sized === false;
  });
  // The resolver's own word that an offer is dead refuses whether or not `pay` is given.
  for (const status of ["filled", "cancelled", "expired"]) {
    await ok(`[served ${status}, no pay] refused with the served status named (was ok:true)`, async () => {
      const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, status }) });
      return r.ok === false && r.trust === "verified" && new RegExp(`serves this offer as ${status}, not open`).test(r.reason ?? "");
    });
  }
  await ok("[served open, no pay] the two-argument call on an open offer still verifies", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, status: "open" }) });
    return r.ok === true && r.sized === undefined;
  });
  await ok("[MF-07 happy] a served status:\"open\" sizes normally (real resolver shape)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, status: "open" }), pay: "500000000" });
    return r.ok === true && Array.isArray(r.outputPlan);
  });
}

// MF-08: the sizer valve. The fixture is deliberately HONEST everywhere except `pay`, so the catch is
// the ONLY possible source of ok:false and a silently-swallowing catch fails the assertion (fail-open).
{
  const rec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } };
  const tx = proposeTx(SELLER_KEY, rec, 6);
  await ok("[MF-08] a sizer throw REFUSES with sumsMismatch (honest served offer, garbage pay)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id }), pay: "1.5" });
    return r.ok === false && /couldn't size the fill/.test(r.reason ?? "");
  });
  const rec2 = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000" } };
  const tx2 = proposeTx(SELLER_KEY, rec2, 7);
  await ok("[MF-08 happy] a payto-less offer + pay now sizes (plan pays the proven author; was a TypeError escape)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx2.json, tx2.phash), client: mockClient, offerId: tx2.id, servedOffer: servedFor({ id: tx2.id }), pay: "500000000" });
    return r.ok === true && Array.isArray(r.outputPlan) && r.outputPlan!.some((o) => o.to === SELLER);
  });
}

// MF-09: absence fails closed, naming the field
{
  const rec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } };
  const tx = proposeTx(SELLER_KEY, rec, 8);
  await ok("[MF-09] a served offer MISSING want.payto is REFUSED naming the field (was a silent skip)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, want: { value: "500000000" } }) });
    return r.ok === false && /missing want\.payto/.test(r.reason ?? "");
  });
  await ok("[MF-09] a served offer MISSING seller is REFUSED naming the field", async () => {
    const served = servedFor({ id: tx.id }) as { seller?: unknown }; delete served.seller;
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: served });
    return r.ok === false && /missing seller/.test(r.reason ?? "");
  });
  await ok("[MF-09 happy] the full served object still verifies (exact resolver shape)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id }) });
    return r.ok === true;
  });
  await ok("[MF-09 happy] NO servedOffer still verifies (the optional param stays optional)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id });
    return r.ok === true;
  });
}

// A9: no outputPlan for an offer whose liveness nobody stated. W15: plannedOutputs that could not be bound say
// so (planBound:false + planReason) instead of returning a bare ok:true.
{
  const rec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } };
  const tx = proposeTx(SELLER_KEY, rec, 10);
  const planned = { [SELLER]: "500000000" };
  await ok("[A9] pay without a served offer: no outputPlan, and planReason says liveness was not stated", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, pay: "500000000" });
    return r.ok === true && r.outputPlan === undefined && /no served offer status/.test(r.planReason ?? "");
  });
  await ok("[A9] a served offer without `status` is not sized either", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, status: undefined }), pay: "500000000" });
    return r.ok === true && r.outputPlan === undefined && /no served offer status/.test(r.planReason ?? "");
  });
  await ok("[A9 honest] the resolver's offer (status open) is sized and the plan binds", async () => {
    const call = (plannedOutputs?: Record<string, bigint>) => preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id }), pay: "500000000", plannedOutputs });
    const sized = await call();
    const r = await call(Object.fromEntries((sized.outputPlan ?? []).map((o) => [o.to, o.value])));
    return r.ok === true && Array.isArray(r.outputPlan) && r.outputPlan.length > 0 && r.planBound === true && r.planReason === undefined;
  });
  await ok("[W15] plannedOutputs without pay: planBound false with a reason (was a silent ok:true)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id }), plannedOutputs: planned });
    return r.ok === true && r.planBound === false && /no `pay`/.test(r.planReason ?? "");
  });
  const tokRec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5", payto: SELLER } };
  const tok = proposeTx(SELLER_KEY, tokRec, 11);
  // A token fill moves no CSD, so a positive planned CSD leg on a proven token want is refused (it was planBound:false).
  await ok("[token, CSD legs] plannedOutputs with a CSD leg on a token-priced offer are REFUSED, with or without pay", async () => {
    const r = await preverifyOffer({ light: mockLight(tok.json, tok.phash), client: mockClient, offerId: tok.id, pay: "1", plannedOutputs: planned });
    const r2 = await preverifyOffer({ light: mockLight(tok.json, tok.phash), client: mockClient, offerId: tok.id, plannedOutputs: planned });
    return [r, r2].every((x) => x.ok === false && x.trust === "verified" && /token-priced, so a fill moves no CSD/.test(x.reason ?? "") && x.planBound === false);
  });
  await ok("[token, CSD legs] a fractional planned amount on a token-priced offer is REFUSED as invalid", async () => {
    const r = await preverifyOffer({ light: mockLight(tok.json, tok.phash), client: mockClient, offerId: tok.id, plannedOutputs: { [SELLER]: "1.5" } });
    return r.ok === false && /invalid plannedOutputs/.test(r.reason ?? "");
  });
  await ok("[token, honest] a token-priced offer with no CSD legs planned (empty or zero) still verifies, planBound false", async () => {
    const r = await preverifyOffer({ light: mockLight(tok.json, tok.phash), client: mockClient, offerId: tok.id, pay: "1", plannedOutputs: {} });
    const r2 = await preverifyOffer({ light: mockLight(tok.json, tok.phash), client: mockClient, offerId: tok.id, pay: "1", plannedOutputs: { [SELLER]: "0" } });
    return [r, r2].every((x) => x.ok === true && x.planBound === false && x.sized === false && /token-priced/.test(x.planReason ?? ""));
  });
  const partRec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER }, min: "100000000" };
  const part = proposeTx(SELLER_KEY, partRec, 12);
  await ok("[W15] plannedOutputs on a partially fillable offer: planBound false, reason names the partial", async () => {
    const r = await preverifyOffer({ light: mockLight(part.json, part.phash), client: mockClient, offerId: part.id, pay: "100000000", plannedOutputs: planned });
    return r.ok === true && r.planBound === false && /partially fillable/.test(r.planReason ?? "");
  });
  await ok("[W15 honest] no plannedOutputs and no pay: neither planBound nor planReason is set (the 2-arg shape is unchanged)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id }) });
    return r.ok === true && r.planBound === undefined && r.planReason === undefined && r.outputPlan === undefined;
  });
}

// A partially fillable offer: no plan is sized (its progress is resolver-served), but a pay that cairnx-core's
// previewFill over the served progress says delivers nothing is refused. Give 10 AAA for 500,000,000, min 100,000,000.
{
  const partRec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER }, min: "100000000" };
  const part = proposeTx(SELLER_KEY, partRec, 18);
  const served = (extra: object = {}) => servedFor({ id: part.id, min: "100000000", paid: "0", delivered: "0", ...extra });
  const check = (pay: string, so: unknown = served()) => preverifyOffer({ light: mockLight(part.json, part.phash), client: mockClient, offerId: part.id, servedOffer: so, pay });
  await ok("[partial below min] pay 1 against the served progress is REFUSED (was ok:true, trust verified)", async () => {
    const r = await check("1");
    return r.ok === false && r.trust === "verified" && /would not deliver against the offer's served progress \(below-min\)/.test(r.reason ?? "") && r.sized === false;
  });
  await ok("[partial honest] pay at the minimum verifies, unsized (sized false, the partial reason)", async () => {
    const r = await check("100000000");
    return r.ok === true && r.sized === false && r.outputPlan === undefined && /partially fillable/.test(r.planReason ?? "");
  });
  await ok("[partial honest] the tail below the minimum (served paid 450,000,000) verifies", async () => {
    const r = await check("50000000", served({ paid: "450000000", delivered: "9" }));
    return r.ok === true && r.sized === false;
  });
  await ok("[partial] a served offer without paid/delivered refuses nothing new (unsized as before)", async () => {
    const r = await check("1", servedFor({ id: part.id, min: "100000000" }));
    return r.ok === true && r.sized === false;
  });
  const tinyRec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER }, min: "1" };
  const tiny = proposeTx(SELLER_KEY, tinyRec, 19);
  await ok("[partial zero delivery] a pay the pro-rata floor delivers 0 tokens for is REFUSED", async () => {
    const r = await preverifyOffer({ light: mockLight(tiny.json, tiny.phash), client: mockClient, offerId: tiny.id, servedOffer: servedFor({ id: tiny.id, min: "1", paid: "0", delivered: "0" }), pay: "10000000" });
    return r.ok === false && /served progress \(zero-delivery\)/.test(r.reason ?? "");
  });
}

// `me` and `tip` run cairnx-core's fillEndorsement over the served state after the binds. H is 40,000 (V17 and above:
// an open CSD offer is filled only by the holder of a live claim); tips at or above V28 (60,000) route a live
// reservation's fill to its fclaim txid.
{
  const BUYER = addrFromPriv(K(0x33)).toLowerCase();
  const FCLAIM = "0x" + "fc".repeat(32);
  const boundRec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER }, taker: ATTACKER };
  const bound = proposeTx(SELLER_KEY, boundRec, 20);
  const openRec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } };
  const open = proposeTx(SELLER_KEY, openRec, 21);
  const tokRec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5", payto: SELLER } };
  const tok = proposeTx(SELLER_KEY, tokRec, 22);
  const run = (tx: { json: object; phash: string; id: string }, extra: object) =>
    preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, pay: "500000000", ...extra });

  await ok("[taker] an offer bound to another taker is REFUSED with me and tip (was ok:true with an outputPlan)", async () => {
    const r = await run(bound, { servedOffer: servedFor({ id: bound.id, taker: ATTACKER }), me: BUYER, tip: H + 10 });
    return r.ok === false && r.trust === "verified" && /CairnX would refuse this fill \(taker-bound offer - not bound to you\)/.test(r.reason ?? "") && r.endorsement?.verdict === "refused";
  });
  await ok("[taker honest] the bound taker itself is endorsed, the plan sized and the target the offer id", async () => {
    const r = await run(bound, { servedOffer: servedFor({ id: bound.id, taker: ATTACKER }), me: ATTACKER, tip: H + 10 });
    return r.ok === true && r.endorsement?.verdict === "endorsed" && r.fillTarget === bound.id && r.sized === true && Array.isArray(r.outputPlan);
  });
  await ok("[taker, no inputs] without me and tip nothing new is refused (ok:true, no endorsement)", async () => {
    const r = await run(bound, { servedOffer: servedFor({ id: bound.id, taker: ATTACKER }) });
    return r.ok === true && r.endorsement === undefined && r.fillTarget === undefined;
  });
  await ok("[open lane] an open CSD offer with no live claim by me is REFUSED (claim it first)", async () => {
    const r = await run(open, { servedOffer: servedFor({ id: open.id }), me: BUYER, tip: H + 10 });
    return r.ok === false && /claim it first/.test(r.reason ?? "");
  });
  await ok("[open lane honest] my live claim is endorsed", async () => {
    const r = await run(open, { servedOffer: servedFor({ id: open.id, claimedBy: BUYER, claimUntilHeight: H + 30 }), me: BUYER, tip: H + 10 });
    return r.ok === true && r.endorsement?.verdict === "endorsed" && r.fillTarget === open.id;
  });
  const held = servedFor({ id: open.id, claimedBy: BUYER, claimUntilHeight: 60_150, claimTxid: FCLAIM });
  await ok("[V28 reservation] a fill attesting the offer id while my reservation routes it is REFUSED; the target is the fclaim", async () => {
    const r = await run(open, { servedOffer: held, me: BUYER, tip: 60_100, fillTargetId: open.id });
    return r.ok === false && /fclaim txid, not the offer id/.test(r.reason ?? "") && r.fillTarget === FCLAIM;
  });
  await ok("[V28 reservation honest] attesting the fclaim txid is endorsed", async () => {
    const r = await run(open, { servedOffer: held, me: BUYER, tip: 60_100, fillTargetId: FCLAIM });
    return r.ok === true && r.endorsement?.verdict === "endorsed" && r.fillTarget === FCLAIM;
  });
  await ok("[token] a token-priced want is not-endorsable, never a refusal", async () => {
    const r = await run(tok, { servedOffer: { id: tok.id, seller: SELLER, feeBps: 150, height: H, status: "open", give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5", payto: SELLER } }, pay: "5", me: BUYER, tip: H + 10 });
    return r.ok === true && r.endorsement?.verdict === "not-endorsable";
  });
  await ok("[inputs] me without tip, or me and tip without pay, is refused as invalid before any chain read", async () => {
    let reads = 0;
    const light = { async verifyTxInclusion() { reads++; return mockLight(open.json, open.phash).verifyTxInclusion(""); } };
    const a = await preverifyOffer({ light, client: mockClient, offerId: open.id, pay: "500000000", me: BUYER });
    const b = await preverifyOffer({ light, client: mockClient, offerId: open.id, me: BUYER, tip: H });
    return [a, b].every((x) => x.ok === false && /invalid fill inputs/.test(x.reason ?? "")) && reads === 0;
  });
  await ok("[inputs] me and tip without the served offer are refused (the endorsement needs its status and claim)", async () => {
    const r = await run(open, { me: BUYER, tip: H + 10 });
    return r.ok === false && /needs the resolver's offer object/.test(r.reason ?? "");
  });
}

// The proven expiry rides on every verified result: expiresAt is the first height CairnX treats the offer as expired.
{
  const rec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } };
  const far = proposeTx(SELLER_KEY, rec, 23);
  const edge = proposeTx(SELLER_KEY, rec, 24, DOMAIN, epochOf(H));
  await ok("[expiry] an offer at 40,000 with expires_epoch 9,000,000 expires at 45,060 (the v2.1 cap); one expiring in its own epoch at 40,020", async () => {
    const r = await preverifyOffer({ light: mockLight(far.json, far.phash), client: mockClient, offerId: far.id });
    const r2 = await preverifyOffer({ light: mockLight(edge.json, edge.phash), client: mockClient, offerId: edge.id });
    return r.ok === true && r.expiresEpoch === 9_000_000 && r.expiresAt === 45_060 && r2.ok === true && r2.expiresEpoch === 1333 && r2.expiresAt === 40_020;
  });
}

// MF-11: the facade reaches the whole preverifyOffer surface, offline via the stubbed SPV seam.
// (This also makes this file's line-2 header comment about Cairn.verifyOfferForFill TRUE at last.)
{
  const rec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } };
  const tx = proposeTx(SELLER_KEY, rec, 9);
  const cairn = new Cairn({ baseUrls: { cairn: "https://example.test" } });
  // The facade reads the light client's cached tip (baseHeight + chain) for the near-tip reorg re-check; an
  // empty cache starting at H means the inclusion came from a fresh sync, so no re-check request is made.
  (cairn as unknown as { seededSpvLight: unknown }).seededSpvLight = async () => ({ ...mockLight(tx.json, tx.phash), baseHeight: H, chain: [] });
  (cairn as unknown as { chain: unknown }).chain = { client: mockClient };
  await ok("[MF-11] verifyOfferForFill(id, served, { pay }) reaches the proven outputPlan seam", async () => {
    const r = await cairn.verifyOfferForFill(tx.id, servedFor({ id: tx.id }), { pay: "500000000" });
    return r.ok === true && Array.isArray(r.outputPlan) && r.outputPlan!.some((o) => o.to === SELLER);
  });
  await ok("[MF-11] plannedOutputs flow through and bind (a smuggled extra leg is REFUSED)", async () => {
    const r = await cairn.verifyOfferForFill(tx.id, servedFor({ id: tx.id }), { pay: "500000000", plannedOutputs: { [SELLER]: "1", ["0x" + "ee".repeat(20)]: "42" } });
    return r.ok === false && /proven fill outputs/.test(r.reason ?? "");
  });
  await ok("[MF-11 happy] the 2-arg call shape is unchanged (ok:true, no outputPlan)", async () => {
    const r = await cairn.verifyOfferForFill(tx.id, servedFor({ id: tx.id }));
    return r.ok === true && r.outputPlan === undefined;
  });
  const buyer = addrFromPriv(K(0x33)).toLowerCase();
  await ok("[facade, me and tip] the open CSD offer without my claim is refused through verifyOfferForFill", async () => {
    const r = await cairn.verifyOfferForFill(tx.id, servedFor({ id: tx.id }), { pay: "500000000", me: buyer, tip: H + 10 });
    return r.ok === false && /claim it first/.test(r.reason ?? "") && r.endorsement?.verdict === "refused";
  });
  await ok("[facade, me and tip honest] with my live claim it is endorsed and the plan sized", async () => {
    const r = await cairn.verifyOfferForFill(tx.id, servedFor({ id: tx.id, claimedBy: buyer, claimUntilHeight: H + 30 }), { pay: "500000000", me: buyer, tip: H + 10 });
    return r.ok === true && r.endorsement?.verdict === "endorsed" && r.fillTarget === tx.id && r.sized === true;
  });
}

// The real facade over the real SPV header fixture (checkpoint 115,403; rows 115358..115437), so the light
// client, the near-tip re-check and csd-light's own below-base answer all run for real.
{
  type Row = { height: number; header: Record<string, unknown>; hash: string };
  const ROWS = (JSON.parse(readFileSync(new URL("./fixtures/spv-headers-115358-80.json", import.meta.url), "utf8")) as { headers: Row[] }).headers;
  const BASE = ROWS[0]!.height, TIP = ROWS[ROWS.length - 1]!.height;
  const mkCairn = (seen: string[], txHeight?: number) => new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const m = url.match(/\/api\/headers\/(\d+)\/(\d+)$/);
    const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (m) return j({ ok: true, headers: ROWS.slice(Number(m[1]) - BASE, Number(m[1]) - BASE + Number(m[2])) });
    if (/\/api\/rpc\/tip$/.test(url)) return j({ height: TIP });
    if (/\/api\/rpc\/tx\//.test(url) && txHeight !== undefined) return j({ ok: true, height: txHeight });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch });
  const rec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } };

  // F2 paired honest path: a near-tip offer whose cached header passes the re-check still verifies (ok, trust
  // verified) through verifyOfferForFill. The inclusion is real-shaped (a real signed Propose with its tx body
  // and committed payload hash); it stands in for csd-light's merkle fold, which no fixture header can satisfy.
  {
    const near = TIP - 2;
    const tx = proposeTx(SELLER_KEY, rec, 13);
    const seen: string[] = [];
    const cairn = mkCairn(seen);
    const lc = await (cairn as unknown as { seededSpvLight(): Promise<{ verifyTxInclusion: unknown }> }).seededSpvLight();
    lc.verifyTxInclusion = async () => ({ trustLevel: "verified-inclusion", included: true, blockHeight: near, confirmations: 3, tx: tx.json, appPayloadHash: tx.phash });
    (cairn as unknown as { chain: unknown }).chain = { client: mockClient };
    // The production call shape: the resolver's offer object (served at the offer's height) plus pay and the
    // planned outputs, which a dApp sizes locally (here with the pure preverifyOffer over the same inclusion).
    const served = servedFor({ id: tx.id, height: near });
    const sized = await preverifyOffer({ light: mockLight(tx.json, tx.phash, near), client: mockClient, offerId: tx.id, servedOffer: served, pay: "500000000" });
    const plannedOutputs = Object.fromEntries((sized.outputPlan ?? []).map((o) => [o.to, o.value]));
    await ok("[F2 honest] a near-tip offer that passes the re-check returns ok:true, trust verified, a bound outputPlan", async () => {
      const r = await cairn.verifyOfferForFill(tx.id, served, { pay: "500000000", plannedOutputs });
      return r.ok === true && r.trust === "verified" && r.blockHeight === near && r.seller === SELLER
        && Array.isArray(r.outputPlan) && r.outputPlan.length > 0 && r.planBound === true;
    });
    await ok("[F2] that verification ran the near-tip re-check (one single-header request) without a reseed", () =>
      seen.filter((u) => u.endsWith(`/api/headers/${near}/1`)).length === 1 && seen.filter((u) => u.endsWith(`/api/headers/${BASE}/46`)).length === 1);
  }

  // The containing height comes from the node's /tx answer, which csd-light passes through untyped. One served as a
  // JSON string still gets the near-tip re-check; one that is not an integer is not a verified height at all.
  {
    const near = TIP - 2;
    const tx = proposeTx(SELLER_KEY, rec, 17);
    const seen: string[] = [];
    const cairn = mkCairn(seen);
    const lc = await (cairn as unknown as { seededSpvLight(): Promise<{ verifyTxInclusion: unknown }> }).seededSpvLight();
    const answer = (blockHeight: unknown) => async () => ({ trustLevel: "verified-inclusion", included: true, blockHeight, confirmations: 3, tx: tx.json, appPayloadHash: tx.phash });
    (cairn as unknown as { chain: unknown }).chain = { client: mockClient };
    lc.verifyTxInclusion = answer(String(near));
    const r = await cairn.verifyOfferForFill(tx.id);
    await ok("[string height] a containing height served as a string runs the near-tip re-check and verifies at that height", () =>
      seen.filter((u) => u.endsWith(`/api/headers/${near}/1`)).length === 1 && r.ok === true && r.blockHeight === near);
    lc.verifyTxInclusion = answer(`${near}.5`);
    const r2 = await cairn.verifyOfferForFill(tx.id);
    await ok("[string height] a containing height that is not an integer is not verified", () =>
      r2.ok === false && r2.trust === "unverified" && /not a block height/.test(r2.reason ?? ""));
  }

  // F4: an offer mined below the synced base is permanent for this checkpoint, so it is not transient, and the
  // reason names config.spvCheckpoint. csd-light's real verifyTxInclusion produces the below-base answer here.
  {
    const seen: string[] = [];
    const r = await mkCairn(seen, 110_000).verifyOfferForFill("0x" + "cd".repeat(32));
    await ok("[F4] an offer below the synced base is not transient", () => r.ok === false && r.transient !== true && r.trust === "unverified");
    await ok("[F4] the reason says it is below the checkpoint window and names config.spvCheckpoint", () => /below this SDK's SPV checkpoint window \(base 115358\)/.test(r.reason ?? "") && /config\.spvCheckpoint/.test(r.reason ?? ""));
    const r2 = await mkCairn([], undefined).verifyOfferForFill("0x" + "cd".repeat(32));
    await ok("[F4 honest] a tx the node does not place in a block (mempool/unknown) stays transient", () => r2.ok === false && r2.transient === true);
  }

  // An offer more than 256 blocks above the cached SPV tip: csd-light's own on-demand sync stops at that gap, so the
  // fill handle advances the cache to the node tip. The real facade and the real LightClient run; headers above the
  // fixture are synthetic, so only their PoW check is replaced (the fixture's real headers keep it).
  {
    const GAP = 300, OFFER_H = TIP + GAP, NEAR_H = TIP + 100;
    const tx = proposeTx(SELLER_KEY, rec, 16);
    // An offer within csd-light's own 256-block on-demand sync of the cached tip.
    const near = proposeTx(SELLER_KEY, rec, 25);
    const synth = new Map<number, Row>();
    let prevHash = ROWS[ROWS.length - 1]!.hash;
    for (let h = TIP + 1; h <= OFFER_H; h++) {
      const hash = "0x" + h.toString(16).padStart(64, "0");
      const merkle = h === OFFER_H ? merkleRoot([tx.id]) : h === NEAR_H ? merkleRoot([near.id]) : "0x" + "00".repeat(32);
      synth.set(h, { height: h, header: { version: 1, prev: prevHash, merkle, time: 1791507021 + (h - TIP) * 120, bits: 453910147, nonce: 0 }, hash });
      prevHash = hash;
    }
    const rowAt = (h: number) => (h <= TIP ? ROWS[h - BASE] : synth.get(h));
    // prewarmTip: what /api/rpc/tip answers during the seed (null = a 502, the failed pre-warm).
    const facade = async (prewarmTip: number | null) => {
      const seen: string[] = [];
      let tipNow: number | null = prewarmTip;
      // Delays every /api/headers answer after the seed, so two concurrent checks' syncs overlap.
      let headerDelayMs = 0;
      const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
      const cairn = new Cairn({ baseUrls: { cairn: "https://stub.test" }, fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        seen.push(url);
        const m = url.match(/\/api\/headers\/(\d+)\/(\d+)$/);
        if (m) {
          if (headerDelayMs) await new Promise((r) => setTimeout(r, headerDelayMs));
          const rows = Array.from({ length: Number(m[2]) }, (_, i) => rowAt(Number(m[1]) + i));
          return rows.every(Boolean) ? j({ ok: true, headers: rows }) : j({ error: "beyond tip" }, 503);
        }
        if (/\/api\/rpc\/tip$/.test(url)) return tipNow === null ? new Response("bad gateway", { status: 502 }) : j({ height: tipNow });
        const t = url.match(/\/api\/rpc\/tx\/(0x[0-9a-f]{64})$/);
        if (t && t[1] === tx.id) return j({ ok: true, height: OFFER_H, tx: tx.json });
        if (t && prevoutOf.has(t[1]!)) return j({ ok: true, tx: prevoutOf.get(t[1]!) });
        if (url.endsWith(`/api/rpc/block/height/${OFFER_H}`)) return j({ ok: true, txs: [tx.json] });
        if (t && t[1] === near.id) return j({ ok: true, height: NEAR_H, tx: near.json });
        if (url.endsWith(`/api/rpc/block/height/${NEAR_H}`)) return j({ ok: true, txs: [near.json] });
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch });
      const lc = await (cairn as unknown as { seededSpvLight(): Promise<Record<string, unknown>> }).seededSpvLight();
      const realVerify = (lc.verifyOne as (...a: unknown[]) => unknown).bind(lc);
      lc.verifyOne = (height: number, header: unknown, window: unknown, parent: { chainwork: bigint } | undefined, claimedHash: string) =>
        height <= TIP ? realVerify(height, header, window, parent, claimedHash) : { height, hash: claimedHash, header, chainwork: (parent?.chainwork ?? 0n) + 1n };
      const cachedTip = (lc.baseHeight as number) + (lc.chain as unknown[]).length - 1;
      tipNow = OFFER_H;
      return { cairn, seen, cachedTip, slowHeaders: (ms: number) => { headerDelayMs = ms; } };
    };
    const headersFrom = (seen: string[], above: number) => seen.filter((u) => { const m = u.match(/\/api\/headers\/(\d+)\//); return !!m && Number(m[1]) > above; });
    const tipReads = (seen: string[]) => seen.filter((u) => /\/api\/rpc\/tip$/.test(u)).length;

    for (const [label, prewarm] of [["a long-lived instance", TIP], ["a failed pre-warm", null]] as const) {
      const { cairn, seen, cachedTip } = await facade(prewarm);
      const before = seen.length;
      const r = await cairn.verifyOfferForFill(tx.id);
      const during = seen.slice(before);
      await ok(`[gap>256, ${label}] cached tip ${cachedTip}, offer at ${OFFER_H}: ok, trust verified, at the offer's height`, () =>
        OFFER_H - cachedTip > 256 && r.ok === true && r.trust === "verified" && r.blockHeight === OFFER_H && r.seller === SELLER);
      await ok(`[gap>256, ${label}] the fill path read the node tip once and synced headers above the cached tip`, () =>
        tipReads(during) === 1 && headersFrom(during, cachedTip).length >= 1);
      if (prewarm === TIP) {
        const again = seen.length;
        const r2 = await cairn.verifyOfferForFill(tx.id);
        const second = seen.slice(again);
        await ok("[gap>256 honest] the next check on the now-fresh cache reads no tip and syncs nothing (the near-tip re-check only)", () =>
          r2.ok === true && tipReads(second) === 0 && headersFrom(second, OFFER_H - 1).length === 1 && headersFrom(second, OFFER_H - 1)[0]!.endsWith(`/api/headers/${OFFER_H}/1`));
      }
    }

    // Concurrent checks on one stale instance share the header sync. csd-light ingests strictly in order, so a second
    // sync overlapping the first failed "out-of-order ingest", which read as a reorg and reseeded from the checkpoint.
    const seedReads = (seen: string[]) => seen.filter((u) => u.endsWith(`/api/headers/${BASE}/46`)).length;
    // Every height above the cached tip is fetched at most once.
    const fetchedOnce = (seen: string[], above: number) => {
      const n = new Map<number, number>();
      for (const u of headersFrom(seen, above)) {
        const [, from, count] = u.match(/\/api\/headers\/(\d+)\/(\d+)$/)!.map(Number);
        for (let h = from!; h < from! + count!; h++) n.set(h, (n.get(h) ?? 0) + 1);
      }
      return [...n.values()].every((c) => c === 1);
    };
    {
      const { cairn, seen, cachedTip, slowHeaders } = await facade(TIP);
      slowHeaders(20);
      const before = seen.length;
      const rs = await Promise.all([cairn.verifyOfferForFill(tx.id), cairn.verifyOfferForFill(tx.id)]);
      const during = seen.slice(before);
      await ok(`[gap>256, concurrent] two checks of an offer ${GAP} blocks above the cached tip both verify`, () =>
        rs.every((r) => r.ok === true && r.trust === "verified" && r.blockHeight === OFFER_H));
      await ok("[gap>256, concurrent] one header sync for both and no checkpoint reseed", () =>
        headersFrom(during, cachedTip).length === 1 && fetchedOnce(during, cachedTip) && seedReads(during) === 0);
    }
    {
      // One offer inside csd-light's on-demand gap (it syncs itself) and one past it (the fill handle syncs).
      const { cairn, seen, cachedTip, slowHeaders } = await facade(TIP);
      slowHeaders(20);
      const before = seen.length;
      const [rn, rf] = await Promise.all([cairn.verifyOfferForFill(near.id), cairn.verifyOfferForFill(tx.id)]);
      const during = seen.slice(before);
      await ok("[concurrent, mixed gaps] offers 100 and 300 blocks above the cached tip both verify", () =>
        rn.ok === true && rn.blockHeight === NEAR_H && rf.ok === true && rf.blockHeight === OFFER_H);
      await ok("[concurrent, mixed gaps] csd-light's own sync and the fill handle's never fetch a height twice; no reseed", () =>
        fetchedOnce(during, cachedTip) && seedReads(during) === 0);
    }
  }
}

console.log(`\nfillverify (F13): ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
