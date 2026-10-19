// The CI workflow's security shape: the token is read-only, no checkout keeps credentials, every action is pinned to
// a full commit SHA, and the secret scan runs the pinned gitleaks over the full history including merge diffs (the
// default log shows no diff for a merge, so a secret added in a conflict resolution would go unscanned).
// Run: pnpm exec tsx test/ci-workflow.test.mjs   (offline)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const GITLEAKS_SHA256 = "ba6dbb656933921c775ee5a2d1c13a91046e7952e9d919f9bac4cec61d628e7d"; // 8.18.4 linux_x64, from the release's checksums file

ok("the workflow token is read-only", () => {
  assert.match(ci, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(ci, /:\s*write\b/);
});
ok("every checkout sets persist-credentials: false", () => {
  const checkouts = ci.split("\n").map((l, i) => [l, i]).filter(([l]) => /uses: actions\/checkout@/.test(l));
  assert.ok(checkouts.length >= 2, `${checkouts.length} checkouts`);
  const lines = ci.split("\n");
  for (const [, i] of checkouts) {
    const block = lines.slice(i + 1, i + 5).join("\n");
    assert.match(block, /persist-credentials: false/, `checkout at line ${i + 1}`);
  }
});
ok("every action is pinned to a full commit SHA", () => {
  const uses = [...ci.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
});
ok("the secret scan: pinned gitleaks, full history, merge diffs", () => {
  assert.ok(ci.includes(GITLEAKS_SHA256), "gitleaks sha256");
  assert.match(ci, /fetch-depth: 0/);
  assert.match(ci, /--log-opts="[^"]*--all[^"]*--diff-merges=first-parent[^"]*"/);
});

console.log(`ci-workflow: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
