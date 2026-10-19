// scripts/check-dashes-paths.mjs on a throwaway git sandbox (one file per case) and on this repo.
// Run: pnpm exec tsx test/check-dashes-paths.test.mjs   (offline)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { offences, PATH_EXCEPTIONS } from "../scripts/check-dashes-paths.mjs";

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

const root = fileURLToPath(new URL("..", import.meta.url));
const EM = "\u2014";

console.log("check-dashes-paths:");
ok("this repo is clean", () => assert.deepEqual(offences(root), []));
ok("every exception names its reason", () => {
  for (const [f, r] of Object.entries(PATH_EXCEPTIONS)) assert.ok(typeof r === "string" && r.length > 10, f);
});

const dir = mkdtempSync(join(tmpdir(), "cairnsdk-dashes-"));
try {
  const put = (f, text, track = true) => {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
    if (track) execFileSync("git", ["add", f], { cwd: dir });
  };
  execFileSync("git", ["init", "-q"], { cwd: dir });
  put("README.md", `a ${EM} b\n`);
  put("docs/archive/old.md", `a ${EM} b\n`);
  put("notes.txt", `a ${EM} b\n`);
  put("untracked.md", `a ${EM} b\n`, false);
  put("docs/guide.md", "load ../cairn-wallet/dist and /opt/cairn_substrate/csd-sdk\n");
  put("src/reads-sdk.mjs", 'const d = process.env.X ?? "../csd-sdk/packages";\n');
  put("src/reads-host.ts", 'import x from "/opt/cairn_substrate/cairn/public/a.js";\n');
  put("tools/run.sh", 'cd "${DIR:-../cairnx}"\n');
  put("src/local.ts", 'import { a } from "../cairnx.js";\nimport { b } from "../csd-local.ts";\n');
  put("scripts/ux-live-readonly.mjs", 'const EXT = "/opt/cairn_substrate/cairn-wallet/dist";\n');
  ok("only the tracked offences outside the exceptions are reported", () => {
    assert.deepEqual(offences(dir).map((l) => l.split(":")[0]).sort(), ["README.md", "src/reads-host.ts", "src/reads-sdk.mjs", "tools/run.sh"]);
  });
  ok("an em dash is reported as one", () => assert.ok(offences(dir).includes("README.md: em dash (U+2014)")));
  ok("a sibling read names the path it matched", () => assert.ok(offences(dir).includes("src/reads-sdk.mjs: reads a sibling checkout (../csd-sdk)")));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\ncheck-dashes-paths: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
