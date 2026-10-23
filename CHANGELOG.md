# Changelog

## 0.8.0 (prepared 2026-10-23, not yet published): open-only market lists, token records checked

A minor bump on 0.x: `offers()` and `bids()` return fewer rows by default, so a `^0.7.x` range does not pick this up.

### Changed

- `cairn.names.offers()` and `cairn.names.bids()` return open rows only, as their docs said. They ask the
  resolver for `?status=open` and drop any row of another status the server returns. Before this release they
  returned every row the resolver holds (on 2026-10-23: 237 offers of which 2 open, 206 bids of which 1 open).
  `offers({ status })` and `bids({ status })` select another status (`OfferStatus` or `BidStatus` from
  cairnx-core); `{ status: "all" }` returns the full list as 0.7.0 did.
- `cairn.names.token(ticker)` and `tokens()` throw `HttpError` ("malformed response: ...", naming the field) for a
  record with decimals outside the range cairnx-core's deploy parser accepts (0 to 8), with `supply`, `minted` or
  `mintLimit` above cairnx-core's `MAX_AMOUNT`, or, for `token(ticker)`, with a ticker other than the one asked
  for. Before, decimals had only a lower bound, amounts no upper bound, and `token("AAA")` returned a record
  for `BBB`. Records the live resolver serves pass unchanged (pinned on a capture of its 20 tokens).

### Dependencies

- No dependency added or bumped.
- `SDK_VERSION` is 0.8.0.

## 0.7.0 (2026-10-19): registry API removed, content from the cairn origin only

A minor bump on 0.x: a call that compiled under 0.6.0 no longer does, so a `^0.6.x` range does not pick this up.

### Removed (breaking for importers of the registry API)

Decision P-5 (2026-10-13): one naming system. The registry served the swarm's peer and gateway lists, and the
swarm is dead; the indexer's `/registry/peers` and `/registry/gateways` answer `[]` today and
return 404 once the indexer release of this wave is deployed. The `@inversealtruism/csd-registry` package is
removed from the csd-sdk monorepo and deprecated on npm after this release, so nothing here depends on it.
Replacement: none for peers, gateways, identity reads and the record builders; for .csd names use `cairn.names`
(server-trusted display reads; the wallet verifies a payment target on-device).

- `RegistryClient` (export) and its option type `RegistryClientOptions`, the `cairn.registry` namespace, and the
  `@inversealtruism/cairn-sdk/registry` subpath export. That removes `registry.gateways()`, `peers()`,
  `resolveName(handle)`, `reverseName(addr)` and `.fromRecords`.
- The csd-registry re-exports that subpath carried: `fromRecords`, `verifyPeer`, `verifyGateway`,
  `verifyIdentitySig`, `DOMAINS`, `buildPeerRecord`, `buildGatewayRecord`, `buildIdentityCommit`,
  `buildIdentityReveal`, `epochOf`, and the types `RankedPeer`, `RankedGateway`, `ResolvedIdentity`,
  `ChainRecord`, `ResolveOpts`, `BuiltRecord`.
- `IndexerClient.registryPeers()`, `registryGateways()`, `identity(handle)` and `reverseIdentity(addr)`
  (`cairn.index.*`). The last two read the indexer's `/identity/:handle` and `/address/:a/identity`, the
  registry's identity layer, which the indexer removes in the same wave (they answer 404 when no binding exists).
- The dependency `@inversealtruism/csd-registry` (0.1.20). The lockfile diff only removes it and its entry.
- `examples/register-swarm-peer.mjs`, which built and proposed swarm peer and gateway records, and the registry
  lines of `examples/read-only.mjs` and `test/e2e/e2e-read.mjs`.

### What a 0.6.0 user sees after the indexer deploy

`cairn.registry.peers()` and `cairn.registry.gateways()` (and `cairn.index.registryPeers()` and
`registryGateways()`) reject with `HttpError` status 404 instead of resolving `[]`. `cairn.index.identity()` and
`reverseIdentity()` reject with `HttpError` 404 once the route is gone. `registry.resolveName()` and
`reverseName()` turned a 404 into `null`, so they resolve `null` after the deploy. Code that guarded these calls with a `.catch(() => [])` keeps working; code that did not now throws.
On 0.7.0, `cairn.registry` is undefined and the names above are not exported or not methods. A TypeScript build
fails at the import or the property access. In plain JavaScript, an ESM `import { RegistryClient }` fails when the
module loads (`SyntaxError`), `import("@inversealtruism/cairn-sdk/registry")` fails with
`ERR_PACKAGE_PATH_NOT_EXPORTED`, under CommonJS `RegistryClient` is `undefined`, and calling `cairn.registry.*` or
`cairn.index.identity()` throws a `TypeError`.

### Content reads from the cairn origin only

The swarm is dead and the indexer removes its `/content` route in the same wave (it fetched from the swarm and
answers 502 today), so `cairn.content` now reads only the cairn origin's `/content/<hash>`, which holds the bytes.
Verification is unchanged: bytes that do not hash to the requested hash throw `ContentVerificationError`; a 404 or
an unreachable origin resolves `null`, as 0.6.0 did when every source failed.

- `baseUrls.swarm` is removed from `CairnBaseUrls`.
- `ContentClientOptions` is `{ cairn: Http }` (`cairn` required); its `swarm` and `indexer` options are removed,
  and with them the multi-source order (a mismatching source no longer falls through to the next one, since there
  is one source).

What a 0.6.0 user sees: content reads through the facade keep working after the indexer deploy, with one extra 404
round trip to the indexer before the origin answers; on 0.7.0 that round trip is gone. In plain JavaScript a
`baseUrls.swarm` value is ignored, and `new ContentClient({ swarm })` or `({ indexer })` without `cairn` throws a
`TypeError` at construction (a TypeScript build fails at the option).

### Surface

The public export list (values and types, every entry) is otherwise unchanged: 208 names at 0.6.0, 189 after
removing the 18 names of the registry entry and `RegistryClient` from the root entry. The four removed
`IndexerClient` methods and `Cairn.registry` are members, not export names, so they do not change that count.
`test/no-registry-surface.test.mjs` builds the package and pins the export list and the `IndexerClient` method
list against `test/fixtures/public-surface-0.6.0.json`.

### Dependencies

- Removed `@inversealtruism/csd-registry` 0.1.20. No dependency added or bumped.
- `SDK_VERSION` is 0.7.0.

## 0.6.0 (2026-10-18) - cairnx-core 0.2.0 and csd-codec 0.1.18 (csd-sdk publish window 2)

A minor bump: the re-exported `bindOfferTerms` changes its default and a call that compiled under 0.5.0 no
longer does, so a `^0.5.x` range does not pick this up.

### Behaviour changes

- **`bindOfferTerms`** (re-exported from cairnx-core) checks the give and want-type legs by default. A
  two-argument call over minted terms (from `provenOfferTerms`, or an `OfferFillCheck`'s `terms`) now also
  reports a mismatch when the served offer's `give` (ticker, amount or name) or want type differs from the
  proven offer. Hand-built terms (a plain `ProvenOfferTerms`) compile only with `{ give: false, wantType: false }`,
  which returns the 0.5.0 two-argument verdict on every input; a JavaScript caller that passes them without
  it gets a mismatch for every offer, honest ones included. A call that already passes
  `{ give: true, wantType: true }` gets the same verdicts as before.
- **`OfferFillCheck.terms`** is typed `MintedProvenOfferTerms` (it was `ProvenOfferTerms`), so it can be passed
  back to the default `bindOfferTerms` call. The value is unchanged, and code that reads it as
  `ProvenOfferTerms` still compiles. `MintedProvenOfferTerms` is exported as a type.
- `preverifyOffer` and `verifyOfferForFill` return the same verdicts: they already passed both legs.
- csd-codec 0.1.18, csd-tx 0.1.21 and csd-client 0.1.18 refuse more input (csd-sdk `CONSENSUS_CHANGES.md`, the
  window 2 entry). Through this SDK:
  `content.prepare()`, `content.put()` and `content.hash()` throw on a Map, Set, Date, typed array, class
  instance, function, symbol or array hole, where they used to hash a rewritten value (plain and
  null-prototype objects hash as before); the re-exported `serialize`, `txid` and `sighash` throw on a Propose
  domain or uri with an unpaired surrogate, and `buildPropose` returns `ok: false` for one; the re-exported
  `verifyMerkleProof` requires a 32-byte txid, siblings and root; `selectInputs` no longer selects one outpoint
  twice when it is served with and without `0x`; `CsdClient` falls back to the default for a non-finite
  `maxResponseBytes` or `retries`. The re-exported `verifyContentBytes` now accepts an expected hash written
  without `0x` (the `content` methods already normalized it). csd-sdk records no honest byte, txid or sighash
  change (its golden vectors are unchanged).

### Dependencies

- `@inversealtruism/cairnx-core` 0.1.42 to 0.2.0, `csd-codec` 0.1.16 to 0.1.18, `csd-crypto` 0.1.16 to 0.1.18,
  `csd-client` 0.1.16 to 0.1.18, `csd-tx` 0.1.19 to 0.1.21, `csd-light` 0.1.21 to 0.1.23, `csd-registry`
  0.1.18 to 0.1.20, and the dev dependency `csd-siwc` 0.1.17 to 0.1.19. The lockfile resolves one csd-codec
  (0.1.18) and one csd-crypto (0.1.18).
- `SDK_VERSION` is 0.6.0.

## 0.5.0 (2026-10-13) - SPV trust honesty, dApp API guards, board client removed

### Removed (breaking for importers of the board client)

The Wall is gone from cairn-substrate.com and the board page redirects to `/uplink`; the remaining board API
routes are being retired with the server's legacy surfaces, so the client for them goes now.
Replacement: none; the board is retired.

- `BoardClient` (export), its types `BoardWindow`, `RankedItem`, `BoardItemContent`, `ProposeInput`,
  `ProposeResult` and `SupportInput`, the `cairn.board` namespace, and the
  `@inversealtruism/cairn-sdk/board` subpath export. That removes `board.top()/board()`, `item()`,
  `domains()`, `quests()/quest()`, `profile()`, `leaderboard()`, `network()/networkSeries()/networkBlocks()`,
  `miner()`, `activity()`, `wall()`, `health()`, and the writes `propose()`, `registerContent()` and
  `support()`. Where a read has an indexer equivalent, use it: `cairn.index.domains()`,
  `cairn.index.domainProposals(domain)`, `cairn.index.proposal(id)`, `cairn.index.attestations(id)`,
  `cairn.index.reputation(addr)`, `cairn.index.health()`. The low-level wallet calls `wallet.propose()` and
  `wallet.attest()` stay; they never registered content with the board server.
- The live write e2e (`pnpm test:e2e:write`, `test/e2e/e2e-write.mjs`, `test/e2e/verify-pending-write.mjs`):
  its pipeline was board propose, content registration and board support. `examples/hello-csd` no longer
  publishes; it reads recent proposals from the indexer. `examples/read-only.mjs` reads proposals from the
  indexer. The error codes and their `/docs/sdk/*` paths are unchanged (the board client set none).

### Behaviour changes (read these if you gate on inclusion)

- **`index.verifyInclusion()`: `included` is `true` only with `trustLevel: "verified-inclusion"`.** Through
  0.4.6 a proof that folded but had no PoW-verified header behind it (below the SPV checkpoint, header
  source unreachable, or no `headerMerkleAt` configured) returned `included: true, trustLevel:
  "proof-consistent"`. It now returns `included: false` with the same `trustLevel` and a `reason` naming
  why the header was not verified. An empty merkle branch whose root equals the txid folds for any txid, so
  without a verified header it never reads as included. If you read `included` alone, proof-consistent
  results now read as not included; if you need the old reading, test `trustLevel !== "not-found"`.
- **Reorgs near the tip:** the SPV light client cached its verified header chain and answered heights at or
  below its cached tip from that cache, so a tx in a block orphaned by a reorg kept reading
  `verified-inclusion` until some read went past the cached tip. A cached header within 12 blocks of the
  cached tip is now compared with the header the base serves at that height (one single-header
  `/api/headers` request per such read); a mismatch reseeds from the checkpoint and the read runs again on
  the live branch, so the orphaned tx no longer reads as verified. Deeper heights still answer from the cache
  with no request. `verifyOfferForFill` gets the same re-check. What it detects depends on the base: the
  hosted cairn-substrate.com serves `/api/headers` rows at or below its tip minus 6 as immutable from the
  edge cache, so there it catches reorgs of up to 6 blocks; a self-hosted base without that cache gets the
  full 12.
- **`DEFAULT_SPV_CHECKPOINT` moves from height 101,998 to 115,403**
  (`0x00000000000052e29166597d598827b137af1dea7542123b848637fee0b67347`), copied from cairn's
  `public/trade/swapguard.js` (cairn `d5c00a9`). The hash was checked against two local nodes, and both
  re-derive it from the header they serve. A cold checkpoint-to-tip seed is about 13,400 headers shorter.
  What a caller sees differently for **heights 101,998 to 115,402**:
  - `index.verifyInclusion(txid)` returns `trustLevel: "proof-consistent"`, `included: false`, where 0.4.6
    returned `"verified-inclusion"`, `included: true`. The `reason` reads `indexer proof only, header at <h>
    not verified (height <h> is below the SPV checkpoint 115403 (cannot PoW-verify backward))`.
  - `verifyOfferForFill` for an offer mined at 101,998 to 115,357 returns `ok: false, trust: "unverified"`
    (not transient) with a reason naming the checkpoint window base 115,358 and `config.spvCheckpoint`
    (csd-light's base is the start of the 46-header seed window). Offers mined at 115,358 to 115,402 sit inside that seed window and still
    verify on this path, as the 45 heights below the old anchor did before.
  - Pass `config.spvCheckpoint: { height: 101998, hash: "0x0000000000085295c9e13bbf276a11affb5470059235d1ea85d6334c8b43c49c" }`
    to keep the old anchor.
- **Retry-After, inside a per-call wait budget:** the SPV header batch and `Http.getJson`'s opt-in GET
  retries now wait as long as the server's `Retry-After` says, as long as it fits a per-call budget for the
  total time spent sleeping between retries. A hint larger than what is left fails the call at once
  (transient for the SPV read, which degrades to `proof-consistent`; the server's `HttpError` for `Http`)
  instead of sleeping. The SPV batch used to cut every wait at 4 s and spend its retries inside the window;
  `Http` ignored the header. Per-call worst cases:
  - one `/api/headers` request: at most 16 s of retry sleep, the same as 0.4.6 (four retries at its 4 s
    cap), so with five attempts at the 15 s per-attempt timeout the worst case stays 91 s. A near-tip
    `verifyInclusion` without a reorg is the proof GET (15 s) plus one re-check (91 s): 106 s at worst. After
    a reorg it makes about 10 such requests, each bounded at 91 s: the re-check, the reseed's seed batch, a
    forward sync from the checkpoint to the tip in 512-header batches (7 at tip 118,652; the count grows as
    the tip moves away from the checkpoint), and the re-check again.
  - `Http.getJson`: at most 30 s of retry sleep (the jitter ladder at the 10-retry cap sums to about 27.75 s,
    so no hint-free schedule changes), plus one `timeoutMs` per attempt. With the default `retries: 0` it
    makes one attempt and never sleeps.
- **`verifyOfferForFill` / `preverifyOffer`: an offer mined below the SPV checkpoint window is not
  `transient`.** csd-light answers "tx below the synced base" for it, which holds for as long as the
  checkpoint does, but it was reported as `transient: true` (retryable), so a dApp would retry forever. It now
  returns `ok: false, trust: "unverified"` without `transient`, and the reason says the offer is below the
  SDK's SPV checkpoint window and names `config.spvCheckpoint`. Other unverified answers (mempool, unreachable
  chain) stay transient.
- **`preverifyOffer` / `verifyOfferForFill`: no `outputPlan` without a served status.** The sizer used to
  assume an offer was open when the caller passed `pay` without the resolver's offer object (or one without
  `status`). It now sizes only for the status the resolver served; otherwise `outputPlan` is absent and
  `planReason` says why. Pass the resolver's offer object to get a plan.
- **`plannedOutputs` that were not bound say so.** With a token-priced or partially fillable offer, without
  `pay`, or without a served status, `plannedOutputs` used to be ignored silently under `ok: true`. The result
  now carries `planBound: false` and `planReason`; `planBound: true` when they were bound to `outputPlan`.
- **`CairnController`:** the wallet's `disconnect` event and an empty `accountsChanged` (lock, account switch,
  revoke) now cancel a `connect()` in flight, the same way `disconnect()` does, so a lock during a repeat
  connect no longer ends in "connected". That `connect()` rejects; a fresh `connect()` works as before.
- **`createCairnHooks(React, controller)`** recognises a controller by its methods instead of `instanceof`,
  so a controller created by the other build of this dual CJS/ESM package is bound instead of silently
  replaced by a new, never-connected one.
- **`names` reads are shape-checked:** `tokens()` and `token()` throw a typed `HttpError` ("malformed
  response") when a row's ticker, `decimals` (non-negative integer), `supply`, `minted` or `mintLimit`
  (base-unit integer strings) is malformed; `names()`, `tokens()`, `offers()` and `bids()` throw the same
  error when the body is not an array (an error object served with status 200 used to be returned as the
  list). `token()` validates the ticker with cairnx-core's `TICKER_RE` instead of a local copy.
- **`names.nameHistory(name)`** is typed as what cairnx serves, `NameHistory` (`{ ok, name, tipHeight, resolve,
  record, events, scopedReplaySufficient, caveat? }`, exported with `NameHistoryEntry`), instead of
  `unknown[]`; the body was always this object, never an array. It throws a typed `HttpError` ("malformed
  response") when the body is not that object, names another name, or carries a malformed `events` entry,
  `resolve` or `scopedReplaySufficient`. Code that treated the result as an array was already wrong at runtime.
- **`content.getBytes()`** skips a source whose bytes do not match the hash and tries the next one; it throws
  `ContentVerificationError` only when no source served verified bytes and at least one served mismatching
  bytes. **`content.get()`** throws a `CairnError` with the new code `CONTENT_NOT_JSON` (cause: the parse
  error) instead of a raw `SyntaxError` when verified bytes are not JSON.
- **`Http`:** `retries: NaN` (or a non-number) now means 0; it used to make a failing GET retry forever.
  `maxBytes` that is NaN, infinite, zero or negative now falls back to the 16 MiB default; NaN used to turn
  the cap off.
- `SDK_VERSION` is 0.5.0. Dependencies are unchanged.

## 0.4.6 (2026-10-11) - wallet 0.2.73 error codes

- Errors: six wallet codes keep their code and the wallet's retry semantics instead of surfacing as `UNKNOWN`:
  `WALLET_UNAVAILABLE` and `REVIEW_REQUIRED` are retryable (nothing was signed); `OFFER_SOURCE_CONFLICT`,
  `FILL_LEGACY_SUNSET`, `VERIFY_HORIZON` and `VERIFY_UNREPRESENTABLE` are final. Before, every one of them was
  final with code `UNKNOWN`. Every path threw before and still throws.
- Tests: the offer-expiry boundary in `preverifyOffer` is pinned (an offer mined in its own expiry epoch is accepted,
  one epoch later it is refused).
- Docs: SDK-GUIDE no longer says the nested wallet codes are unmapped.

## 0.4.5 (2026-10-10) - single csd-codec / csd-crypto graph

- Dependencies: `@inversealtruism/csd-crypto` 0.1.15 to 0.1.16, `@inversealtruism/csd-tx` 0.1.18 to 0.1.19,
  `@inversealtruism/csd-registry` 0.1.17 to 0.1.18, and the dev dependency `@inversealtruism/csd-siwc`
  0.1.16 to 0.1.17. All of them resolve `@inversealtruism/csd-codec` 0.1.16, so the lockfile now contains one
  codec and one crypto copy. At 0.4.4 csd-crypto 0.1.15 pulled in csd-codec 0.1.15 beside the direct 0.1.16,
  which the CI dep-pin hygiene step (single codec/crypto copy) rejected.
- `cairnx-core` 0.1.42 and `csd-light` 0.1.21 are unchanged. No source behaviour change.
- `SDK_VERSION` is 0.4.5.

## 0.4.4 (2026-09-25) - CairnX public launch (Plans 80 and 81)

- Dependencies: `@inversealtruism/cairnx-core` 0.1.42 (the expiry index: `resolve()` sweeps only open offers,
  bids and pending names; canonical replay byte-identical to 0.1.41, proven on the real chain) and
  `@inversealtruism/csd-light` 0.1.21 (hash-once header verify, light-local PoW/work memos, chunked async
  snapshot restore from 0.1.20). The lockfile is regenerated: at 0.4.3 it still resolved csd-client 0.1.15
  and csd-tx 0.1.17 while package.json pinned 0.1.16 and 0.1.18, so a frozen install (CI) refused.
- `DEFAULT_SPV_CHECKPOINT` moves from height 66,589 to **101,998**
  (`0x0000000000085295c9e13bbf276a11affb5470059235d1ea85d6334c8b43c49c`), following cairn's
  `public/trade/swapguard.js` (Plan 80 D9, live since 25 Sep; hash checked against the local node). A cold
  checkpoint-to-tip seed drops from about 39,000 headers to about 4,000.
- **Read this if you gate on `trustLevel === "verified-inclusion"`:** the light client verifies headers
  forward from the anchor only, so a transaction confirmed below height 101,998 no longer reaches
  `verified-inclusion` through the default anchor. Pass your own older checkpoint if you need to prove
  inclusion that deep.
- `SDK_VERSION` is 0.4.4.

## 0.4.2 (2026-08-02) - Plan 75-B C3

- ASDK-1: the SPV transient-vs-structural classifier now recognises the Node/undici transport wording
  `fetch failed` alongside the browser's `failed to fetch`. This package runs in Node, so an ordinary
  transport blip was classified STRUCTURAL and drove `withSpvReseed` into a full checkpoint-to-tip cold
  reseed instead of a retry: the DOS-HDR-3 storm the split exists to prevent, re-authored through a
  different message class. The fix landed on master right after 0.4.1 was published, so every 0.4.1
  install carries the defect.
- `DEFAULT_SPV_CHECKPOINT` moves from height 38,142 to **66,589**
  (`0x00000000000027088f7a801555e1863d96a11fd4c258f86ca2c2506bd59ea698`). A moved trust anchor is never a
  silent change. The anchor is cairn's `public/trade/swapguard.js` CP, picked by that repo's
  `bump-swapguard-cp.mjs` (finalized, at least 1,000 deep, hash cross-checked against two independent
  local RPCs) and pinned to this literal by `test/spv-checkpoint.test.ts`. Effect for consumers: the cold
  checkpoint-to-tip header seed drops from about 29,400 headers to about 1,000, one or two batched
  `/api/headers` requests instead of about 58.
- **Read this if you gate on `trustLevel === "verified-inclusion"`.** No signature, export or option
  changed, but one behavior did, and it is a consequence of the anchor move above. The light client
  verifies headers FORWARD from the anchor only, so `index.verifyInclusion(txid)` for a tx confirmed in
  blocks **38,142 through 66,588** now returns `trustLevel: "proof-consistent"` where 0.4.1 returned
  `"verified-inclusion"` (internally: `height <N> is below the SPV checkpoint 66589 (cannot PoW-verify
  backward)`). That is roughly six weeks of chain history. The proof is still fetched, shape-checked and
  root-matched, it is just indexer-trusted instead of PoW-verified, so the move is fail-CLOSED and never
  an over-claim. It still matters for a consumer that REFUSES anything below `verified-inclusion`: those
  reads start being refused on a routine `^0.4.1` update, because this is a patch release. If you need
  backward verification over that band, keep the old anchor explicitly:
  `new Cairn({ spvCheckpoint: { height: 38142, hash: "0x00000000000140f023cc0ee1457a40833f2fcb4de44291b9d373e50f17b97232" } })`.
  A pinned anchor is your own trust decision and is never checked against swapguard.
- Release integrity: `prepack` now runs `pnpm build`. `dist/` is gitignored and untracked and `pnpm pack`
  does not fire `prepublishOnly`, so the sanctioned pack-then-publish path could ship a dist older than
  the source it claims to be. Measured at 0.4.1: `grep -c "fetch failed" dist/index.js` was 0 while the
  suite reported 16/16 green, because the parity test reads `src` by design.
  `test/spv-transient-parity.test.mjs` gains a dist arm that replays the whole vector corpus against the
  BUILT bytes and hard-fails on a missing dist. No hook fires when a pre-made tarball is published, so
  the authoritative gate stays the extracted-tarball assertion, now `node scripts/verify-tarball.mjs`
  (repo-only, not shipped): it checks the packed `dist/index.js` for the ASDK-1 arm AND cross-checks the
  packed `DEFAULT_SPV_CHECKPOINT` against cairn's `public/trade/swapguard.js` CP. Publishing a pre-made
  tarball also skips `prepublishOnly`, so `test/spv-checkpoint.test.ts` is not in that path; the
  cross-check is in the gate that is. An absent sibling cairn checkout FAILS the gate, never skips it.

## 0.4.1 (2026-07-31) - Plan 75, P75-5 fill + SPV surface

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

## Notes moved from AGENTS.md (2026-10-22)

History that used to sit in the maintainer briefing. The rules it led to stay in `AGENTS.md`.

- Stray npm lockfile (W-K1): a second lockfile, `package-lock.json`, had drifted to 0.2.3 while the package
  was 0.2.4, a supply-chain ambiguity. It was removed on 2026-07-17 (commit 09b25ff, released in 0.3.0).
- CI dep-pin gate (fixed in 0.2.2, 2026-07-10): the old ci.yml gate demanded that every
  `@inversealtruism/csd-*` pin be one uniform version, which cannot hold under independent per-package
  versioning, so it could never pass. It was reworked to per-package exact-semver hygiene over every
  `@inversealtruism/*` pin, now including cairnx-core, which the old name filter excluded.
- Pin drift (fixed in 0.2.2): `package.json` pins had drifted; 0.2.2 re-pinned to the published versions.
- The SDK originally shipped with no CI at all, and pin drift went unnoticed until a review caught it.
- Stale lockfile (found at 0.4.2): the lockfile had been stale since the 0.4.0 release, so `package.json`
  pinned newer cairnx-core, csd-codec, csd-light and csd-registry versions than `node_modules` carried.
  Every green result that certified 0.4.1 and 0.4.2, including the ASDK-1 parity corpus, had run against the
  wrong dependency graph, and `tsc` could not catch it because those `.d.ts` files are identical.
- `scripts/live-wallet-ui.mjs` was added in commit 76a0a10 (2026-07-08).
- Audit-ID markers in `src/` comments, all remediated; each marks why a guard exists:
  - M3: no over-claimed `verified-inclusion`.
  - H2 / UTXO-VALUE-1: `Chain.send` spends only verified inputs.
  - CAIRNSDK-DESER-1/3/4: buffer caps and merkle-proof pre-validation.
  - CAIRNSDK-VP-4: a submit rejection is folded into `ok`.
  - CONNECT-1 / CTRL-ADOPT-1: no adoption of a forged account.
  - F11: ghost reconnect.
