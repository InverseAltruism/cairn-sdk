// Live WALLET CONNECTOR e2e — drives the REAL Cairn Wallet extension in real Chromium
// (under Xvfb) through the cairn-sdk connector, proving the per-origin consent model
// end-to-end in a browser:
//   1. SDK detectProvider() sees window.cairn (broad injection / connect-anywhere)
//   2. first connect() opens the clear-signing approval window → approve → address
//   3. repeat getAddress() is SILENT (no new window) — consented origin
//   4. send() STILL opens the approval window (signing never auto-approves) → reject
//   5. revoke the site in the wallet → connect() prompts again
//
// Requires: a built cairn-wallet/dist + cached chromium + Xvfb. Run via:
//   xvfb-run -a node test/e2e/e2e-wallet-connect.mjs
import { chromium } from "playwright-core";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeHarness } from "./harness.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const EXE = process.env.CHROME || "/home/inverse/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome";
const DIST = "/opt/cairn_substrate/cairn-wallet/dist";
const PW = "correct horse battery staple";
const h = makeHarness("wallet-connect");

if (!existsSync(EXE)) { console.log(`SKIP: no chromium at ${EXE}`); process.exit(0); }
if (!existsSync(join(DIST, "manifest.json"))) { console.log(`SKIP: build cairn-wallet/dist first (node build.mjs)`); process.exit(0); }

// Bundle the SDK connector so the page can call it as window.__sdk.* (real SDK code).
const bundle = await build({
  stdin: {
    contents: `import { detectProvider, WalletConnection, isInstalled, NotInstalledError, UserRejectedError } from ${JSON.stringify(join(__dir, "../../src/index.ts"))};
      window.__sdk = { detectProvider, WalletConnection, isInstalled, NotInstalledError, UserRejectedError };`,
    resolveDir: __dir,
    loader: "ts",
  },
  bundle: true, format: "iife", write: false, target: "es2020",
});
const sdkJs = bundle.outputFiles[0].text;

// Serve our OWN permissive page (no CSP) on 127.0.0.1 — the wallet injects on
// http://127.0.0.1/* at any port. (The cairn board page has script-src 'self', which
// blocks injecting the SDK bundle, so we host a clean page instead.)
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>cairn-sdk e2e</title><body><script>${sdkJs}</script></body>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const ORIGIN_PAGE = `http://127.0.0.1:${PORT}/`;

const udd = mkdtempSync(join(tmpdir(), "cairn-connect-"));
const ctx = await chromium.launchPersistentContext(udd, {
  executablePath: EXE, headless: false,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--no-sandbox", "--no-first-run"],
});

const approveWindows = () => ctx.pages().filter((p) => p.url().includes("approve.html"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForApprove(timeoutMs = 9000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { const w = approveWindows()[0]; if (w) { return w; } await wait(250); }
  return null;
}
// Click a button (Approve/Reject) — the approval window disables both buttons for ~700ms
// (anti-clickjacking), so wait that out and retry until the button is enabled + clicked.
async function clickIn(win, re) {
  for (let i = 0; i < 8; i++) {
    await win.waitForTimeout(300);
    const done = await win.evaluate((reSrc) => {
      const b = [...document.querySelectorAll("button")].find((x) => new RegExp(reSrc, "i").test(x.textContent || ""));
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    }, re.source);
    if (done) return true;
  }
  return false;
}

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];

  h.section("setup: create + unlock a wallet via the extension popup");
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForTimeout(400);
  const call = (m, ...a) => popup.evaluate(({ m, a }) => new Promise((r) => chrome.runtime.sendMessage({ kind: "popup", method: m, args: a }, r)), { m, a });
  const created = await call("create", PW);
  const addr0 = created?.result?.addr;
  h.ok("wallet created + unlocked", created?.ok && /^0x[0-9a-f]{40}$/.test(addr0 || ""), addr0);

  h.section("SDK connector sees the injected provider (connect-anywhere)");
  const page = await ctx.newPage();
  await page.goto(ORIGIN_PAGE, { waitUntil: "domcontentloaded", timeout: 10000 });
  await page.waitForTimeout(500);
  h.ok("window.cairn injected on the page", await page.evaluate(() => !!(window.cairn && window.cairn.isCairn)));
  h.ok("SDK connector bundle loaded on the page", await page.evaluate(() => !!(window.__sdk && window.__sdk.detectProvider)));
  h.ok("SDK isInstalled() true via the real provider", await page.evaluate(() => window.__sdk.isInstalled()));

  h.section("first connect() → approval window → address");
  await page.evaluate(() => {
    window.__r = {};
    (async () => {
      const w = new window.__sdk.WalletConnection(await window.__sdk.detectProvider());
      window.__w = w;
      window.__r.connect = await w.connect().then((a) => ({ ok: true, addr: a })).catch((e) => ({ ok: false, name: e?.name }));
    })();
  });
  const aw1 = await waitForApprove();
  h.ok("first connect opens the clear-signing approval window", !!aw1);
  if (aw1) {
    const body = await aw1.evaluate(() => document.body.innerText);
    h.ok("approval window shows the requesting origin", /127\.0\.0\.1|localhost/.test(body));
    h.ok("approval window shows the connect-consent note", /see your address|disconnect/i.test(body));
    h.ok("clicked Approve", await clickIn(aw1, /approve/));
  }
  let cr = null;
  for (let i = 0; i < 30 && !cr; i++) { cr = await page.evaluate(() => window.__r.connect); if (!cr) await wait(300); }
  h.ok("SDK connect() resolved to the wallet address", cr?.ok === true && cr.addr === addr0, cr?.addr);

  h.section("repeat getAddress() is SILENT for the consented origin");
  const before = approveWindows().length;
  await page.evaluate(() => { window.__r.repeat = null; window.__w.getAddress().then((a) => window.__r.repeat = { ok: true, addr: a }).catch((e) => window.__r.repeat = { ok: false, name: e?.name }); });
  await wait(4000);
  const newWindows = approveWindows().length - before;
  const rr = await page.evaluate(() => window.__r.repeat);
  h.ok("repeat getAddress opened NO new approval window (silent)", newWindows === 0, `new windows: ${newWindows}`);
  h.ok("repeat getAddress resolved immediately to the address", rr?.ok === true && rr.addr === addr0);

  h.section("send() STILL prompts from the consented origin (signing never silent)");
  const beforeSend = approveWindows().length;
  await page.evaluate((to) => { window.__r.send = null; window.__w.send({ to, amount: 1, fee: 1 }).then((v) => window.__r.send = { ok: true, v }).catch((e) => window.__r.send = { ok: false, name: e?.name }); }, addr0);
  const aw2 = await waitForApprove();
  h.ok("send opened a fresh approval window despite being connected", !!aw2 && approveWindows().length > beforeSend);
  if (aw2) { await clickIn(aw2, /reject/); }
  let sr = null;
  for (let i = 0; i < 20 && !sr; i++) { sr = await page.evaluate(() => window.__r.send); if (!sr) await wait(300); }
  h.ok("rejected send surfaces UserRejectedError to the SDK caller", sr?.ok === false && sr.name === "UserRejectedError", sr?.name);

  h.section("connected sites: listed, then revoked → connect prompts again");
  const sites = await call("connectedSites");
  const origin = new URL(ORIGIN_PAGE).origin;
  h.ok("the origin appears under connected sites", Array.isArray(sites?.result) && sites.result.some((s) => s.origin === origin), origin);
  const rev = await call("disconnectSite", origin);
  h.ok("disconnectSite removed it", rev?.result?.removed === true);
  const beforeRe = approveWindows().length;
  await page.evaluate(() => { window.__r.re = null; window.__w.connect().then((a) => window.__r.re = { ok: true, addr: a }).catch((e) => window.__r.re = { ok: false, name: e?.name }); });
  const aw3 = await waitForApprove();
  h.ok("after revoke, connect() prompts again (no longer silent)", !!aw3 && approveWindows().length > beforeRe);
  if (aw3) await clickIn(aw3, /reject/);
} finally {
  await ctx.close();
  server.close();
}

process.exit(h.done() ? 0 : 1);
