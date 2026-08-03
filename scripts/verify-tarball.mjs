#!/usr/bin/env node
// Release runbook step 9, as ONE executable assertion over the bytes that will actually be published.
//
// Why this script exists and why it, not a hook, is the gate: `dist/` is gitignored and untracked,
// `pnpm pack` fires `prepack` but NOT `prepublishOnly`, and publishing a PRE-MADE TARBALL (this
// project's sanctioned path, because the npm 2FA-bypass token cannot publish) fires NEITHER hook. So
// `prepublishOnly = build + test` never runs at publish time, which means test/spv-checkpoint.test.ts,
// the SDK-vs-swapguard drift gate, is NOT in the sanctioned publish path. Saying otherwise is the
// over-claim this script replaces: the gate that IS in the path now checks both things.
//
// Checks, all against the extracted tarball, never the working tree, and run over BOTH package entries
// (dist/index.js is `module` + exports["."].import; dist/index.cjs is `main` + exports["."].require, so
// it is what every CommonJS consumer loads). Checking only the ESM entry left the CJS bytes ungated:
// a tarball whose index.cjs carried the old anchor or a stripped ASDK-1 arm passed green.
//   1. the entry exists (a missing entry FAILS, it is never skipped) and carries the ASDK-1
//      transient arm ("fetch failed").
//   2. the entry carries a parseable DEFAULT_SPV_CHECKPOINT literal.
//   3. that height+hash pair equals cairn's public/trade/swapguard.js CP (the fund-adjacent pin).
// A missing sibling cairn checkout FAILS here (a silent skip is exactly the class this gate exists for).
// CAIRN_REPO / CAIRN_SWAPGUARD must point at the cairn tree carrying the CP you intend to ship against.
//
// Usage: node scripts/verify-tarball.mjs [path/to/pkg.tgz]     (default: ./inversealtruism-cairn-sdk-<version>.tgz)
// Exit 0 = publish may proceed. Exit 1 = stop, do not publish. Never report-only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const tgz = resolve(process.argv[2] ?? join(repo, `inversealtruism-cairn-sdk-${pkg.version}.tgz`));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };
const die = (msg) => { console.error("  FAIL " + msg); console.error(`\nverify-tarball: ${pass} passed, ${fail + 1} failed`); process.exit(1); };

console.log(`verify-tarball: ${tgz}`);
if (!existsSync(tgz)) die(`tarball not found: ${tgz} (run \`pnpm pack\` first)`);
console.log(`  sha256 ${createHash("sha256").update(readFileSync(tgz)).digest("hex")}`);

// The swapguard CP is resolved BEFORE any tarball work so an absent sibling fails loud and early.
// Same resolution order as test/spv-checkpoint.test.ts.
const candidates = [
  process.env.CAIRN_SWAPGUARD,
  process.env.CAIRN_REPO && join(process.env.CAIRN_REPO, "public/trade/swapguard.js"),
  fileURLToPath(new URL("../../cairn/public/trade/swapguard.js", import.meta.url)),
].filter(Boolean);
// An env var that is SET names the operator's intent. If it points at nothing, falling through to the
// default sibling would quietly check a DIFFERENT tree's anchor and report green, which is the same
// silent-skip class in a new coat. A typo stops the release instead.
for (const [name, p] of [
  ["CAIRN_SWAPGUARD", process.env.CAIRN_SWAPGUARD],
  ["CAIRN_REPO", process.env.CAIRN_REPO && join(process.env.CAIRN_REPO, "public/trade/swapguard.js")],
]) {
  if (p && !existsSync(p)) die(`${name} is set but ${p} does not exist (refusing to fall back to another cairn tree)`);
}
const swapguard = candidates.find((p) => existsSync(p));
if (!swapguard) {
  console.error("  FAIL cairn swapguard.js not found, so the checkpoint pin CANNOT be checked.");
  console.error("     Checked: " + candidates.join(", "));
  console.error("     Set CAIRN_REPO or CAIRN_SWAPGUARD to the cairn tree whose CP this release ships against.");
  die("no swapguard.js (this gate never skips: an unchecked trust anchor is the whole point of the gate)");
}
const cpMatch = readFileSync(swapguard, "utf8")
  .match(/const\s+CP\s*=\s*\{\s*height:\s*(\d+)\s*,\s*hash:\s*["']([0-9a-fA-Fx]+)["']/);
if (!cpMatch) die(`could not parse the CP literal out of ${swapguard}`);
const CP = { height: Number(cpMatch[1]), hash: cpMatch[2].toLowerCase() };
console.log(`  swapguard ${swapguard}`);
console.log(`  swapguard CP height=${CP.height} hash=${CP.hash}`);

const work = mkdtempSync(join(tmpdir(), "cairn-sdk-tarball-"));
try {
  execFileSync("tar", ["xf", tgz, "-C", work], { stdio: ["ignore", "ignore", "inherit"] });
  // Both entries of exports["."]: the ESM one and the CJS one every `require()` consumer gets.
  for (const entry of ["dist/index.js", "dist/index.cjs"]) {
    const distPath = join(work, "package", entry);
    if (!existsSync(distPath)) die(`package/${entry} is missing from the tarball (a dist-less or half-built pack)`);
    const dist = readFileSync(distPath, "utf8");

    // 1. ASDK-1: the Node/undici transport wording must be in the SHIPPED classifier.
    ok(`packed ${entry} carries the ASDK-1 "fetch failed" arm`, dist.includes("fetch failed"));

    // 2 + 3. The packed anchor, and its equality with cairn's swapguard CP.
    const m = dist.match(/DEFAULT_SPV_CHECKPOINT\s*=\s*\{\s*height:\s*(\d+)\s*,\s*hash:\s*["']([0-9a-fA-Fx]+)["']/);
    ok(`packed ${entry} carries a parseable DEFAULT_SPV_CHECKPOINT`, !!m);
    if (m) {
      const packed = { height: Number(m[1]), hash: m[2].toLowerCase() };
      console.log(`  packed  ${entry} CP height=${packed.height} hash=${packed.hash}`);
      ok(`packed ${entry} checkpoint height matches swapguard (${CP.height})`, packed.height === CP.height);
      ok(`packed ${entry} checkpoint hash matches swapguard (lowercased)`, packed.hash === CP.hash);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\nverify-tarball: ${pass} passed, ${fail} failed`);
if (fail) {
  console.error("STOP: do not publish this tarball.");
  process.exit(1);
}
