# Release and publish

How a version reaches npm and what the gates on that path check. The rules are in `AGENTS.md` ("Release and
publish"); this file holds the mechanism.

## Why pack, then publish the tarball

Maintainers publish to npm (public access) by hand. CI has no publish job, on purpose. The npm 2FA-bypass token cannot
publish, so the sanctioned path is to pack and then publish the tarball.

`pnpm pack` runs `prepack`, which runs the build. `pnpm pack` does not fire `prepublishOnly` (build + test), and no
hook fires when a pre-made tarball is published, so without `prepack` the pack could ship stale bytes from the
untracked `dist/`.

The verified tarball is published with a transient npm token in a `mktemp --userconfig` file, deleted right after;
tokens are never stored.

## What `scripts/release-gate.mjs` checks

`verify-tarball.mjs` ties a tarball to the tree on disk and calls git 0 times, so on its own a tracked edit that
was never reviewed passes it and ships. The release gate ties the tarball to a commit. The maintainer runs it from a
fresh worktree at the release commit after `git fetch origin`; CI does not run it (it reads the registry), and it
publishes nothing.

`node scripts/release-gate.mjs --out <dir>` (`<dir>` new or empty) runs every check below, lists each as pass or
FAIL, and exits 1 if any failed:

- `git status --porcelain` is empty: no tracked change and no untracked file outside `.gitignore`.
- HEAD is on the first-parent line of `origin/master` as last fetched (`git rev-list --first-parent origin/master`
  lists it): a merge commit or a direct commit of master. A commit inside a merged pull request is an ancestor of
  master but not on that line, and can predate the branch's last fix, so `merge-base --is-ancestor` is not this
  check.
- package.json's version is not on the registry: only a 404 for `name@version` passes; a 200, any other status or
  an unreachable registry refuses.
- The repo's check: `pnpm install --frozen-lockfile`, `typecheck`, `lint`, `check:dashes-paths`, `build`, `test`.
- `pnpm pack` into `<dir>` (its `prepack` builds), then `verify-tarball.mjs` on that tarball.
- `git status --porcelain` is still empty after the check.

On success it prints the tarball's path, sha1 (npm's `dist.shasum`), sha512 integrity (`dist.integrity`) and
sha256. After `npm publish <tgz>`, `node scripts/release-gate.mjs --compare <tgz>` reads the registry's entry for
package.json's version and exits 0 only when both `dist.shasum` and `dist.integrity` equal the tarball's.

`test/release-gate.test.mjs` runs each guard in scratch git repositories it makes (a bare origin, a clone with a
merged pull request), with the registry, pnpm and verify-tarball stood in: each refusal, and the honest release
passing. The gate does not check the tag; step 5 of the release steps in `AGENTS.md` tags the commit it ran on.

## What `scripts/verify-tarball.mjs` checks

`node scripts/verify-tarball.mjs [tgz]` is the authoritative gate (repo-only, not in `files`).

- It rebuilds this tree by running the `build` tsup command through node with only PATH and HOME set, so no npm or
  pnpm config can skip or fake the build.
- It packs with scripts off, checks the packed dist/ equals what it just built, and requires the tarball's sha256 to
  equal the fresh pack's. The pack is deterministic; on a mismatch it lists the differing paths.
- Both package entries must carry the ASDK-1 `fetch failed` arm and a parseable `DEFAULT_SPV_CHECKPOINT`.
- The tarball's types: every file the `exports` map names must be in it, and a consumer importing every subpath must
  typecheck under node16 CommonJS, node16 ESM and bundler resolution (`scripts/check-consumer-types.mjs`, which also
  runs alone on a tarball). Each subpath gives `import` and `require` their own `types` (`.d.ts` and `.d.cts`);
  `test/consumer-types.test.mjs` pins that the 0.8.2 map, one shared ESM `types`, fails the CommonJS consumer with
  TS1479.
- It reads no other repository. CI runs it on a fresh pack, and `test/verify-tarball.test.ts` (run in a disposable
  copy of the package) pins that an edited tarball, a stale dist under ignore-scripts or a faked script shell, and a
  failing build all fail.
- `test/spv-checkpoint.test.ts` does not gate publishing: it is not in the pre-made-tarball path. The sha256 equality
  ties the tarball to the tree that test ran on.

## Pins

- Every dependency, dev dependencies included, is exact-pinned in `package.json`, the single source for every version
  and pin (csd-siwc is a devDependency). `test/dep-pins.test.mjs` checks every pin against `pnpm-lock.yaml`.
- The CI dep-pin hygiene step (`.github/workflows/ci.yml`) requires every `@inversealtruism/*` pin to be exact semver
  and the resolved tree to hold one csd-codec and one csd-crypto copy.
- Cross-repo pin freshness is csd-sdk's maintainer-run `scripts/check-consumer-pins.mjs` (it grades cairn-sdk as a
  helpers-only-lag advisory); it is not wired into this repo's CI.
