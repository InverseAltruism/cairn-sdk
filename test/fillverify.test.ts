// F13 offer pre-verify tests — the diligent-dApp on-chain corroboration `preverifyOffer` (and the
// `Cairn.verifyOfferForFill` method that wraps it). A mock PoW light client returns a canned verified-inclusion
// for a REAL signed offer Propose (real txid, real record commitment); a mock tx reader returns the funding
// source tx so the prevout-owner author bind resolves. We assert: an honest offer verifies (payto/seller/terms
// derived); each served-field lie (payto / seller / feeBps / spurious min) is REFUSED; and a below-checkpoint /
// unprovable-author view fails SOFT (transient), never a hard decline. Pure unit test, no network.
import { addrFromPriv, signDigest, buildScriptSig } from "@inversealtruism/csd-crypto";
import { provenOfferTerms } from "@inversealtruism/cairnx-core";
import { txid, sighash, canonicalJson, payloadHash, rpcTxToTx } from "../src/chain.js";
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
  const stripped = { version: 1, inputs: [{ prevTxid: prev, vout: 0, scriptSig: "0x" }], outputs: [{ value: 1000, scriptPubkey: a }], locktime: 0, app: { type: "Propose", domain, payloadHash: phash, uri, expiresEpoch } };
  const { sig64, pub33 } = signDigest(sighash(stripped), priv);
  const scriptSig = buildScriptSig(sig64, pub33);
  const id = txid(stripped);
  const json = { txid: id, version: 1, locktime: 0, inputs: [{ prev_txid: prev, vout: 0, script_sig: scriptSig }], outputs: [{ value: 1000, script_pubkey: a }], app: { type: "Propose", domain, payload_hash: phash, uri, expires_epoch: expiresEpoch } };
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

// B7b: the 3-arg OPT-IN give legs (W7) + symmetric want-type refusal, over BRANDED proven terms.
await ok("bindOfferTerms 3-arg: an honest give+type match -> no mismatch", () => {
  const t = provenOfferTerms({ t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } } as never, H);
  return bindOfferTerms(servedFor(), t, { give: true, wantType: true }) === false;
});
await ok("[W7 give shortchange] a served give.amount inflated a millionfold is REFUSED (only the opt-in give leg catches it)", () => {
  const t = provenOfferTerms({ t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } } as never, H);
  return bindOfferTerms(servedFor({ give: { ticker: "AAA", amount: "10000000000" } }), t, { give: true, wantType: true }) === true
      && bindOfferTerms(servedFor({ give: { ticker: "AAA", amount: "10000000000" } }), t) === false; // 2-arg is byte-identical to pre-B6: does NOT catch the give
});
await ok("[want-type flip] a proven TOKEN offer served as CSD is REFUSED by the wantType leg (the reverse the legacy value leg misses)", () => {
  const t = provenOfferTerms({ t: "offer", give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5", payto: SELLER } } as never, H);
  // served as CSD (want.value, no ticker): the legacy value leg does NOT fire (a proven token has no value)
  return bindOfferTerms(servedFor(), t, { give: true, wantType: true }) === true
      && bindOfferTerms(servedFor(), t) === false;
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
    // non-safe-integer expiry (>= 2^53): the codec's u64 refuses to even RE-DERIVE such a tx
    // (txid throws), so preverifyOffer fails closed at the re-derivation step - never ok:true. The
    // resolver also rejects a non-safe-integer expiresEpoch outright (resolve.ts), and the expiry
    // check in fillverify carries a matching !Number.isSafeInteger refusal as defense-in-depth.
    {
      const badJson = { txid: K(0x99), version: 1, locktime: 0, inputs: [{ prev_txid: K(0x01), vout: 0, script_sig: "0x" }], outputs: [{ value: 1000, script_pubkey: SELLER }], app: { type: "Propose", domain: DOMAIN, payload_hash: "0x" + "0".repeat(64), uri: "x", expires_epoch: 9007199254740992 } };
      await ok("[S-B4] a non-safe-integer expires_epoch offer is REFUSED (fail-closed)", async () => {
        const r = await preverifyOffer({ light: mockLight(badJson, "0x" + "0".repeat(64)), client: mockClient, offerId: K(0x99) });
        return r.ok === false;
      });
    }
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
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, pay: "500000000" });
    return r.ok === true && Array.isArray(r.outputPlan) && r.outputPlan.length > 0 && r.outputPlan.some((o) => o.to === SELLER) && r.outputPlan.every((o) => typeof o.value === "bigint");
  });
  await ok("[sums honest] plannedOutputs equal to the proven plan is ACCEPTED (no false refusal)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, pay: "500000000" });
    const planned = Object.fromEntries((r.outputPlan ?? []).map((o) => [o.to, o.value.toString()]));
    const r2 = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, pay: "500000000", plannedOutputs: planned });
    return r2.ok === true;
  });
  await ok("[W3 overpay] a planned leg above the proven plan is REFUSED (N26 smuggle / overpay class)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, pay: "500000000" });
    const planned = Object.fromEntries((r.outputPlan ?? []).map((o) => [o.to, o.value.toString()]));
    planned[SELLER] = (BigInt(planned[SELLER] ?? "0") + 100000n).toString();   // overpay the recipient leg
    const r2 = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, pay: "500000000", plannedOutputs: planned });
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

console.log("\nP75-5 fill-surface guards:");

// MF-06: a token-priced offer's served price is bound to the merkle-bound record
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
    return r.ok === false && /want ticker\/amount/.test(r.reason ?? "");
  });
  await ok("[MF-06] a served want.ticker swap on a token-priced offer is REFUSED", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedTok({ ticker: "SCAM", amount: "5", payto: SELLER }) });
    return r.ok === false && /want ticker\/amount/.test(r.reason ?? "");
  });
}

// MF-07: settlement-domain bind + no asserted liveness
{
  const rec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } };
  const wrong = proposeTx(SELLER_KEY, rec, 4, "board:v1");
  await ok("[MF-07] a Propose from a non-cairnx:v1 settlement domain is REFUSED (unverified)", async () => {
    const r = await preverifyOffer({ light: mockLight(wrong.json, wrong.phash), client: mockClient, offerId: wrong.id });
    return r.ok === false && r.trust === "unverified" && /settlement domain/.test(r.reason ?? "");
  });
  const tx = proposeTx(SELLER_KEY, rec, 5);
  await ok("[MF-07 happy] the cairnx:v1 domain still verifies (zero false-refuse)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id });
    return r.ok === true;
  });
  await ok("[MF-07] a served non-open status is refused by the sizer's own status gate (no asserted liveness)", async () => {
    const r = await preverifyOffer({ light: mockLight(tx.json, tx.phash), client: mockClient, offerId: tx.id, servedOffer: servedFor({ id: tx.id, status: "cancelled" }), pay: "500000000" });
    return r.ok === false && /not-open/.test(r.reason ?? "");
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
    const r = await preverifyOffer({ light: mockLight(tx2.json, tx2.phash), client: mockClient, offerId: tx2.id, pay: "500000000" });
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

// MF-11: the facade reaches the whole preverifyOffer surface, offline via the stubbed SPV seam.
// (This also makes this file's line-2 header comment about Cairn.verifyOfferForFill TRUE at last.)
{
  const rec = { v: 1, t: "offer", give: { ticker: "AAA", amount: "10" }, want: { value: "500000000", payto: SELLER } };
  const tx = proposeTx(SELLER_KEY, rec, 9);
  const cairn = new Cairn({ baseUrls: { cairn: "https://example.test" } });
  (cairn as unknown as { seededSpvLight: unknown }).seededSpvLight = async () => mockLight(tx.json, tx.phash);
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
}

console.log(`\nfillverify (F13): ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
