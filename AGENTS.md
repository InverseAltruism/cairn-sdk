# cairn-sdk

> Onboarding briefing for coding agents and contributors working on this repo. `AGENTS.md` is the canonical briefing; `CLAUDE.md` is a symlink to it. Production hosting and operations specifics are intentionally out of scope here and maintained privately.

`@inversealtruism/cairn-sdk` (npm; the version is in `package.json`) is the Compute Substrate dApp kit: the single umbrella package a third party installs to build on CSD/Cairn. It composes the published low-level `@inversealtruism/csd-*` primitives (from the csd-sdk monorepo) behind one `Cairn` facade with five namespaces (`wallet`, `chain`, `index`, `content`, `names`); `README.md` describes them for users.

It also owns the dApp-facing wallet API contract (src/connect.ts CairnProvider) and the client half of SIWC (Sign in with CSD; server verification is `@inversealtruism/csd-siwc`). Position: csd-sdk = chain primitives (the "ethers" layer); cairn-sdk = the "wagmi + service clients" layer. The repo doubles as the ecosystem's live browser E2E rig (scripts/ harnesses driving the production site + wallet).

## Cross-repo standard

This repo follows the maintainers' cross-repo engineering standard (a private document). The rules that matter for a contributor here:

- One home per concept: consensus values (NAME_RE, RESERVED_NAMES, fee constants, codec shapes) come from the published csd-sdk packages and are never re-declared here.
- TypeScript `strict` with `noUncheckedIndexedAccess`, no `@ts-ignore`, `any` only at a parse boundary. Money is integer base units (`bigint`), never floats. No empty `catch {}`; on money paths no catch-and-continue that hides a failure, and error text says what happened.
- Tests check behaviour at boundaries. A fix ships with a test that fails without it, plus an assertion that the honest path still passes with the call shape production sends. A skipped test names its reason and when it un-skips. `pnpm test` is offline; anything that touches mainnet is `test:live` or an e2e script.
- Comments state constraints and non-obvious invariants, not history or audit IDs. Removing code needs the same evidence as adding it.
- Docs: this file holds what stays true (no version tables, no status snapshots; versions live in `package.json` and tags, live state comes from a live query). Dates are absolute, no em dashes.

Known deviations (checked 2026-10-22, not exhaustive):

- Sibling-checkout reads: the opt-in wallet-connector e2e (`test:live:wallet`) loads a built `../cairn-wallet/dist` (or `WALLET_EXT`). `test/e2e/e2e-siwc.mjs` and the six maintainer-run `scripts/*.mjs` harnesses load the wallet from fixed host paths, and e2e-siwc also loads csd-siwc and the cairn console. All are listed as exceptions in `scripts/check-dashes-paths.mjs`.
- `pnpm lint` (Biome, `biome.json`) reports 91 empty blocks as warnings, 81 of them in the six `scripts/*.mjs` live harnesses, so that rule does not fail CI yet.
- The heavy comment blocks and audit IDs in `src/` are trimmed per module, not as drive-by edits.

## The stack around it

Everything defaults to the hosted public bases at https://cairn-substrate.com: RPC proxy /api/rpc, SPV headers /api/headers, content /content, indexer proxy /explorer/api, names /trade/api/cairnx/*. Those are reverse proxies in front of the node, the csd-indexer, and the cairnx names/market resolver; every base is overridable via CairnConfig for self-hosted setups. The chain is the only source of truth; every read carries an honest trust level, described once in docs/SDK-GUIDE.md ("What the SDK verifies vs trusts").

## Architecture

`src/` is built by tsup to esm+cjs+dts with 7 entry points (the `build` script lists them):

- `index.ts`: Cairn facade, CairnConfig, DEFAULT_SPV_CHECKPOINT (height and hash are in the source), and the lazy PoW-verified header wiring into the indexer via `seededSpvLight`.
  - Header sync runs forward from the checkpoint to the tip through a batch header provider over the cairn server's /api/headers: a few batched requests, never a per-height flood, fail-soft to on-demand sync.
  - The per-attempt timeout is deliberately above the server's 10 s route deadline.
  - Cross-origin reach of that provider depends on the cairn server's CORS mount on /api/headers.
  - The checkpoint is picked in cairn (`bump-swapguard-cp.mjs`) and copied here in the same cycle; it is never a unilateral SDK edit.
  - `test/spv-checkpoint.test.ts` recomputes the anchor's hash from a committed header capture (`test/fixtures/spv-headers-*.json`, PoW and prev-links checked) and fails when the constant is not that block; a moved checkpoint needs a new capture.
  - Verification only runs forward from the anchor, so a moved checkpoint turns reads below it into `proof-consistent` (behaviour described in docs/SDK-GUIDE.md). Every checkpoint move names the affected band in the CHANGELOG.
- `connect.ts`: CairnProvider typed contract, detectProvider/discoverProviders (csd:announceProvider discovery), WalletConnection (connect/getAddress/signInWithCsd/send/propose/attest/fillOffer/sealClaim/revealClaim/permissions/events).
- `indexer.ts`: REST + verifyInclusion(txid) with TrustLevel = verified-inclusion | proof-consistent | not-found (+ equivocation flag), SSE-over-fetch with reconnect + 1MiB buffer cap, WS subscribe.
- `content.ts`: prepare/put/hash, verified get/getBytes from the cairn origin, hash format gated against path-walk.
- `names.ts`: NamesClient over /trade/api/cairnx/*; inputs pre-validated with cairnx-core NAME_RE + RESERVED_NAMES.
- `chain.ts`: tip/utxos/submit/light(); Chain.send() = key-backed send via buildSendVerified + verifyInputValues (fail-closed).
- `controller.ts` (framework-agnostic reactive store; spoofed-accountsChanged adoption guard), `react.ts` (createCairnHooks(React), zero react dependency), `errors.ts` (CairnError hierarchy with stable codes; SDK_VERSION manually kept == package.json, test-enforced), `http.ts` (15s timeout, 16MiB streamed byte cap, idempotent-GET-only retries).

docs/SDK-GUIDE.md (third-party guide incl. the verifies-vs-trusts section), examples/ (read-only, wallet-connect, siwc-login, node-signer, hello-csd), scripts/ (esbuild example build + 6 maintainer-run live E2E harnesses: scripts/live-wallet-ui.mjs, scripts/names-e2e.mjs, scripts/names-buy-e2e.mjs, scripts/ux-live-readonly.mjs, scripts/ux-openlane-buy.mjs, scripts/wallet-send-spv-e2e.mjs).

Deps and the fill-verify surface:

- Every dependency, dev dependencies included, is exact-pinned in `package.json`, the single source for every version and pin (csd-siwc is a devDependency). `test/dep-pins.test.mjs` checks every pin against `pnpm-lock.yaml`.
- `src/fillverify.ts` imports `feeBpsAt`, `bindOfferTerms`, `provenOfferTerms` and `provenOfferRefusal` (the resolver's creation rules for a proven offer, except the two activation gates it lacks; CHANGELOG) from cairnx-core, with no local copies. The ProvenOfferTerms interface and producer are single-sourced and corpus-equivalence-pinned by `test/proven-terms-corpus.test.ts`.
- fillverify exports the `preverifyOffer` helper and the throw-on-nested-refusal write wrapper.
- The give and want-type binds are on: `bindOfferTerms` over the branded `MintedProvenOfferTerms` checks them by default in cairnx-core, and fillverify also passes `{ give: true, wantType: true }`. It binds the give legs, a symmetric want-type refusal and a token want's ticker and amount.
- `OfferFillCheck.terms` keeps that brand (`test/fillverify-types.test.mjs` type-checks it). The opt-in sums seam runs over the discriminated `fillOutputPlan`.
- `fillEndorsement` and `fillOutputPlan` are the successors. The deprecated `fillIsSafe`, `requiredFillOutputs` and `previewFill` stay exported, behaviour-frozen.
- `fillEndorsement`'s not-endorsable verdict means proceed unendorsed; it is never a refusal of an honest token fill.

## Invariants and red lines

- Connection never pre-approves signatures: connect/getAddress are the only calls that return the address without a prompt after consent (getPermissions/revokePermissions are silent and origin-scoped); every signing method opens the wallet's clear-sign window (extension-enforced). Never imply otherwise in docs.
- DEFAULT_SPV_CHECKPOINT is copied from cairn/public/trade/swapguard.js's baked anchor in the same cycle. This repo checks that the constant is a real block (test/spv-checkpoint.test.ts against the header capture); it does not read the cairn tree, so the copy in cairn (swapguard.js and its ops files) is checked in the cairn repo when the anchor moves.
- Never over-claim trust levels: verified-inclusion requires a PoW-verified header; same-origin proxy setups honestly degrade to proof-consistent. The user-facing description lives in docs/SDK-GUIDE.md; change it there.
- cairn.names.* are server-trusted display reads. Never wire them straight into a payment target; payment-grade resolution is the wallet's on-device SPV path.
- The `fillOffer` provider call is resolver-trusted at the SDK layer. `preverifyOffer`/fillverify is the diligent dApp's merkle-proven corroboration: fail-closed on a positive mismatch, fail-soft on an unreachable chain view. The wallet's own on-device fill-SPV is the payment-grade boundary.
- SDK_VERSION in src/errors.ts bumps together with package.json.
- csd-* deps exact-pinned, no carets.
- Content bytes hashed raw; the 16MiB cap and merkle-proof shape validation (fail-closed to not-found) must not be removed.
- Operator-token endpoints are deliberately never used; a dApp acts as the user.
- Legacy signIn() is first-party-only and @deprecated; third parties use SIWC.
- Consensus values (NAME_RE, RESERVED_NAMES, fee constants, codec shapes) always come from the published csd-*/cairnx-core packages; never re-declare them locally.
- Security fixes must not regress UX: never add complexity, latency, or spurious declines to a legitimate hot path in the name of hardening.
- House style: no em dashes in any doc (`grep -cP '\x{2014}' <file>` prints 0; `pnpm check:dashes-paths` checks every tracked .md outside docs/archive/); keep prose concrete, no filler.
- Releasing is a maintainer action: contributors do not bump versions, tag, or publish; maintainers publish to npm (see Release and publish).

## Dev workflow

Package manager is pnpm (the `packageManager` field in `package.json`). `pnpm-lock.yaml` is the single lockfile: CI runs `pnpm install --frozen-lockfile` and the dep-pin gate parses `pnpm-lock.yaml` directly. Do not add an npm `package-lock.json`. To inspect deps with npm, run `npm install --package-lock-only` in a scratch copy and do not commit the result.

```bash
pnpm install --frozen-lockfile
pnpm typecheck                  # tsc over src and test/ (strict, noUncheckedIndexedAccess)
pnpm lint                       # Biome, four rules only (biome.json; test/lint-config.test.mjs)
pnpm check:dashes-paths         # em dashes in docs, sibling-checkout reads in code (CI runs both)
pnpm build                      # tsup, 7 entrypoints
pnpm test                       # offline unit suites (tsx)
pnpm test:live                  # examples/read-only.mjs + test/e2e/e2e-read.mjs vs live mainnet
pnpm test:live:wallet           # wallet connector e2e (opt-in: Xvfb, Chromium, a built ../cairn-wallet/dist or WALLET_EXT)
pnpm build:example              # esbuild JS API (not the CLI shim; it ELF-errors under pnpm)
```

## Testing

Three layers (test/e2e/README.md), all against built dist/:

- Unit (`pnpm test` = `test/run.mjs`, offline): a glob runner that discovers every `test/*.test.{ts,mjs}`, runs all of them even after a failure, applies a per-file timeout, and classifies SKIP instead of miscounting it. `ls test` is the suite list.
- `test/runner-guards.test.mjs` drives the real runner against throwaway sandboxes, including a 3-file middle-fails fixture: a mid-suite failure still runs the rest and forces a non-zero exit.
- Live read (`pnpm test:live`): every read surface vs mainnet plus adversarial cases; `CAIRN_BASE` points it at another front door.
- Wallet connector (`pnpm test:live:wallet`): real Chromium and the real built ../cairn-wallet/dist (or `WALLET_EXT`) extension under Xvfb via playwright-core; proves silent repeat-connect and that send still prompts.
- test/e2e/ also holds the e2e-siwc.mjs helper beyond the three canonical layers.

The `scripts/*.mjs` live harnesses are maintainer-run only, and some spend CSD. `scripts/live-wallet-ui.mjs` is the read-only one: headed Chrome and the real MV3 extension against the production site. It approves only the non-spend Connect, reads, then rejects every fund- or fee-bearing clear-sign popup, and captures screenshots.

## Release and publish

Maintainers publish to npm (public access) by hand. CI has no publish job, on purpose. The npm 2FA-bypass token cannot publish, so the sanctioned path is to pack and then publish the tarball.

1. Prepare: bump `version` and `SDK_VERSION` (src/errors.ts) together, re-pin csd-*/cairnx-core to published versions, and add the CHANGELOG entry.
2. Pack: `pnpm pack`. `prepack` runs the build. `pnpm pack` does not fire `prepublishOnly` (build + test), and no hook fires when a pre-made tarball is published, so without `prepack` the pack could ship stale bytes from the untracked `dist/`.
3. Verify: `node scripts/verify-tarball.mjs [tgz]`, the authoritative gate (repo-only, not in `files`). Do not publish unless it exits 0.
4. Publish the verified tarball with a transient npm token in a `mktemp --userconfig` file, deleted right after; tokens are never stored.
5. Tag `vX.Y.Z` and push. The version history is the CHANGELOG and the `v*` tags.

What verify-tarball checks:

- It rebuilds this tree by running the `build` tsup command through node with only PATH and HOME set, so no npm or pnpm config can skip or fake the build.
- It packs with scripts off, checks the packed dist/ equals what it just built, and requires the tarball's sha256 to equal the fresh pack's. The pack is deterministic; on a mismatch it lists the differing paths.
- Both package entries must carry the ASDK-1 `fetch failed` arm and a parseable `DEFAULT_SPV_CHECKPOINT`.
- It reads no other repository. CI runs it on a fresh pack, and `test/verify-tarball.test.ts` (run in a disposable copy of the package) pins that an edited tarball, a stale dist under ignore-scripts or a faked script shell, and a failing build all fail.
- `test/spv-checkpoint.test.ts` does not gate publishing: it is not in the pre-made-tarball path. The sha256 equality ties the tarball to the tree that test ran on.

## Gotchas

- CI gates (`.github/workflows/ci.yml`): the dep-pin hygiene step requires every `@inversealtruism/*` pin to be exact semver and the resolved tree to hold one csd-codec and one csd-crypto copy. Every `uses:` is pinned to a full commit SHA (tag in a trailing comment), and the `secrets` job runs gitleaks over the full history. Do not remove these gates.
- Cross-repo pin freshness is csd-sdk's maintainer-run `scripts/check-consumer-pins.mjs` (it grades cairn-sdk as a helpers-only-lag advisory); it is not wired into this repo's CI.
- `package.json` is the only source of pins. Do not re-pin outside a release, and never correct `package.json` to an older number from a stale doc.
- Check `pnpm-lock.yaml` against `package.json` before trusting a suite: a stale lockfile runs every test against the wrong dependency graph, and `tsc` cannot see it when the `.d.ts` files are identical.
- SSE through a buffering reverse proxy needs `X-Accel-Buffering: no` from the origin (the hosted proxy sets it); WS subscribe still needs a direct indexer URL because the hosted proxy is REST+SSE only.
- esbuild CLI shim ELF-errors under pnpm; scripts/build-example.mjs uses the JS API, keep it that way.
- Audit-ID markers in `src/` comments (M3, H2, CAIRNSDK-*, CONNECT-1 and others) are mapped to the guards they explain in CHANGELOG.md, "Notes moved from AGENTS.md".
- mapProviderError and the write wrappers classify every code in WALLET-ERROR-CODES.md (the wallet repo's canonical contract) as retryable, in flight or final; add a new wallet code to `src/errors.ts` and `test/errors.test.ts` when the wallet adds one.
- Large-tx submits: a reverse proxy with a small body cap on POST /api/rpc/tx/submit answers HTTP 400 before the tx reaches the node (a 64KB cap is hit at roughly 127+ inputs). The cairn server has a scoped 512KB cap on that route.
- Symptom on a server without that cap: a big Chain.send()/submit 400s with no node-side error. Suspect the proxy body cap on the server you target before blaming the SDK.

## Cross-repo map

Depends on the published `@inversealtruism/csd-*` / `@inversealtruism/cairnx-core` packages from the csd-sdk monorepo (exact pins, installed from npm). Contract couplings: cairn-wallet's window.cairn provider (connect.ts is the dApp-side contract; WALLET-ERROR-CODES.md in the cairn-wallet repo), the cairn server endpoints (/api/rpc, /api/headers, /content, /explorer/api, /trade/api/cairnx/*), and the SPV checkpoint literal copied from cairn/public/trade/swapguard.js (each repo checks its copy against the chain). The opt-in wallet-connector E2E loads a sibling ../cairn-wallet/dist (override with WALLET_EXT).

## Docs

| Doc | Holds |
|---|---|
| `README.md` | what the package is, install, quick start |
| `docs/SDK-GUIDE.md` | third-party developer guide; the one description of the trust levels |
| `CHANGELOG.md` | one entry per release; every SPV checkpoint move names the affected band |
| `test/e2e/README.md` | the test layers and how to run them |
| `.githooks/README.md` | the secret-scan pre-commit hook |

The wallet error code contract is `WALLET-ERROR-CODES.md` in the cairn-wallet repo. The cross-repo standard is a private document; the summary above is the part that binds a contributor here.
