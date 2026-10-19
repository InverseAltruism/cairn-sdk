// Every dependency and devDependency in package.json is an exact version, and pnpm-lock.yaml records that
// same string as the specifier and resolves it to that version. A range lets a lockfile refresh move a
// toolchain package (the tsup that builds the published dist, the test loader) without a package.json diff.
// The ci.yml dep-pin step stays: it also asserts a single csd-codec and csd-crypto copy in the resolved tree.
// Run: pnpm exec tsx test/dep-pins.test.mjs   (offline)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

const EXACT = /^\d+\.\d+\.\d+$/;

/** The root importer of a pnpm v9 lockfile: { dependencies: { name: { specifier, version } }, devDependencies: ... }. */
export function rootImporter(lockText) {
  const out = {};
  const lines = lockText.split("\n");
  const start = lines.indexOf("  .:");
  assert.ok(start >= 0, "pnpm-lock.yaml has a root importer");
  let field = null, name = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("    ") && line.trim() !== "") break;
    let m;
    if ((m = /^    (\w+):$/.exec(line))) { field = out[m[1]] = {}; continue; }
    if ((m = /^      '?([^':]+)'?:$/.exec(line)) && field) { name = field[m[1]] = {}; continue; }
    if ((m = /^        (specifier|version): (.+)$/.exec(line)) && name) name[m[1]] = m[2].replace(/\(.*$/, "");
  }
  return out;
}

/** One line per offence: a range, a lockfile specifier that differs, or a resolved version that differs. */
export function pinOffences(pkg, importer) {
  const out = [];
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      const locked = importer[field]?.[name];
      if (!EXACT.test(spec)) out.push(`${field}.${name}: "${spec}" is not an exact version`);
      if (locked?.specifier !== spec) out.push(`${field}.${name}: the lockfile specifier is "${locked?.specifier}"`);
      if (locked?.version !== spec) out.push(`${field}.${name}: the lockfile resolves ${locked?.version}`);
    }
  }
  return out;
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lockText = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const importer = rootImporter(lockText);

console.log("dependency pins:");
ok("package.json pins every dependency to the version pnpm-lock.yaml resolves", () => {
  assert.deepEqual(pinOffences(pkg, importer), []);
});
ok("the parser read every package.json dependency from the lockfile, peer suffixes stripped", () => {
  const names = (o) => Object.keys(o ?? {}).sort();
  assert.deepEqual(names(importer.dependencies), names(pkg.dependencies));
  assert.deepEqual(names(importer.devDependencies), names(pkg.devDependencies));
  assert.equal(importer.devDependencies.tsup.version, pkg.devDependencies.tsup);
});
ok("a caret range on a dev dependency is an offence", () => {
  const caret = { ...pkg, devDependencies: { ...pkg.devDependencies, tsx: "^" + pkg.devDependencies.tsx } };
  assert.ok(pinOffences(caret, importer).some((l) => l.startsWith("devDependencies.tsx:") && l.includes("not an exact version")));
});
ok("a lockfile still carrying the old range as its specifier is an offence", () => {
  const stale = structuredClone(importer);
  stale.devDependencies.typescript.specifier = "^5.6.0";
  assert.ok(pinOffences(pkg, stale).includes('devDependencies.typescript: the lockfile specifier is "^5.6.0"'));
});
ok("a lockfile that resolves another version is an offence", () => {
  const drift = structuredClone(importer);
  drift.dependencies["@inversealtruism/csd-tx"].version = "0.0.1";
  assert.ok(pinOffences(pkg, drift).includes("dependencies.@inversealtruism/csd-tx: the lockfile resolves 0.0.1"));
});

console.log(`\ndep-pins: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
