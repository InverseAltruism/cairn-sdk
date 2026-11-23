// scripts/check-consumer-types.mjs over this package as it would be packed (package.json and the built dist/),
// and over the same package with the exports map of 0.8.2, which gave `require` the ESM .d.ts files: a CommonJS
// consumer under node16 resolution then fails with TS1479. Needs a build (`pnpm build`). Offline.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  ok("this package: every mapped file exists and all four consumers typecheck", () => {
    for (const c of Object.values(now)) assert.ok(c.ok, show(c));
    assert.equal(Object.keys(now).length, 5);
  });
  ok("node16-cjs leaves out ./replica alone; node20-cjs imports every subpath", () => {
    assert.match(now["node16-cjs"].name, / every subpath but \.\/replica$/);
    assert.match(now["node20-cjs"].name, / every subpath$/);
  });

  // The 0.8.2 map: one `types` per entry, shared by `import` and `require`.
  const flat = Object.fromEntries(Object.entries(pkg.exports).map(([k, v]) => [k, { types: v.import.types, import: v.import.default, require: v.require.default }]));
  const old = verdicts({ ...pkg, exports: flat });
  ok("the 0.8.2 map: the node16 CommonJS consumer fails with TS1479 on every subpath it imports", () => {
    const cjs = old["node16-cjs"];
    assert.equal(cjs.ok, false);
    assert.equal(cjs.detail.filter((l) => /error TS1479/.test(l)).length, Object.keys(pkg.exports).length - 1, show(cjs));
  });
  ok("the 0.8.2 map: the ESM and bundler consumers still pass (the check is not failing on everything)", () => {
    assert.ok(old["node16-esm"].ok, show(old["node16-esm"]));
    assert.ok(old.bundler.ok, show(old.bundler));
  });

  // Started as a command through a symlink to the checkout: Node gives import.meta.url the real path, so a start guard
  // that compares argv[1] unresolved prints nothing and exits 0, a green for a tarball nothing checked.
  console.log("check-consumer-types, started as a command:");
  const pack = (pkgJson) => {
    const stage = join(work, `stage-${n++}`);
    cpSync(join(root, "dist"), join(stage, "package", "dist"), { recursive: true });
    writeFileSync(join(stage, "package", "package.json"), JSON.stringify(pkgJson, null, 2));
    const tgz = join(work, `pkg-${n}.tgz`);
    execFileSync("tar", ["czf", tgz, "-C", stage, "package"]);
    return tgz;
  };
  symlinkSync(root, join(work, "root-link"));
  const start = join(work, "root-link", "scripts", "check-consumer-types.mjs");
  const run = (tgz) => spawnSync(process.execPath, [start, tgz], { cwd: work, encoding: "utf8" });
  ok("symlinked checkout: this package's tarball passes (exit 0, 5 passed, 0 failed)", () => {
    const r = run(pack(pkg));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^check-consumer-types: 5 passed, 0 failed$/m);
  });
  ok("symlinked checkout: the 0.8.2 map is refused (exit 1, the node16 CommonJS consumer fails with TS1479)", () => {
    const r = run(pack({ ...pkg, exports: flat }));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^ {2}FAIL a node16-cjs consumer typechecks against every subpath but \.\/replica$/m);
    assert.match(r.stdout, /error TS1479/);
    assert.match(r.stdout, /^check-consumer-types: 4 passed, 1 failed$/m);
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\nconsumer-types: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
