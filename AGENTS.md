# cairn-sdk

> Onboarding briefing for coding agents and contributors working on this repo. `AGENTS.md` is the canonical briefing; `CLAUDE.md` imports it, so edit `AGENTS.md` only and keep them in sync that way. Production hosting and operations specifics are intentionally out of scope here and maintained privately.

`@inversealtruism/cairn-sdk` (npm; version state is ephemeral, see the dated State snapshot at the bottom) is the Compute Substrate dApp kit: the single umbrella package a third party installs to build on CSD/Cairn. It composes the published low-level `@inversealtruism/csd-*` primitives (from the csd-sdk monorepo) behind one `Cairn` facade:

- `cairn.wallet`: connect the Cairn Wallet extension (window.cairn), clear-signed writes; keys never leave the extension
- `cairn.chain`: node RPC, tx builders, verifying LightClient (re-exports csd-client/tx/codec/crypto/light)
- `cairn.board`: signal board + work graph (reads; wallet-signed propose/support writes)
- `cairn.index`: L2 indexer (Esplora REST + merkle proofs + SSE/WS)
- `cairn.content`: self-certifying content (sha256 verified client-side)
- `cairn.registry`: L3 peer/gateway/identity resolution
- `cairn.names`: .csd names + CairnX market READS

It also owns the dApp-facing wallet API contract (src/connect.ts CairnProvider) and the client half of SIWC (Sign in with CSD; server verification is `@inversealtruism/csd-siwc`). Position: csd-sdk = chain primitives (the "ethers" layer); cairn-sdk = the "wagmi + service clients" layer. The repo doubles as the ecosystem's live browser E2E rig (scripts/ harnesses driving the production site + wallet).

## The stack around it

Everything defaults to the hosted public bases at https://cairn-substrate.com: board /api, RPC proxy /api/rpc, indexer proxy /explorer/api, names /trade/api/cairnx/*. Those are reverse proxies in front of the node, the csd-indexer, and the cairnx names/market resolver; every base is overridable via CairnConfig for self-hosted setups. The chain is the only source of truth; every read carries an honest trust level (docs/SDK-GUIDE.md has the verifies-vs-trusts table).

## Architecture

src/ (12 files, ~2,200 lines), built by tsup to esm+cjs+dts with 9 subpath exports:

- `index.ts`: Cairn facade, CairnConfig, DEFAULT_SPV_CHECKPOINT {height: 38142, hash: 0x00000000000140f0...}, lazy PoW-verified header wiring into the indexer via `seededSpvLight` (B7c/W12: the checkpoint..tip forward sync actually RUNS now, through a BATCH header provider over the cairn server's /api/headers with a per-attempt timeout deliberately above the server's 10s route deadline; a few batched requests, never a per-height flood; fail-soft to on-demand sync). Cross-origin reach of that batch provider depends on cairn's B7d CORS mount. The CP forward-bump past 38142 was deliberately NOT done unilaterally (it would red the cross-repo parity pin while swapguard still bakes 38142); a coordinated tri-repo bump (swapguard.js + this SDK + cairn/deploy/spv-checkpoint, ONE value ONE change) is a deferred runbook perf item.
- `connect.ts`: CairnProvider typed contract, detectProvider/discoverProviders (csd:announceProvider discovery), WalletConnection (connect/getAddress/signInWithCsd/send/propose/attest/fillOffer/sealClaim/revealClaim/permissions/events).
- `board.ts`: reads /api/*; writes propose() (wallet-signed + retrying POST /api/content registration) and support(). Never uses operator-token endpoints.
- `indexer.ts`: REST + verifyInclusion(txid) with TrustLevel = verified-inclusion | proof-consistent | not-found (+ equivocation flag), SSE-over-fetch with reconnect + 1MiB buffer cap, WS subscribe.
- `content.ts`: prepare/put/hash, verified get/getBytes (source order swarm -> indexer -> cairn origin), hash format gated against path-walk.
- `names.ts`: NamesClient over /trade/api/cairnx/*; inputs pre-validated with cairnx-core NAME_RE + RESERVED_NAMES.
- `chain.ts`: tip/utxos/submit/light(); Chain.send() = key-backed send via buildSendVerified + verifyInputValues (fail-closed).
- `registry.ts`, `controller.ts` (framework-agnostic reactive store; spoofed-accountsChanged adoption guard), `react.ts` (createCairnHooks(React), zero react dependency), `errors.ts` (CairnError hierarchy with stable codes; SDK_VERSION manually kept == package.json, test-enforced), `http.ts` (15s timeout, 16MiB streamed byte cap, idempotent-GET-only retries).

docs/SDK-GUIDE.md (third-party guide incl. the verifies-vs-trusts table), examples/ (read-only, wallet-connect, siwc-login, node-signer, hello-csd, register-swarm-peer [historical; swarm L1 is dead]), scripts/ (esbuild example build + 6 maintainer-run live E2E harnesses: scripts/live-wallet-ui.mjs, scripts/names-e2e.mjs, scripts/names-buy-e2e.mjs, scripts/ux-live-readonly.mjs, scripts/ux-openlane-buy.mjs, scripts/wallet-send-spv-e2e.mjs).

Deps (exact-pinned): cairnx-core 0.1.38, csd-tx 0.1.17, csd-light 0.1.18, csd-registry 0.1.16, csd-client/codec/crypto/siwc 0.1.15 (the cairnx-core re-pin to 0.1.40 rides the 0.4.0 release, runbook). src/fillverify.ts imports `feeBpsAt`/`bindOfferTerms`/`provenOfferTerms` from cairnx-core (the local copies were retired: B4b single-sourced the ProvenOfferTerms interface + producer, corpus-equivalence-pinned by test/proven-terms-corpus.test.ts); the F13 `preverifyOffer` helper and F14 throw-on-nested-refusal write wrapper landed in 0.3.0. B7b (0.4.0-to-be) FLIPS the opt-in binds ON: the 3-arg branded `bindOfferTerms` give legs + symmetric want-type refusal, the opt-in sums seam over the discriminated `fillOutputPlan`, and the `fillEndorsement`/`fillOutputPlan` successors surfaced (deprecated `fillIsSafe`/`requiredFillOutputs`/`previewFill` stay exported, behavior-frozen; `fillEndorsement`'s not-endorsable verdict means PROCEED-unendorsed, never a refusal of an honest token fill).

## Invariants and red lines

- Connection never pre-approves signatures: connect/getAddress are the only silent-after-consent calls; every signing method opens the wallet's clear-sign window (extension-enforced). Never imply otherwise in docs.
- DEFAULT_SPV_CHECKPOINT MUST stay byte-identical to cairn/public/trade/swapguard.js's baked anchor (test/spv-checkpoint.test.ts enforces).
- Never over-claim trust levels: verified-inclusion requires a PoW-verified header; same-origin proxy setups honestly degrade to proof-consistent.
- cairn.names.* and registry.resolveName() are SERVER-TRUSTED display reads. Never wire them straight into a payment target; payment-grade resolution is the wallet's on-device SPV path. (Trust-model note, evident from public source: the `fillOffer` provider call remains resolver-trusted AT THE SDK LAYER; `preverifyOffer`/fillverify (F13 + the B7b binds) is the diligent dApp's merkle-proven corroboration, fail-closed on a positive mismatch and fail-soft on an unreachable chain view, and the wallet's own on-device fill-SPV is the payment-grade boundary.)
- SDK_VERSION in src/errors.ts bumps together with package.json.
- csd-* deps exact-pinned, no carets.
- Content bytes hashed raw; the 16MiB cap and merkle-proof shape validation (fail-closed to not-found) must not be removed.
- Operator-token endpoints are deliberately never used; a dApp acts as the user.
- Legacy signIn() is first-party-only and @deprecated; third parties use SIWC.
- Consensus values (NAME_RE, RESERVED_NAMES, fee constants, codec shapes) always come from the published csd-*/cairnx-core packages; never re-declare them locally.
- Security fixes must not regress UX: never add complexity, latency, or spurious declines to a legitimate hot path in the name of hardening.
- House style: no em dashes in READMEs or user-facing docs; keep prose concrete, no filler.
- Releasing is a maintainer action: contributors do not bump versions, tag, or publish; maintainers publish to npm (see Release and publish).

## Dev workflow

Package manager is pnpm (packageManager pnpm@10.32.1). `pnpm-lock.yaml` is the single authoritative lockfile: CI runs `pnpm install --frozen-lockfile` and the dep-pin gate parses `pnpm-lock.yaml` directly. The old stray `package-lock.json` (W-K1: a second, npm lockfile that had drifted to 0.2.3 while the package was 0.2.4, a supply-chain ambiguity) was removed 2026-07-17; do not re-add an npm lockfile. If you must inspect deps with npm, use `npm install --package-lock-only` in a scratch copy, never commit the result.

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm build                      # tsup, 9 entrypoints
pnpm test                       # offline unit suites (tsx)
pnpm test:live                  # examples/read-only.mjs vs live mainnet
pnpm build:example              # esbuild JS API (NOT the CLI shim; it ELF-errors under pnpm)
```

## Testing

Four layers (test/e2e/README.md), all against built dist/:
- Unit (pnpm test = `test/run.mjs`, offline): a GLOB runner (REBIND B3/F13: discovers every test/*.test.{ts,mjs}, runs ALL even after a failure, per-file timeout, SKIP classified not miscounted; it replaced the fail-fast hand-maintained `&&` chain that once hid 69 assertions behind one red suite). Suites at this writing: sdk, connect, errors, controller, react, hardening, spv-checkpoint, names-b10, fillverify, proven-terms-corpus, w12-spv-sync, runner-guards. `test/runner-guards.test.mjs` (FU-9, the N24 guard-of-the-guard) drives the REAL runner against throwaway sandboxes, incl. the 3-file middle-fails fixture proving a mid-suite failure still runs the rest AND forces a non-zero exit.
- Live read (pnpm test:e2e:read): every read surface vs mainnet + adversarial cases.
- Wallet connector (pnpm test:e2e:wallet): real Chromium + the real built ../cairn-wallet/dist extension under Xvfb via playwright-core; proves silent repeat-connect and that send STILL prompts.
- Live write (pnpm test:e2e:write, SPENDS ~0.3 CSD, opt-in): full propose+support via examples/node-signer.mjs; needs a funded key supplied via CAIRN_KEY (default path documented in test/e2e/README.md). Mine-waits up to 20 min.
scripts/*.mjs live harnesses are maintainer-run only (some spend CSD). scripts/live-wallet-ui.mjs (added @76a0a10) is the read-only one: headed Chrome + real MV3 extension vs the production site; approves ONLY the non-spend Connect, reads then REJECTS every fund/fee-bearing clear-sign popup, captures screenshots. test/e2e/ also holds e2e-siwc.mjs and verify-pending-write.mjs helpers beyond the four canonical layers.

## Release and publish

Maintainers publish to npm (public access) manually, with a transient npm token via a mktemp --userconfig deleted immediately; tokens are never stored and CI has NO publish job on purpose. prepublishOnly = build + test. Release ritual: bump version + SDK_VERSION + re-pin csd-*/cairnx-core to published versions, tag vX.Y.Z, push. History: 0.1.0 -> 0.1.1 -> 0.1.2 (M3 PoW-verify) -> 0.1.4 -> 0.2.0 (names namespace, native wallet error codes, http hardening) -> 0.2.1 (truth pass + re-pins) -> 0.2.2 (re-pin cairnx-core 0.1.36 + csd-tx 0.1.16 + csd-light 0.1.17; CI gate reworked from uniform-version to per-package exact-pin hygiene) -> 0.2.3 (Plan 69 re-pin) -> 0.2.4 (Plan 70 R1) -> 0.3.0 (Plan 70 R2/R3: F13 preverifyOffer + F14 throw-on-nested-refusal; re-pin cairnx-core 0.1.38 + csd-tx 0.1.17 + csd-light 0.1.18) -> 0.3.1 (2026-07-18 certification campaign) -> 0.3.2 (REBIND B3: SDK_VERSION lockstep pin + the glob test runner; published). NEXT: 0.4.0 (the REBIND B4b/B7b/B7c line on branch rebind/b4b; bump + cairnx-core 0.1.40 re-pin + publish are runbook steps, superseding OP-19).

## Gotchas and incident history

- CI dep-pin gate (RESOLVED in 0.2.2, 2026-07-10): the old ci.yml gate demanded all @inversealtruism/csd-* pins be ONE uniform version, which is structurally impossible under independent per-package versioning, so it could never pass. Reworked to per-package EXACT-semver hygiene over every @inversealtruism/* (now including cairnx-core, which the old name filter excluded); cross-repo freshness is delegated to csd-sdk scripts/check-consumer-pins.mjs (which grades cairn-sdk as a helpers-only-lag advisory).
- Pin drift (RESOLVED in 0.2.2, kept current since): cairn-sdk now pins cairnx-core 0.1.38 + csd-tx 0.1.17 + csd-light 0.1.18 (the published versions as of 0.3.0). Do NOT re-pin outside a release, and never "correct" package.json to an older number from a stale doc.
- The SDK originally shipped with no CI at all, and pin drift went unnoticed until review caught it. Don't remove the gates.
- SSE through a buffering reverse proxy needs `X-Accel-Buffering: no` from the origin (the hosted proxy sets it); WS subscribe still needs a direct indexer URL because the hosted proxy is REST+SSE only.
- esbuild CLI shim ELF-errors under pnpm; scripts/build-example.mjs uses the JS API, keep it that way.
- Hardening lineage in code comments (all remediated; the markers explain why the guards exist): M3 (no over-claimed verified-inclusion), H2/UTXO-VALUE-1 (Chain.send verified inputs), CAIRNSDK-DESER-1/3/4 (buffer caps, proof pre-validation), CAIRNSDK-VP-4 (submit rejection folded into ok), CONNECT-1/CTRL-ADOPT-1 (no forged-account adoption), F11 (ghost-reconnect).
- mapProviderError maps the outer error-code set; the 13 nested wallet SubmitResult codes are documented but unmapped; WALLET-ERROR-CODES.md in the wallet repo is the canonical contract.
- Large-tx submits: the hosted RPC proxy at cairn-substrate.com historically rejected very large multi-input submits to POST /api/rpc/tx/submit with HTTP 400 before the tx ever reached the node, because of a 64KB body cap (hit at roughly 127+ inputs). The cap is being raised to 512KB on that route. Symptom: a big Chain.send()/submit 400s with no node-side error. Debugging hint: suspect the proxy body cap (and check whether the raised cap is live on the server you target) before blaming the SDK.

## State snapshot (2026-07-21, REBIND S-06; verify with git log before trusting)

Version in tree 0.3.2 on branch rebind/b4b = the staged 0.4.0-TO-BE (B4b single-source + B7b fillverify flip/surface + B7c seededSpvLight W12 sync + the FU-9 runner-guards fixture). npm has 0.3.2; tags through v0.3.2. The 0.4.0 bump, cairnx-core 0.1.40 re-pin, --ff-only merge to master, tag and publish are close-out/runbook steps (never pin an unpublished version). Suite 12/12 via test/run.mjs. MIT.

Open items (do not act without a maintainer/release ask):
- DEFAULT_SPV_CHECKPOINT tri-repo coordinated forward-bump (perf only, parity 38142 kept deliberately; see the index.ts bullet).
- The seededSpvLight batch provider is cross-origin-reachable only once cairn's B7d CORS mount is deployed (rides cairn 0.5.27 + restart).
- The hosted RPC proxy's large-submit body-cap raise (64KB -> 512KB on /api/rpc/tx/submit): shipped server-side in cairn; verify live before leaning on it (see gotchas).

## Cross-repo map

Depends on the published `@inversealtruism/csd-*` / `@inversealtruism/cairnx-core` packages from the csd-sdk monorepo (exact pins, installed from npm). Contract couplings: cairn-wallet's window.cairn provider (connect.ts is the dApp-side contract; WALLET-ERROR-CODES.md in the cairn-wallet repo), the cairn server endpoints (/api/*, /explorer/api, /trade/api/cairnx/*, POST /api/content), and the SPV checkpoint literal duplicated with cairn/public/trade/swapguard.js (test-enforced). The wallet-connector E2E builds against a sibling ../cairn-wallet checkout (override with WALLET_EXT).

Published dependency versions as of 2026-07-17 (verify on npm before trusting): cairnx-core 0.1.38, csd-tx 0.1.17, csd-light 0.1.18, csd-registry 0.1.16, csd-client/codec/crypto/siwc 0.1.15.
