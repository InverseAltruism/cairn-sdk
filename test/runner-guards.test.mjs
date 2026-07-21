// test/run.mjs guard-of-the-guard tests (REBIND B8-docs/FU-9, closes N24 3/3 for cairn-sdk).
//
// The runner IS the gate: every unit suite in this repo reaches prepublishOnly/CI only through
// test/run.mjs. Its aggregation invariant ("a mid-suite failure still runs the rest AND forces a
// non-zero exit") was previously proven only by ephemeral commit-message mutations, never by a
// checked-in fixture. That is the exact dead-green class the REBIND campaign keeps re-finding (a
// runner that silently stops aggregating hides every test behind the first red one; the fail-fast
// `&&` chain this runner replaced hid 69 assertions behind one red suite). cairn-wallet and cairn
// carry the same fixture (their B8w/B0 runner-guards); this is the missing third port.
//
// Each case drives the REAL runner (a child `node test/run.mjs`) against a throwaway sandbox, so it
// exercises the shipped control flow, not a re-implementation of it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

// Build an isolated runner sandbox: a copy of run.mjs plus the case's fixture files. node_modules is
// symlinked so the tsx loader path inside run.mjs still resolves. Unlike the wallet's runner, this one
// requires no selftest.ts: it globs test/*.test.{ts,mjs} and nothing else.
function sandbox(files) {
  const dir = mkdtempSync(join(tmpdir(), "cairnsdk-runner-"));
  mkdirSync(join(dir, "test"), { recursive: true });
  cpSync(join(here, "run.mjs"), join(dir, "test", "run.mjs"));
  try { symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir"); } catch { /* fall through */ }
  if (!existsSync(join(dir, "node_modules"))) cpSync(join(root, "node_modules", "tsx"), join(dir, "node_modules", "tsx"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "test", name), body);
  return dir;
}
const runRunner = (dir, env = {}) =>
  spawnSync(process.execPath, [join(dir, "test", "run.mjs")], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });

console.log("test/run.mjs guards:");

// GUARD 1 (N24, the headline): a 3-file middle-fails fixture. The runner must CONTINUE past a
// mid-suite failure (run every remaining file) AND still exit non-zero. Break the continue-on-failure
// loop and the "the file after the failure still ran" assertion goes red, the whole point.
ok("a mid-suite failure still runs the rest AND forces a non-zero exit", () => {
  const dir = sandbox({
    // glob sorts alphabetically: a_ < b_ < c_ ; the FAIL sits in the MIDDLE, c_ runs AFTER it
    "a_pass.test.mjs": "console.log('A_RAN');\n",
    "b_fail.test.mjs": "console.log('B_RAN then failing');\nprocess.exit(1);\n",
    "c_pass.test.mjs": "console.log('C_RAN_AFTER_FAILURE');\n",
  });
  try {
    const r = runRunner(dir);
    assert.equal(r.status, 1, "a suite with a failing file must exit non-zero");
    assert.match(r.stdout, /C_RAN_AFTER_FAILURE/, "the file AFTER the mid-suite failure must still have run (aggregation-continuation)");
    assert.match(r.stdout, /b_fail\.test\.mjs/, "the summary must name the offending file");
    assert.doesNotMatch(r.stdout, /ALL TEST FILES PASS/, "a red suite must never claim success");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// GUARD 2: a hang is a FAILURE, not a pass and not a skip (this runner carries the same per-file
// timeout machinery as cairn's B0b fix). setInterval, NOT an unsettled top-level await: tsx detects
// the latter and exits 13, so the fixture would never actually hang and the guard would pass vacuously.
ok("a hanging test file fails the runner (does not hang it, does not pass)", () => {
  const dir = sandbox({ "hang.test.mjs": "console.log('starting');\nsetInterval(() => {}, 1000);\n" });
  try {
    const r = runRunner(dir, { CAIRN_TEST_TIMEOUT_MS: "4000" });
    assert.equal(r.status, 1, "runner must exit non-zero");
    assert.match(r.stdout, /TIMED OUT/, "must report a timeout");
    assert.match(r.stdout, /hang\.test\.mjs/, "must name the offending file");
    assert.doesNotMatch(r.stdout, /ALL TEST FILES PASS/, "must not claim success");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// GUARD 3: exit-0-with-a-top-level-SKIP is classified SKIPPED (not a silent pass); an INDENTED
// skip-shaped line is NOT (the /^SKIP:/m asymmetry is load-bearing and easy to regress). No cairn-sdk
// suite prints SKIP today; the classification is kept so a future one is counted, not dead-green.
ok("a top-level SKIP: line is SKIPPED, an indented one is not", () => {
  const dir = sandbox({
    "topskip.test.mjs": "console.log('SKIP: prereq missing');\n",
    "indentskip.test.mjs": "console.log('      (SKIP: looks like a skip but is not)');\n",
  });
  try {
    const r = runRunner(dir);
    assert.match(r.stdout, /1 SKIPPED/, "exactly one file should be classified SKIPPED");
    assert.match(r.stdout, /topskip\.test\.mjs/, "the top-level SKIP file is the skipped one");
    assert.doesNotMatch(r.stdout.split("SKIPPED (unmet prereq")[1] || "", /indentskip/, "an indented skip must NOT be classified SKIPPED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// GUARD 4: CAIRN_E2E_REQUIRED=1 escalates a skip into a hard failure (CI posture).
ok("CAIRN_E2E_REQUIRED=1 turns a SKIP into a hard failure", () => {
  const dir = sandbox({ "topskip.test.mjs": "console.log('SKIP: prereq missing');\n" });
  try {
    const r = runRunner(dir, { CAIRN_E2E_REQUIRED: "1" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SKIPPED but CAIRN_E2E_REQUIRED=1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`runner-guards: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
