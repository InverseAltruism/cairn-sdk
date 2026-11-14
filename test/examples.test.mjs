// The examples run from the installed package: they import it by its published name (resolved here to this repo's
// dist/ through the exports map, so `pnpm build` first), they typecheck, the browser sample bundles, and the sample
// server verifies "Sign in with CSD" correctly (single-use nonce, bound to the browser, replay refused). Offline:
// the server binds 127.0.0.1 on an ephemeral port.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { addrFromPriv } from "@inversealtruism/csd-crypto";
import { CSD_CHAIN_MAINNET, rfc3339, signSiwc, SIWC_VERSION } from "@inversealtruism/csd-siwc";

let pass = 0, fail = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

const root = fileURLToPath(new URL("..", import.meta.url));
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "examples"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);

console.log("examples:");
await ok("no example imports this repo's src/ or dist/ by a relative path", () => {
  const relative = /(?:from\s*|import\s*\(\s*)["'](?:\.\.?\/)+(?:src|dist)\//;
  const offenders = tracked.filter((f) => /\.(?:[cm]?[jt]s|html)$/.test(f) && relative.test(readFileSync(join(root, f), "utf8")));
  assert.deepEqual(offenders, []);
});

await ok("the TypeScript examples and the sample server typecheck against the built package (strict)", () => {
  const r = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "examples", "tsconfig.json"), "--listFiles"], { cwd: root, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const listed = new Set(out.split("\n").map((l) => l.trim()));
  for (const f of tracked.filter((x) => x.endsWith(".ts")).concat("examples/integrate-wallet/server.mjs")) assert.ok(listed.has(join(root, f)), `${f} not compiled`);
  assert.ok(listed.has(join(root, "dist", "index.d.ts")), "the package name did not resolve to dist/index.d.ts");
  assert.equal(r.status, 0, out.split("\n").filter((l) => /error TS/.test(l)).join("\n"));
});

await ok("the browser sample bundles with the package resolved by name", async () => {
  const r = await build({ entryPoints: [join(root, "examples/integrate-wallet/app.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, logLevel: "silent" });
  assert.equal(r.errors.length, 0);
  assert.ok(r.outputFiles[0].text.includes("csd:requestProvider"), "the connector is in the bundle");
});

await ok("the module examples load in Node by the package name", async () => {
  for (const f of ["wallet-connect.mjs", "siwc-login.mjs", "node-signer.mjs"]) {
    const m = await import(pathToFileURL(join(root, "examples", f)).href);
    assert.ok(Object.keys(m).length > 0, f);
  }
});

console.log("sample server, Sign in with CSD:");
const server = spawn(process.execPath, [join(root, "examples/integrate-wallet/server.mjs")], { env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
try {
  const base = await new Promise((resolve, reject) => {
    let seen = "";
    const t = setTimeout(() => reject(new Error(`no listen line: ${seen}`)), 10_000);
    server.stdout.on("data", (b) => {
      seen += b;
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)\/ \(SIWC domain ([^)]+)\)/.exec(seen);
      if (m) { clearTimeout(t); resolve({ url: m[1], domain: m[2] }); }
    });
    server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  const priv = randomBytes(32).toString("hex");
  const account = addrFromPriv(priv);
  const post = (path, body, cookie = "") => fetch(base.url + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body ?? {}) });
  const nonceFor = async (cookie = "") => {
    const r = await post("/auth/siwc/nonce", {}, cookie);
    return { nonce: (await r.json()).nonce, cookie: cookie || String(r.headers.get("set-cookie")).split(";")[0] };
  };
  const sign = (nonce, domain = base.domain) => {
    const now = Date.now();
    const s = signSiwc({ domain, account, uri: `http://${domain}/`, version: SIWC_VERSION, chainId: CSD_CHAIN_MAINNET, nonce, issuedAt: rfc3339(now), expirationTime: rfc3339(now + 600_000) }, priv);
    return { message: s.message, sig64: s.sig64, pub33: s.pub33 };
  };

  const a = await nonceFor();
  const signed = sign(a.nonce);
  const v = await post("/auth/siwc/verify", signed, a.cookie);
  const vBody = await v.json();
  const sid = String(v.headers.get("set-cookie")).split(";")[0];
  await ok("honest: a signed nonce verifies, the account is the signer's, and the session cookie works", async () => {
    assert.equal(v.status, 200);
    assert.deepEqual(vBody, { ok: true, account });
    const me = await fetch(`${base.url}/auth/me`, { headers: { cookie: sid } });
    assert.deepEqual(await me.json(), { ok: true, account });
  });
  await ok("the same signed message again is refused (the nonce is single-use)", async () => {
    const r = await post("/auth/siwc/verify", signed, a.cookie);
    assert.equal(r.status, 401);
    assert.match((await r.json()).error, /unknown or used nonce/);
  });
  await ok("a nonce verified from another browser is refused", async () => {
    const b = await nonceFor();
    const r = await post("/auth/siwc/verify", sign(b.nonce), "pre=someone-else");
    assert.equal(r.status, 401);
    assert.match((await r.json()).error, /another browser/);
  });
  await ok("a message signed for another site is refused (domain-mismatch)", async () => {
    const c = await nonceFor();
    const r = await post("/auth/siwc/verify", sign(c.nonce, "evil.example"), c.cookie);
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, "domain-mismatch");
  });
  await ok("the page is served; files outside the served list are not", async () => {
    assert.match(await (await fetch(`${base.url}/`)).text(), /Integrate the Cairn Wallet/);
    assert.equal((await fetch(`${base.url}/server.mjs`)).status, 404);
  });
} finally {
  server.kill();
}

console.log(`\nexamples: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
