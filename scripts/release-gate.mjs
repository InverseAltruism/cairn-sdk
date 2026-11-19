#!/usr/bin/env node
// The release gate: ties the tarball to a reviewed commit. verify-tarball.mjs ties a tarball to the tree on disk;
// this adds what that cannot see, and is run by the maintainer, not by CI (it reads the registry).
//
//   node scripts/release-gate.mjs --out <dir>
//       before the publish. Refuses unless the tree has no local change (tracked or untracked), HEAD is on the
//       first-parent line of refs/remotes/origin/master as last fetched, and package.json's version is not on the
//       registry. Then runs the repo's check (frozen install, typecheck, lint, dashes and paths, build, the unit
//       suites), packs into <dir> (new or empty, outside the checkout), runs verify-tarball.mjs on that tarball,
//       checks the tree and HEAD again, writes <dir>/release-gate.json (name, version, commit, tarball, digests)
//       and prints the commit and the tarball's sha1, sha512 integrity and sha256. Every check runs and is listed;
//       any failure exits 1 and writes no record.
//   node scripts/release-gate.mjs --compare <dir>
//       after `npm publish <dir>/<tgz>`: the registry's dist.shasum and dist.integrity for the version in
//       <dir>/release-gate.json must equal the digests recorded there. Exit 0 only on a match.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = `usage: node scripts/release-gate.mjs --out <dir>
       node scripts/release-gate.mjs --compare <dir>`;
export const RECORD = "release-gate.json";
const REGISTRY = "https://registry.npmjs.org";

/** @typedef {(cmd: string, args: string[], cwd: string) => { ok: boolean, out: string }} Sh */
/** @typedef {(name: string, version: string) => Promise<{ status: number, meta: any }>} RegistryRead */

/** @type {Sh} */
const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
};

/** @type {RegistryRead} */
export async function registryVersion(name, version) {
  const res = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}/${version}`);
  return { status: res.status, meta: res.ok ? await res.json() : null };
}

/** The digests npm records for a tarball: dist.shasum (sha1 hex) and dist.integrity (sha512 SRI), and the sha256. */
export function digests(/** @type {Uint8Array} */ bytes) {
  return {
    sha1: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * No tracked change and no untracked file that .gitignore does not cover, whatever status.showUntrackedFiles says,
 * and no file marked assume-unchanged (a lower-case `git ls-files -v` tag) or skip-worktree (`S`), which git status
 * does not compare.
 */
export function treeClean(/** @type {string} */ root, run = sh) {
  const r = run("git", ["status", "--porcelain", "--untracked-files=all"], root);
  const tags = run("git", ["ls-files", "-v"], root);
  return r.ok && r.out.trim() === "" && tags.ok && !tags.out.split("\n").some((l) => /^([a-z]|S) /.test(l));
}

/**
 * HEAD is on the first-parent line of origin/master: a merge commit or a direct commit of master. A commit inside a
 * merged pull request is an ancestor of origin/master but not on that line, and can predate the branch's last fix, so
 * ancestry (`merge-base --is-ancestor`) does not qualify. The full ref name: a local branch called origin/master would
 * win over the remote-tracking ref.
 */
export function headOnOriginMaster(/** @type {string} */ root, run = sh) {
  const id = headId(root, run);
  const line = run("git", ["rev-list", "--first-parent", "refs/remotes/origin/master"], root);
  return id !== "" && line.ok && line.out.split("\n").includes(id);
}

/** HEAD's full commit id, or "" when it cannot be read. */
export function headId(/** @type {string} */ root, run = sh) {
  const head = run("git", ["rev-parse", "--verify", "HEAD^{commit}"], root);
  const id = head.out.trim();
  return head.ok && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(id) ? id : "";
}

/** Only a registry 404 means the version is free; any other answer, an error included, refuses. */
export async function versionUnpublished(/** @type {string} */ name, /** @type {string} */ version, registry = registryVersion) {
  try {
    const { status } = await registry(name, version);
    return status === 404 ? { ok: true, reason: "" } : { ok: false, reason: status === 200 ? `${name}@${version} is already on the registry` : `the registry answered HTTP ${status} for ${name}@${version}` };
  } catch (e) {
    return { ok: false, reason: `the registry could not be read for ${name}@${version} (${e instanceof Error ? e.message : e})` };
  }
}

// The repo's check, in AGENTS.md's order.
const SUITE = [["install", "--frozen-lockfile"], ["typecheck"], ["lint"], ["check:dashes-paths"], ["build"], ["test"]];

/** @typedef {{ name: string, version: string, commit: string, tarball: string, sha1: string, integrity: string, sha256: string }} GateRecord */

/**
 * Every pre-publish check, logged in order; returns the failed ones, the packed tarball and, only when none failed,
 * the record written to <out>/release-gate.json. `sh`, `registry` and `verify` default to the real ones; a test
 * stands in for them.
 * @param {{ root: string, out: string, log: (line: string) => void, sh?: Sh, registry?: RegistryRead,
 *   verify?: (tgz: string) => { ok: boolean, out: string } }} o
 * @returns {Promise<{ fails: string[], tarball?: string, record?: GateRecord }>}
 */
export async function checkRelease(o) {
  const { root, out, log } = o;
  const run = o.sh ?? sh;
  const verify = o.verify ?? ((tgz) => run(process.execPath, [join(root, "scripts", "verify-tarball.mjs"), tgz], root));
  /** @type {string[]} */
  const fails = [];
  const chk = (/** @type {string} */ what, /** @type {boolean} */ c, detail = "") => {
    log(`  ${c ? "pass" : "FAIL"}: ${what}`);
    if (!c) { fails.push(what); if (detail) log(detail.trimEnd().split("\n").slice(-20).map((l) => `    ${l}`).join("\n")); }
  };
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const startHead = headId(root, run);
  log(`== release gate for ${pkg.name}@${pkg.version} at ${startHead || "(HEAD unreadable)"}`);
  chk("the tree has no local change", treeClean(root, run));
  chk("HEAD is on the first-parent line of origin/master", headOnOriginMaster(root, run));
  const free = await versionUnpublished(pkg.name, pkg.version, o.registry);
  chk(`${pkg.name}@${pkg.version} is not on the registry${free.ok ? "" : ` (${free.reason})`}`, free.ok);
  for (const args of SUITE) {
    const r = run("pnpm", args, root);
    chk(`pnpm ${args.join(" ")}`, r.ok, r.out);
  }
  const packed = run("pnpm", ["pack", "--pack-destination", out], root);
  const tarball = readdirSync(out).filter((f) => f.endsWith(".tgz")).map((f) => join(out, f))[0];
  chk("pnpm pack", packed.ok && !!tarball, packed.out);
  if (tarball) {
    const v = verify(tarball);
    chk("verify-tarball on the packed tarball", v.ok, v.out);
  }
  chk("the tree has no local change after the check", treeClean(root, run));
  chk("HEAD after the check is the commit the gate started at", startHead !== "" && headId(root, run) === startHead);
  if (fails.length || !tarball) return { fails, tarball };
  const d = digests(new Uint8Array(readFileSync(tarball)));
  /** @type {GateRecord} */
  const record = { name: pkg.name, version: pkg.version, commit: startHead, tarball, ...d };
  writeFileSync(join(out, RECORD), `${JSON.stringify(record, null, 2)}\n`);
  return { fails, tarball, record };
}

/**
 * After the publish: the registry's entry for the version recorded in <out>/release-gate.json carries the recorded
 * digests. The record, not a file handed in, is what binds the published bytes to the checked ones.
 * @param {{ out: string, registry?: RegistryRead }} o
 */
export async function compareRelease(o) {
  const path = join(o.out, RECORD);
  /** @type {GateRecord} */
  let rec;
  try { rec = JSON.parse(readFileSync(path, "utf8")); } catch (e) { return { ok: false, reason: `no gate record at ${path} (${e instanceof Error ? e.message : e}); run the gate with --out ${o.out} first` }; }
  if (typeof rec?.name !== "string" || typeof rec.version !== "string" || typeof rec.sha1 !== "string" || typeof rec.integrity !== "string")
    return { ok: false, reason: `${path} is not a gate record` };
  let got;
  try { got = await (o.registry ?? registryVersion)(rec.name, rec.version); } catch (e) { return { ok: false, reason: `the registry could not be read (${e instanceof Error ? e.message : e})`, rec }; }
  if (got.status !== 200) return { ok: false, reason: `${rec.name}@${rec.version} is not on the registry (HTTP ${got.status})`, rec };
  const dist = got.meta?.dist ?? {};
  const ok = dist.shasum === rec.sha1 && dist.integrity === rec.integrity;
  return { ok, reason: ok ? "" : `the registry's ${rec.name}@${rec.version} (shasum ${dist.shasum}) is not the checked tarball (shasum ${rec.sha1}, commit ${rec.commit})`, rec };
}

async function main() {
  const a = process.argv.slice(2);
  const root = fileURLToPath(new URL("..", import.meta.url));
  if (a.length === 2 && a[0] === "--compare") {
    const m = await compareRelease({ out: resolve(String(a[1])) });
    console.log(m.ok ? `${m.rec?.name}@${m.rec?.version} at ${m.rec?.commit}: registry shasum ${m.rec?.sha1} MATCH` : `STOP: ${m.reason}`);
    return m.ok ? 0 : 1;
  }
  if (a.length !== 2 || a[0] !== "--out") { console.error(USAGE); return 2; }
  const out = resolve(String(a[1]));
  if (existsSync(out) && readdirSync(out).length) { console.error(`STOP: ${out} is not empty`); return 1; }
  mkdirSync(out, { recursive: true });
  // Inside the checkout the tarball is an untracked file and the second tree check would fail without saying why.
  if (!relative(realpathSync(root), realpathSync(out)).startsWith("..")) {
    if (!readdirSync(out).length) rmdirSync(out);
    console.error(`STOP: ${out} is inside the checkout; use a directory outside it`);
    return 1;
  }
  const { fails, record } = await checkRelease({ root, out, log: (s) => console.log(s) });
  if (fails.length || !record) { console.log(`\nREFUSED: ${fails.length} check(s) failed: ${fails.join("; ")}. Do not publish.`); return 1; }
  console.log(`\nevery check passed: ${record.tarball}\n  commit ${record.commit}\n  sha1 ${record.sha1}\n  integrity ${record.integrity}\n  sha256 ${record.sha256}`);
  console.log(`publish that file, then: node scripts/release-gate.mjs --compare ${out}`);
  return 0;
}

// Real paths on both sides: started through a symlinked checkout, argv[1] is the link and import.meta.url the target.
const invoked = (() => { try { return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : ""; } catch { return ""; } })();
if (invoked && import.meta.url === invoked) process.exit(await main());
