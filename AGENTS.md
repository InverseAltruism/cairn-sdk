# cairn-sdk

> Onboarding briefing for coding agents and contributors working on this repo. `AGENTS.md` is the canonical briefing; `CLAUDE.md` is a symlink to it. Production hosting and operations specifics are intentionally out of scope here and maintained privately.

`@inversealtruism/cairn-sdk` (npm; the version is in `package.json`) is the Compute Substrate dApp kit: the single umbrella package a third party installs to build on CSD/Cairn. It composes the published low-level `@inversealtruism/csd-*` primitives (from the csd-sdk monorepo) behind one `Cairn` facade:

- `cairn.wallet`: connect the Cairn Wallet extension (window.cairn), clear-signed writes; keys never leave the extension
- `cairn.chain`: node RPC, tx builders, verifying LightClient (re-exports csd-client/tx/codec/crypto/light)
- `cairn.index`: L2 indexer (Esplora REST + merkle proofs + SSE/WS)
- `cairn.content`: self-certifying content (sha256 verified client-side)
- `cairn.registry`: L3 peer/gateway/identity resolution
- `cairn.names`: .csd names + CairnX market READS

It also owns the dApp-facing wallet API contract (src/connect.ts CairnProvider) and the client half of SIWC (Sign in with CSD; server verification is `@inversealtruism/csd-siwc`). Position: csd-sdk = chain primitives (the "ethers" layer); cairn-sdk = the "wagmi + service clients" layer. The repo doubles as the ecosystem's live browser E2E rig (scripts/ harnesses driving the production site + wallet).

## Cross-repo standard

This repo follows the maintainers' cross-repo engineering standard (a private document). The rules that matter for a contributor here:

- One home per concept: consensus values (NAME_RE, RESERVED_NAMES, fee constants, codec shapes) come from the published csd-sdk packages and are never re-declared here.
- TypeScript `strict` with `noUncheckedIndexedAccess`, no `@ts-ignore`, `any` only at a parse boundary. Money is integer base units (`bigint`), never floats. No empty `catch {}`; on money paths no catch-and-continue that hides a failure, and error text says what happened.
- Tests check behaviour at boundaries. A fix ships with a test that fails without it, plus an assertion that the honest path still passes with the call shape production sends. A skipped test names its reason and when it un-skips. `pnpm test` is offline; anything that touches mainnet is `test:live` or an e2e script.
- Comments state constraints and non-obvious invariants, not history or audit IDs. Removing code needs the same evidence as adding it.
- Docs: this file holds what stays true (no version tables, no status snapshots; versions live in `package.json` and tags, live state comes from a live query). Dates are absolute, no em dashes.

Known deviations (checked 2026-10-11, not exhaustive): `test/spv-checkpoint.test.ts` and `scripts/verify-tarball.mjs` read the sibling cairn checkout (`../cairn`, `CAIRN_REPO` or `CAIRN_SWAPGUARD`); the wallet-connector e2e builds against `../cairn-wallet`; there are no `typecheck` or `lint` scripts (CI runs `pnpm exec tsc --noEmit` directly); the heavy comment blocks and audit IDs in `src/` are trimmed per module, not as drive-by edits.

## The stack around it

Everything defaults to the hosted public bases at https://cairn-substrate.com: RPC proxy /api/rpc, SPV headers /api/headers, content /content, indexer proxy /explorer/api, names /trade/api/cairnx/*. Those are reverse proxies in front of the node, the csd-indexer, and the cairnx names/market resolver; every base is overridable via CairnConfig for self-hosted setups. The chain is the only source of truth; every read carries an honest trust level (docs/SDK-GUIDE.md has the verifies-vs-trusts table).

## Architecture

`src/` is built by tsup to esm+cjs+dts with 8 entry points (the `build` script lists them):

- `index.ts`: Cairn facade, CairnConfig, DEFAULT_SPV_CHECKPOINT (height and hash are in the source), and the lazy PoW-verified header wiring into the indexer via `seededSpvLight`: a forward sync from the checkpoint to the tip through a BATCH header provider over the cairn server's /api/headers, with a per-attempt timeout deliberately above the server's 10 s route deadline; a few batched requests, never a per-height flood; fail-soft to on-demand sync. Cross-origin reach of that provider depends on the cairn server's CORS mount on /api/headers. The checkpoint is picked in cairn (`bump-swapguard-cp.mjs`) and copied here in the same cycle; it is never a unilateral SDK edit, and `test/spv-checkpoint.test.ts` reds on drift. Verification only runs forward from the anchor, so `index.verifyInclusion` for a tx confirmed below the checkpoint returns `proof-consistent`, not `verified-inclusion` (fail-closed, never an over-claim). A dApp that refuses anything below `verified-inclusion` starts refusing those reads when the anchor moves; `config.spvCheckpoint` keeps an older anchor. Every checkpoint move names the affected band in the CHANGELOG.
- `connect.ts`: CairnProvider typed contract, detectProvider/discoverProviders (csd:announceProvider discovery), WalletConnection (connect/getAddress/signInWithCsd/send/propose/attest/fillOffer/sealClaim/revealClaim/permissions/events).
- `indexer.ts`: REST + verifyInclusion(txid) with TrustLevel = verified-inclusion | proof-consistent | not-found (+ equivocation flag), SSE-over-fetch with reconnect + 1MiB buffer cap, WS subscribe.
- `content.ts`: prepare/put/hash, verified get/getBytes (source order swarm -> indexer -> cairn origin), hash format gated against path-walk.
- `names.ts`: NamesClient over /trade/api/cairnx/*; inputs pre-validated with cairnx-core NAME_RE + RESERVED_NAMES.
- `chain.ts`: tip/utxos/submit/light(); Chain.send() = key-backed send via buildSendVerified + verifyInputValues (fail-closed).
- `registry.ts`, `controller.ts` (framework-agnostic reactive store; spoofed-accountsChanged adoption guard), `react.ts` (createCairnHooks(React), zero react dependency), `errors.ts` (CairnError hierarchy with stable codes; SDK_VERSION manually kept == package.json, test-enforced), `http.ts` (15s timeout, 16MiB streamed byte cap, idempotent-GET-only retries).

docs/SDK-GUIDE.md (third-party guide incl. the verifies-vs-trusts table), examples/ (read-only, wallet-connect, siwc-login, node-signer, hello-csd, register-swarm-peer [historical; swarm L1 is dead]), scripts/ (esbuild example build + 6 maintainer-run live E2E harnesses: scripts/live-wallet-ui.mjs, scripts/names-e2e.mjs, scripts/names-buy-e2e.mjs, scripts/ux-live-readonly.mjs, scripts/ux-openlane-buy.mjs, scripts/wallet-send-spv-e2e.mjs).

Deps: exact-pinned in `package.json`, which is the single source for every version and pin (csd-siwc is a devDependency). `src/fillverify.ts` imports `feeBpsAt`, `bindOfferTerms` and `provenOfferTerms` from cairnx-core (no local copies; the ProvenOfferTerms interface and producer are single-sourced and corpus-equivalence-pinned by test/proven-terms-corpus.test.ts). It exports the `preverifyOffer` helper and the throw-on-nested-refusal write wrapper. The opt-in binds are ON: the 3-arg branded `bindOfferTerms` binds the give legs with a symmetric want-type refusal, the opt-in sums seam runs over the discriminated `fillOutputPlan`, and `fillEndorsement`/`fillOutputPlan` are the successors (deprecated `fillIsSafe`/`requiredFillOutputs`/`previewFill` stay exported, behavior-frozen; `fillEndorsement`'s not-endorsable verdict means PROCEED-unendorsed, never a refusal of an honest token fill).

## Invariants and red lines

- Connection never pre-approves signatures: connect/getAddress are the only silent-after-consent calls; every signing method opens the wallet's clear-sign window (extension-enforced). Never imply otherwise in docs.
- DEFAULT_SPV_CHECKPOINT MUST stay byte-identical to cairn/public/trade/swapguard.js's baked anchor (test/spv-checkpoint.test.ts enforces). The cairn repo keeps one more copy of the same number in its ops files; the parity test does not cover it, so check it in the cairn repo when the anchor moves.
- Never over-claim trust levels: verified-inclusion requires a PoW-verified header; same-origin proxy setups honestly degrade to proof-consistent.
- cairn.names.* and registry.resolveName() are SERVER-TRUSTED display reads. Never wire them straight into a payment target; payment-grade resolution is the wallet's on-device SPV path. (Trust-model note, evident from public source: the `fillOffer` provider call remains resolver-trusted AT THE SDK LAYER; `preverifyOffer`/fillverify (F13 + the B7b binds) is the diligent dApp's merkle-proven corroboration, fail-closed on a positive mismatch and fail-soft on an unreachable chain view, and the wallet's own on-device fill-SPV is the payment-grade boundary.)
- SDK_VERSION in src/errors.ts bumps together with package.json.
- csd-* deps exact-pinned, no carets.
- Content bytes hashed raw; the 16MiB cap and merkle-proof shape validation (fail-closed to not-found) must not be removed.
- Operator-token endpoints are deliberately never used; a dApp acts as the user.
- Legacy signIn() is first-party-only and @deprecated; third parties use SIWC.
- Consensus values (NAME_RE, RESERVED_NAMES, fee constants, codec shapes) always come from the published csd-*/cairnx-core packages; never re-declare them locally.
- Security fixes must not regress UX: never add complexity, latency, or spurious declines to a legitimate hot path in the name of hardening.
- House style: no em dashes in any doc (`grep -cP '\x{2014}' <file>` prints 0); keep prose concrete, no filler.
- Releasing is a maintainer action: contributors do not bump versions, tag, or publish; maintainers publish to npm (see Release and publish).

## Dev workflow

Package manager is pnpm (packageManager pnpm@10.32.1). `pnpm-lock.yaml` is the single authoritative lockfile: CI runs `pnpm install --frozen-lockfile` and the dep-pin gate parses `pnpm-lock.yaml` directly. The old stray `package-lock.json` (W-K1: a second, npm lockfile that had drifted to 0.2.3 while the package was 0.2.4, a supply-chain ambiguity) was removed 2026-07-17; do not re-add an npm lockfile. If you must inspect deps with npm, use `npm install --package-lock-only` in a scratch copy, never commit the result.

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm build                      # tsup, 8 entrypoints
pnpm test                       # offline unit suites (tsx)
pnpm test:live                  # examples/read-only.mjs vs live mainnet
pnpm build:example              # esbuild JS API (NOT the CLI shim; it ELF-errors under pnpm)
```

## Testing

Three layers (test/e2e/README.md), all against built dist/:
- Unit (pnpm test = `test/run.mjs`, offline): a GLOB runner that discovers every test/*.test.{ts,mjs}, runs ALL even after a failure, applies a per-file timeout, and classifies SKIP instead of miscounting it (it replaced a fail-fast hand-maintained `&&` chain that once hid 69 assertions behind one red suite). `ls test` is the suite list. `test/runner-guards.test.mjs` (the guard-of-the-guard) drives the REAL runner against throwaway sandboxes, including the 3-file middle-fails fixture proving a mid-suite failure still runs the rest AND forces a non-zero exit. `test/spv-checkpoint.test.ts` prints UNCHECKED, and does not fail, when no cairn checkout is found (the public CI has none); `CSD_SDK_REQUIRE_PARITY=1` turns that into a failure.
- Live read (pnpm test:e2e:read): every read surface vs mainnet + adversarial cases; `CAIRN_BASE` points it at another front door.
- Wallet connector (pnpm test:e2e:wallet): real Chromium + the real built ../cairn-wallet/dist extension under Xvfb via playwright-core; proves silent repeat-connect and that send STILL prompts.
scripts/*.mjs live harnesses are maintainer-run only (some spend CSD). scripts/live-wallet-ui.mjs (added @76a0a10) is the read-only one: headed Chrome + real MV3 extension vs the production site; approves ONLY the non-spend Connect, reads then REJECTS every fund/fee-bearing clear-sign popup, captures screenshots. test/e2e/ also holds the e2e-siwc.mjs helper beyond the three canonical layers.

## Release and publish

Maintainers publish to npm (public access) manually, with a transient npm token via a mktemp --userconfig deleted immediately; tokens are never stored and CI has NO publish job on purpose. The npm 2FA-bypass token cannot publish, so the sanctioned path is `pnpm pack` then publishing the tarball. `prepublishOnly` = build + test and `prepack` = build; `pnpm pack` does NOT fire `prepublishOnly`, and no hook fires when a pre-made tarball is published, so without `prepack` the pack could ship whatever stale bytes were in the untracked `dist/`. The authoritative gate is `node scripts/verify-tarball.mjs [tgz]` (repo-only, excluded from `files`): it prints the tarball sha256 and asserts the PACKED `dist/index.js` carries the ASDK-1 `fetch failed` arm and a `DEFAULT_SPV_CHECKPOINT` byte-equal to cairn's `public/trade/swapguard.js` CP, resolved via `CAIRN_SWAPGUARD` / `CAIRN_REPO` / `../cairn`. An absent sibling FAILS it (exit 1), never skips. Do NOT claim `test/spv-checkpoint.test.ts` gates publishing: it is not in the pre-made-tarball path. Release ritual: bump version + SDK_VERSION + re-pin csd-*/cairnx-core to published versions, tag vX.Y.Z, push. The version history is the CHANGELOG and the `v*` tags.

## Gotchas and incident history

- CI dep-pin gate (RESOLVED in 0.2.2, 2026-07-10): the old ci.yml gate demanded all @inversealtruism/csd-* pins be ONE uniform version, which is structurally impossible under independent per-package versioning, so it could never pass. Reworked to per-package EXACT-semver hygiene over every @inversealtruism/* (now including cairnx-core, which the old name filter excluded); cross-repo freshness is delegated to csd-sdk scripts/check-consumer-pins.mjs (which grades cairn-sdk as a helpers-only-lag advisory).
- Pin drift (RESOLVED in 0.2.2, kept current since): `package.json` is the only source of pins. Do NOT re-pin outside a release, and never "correct" package.json to an older number from a stale doc.
- Stale lockfile (found at 0.4.2): the lockfile had been stale since the 0.4.0 release, so `package.json` pinned newer cairnx-core, csd-codec, csd-light and csd-registry versions than `node_modules` carried. Every green result that certified 0.4.1 and 0.4.2, including the ASDK-1 parity corpus, had run against the wrong dependency graph, and `tsc` could not catch it because those `.d.ts` files are identical. Check the lockfile against `package.json` before trusting a suite; CI installs with `--frozen-lockfile` and asserts a single csd-codec and csd-crypto copy.
- The SDK originally shipped with no CI at all, and pin drift went unnoticed until review caught it. Don't remove the gates.
- SSE through a buffering reverse proxy needs `X-Accel-Buffering: no` from the origin (the hosted proxy sets it); WS subscribe still needs a direct indexer URL because the hosted proxy is REST+SSE only.
- esbuild CLI shim ELF-errors under pnpm; scripts/build-example.mjs uses the JS API, keep it that way.
- Hardening lineage in code comments (all remediated; the markers explain why the guards exist): M3 (no over-claimed verified-inclusion), H2/UTXO-VALUE-1 (Chain.send verified inputs), CAIRNSDK-DESER-1/3/4 (buffer caps, proof pre-validation), CAIRNSDK-VP-4 (submit rejection folded into ok), CONNECT-1/CTRL-ADOPT-1 (no forged-account adoption), F11 (ghost-reconnect).
- mapProviderError and the write wrappers classify every code in WALLET-ERROR-CODES.md (the wallet repo's canonical contract) as retryable, in flight or final; add a new wallet code to `src/errors.ts` and `test/errors.test.ts` when the wallet adds one.
- Large-tx submits: the hosted RPC proxy at cairn-substrate.com once rejected very large multi-input submits to POST /api/rpc/tx/submit with HTTP 400 before the tx reached the node, because of a 64KB body cap (hit at roughly 127+ inputs). The cairn server now has a scoped 512KB cap on that route. Symptom on a server that lacks it: a big Chain.send()/submit 400s with no node-side error. Suspect the proxy body cap on the server you target before blaming the SDK.

## Cross-repo map

Depends on the published `@inversealtruism/csd-*` / `@inversealtruism/cairnx-core` packages from the csd-sdk monorepo (exact pins, installed from npm). Contract couplings: cairn-wallet's window.cairn provider (connect.ts is the dApp-side contract; WALLET-ERROR-CODES.md in the cairn-wallet repo), the cairn server endpoints (/api/rpc, /api/headers, /content, /explorer/api, /trade/api/cairnx/*), and the SPV checkpoint literal duplicated with cairn/public/trade/swapguard.js (test-enforced). The wallet-connector E2E builds against a sibling ../cairn-wallet checkout (override with WALLET_EXT).

## Docs

| Doc | Holds |
|---|---|
| `README.md` | what the package is, install, quick start |
| `docs/SDK-GUIDE.md` | third-party developer guide, including the verifies-vs-trusts table |
| `CHANGELOG.md` | one entry per release; every SPV checkpoint move names the affected band |
| `test/e2e/README.md` | the four test layers and how to run them |
| `.githooks/README.md` | the secret-scan pre-commit hook |

The wallet error code contract is `WALLET-ERROR-CODES.md` in the cairn-wallet repo. The cross-repo standard is a private document; the summary above is the part that binds a contributor here.
