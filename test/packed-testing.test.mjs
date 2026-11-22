// The `/testing` subpath as an integrator gets it: this package packed by `pnpm pack` (so `files` and the exports map
// decide what ships), installed into a throwaway project, and imported there by an ES module and by require(). Each
// drives the wallet calls a page makes through WalletConnection from the packed root entry: connect, the address,
// sign-in, a send that returns a txid, a rejection and a locked wallet. Needs a build (`pnpm build`). Offline.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installPackage } from "../scripts/check-consumer-types.mjs";

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

const root = fileURLToPath(new URL("..", import.meta.url));
if (!existsSync(join(root, "dist", "testing.js"))) {
  console.log("  ✗ dist/ is not built: run `pnpm build` first");
  process.exit(1);
}

// One scenario, written once and run as ESM and as CommonJS; it prints one JSON line of what it saw.
const scenario = (load) => `${load}
const addr = "0x" + "ab".repeat(20);
const mock = mockCairnProvider({ address: addr, txid: "0x" + "01".repeat(32) });
const w = new WalletConnection(mock);
const out = { where: whereTesting, whereRoot };
const caught = async (fn) => { try { await fn(); return "returned"; } catch (e) { return e.constructor.name + ":" + e.code; } };
(async () => {
  out.connect = await w.connect();
  out.address = await w.getAddress();
  out.signIn = (await w.signInWithCsd({ domain: "app.example", uri: "https://app.example", nonce: "abcdefgh1234" })).account;
  out.send = (await w.send({ to: addr, amount: 1 })).txid;
  mock.next("send", { kind: "reject", code: "USER_REJECTED" });
  out.rejected = await caught(() => w.send({ to: addr, amount: 1 }));
  mock.next("connect", { kind: "reject", code: "WALLET_LOCKED" });
  out.locked = await caught(() => w.connect());
  out.calls = mock.calls.map((c) => c.method);
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(1); });
`;
const ESM = scenario(`import { mockCairnProvider } from "@inversealtruism/cairn-sdk/testing";
import { WalletConnection } from "@inversealtruism/cairn-sdk";
const whereTesting = import.meta.resolve("@inversealtruism/cairn-sdk/testing");
const whereRoot = import.meta.resolve("@inversealtruism/cairn-sdk");`);
const CJS = scenario(`const { mockCairnProvider } = require("@inversealtruism/cairn-sdk/testing");
const { WalletConnection } = require("@inversealtruism/cairn-sdk");
const whereTesting = require.resolve("@inversealtruism/cairn-sdk/testing");
const whereRoot = require.resolve("@inversealtruism/cairn-sdk");`);

const work = mkdtempSync(join(tmpdir(), "cairn-sdk-packed-testing-"));
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
  const project = join(work, "project");
  mkdirSync(project);
  installPackage(join(x, "package"), project, root);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "integrator", private: true }));
  writeFileSync(join(project, "esm.mjs"), ESM);
  writeFileSync(join(project, "cjs.cjs"), CJS);
  const installed = join(project, "node_modules", "@inversealtruism", "cairn-sdk");

  for (const [label, file, testingFile] of [["ES module", "esm.mjs", "testing.js"], ["require()", "cjs.cjs", "testing.cjs"]]) {
    const r = spawnSync(process.execPath, [file], { cwd: project, encoding: "utf8" });
    let seen = null;
    ok(`${label}: the scenario runs against the packed package`, () => {
      assert.equal(r.status, 0, r.stdout + r.stderr);
      seen = JSON.parse(r.stdout.trim().split("\n").pop());
    });
    if (!seen) continue;
    ok(`${label}: ./testing and the root entry resolve inside the installed package (dist/${testingFile}), not src/`, () => {
      const at = (w) => (w.startsWith("file:") ? fileURLToPath(w) : w);
      assert.equal(at(seen.where), join(installed, "dist", testingFile));
      assert.ok(at(seen.whereRoot).startsWith(join(installed, "dist") + "/"), seen.whereRoot);
      assert.ok(!at(seen.where).startsWith(root), seen.where);
    });
    ok(`${label}: connect, the address, sign-in and a send with its txid; a rejection and a locked wallet as typed errors`, () => {
      const addr = `0x${"ab".repeat(20)}`;
      assert.equal(seen.connect, addr);
      assert.equal(seen.address, addr);
      assert.equal(seen.signIn, addr);
      assert.equal(seen.send, `0x${"01".repeat(32)}`);
      assert.equal(seen.rejected, "UserRejectedError:USER_REJECTED");
      assert.equal(seen.locked, "WalletLockedError:WALLET_LOCKED");
      assert.deepEqual(seen.calls, ["connect", "getAddress", "signInWithCsd", "send", "send", "connect"]);
    });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\npacked-testing: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
