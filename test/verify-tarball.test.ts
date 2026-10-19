// Runs scripts/verify-tarball.mjs the way a release does (`pnpm pack`, then the script on the tarball) and against
// tarballs it must reject. Everything runs in a disposable copy of the package (node_modules symlinked), so no case
// can leave this repo's dist/ changed. Offline; each script run rebuilds and repacks the copy once.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

const repo = fileURLToPath(new URL("..", import.meta.url));
const distHash = (dir: string): string => {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else h.update(relative(dir, p)).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
};
const repoDistBefore = distHash(join(repo, "dist"));

const work = mkdtempSync(join(tmpdir(), "verify-tarball-test-"));
try {
  const pkg = join(work, "pkg");
  cpSync(repo, pkg, { recursive: true, filter: (src) => { const r = relative(repo, src); return r !== "node_modules" && r !== ".git"; } });
  symlinkSync(join(repo, "node_modules"), join(pkg, "node_modules"));
  let n = 0;
  const packIn = (env: NodeJS.ProcessEnv = process.env): string => {
    const dir = join(work, `pack-${n++}`);
    execFileSync("pnpm", ["pack", "--pack-destination", dir], { cwd: pkg, stdio: "ignore", env });
    return join(dir, readdirSync(dir).find((f) => f.endsWith(".tgz"))!);
  };
  const verify = (tgz: string, env: NodeJS.ProcessEnv = process.env) => {
    const r = spawnSync(process.execPath, [join(pkg, "scripts/verify-tarball.mjs"), tgz], { encoding: "utf8", env });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const distJs = join(pkg, "dist/index.js");

  const packed = packIn();
  let r = verify(packed);
  ok("honest: a fresh `pnpm pack` passes", r.code === 0 && /PASS tarball sha256 equals a fresh build and pack/.test(r.out) && /PASS the fresh pack's dist\/ equals the files just built/.test(r.out));

  // Edited after packing; the literals the entry checks look for are all still present.
  const x = join(work, "x");
  mkdirSync(x);
  execFileSync("tar", ["xzf", packed, "-C", x]);
  appendFileSync(join(x, "package/dist/index.js"), "\n// edited after pack\n");
  const edited = join(work, "edited.tgz");
  execFileSync("tar", ["czf", edited, "-C", x, "package"]);
  r = verify(edited);
  ok("an edited tarball fails on the sha256 comparison", r.code === 1 && /FAIL tarball sha256 equals/.test(r.out));
  ok("the edited path is named", /differs: package\/dist\/index\.js/.test(r.out));
  ok("the entry literal checks alone would have passed it", /PASS packed dist\/index\.js carries the ASDK-1/.test(r.out));

  // A stale dist/ on disk, packed and verified under config that skips or fakes package scripts.
  for (const [label, extra] of [
    ["ignore-scripts", { npm_config_ignore_scripts: "true" }],
    ["ignore-scripts + script-shell=/bin/true", { npm_config_ignore_scripts: "true", npm_config_script_shell: "/bin/true" }],
    ["ignore-scripts + bail=false", { npm_config_ignore_scripts: "true", npm_config_bail: "false" }],
  ] as const) {
    const env = { ...process.env, ...extra };
    appendFileSync(distJs, "\n// stale dist\n");
    r = verify(packIn(env), env);
    ok(`${label}: a tarball packed from a stale dist/ is rejected`, r.code === 1 && /differs: package\/dist\/index\.js/.test(r.out));
    ok(`${label}: the verifier rebuilt dist/`, !readFileSync(distJs, "utf8").includes("// stale dist"));
  }

  // A build that fails stops the verifier.
  writeFileSync(join(pkg, "src/index.ts"), readFileSync(join(pkg, "src/index.ts"), "utf8") + "\nexport const broken: number = ;\n");
  r = verify(packed);
  ok("a failing build stops the verifier", r.code === 1 && /the build \(tsup .*\) exited/.test(r.out));
} finally {
  rmSync(work, { recursive: true, force: true });
}
ok("this repo's dist/ is unchanged", distHash(join(repo, "dist")) === repoDistBefore);

console.log(`verify-tarball: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
