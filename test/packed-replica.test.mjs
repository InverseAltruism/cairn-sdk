// The `/replica` subpath as an integrator gets it: this package packed by `pnpm pack`, installed into two throwaway
// projects, one without the optional peer @inversealtruism/cairnx-replica and one with it. Without it the root entry
// loads by import and by require() and no other entry names the replica; `/replica` alone fails, naming the missing
// package. With it `/replica` gives the replica's browser entry itself: every export, the same objects. Needs a build
// (`pnpm build`). Offline.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installPackage } from "../scripts/check-consumer-types.mjs";

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

const root = fileURLToPath(new URL("..", import.meta.url));
if (!existsSync(join(root, "dist", "replica.js"))) {
  console.log("  ✗ dist/ is not built: run `pnpm build` first");
  process.exit(1);
}
const PEER = "@inversealtruism/cairnx-replica";
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

console.log("the replica is an optional peer:");
ok("package.json names it only as an optional peer and a dev dependency, at one exact version", () => {
  assert.equal(pkg.dependencies[PEER], undefined);
  assert.equal(pkg.optionalDependencies?.[PEER], undefined);
  assert.match(pkg.peerDependencies[PEER], /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.peerDependenciesMeta[PEER].optional, true);
  assert.equal(pkg.devDependencies[PEER], pkg.peerDependencies[PEER]);
});

const run = (cwd, file, src) => {
  writeFileSync(join(cwd, file), src);
  const r = spawnSync(process.execPath, [file], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim().split("\n").pop() ?? "", err: r.stderr };
};

const work = mkdtempSync(join(tmpdir(), "cairn-sdk-packed-replica-"));
try {
  const packDir = join(work, "pack");
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: root, env: { ...process.env, npm_config_ignore_scripts: "true" }, stdio: ["ignore", "ignore", "inherit"],
  });
  const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  assert.ok(tgz, "pnpm pack produced no tarball");
  const x = join(work, "x");
  mkdirSync(x);
  execFileSync("tar", ["xf", join(packDir, tgz), "-C", x]);
  const project = (name, peers) => {
    const dir = join(work, name);
    mkdirSync(dir);
    installPackage(join(x, "package"), dir, root, { peers });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true }));
    return dir;
  };

  console.log("without the peer:");
  const bare = project("bare", false);
  ok("the replica is not installed", () => assert.equal(existsSync(join(bare, "node_modules", PEER)), false));
  ok("no packed file outside dist/replica.* names the replica", () => {
    const dist = join(x, "package", "dist");
    const naming = readdirSync(dist).filter((f) => readFileSync(join(dist, f), "utf8").includes(PEER));
    assert.deepEqual(naming.sort(), ["replica.cjs", "replica.d.cts", "replica.d.ts", "replica.js"]);
  });
  ok("the root entry loads by import and by require()", () => {
    const a = run(bare, "root.mjs", `import { Cairn, SDK_VERSION } from "@inversealtruism/cairn-sdk"; console.log(typeof Cairn, SDK_VERSION);`);
    const b = run(bare, "root.cjs", `const { Cairn, SDK_VERSION } = require("@inversealtruism/cairn-sdk"); console.log(typeof Cairn, SDK_VERSION);`);
    assert.equal(a.status, 0, a.err);
    assert.equal(b.status, 0, b.err);
    assert.equal(a.out, `function ${pkg.version}`);
    assert.equal(b.out, a.out);
  });
  ok("/replica fails, naming the missing package", () => {
    const r = run(bare, "replica.mjs", `import("@inversealtruism/cairn-sdk/replica").then(() => console.log("loaded"), (e) => console.log(e.code, e.message.includes("${PEER}")));`);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, "ERR_MODULE_NOT_FOUND true");
  });

  console.log("with the peer:");
  const full = project("full", true);
  const same = `
const names = Object.keys(own).sort();
const out = {
  names: names.length,
  equal: JSON.stringify(Object.keys(sdk).sort()) === JSON.stringify(names) && names.every((k) => sdk[k] === own[k]),
  codes: Array.isArray(sdk.NOT_VERIFIED_CODES) && sdk.NOT_VERIFIED_CODES.includes("LEVEL_FEED") && Array.isArray(sdk.NOTE_CODES),
  fns: [sdk.open, sdk.levelOf, sdk.proofOf, sdk.hostedBlocks, sdk.idbStore].every((f) => typeof f === "function"),
};
console.log(JSON.stringify(out));`;
  for (const [label, file, load] of [
    ["ES module", "same.mjs", `import * as sdk from "@inversealtruism/cairn-sdk/replica";\nimport * as own from "${PEER}/browser";`],
    ["require()", "same.cjs", `const sdk = require("@inversealtruism/cairn-sdk/replica");\nconst own = require("${PEER}/browser");`],
  ]) {
    ok(`${label}: /replica is the replica's browser entry, every export the same object`, () => {
      const r = run(full, file, load + same);
      assert.equal(r.status, 0, r.err);
      const seen = JSON.parse(r.out);
      assert.ok(seen.names > 20, `${seen.names} exports`);
      assert.deepEqual({ equal: seen.equal, codes: seen.codes, fns: seen.fns }, { equal: true, codes: true, fns: true });
    });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\npacked-replica: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
