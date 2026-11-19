# cairn-sdk

The guide for maintainers and coding agents; `CLAUDE.md` is a symlink to this file and `README.md` is for users.
Production hosting and operations specifics are out of scope here and maintained privately.

`@inversealtruism/cairn-sdk` (npm; the version is in `package.json`) is the Compute Substrate dApp kit: the single
umbrella package a third party installs to build on CSD/Cairn. It composes the published low-level
`@inversealtruism/csd-*` primitives (from the csd-sdk monorepo) behind one `Cairn` facade with five namespaces
(`wallet`, `chain`, `index`, `content`, `names`); `README.md` describes them for users. It also holds the SDK's typed
mirror of the wallet's provider contract (`src/connect.ts` CairnProvider) and the client half of SIWC (Sign in with CSD; server
verification is `@inversealtruism/csd-siwc`). Position: csd-sdk = chain primitives, cairn-sdk = the wallet connector
and service clients over them. The repo doubles as the ecosystem's live browser E2E rig (the `scripts/` harnesses
drive the production site and the wallet).

## Check

```bash
pnpm install --frozen-lockfile
pnpm typecheck                  # tsc over src and test/ (strict, noUncheckedIndexedAccess)
pnpm lint                       # Biome, four rules only (biome.json; test/lint-config.test.mjs)
pnpm check:dashes-paths         # em dashes in docs, sibling-checkout reads in code (CI runs both)
pnpm build                      # tsup, 8 entrypoints; before pnpm test: one suite checks the built dist/
pnpm test                       # offline unit suites (test/run.mjs, every test/*.test.{ts,mjs})
pnpm test:live                  # examples/read-only.mjs + test/e2e/e2e-read.mjs vs live mainnet
pnpm test:live:wallet           # wallet connector e2e (opt-in: Xvfb, Chromium, ../cairn-wallet/dist or WALLET_EXT)
pnpm build:example              # esbuild JS API (not the CLI shim; it ELF-errors under pnpm)
```

Package manager is pnpm (the `packageManager` field in `package.json`). `pnpm-lock.yaml` is the single lockfile: CI
runs `pnpm install --frozen-lockfile` and the dep-pin gate parses `pnpm-lock.yaml` directly. Do not add an npm
`package-lock.json`. To inspect deps with npm, run `npm install --package-lock-only` in a scratch copy and do not
commit the result.

## Standard

This repo follows the maintainers' cross-repo engineering standard (a private document). The part that binds a
contributor here:

- One home per concept: consensus values (NAME_RE, RESERVED_NAMES, fee constants, codec shapes) come from the
  published csd-sdk packages and are never re-declared here.
- TypeScript `strict` with `noUncheckedIndexedAccess`, no `@ts-ignore`, `any` only at a parse boundary. Money is
  integer base units (`bigint`), never floats. No empty `catch {}`; on money paths no catch-and-continue that hides a
  failure, and error text says what happened.
- Tests check behaviour at boundaries. A fix ships with a test that fails without it, plus an assertion that the
  honest path still passes with the call shape production sends. A skipped test names its reason and when it
  un-skips. `pnpm test` is offline; anything that touches mainnet is `test:live` or an e2e script.
- Comments state constraints and non-obvious invariants, not history or audit IDs. Removing code needs the same
  evidence as adding it.
- Docs: this file holds what stays true (no version tables, no status snapshots; versions live in `package.json` and
  tags, live state comes from a live query). Dates are absolute, no em dashes.

Known deviations:

- Sibling-checkout reads: the opt-in wallet-connector e2e (`test:live:wallet`) loads a built `../cairn-wallet/dist`
  (or `WALLET_EXT`). `test/e2e/e2e-siwc.mjs` and the six maintainer-run `scripts/*.mjs` harnesses load the wallet
  from fixed host paths, and e2e-siwc also loads csd-siwc and the cairn console. All are listed as exceptions in
  `scripts/check-dashes-paths.mjs`.
- `pnpm lint` reports empty blocks as warnings, most of them in the six `scripts/*.mjs` live harnesses, so that rule
  does not fail CI yet.
- The heavy comment blocks and audit IDs in `src/` are trimmed per module, not as drive-by edits.

## Code map

Module detail, the SPV header sync, the fill-verify surface and the integration notes are in `docs/architecture.md`.

- `src/index.ts`: the `Cairn` facade, CairnConfig, DEFAULT_SPV_CHECKPOINT and the PoW-verified header wiring. Every
  base defaults to the hosted proxies at https://cairn-substrate.com and is overridable through CairnConfig.
- `src/connect.ts`: the CairnProvider contract, provider discovery, WalletConnection.
- `src/indexer.ts`, `content.ts`, `names.ts`, `chain.ts`: the service clients (indexer REST, SSE and
  `verifyInclusion`; verified content; names reads; tip, utxos, submit and the key-backed `Chain.send`).
- `src/fillverify.ts`: `preverifyOffer`, the merkle-proven pre-verify of a fill, over cairnx-core's predicates.
- `src/controller.ts`, `react.ts`: the reactive store and the React hooks. `src/errors.ts`: the CairnError codes and
  SDK_VERSION. `src/http.ts`: timeout, byte cap, retries.
- `examples/`: the samples, checked by `test/examples.test.mjs`. `scripts/`: the release gates, the example build and
  the six live harnesses. `test/`: unit suites; `test/e2e/`: the live layers.

## Invariants and red lines

- Connection never pre-approves signatures: connect/getAddress are the only calls that return the address without a
  prompt after consent (getPermissions/revokePermissions are silent and origin-scoped); every signing method opens
  the wallet's clear-sign window (extension-enforced). Never imply otherwise in docs.
- DEFAULT_SPV_CHECKPOINT is picked in cairn (`bump-swapguard-cp.mjs`) and copied here from
  cairn/public/trade/swapguard.js's baked anchor in the same cycle; it is never a unilateral SDK edit. This repo
  checks that the constant is a real block (`test/spv-checkpoint.test.ts` against the committed header capture; a
  moved checkpoint needs a new capture); it does not read the cairn tree, so the copy in cairn (swapguard.js and its
  ops files) is checked in the cairn repo when the anchor moves. Every checkpoint move names the affected band in
  the CHANGELOG.
- Never over-claim trust levels: verified-inclusion requires a PoW-verified header; same-origin proxy setups honestly
  degrade to proof-consistent. The user-facing description lives in `docs/SDK-GUIDE.md`; change it there.
- cairn.names.* are server-trusted display reads. Never wire them straight into a payment target; payment-grade
  resolution is the wallet's on-device SPV path.
- The `fillOffer` provider call is resolver-trusted at the SDK layer. `preverifyOffer`/fillverify is the diligent
  dApp's merkle-proven corroboration: fail-closed on a positive mismatch, fail-soft on an unreachable chain view. The
  wallet's own on-device fill-SPV is the payment-grade boundary.
- Consensus values (NAME_RE, RESERVED_NAMES, fee constants, codec shapes) always come from the published
  csd-*/cairnx-core packages; never re-declare them locally. `src/fillverify.ts` imports its fill predicates from
  cairnx-core, with no local copies (`test/proven-terms-corpus.test.ts` pins the proven terms).
- `fillEndorsement`'s not-endorsable verdict means proceed unendorsed; it is never a refusal of an honest token fill.
  The deprecated `fillIsSafe`, `requiredFillOutputs` and `previewFill` stay exported, behaviour-frozen.
- The facade's light client runs one `sync` at a time (`test/fillverify.test.ts` and
  `test/spv-fault-tolerance.test.ts`, the concurrent cases). The header sync is a few batched requests, never a
  per-height flood, and its per-attempt timeout is deliberately above the server's 10 s route deadline.
- SDK_VERSION in `src/errors.ts` bumps together with `package.json` (`test/errors.test.ts`).
- csd-* deps exact-pinned, no carets: every dependency, dev dependencies included, is exact-pinned in
  `package.json`, the only source of pins (`test/dep-pins.test.mjs`). Do not re-pin outside a release, and never
  correct `package.json` to an older number from a stale doc.
- Content bytes hashed raw; the 16MiB cap and merkle-proof shape validation (fail-closed to not-found) must not be
  removed.
- Operator-token endpoints are deliberately never used; a dApp acts as the user.
- Legacy signIn() is first-party-only and @deprecated; third parties use SIWC.
- Security fixes must not regress UX: never add complexity, latency, or spurious declines to a legitimate hot path in
  the name of hardening.
- House style: no em dashes in any doc (`grep -cP '\x{2014}' <file>` prints 0; `pnpm check:dashes-paths` checks every
  tracked .md outside docs/archive/); keep prose concrete, no filler.
- Releasing is a maintainer action: contributors do not bump versions, tag, or publish; maintainers publish to npm
  (see Release and publish).
- CI gates (`.github/workflows/ci.yml`): the dep-pin hygiene step requires every `@inversealtruism/*` pin to be exact
  semver and the resolved tree to hold one csd-codec and one csd-crypto copy. Every `uses:` is pinned to a full
  commit SHA (tag in a trailing comment), and the `secrets` job runs gitleaks over the full history. Do not remove
  these gates.

## Testing

Three layers (`test/e2e/README.md`): unit (`pnpm test`, offline), live read (`pnpm test:live`; `CAIRN_BASE` points it
at another front door) and the wallet connector (`pnpm test:live:wallet`).

- Check `pnpm-lock.yaml` against `package.json` before trusting a suite: a stale lockfile runs every test against the
  wrong dependency graph, and `tsc` cannot see it when the `.d.ts` files are identical.
- `test/spv-transient-parity.test.mjs` checks the built `dist/` and fails without one, so build before `pnpm test`.
- The `scripts/*.mjs` live harnesses are maintainer-run only, and some spend CSD. `scripts/live-wallet-ui.mjs` is the
  read-only one: it approves only the non-spend Connect and rejects every fund- or fee-bearing clear-sign popup.
- When the wallet adds an error code, add it to `test/types/wallet-codes.ts` and classify it in `src/errors.ts` as
  retryable, in flight or final; at each wallet release, compare `test/types/wallet-params.ts` with the wallet's
  handlers by hand and update it and the types in `src/connect.ts` together. The steps for both are in
  `docs/architecture.md` ("The wallet contract").
- `scripts/build-example.mjs` uses the esbuild JS API (the CLI shim ELF-errors under pnpm); keep it that way.

## Release and publish

Maintainers publish to npm (public access) by hand; CI has no publish job, on purpose. The sanctioned path is to
pack, check and then publish the tarball from the release commit (`docs/release.md` says why and what each gate
checks).

1. Prepare: bump `version` and `SDK_VERSION` (`src/errors.ts`) together, re-pin csd-*/cairnx-core to published
   versions, add the CHANGELOG entry, and merge it to `master` through a pull request.
2. Gate: `git fetch origin`, then from a fresh worktree at the release commit run
   `node scripts/release-gate.mjs --out <new dir>`. It refuses a tree with any local change, a HEAD that is not on
   the first-parent line of `origin/master` and a version already on the registry; runs the check (frozen install,
   typecheck, lint, dashes and paths, build, unit suites); packs (`prepack` builds `dist/`); runs
   `scripts/verify-tarball.mjs` on that tarball; and prints its sha1, integrity and sha256. Do not publish unless
   it exits 0.
3. Publish that tarball with a transient npm token in a `mktemp --userconfig` file, deleted right after; tokens are
   never stored.
4. Compare: `node scripts/release-gate.mjs --compare <tgz>` exits 0 only when the registry's `dist.shasum` and
   `dist.integrity` equal the tarball's.
5. Tag `vX.Y.Z` at that commit and push. The version history is the CHANGELOG and the `v*` tags.

## Cross-repo contract

- Depends on the published `@inversealtruism/csd-*` and `@inversealtruism/cairnx-core` packages from the csd-sdk
  monorepo (exact pins, installed from npm). Pin freshness is csd-sdk's maintainer-run
  `scripts/check-consumer-pins.mjs`; it is not wired into this repo's CI.
- cairn-wallet's `window.cairn` provider: the contract is `docs/PROVIDER.md` in the cairn-wallet repo, with the error
  codes in its `WALLET-ERROR-CODES.md`; `src/connect.ts` is the typed mirror of it.
- The cairn server endpoints (/api/rpc, /api/headers, /content, /explorer/api, /trade/api/cairnx/*), and the SPV
  checkpoint literal copied from cairn/public/trade/swapguard.js (each repo checks its copy against the chain).
- The opt-in wallet-connector E2E loads a sibling ../cairn-wallet/dist (override with `WALLET_EXT`).

## Docs

- `README.md`: what the package is, install, quick start.
- `docs/SDK-GUIDE.md`: the third-party developer guide; the one description of the trust levels.
- `docs/architecture.md`: modules, SPV header sync, the fill-verify surface, the wallet contract, integration notes.
- `docs/release.md`: why pack-then-publish, what the release gate and verify-tarball check, the pin gates.
- `CHANGELOG.md`: one entry per release; every SPV checkpoint move names the affected band; "Notes moved from
  AGENTS.md" maps the audit-ID markers in `src/` comments to the guards they explain.
- `test/e2e/README.md`: the test layers, the unit runner and the live harnesses.
- `.githooks/README.md`: the secret-scan pre-commit hook.

The cross-repo standard is a private document; the summary above is the part that binds a contributor here.
