# Changelog

## Unreleased (Plan 75, P75-5 fill + SPV surface)

BREAKING REFUSAL (MF-09): `preverifyOffer` / `verifyOfferForFill` now REFUSE a `servedOffer` whose
`want.payto` or `seller` is absent or null (the reason names the missing field), where they previously
skipped that bind and returned ok:true trust:"verified". Pass the resolver's full offer object, or omit
`servedOffer`. Resolver-served objects always carry both fields, so only hand-built partial objects see
the new refusal.

Fill surface:

- MF-06: a token-priced offer's served `want.ticker`/`want.amount` are bound verbatim to the
  merkle-bound record (bait-and-switch price refused).
- MF-07: a Propose outside the `cairnx:v1` settlement domain is refused; the fill sizer judges the
  served `status` when one is supplied instead of asserting liveness past cairnx-core's status gate.
- MF-08: a fill-sizer throw is now a refusal carried in the result (it previously escaped and rejected
  the whole call); the derived payto flows into the sizer, so a payto-less offer plus `pay` sizes
  instead of throwing.
- MF-11: `verifyOfferForFill(offerId, servedOffer?, { pay, plannedOutputs }?)` reaches the proven
  `outputPlan` seam through the facade.
- MF-10: `fillOffer` emits a once-per-connection console advisory when the wallet self-reports a
  version below 0.2.60 (predates on-device fill-SPV). WARN only, never a block; unparseable versions
  never warn.

SPV / transport / controller surface:

- MF-12: registry reads (peers / gateways / identity / reverse-identity) run over the SDK's hardened
  Http; failures now throw the typed `HttpError`/`CairnError` (`.status`, 15s timeout, 16 MiB streamed
  cap) instead of csd-registry's bare `Error("/registry/peers -> 500")`, and `reverseName` URL-encodes
  the address segment. The 404-to-null contract of both name resolvers is unchanged. Callers
  string-matching the old bare message must switch to `instanceof HttpError` / `errorCode()`.
- MF-13: the SPV header-batch read (`/api/headers`) is now bounded on BOTH headers and body: one
  AbortController spans the whole attempt (the timer stays armed through the body read) and the body
  streams through a 2 MiB capped reader, so an oversize or never-ending 200 fails bounded instead of
  OOMing or hanging. Semantic note: a malformed 200 body (e.g. a Cloudflare interstitial) that was
  thrown immediately is now RETRIED within the same finite `SPV_HTTP_MAX_RETRIES` budget, then thrown.
- MF-14: the checkpoint seed is committed to the shared light-client field ONLY on a fully successful
  seed. A failed seed leaves no cached state (the next call retries on a fresh client instead of
  wedging forever on "seedTrusted must be called on a fresh client"), and concurrent first callers
  share ONE in-flight seed.
- MF-03: SPV sync failures are classified transient-vs-structural (ported from the wallet's widened
  form: the 50[0-9] arm plus a JSON-parse arm, so a CF 200-HTML interstitial is transport, never
  chain). A STRUCTURAL break (a reorg orphaned the cached tip) reseeds ONCE from the checkpoint into a
  fresh client and commits it only on success; a transient failure keeps the cache and rethrows (no
  reseed storm). RESIDUAL: heights at or below the cached tip still answer from the cached branch with
  no network touch, so a tx in a reorg-orphaned block can still read as verified-inclusion until a
  past-tip read trips the reseed; this release closes the permanent post-reorg brick, not
  reorg-blindness itself.
- MF-15: `CairnController` connect/disconnect carry a generation token, so a connect() whose approval
  await straddled a disconnect() refuses to commit "connected" over the torn-down session; disconnect()
  tears down local state immediately and revokes after (a hung provider can no longer hold a torn-down
  session "connected"); `signInWithCsd` gates on connection STATUS, not just a non-null handle; and
  `WalletConnection.call()` rejects a synchronously-throwing provider instead of escaping the promise
  contract.

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
