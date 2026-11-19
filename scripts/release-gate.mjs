#!/usr/bin/env node
// The release gate: ties the tarball to a reviewed commit. verify-tarball.mjs ties a tarball to the tree on disk;
// this adds what that cannot see, and is run by the maintainer, not by CI (it reads the registry).
//
//   node scripts/release-gate.mjs --out <dir>
//       before the publish. Refuses unless the tree has no local change (tracked or untracked), HEAD is on the
//       first-parent line of origin/master as last fetched, and package.json's version is not on the registry.
//       Then runs the repo's check (frozen install, typecheck, lint, dashes and paths, build, the unit suites),
//       packs into <dir> (new or empty), runs verify-tarball.mjs on that tarball, checks the tree again and prints
//       the tarball's sha1, sha512 integrity and sha256. Every check runs and is listed; any failure exits 1.
//   node scripts/release-gate.mjs --compare <tgz>
//       after `npm publish <tgz>`: the registry's dist.shasum and dist.integrity for package.json's version must
//       equal the tarball's. Exit 0 only on a match.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = `usage: node scripts/release-gate.mjs --out <dir>
       node scripts/release-gate.mjs --compare <tgz>`;
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

/** No tracked change and no untracked file that .gitignore does not cover. */
export function treeClean(/** @type {string} */ root, run = sh) {
  const r = run("git", ["status", "--porcelain"], root);
  return r.ok && r.out.trim() === "";
}

/**
 * HEAD is on the first-parent line of origin/master: a merge commit or a direct commit of master. A commit inside a
 * merged pull request is an ancestor of origin/master but not on that line, and can predate the branch's last fix, so
 * ancestry (`merge-base --is-ancestor`) does not qualify.
 */
export function headOnOriginMaster(/** @type {string} */ root, run = sh) {
  const head = run("git", ["rev-parse", "--verify", "HEAD^{commit}"], root);
  const line = run("git", ["rev-list", "--first-parent", "origin/master"], root);
  const id = head.out.trim();
  return head.ok && line.ok && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(id) && line.out.split("\n").includes(id);
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

/** The registry entry of name@version is the tarball: dist.shasum and dist.integrity both equal its digests. */
export async function registryMatches(/** @type {string} */ name, /** @type {string} */ version, /** @type {Uint8Array} */ bytes, registry = registryVersion) {
  const local = digests(bytes);
  let got;
  try { got = await registry(name, version); } catch (e) { return { ok: false, reason: `the registry could not be read (${e instanceof Error ? e.message : e})`, local }; }
  if (got.status !== 200) return { ok: false, reason: `${name}@${version} is not on the registry (HTTP ${got.status})`, local };
  const dist = got.meta?.dist ?? {};
  const ok = dist.shasum === local.sha1 && dist.integrity === local.integrity;
  return { ok, reason: ok ? "" : `the registry's ${name}@${version} (shasum ${dist.shasum}) is not this tarball (shasum ${local.sha1})`, local };
}

// The repo's check, in AGENTS.md's order.
const SUITE = [["install", "--frozen-lockfile"], ["typecheck"], ["lint"], ["check:dashes-paths"], ["build"], ["test"]];

/**
 * Every pre-publish check, logged in order; returns the failed ones and the packed tarball. `sh`, `registry` and
 * `verify` default to the real ones; a test stands in for them.
 * @param {{ root: string, out: string, log: (line: string) => void, sh?: Sh, registry?: RegistryRead,
 *   verify?: (tgz: string) => { ok: boolean, out: string } }} o
 * @returns {Promise<{ fails: string[], tarball?: string }>}
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
  log(`== release gate for ${pkg.name}@${pkg.version} at ${run("git", ["rev-parse", "--short", "HEAD"], root).out.trim()}`);
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
  return { fails, tarball };
}

async function main() {
  const a = process.argv.slice(2);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (a.length === 2 && a[0] === "--compare") {
    const tgz = resolve(String(a[1]));
    if (!existsSync(tgz)) { console.error(`STOP: ${tgz} not found`); return 1; }
    const m = await registryMatches(pkg.name, pkg.version, new Uint8Array(readFileSync(tgz)));
    console.log(`${pkg.name}@${pkg.version} local shasum ${m.local.sha1} ${m.ok ? "MATCH" : `MISMATCH: ${m.reason}`}`);
    return m.ok ? 0 : 1;
  }
  if (a.length !== 2 || a[0] !== "--out") { console.error(USAGE); return 2; }
  const out = resolve(String(a[1]));
  if (existsSync(out) && readdirSync(out).length) { console.error(`STOP: ${out} is not empty`); return 1; }
  mkdirSync(out, { recursive: true });
  const { fails, tarball } = await checkRelease({ root, out, log: (s) => console.log(s) });
  if (fails.length) { console.log(`\nREFUSED: ${fails.length} check(s) failed: ${fails.join("; ")}. Do not publish.`); return 1; }
  const d = digests(new Uint8Array(readFileSync(/** @type {string} */ (tarball))));
  console.log(`\nevery check passed: ${tarball}\n  sha1 ${d.sha1}\n  integrity ${d.integrity}\n  sha256 ${d.sha256}`);
  console.log(`publish that file, then: node scripts/release-gate.mjs --compare ${tarball}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(await main());
