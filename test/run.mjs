#!/usr/bin/env node
// Glob-driven unit-test runner (REBIND B3 / F13 fix), mirroring cairn/test/run.mjs.
//
// `pnpm test` was a nine-deep shell `&&` chain, hand-maintained in package.json. Two defects:
// (1) hand-maintained: a new test/*.test.ts file had to be remembered into the chain or it was
//     silently never run;
// (2) fail-fast: the chain stopped at the FIRST failing suite, so when errors.test.ts (third in
//     the chain) went red on the 0.3.1 SDK_VERSION drift, the six suites behind it (69 assertions,
//     including the spv-checkpoint cross-repo anchor parity that prepublishOnly is supposed to
//     gate) never executed at all.
// This runner discovers every test/*.test.ts and test/*.test.mjs by glob, runs ALL of them even
// after a failure, prints a per-file verdict, and exits non-zero if ANY failed. test/e2e/* is
// deliberately not matched: those are live-network harnesses with their own pnpm scripts.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Every unit suite, alphabetically. Glob-driven so a new suite cannot be forgotten.
const tests = [];
for (const f of readdirSync(here).sort()) {
  if (f.endsWith(".test.ts") || f.endsWith(".test.mjs")) tests.push(join("test", f));
}
if (tests.length === 0) {
  process.stderr.write("test/run.mjs: no test/*.test.{ts,mjs} files found (glob rot?)\n");
  process.exit(2);
}

// Same SKIP classification as cairn/test/run.mjs: a suite that exits 0 after printing a `SKIP:`
// line is NOT a pass (dead-green class). No cairn-sdk suite prints SKIP today (spv-checkpoint's
// sibling-absent path prints UNCHECKED to stderr instead, by its own documented design), but the
// convention is kept so a future suite that adopts it is classified, not miscounted.
// CAIRN_E2E_REQUIRED=1 turns a SKIP into a hard failure.
const requireE2E = process.env.CAIRN_E2E_REQUIRED === "1";

// Per-file wall-clock cap, same posture as cairn's B0b fix: a hang is a failure, never a pass and
// never an endless wait. These suites are offline and fast; the default is generous anyway.
const rawTimeout = process.env.CAIRN_TEST_TIMEOUT_MS;
const TIMEOUT_MS = rawTimeout === undefined ? 180_000 : Number(rawTimeout);
if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS <= 0) {
  process.stderr.write(`test/run.mjs: CAIRN_TEST_TIMEOUT_MS must be a positive number, got ${JSON.stringify(rawTimeout)}\n`);
  process.exit(2);
}

// Spawn node with the tsx loader DIRECTLY (not via `pnpm exec tsx`): spawnSync's timeout kills only
// the immediate child, and a shim chain would leave the real test process orphaned past the cap.
const tsxDir = join(root, "node_modules", "tsx", "dist");
const nodeArgs = ["--require", join(tsxDir, "preflight.cjs"), "--import", pathToFileURL(join(tsxDir, "loader.mjs")).href];

let passed = 0;
const skipped = [];
const failed = [];
const slow = [];
for (const t of tests) {
  process.stdout.write(`\n== ${t} ==\n`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [...nodeArgs, t], {
    cwd: root, stdio: ["inherit", "pipe", "pipe"], encoding: "utf8", env: process.env,
    timeout: TIMEOUT_MS, killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,   // a chatty-but-passing suite must not be mistaken for a hang (ENOBUFS)
  });
  const secs = (Date.now() - t0) / 1000;
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (secs >= TIMEOUT_MS / 1000 * 0.5) slow.push(`${t} (${secs.toFixed(1)}s)`);
  const didSkip = /^SKIP:/m.test(r.stdout || "");
  // Distinguish kill reasons explicitly (ETIMEDOUT vs ENOBUFS vs external kill), same as cairn's runner.
  if (r.error?.code === "ETIMEDOUT") {
    failed.push(`${t} (TIMED OUT after ${TIMEOUT_MS / 1000}s: a hang is a failure, not a skip)`);
  } else if (r.error) {
    failed.push(`${t} (runner error ${r.error.code || r.error.message} after ${secs.toFixed(1)}s)`);
  } else if (r.status === null && r.signal) {
    failed.push(`${t} (killed by ${r.signal} after ${secs.toFixed(1)}s)`);
  } else if (r.status === 0 && didSkip) {
    if (requireE2E) failed.push(`${t} (SKIPPED but CAIRN_E2E_REQUIRED=1)`);
    else skipped.push(t);
  } else if (r.status === 0) {
    passed++;
    process.stdout.write(`PASS ${t} (${secs.toFixed(1)}s)\n`);
  } else {
    failed.push(`${t} (exit ${r.status})`);
    process.stdout.write(`FAIL ${t} (exit ${r.status}, ${secs.toFixed(1)}s)\n`);
  }
}

process.stdout.write(`\n========================================\n`);
process.stdout.write(`test/run.mjs: ${passed}/${tests.length} files passed${skipped.length ? `, ${skipped.length} SKIPPED` : ""}\n`);
if (skipped.length) process.stdout.write(`SKIPPED (unmet prereq; set CAIRN_E2E_REQUIRED=1 to require):\n  ${skipped.join("\n  ")}\n`);
if (slow.length) process.stdout.write(`SLOW (over half the ${TIMEOUT_MS / 1000}s per-file cap):\n  ${slow.join("\n  ")}\n`);
if (failed.length) {
  process.stdout.write(`FAILED:\n  ${failed.join("\n  ")}\n`);
  process.exit(1);
}
process.stdout.write(skipped.length ? `ALL RUN TEST FILES PASS (${skipped.length} skipped)\n` : `ALL TEST FILES PASS\n`);
