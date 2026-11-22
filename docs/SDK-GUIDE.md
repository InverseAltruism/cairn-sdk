# Cairn SDK: third-party developer guide

`@inversealtruism/cairn-sdk` is the dApp kit for the Compute Substrate (CSD) chain + the Cairn Wallet:
wallet connection, audience-bound auth ("Sign in with CSD"), chain reads with a verifying light client,
the indexer, .csd names and content. Framework-agnostic core + an optional React
adapter. See also the runnable references in `examples/`.

## Install

```bash
npm i @inversealtruism/cairn-sdk
# server-side auth verification only:
npm i @inversealtruism/csd-siwc
```

## Quickstart

```ts
import { Cairn, connect } from "@inversealtruism/cairn-sdk";

const cairn = new Cairn({ network: "mainnet" });          // reads need no wallet
const tip = await cairn.chain.tip();

const { wallet, address } = await connect();              // prompts the user once per origin
await wallet.send({ to: "0x…", amount: 100_000_000 });    // wallet clear-signs every signature
```

Sign-in (passwordless): see `examples/siwc-login.mjs` for the full client + server flow.

## Integrate the wallet

`examples/integrate-wallet/` is a runnable page and server that does all of the steps below: `app.ts` (the page),
`index.html` and `server.mjs` (serves the page and verifies the sign-in). It imports the packages by their
published names. In this repo:

```bash
pnpm install --frozen-lockfile && pnpm build && pnpm build:example
node examples/integrate-wallet/server.mjs      # http://127.0.0.1:4173/ (PORT to change it)
```

In your own project, install `@inversealtruism/cairn-sdk` and `@inversealtruism/cairnx-core` for the page and
`@inversealtruism/csd-siwc` for the server, and bundle `app.ts` with your bundler.

Compatibility: each release's CHANGELOG entry names the Cairn Wallet version whose error codes and params it
follows, and says whether the sample ran against that wallet for the release.

1. Where the wallet runs. It injects into the top frame only, of https pages and of http pages on `localhost` and
   `127.0.0.1` (any port). It does not inject into an iframe or into an http page on any other host; there
   `getWallet()` rejects with `NOT_INSTALLED`. Served from `http://127.0.0.1:4173`, the sign-in domain your
   server expects is `127.0.0.1:4173`.
2. Detect. `getWallet()` (or `detectProvider()`) waits up to 3 s (`timeoutMs`) for the wallet to announce itself
   and rejects with `NOT_INSTALLED` when none does. The wallet injects after the page starts, so `isInstalled()`,
   a synchronous read, returns `false` at startup for a user who has the wallet: do not decide "not installed"
   with it. `discoverProviders()` lists every announcing wallet for a picker.
3. Connect. `wallet.connect()` asks the user once per site and answers silently afterwards. A locked wallet
   shows its own unlock form in the approval window, so the page needs no branch for it: a request made while it
   is locked waits there for the user to unlock. `WALLET_LOCKED` arrives when the wallet locks between the user's
   review and the approval.
4. Balances are served reads for display, never a payment gate. CSD: `cairn.chain.utxos(addr)`,
   `confirmed_balance` in base units (1 CSD = 100,000,000). Tokens: `GET
   https://cairn-substrate.com/trade/api/cairnx/address/<addr>` answers `{ balances: { <ticker>: { available,
   locked } } }` in base units as strings; `cairn.names.token(ticker)` gives the `decimals`. The SDK does not wrap
   that route.
5. Sign in with server-side verification. Your server issues a nonce (`generateNonce()`; at least 8 ASCII letters
   and digits, see "Sign-in" below), the page calls `wallet.signInWithCsd({ nonce, statement })`, and the server
   looks the nonce up in its own store (bound to the browser that asked for it), deletes it, runs `verifySiwc`
   with its own domain and that nonce, then starts its own session. `verifySiwc` only compares the message with
   what you pass it: given the nonce read from the message without your store lookup, it accepts a replay.
6. A CSD send: `wallet.send({ to, amount })`, amount in base units. The wallet selects the inputs, returns change
   to itself and shows every output and the fee.
7. A token send: build the record with cairnx-core `transfer({ ticker, to, amount, ts })` (amount in the token's
   base units) and anchor it with `wallet.propose({ domain: DOMAIN, payloadHash, uri, expiresEpoch })`, where
   `DOMAIN` is cairnx-core's `cairnx:v1`. With no `fee` the wallet signs its Propose fee floor (`MIN_FEE_PROPOSE`,
   25,000,000 base units). The sample sets `expiresEpoch` to the current epoch plus 720, the window the wallet's
   own token transfer uses (about 30 days: an epoch is 30 blocks at a 120 s target). The approval window shows a
   CairnX token transfer; the balance changes once the resolver reads the block that mines it.
8. Failures: branch on `errorCode(e)`, never on the message. `NOT_INSTALLED`, `USER_REJECTED` (also when the
   user closes the approval window), `WALLET_LOCKED`, `ACCOUNT_CHANGED` (the account changed while the request was
   open), `WALLET_RELOADED` (reload the page), `RATE_LIMITED` (too many requests wait in the wallet). A
   `SubmitInFlightError` means the transaction may have been sent: check before sending again ("Typed errors"
   below). With code `WALLET_TIMEOUT` the request may still be open in the wallet: have the user reject it there
   first, then check, since approving it after a new send sends twice. A failed read never involved the wallet: an
   HTTP status from the indexer, content or names routes throws an `HttpError` with code `HTTP_ERROR`; a chain read
   (`cairn.chain.*`) that fails, or a request that got no answer, rejects with a plain `Error`, for which
   `errorCode` gives `UNKNOWN`.
9. Account changes: `wallet.on("accountsChanged", (accounts) => ...)` fires with `[]` when the site loses access
   (the wallet locked, switched account or revoked the site). It never carries the new address; call
   `connect()` again.
10. What the wallet does not do: there is no `signMessage` (arbitrary message signing). The signing methods are
    `send`, `propose`, `attest`, `fillOffer`, `sealClaim`, `revealClaim` and `signInWithCsd`, and each opens the
    approval window every time. There is no testnet ("Getting CSD for development" below), so taking a
    transaction past the approval window spends mainnet CSD.

## Testing your integration

Your own tests can run against `mockCairnProvider` from `@inversealtruism/cairn-sdk/testing` instead of the
extension. It is a mock for tests, not a wallet: it holds no key, signs nothing, and returns placeholder txids and
signatures (a sign-in from it fails `verifySiwc`). It answers with the wallet's envelopes and nested `SubmitResult`,
approves by default and records every call in `calls`. Script an answer with `next(method, answer)`: `{ kind:
"approve", txid }`, `{ kind: "reject", code }` for an outer refusal with a code from the wallet's
`WALLET-ERROR-CODES.md`, `{ kind: "refuse", code, txid? }` for a refusal nested in an approved reply, or `{ kind:
"reply", reply }` for a raw envelope. `emit("accountsChanged")` and `emit("disconnect", "locked")` send the wallet's
events, and an approved `revokePermissions()` sends both, as the wallet does. `installMockCairn(window, mock)`
installs it on the window you pass, with the wallet's discovery handshake, so `getWallet()` and
`discoverProviders()` find it; it returns the uninstall function.

```ts
import { CairnError, getWallet } from "@inversealtruism/cairn-sdk";
import { installMockCairn, mockCairnProvider } from "@inversealtruism/cairn-sdk/testing";

const mock = mockCairnProvider({ address: `0x${"ab".repeat(20)}` });
const uninstall = installMockCairn(window, mock); // the test environment's window (jsdom, happy-dom, a browser)

const wallet = await getWallet();                 // detect: the mock announces itself as the wallet does
const address = await wallet.connect();
const post = { domain: "my-app:v1", payloadHash: `0x${"00".repeat(32)}`, uri: "my-app:post/1", expiresEpoch: 1000 };

mock.next("propose", { kind: "reject", code: "USER_REJECTED" });
try {
  await wallet.propose(post);
} catch (e) {
  if (e instanceof CairnError) console.log(e.code);   // "USER_REJECTED"
}

mock.next("propose", { kind: "approve", txid: `0x${"cd".repeat(32)}` });
const { txid } = await wallet.propose(post);          // the scripted txid
console.log(mock.calls.map((c) => c.method));         // ["connect", "propose", "propose"]
uninstall();
```

In this repo's tests the mock's method list must equal a snapshot of the wallet's `getCapabilities().methods`, which
is compared with the wallet by hand at each wallet release.

## Subpath exports (tree-shakeable)

| Import | What |
|---|---|
| `@inversealtruism/cairn-sdk` | the `Cairn` facade + connectors + types |
| `…/connect` | `connect` / `getWallet` / `detectProvider` / `discoverProviders` |
| `…/controller` | `CairnController`: framework-agnostic reactive connection store |
| `…/react` | `createCairnHooks(React)`: React hooks (zero react dependency; you pass React) |
| `…/chain` | `CsdClient`, tx builders, the verifying `LightClient` |
| `…/indexer`, `…/content` | service clients |
| `…/testing` | `mockCairnProvider`, `installMockCairn`: a mock of the wallet's provider for your tests (no key, signs nothing) |
| `@inversealtruism/csd-siwc` | **server-side** SIWC verify (`verifySiwc`, `generateNonce`) |

## Names: pages and lookups

`cairn.names.namesPage(opts)` reads one page of the names list from the CairnX read API, version 1
(`/api/cairnx/v1/names`). Rows are `NameRow` from `@inversealtruism/cairnx-api` (cairnx-core's `NameState`: `name`,
`owner`, `addr`, `profile`, `viaFill`, the lease fields). That package is pre-1.0, and these calls follow it: a
release before its 1.0.0 may change a parameter or a field, and this SDK's changelog names it.

```ts
let page = await cairn.names.namesPage({ limit: 200 });
const all = [...page.rows];
while (page.next !== null) {
  page = await cairn.names.namesPage({ limit: 200, after: page.next, at: page.at });
  all.push(...page.rows);
}
```

- Options: `keys` (1 to 32 names; excludes every other option but `at`), `after` (a page's `next`), `limit` (1 to
  200; the server's default is 100), `at` (a page's `at`), `owner`, `status` (`held`, `pending`, `lapsed`), `order`
  (`name`, bytewise, the default; `newest`). An option outside that grammar throws a `CairnError` with code
  `INVALID_QUERY` before any request (the check is cairnx-api's `parseQuery`).
- `at` is the snapshot a page describes. Passing it back reads every page from that one state; a server that no longer
  holds it answers 409 (an `HttpError` whose body names `SNAPSHOT_NOT_HELD`), and the walk starts again without `at`.
  A walk ends on `next === null`; `total`, when present, is a count and never ends a walk.
- `cairn.names.lookup(name)` reads one name over `names?keys=<name>` and returns `{ name, row, resolved, at }`:
  `resolved` is cairnx-core's `resolveNameIn` over the row (the `nset` address, else the owner; null for no row or a
  pending reservation; `lapsed: true` for a lease that ran out). null means the input is not a name.

Fallback. On a front door without the read API, both calls answer from the legacy list
(`/trade/api/cairnx/names`), the read `names()` makes. The rule is the site's: anything but a 2xx whose JSON body is a
page (`ok: true`, `rows` an array, a well-formed `at`, `next` a string or null) falls back, whatever the cause: a 404
(no read API), a 5xx, a body that is not JSON, the request timeout, a network error, `ok: false`. The legacy rows are
sorted and paged with cairnx-api's cursor codec, so a page holds the rows the read API gives for the same query, with
`at: null`. A read the legacy list cannot answer has no fallback and throws the read API's error: one with `at` (the
legacy list names no snapshot) or with `owner` or `status` (filters are the read API's). If the legacy read fails as
well, its error is thrown.

These are display reads like the rest of `cairn.names`: an answer is the server's word, never a payment target.

## What the SDK verifies vs trusts (read this)

The honest trust model: funds are safe even against a malicious RPC, because **the wallet signs
locally and the user clear-signs every signature**; a bad RPC can mislead *display*, not move funds.

- **Verified (cryptographic):** transaction signing + sighash (in the wallet); `LightClient` tx
  *inclusion* (Merkle branch folded against a **PoW-verified** header it re-derives LWMA difficulty
  for, anchored to a baked checkpoint); content self-certification (`sha256(bytes) == payloadHash`;
  `cairn.content.get()` throws `ContentVerificationError` on a mismatch, so an untrusted gateway cannot
  serve tampered content);
  SIWC sign-ins (domain + nonce + chain + time + signature + `hash160(pub)==account`).
- **RPC-trusted (display only):** balances / UTXO sets / history / prices. CSD headers carry no UTXO
  commitment, so non-spend can't be proven from headers, so `LightClient.balance()` is tagged
  `rpc-trusted` and never hides that. Verify what matters; treat balances as a hint.
  `cairn.index.addressUtxo(addr)` reads an address's unspent outputs from the indexer in pages of 1,000 and
  stops at 100 pages: when the 100th page is full (100,000 or more outputs, or an indexer whose pages never
  end) it throws `HttpError` (`too many unspent outputs: ...`) instead of reading on.
- **Indexer = untrusted derived view:** the `IndexerClient` re-folds Merkle proofs
  (`verifyInclusion`). `verifyInclusion()` folds the proof and checks its root against a header from
  `headerMerkleAt`. What it proves is that a 32-byte value is a node of that block's merkle tree, not that
  the value is a transaction: the tree has no leaf and node separation, so an inner node or the block's
  merkle root itself folds as well. Get the id by hashing a transaction body you hold (`txid(tx)` from
  `…/chain`); an id the indexer or anyone else hands you proves nothing on its own. The default `Cairn` wiring backs that with a light
  client that PoW-verifies headers forward from a pinned checkpoint (`DEFAULT_SPV_CHECKPOINT`; pass
  `spvCheckpoint` in the config to keep a different anchor). `included` is `true` only with
  `trustLevel: "verified-inclusion"` (the proof root matched a PoW-verified header). When no header can
  be verified (the tx is below the checkpoint, the header source is unreachable, or none is configured)
  a proof that only folds is `"proof-consistent"` with `included: false` and a `reason`: the indexer
  alone vouches for it. Gate on `included` or on `trustLevel === "verified-inclusion"`; they agree.
  When a release moves the default checkpoint, transactions below the new anchor drop to
  `"proof-consistent"`; the changelog names the affected band.
- **Reorgs near the tip:** a header within 12 blocks of the light client's cached tip is first compared
  with the header the base serves at that height, so a block orphaned by a reorg stops counting. The
  hosted base edge-caches rows at or below its tip minus 6, so against cairn-substrate.com this catches
  reorgs of up to 6 blocks; a self-hosted base without that cache gets the full 12.
- **A long-lived instance:** the header cache advances on demand. When a transaction sits more than 256
  blocks above it (a page open for hours, or a header pre-warm that failed), `verifyInclusion` and
  `verifyOfferForFill` sync the cache forward first through `/api/headers` (512 headers a request), so
  the first check after a long idle takes a few requests longer; later checks add none. Concurrent checks on
  one `Cairn` instance share that sync.

**Filling an offer (F13, diligent-dApp pre-verify):** `fillOffer` is resolver-trusted at this SDK layer:
the SDK does NOT SPV-verify the `outputs` you hand the wallet, so a lying resolver could redirect the
payment. Before you build those `outputs`, corroborate the offer on-chain with
`await cairn.verifyOfferForFill(offerId, servedOffer, { pay, plannedOutputs, me, tip })`. It merkle-proves the offer's
Propose into the PoW-verified header chain (from the pinned SPV checkpoint), binds the record to its on-chain
commitment, derives the payment recipient + seller from the offer's on-chain author (the funding input's
prevout owner, accepted only when the Propose body carries that owner's signature, which the merkle root does
not commit: a body served without it has no author yet and answers transiently), and, when you pass the resolver-served `offer`, binds its
payto/seller + fee/rebate/partial terms to the proven ones. It refuses an offer under the creation rules
cairnx-core `provenOfferRefusal` covers (a Propose outside the `cairnx:v1` settlement domain, a treasury payee,
an expiry already past when it was mined, and the height-gated record rules such as the v1.3 ban on open
CSD-priced offers, and the activation gates at 29,860 and, for name offers, 29,960), binds a token-priced offer's served `want.ticker`/`want.amount` verbatim to the record,
and refuses a served offer whose `want.payto` or `seller` is absent (the reason names the missing field, so
pass the resolver's full offer object or omit `servedOffer`).

Pass `opts.pay` (the CSD base units you intend to pay) to receive the PROVEN `outputPlan` for a whole fill of
a non-partial offer, and `opts.plannedOutputs` (your planned per-address sums) to bind them to that plan
before signing. The plan is sized only when you also pass the resolver's offer object with its `status`:
liveness is not provable at this layer, so an offer of unknown status gets no plan, and a served status other
than `open` is refused whether or not you pass `pay`. With `pay` the result carries `sized`: `true` when
`outputPlan` holds the proven outputs for that pay, `false` when the fill could not be sized from proven data
(`planReason` says why). `ok: true` with `sized: false` is a verdict on the offer record, not on your fill.
A partially fillable (min-bearing) offer is never sized here, because its progress (`paid`, `delivered`) is
served by the resolver, not proven; with the served offer, a pay that cairnx-core's `previewFill` says delivers
nothing (below the minimum, or rounded to zero tokens) is refused, since CairnX would keep the CSD. A pay above
the served remainder is clamped by CairnX and the excess is not returned, and a resolver can serve a wrong
`paid`, so for a partial fill rely on the Cairn Wallet's own fill preflight, the payment-grade check. When
`plannedOutputs` could not be bound (no `pay`, a token-priced or partially fillable offer, no served status),
the result says so with `planBound: false` and a `planReason`; `ok: true` with `planBound: false` means your
outputs were not checked. On a token-priced offer a fill moves no CSD, so any positive CSD leg in
`plannedOutputs` is refused.

Without more inputs `ok` says the offer is proven, not that you can fill it now: an offer bound to another
taker, or held by someone else's live claim or reservation, still answers `ok: true`. Pass `opts.me` (the
address that signs the fill) and `opts.tip` (the chain tip height you sign at) together with `pay`, and
optionally `opts.fillTargetId` (the proposal id your attest will target), to run cairnx-core's
`fillEndorsement` over the served state after the binds. The result then carries `endorsement` (`{ verdict,
reason }`) and `fillTarget` (the id the attest must target at that tip: the offer id, or the fclaim txid
while a live V28 reservation routes the offer). A `refused` verdict answers `ok: false` with no `outputPlan`
(`sized: false`), as a served status other than `open` does; `not-endorsable` (a
token-priced want, whose delivery depends on your token balance) is not a refusal. The claim fields the
endorsement reads (`claimedBy`, `claimUntilHeight`, `claimTxid`) are served by the resolver too, like `paid`, and
`fillTarget` is derived from them: a resolver that serves `claimedBy` as your address turns `refused` into
`endorsed` and `ok: true`, so rely on the Cairn Wallet's own fill preflight for the claim as well. Every result that carries
the proven `terms` also carries the proven expiry: `expiresEpoch` and `expiresAt`, the first block height at
which CairnX treats the offer as expired. A fill must be mined below `expiresAt`. With `me` and `tip`, a fill
whose offer's last live block (`expiresAt - 1`) is fewer than 4 blocks above your tip (cairnx-core's
`offerFillTooLate`, `FILL_TIP_MARGIN`) answers `ok: false` with no `outputPlan`; without them, compare
`expiresAt` with your tip.

It returns a trust-labeled `OfferFillCheck` (`{ ok, trust, payto, seller, terms, reason, transient,
blockHeight, expiresEpoch, expiresAt, outputPlan, sized, planBound, planReason, endorsement, fillTarget }`):
fail-closed on a positive mismatch; `transient` on a lagging chain view, where a retry can help; final, with a
reason naming the anchor, for an offer mined below the SPV checkpoint (pass an older `spvCheckpoint` to
verify it). Build EXACTLY the `outputPlan`, never the resolver-served outputs a lying
resolver could redirect. Its values are `bigint` base units, while each output `value` of `fillOffer` is a
`number` the wallet requires to be a positive safe integer (refused otherwise: wallet 0.3.3 answers the nested
`BAD_OUTPUTS` at signing, the release after it `BAD_REQUEST` before any window opens): pass `Number(value)` after
checking `value <= BigInt(Number.MAX_SAFE_INTEGER)`. Where a param takes a decimal string, `value.toString()` is
exact. Never `JSON.stringify` the plan: it throws on a `bigint`. This is best-effort corroboration, not the payment-grade boundary (the Cairn
Wallet's own on-device fill-SPV in 0.2.60+ is what fails-closed before signing), but a dApp settling real
value should clear it first. The standalone `preverifyOffer({ light, client, offerId, servedOffer, pay,
plannedOutputs, me, tip, fillTargetId })` takes an injected light client + tx reader for custom wiring; `bindOfferTerms` / `feeBpsAt`
are the pure term-bind primitives, re-exported from the pinned cairnx-core (single-sourced; the former local
copies were retired when the pin began exporting them). `bindOfferTerms(servedOffer, terms)` also checks the
offer's give and want type by default, so `terms` must come from `provenOfferTerms` or from the result's
`terms` (typed `MintedProvenOfferTerms`); hand-built terms compile only with `{ give: false, wantType: false }`,
the older verdict that misses a lied-about give.

**Sign-in:** the SIWC signature proves key control ONCE. Verify it **server-side** (`verifySiwc`) and
then issue **your own** session (rotating, expiring, HttpOnly+Secure+SameSite cookie). The signature is
**never** a bearer token. The wallet binds the message's `domain` to the real page origin (you can't
spoof it), so a signature for site A can't be replayed at site B. The nonce must be at least 8 ASCII letters and
digits and nothing else (`generateNonce()` from csd-siwc makes one); `signInWithCsd` refuses another shape, such
as a UUID, with `BAD_REQUEST` before the wallet opens: the fault is in your server's nonce, not in the wallet.

## Capability / version negotiation

The provider API evolves **additively**: detect features instead of assuming them:

```ts
const wallet = await getWallet();
if (!wallet.supportsSiwc) promptUpdate();              // cheap sync boolean
const caps = await wallet.getCapabilities();            // { version, siwc, discovery, events, methods } | null
```

Old wallets degrade gracefully: `getPermissions()` → `[]`, `revokePermissions()` → `{revoked:false}`,
`on()/off()` are no-ops, `signInWithCsd()/requestPermissions()` reject with `UNSUPPORTED_METHOD`.

## Typed errors

Every SDK error is a `CairnError` with a stable `code` (branch on this, not the message), a
`shortMessage`, a `docsPath`, the `version`, and `.walk()` for the cause chain.

```ts
import { SubmitInFlightError, errorCode } from "@inversealtruism/cairn-sdk";
try { await wallet.send({ to, amount }); }
catch (e) {
  if (e instanceof SubmitInFlightError) reconcile(e);   // may have been sent: never resend blindly (see below)
  else switch (errorCode(e)) {
    case "USER_REJECTED": break;                        // user closed the prompt
    case "WALLET_LOCKED": promptUnlock(); break;
    case "NOT_INSTALLED": promptInstall(); break;
    default: report(e);
  }
}
```

Codes: `NOT_INSTALLED`, `USER_REJECTED`, `WALLET_LOCKED`, `UNSUPPORTED_METHOD`, `HTTP_ERROR` (also
a 2xx body whose shape is wrong, such as a names list read that is not an array), `CONTENT_VERIFICATION`,
`CONTENT_NOT_JSON` (`content.get()` on verified bytes that are not JSON), `WALLET_TIMEOUT` (a write method
outlasted the connection timeout; see below), `WALLET_RELOADED` (the wallet was updated or reloaded under the
page; the request never reached it, and the page must reload to reach the wallet again), `INVALID_QUERY` (a
`namesPage` option outside the read's grammar; nothing was sent), `UNKNOWN`, the `LINK_*`
codes of [Links](#links-webcsd), and every wallet code below.

> **Canonical error contract:** the wallet repo's `WALLET-ERROR-CODES.md` (cairn-wallet) is the
> source of truth. `mapProviderError` and the write wrappers keep the wallet's code on the error (except
> `UNKNOWN_KIND`, which throws `UnsupportedMethodError` with `UNSUPPORTED_METHOD`, and `APPROVAL_CLOSED`, which
> throws `UserRejectedError` with `USER_REJECTED`) and classify every code listed there as of the wallet after 0.3.3 except
> `RESERVATION_UNCONFIRMED`, which the wallet returns to its approval window only: retryable (`VERIFY_UNAVAILABLE`, `OFFER_UNKNOWN`, `REVIEW_REQUIRED`,
> `SEAL_NOT_MINED`, and `WALLET_UNAVAILABLE` on `connect` and `getAddress`: nothing was sent), in flight
> (`SUBMIT_MAYBE_INFLIGHT`, `SUBMIT_DUPLICATE`, and `WALLET_UNAVAILABLE` on a write method: `send`,
> `fillOffer`, `propose`, `attest`, `sealClaim`, `revealClaim`), and final (every other code, including
> `OFFER_SOURCE_CONFLICT`, `FILL_LEGACY_SUNSET`, `VERIFY_HORIZON`, `VERIFY_UNREPRESENTABLE`,
> `RESERVATION_DENIED`, `RPC_BLOCK_MISMATCH`, `FILL_IN_PROGRESS`, `SEAL_UNKNOWN` and `FILL_ALREADY_SENT`;
> `retryable: false`). `SEAL_UNKNOWN`: `revealClaim` named a txid this account holds no sealed claim for; reveal
> from the account that sealed it. The wallet sends that code from its release after 0.3.3; 0.3.3 sends the same
> refusal without a code, which reads `UNKNOWN`. `FILL_ALREADY_SENT` comes with the wallet's next release: this
> account's earlier fill of the same offer or reservation was sent less than 30 minutes ago and is not seen
> applied; nothing was signed. Do not ask again on a timer: look the earlier fill up, and let the user ask again
> once it confirms, or after the 30 minutes if it did not go through (the earlier fill can still be mined after
> them). Wallets 0.3.2 and 0.3.3 refuse only the partial offer-id case of a repeated fill, as
> `VERIFY_UNAVAILABLE`, which this SDK marks retryable, so a program that retries `VERIFY_UNAVAILABLE` meets it
> again on each try; they sign a repeated whole-offer or reservation fill. The wider refusal comes with the next
> wallet release. Under CommonJS, an error thrown by a `Chain` taken from `@inversealtruism/cairn-sdk/chain` is not
> `instanceof` the root entry's classes (each CommonJS entry carries its own copy): branch on `e.code` and
> `e.maybeSent`, or take `Chain` and the error classes from the same entry. `FILL_IN_PROGRESS`
> means another fill request for the same offer or reservation is open in the wallet, queued or being sent; this
> one was not queued and nothing was signed for it. Ask again only after the first is answered, and if the first
> was sent, check that purchase before paying again. An in-flight error is a `SubmitInFlightError` (`maybeSent: true`, `retryable: false`)
> carrying the txid when the wallet knows it: check the chain or the balance before you send again, never retry
> blindly. `WALLET_UNAVAILABLE` on a write means the page lost the wallet's reply, which can happen after the
> wallet submitted the approved transaction. A write that outlasts the connection timeout (10 minutes by
> default; `new WalletConnection(provider, { timeoutMs })`) rejects the same way with code `WALLET_TIMEOUT` and
> no txid, since the request may still be open in the wallet and be sent if the user approves it. Have the user
> reject it in the wallet before you send again: checking the chain alone leaves it open, and approving it and a
> resend sends twice. The key-backed `cairn.chain.send` reads its submit with the exported `classifySubmit`
> and throws the same error, carrying the signed transaction as `nodeJson`, when
> no verdict came (code `SUBMIT_MAYBE_INFLIGHT`: no answer, a timeout, a 5xx or any status other than 400, 413
> and 429, a 2xx body without the node's own `ok`, or an `ok: false` without the node's `err` text) and when the
> node answers "already present" (code
> `SUBMIT_DUPLICATE`: a node holds these bytes). Once the chain shows it did not land, resend it with
> `cairn.chain.submit(e.nodeJson)` (the same coins under the same txid, so it cannot pay twice) rather than a new
> send, which may select other coins. A refused answer to that resend decides nothing (if the first copy was mined
> in between, the node answers "missing utxo"): look the txid up. HTTP 400, 413 or 429 throws a final `CairnError`
> with code `SUBMIT_REJECTED` and no `nodeJson`: cairn-substrate.com answers 400 (its body cap) and 429 (its rate
> limit) before it forwards a submit, and nginx or Cloudflare answer a body cap with 413, so nothing was broadcast.
> Behind a front of your own that can answer one of these after forwarding, keep the bytes yourself: build with
> `cairn.chain.send({ ..., broadcast: false })`, submit with `cairn.chain.submit(nodeJson)`, read the outcome with
> `classifySubmit`, and treat a `rejected` verdict that carries `status` as in flight. The node's own refusal
> resolves `ok: false` with the node's answer in `submitResult`. A code the
> wallet sends that this SDK release does not list yet is kept on the error as sent (`errorCode(e)` returns it),
> final, with the wallet's message, so you can branch on a newer wallet's code before the SDK lists it; the
> `CairnErrorCode` type admits any string for that reason. A reply that names a code only the SDK assigns
> (`WALLET_TIMEOUT`, `NOT_INSTALLED`, `HTTP_ERROR`, `CONTENT_VERIFICATION`, `CONTENT_NOT_JSON`, `UNKNOWN`) is
> not the wallet's and reads `UNKNOWN`. The wallet's `WALLET_RELOADED:` reply becomes code `WALLET_RELOADED`
> whether it carries that code or none (wallet 0.3.2 sends none).

## Links (`web+csd:`)

A `web+csd:` link names a CNS name, optionally with a path: `web+csd:alice` or `web+csd:alice/blog/post-1`. A link
opens that name's page and authorizes nothing: it carries no action, amount, address, query or fragment, and a
handler must not read one into it. Nothing in this section makes a request.

```ts
import { parseCsdLink, formatCsdLink, csdLinkToHttps } from "@inversealtruism/cairn-sdk";
const r = parseCsdLink(input);              // { ok: true, name, path? } or { ok: false, code, reason }; it does not throw
if (r.ok) open(csdLinkToHttps(r, "https://cairn-substrate.com"));  // https://cairn-substrate.com/names#/name/alice
formatCsdLink({ name: "alice", path: "blog" });                     // "web+csd:alice/blog"
```

Grammar (ABNF, RFC 5234; the quoted scheme is case-insensitive):

```
csd-link   = "web+csd:" name [ "/" path ]
name       = 1*32( ALPHA / DIGIT / "-" )   ; ASCII-lowercased, then cairnx-core's isName
path       = segment *( "/" segment )      ; at most 256 characters, case kept
segment    = *"." safe *( safe / "." )     ; not empty and not made only of dots
safe       = ALPHA / DIGIT / "-" / "_" / "~"
```

- The name is checked with cairnx-core's `isName` (lowercase ASCII letters, digits and inner hyphens, 1 to 32
  characters, not reserved) after only A-Z is folded to lowercase, so a non-ASCII look-alike (U+212A KELVIN SIGN,
  Cyrillic letters) is refused, never mapped onto an ASCII name. `parseCsdLink` returns the name lowercase.
- The path holds only RFC 3986 unreserved characters, so it is valid as it stands in a URL path or fragment and has
  nothing to decode. Percent-encoding, an empty segment (a leading, doubled or trailing slash) and a `.` or `..`
  segment are refused.
- The `web+csd://` form is refused. The whole input is at most 297 characters (8 + 32 + 1 + 256), checked first.
- White space is refused anywhere, including around the link. A browser strips it before a handler sees the link;
  a page that parses pasted or scanned text trims it first.
- A browser's `registerProtocolHandler` hands the link percent-encoded in place of `%s`; decode it once (for example
  with `URLSearchParams`) and pass the result to `parseCsdLink`.
- `formatCsdLink` takes the name in the lowercase form `parseCsdLink` returns, so `parseCsdLink(formatCsdLink(x))`
  gives back `x`; it throws a `CairnError` with the code below for anything `parseCsdLink` would not return. It
  reads `name` and `path` once and writes the values it checked.
- `csdLinkToHttps(link, origin)` is the https page of the same name and path, to show beside every `web+csd:` link:
  `<origin>/names#/name/<name>[/<path>]`. There is no default origin. `origin` is read with `new URL(String(origin))`
  and refused with `LINK_ORIGIN` unless that URL is https with no credentials, no path other than `/` and no query
  or fragment; a form URL parsing reduces to that is taken (surrounding white space, backslashes, an empty `?` or
  `#`, a path such as `/a/..`). The output is that URL's origin followed by `/names#/name/...`. An `http://` base,
  such as a local front door at `http://127.0.0.1`, is refused.

| Code | Refused |
|---|---|
| `LINK_SCHEME` | not a string, or not starting with `web+csd:` |
| `LINK_AUTHORITY` | `web+csd://...` |
| `LINK_QUERY` | a `?` or `#` anywhere after the scheme |
| `LINK_NAME` | a name `isName` refuses after the fold (empty, too long, a character outside a-z 0-9 -, reserved) |
| `LINK_PATH` | a path outside the grammar or over 256 characters |
| `LINK_TOO_LONG` | an input over 297 characters |
| `LINK_ORIGIN` | `csdLinkToHttps` with an origin that is not https, or carries a path, query, fragment or credentials |

`test/vectors/csd-link.json` holds the accepted and refused cases, each refusal with its code.

## Versioning & dependency hygiene

- The SDK is **0.x**: minor versions may change the API until 1.0 (semver: 0.y.z makes no
  compatibility promise). Read the changelog before upgrading.
- **In apps: pin exactly** (`"@inversealtruism/cairn-sdk": "0.8.0"`) and commit your lockfile.
  **In libraries that depend on the SDK: use a range** (`^0.8.0`; on 0.x a caret stays inside one minor) to avoid duplicate installs.
- The low-level **`@inversealtruism/csd-*` packages are versioned independently**, so their numbers differ.
  If you depend on more than one, pin each exactly and make sure your lockfile resolves a single
  `@inversealtruism/csd-codec` and a single `@inversealtruism/csd-crypto` (a codec that *signs* must be the
  one that *verifies*). The SDK's own pins in `package.json` are a known-good set.
- Pre-release / dormant builds are published under the `next` / `beta` dist-tag, so `npm i` (which
  resolves `latest`) never picks them up by accident.

## Getting CSD for development

There is no faucet and no public testnet. Reads need no CSD, so most of a dApp can be built against
mainnet reads. Anything that signs a transaction spends real mainnet CSD from the user's wallet; to
exercise those paths you need CSD from an existing holder. The wallet can also point at a local node.
