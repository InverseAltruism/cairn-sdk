// 0.7.0 removed the registry API (cairn.registry, the ./registry subpath, the IndexerClient registryPeers,
// registryGateways, identity and reverseIdentity methods, and the csd-registry dependency). This builds the package the way `pnpm build` does, into a scratch directory, and checks
// the shipped surface: no registry name in any entry's runtime or type exports, no registry entry or exports-map
// key, no csd-registry import in the output; and every other name that 0.6.0 exported is still exported.
// Offline. Run: pnpm exec tsx test/no-registry-surface.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const fixture = JSON.parse(readFileSync(join(root, "test/fixtures/public-surface-0.6.0.json"), "utf8"));
const pinned = fixture.entries;
const methods = fixture.indexerClientMethods;

/** Every name the 0.6.0 build exported from the registry entry, plus RegistryClient from the root entry. */
const REMOVED = [
  "RegistryClient", "RegistryClientOptions", "fromRecords", "verifyPeer", "verifyGateway", "verifyIdentitySig", "DOMAINS",
  "buildPeerRecord", "buildGatewayRecord", "buildIdentityCommit", "buildIdentityReveal", "epochOf",
  "RankedPeer", "RankedGateway", "ResolvedIdentity", "ChainRecord", "ResolveOpts", "BuiltRecord",
];

// The build runs inside the repo so the .d.ts files resolve @inversealtruism/* from node_modules.
const out = mkdtempSync(join(root, "node_modules", ".surface-"));
const cleanup = () => rmSync(out, { recursive: true, force: true });

try {
  const buildArgs = pkg.scripts.build.split(/\s+/);
  assert.equal(buildArgs[0], "tsup", "package.json build is a plain tsup command");
  const tsupDir = join(root, "node_modules", "tsup");
  const tsupBin = join(tsupDir, JSON.parse(readFileSync(join(tsupDir, "package.json"), "utf8")).bin.tsup);
  const built = spawnSync(process.execPath, [tsupBin, ...buildArgs.slice(1), "--out-dir", out], { cwd: root, encoding: "utf8" });
  assert.equal(built.status, 0, `tsup failed:\n${built.stdout}\n${built.stderr}`);

  const entries = readdirSync(out).filter((f) => /^[a-z]+\.d\.ts$/.test(f)).map((f) => f.slice(0, -5)).sort();

  console.log("package metadata:");
  ok("package.json has no ./registry export, no registry entry in build and no csd-registry dependency", () => {
    assert.deepEqual(Object.keys(pkg.exports).filter((k) => /registry/i.test(k)), []);
    assert.ok(!/registry/i.test(pkg.scripts.build), pkg.scripts.build);
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      assert.deepEqual(Object.keys(pkg[field] ?? {}).filter((k) => /registry/i.test(k)), []);
    }
  });
  ok("the exports map and the build entries name the same modules", () => {
    const mapped = Object.keys(pkg.exports).map((k) => (k === "." ? "index" : k.slice(2))).sort();
    assert.deepEqual(mapped, entries);
  });
  ok("every exports-map target exists in the build", () => {
    const files = new Set(readdirSync(out));
    for (const target of Object.values(pkg.exports).flatMap((o) => Object.values(o))) {
      assert.ok(files.has(target.replace("./dist/", "")), `${target} is not built`);
    }
  });

  console.log("built output:");
  ok("no registry file and no csd-registry import in the output", () => {
    const files = readdirSync(out);
    assert.deepEqual(files.filter((f) => /registry/i.test(f)), []);
    for (const f of files) assert.ok(!/csd-registry/.test(readFileSync(join(out, f), "utf8")), `${f} mentions csd-registry`);
  });

  const ts = createRequire(join(root, "package.json"))("typescript");
  const program = ts.createProgram(entries.map((e) => join(out, `${e}.d.ts`)), {
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, noEmit: true, types: [],
  });
  const checker = program.getTypeChecker();
  const typeExports = {};
  for (const e of entries) {
    const sf = program.getSourceFile(join(out, `${e}.d.ts`));
    typeExports[e] = checker.getExportsOfModule(checker.getSymbolAtLocation(sf)).map((s) => s.name).sort();
  }
  const runtime = {};
  for (const e of entries) runtime[e] = await import(pathToFileURL(join(out, `${e}.js`)).href);

  ok("no entry exports a registry name, as a value or as a type", () => {
    for (const e of entries) {
      assert.deepEqual(typeExports[e].filter((n) => REMOVED.includes(n)), [], `${e} types`);
      assert.deepEqual(Object.keys(runtime[e]).filter((n) => REMOVED.includes(n)), [], `${e} values`);
    }
  });
  ok("the Cairn facade has no registry member and IndexerClient has none of the registry and identity methods", () => {
    const cairn = new runtime.index.Cairn({ network: "mainnet" });
    for (const m of fixture.removedFacadeMembers) assert.equal(m in cairn, false, m);
    const dts = readFileSync(join(out, "indexer.d.ts"), "utf8");
    for (const m of methods.removed) {
      assert.equal(typeof runtime.indexer.IndexerClient.prototype[m], "undefined", m);
      assert.ok(!new RegExp(`\\b${m}\\b`).test(dts), `${m} in indexer.d.ts`);
    }
  });

  console.log("honest path (the rest of the 0.6.0 surface):");
  ok("every name 0.6.0 exported outside the registry surface is still exported, per entry", () => {
    assert.deepEqual(Object.keys(pinned).sort(), entries);
    for (const e of entries) {
      const have = new Set(typeExports[e]);
      assert.deepEqual(pinned[e].filter((n) => !have.has(n)), [], `${e}: missing`);
    }
  });
  ok("every other IndexerClient method of 0.6.0 is still a method, and nothing was added", () => {
    const have = Object.getOwnPropertyNames(runtime.indexer.IndexerClient.prototype).filter((n) => n !== "constructor").sort();
    assert.deepEqual(have, [...methods.kept].sort());
  });
  ok("the production call shape still works: Cairn builds with chain, index, content and names", () => {
    const cairn = new runtime.index.Cairn({ network: "mainnet" });
    for (const ns of ["chain", "index", "content", "names"]) assert.ok(cairn[ns], ns);
    for (const m of ["tipHeight", "verifyInclusion", "reputation", "address"]) assert.equal(typeof cairn.index[m], "function", m);
  });
} finally {
  cleanup();
}

console.log(`\nno-registry-surface: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
