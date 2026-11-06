// F13 - a diligent-dApp OFFER PRE-VERIFY, to call BEFORE building a `fillOffer` payment's `outputs`.
//
// The `fillOffer` provider call is RESOLVER-TRUSTED at the SDK layer: this kit does NOT SPV-verify the
// `outputs` a dApp hands the wallet, so a lying resolver can redirect the payment. This helper is the diligent
// dApp's on-chain corroboration: it merkle-proves the offer's Propose into the PoW-verified header chain (from
// the pinned SPV checkpoint), binds the record to its on-chain commitment, derives the payment recipient +
// seller from the offer's on-chain AUTHOR (the funding input's prevout owner, txid-committed, NOT the malleable
// scriptSig), and, if given the resolver-SERVED offer, binds its fee/rebate/partial terms + recipients to the
// proven ones. Trust-labeled; fail-CLOSED on a positive mismatch, a partial served offer (an absent served
// want.payto/seller refuses, naming the field) or a fill the served state says would move CSD for nothing;
// transient on an unreachable or lagging chain view; final, naming the anchor, below the SPV checkpoint.
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
import { authorOf } from "@inversealtruism/csd-crypto";
import {
  parseRecord, feeBpsAt, bindOfferTerms, provenOfferTerms, provenOfferRefusal, fillOutputPlan, isTokenWant,
  fillEndorsement, fillIsSafe, requiredFillOutputs, previewFill, offerExpiryHeightOf, offerFillTooLate, FILL_TIP_MARGIN,
  fillTargetId as fillTargetOf, type MintedProvenOfferTerms, type OfferState,
} from "@inversealtruism/cairnx-core";
import type { InclusionResult } from "@inversealtruism/csd-light";

// B4b (REBIND W2): the terms interface + producer are SINGLE-SOURCED in the pinned cairnx-core
// (provenOfferTerms, verifyfill.ts) - this file used to carry a local interface copy and one of the
// four hand-built producers the audit flagged. Corpus-equivalence over every real on-chain offer
// (55) + synthetic envelope variants proved the old copy byte-identical to canonical before the
// swap (test/proven-terms-corpus.test.ts pins it). Re-exported as a POINTER for existing importers.
export type { ProvenOfferTerms, MintedProvenOfferTerms } from "@inversealtruism/cairnx-core";

/** The trust-labeled verdict. `ok:false` + `transient:true` = a retryable chain-catching-up soft-fail (NOT a
 *  proven mismatch). `payto`/`seller`/`terms` are populated whenever they could be merkle-derived. */
export interface OfferFillCheck {
  /** `true`: the offer record is proven and no check refused. Without `me` and `tip` it does not say the offer
   *  is fillable by you now (it may be bound to another taker, held by someone else's live claim or
   *  reservation, or too close to its expiry), and with `sized: false` it does not size your fill. */
  ok: boolean;
  /** "verified" = merkle-proven inclusion + on-chain author; "proof-consistent" = a proof that folds but the
   *  header could not be PoW-verified (indexer-trusted); "unverified" = could not prove. */
  trust: "verified" | "proof-consistent" | "unverified";
  reason?: string;
  transient?: boolean;
  payto?: string;
  seller?: string;
  /** Minted by cairnx-core's `provenOfferTerms`, so it can be passed back to `bindOfferTerms` without the opt-out. */
  terms?: MintedProvenOfferTerms;
  blockHeight?: number;
  /** The proven Propose's `expires_epoch`. */
  expiresEpoch?: number;
  /** The first block height at which CairnX treats the offer as expired (cairnx-core `offerExpiryHeightOf` over the
   *  proven expiry and anchor). A fill must be mined below it; with `me` and `tip` a fill with less than
   *  cairnx-core's `FILL_TIP_MARGIN` blocks of cushion is refused, without them compare it with your tip. */
  expiresAt?: number;
  /** B7b (REBIND W3/M1): the PROVEN CSD outputs to build for `pay` (a WHOLE fill of a non-partial offer),
   *  sized from the merkle-proven offer by the single-sourced `fillOutputPlan`. Present only when `pay` was
   *  passed, the served offer carried a `status`, the offer could be sized, and neither the served status, the
   *  endorsement nor the expiry cushion refuses the fill (other refusals keep the proven plan; branch on `ok`).
   *  Build EXACTLY these; never the resolver-served outputs a lying resolver could redirect. A partial
   *  (min-bearing) offer is left unsized (its running paid/delivered is not provable at this corroboration layer;
   *  the wallet's fill-SPV is the payment-grade sizer). Liveness is never proven here: the plan is sized only
   *  for the status the resolver served, so an offer with no served status gets no plan. */
  outputPlan?: { to: string; value: bigint }[];
  /** Present when `pay` was passed: `true` when `outputPlan` holds the proven outputs for this pay, `false` when
   *  the fill could not be sized from proven data (`planReason` says why). `ok: true` with `sized: false` is a
   *  verdict on the offer record, not on this fill. */
  sized?: boolean;
  /** Present when `me` and `tip` were passed: cairnx-core's `fillEndorsement` over the served state after the
   *  binds. "refused" answers `ok: false`; "not-endorsable" (a token-priced want) is not a refusal. */
  endorsement?: { verdict: "endorsed" | "refused" | "not-endorsable"; reason: string };
  /** Present with `endorsement`: the proposal id the fill's attest must target at `tip` (cairnx-core
   *  `fillTargetId`: the offer id, or the fclaim txid while a live reservation routes the offer). */
  fillTarget?: string;
  /** Present when `plannedOutputs` was passed: `true` when they were bound to `outputPlan` (a mismatch
   *  refuses with `ok: false`), `false` when there was no proven plan to bind them to (`planReason` says why).
   *  `ok: true` with `planBound: false` means your planned outputs were NOT checked. */
  planBound?: boolean;
  /** Why no output plan was sized (set whenever `outputPlan` is absent after `pay` or `plannedOutputs` was passed). */
  planReason?: string;
}

const ADDR = /^0x[0-9a-f]{40}$/;
// csd-light's verifyTxInclusion reason for a tx below the light client's synced base (the start of the
// checkpoint seed window). That holds for as long as the checkpoint does, so it is not a transient failure.
const BELOW_BASE = /^tx below the synced base \((\d+)\)/;
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

// The offer's author: csd-crypto `authorOf` over the proven Propose and the funded output's scriptPubkey. That
// scriptPubkey is read from the source tx only after its recomputed txid equals the outpoint (the txid commits it).
// The Propose's scriptSig is not merkle-committed, so a body served without the owner's signature has no author.
// Returns the lowercased 0x-addr, or null on any miss, mismatch, coinbase or unsigned body.
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
  return authorOf(provenTx, src.outputs?.[Number(in0.vout)]?.scriptPubkey);
}

/** The inputs that judge a fill rather than the offer. `me` and `tip` run cairnx-core's `fillEndorsement`. */
interface FillInputs {
  pay?: bigint | string | number;
  plannedOutputs?: Record<string, bigint | string | number>;
  me?: string;
  tip?: number;
  fillTargetId?: string;
}

const has = <T>(v: T): v is NonNullable<T> => v !== undefined && v !== null;

// Validated at the boundary, before any chain read: `me`, `tip` and `pay` go together.
function fillInputs(o: FillInputs): FillInputs | string {
  const base = { pay: o.pay, plannedOutputs: o.plannedOutputs };
  if (!has(o.me) && !has(o.tip) && !has(o.fillTargetId)) return base;
  const me = typeof o.me === "string" ? o.me.toLowerCase() : "";
  const target = has(o.fillTargetId) ? String(o.fillTargetId).toLowerCase() : undefined;
  if (!ADDR.test(me) || !Number.isSafeInteger(o.tip) || (o.tip as number) < 0 || (target !== undefined && !HASH.test(target)) || !has(o.pay))
    return "invalid fill inputs: pass me (your 0x address), tip (the chain tip height) and pay together; fillTargetId, when given, is a 0x txid";
  return { ...base, me, tip: o.tip, fillTargetId: target };
}

/** What the resolver serves about an offer since it was mined: liveness, a partial offer's progress and the
 *  current claim or reservation. None of it is provable at this layer. */
interface ServedRunning { status?: unknown; paid?: unknown; delivered?: unknown; claimedBy?: unknown; claimUntilHeight?: unknown; claimTxid?: unknown }

interface FillJudgement {
  refusal?: string;
  outputPlan?: { to: string; value: bigint }[];
  planReason?: string;
  planBound: boolean;
  endorsement?: { verdict: "endorsed" | "refused" | "not-endorsable"; reason: string };
  fillTarget?: string;
}

// Judges a fill of the proven offer. The state is the proven record (terms, height, author, payto, expiry) plus the
// served running state; every rule applied to it is cairnx-core's. A whole fill is sized from proven terms; a
// partial offer is only checked for deliverability, from its served progress; `me` and `tip` add fillEndorsement and
// offerFillTooLate.
function judgeFill(
  rec: Parameters<typeof provenOfferTerms>[0],
  proven: { id: string; seller: string; payto: string; terms: MintedProvenOfferTerms; expiresEpoch: number; expiresAt: number },
  served: ServedRunning | undefined,
  f: FillInputs,
): FillJudgement {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const status = served?.status;
  const terms = proven.terms;
  const state = {
    id: proven.id, seller: proven.seller, give: rec.give, want: { ...rec.want, payto: proven.payto }, taker: rec.taker,
    bid: rec.bid, min: rec.min, status, expiresEpoch: proven.expiresEpoch, height: terms.height, feeBps: terms.feeBps,
    paid: str(served?.paid), delivered: str(served?.delivered), claimedBy: str(served?.claimedBy),
    claimUntilHeight: typeof served?.claimUntilHeight === "number" ? served.claimUntilHeight : undefined, claimTxid: str(served?.claimTxid),
  } as OfferState;
  const j: FillJudgement = { planBound: false };
  const err = (e: unknown) => (e as Error)?.message ?? String(e);
  const token = isTokenWant(rec.want);
  const progress = state.paid !== undefined && state.delivered !== undefined;
  if (typeof status === "string" && status !== "open")
    j.refusal = `the resolver serves this offer as ${status}, not open - refusing (CairnX does not apply a fill of it)`;
  if (token && has(f.plannedOutputs)) {
    const legs = bindPlannedSums(f.plannedOutputs, []);
    if (legs) j.refusal ??= `the offer is token-priced, so a fill moves no CSD: ${legs}`;
  }
  if (!has(f.pay)) j.planReason = "no `pay` was given, so no output plan was sized";
  else if (j.refusal) j.planReason = "the fill is refused, so no output plan was sized";
  else if (token) j.planReason = "the offer is token-priced: the payment is a token transfer, not CSD outputs";
  else if (rec.min !== undefined) {
    j.planReason = "the offer is partially fillable: its running paid/delivered is not provable here (the wallet's fill-SPV sizes it)";
    // The served progress is the trust the status already takes; it can only refuse a pay it says delivers nothing.
    if (typeof status === "string" && progress) {
      try {
        const p = previewFill(state, f.pay);
        if (!p.deliverable) j.refusal = `this pay would not deliver against the offer's served progress (${p.reason}) - refusing (the CSD would be lost)`;
      } catch (e) { j.refusal = `couldn't size the fill against the offer (${err(e)}) - refusing`; }
    }
  } else if (typeof status !== "string") j.planReason = "no served offer status: liveness is not provable here, so no output plan was sized (pass the resolver's offer object)";
  else {
    // A sizer throw over the caller's `pay` refuses: escaping would skip the served-terms binds, swallowing would
    // return ok:true with the sums bind skipped.
    try {
      const plan = fillOutputPlan(state, f.pay);
      if (plan.kind === "csd-outputs") {
        j.outputPlan = plan.outputs;
        if (has(f.plannedOutputs)) {
          j.refusal = bindPlannedSums(f.plannedOutputs, plan.outputs);
          j.planBound = true;
        }
      } else if (plan.kind === "undeliverable") {
        j.refusal = `this pay would not deliver against the proven offer (${plan.reason}) - refusing (the CSD would be lost)`;
      } else {
        j.planReason = `the proven offer settles without CSD outputs (${plan.kind})`;
      }
    } catch (e) {
      j.refusal = `couldn't size the fill against the proven offer (${err(e)}) - refusing rather than sizing from served fields`;
    }
  }
  if (f.me !== undefined && f.tip !== undefined && has(f.pay)) {
    // A refused fill keeps no plan to build, as a status refusal sizes none.
    const unplan = () => { delete j.outputPlan; j.planBound = false; j.planReason = "the fill is refused, so no output plan was sized"; };
    if (offerFillTooLate(proven.expiresAt, f.tip)) {
      j.refusal ??= `the offer's last live block ${proven.expiresAt - 1} leaves less than the ${FILL_TIP_MARGIN}-block cushion above tip ${f.tip}, so the fill is too close to the offer's expiry - do not sign it`;
      unplan();
    }
    if (typeof status !== "string") j.refusal ??= "the fill endorsement needs the resolver's offer object (its status, claim and progress) - pass servedOffer";
    else if (rec.min !== undefined && !progress) j.refusal ??= "the served offer is missing paid or delivered (a partial offer's progress) - pass the resolver's full offer object";
    else {
      try {
        const e = fillEndorsement(state, f.me, f.pay, f.tip, f.fillTargetId !== undefined ? { fillTargetId: f.fillTargetId } : undefined);
        j.endorsement = { verdict: e.verdict, reason: e.reason };
        j.fillTarget = fillTargetOf(state, f.tip);
        if (e.verdict === "refused") { j.refusal ??= `CairnX would refuse this fill (${e.reason}) - do not sign it`; unplan(); }
      } catch (e) { j.refusal ??= `couldn't judge the fill against the offer (${err(e)}) - refusing`; unplan(); }
    }
  }
  return j;
}

/**
 * Pre-verify an offer on-chain before building a `fillOffer` payment. `light` is a PoW-verifying light client
 * (its `verifyTxInclusion` surfaces the merkle-proven tx + committed appPayloadHash); `client` reads source txs
 * for the prevout-owner author bind. Pass `servedOffer` (the resolver's offer object) to also bind its
 * payto/seller/terms to the proven values. The FULL object is required: a served offer missing want.payto
 * or seller is refused (P75-5). A token-priced offer's served want.ticker/want.amount are bound verbatim to
 * the record. A served status other than open refuses. See the module header for the trust posture.
 */
export async function preverifyOffer(opts: {
  light: { verifyTxInclusion(txidHex: string): Promise<InclusionResult> };
  client: { tx(id: string): Promise<unknown> };
  offerId: string;
  servedOffer?: unknown;
  /** B7b (REBIND W3/M1): the CSD base units you intend to pay. When given, the result carries `outputPlan`
   *  (the PROVEN CSD outputs to build for a WHOLE fill of a non-partial offer, sized by the single-sourced
   *  `fillOutputPlan`) and, if you also pass `plannedOutputs`, binds them EXACTLY to that proven plan.
   *  A partial (min-bearing) offer is left unsized here (`sized: false`); with the served offer, a pay its
   *  served progress says delivers nothing (below the minimum) is refused. The wallet's fill-SPV sizes it. */
  pay?: bigint | string | number;
  /** B7b: your planned per-address CSD sums (the outputs you WILL build), bound both ways to `outputPlan`.
   *  Requires `pay`. A missing/low leg is a doomed underpay; an extra/high leg is a W3 overpay or an N26
   *  smuggled output - both refused. On a token-priced offer any positive CSD leg is refused. */
  plannedOutputs?: Record<string, bigint | string | number>;
  /** Your address, the one that signs the fill. With `tip` (and `pay`), the result carries cairnx-core's
   *  `fillEndorsement` over the served state: a taker bound to another address, an open CSD offer you hold no
   *  live claim or reservation on, or an attest target the offer's routing rejects is refused, and so is a fill
   *  that cairnx-core's `offerFillTooLate` says is too close to the offer's expiry. */
  me?: string;
  /** The chain tip height you sign at (for example `(await cairn.chain.tip()).height`). Goes with `me`. */
  tip?: number;
  /** The proposal id your attest will target: the offer id, or the fclaim txid while your reservation routes it. */
  fillTargetId?: string;
}): Promise<OfferFillCheck> {
  const id = String(opts.offerId).toLowerCase();
  if (!HASH.test(id)) return { ok: false, trust: "unverified", reason: "invalid offer id" };
  const fill = fillInputs(opts);
  if (typeof fill === "string") return { ok: false, trust: "unverified", reason: fill };

  let incl: InclusionResult;
  try { incl = await opts.light.verifyTxInclusion(id); }
  catch (e) { return { ok: false, trust: "unverified", transient: true, reason: `couldn't reach the chain to verify the offer (${(e as Error)?.message ?? e})` }; }
  // The PoW light client yields "verified-inclusion" (merkle-proven against a PoW-verified header) or a fail
  // reason ("rpc-trusted"/not-included for a below-checkpoint, mempool, or unreachable tx). Only the former is
  // trustworthy for a payment corroboration; anything else is a soft "chain catching up" (never a hard decline).
  if (!incl.included || incl.trustLevel !== "verified-inclusion" || !incl.tx || !incl.appPayloadHash) {
    const below = BELOW_BASE.exec(incl.reason ?? "");
    if (below)
      return { ok: false, trust: "unverified", blockHeight: incl.blockHeight, reason: `the offer was mined below this SDK's SPV checkpoint window (base ${below[1]}), so it cannot be merkle-proven here and retrying will not change that; pass an older anchor in config.spvCheckpoint to verify it` };
    return { ok: false, trust: "unverified", transient: true, blockHeight: incl.blockHeight, reason: incl.reason ?? `offer not merkle-proven on-chain (${incl.trustLevel})` };
  }
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
  // The resolver's own creation rules over the proven Propose (the cairnx:v1 domain, a treasury payee, the expiry
  // and the gated record rules); the give's backing is chain state and is not checked here.
  const ee = (app as { expires_epoch?: unknown }).expires_epoch;
  const refusal = provenOfferRefusal(offerRec, { domain: String(app.domain), height: blockHeight, expiresEpoch: typeof ee === "bigint" ? ee : Number(ee), seller });
  if (refusal) return { ok: false, trust: "verified", blockHeight, reason: `CairnX rejects this offer (${refusal}) - a fill would move CSD for nothing` };
  const w = rec.want ?? {};
  const payto = (w.payto && ADDR.test(String(w.payto).toLowerCase())) ? String(w.payto).toLowerCase() : seller;
  // B4b: the ONE pinned producer; blockHeight is the merkle-proven inclusion height, never served.
  // Keeps the BRANDED MintedProvenOfferTerms (no widening annotation): bindOfferTerms with the give and
  // wantType legs on accepts only minted terms, so a hand-built terms object there is a compile error.
  const terms = provenOfferTerms(offerRec, blockHeight);
  // provenOfferRefusal refused an expiry that is not a safe integer, so this conversion is exact.
  const expiresEpoch = Number(ee);
  const expiresAt = offerExpiryHeightOf(expiresEpoch, blockHeight);

  const j = judgeFill(offerRec, { id, seller, payto, terms, expiresEpoch, expiresAt }, opts.servedOffer as ServedRunning | undefined, fill);
  const planFields = {
    ...(j.outputPlan ? { outputPlan: j.outputPlan } : {}),
    ...(has(opts.pay) ? { sized: j.outputPlan !== undefined } : {}),
    ...(has(opts.plannedOutputs) ? { planBound: j.planBound } : {}),
    ...(!j.outputPlan && j.planReason && (has(opts.pay) || has(opts.plannedOutputs)) ? { planReason: j.planReason } : {}),
    ...(j.endorsement ? { endorsement: j.endorsement, fillTarget: j.fillTarget } : {}),
  };
  const base = { payto, seller, terms, blockHeight, expiresEpoch, expiresAt, ...planFields };

  if (opts.servedOffer !== undefined && opts.servedOffer !== null) {
    const so = opts.servedOffer as { want?: { payto?: unknown }; seller?: unknown };
    // P75-5 MF-09: every served leg fails CLOSED, including ABSENCE. A partial served offer (a dApp
    // hand-building one) previously skipped the payto/seller bind entirely and still earned ok:true
    // trust:"verified". BREAKING REFUSAL for such callers; the reason NAMES the missing field. A
    // resolver's real offer object always carries both fields, so the hot path sees zero new declines.
    if (so?.want?.payto === undefined || so?.want?.payto === null)
      return { ok: false, trust: "verified", reason: "the served offer is missing want.payto (the payment recipient) - pass the resolver's full offer object, or omit servedOffer", ...base };
    if (String(so.want.payto).toLowerCase() !== payto)
      return { ok: false, trust: "verified", reason: "the served payment recipient doesn't match the offer's on-chain author/record", ...base };
    if (so?.seller === undefined || so?.seller === null)
      return { ok: false, trust: "verified", reason: "the served offer is missing seller (the rebate recipient) - pass the resolver's full offer object, or omit servedOffer", ...base };
    if (String(so.seller).toLowerCase() !== seller)
      return { ok: false, trust: "verified", reason: "the served seller doesn't match the offer's on-chain author (a lying resolver may be redirecting your payment)", ...base };
    // B7b: both legs on, stated explicitly (cairnx-core 0.2.0 also defaults them on): the give legs (W7
    // shortchange: give.amount inflated a millionfold passes every legacy leg) + the want leg (its type, and a
    // token want's ticker and amount, verbatim). Give is compared as VERBATIM strings, never a deep object
    // compare (resolve.ts copies the record's give verbatim and tracks delivered separately).
    if (bindOfferTerms(opts.servedOffer, terms, { give: true, wantType: true }))
      return { ok: false, trust: "verified", reason: "the served terms don't match the offer's on-chain record (fee, rebate, partial sizing, the give, or the want's type or token price - a lying resolver could mis-size, re-price or re-route the fill, redirecting or burning your payment)", ...base };
  }
  if (j.refusal) return { ok: false, trust: "verified", reason: j.refusal, ...base };
  return { ok: true, trust: "verified", ...base };
}
