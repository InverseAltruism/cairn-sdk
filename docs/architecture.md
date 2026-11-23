# Architecture

Maintainer reference: what each `src/` module holds, how the SPV header sync and the fill pre-verify work, the wallet
contract couplings and the integration notes. `AGENTS.md` keeps the rules; this file keeps the detail behind them.
`docs/SDK-GUIDE.md` is the guide for third-party developers.

## Modules

`src/` is built by tsup to esm+cjs+dts with 9 entry points (the `build` script in `package.json` lists them).

- `index.ts`: Cairn facade, CairnConfig, DEFAULT_SPV_CHECKPOINT (height and hash are in the source), and the lazy
  PoW-verified header wiring into the indexer via `seededSpvLight`. See "SPV header sync" below.
- `connect.ts`: CairnProvider typed contract, detectProvider/discoverProviders (csd:announceProvider discovery),
  WalletConnection (connect/getAddress/signInWithCsd/send/propose/attest/fillOffer/sealClaim/revealClaim/permissions/
  events).
- `indexer.ts`: REST (addressUtxo follows the indexer's 1,000-row `?after=` pages until a short page, at most 100
  pages, then throws HttpError) + verifyInclusion(txid) with TrustLevel = verified-inclusion | proof-consistent |
  not-found (+ equivocation flag), SSE-over-fetch with reconnect + 1MiB buffer cap, WS subscribe.
- `content.ts`: prepare/put/hash, verified get/getBytes from the cairn origin, hash format gated against path-walk.
- `names.ts`: NamesClient over /trade/api/cairnx/*; inputs pre-validated with cairnx-core `isName`. `namesPage` and
  `lookup` read `/api/cairnx/v1/names` through `apiv1.ts` and answer from the legacy list on a 404 (no v1 mount) when
  it has an answer, sorted and paged with cairnx-api's cursor codec; `lookup` resolves with cairnx-core's
  `resolveNameIn`. `allNames` is the walk: page 1's `at` on every page, a progress check on every `next`, bounds on
  pages, rows and 409 restarts (`test/names-v1.test.ts`, "allNames").
- `apiv1.ts`: page reads of the CairnX read API, version 1: the query checked with cairnx-api's `parseQuery` before a
  request, the page shape check (rows, and `next` in the order's cursor grammar), the page's `source`, and the
  fallback rule: a 404 only, where the site's own pages (cairn `public/trade/apiv1.js`) fall back on any failure; an
  SDK caller gets every other refusal as an error (the guide states the rule). Types come from `@inversealtruism/cairnx-api` 1.0; the root entry re-exports `NameRow` as a type
  (`test/no-registry-surface.test.mjs`), not `At`, a name the `./replica` entry uses for the replica's own type.
- `replica.ts`: the `./replica` entry, `export *` from `@inversealtruism/cairnx-replica/browser`, an optional peer
  (`peerDependenciesMeta`) and an exact dev dependency. No other entry imports it, so an app that does not import
  `./replica` installs and loads nothing of the replica (`test/packed-replica.test.mjs`). The replica is ESM only:
  `scripts/check-consumer-types.mjs` leaves `./replica` out of the node16 CommonJS consumer (TS1479 by TypeScript's
  rule) and checks it under node20 CommonJS, Node 22.12's `require()` of ES modules.
- `csdlink.ts`: `web+csd:` links (parse, format, the https page beside a link); names checked with cairnx-core `isName`, no I/O.
- `chain.ts`: tip/utxos/submit/light(); Chain.send() = key-backed send via buildSendVerified + verifyInputValues
  (fail-closed). It reads the submit with `classifySubmit` and throws SubmitInFlightError with the signed txid and
  the signed tx as `nodeJson` for a duplicate or an outcome without a verdict, a final CairnError `SUBMIT_REJECTED`
  for HTTP 400, 413 or 429 (answered before forwarding by cairn-substrate.com, 400 and 429, and by nginx or
  Cloudflare, 413), and resolves `ok: false` on the node's refusal (`test/chain-send.test.ts`).
- `submit.ts`: `classifySubmit`, the one reading of a submit attempt (accepted, duplicate, rejected, in flight),
  exported from the root and `/chain` entries and used by Chain.send and `examples/node-signer.mjs`
  (`test/submit-classify.test.ts`). csd-client marks every status below 500 `terminal` and puts the status only in
  its message, so the classifier reads the status from that message and ignores the flag.
- `controller.ts`: framework-agnostic reactive store; spoofed-accountsChanged adoption guard.
- `react.ts`: createCairnHooks(React), zero react dependency.
- `errors.ts`: CairnError hierarchy with stable codes; SDK_VERSION manually kept == package.json, test-enforced
  (`test/errors.test.ts`).
- `http.ts`: 15s timeout, 16MiB streamed byte cap, idempotent-GET-only retries.
- `fillverify.ts`: the fill pre-verify; see "The fill-verify surface" below.

Outside `src/`:

- `docs/SDK-GUIDE.md`: the third-party guide, including the verifies-vs-trusts section and "Integrate the wallet".
- `examples/` (integrate-wallet, read-only, wallet-connect, siwc-login, node-signer, hello-csd): each imports the
  package by its name, which resolves to dist/ through the exports map; `test/examples.test.mjs` typechecks them,
  loads the modules, bundles the browser sample and runs the sample server's sign-in.
- `scripts/`: the esbuild example build (`build-example.mjs`), the release gates (`release-gate.mjs`,
  `verify-tarball.mjs`, `check-consumer-types.mjs`), `check-dashes-paths.mjs`, and 6 maintainer-run live E2E harnesses
  (`live-wallet-ui.mjs`, `names-e2e.mjs`, `names-buy-e2e.mjs`, `ux-live-readonly.mjs`, `ux-openlane-buy.mjs`,
  `wallet-send-spv-e2e.mjs`); `test/e2e/README.md` describes them.

## The hosted bases

Everything defaults to the hosted public bases at https://cairn-substrate.com: RPC proxy /api/rpc, SPV headers
/api/headers, content /content, indexer proxy /explorer/api, names /trade/api/cairnx/* and the read API /api/cairnx/v1/*. Those are reverse proxies in
front of the node, the csd-indexer, and the cairnx names/market resolver; every base is overridable via CairnConfig for
self-hosted setups. The chain is the only source of truth; every read carries an honest trust level, described once in
`docs/SDK-GUIDE.md` ("What the SDK verifies vs trusts").

## SPV header sync (`index.ts`)

- Header sync runs forward from the checkpoint to the tip through a batch header provider over the cairn server's
  /api/headers: a few batched requests, never a per-height flood, fail-soft to on-demand sync.
- The facade's light client (`SpvLightClient`) runs one `sync` at a time, csd-light's own on-demand sync included:
  csd-light refuses an overlapping sync as out of order, which would read as a reorg and reseed
  (`test/fillverify.test.ts` and `test/spv-fault-tolerance.test.ts`, the concurrent cases). Callers whose structural
  failures overlap share one reseed (C5). Only a failure that says the chain moved reseeds: csd-light's broken prev link
  past the cached tip, or the near-tip re-check's mismatch. Every other one (a refused tx or block read, a device
  clock more than 2 h behind) keeps the cache and surfaces as itself (C6, C7).
- The per-attempt timeout is deliberately above the server's 10 s route deadline.
- Cross-origin reach of that provider depends on the cairn server's CORS mount on /api/headers.
- The checkpoint is picked in cairn (`bump-swapguard-cp.mjs`) and copied here in the same cycle; it is never a
  unilateral SDK edit.
- `test/spv-checkpoint.test.ts` recomputes the anchor's hash from a committed header capture
  (`test/fixtures/spv-headers-*.json`, PoW and prev-links checked) and fails when the constant is not that block; a
  moved checkpoint needs a new capture.
- Verification only runs forward from the anchor, so a moved checkpoint turns reads below it into `proof-consistent`
  (behaviour described in `docs/SDK-GUIDE.md`). Every checkpoint move names the affected band in the CHANGELOG.

## The fill-verify surface (`fillverify.ts`)

- `src/fillverify.ts` imports `feeBpsAt`, `bindOfferTerms`, `provenOfferTerms`, `provenOfferRefusal` (the resolver's
  creation rules for a proven offer, both activation gates included), `previewFill`, `fillEndorsement`,
  `fillTargetId`, `isOpenClaimLane`, `LEGACY_HOLD_SUNSET_HEIGHT`, `offerExpiryHeightOf` and `offerFillTooLate` from
  cairnx-core, with no local copies. The
  ProvenOfferTerms interface and producer are single-sourced and corpus-equivalence-pinned by
  `test/proven-terms-corpus.test.ts`.
- `preverifyOffer` judges a fill over the proven record plus the served running state (status, a partial offer's paid
  and delivered, the claim or reservation). A served status other than open refuses; a partial offer is never sized,
  but a pay `previewFill` says delivers nothing refuses; `me` and `tip` add `fillEndorsement`, `offerFillTooLate` and
  the legacy-hold sunset (an open CSD offer's fill that attests the offer id is refused from that height).
  Without them `ok` is a verdict on the record, not on the caller's fill.
- fillverify exports the `preverifyOffer` helper; the throw-on-nested-refusal write wrapper is `unwrapWrite` in
  `connect.ts`, not exported.
- The give and want-type binds are on: `bindOfferTerms` over the branded `MintedProvenOfferTerms` checks them by
  default in cairnx-core, and fillverify also passes `{ give: true, wantType: true }`. It binds the give legs, a
  symmetric want-type refusal and a token want's ticker and amount.
- `OfferFillCheck.terms` keeps that brand (`test/fillverify-types.test.mjs` type-checks it). The opt-in sums seam runs
  over the discriminated `fillOutputPlan`.
- `fillEndorsement` and `fillOutputPlan` are the successors. The deprecated `fillIsSafe`, `requiredFillOutputs` and
  `previewFill` stay exported, behaviour-frozen.
- `fillEndorsement`'s not-endorsable verdict means proceed unendorsed; it is never a refusal of an honest token fill.

## The wallet contract

- `src/connect.ts` is the typed mirror of the contract of cairn-wallet's `window.cairn` provider, which is
  `docs/PROVIDER.md` in the cairn-wallet repo; the wallet error code contract is its `WALLET-ERROR-CODES.md`.
- mapProviderError and the write wrappers classify every code in WALLET-ERROR-CODES.md
  (`RESERVATION_UNCONFIRMED` never reaches a page) as retryable, in flight or final. Any wallet code not named in
  `src/errors.ts` is kept on the error as sent, final, so when the wallet adds a code: a retryable one goes into
  `NESTED_TRANSIENT`, a maybe-sent one into the in-flight pair, and a final one needs only its `CairnErrorCode` entry
  and a test in `test/errors.test.ts`. A reply naming a code only the SDK assigns (`SDK_ONLY_CODES`) reads `UNKNOWN`.
- `test/types/wallet-codes.ts` is a hand-written snapshot of the codes in the wallet's `WALLET-ERROR-CODES.md` (its
  header names the wallet commit it was read from); `pnpm typecheck` fails when one is missing from `KnownCode` in
  `src/errors.ts`, which no package entry exports. At each wallet release, compare it with the wallet's table by
  hand, add each new code to it, and classify the code as above.
- `test/types/wallet-params.ts` is a hand-written snapshot of the params the wallet accepts (its header names the
  wallet version it was read from); `pnpm typecheck` fails when a param type in `src/connect.ts` differs from it. It
  does not read the wallet: at each wallet release, compare the snapshot with the wallet's handlers by hand and
  update it and the types together. Its `WALLET_CAPABILITY_METHODS` is the wallet's `getCapabilities().methods`;
  `test/testing.test.ts` requires `src/testing.ts` (the `/testing` mock) to advertise exactly those, so a new wallet
  method goes into the snapshot and the mock together.
- Audit-ID markers in `src/` comments (M3, H2, CAIRNSDK-*, CONNECT-1 and others) are mapped to the guards they
  explain in `CHANGELOG.md`, "Notes moved from AGENTS.md".

## Integration notes

- SSE through a buffering reverse proxy needs `X-Accel-Buffering: no` from the origin (the hosted proxy sets it); WS
  subscribe still needs a direct indexer URL because the hosted proxy is REST+SSE only.
- Large-tx submits: a reverse proxy with a small body cap on POST /api/rpc/tx/submit answers HTTP 400 before the tx
  reaches the node (a 64KB cap is hit at roughly 127+ inputs). The cairn server has a scoped 512KB cap on that route.
  Symptom on a server without that cap: a big Chain.send()/submit 400s with no node-side error. Suspect the proxy
  body cap on the server you target before blaming the SDK.
- The esbuild CLI shim ELF-errors under pnpm; `scripts/build-example.mjs` uses the JS API, keep it that way.
