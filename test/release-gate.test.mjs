// scripts/release-gate.mjs: each guard refuses what it exists for, and the honest release passes, in scratch git
// repositories this test makes (a bare origin and a clone), never this repo's own state. The registry, pnpm and
// verify-tarball are stand-ins: no network, no build. The script is also started as a command, from a copy in a
// scratch directory, by its real path and through symlinks. Offline.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRelease, compareRelease, digests, headOnOriginMaster, RECORD, treeClean, versionUnpublished } from "../scripts/release-gate.mjs";

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
await ok("an untracked file is refused under status.showUntrackedFiles=no", () => {
  git(repo, "config", "status.showUntrackedFiles", "no");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "submit.js"), "planted\n");
  assert.equal(git(repo, "status", "--porcelain"), "", "plain git status hides it under this setting");
  assert.equal(treeClean(repo, sh), false);
  rmSync(join(repo, "src"), { recursive: true });
  git(repo, "config", "--unset", "status.showUntrackedFiles");
  assert.equal(treeClean(repo, sh), true);
});
await ok("an edit hidden by assume-unchanged or skip-worktree is refused", () => {
  at(M);
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    git(repo, "update-index", flag, "f.txt");
    writeFileSync(join(repo, "f.txt"), "edited\n");
    assert.equal(git(repo, "status", "--porcelain"), "", `${flag}: plain git status hides the edit`);
    assert.equal(treeClean(repo, sh), false, flag);
    git(repo, "update-index", flag.replace("--", "--no-"), "f.txt");
    git(repo, "checkout", "-q", "--", "f.txt");
  }
  assert.equal(treeClean(repo, sh), true);
});
await ok("a local branch named origin/master does not stand in for the remote-tracking ref", () => {
  at(M);
  git(repo, "commit", "-q", "--allow-empty", "-m", "local");
  git(repo, "branch", "origin/master");
  assert.equal(headOnOriginMaster(repo, sh), false);
  git(repo, "branch", "-D", "origin/master");
  at(M);
  assert.equal(headOnOriginMaster(repo, sh), true);
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
await ok("digests are npm's: sha1 hex (dist.shasum), sha512 base64 SRI (dist.integrity), sha256 hex (known answers for \"abc\")", () => {
  assert.deepEqual(digests(new Uint8Array(Buffer.from("abc"))), {
    sha1: "a9993e364706816aba3e25717850c26c9cd0d89d",
    integrity: "sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
});
const bytes = new Uint8Array(Buffer.from("tarball bytes"));
const d = digests(bytes);

console.log("release gate, the whole check:");
/** checkRelease over the scratch repo; pnpm calls are recorded, `pack` writes a tarball unless `noTarball`, `failing`
 *  names a pnpm step that fails, `during` runs inside the `test` step. */
async function gate({ registry = reg(404), failing = "", verifyOk = true, noTarball = false, during = () => undefined } = {}) {
  const out = mkdtempSync(join(work, "out-"));
  const pnpm = [];
  const fake = (cmd, args) => {
    assert.equal(cmd, "pnpm");
    pnpm.push(args.join(" "));
    if (args[0] === "pack" && !noTarball) writeFileSync(join(out, "scope-pkg-1.0.0.tgz"), bytes);
    if (args[0] === "test") during();
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
  const rec = JSON.parse(readFileSync(join(r.tarball.replace(/\/[^/]+$/, ""), RECORD), "utf8"));
  assert.deepEqual(rec, { name: "@scope/pkg", version: "1.0.0", commit: M, tarball: r.tarball, ...d }, "the record names the commit and the checked digests");
});
await ok("a failing pnpm pack, or a pack that leaves no tarball, refuses and writes no record", async () => {
  at(M);
  const r0 = await gate({ noTarball: true });
  assert.deepEqual(r0.fails, ["pnpm pack"]);
  assert.equal(r0.record, undefined);
  const out = mkdtempSync(join(work, "out-"));
  const r = await checkRelease({ root: repo, out, log: () => undefined, registry: reg(404), verify: () => ({ ok: true, out: "" }),
    sh: shWith((_c, args) => { if (args[0] === "pack") writeFileSync(join(out, "x.tgz"), bytes); return { ok: args[0] !== "pack", out: "" }; }) });
  assert.deepEqual(r.fails, ["pnpm pack"]);
  assert.equal(existsSync(join(out, RECORD)), false);
});
await ok("a commit made while the suite runs refuses (HEAD after the check is not the commit checked)", async () => {
  at(M);
  const r = await gate({ during: () => git(repo, "commit", "-q", "--allow-empty", "-m", "during the suite") });
  assert.deepEqual(r.fails, ["HEAD after the check is the commit the gate started at"]);
  assert.equal(r.record, undefined);
  at(M);
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

console.log("release gate, the compare after the publish:");
await ok("honest: the registry entry carries the digests the gate recorded", async () => {
  at(M);
  const r = await gate();
  const out = r.tarball.replace(/\/[^/]+$/, "");
  let asked = "";
  const m = await compareRelease({ out, registry: async (n, v) => { asked = `${n}@${v}`; return { status: 200, meta: { dist: { shasum: d.sha1, integrity: d.integrity } } }; } });
  assert.equal(m.ok, true, m.reason);
  assert.equal(asked, "@scope/pkg@1.0.0", "the version comes from the record");
});
await ok("other bytes on the registry (shasum or integrity), no entry, an unreadable registry, or no record: refused", async () => {
  at(M);
  const out = (await gate()).tarball.replace(/\/[^/]+$/, "");
  const other = digests(new Uint8Array(Buffer.from("other")));
  assert.equal((await compareRelease({ out, registry: reg(200, { dist: { shasum: other.sha1, integrity: d.integrity } }) })).ok, false);
  assert.equal((await compareRelease({ out, registry: reg(200, { dist: { shasum: d.sha1, integrity: other.integrity } }) })).ok, false);
  assert.equal((await compareRelease({ out, registry: reg(404) })).ok, false);
  assert.equal((await compareRelease({ out, registry: async () => { throw new TypeError("fetch failed"); } })).ok, false);
  const empty = mkdtempSync(join(work, "out-"));
  const none = await compareRelease({ out: empty, registry: reg(200, { dist: { shasum: d.sha1, integrity: d.integrity } }) });
  assert.equal(none.ok, false); assert.match(none.reason, /no gate record/);
});
await ok("a refused gate writes no record, so --compare cannot pass on its tarball", async () => {
  at(T);
  const r = await gate();
  assert.ok(r.fails.length > 0);
  assert.equal(existsSync(join(r.tarball.replace(/\/[^/]+$/, ""), RECORD)), false);
  at(M);
});

console.log("release gate, started as a command:");
// A copy of the script in a scratch package (it imports node builtins only), started by its real path, through a
// symlink to the file and through a symlink to the directory; each must run main and exit with its code.
const cmd = join(work, "cmd");
mkdirSync(join(cmd, "scripts"), { recursive: true });
writeFileSync(join(cmd, "package.json"), JSON.stringify({ name: "@scope/pkg", version: "1.0.0" }));
copyFileSync(fileURLToPath(new URL("../scripts/release-gate.mjs", import.meta.url)), join(cmd, "scripts", "release-gate.mjs"));
symlinkSync(join(cmd, "scripts", "release-gate.mjs"), join(work, "gate-link.mjs"));
symlinkSync(cmd, join(work, "cmd-link"));
const starts = { "real path": join(cmd, "scripts", "release-gate.mjs"), "symlinked file": join(work, "gate-link.mjs"), "symlinked directory": join(work, "cmd-link", "scripts", "release-gate.mjs") };
const full = mkdtempSync(join(work, "full-"));
writeFileSync(join(full, "x"), "x");
const noRecord = mkdtempSync(join(work, "norecord-"));
for (const [how, script] of Object.entries(starts)) {
  await ok(`${how}: no arguments print the usage and exit 2; --compare without a record and a non-empty --out exit 1`, () => {
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: work, encoding: "utf8", env });
    const u = run();
    assert.equal(u.status, 2, u.stdout + u.stderr); assert.match(u.stderr, /usage:/);
    const c = run("--compare", noRecord);
    assert.equal(c.status, 1, c.stdout + c.stderr); assert.match(c.stdout, /STOP: no gate record/);
    const f = run("--out", full);
    assert.equal(f.status, 1, f.stdout + f.stderr); assert.match(f.stderr, /is not empty/);
  });
}
await ok("--out inside the checkout is refused with the reason, and the directory it made is removed", () => {
  const r = spawnSync(process.execPath, [starts["symlinked directory"], "--out", join(work, "cmd-link", "out")], { cwd: work, encoding: "utf8", env });
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /inside the checkout/);
  assert.equal(existsSync(join(cmd, "out")), false);
});

rmSync(work, { recursive: true, force: true });
console.log(`\nrelease-gate: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
