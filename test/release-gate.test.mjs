// scripts/release-gate.mjs: each guard refuses what it exists for, and the honest release passes, in scratch git
// repositories this test makes (a bare origin and a clone), never this repo's own state. The registry, pnpm and
// verify-tarball are stand-ins: no network, no build. Offline.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRelease, digests, headOnOriginMaster, registryMatches, treeClean, versionUnpublished } from "../scripts/release-gate.mjs";

let pass = 0, fail = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

const work = mkdtempSync(join(tmpdir(), "release-gate-test-"));
const env = { PATH: process.env.PATH ?? "", HOME: work, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(work, "gitconfig") };
writeFileSync(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = t\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = master\n");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** The gate's shell with this test's git config; pnpm and anything else answer from `fake`. */
const shWith = (fake = () => ({ ok: true, out: "" })) => (cmd, args, cwd) => {
  if (cmd !== "git") return fake(cmd, args, cwd);
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const sh = shWith();

// origin: master = A, then M (a --no-ff merge of topic commit T). First-parent line of master: M, A. T is an
// ancestor of master but not on that line.
const origin = join(work, "origin.git");
const repo = join(work, "repo");
git(work, "init", "--bare", "-q", origin);
git(work, "clone", "-q", origin, repo);
writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "@scope/pkg", version: "1.0.0" }));
writeFileSync(join(repo, ".gitignore"), "dist/\n");
git(repo, "add", "-A"); git(repo, "commit", "-qm", "A");
const A = git(repo, "rev-parse", "HEAD");
git(repo, "checkout", "-qb", "topic");
writeFileSync(join(repo, "f.txt"), "t\n");
git(repo, "add", "-A"); git(repo, "commit", "-qm", "T");
const T = git(repo, "rev-parse", "HEAD");
git(repo, "checkout", "-q", "master");
git(repo, "merge", "-q", "--no-ff", "-m", "M", "topic");
const M = git(repo, "rev-parse", "HEAD");
git(repo, "push", "-q", "origin", "master");
git(repo, "fetch", "-q", "origin");
const at = (id) => git(repo, "checkout", "-q", "--detach", id);

console.log("release gate, the tree and HEAD:");
await ok("honest: a clean tree at origin/master's tip passes both checks", () => {
  at(M);
  assert.equal(treeClean(repo, sh), true);
  assert.equal(headOnOriginMaster(repo, sh), true);
});
await ok("an older commit on the first-parent line passes", () => { at(A); assert.equal(headOnOriginMaster(repo, sh), true); });
await ok("a commit inside the merged pull request (an ancestor, off the first-parent line) is refused", () => {
  at(T);
  assert.equal(git(repo, "merge-base", "--is-ancestor", T, "origin/master"), "", "T is an ancestor of origin/master");
  assert.equal(headOnOriginMaster(repo, sh), false);
});
await ok("a local commit not on origin/master is refused", () => {
  at(M);
  git(repo, "commit", "-q", "--allow-empty", "-m", "local");
  assert.equal(headOnOriginMaster(repo, sh), false);
});
await ok("a tracked edit is refused", () => {
  at(M);
  writeFileSync(join(repo, "f.txt"), "edited\n");
  assert.equal(treeClean(repo, sh), false);
  git(repo, "checkout", "-q", "--", "f.txt");
  assert.equal(treeClean(repo, sh), true);
});
await ok("an untracked file is refused; an ignored one is not", () => {
  mkdirSync(join(repo, "dist"), { recursive: true });
  writeFileSync(join(repo, "dist", "index.js"), "built\n");
  assert.equal(treeClean(repo, sh), true, "dist/ is ignored");
  writeFileSync(join(repo, "stray.ts"), "x\n");
  assert.equal(treeClean(repo, sh), false);
  rmSync(join(repo, "stray.ts"));
});

console.log("release gate, the registry:");
const reg = (status, meta = null) => async () => ({ status, meta });
await ok("honest: a version the registry answers 404 for is free", async () => assert.equal((await versionUnpublished("@scope/pkg", "1.0.0", reg(404))).ok, true));
await ok("a version already on the registry is refused", async () => {
  const r = await versionUnpublished("@scope/pkg", "1.0.0", reg(200, {}));
  assert.equal(r.ok, false); assert.match(r.reason, /already on the registry/);
});
await ok("a registry error or an unreachable registry refuses (never read as free)", async () => {
  assert.equal((await versionUnpublished("@scope/pkg", "1.0.0", reg(500))).ok, false);
  assert.equal((await versionUnpublished("@scope/pkg", "1.0.0", async () => { throw new TypeError("fetch failed"); })).ok, false);
});
const bytes = new Uint8Array(Buffer.from("tarball bytes"));
const d = digests(bytes);
await ok("honest: after the publish, a registry entry with the tarball's shasum and integrity matches", async () => {
  assert.equal((await registryMatches("@scope/pkg", "1.0.0", bytes, reg(200, { dist: { shasum: d.sha1, integrity: d.integrity } }))).ok, true);
});
await ok("a registry entry with other bytes does not match (shasum or integrity)", async () => {
  const other = digests(new Uint8Array(Buffer.from("other")));
  assert.equal((await registryMatches("@scope/pkg", "1.0.0", bytes, reg(200, { dist: { shasum: other.sha1, integrity: d.integrity } }))).ok, false);
  assert.equal((await registryMatches("@scope/pkg", "1.0.0", bytes, reg(200, { dist: { shasum: d.sha1, integrity: other.integrity } }))).ok, false);
  assert.equal((await registryMatches("@scope/pkg", "1.0.0", bytes, reg(404))).ok, false);
});

console.log("release gate, the whole check:");
/** checkRelease over the scratch repo; pnpm calls are recorded, `pack` writes a tarball, `failing` names a pnpm step that fails. */
async function gate({ registry = reg(404), failing = "", verifyOk = true } = {}) {
  const out = mkdtempSync(join(work, "out-"));
  const pnpm = [];
  const fake = (cmd, args) => {
    assert.equal(cmd, "pnpm");
    pnpm.push(args.join(" "));
    if (args[0] === "pack") writeFileSync(join(out, "scope-pkg-1.0.0.tgz"), bytes);
    return { ok: args.join(" ") !== failing, out: "" };
  };
  const lines = [];
  const r = await checkRelease({ root: repo, out, log: (s) => lines.push(s), sh: shWith(fake), registry, verify: () => ({ ok: verifyOk, out: "" }) });
  return { ...r, pnpm, lines };
}
await ok("honest: a clean tree on origin/master with a free version runs the whole check and passes", async () => {
  at(M);
  const r = await gate();
  assert.deepEqual(r.fails, [], r.lines.join("\n"));
  assert.deepEqual(r.pnpm, ["install --frozen-lockfile", "typecheck", "lint", "check:dashes-paths", "build", "test", `pack --pack-destination ${r.tarball?.replace(/\/[^/]+$/, "")}`]);
  assert.ok(r.tarball?.endsWith(".tgz"));
});
await ok("a failing suite step refuses", async () => {
  at(M);
  for (const step of ["test", "typecheck", "install --frozen-lockfile"]) assert.deepEqual((await gate({ failing: step })).fails, [`pnpm ${step}`]);
});
await ok("a failing verify-tarball refuses", async () => { at(M); assert.deepEqual((await gate({ verifyOk: false })).fails, ["verify-tarball on the packed tarball"]); });
await ok("a published version refuses", async () => {
  at(M);
  const r = await gate({ registry: reg(200, {}) });
  assert.equal(r.fails.length, 1); assert.match(r.fails[0], /is not on the registry \(@scope\/pkg@1\.0\.0 is already on the registry\)/);
});
await ok("a dirty tree and a HEAD off the line refuse, and the rest still runs and is listed", async () => {
  at(T);
  writeFileSync(join(repo, "f.txt"), "edited\n");
  const r = await gate();
  assert.deepEqual(r.fails, ["the tree has no local change", "HEAD is on the first-parent line of origin/master", "the tree has no local change after the check"]);
  assert.equal(r.pnpm.length, 7, "every step still ran");
  git(repo, "checkout", "-q", "--", "f.txt");
});

rmSync(work, { recursive: true, force: true });
console.log(`\nrelease-gate: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
