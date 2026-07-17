# Changelog

## 0.3.0 (2026-07-17) - Plan 70 R2

BREAKING (F14): the WalletConnection write wrappers (send/fillOffer/propose/attest/sealClaim/revealClaim)
now THROW a typed `CairnError` when the wallet returns a nested fund-safety refusal ({ok:false, code}),
instead of resolving with {ok:false, txid:undefined}. A dApp that did `const {txid} = await fillOffer();
markPaid(txid)` previously marked a REFUSED fill as paid; it must now use try/catch. New exports
`SubmitInFlightError` (carries the locally-computed `txid` + `maybeSent` for SUBMIT_MAYBE_INFLIGHT /
SUBMIT_DUPLICATE - reconcile, never blind-retry) and `mapSubmitResultError`. `err.retryable === true`
marks a safe auto-retry (nothing signed); a terminal CairnError is definitively not sent.

Added: `preverifyOffer` / `Cairn.verifyOfferForFill` (F13-helper) - a diligent dApp can merkle-prove an
offer + bind the payment recipient to its on-chain author before fillOffer.
Hardening: the spv-checkpoint parity guard fails-not-silent-skips (I2); the stray npm lockfile removed (W-K1).
