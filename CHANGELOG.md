# Changelog

## 0.3.2 (2026-07-20) - REBIND B3 release unblock

Fixes the v0.3.1 release blocker (F13): SDK_VERSION in src/errors.ts stayed at "0.3.0" while
package.json moved to 0.3.1, so the drift assertion in test/errors.test.ts went red. Because the
`test` script was a nine-deep shell `&&` chain with errors third, the six suites behind it (69
assertions, including the spv-checkpoint cross-repo anchor parity gate) never executed, and
`prepublishOnly` could never pass. The v0.3.1 tag exists with that broken content and was never
published to npm; 0.3.2 supersedes it (tags are never moved). No runtime behavior changed.

- SDK_VERSION and package.json both 0.3.2 (the equality test enforces the lockstep).
- `pnpm test` is now `node test/run.mjs`, a glob-driven runner mirroring cairn/test/run.mjs: it
  discovers every test/*.test.ts and test/*.test.mjs, runs ALL of them even after a failure,
  prints a per-file verdict, classifies exit-0-with-SKIP as SKIPPED (not a pass), applies a
  per-file wall-clock cap (CAIRN_TEST_TIMEOUT_MS, default 180s; a hang is a failure), and exits
  non-zero if any suite failed. A new suite can no longer be forgotten out of a hand-maintained
  chain, and one red suite can no longer hide the suites behind it.

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
