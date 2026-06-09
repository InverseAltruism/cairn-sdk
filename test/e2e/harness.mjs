// Shared tiny test harness for the e2e suites (no deps). Tracks pass/fail, prints
// a clean report, exits non-zero on any failure.
export function makeHarness(title) {
  let pass = 0, fail = 0;
  const fails = [];
  const ok = (name, cond, detail = "") => {
    if (cond) { pass++; console.log(`  ✅ ${name}${detail ? "  — " + detail : ""}`); }
    else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
    return cond;
  };
  const okThrows = async (name, fn, ctorName) => {
    try { await fn(); ok(name, false, "no error thrown"); }
    catch (e) { ok(name, e?.constructor?.name === ctorName || e?.name === ctorName, `threw ${e?.constructor?.name}`); }
  };
  const section = (s) => console.log(`\n=== ${s} ===`);
  const done = () => {
    console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} [${title}]: ${pass} passed, ${fail} failed`);
    if (fail) console.log("  failed: " + fails.join("; "));
    return fail === 0;
  };
  return { ok, okThrows, section, done, get pass() { return pass; }, get fail() { return fail; } };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll `fn` until it returns truthy or timeout. Returns the value or null.
export async function until(fn, { timeoutMs = 120000, everyMs = 4000, label = "" } = {}) {
  const start = Date.now();
  let n = 0;
  while (Date.now() - start < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch { /* keep polling */ }
    n++;
    if (label && n % 3 === 0) console.log(`     …waiting for ${label} (${Math.round((Date.now() - start) / 1000)}s)`);
    await sleep(everyMs);
  }
  return null;
}
