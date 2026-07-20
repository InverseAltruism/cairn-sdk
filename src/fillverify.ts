// F13 - a diligent-dApp OFFER PRE-VERIFY, to call BEFORE building a `fillOffer` payment's `outputs`.
//
// The `fillOffer` provider call is RESOLVER-TRUSTED at the SDK layer: this kit does NOT SPV-verify the
// `outputs` a dApp hands the wallet, so a lying resolver can redirect the payment. This helper is the diligent
// dApp's on-chain corroboration: it merkle-proves the offer's Propose into the PoW-verified header chain (from
// the pinned SPV checkpoint), binds the record to its on-chain commitment, derives the payment recipient +
// seller from the offer's on-chain AUTHOR (the funding input's prevout owner, txid-committed, NOT the malleable
// scriptSig), and, if given the resolver-SERVED offer, binds its fee/rebate/partial terms + recipients to the
// proven ones. Trust-labeled; fail-CLOSED on a positive mismatch, fail-SOFT (transient) on an unreachable /
// lagging / below-checkpoint chain view (never a hard decline of an honest offer).
//
// It is best-effort corroboration, NOT the payment-grade boundary: the Cairn Wallet's OWN on-device fill-SPV
// (cairn-wallet 0.2.60+, which fails-closed before signing) is the payment-grade check. Use this to avoid
// building `outputs` a lying resolver would redirect, and to surface an honest trust label to the user.
//
// The term-mismatch predicate `bindOfferTerms` and `feeBpsAt` are IMPORTED from the pinned cairnx-core
// (0.1.38 exports them; Plan 70 R2 Option B) and re-exported below, so the SDK never re-declares consensus
// logic locally (the AGENTS.md invariant). They were a byte-identical local copy while the pin predated the
// exports; the copy was retired once the pin carried them.
//
// B7b (REBIND W2/W7/W3/W10/M1) FLIP: consuming the 0.1.40 cairnx-core, this file now (1) turns ON the
// opt-in `bindOfferTerms` give legs + symmetric want-type refusal (the 3-arg form over the BRANDED proven
// terms), (2) adds the OPT-IN sums seam - when the caller states `pay`, it sizes the PROVEN output plan via
// the discriminated `fillOutputPlan` and binds the caller's planned per-address sums to it - and (3)
// surfaces the discriminated `fillEndorsement` / `fillOutputPlan` successors (keeping the deprecated,
// behavior-frozen `fillIsSafe` / `requiredFillOutputs` / `previewFill` exported for existing consumers).
import { rpcTxToTx, type RpcTxJson } from "@inversealtruism/csd-client";
import { txid, payloadHash } from "@inversealtruism/csd-codec";
import {
  parseRecord, feeBpsAt, bindOfferTerms, provenOfferTerms, fillOutputPlan, isTokenWant,
  fillEndorsement, fillIsSafe, requiredFillOutputs, previewFill,
  type ProvenOfferTerms, type OfferState,
} from "@inversealtruism/cairnx-core";
import type { InclusionResult } from "@inversealtruism/csd-light";

// B4b (REBIND W2): the terms interface + producer are SINGLE-SOURCED in the pinned cairnx-core
// (provenOfferTerms, verifyfill.ts) - this file used to carry a local interface copy and one of the
// four hand-built producers the audit flagged. Corpus-equivalence over every real on-chain offer
// (55) + synthetic envelope variants proved the old copy byte-identical to canonical before the
// swap (test/proven-terms-corpus.test.ts pins it). Re-exported as a POINTER for existing importers.
export type { ProvenOfferTerms } from "@inversealtruism/cairnx-core";

/** The trust-labeled verdict. `ok:false` + `transient:true` = a retryable chain-catching-up soft-fail (NOT a
 *  proven mismatch). `payto`/`seller`/`terms` are populated whenever they could be merkle-derived. */
export interface OfferFillCheck {
  ok: boolean;
  /** "verified" = merkle-proven inclusion + on-chain author; "proof-consistent" = a proof that folds but the
   *  header could not be PoW-verified (indexer-trusted); "unverified" = could not prove. */
  trust: "verified" | "proof-consistent" | "unverified";
  reason?: string;
  transient?: boolean;
  payto?: string;
  seller?: string;
  terms?: ProvenOfferTerms;
  blockHeight?: number;
  /** B7b (REBIND W3/M1): the PROVEN CSD outputs to build for `pay` (a WHOLE fill of a non-partial offer),
   *  sized from the merkle-proven offer by the single-sourced `fillOutputPlan`. Present only when `pay` was
   *  passed and the offer could be sized. Build EXACTLY these; never the resolver-served outputs a lying
   *  resolver could redirect. A partial (min-bearing) offer is left unsized (its running paid/delivered is
   *  not provable at this corroboration layer; the wallet's fill-SPV is the payment-grade sizer). */
  outputPlan?: { to: string; value: bigint }[];
}

const ADDR = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const COINBASE = "0x" + "00".repeat(32);

// `feeBpsAt` (the treasury fee rate stamped at an offer's creation height) and `bindOfferTerms` (the
// fee/rebate/partial-sizing term-mismatch predicate, fail-closed: any divergence => the caller refuses) come
// from cairnx-core and are re-exported so the SDK's public API is unchanged while the consensus logic stays
// single-sourced. Their prior byte-identical local copies were retired when the pin (0.1.38) began exporting them.
//
// B7b (REBIND W10/M1): also surface the DISCRIMINATED fill-safety successors so a dApp uses a verdict it
// cannot fall through silently. `fillEndorsement` returns endorsed / refused / not-endorsable, where a
// TOKEN-priced want is HONEST NON-ENDORSEMENT (deliverability is the attester's token balance a pure
// predicate cannot see) - proceed with your own token-balance + proven-terms checks, NEVER treat it as a
// refusal (that hard-blocks every honest token fill, the named B7f trap). `fillOutputPlan` returns
// csd-outputs / token-settled / undeliverable so the token-settled `[]` can no longer read as "nothing to
// check". The deprecated `fillIsSafe` / `requiredFillOutputs` / `previewFill` stay exported and
// BEHAVIOR-FROZEN for existing third-party consumers (their published verdicts must not be hardened in
// place); new callers use the successors. All single-sourced from cairnx-core; the SDK re-declares nothing.
export { feeBpsAt, bindOfferTerms, fillEndorsement, fillOutputPlan, fillIsSafe, requiredFillOutputs, previewFill };
export type { FillEndorsement, FillOutputPlan, FillSafety, FillPreview } from "@inversealtruism/cairnx-core";

// B7b (REBIND W3/M1) sums-seam helper: bind the caller's PLANNED per-address CSD sums (the outputs they
// will build) to the PROVEN output plan, EXACTLY and both ways. A missing/low leg is a doomed underpay; an
// extra/high leg is the W3 overpay or a smuggled output (N26). Pure local comparison over the single-sourced
// `fillOutputPlan` result; the sizing math itself never leaves cairnx-core. Returns a mismatch reason or undefined.
function bindPlannedSums(
  planned: Record<string, bigint | string | number>,
  proven: { to: string; value: bigint }[],
): string | undefined {
  const provenMap = new Map<string, bigint>(proven.map((o) => [o.to.toLowerCase(), o.value]));
  const plannedMap = new Map<string, bigint>();
  try {
    for (const [a, v] of Object.entries(planned)) { const k = String(a).toLowerCase(); plannedMap.set(k, (plannedMap.get(k) ?? 0n) + BigInt(v)); }
  } catch { return "invalid plannedOutputs (amounts must be base-unit integers)"; }
  for (const k of new Set([...provenMap.keys(), ...plannedMap.keys()])) {
    if ((provenMap.get(k) ?? 0n) !== (plannedMap.get(k) ?? 0n))
      return `your planned payment doesn't match the proven fill outputs (${k}: planned ${(plannedMap.get(k) ?? 0n).toString()}, proven ${(provenMap.get(k) ?? 0n).toString()}) - refusing (an overpay past the proven amount is unrecoverable, and a missing or low leg is a doomed underpay)`;
  }
  return undefined;
}

// The on-chain author of an offer Propose = the funding input's prevout OWNER (only that owner's key can spend
// the coin it funds, and the owner is txid-committed). We fetch the source tx, RECOMPUTE its txid (so a forged
// body whose recomputed id still matches the outpoint is impossible), and read the funded output's scriptPubkey.
// This is txid-bound (range-INDEPENDENT), NOT scriptSig-recovered (the merkle root does not commit the scriptSig,
// so a strip/re-sign would else redirect it). Returns the lowercased 0x-addr, or null on any miss/mismatch/coinbase.
async function provenAuthor(
  client: { tx(id: string): Promise<unknown> },
  provenTx: ReturnType<typeof rpcTxToTx>,
): Promise<string | null> {
  const in0 = provenTx.inputs?.[0];
  if (!in0 || (String(in0.prevTxid).toLowerCase() === COINBASE && Number(in0.vout) === 0xffffffff)) return null;
  let info: unknown;
  try { info = await client.tx(String(in0.prevTxid)); } catch { return null; }
  const body = ((info as { tx?: RpcTxJson })?.tx ?? info) as RpcTxJson | undefined;
  if (!body || !Array.isArray(body.outputs) || !Array.isArray(body.inputs)) return null;
  let src: ReturnType<typeof rpcTxToTx>;
  try { src = rpcTxToTx(body); } catch { return null; }
  if (String(txid(src)).toLowerCase() !== String(in0.prevTxid).toLowerCase()) return null;   // forged source body
  const out = src.outputs?.[Number(in0.vout)];
  const spk = out?.scriptPubkey ? String(out.scriptPubkey).toLowerCase() : null;
  return spk && ADDR.test(spk) ? spk : null;
}

/**
 * Pre-verify an offer on-chain before building a `fillOffer` payment. `light` is a PoW-verifying light client
 * (its `verifyTxInclusion` surfaces the merkle-proven tx + committed appPayloadHash); `client` reads source txs
 * for the prevout-owner author bind. Pass `servedOffer` (the resolver's offer object) to also bind its
 * payto/seller/terms to the proven values. See the module header for the trust posture.
 */
export async function preverifyOffer(opts: {
  light: { verifyTxInclusion(txidHex: string): Promise<InclusionResult> };
  client: { tx(id: string): Promise<unknown> };
  offerId: string;
  servedOffer?: unknown;
  /** B7b (REBIND W3/M1): the CSD base units you intend to pay. When given, the result carries `outputPlan`
   *  (the PROVEN CSD outputs to build for a WHOLE fill of a non-partial offer, sized by the single-sourced
   *  `fillOutputPlan`) and, if you also pass `plannedOutputs`, binds them EXACTLY to that proven plan.
   *  A partial (min-bearing) offer is left unsized here; the wallet's fill-SPV is its payment-grade sizer. */
  pay?: bigint | string | number;
  /** B7b: your planned per-address CSD sums (the outputs you WILL build), bound both ways to `outputPlan`.
   *  Requires `pay`. A missing/low leg is a doomed underpay; an extra/high leg is a W3 overpay or an N26
   *  smuggled output - both refused. */
  plannedOutputs?: Record<string, bigint | string | number>;
}): Promise<OfferFillCheck> {
  const id = String(opts.offerId).toLowerCase();
  if (!HASH.test(id)) return { ok: false, trust: "unverified", reason: "invalid offer id" };

  let incl: InclusionResult;
  try { incl = await opts.light.verifyTxInclusion(id); }
  catch (e) { return { ok: false, trust: "unverified", transient: true, reason: `couldn't reach the chain to verify the offer (${(e as Error)?.message ?? e})` }; }
  // The PoW light client yields "verified-inclusion" (merkle-proven against a PoW-verified header) or a fail
  // reason ("rpc-trusted"/not-included for a below-checkpoint, mempool, or unreachable tx). Only the former is
  // trustworthy for a payment corroboration; anything else is a soft "chain catching up" (never a hard decline).
  if (!incl.included || incl.trustLevel !== "verified-inclusion" || !incl.tx || !incl.appPayloadHash)
    return { ok: false, trust: "unverified", transient: true, blockHeight: incl.blockHeight, reason: incl.reason ?? `offer not merkle-proven on-chain (${incl.trustLevel})` };
  const blockHeight = Number(incl.blockHeight);

  let provenTx: ReturnType<typeof rpcTxToTx>, provenId: string;
  try { provenTx = rpcTxToTx(incl.tx); provenId = txid(provenTx); }
  catch { return { ok: false, trust: "unverified", reason: "the on-chain offer tx couldn't be re-derived" }; }
  if (String(provenId).toLowerCase() !== id) return { ok: false, trust: "unverified", reason: "the merkle-proven tx doesn't match the offer id" };
  const app = incl.tx.app;
  if (!app || app.type !== "Propose") return { ok: false, trust: "unverified", reason: "the offer tx is not a Propose" };

  let rec: { t?: string; want?: { payto?: string; value?: string }; taker?: string; bid?: string; min?: string } | null;
  try { rec = parseRecord(app.uri, incl.appPayloadHash) as typeof rec; } catch { rec = null; }
  if (!rec || rec.t !== "offer") return { ok: false, trust: "unverified", reason: "the offer record doesn't bind to its on-chain commitment" };
  if (String(payloadHash(rec)).toLowerCase() !== String(incl.appPayloadHash).toLowerCase())
    return { ok: false, trust: "unverified", reason: "the offer record doesn't match the on-chain (merkle-proven) commitment" };

  const seller = await provenAuthor(opts.client, provenTx);
  if (!seller) return { ok: false, trust: "verified", transient: true, blockHeight, reason: "couldn't prove the offer's on-chain author yet; the chain view may be catching up, try again" };
  // The cast is sound: rec passed the t==="offer" payload-hash-bound guard above; parseRecord's widened
  // partial type simply lacks the OfferRecord brand the pinned signatures demand.
  const offerRec = rec as Parameters<typeof provenOfferTerms>[0];
  const w = rec.want ?? {};
  const payto = (w.payto && ADDR.test(String(w.payto).toLowerCase())) ? String(w.payto).toLowerCase() : seller;
  // B4b: the ONE pinned producer; blockHeight is the merkle-proven inclusion height, never served.
  // B7b keeps the BRANDED MintedProvenOfferTerms (no widening annotation) so the 3-arg bindOfferTerms
  // opt-in below type-checks - a hand-built terms object opting into the new legs is a compile error.
  const terms = provenOfferTerms(offerRec, blockHeight);

  // B7b (REBIND W3/M1) OPT-IN sums seam: when the caller states the `pay` it intends, size the PROVEN CSD
  // output plan from the merkle-proven offer via the discriminated `fillOutputPlan` (the M1 successor to
  // requiredFillOutputs), so a diligent dApp builds the PROVEN outputs, never the served ones a lying
  // resolver could redirect. Scoped to a WHOLE fill of a non-partial (min-less) offer: the running
  // paid/delivered of a PARTIALLY-fillable offer is not merkle-provable at this corroboration layer (that
  // is the wallet's fill-SPV, cairn-wallet 0.2.60+), so a partial is LEFT UNSIZED rather than false-refused.
  // The offer state fed to the sizer is built ENTIRELY from proven fields (record + merkle-proven height +
  // prevout-bound seller), never a resolver-served object.
  let outputPlan: { to: string; value: bigint }[] | undefined;
  let sumsMismatch: string | undefined;
  if (opts.pay !== undefined && opts.pay !== null && !isTokenWant(offerRec.want) && offerRec.min === undefined) {
    const provenState = {
      id, seller, give: offerRec.give, want: offerRec.want, taker: offerRec.taker, bid: offerRec.bid,
      status: "open", expiresEpoch: 0, height: blockHeight, feeBps: terms.feeBps,
    } as OfferState;
    const plan = fillOutputPlan(provenState, opts.pay);
    if (plan.kind === "csd-outputs") {
      outputPlan = plan.outputs;
      if (opts.plannedOutputs !== undefined && opts.plannedOutputs !== null)
        sumsMismatch = bindPlannedSums(opts.plannedOutputs, plan.outputs);
    } else if (plan.kind === "undeliverable") {
      sumsMismatch = `this pay would not deliver against the proven offer (${plan.reason}) - refusing (the CSD would be lost)`;
    }
  }
  const base = { payto, seller, terms, blockHeight, ...(outputPlan ? { outputPlan } : {}) };

  if (opts.servedOffer !== undefined && opts.servedOffer !== null) {
    const so = opts.servedOffer as { want?: { payto?: unknown }; seller?: unknown };
    const servedPayto = so?.want?.payto !== undefined && so?.want?.payto !== null ? String(so.want.payto).toLowerCase() : "";
    if (servedPayto && servedPayto !== payto)
      return { ok: false, trust: "verified", reason: "the served payment recipient doesn't match the offer's on-chain author/record", ...base };
    if (so?.seller !== undefined && so?.seller !== null && String(so.seller).toLowerCase() !== seller)
      return { ok: false, trust: "verified", reason: "the served seller doesn't match the offer's on-chain author (a lying resolver may be redirecting your payment)", ...base };
    // B7b: the 3-arg OPT-IN turns on the give legs (W7 shortchange: give.amount inflated a millionfold
    // passes every legacy leg) + the symmetric want-type refusal (proven-token served as CSD, which only
    // the wallet caught one-sidedly before). Give is compared as VERBATIM strings, never a deep object
    // compare (resolve.ts copies the record's give verbatim and tracks delivered separately).
    if (bindOfferTerms(opts.servedOffer, terms, { give: true, wantType: true }))
      return { ok: false, trust: "verified", reason: "the served terms don't match the offer's on-chain record (fee, rebate, partial sizing, the give, or the want type - a lying resolver could mis-size or re-route the fill, redirecting or burning your payment)", ...base };
  }
  if (sumsMismatch) return { ok: false, trust: "verified", reason: sumsMismatch, ...base };
  return { ok: true, trust: "verified", ...base };
}
