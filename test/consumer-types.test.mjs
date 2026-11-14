// scripts/check-consumer-types.mjs over this package as it would be packed (package.json and the built dist/),
// and over the same package with the exports map of 0.8.2, which gave `require` the ESM .d.ts files: a CommonJS
// consumer under node16 resolution then fails with TS1479. Needs a build (`pnpm build`). Offline.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { consumerTypeChecks } from "../scripts/check-consumer-types.mjs";

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

const root = fileURLToPath(new URL("..", import.meta.url));
if (!existsSync(join(root, "dist", "index.d.cts"))) {
  console.log("  ✗ dist/ is not built: run `pnpm build` first");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "cairn-sdk-consumer-test-"));
let n = 0;
const verdicts = (pkgJson) => {
  const dir = join(work, `package-${n++}`);
  cpSync(join(root, "dist"), join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson, null, 2));
  return Object.fromEntries(consumerTypeChecks(dir, root).map((c) => [c.name.split(" consumer")[0].replace(/^an? /, ""), c]));
};
const show = (c) => `${c.name}\n        ${c.detail.join("\n        ")}`;

try {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  console.log("consumer typecheck:");
  const now = verdicts(pkg);
  ok("this package: every mapped file exists and all three consumers typecheck", () => {
    for (const c of Object.values(now)) assert.ok(c.ok, show(c));
    assert.equal(Object.keys(now).length, 4);
  });

  // The 0.8.2 map: one `types` per entry, shared by `import` and `require`.
  const flat = Object.fromEntries(Object.entries(pkg.exports).map(([k, v]) => [k, { types: v.import.types, import: v.import.default, require: v.require.default }]));
  const old = verdicts({ ...pkg, exports: flat });
  ok("the 0.8.2 map: the node16 CommonJS consumer fails with TS1479 on every subpath", () => {
    const cjs = old["node16-cjs"];
    assert.equal(cjs.ok, false);
    assert.equal(cjs.detail.filter((l) => /error TS1479/.test(l)).length, Object.keys(pkg.exports).length, show(cjs));
  });
  ok("the 0.8.2 map: the ESM and bundler consumers still pass (the check is not failing on everything)", () => {
    assert.ok(old["node16-esm"].ok, show(old["node16-esm"]));
    assert.ok(old.bundler.ok, show(old.bundler));
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\nconsumer-types: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
