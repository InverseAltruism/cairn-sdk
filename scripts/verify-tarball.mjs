#!/usr/bin/env node
// Publish gate over the bytes that will actually be published. `dist/` is untracked, `pnpm pack` fires
// `prepack` but not `prepublishOnly`, and publishing a pre-made tarball (the sanctioned path here) fires no
// hook, so this script is the check that runs on the tarball itself.
//
//   1. Rebuild this tree by running package.json's `build` (a plain `tsup ...` command) through node from
//      node_modules with only PATH and HOME in the environment, so no npm/pnpm config (ignore-scripts,
//      script-shell, ...) can skip or fake it; a non-zero exit stops here. Pack with scripts off, require the
//      packed dist/ to equal the files just built, then require the tarball's sha256 to equal the fresh pack's.
//      The pack is deterministic, so any edited, stale or foreign byte in the tarball fails. On a mismatch
//      the differing paths are listed.
//   2. Both package entries (dist/index.js for ESM, dist/index.cjs for require()) exist, carry the ASDK-1
//      transient arm ("fetch failed") and a parseable DEFAULT_SPV_CHECKPOINT, which is printed.
// The checkpoint's agreement with the chain is test/spv-checkpoint.test.ts (a pinned header fixture); no
// other repository is read.
//
// Usage: node scripts/verify-tarball.mjs [path/to/pkg.tgz]     (default: ./inversealtruism-cairn-sdk-<version>.tgz)
// Exit 0 = publish may proceed. Exit 1 = stop, do not publish.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const tgz = resolve(process.argv[2] ?? join(repo, `inversealtruism-cairn-sdk-${pkg.version}.tgz`));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };
const die = (msg) => { console.error("  FAIL " + msg); console.error(`\nverify-tarball: ${pass} passed, ${fail + 1} failed`); process.exit(1); };
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** Every file under `dir`, relative path -> sha256. */
const tree = (dir, rel = "", out = new Map()) => {
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) tree(dir, r, out); else out.set(r, sha256(join(dir, r)));
  }
  return out;
};

console.log(`verify-tarball: ${tgz}`);
if (!existsSync(tgz)) die(`tarball not found: ${tgz} (run \`pnpm pack\` first)`);
const given = sha256(tgz);
console.log(`  sha256 ${given}`);

const work = mkdtempSync(join(tmpdir(), "cairn-sdk-tarball-"));
try {
  // 1. Rebuild and repack, then compare whole-tarball bytes.
  const freshDir = join(work, "fresh");
  const buildArgs = String(pkg.scripts?.build ?? "").trim().split(/\s+/);
  if (buildArgs[0] !== "tsup" || buildArgs.some((a) => !/^[\w./,=-]+$/.test(a))) die(`package.json "build" is not a plain tsup command: ${pkg.scripts?.build}`);
  const tsupDir = join(repo, "node_modules", "tsup");
  const tsupBin = join(tsupDir, JSON.parse(readFileSync(join(tsupDir, "package.json"), "utf8")).bin.tsup);
  const built = spawnSync(process.execPath, [tsupBin, ...buildArgs.slice(1)], {
    cwd: repo, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, stdio: ["ignore", "ignore", "inherit"],
  });
  if (built.status !== 0) die(`the build (${buildArgs.join(" ")}) exited ${built.status ?? built.signal}`);
  // Taken before pnpm runs: a pnpm hook (a global pnpmfile's beforePacking, which runs even with scripts off) could
  // rewrite dist/ between the build and the pack.
  const builtDist = tree(join(repo, "dist"));
  execFileSync("pnpm", ["pack", "--pack-destination", freshDir], {
    cwd: repo, env: { ...process.env, npm_config_ignore_scripts: "true" }, stdio: ["ignore", "ignore", "inherit"],
  });
  const freshTgz = readdirSync(freshDir).filter((f) => f.endsWith(".tgz")).map((f) => join(freshDir, f))[0];
  if (!freshTgz) die("`pnpm pack` produced no tarball");
  const fresh = sha256(freshTgz);
  console.log(`  fresh  ${fresh} (rebuilt and repacked from ${repo})`);
  ok("tarball sha256 equals a fresh build and pack of this tree", given === fresh);

  const givenX = join(work, "given"), freshX = join(work, "fresh-x");
  for (const [src, dst] of [[tgz, givenX], [freshTgz, freshX]]) {
    mkdirSync(dst, { recursive: true });
    execFileSync("tar", ["xf", src, "-C", dst], { stdio: ["ignore", "ignore", "inherit"] });
  }
  const packedDist = tree(join(freshX, "package", "dist"));
  ok("the fresh pack's dist/ equals the files just built",
    builtDist.size === packedDist.size && [...builtDist].every(([p, h]) => packedDist.get(p) === h));
  if (given !== fresh) {
    const a = tree(givenX), b = tree(freshX);
    for (const p of new Set([...a.keys(), ...b.keys()])) {
      if (a.get(p) !== b.get(p)) console.log(`    differs: ${p}${!a.has(p) ? " (missing from the tarball)" : !b.has(p) ? " (not in a fresh pack)" : ""}`);
    }
  }

  // 2. Both entries of exports["."], read from the given tarball.
  for (const entry of ["dist/index.js", "dist/index.cjs"]) {
    const distPath = join(givenX, "package", entry);
    if (!existsSync(distPath)) die(`package/${entry} is missing from the tarball (a dist-less or half-built pack)`);
    const dist = readFileSync(distPath, "utf8");
    ok(`packed ${entry} carries the ASDK-1 "fetch failed" arm`, dist.includes("fetch failed"));
    const m = dist.match(/DEFAULT_SPV_CHECKPOINT\s*=\s*\{\s*height:\s*(\d+)\s*,\s*hash:\s*["']([0-9a-fA-Fx]+)["']/);
    ok(`packed ${entry} carries a parseable DEFAULT_SPV_CHECKPOINT`, !!m);
    if (m) console.log(`  packed  ${entry} CP height=${m[1]} hash=${m[2].toLowerCase()}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\nverify-tarball: ${pass} passed, ${fail} failed`);
if (fail) {
  console.error("STOP: do not publish this tarball.");
  process.exit(1);
}
