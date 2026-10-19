// biome.json enables exactly four rules (STANDARDS section 8): unused imports, focused tests and ts-ignore directives
// are errors, so `pnpm lint` fails on them; empty blocks are a warning until the 91 existing ones are fixed. Every
// other rule and the formatter are off. Runs the real Biome binary on a throwaway git sandbox holding one
// violation of each rule plus code that the recommended preset would flag.
// Run: pnpm exec tsx test/lint-config.test.mjs   (offline)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

const root = fileURLToPath(new URL("..", import.meta.url));
const biome = join(root, "node_modules", "@biomejs", "biome", "bin", "biome");
const lint = (dir, args) => spawnSync(process.execPath, [biome, ...args], { cwd: dir, encoding: "utf8" });

console.log("lint config:");
const dir = mkdtempSync(join(tmpdir(), "cairnsdk-lint-"));
try {
  copyFileSync(join(root, "biome.json"), join(dir, "biome.json"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "b.ts"), "export const x = 1;\n");
  writeFileSync(join(dir, "violations.ts"), [
    'import { x } from "./b";',
    "// @ts-ignore",
    "const y: number = 1;",
    "try { void y; } catch {}",
    'test.only("t", () => 1);',
    "",
  ].join("\n"));
  writeFileSync(join(dir, "other.ts"), "var z = 1; if (z == 2) { debugger; }\nexport   const   w=z;\n");
  writeFileSync(join(dir, "clean.ts"), 'import { x } from "./b";\ntry { void x; } catch { /* reason */ }\nexport {};\n');

  const run = lint(dir, ["lint", "--reporter=json", "--max-diagnostics=none", "."]);
  const report = JSON.parse(run.stdout);
  ok("the four rules fire on the sandbox with the configured severities", () => {
    const found = report.diagnostics.filter((d) => d.category?.startsWith("lint/")).map((d) => `${d.location.path}|${d.category}|${d.severity}`).sort();
    assert.deepEqual(found, [
      "violations.ts|lint/correctness/noUnusedImports|error",
      "violations.ts|lint/suspicious/noEmptyBlockStatements|warning",
      "violations.ts|lint/suspicious/noFocusedTests|error",
      "violations.ts|lint/suspicious/noTsIgnore|error",
    ]);
  });
  ok("an error-level finding fails the run", () => assert.equal(run.status, 1));
  ok("Biome reports nothing about the config itself (no deprecated or unknown key)", () => {
    assert.deepEqual(report.diagnostics.filter((d) => d.location?.path === "biome.json"), []);
  });

  rmSync(join(dir, "violations.ts"));
  ok("`biome check` (lint, formatter, assist) passes var, ==, debugger, unformatted code and a catch with its reason inside", () => {
    assert.equal(lint(dir, ["check", "."]).status, 0);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nlint-config: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
