#!/usr/bin/env node
// Typechecks a consumer of the packed package, so the published `exports` map is checked for types and not only
// for bytes. The package is unpacked into a throwaway project's node_modules; its dependencies are linked from
// this repo's node_modules (the versions the lockfile pins), so nothing is downloaded. One consumer file imports
// every subpath the `exports` map names and is compiled with this repo's tsc under three settings:
//   node16-cjs   a .cts file, module/moduleResolution node16: needs each entry's `require` condition to give
//                CommonJS types (.d.cts); ESM types there are TS1479.
//   node16-esm   a .mts file, module/moduleResolution node16.
//   bundler      a .ts file, module esnext, moduleResolution bundler.
// Before compiling, every file the map names must exist in the package (the build emits what the map promises).
//
// Usage: node scripts/check-consumer-types.mjs [path/to/pkg.tgz]   (default: ./inversealtruism-cairn-sdk-<version>.tgz)
// scripts/verify-tarball.mjs runs the same checks on the tarball it verifies.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));

/** Every relative file path an `exports` value names, as `[condition path, file]` pairs. */
export function exportTargets(value, at, out = []) {
  if (typeof value === "string") out.push([at, value]);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) exportTargets(v, `${at}.${k}`, out);
  return out;
}

const MODES = [
  { name: "node16-cjs", file: "consumer.cts", module: "node16", moduleResolution: "node16" },
  { name: "node16-esm", file: "consumer.mts", module: "node16", moduleResolution: "node16" },
  { name: "bundler", file: "consumer.ts", module: "esnext", moduleResolution: "bundler" },
];

/**
 * Run the consumer checks against an unpacked package directory (the tarball's `package/`).
 * Returns one `{ name, ok, detail }` per check; `repo` supplies typescript and the dependencies.
 */
export function consumerTypeChecks(packageDir, repo = here) {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const results = [];
  const subpaths = Object.keys(pkg.exports ?? {});
  const missing = exportTargets(pkg.exports, "exports").filter(([, p]) => !existsSync(join(packageDir, p)));
  results.push({
    name: `every file the exports map names is in the package (${subpaths.length} subpaths)`,
    ok: subpaths.length > 0 && missing.length === 0,
    detail: missing.map(([at, p]) => `${at} -> ${p} is missing`),
  });

  const work = mkdtempSync(join(tmpdir(), "cairn-sdk-consumer-"));
  try {
    const scope = join(work, "node_modules", ...pkg.name.split("/").slice(0, -1));
    mkdirSync(scope, { recursive: true });
    execFileSync("cp", ["-R", packageDir, join(work, "node_modules", pkg.name)]);
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const link = join(work, "node_modules", dep);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(realpathSync(join(repo, "node_modules", dep)), link);
    }
    const specs = subpaths.map((s) => (s === "." ? pkg.name : `${pkg.name}/${s.slice(2)}`));
    const source = [
      ...specs.map((s, i) => `import * as m${i} from ${JSON.stringify(s)};`),
      `export const entries: number[] = [${specs.map((_, i) => `Object.keys(m${i}).length`).join(", ")}];`,
      "",
    ].join("\n");
    const tsc = join(repo, "node_modules", "typescript", "bin", "tsc");
    for (const mode of MODES) {
      const dir = join(work, mode.name);
      mkdirSync(dir);
      writeFileSync(join(dir, mode.file), source);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `consumer-${mode.name}`, private: true }));
      writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
          target: "ES2022", lib: ["ES2022", "DOM"], module: mode.module, moduleResolution: mode.moduleResolution,
          strict: true, noEmit: true, skipLibCheck: false, types: [],
        },
        files: [mode.file],
      }));
      const r = spawnSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { cwd: dir, encoding: "utf8" });
      const errors = `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").filter((l) => /error TS\d+/.test(l));
      results.push({
        name: `a ${mode.name} consumer typechecks against every subpath`,
        ok: r.status === 0 && errors.length === 0,
        detail: errors.length ? errors : r.status === 0 ? [] : [`tsc exited ${r.status ?? r.signal}`],
      });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
  const tgz = resolve(process.argv[2] ?? join(here, `inversealtruism-cairn-sdk-${pkg.version}.tgz`));
  if (!existsSync(tgz)) {
    console.error(`check-consumer-types: tarball not found: ${tgz} (run \`pnpm pack\` first)`);
    process.exit(1);
  }
  const x = mkdtempSync(join(tmpdir(), "cairn-sdk-consumer-tgz-"));
  let fail = 0;
  try {
    execFileSync("tar", ["xf", tgz, "-C", x]);
    const results = consumerTypeChecks(join(x, "package"));
    for (const c of results) {
      console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.name}`);
      for (const l of c.detail) console.log(`      ${l}`);
      if (!c.ok) fail++;
    }
    console.log(`\ncheck-consumer-types: ${results.length - fail} passed, ${fail} failed`);
  } finally {
    rmSync(x, { recursive: true, force: true });
  }
  process.exit(fail ? 1 : 0);
}
