// The `ts` blocks of README.md and docs/SDK-GUIDE.md that show `allNames` or the `/replica` entry, type-checked as an
// app would compile them: each block is its own ES module importing the package by its name (resolved to this repo's
// built dist/), under strict and noUncheckedIndexedAccess. @inversealtruism/cairnx-pin is not a dependency of this
// repo, so its one export the guide uses, PIN, is declared here with the replica's own Pin type. Needs `pnpm build`.
// Offline.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

const root = fileURLToPath(new URL("..", import.meta.url));
if (!existsSync(join(root, "dist", "index.d.ts"))) {
  console.log("  ✗ dist/ is not built: run `pnpm build` first");
  process.exit(1);
}

/** The ```ts blocks of a markdown file. */
const tsBlocks = (file) => [...readFileSync(join(root, file), "utf8").matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
const picked = ["README.md", "docs/SDK-GUIDE.md"].flatMap((f) => tsBlocks(f).map((code) => ({ f, code })))
  .filter(({ code }) => code.includes("allNames(") || code.includes("cairn-sdk/replica"));

console.log("doc snippets:");
ok("two blocks are picked: the guide's allNames walk and its replica example", () => {
  assert.equal(picked.length, 2, picked.map((p) => p.f).join(", "));
  assert.ok(picked.some((p) => p.code.includes("allNames(")) && picked.some((p) => p.code.includes("cairn-sdk/replica")));
});

const work = mkdtempSync(join(root, ".doc-snippets-"));
try {
  writeFileSync(join(work, "cairnx-pin.d.ts"), `declare module "@inversealtruism/cairnx-pin" { export const PIN: import("@inversealtruism/cairnx-replica").Pin; }\n`);
  const files = picked.map((p, i) => { const f = join(work, `snippet-${i}.mts`); writeFileSync(f, p.code); return f; });
  writeFileSync(join(work, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", lib: ["ES2022", "DOM"], module: "nodenext", moduleResolution: "nodenext",
      strict: true, noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: true, types: [],
    },
    files: ["cairnx-pin.d.ts", ...files.map((f) => f.slice(work.length + 1))],
  }));
  const r = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(work, "tsconfig.json")], { cwd: work, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  ok("every picked block compiles under strict settings against the built package", () => assert.equal(r.status, 0, out));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\ndoc-snippets: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
