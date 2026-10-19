// Runs scripts/verify-tarball.mjs the way a release does (`pnpm pack`, then the script on the tarball) and on a
// tarball edited after packing. Offline; each script run rebuilds and repacks this tree once.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

const repo = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "verify-tarball-test-"));
const verify = (tgz: string, env: NodeJS.ProcessEnv = process.env) => {
  const r = spawnSync(process.execPath, [join(repo, "scripts/verify-tarball.mjs"), tgz], { encoding: "utf8", env });
  return { code: r.status, out: r.stdout + r.stderr };
};

try {
  execFileSync("pnpm", ["pack", "--pack-destination", work], { cwd: repo, stdio: "ignore" });
  const packed = join(work, readdirSync(work).find((f) => f.endsWith(".tgz"))!);
  let r = verify(packed);
  ok("honest: a fresh `pnpm pack` passes", r.code === 0 && /PASS tarball sha256 equals a fresh build and pack/.test(r.out));

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

  // A stale dist/ on disk, packed and verified with ignore-scripts set: `pnpm pack` then skips prepack, so a
  // check that only repacks would compare the stale tarball with the same stale bytes.
  const ignore = { ...process.env, npm_config_ignore_scripts: "true" };
  const distJs = join(repo, "dist/index.js");
  appendFileSync(distJs, "\n// stale dist\n");
  const staleDir = join(work, "stale");
  execFileSync("pnpm", ["pack", "--pack-destination", staleDir], { cwd: repo, stdio: "ignore", env: ignore });
  const stale = join(staleDir, readdirSync(staleDir).find((f) => f.endsWith(".tgz"))!);
  r = verify(stale, ignore);
  ok("ignore-scripts: a tarball packed from a stale dist/ is rejected", r.code === 1 && /differs: package\/dist\/index\.js/.test(r.out));
  ok("ignore-scripts: verify-tarball rebuilt dist/ before packing", !readFileSync(distJs, "utf8").includes("// stale dist"));
} finally {
  execFileSync("pnpm", ["run", "build"], { cwd: repo, stdio: "ignore" });
  rmSync(work, { recursive: true, force: true });
}

console.log(`verify-tarball: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
