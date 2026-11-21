// scripts/check-dashes-paths.mjs on a throwaway git sandbox (one file per case) and on this repo.
// Run: pnpm exec tsx test/check-dashes-paths.test.mjs   (offline)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { offences, PATH_EXCEPTIONS } from "../scripts/check-dashes-paths.mjs";

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

const root = fileURLToPath(new URL("..", import.meta.url));
const EM = "\u2014";

console.log("check-dashes-paths:");
ok("this repo is clean", () => assert.deepEqual(offences(root), []));
ok("every exception names its reason", () => {
  for (const [f, r] of Object.entries(PATH_EXCEPTIONS)) assert.ok(typeof r === "string" && r.length > 10, f);
});

const dir = mkdtempSync(join(tmpdir(), "cairnsdk-dashes-"));
try {
  const put = (f, text, track = true) => {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
    if (track) execFileSync("git", ["add", f], { cwd: dir });
  };
  execFileSync("git", ["init", "-q"], { cwd: dir });
  put("README.md", `a ${EM} b\n`);
  put("docs/archive/old.md", `a ${EM} b\n`);
  put("notes.txt", `a ${EM} b\n`);
  put("untracked.md", `a ${EM} b\n`, false);
  put("docs/guide.md", "load ../cairn-wallet/dist and /opt/cairn_substrate/csd-sdk\n");
  put("src/reads-sdk.mjs", 'const d = process.env.X ?? "../csd-sdk/packages";\n');
  put("src/reads-host.ts", 'import x from "/opt/cairn_substrate/cairn/public/a.js";\n');
  put("tools/run.sh", 'cd "${DIR:-../cairnx}"\n');
  put("src/local.ts", 'import { a } from "../cairnx.js";\nimport { b } from "../csd-local.ts";\n');
  put("scripts/ux-live-readonly.mjs", 'const EXT = "/opt/cairn_substrate/cairn-wallet/dist";\n');
  ok("only the tracked offences outside the exceptions are reported", () => {
    assert.deepEqual(offences(dir).map((l) => l.split(":")[0]).sort(), ["README.md", "src/reads-host.ts", "src/reads-sdk.mjs", "tools/run.sh"]);
  });
  ok("an em dash is reported as one", () => assert.ok(offences(dir).includes("README.md: em dash (U+2014)")));
  ok("a sibling read names the path it matched", () => assert.ok(offences(dir).includes("src/reads-sdk.mjs: reads a sibling checkout (../csd-sdk)")));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// Started as a command: by its real path, through a symlink to the file and through a symlink to the checkout. Node
// gives import.meta.url the real path, so a start guard that compares argv[1] unresolved prints nothing and exits 0.
console.log("check-dashes-paths, started as a command:");
const cmd = mkdtempSync(join(tmpdir(), "cairnsdk-dashes-cmd-"));
try {
  const sandbox = (name, text) => {
    const d = join(cmd, name);
    mkdirSync(d);
    execFileSync("git", ["init", "-q"], { cwd: d });
    writeFileSync(join(d, "README.md"), text);
    execFileSync("git", ["add", "README.md"], { cwd: d });
    return d;
  };
  const dirty = sandbox("dirty", `a ${EM} b\n`);
  const clean = sandbox("clean", "a - b\n");
  const script = join(root, "scripts", "check-dashes-paths.mjs");
  symlinkSync(script, join(cmd, "script-link.mjs"));
  symlinkSync(root, join(cmd, "root-link"));
  const starts = { "real path": script, "symlinked file": join(cmd, "script-link.mjs"), "symlinked checkout": join(cmd, "root-link", "scripts", "check-dashes-paths.mjs") };
  const run = (start, target) => spawnSync(process.execPath, [start, target], { cwd: cmd, encoding: "utf8" });
  for (const [how, start] of Object.entries(starts)) {
    ok(`${how}: a tree with an em dash is refused (exit 1, the file named)`, () => {
      const r = run(start, dirty);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /^README\.md: em dash \(U\+2014\)$/m);
      assert.match(r.stdout, /^check-dashes-paths: 1 offence\(s\)$/m);
    });
    ok(`${how}: a clean tree passes (exit 0, "clean")`, () => {
      const r = run(start, clean);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /^check-dashes-paths: clean$/m);
    });
  }
} finally {
  rmSync(cmd, { recursive: true, force: true });
}

console.log(`\ncheck-dashes-paths: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
