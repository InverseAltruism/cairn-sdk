# Cairn SDK: third-party developer guide

`@inversealtruism/cairn-sdk` is the dApp kit for the Compute Substrate (CSD) chain + the Cairn Wallet:
wallet connection, audience-bound auth ("Sign in with CSD"), chain reads with a verifying light client,
the signal board, the indexer, content, and registries. Framework-agnostic core + an optional React
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
const top = await cairn.board.top({ domain: "cairn:quests" });

const { wallet, address } = await connect();              // prompts the user once per origin
await cairn.board.support(top[0].id, { confidence: 100 });// wallet clear-signs every signature
```

Sign-in (passwordless): see `examples/siwc-login.mjs` for the full client + server flow.

## Subpath exports (tree-shakeable)

| Import | What |
|---|---|
| `@inversealtruism/cairn-sdk` | the `Cairn` facade + connectors + types |
| `…/connect` | `connect` / `getWallet` / `detectProvider` / `discoverProviders` |
| `…/controller` | `CairnController`: framework-agnostic reactive connection store |
| `…/react` | `createCairnHooks(React)`: React hooks (zero react dependency; you pass React) |
| `…/chain` | `CsdClient`, tx builders, the verifying `LightClient` |
| `…/indexer`, `…/board`, `…/content`, `…/registry` | service clients |
| `@inversealtruism/csd-siwc` | **server-side** SIWC verify (`verifySiwc`, `generateNonce`) |

## What the SDK verifies vs trusts (read this)

The honest trust model: funds are safe even against a malicious RPC, because **the wallet signs
locally and the user clear-signs every signature**; a bad RPC can mislead *display*, not move funds.

- **Verified (cryptographic):** transaction signing + sighash (in the wallet); `LightClient` tx
  *inclusion* (Merkle branch folded against a **PoW-verified** header it re-derives LWMA difficulty
  for, anchored to a baked checkpoint); content self-certification (`sha256(bytes) == payloadHash`);
  SIWC sign-ins (domain + nonce + chain + time + signature + `hash160(pub)==account`).
- **RPC-trusted (display only):** balances / UTXO sets / history / prices. CSD headers carry no UTXO
  commitment, so non-spend can't be proven from headers, so `LightClient.balance()` is tagged
  `rpc-trusted` and never hides that. Verify what matters; treat balances as a hint.
- **Indexer = untrusted derived view:** the `IndexerClient` re-folds Merkle proofs
  (`verifyInclusion`); it's a prover, not an authority.

**Filling an offer (F13, diligent-dApp pre-verify):** `fillOffer` is resolver-trusted at this SDK layer:
the SDK does NOT SPV-verify the `outputs` you hand the wallet, so a lying resolver could redirect the
payment. Before you build those `outputs`, corroborate the offer on-chain with
`await cairn.verifyOfferForFill(offerId, servedOffer, { pay, plannedOutputs })`. It merkle-proves the offer's
Propose into the PoW-verified header chain (from the pinned SPV checkpoint), binds the record to its on-chain
commitment, derives the payment recipient + seller from the offer's on-chain author (the funding input's
prevout owner, not the malleable scriptSig), and, when you pass the resolver-served `offer`, binds its
payto/seller + fee/rebate/partial terms to the proven ones. It refuses a Propose outside the `cairnx:v1`
settlement domain, binds a token-priced offer's served `want.ticker`/`want.amount` verbatim to the record,
and refuses a served offer whose `want.payto` or `seller` is absent (the reason names the missing field, so
pass the resolver's full offer object or omit `servedOffer`).

Pass `opts.pay` (the CSD base units you intend to pay) to receive the PROVEN `outputPlan` for a whole fill of
a non-partial offer, and `opts.plannedOutputs` (your planned per-address sums) to bind them to that plan
before signing. It returns a trust-labeled `OfferFillCheck` (`{ ok, trust, payto, seller, terms, reason,
transient, outputPlan }`): fail-closed on a positive mismatch, fail-soft (`transient`) on a lagging or
below-checkpoint chain view. Build EXACTLY the `outputPlan`, never the resolver-served outputs a lying
resolver could redirect. This is best-effort corroboration, not the payment-grade boundary (the Cairn
Wallet's own on-device fill-SPV in 0.2.60+ is what fails-closed before signing), but a dApp settling real
value should clear it first. The standalone `preverifyOffer({ light, client, offerId, servedOffer, pay,
plannedOutputs })` takes an injected light client + tx reader for custom wiring; `bindOfferTerms` / `feeBpsAt`
are the pure term-bind primitives, re-exported from the pinned cairnx-core (single-sourced; the former local
copies were retired when the pin began exporting them).

**Sign-in:** the SIWC signature proves key control ONCE. Verify it **server-side** (`verifySiwc`) and
then issue **your own** session (rotating, expiring, HttpOnly+Secure+SameSite cookie). The signature is
**never** a bearer token. The wallet binds the message's `domain` to the real page origin (you can't
spoof it), so a signature for site A can't be replayed at site B.

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
import { errorCode } from "@inversealtruism/cairn-sdk";
try { await wallet.send({ to, amount }); }
catch (e) {
  switch (errorCode(e)) {
    case "USER_REJECTED": break;                        // user closed the prompt
    case "WALLET_LOCKED": promptUnlock(); break;
    case "NOT_INSTALLED": promptInstall(); break;
    default: report(e);
  }
}
```

Codes: `NOT_INSTALLED`, `USER_REJECTED`, `WALLET_LOCKED`, `UNSUPPORTED_METHOD`, `HTTP_ERROR`,
`CONTENT_VERIFICATION`, `UNKNOWN`.

> **Canonical error contract:** the wallet repo's `WALLET-ERROR-CODES.md` (cairn-wallet) is the
> source of truth. `mapProviderError` and the write wrappers keep the wallet's code on the error and
> classify every code listed there as of wallet 0.2.73: retryable (`VERIFY_UNAVAILABLE`, `OFFER_UNKNOWN`,
> `WALLET_UNAVAILABLE`, `REVIEW_REQUIRED`: nothing was signed), in flight (`SUBMIT_MAYBE_INFLIGHT`,
> `SUBMIT_DUPLICATE`: a `SubmitInFlightError` carrying the txid to reconcile, never retry blindly), and
> final (every other code, including `OFFER_SOURCE_CONFLICT`, `FILL_LEGACY_SUNSET`, `VERIFY_HORIZON` and
> `VERIFY_UNREPRESENTABLE`; `retryable: false`). A code the SDK does not know yet still throws, as a final
> error with the wallet's message.

## Versioning & dependency hygiene

- The SDK is **0.x**: minor versions may change the API until 1.0 (semver: 0.y.z makes no
  compatibility promise). Read the changelog before upgrading.
- **In apps: pin exactly** (`"@inversealtruism/cairn-sdk": "0.2.1"`) and commit your lockfile.
  **In libraries that depend on the SDK: use a range** (`^0.2.1`) to avoid duplicate installs.
- The low-level **`@inversealtruism/csd-*` packages are versioned independently**, so their numbers differ.
  If you depend on more than one, pin each exactly and make sure your lockfile resolves a single
  `@inversealtruism/csd-codec` and a single `@inversealtruism/csd-crypto` (a codec that *signs* must be the
  one that *verifies*). The SDK's own pins in `package.json` are a known-good set.
- Pre-release / dormant builds are published under the `next` / `beta` dist-tag, so `npm i` (which
  resolves `latest`) never picks them up by accident.

## Testnet & faucet

cairn serves a scarcity-honest faucet at `/faucet` for development CSD. (A dedicated public testnet
network id + endpoint is operator-provisioned; until then, develop against mainnet reads + the faucet,
and use the wallet's RPC switcher to point at a local node.)
