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
import { rpcTxToTx, type RpcTxJson } from "@inversealtruism/csd-client";
import { txid, payloadHash } from "@inversealtruism/csd-codec";
import { parseRecord, feeBpsAt, bindOfferTerms } from "@inversealtruism/cairnx-core";
import type { InclusionResult } from "@inversealtruism/csd-light";

/** The fee/rebate-relevant fields of an offer, derived from the MERKLE-PROVEN offer (never a served object). */
export interface ProvenOfferTerms { height: number; feeBps: number; value?: string; taker?: string; bid?: string; min?: string }

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
}

const ADDR = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const COINBASE = "0x" + "00".repeat(32);

// `feeBpsAt` (the treasury fee rate stamped at an offer's creation height) and `bindOfferTerms` (the
// fee/rebate/partial-sizing term-mismatch predicate, fail-closed: any divergence => the caller refuses) come
// from cairnx-core and are re-exported so the SDK's public API is unchanged while the consensus logic stays
// single-sourced. Their prior byte-identical local copies were retired when the pin (0.1.38) began exporting them.
export { feeBpsAt, bindOfferTerms };

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
  const w = rec.want ?? {};
  const payto = (w.payto && ADDR.test(String(w.payto).toLowerCase())) ? String(w.payto).toLowerCase() : seller;
  const terms: ProvenOfferTerms = {
    height: blockHeight,
    feeBps: feeBpsAt(blockHeight),
    value: w.value !== undefined ? String(w.value) : undefined,
    taker: rec.taker !== undefined ? String(rec.taker).toLowerCase() : undefined,
    bid: rec.bid !== undefined ? String(rec.bid).toLowerCase() : undefined,
    min: rec.min !== undefined ? String(rec.min) : undefined,
  };
  const base = { payto, seller, terms, blockHeight };

  if (opts.servedOffer !== undefined && opts.servedOffer !== null) {
    const so = opts.servedOffer as { want?: { payto?: unknown }; seller?: unknown };
    const servedPayto = so?.want?.payto !== undefined && so?.want?.payto !== null ? String(so.want.payto).toLowerCase() : "";
    if (servedPayto && servedPayto !== payto)
      return { ok: false, trust: "verified", reason: "the served payment recipient doesn't match the offer's on-chain author/record", ...base };
    if (so?.seller !== undefined && so?.seller !== null && String(so.seller).toLowerCase() !== seller)
      return { ok: false, trust: "verified", reason: "the served seller doesn't match the offer's on-chain author (a lying resolver may be redirecting your payment)", ...base };
    if (bindOfferTerms(opts.servedOffer, terms))
      return { ok: false, trust: "verified", reason: "the served fee/rebate/partial terms don't match the offer's on-chain record (a lying resolver could mis-size the fill, causing a rejected fill after your payment)", ...base };
  }
  return { ok: true, trust: "verified", ...base };
}
