// Full SIWC end-to-end (doc 28 Phase 4) — the REAL Cairn Wallet extension in real Chromium signs an
// audience-bound "Sign in with CSD" message, driven by the REAL first-party console code
// (cairn/public/console-write.js performSignIn), verified by the canonical @inversealtruism/csd-siwc
// verifier behind a real /auth/v2, with the approval popup auto-approved. Asserts: the wallet binds the
// page's origin, a session is issued to the wallet's address, the nonce is single-use, and a
// cross-domain replay of the same signature is rejected.
//   Run: xvfb-run -a node test/e2e/e2e-siwc.mjs   (needs a built cairn-wallet/dist + cached chromium)
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness, sleep } from "./harness.mjs";
import { verifySiwc, generateNonce, parseSiwcMessage, CSD_CHAIN_MAINNET } from "/opt/cairn_substrate/csd-sdk/packages/siwc/dist/index.js";

const EXE = process.env.CHROME || "/home/inverse/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome";
const DIST = "/opt/cairn_substrate/cairn-wallet/dist";
const CONSOLE_WRITE = "/opt/cairn_substrate/cairn/public/console-write.js";
const PW = "correct horse battery staple";
const h = makeHarness("siwc-e2e");

if (!existsSync(EXE)) { console.log(`SKIP: no chromium at ${EXE}`); process.exit(0); }
if (!existsSync(join(DIST, "manifest.json"))) { console.log("SKIP: build cairn-wallet/dist first (node build.mjs)"); process.exit(0); }

const consoleWriteSrc = readFileSync(CONSOLE_WRITE, "utf8");

// ── a real relying-party /auth/v2 server (single-use nonce + canonical verifySiwc + own session) ──
const nonces = new Map();          // nonce -> exp
const sessions = new Map();        // session -> addr
let lastSigned = null;             // capture the signed artifact for the replay check
let EXPECTED_DOMAIN = "";

const server = createServer((req, res) => {
  const json = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.method === "POST" && req.url === "/auth/v2/nonce") {
    const nonce = generateNonce(); nonces.set(nonce, Date.now() + 5 * 60_000); return json({ ok: true, nonce });
  }
  if (req.method === "POST" && req.url === "/auth/v2/verify") {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      let p; try { p = JSON.parse(body); } catch { return json({ ok: false, error: "bad json" }, 400); }
      lastSigned = p;
      const parsed = parseSiwcMessage(String(p.message || ""));
      if (!parsed) return json({ ok: false, error: "malformed" }, 400);
      const exp = nonces.get(parsed.nonce);
      if (!exp) return json({ ok: false, error: "unknown nonce" }, 401);
      if (exp < Date.now()) { nonces.delete(parsed.nonce); return json({ ok: false, error: "nonce expired" }, 401); }
      const v = verifySiwc({ message: p.message, sig64: p.sig64, pub33: p.pub33 }, { domain: EXPECTED_DOMAIN, nonce: parsed.nonce, chainId: CSD_CHAIN_MAINNET });
      if (!v.ok) return json({ ok: false, error: v.reason }, 401);
      nonces.delete(parsed.nonce); // single-use
      const session = generateNonce(); sessions.set(session, v.account);
      return json({ ok: true, addr: v.account, session });
    });
    return;
  }
  // the first-party console page: real console-write.js + a minimal __cairnConsole, exercised via performSignIn
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>cairn console (siwc e2e)</title><body>
<div id="g-out"></div><div id="g-st"></div>
<script>window.__cairnConsole={rpc:{},api:"",log(){},logOk(){},logErr(){},makeCard(){},esc:(s)=>s,short:(s,n)=>String(s).slice(0,n||10),fmtCSD:(s)=>s,COIN:1e8,WALLET:{}};</script>
<script>${consoleWriteSrc}</script>
<script>window.__run=async()=>{try{window.__r=await window.__performSignIn();}catch(e){window.__r={error:String(e&&e.message||e)};}};</script>
</body>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;
EXPECTED_DOMAIN = `127.0.0.1:${PORT}`;

const udd = mkdtempSync(join(tmpdir(), "cairn-siwc-"));
console.log("launching chromium + wallet extension…");
const ctx = await chromium.launchPersistentContext(udd, {
  executablePath: EXE, headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--no-sandbox", "--no-first-run", "--disable-gpu"],
});
console.log("launched.");
const approveWindows = () => ctx.pages().filter((p) => p.url().includes("approve.html"));
const waitForApprove = async (ms = 9000) => { const t = Date.now(); while (Date.now() - t < ms) { const w = approveWindows()[0]; if (w) return w; await sleep(250); } return null; };
const clickIn = async (win, re) => { for (let i = 0; i < 10; i++) { await win.waitForTimeout(300); const done = await win.evaluate((s) => { const b = [...document.querySelectorAll("button")].find((x) => new RegExp(s, "i").test(x.textContent || "")); if (b && !b.disabled) { b.click(); return true; } return false; }, re.source); if (done) return true; } return false; };

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = sw.url().split("/")[2];

  h.section("setup: create + unlock the wallet via the popup");
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForTimeout(400);
  const call = (m, ...a) => popup.evaluate(({ m, a }) => new Promise((r) => chrome.runtime.sendMessage({ kind: "popup", method: m, args: a }, r)), { m, a });
  const created = await call("create", PW);
  const addr0 = created?.result?.addr;
  h.ok("wallet created + unlocked", created?.ok && /^0x[0-9a-f]{40}$/.test(addr0 || ""), addr0);

  h.section("load the first-party console page (real console-write.js)");
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/", { waitUntil: "domcontentloaded", timeout: 10000 });
  await page.waitForTimeout(500);
  h.ok("window.cairn injected on the page", await page.evaluate(() => !!(window.cairn && window.cairn.isCairn)));
  h.ok("the wallet exposes signInWithCsd (SIWC-capable)", await page.evaluate(() => typeof window.cairn.signInWithCsd === "function"));
  h.ok("real console performSignIn() is present", await page.evaluate(() => typeof window.__performSignIn === "function"));

  h.section("Sign in with CSD: real performSignIn → wallet signs → /auth/v2 verify");
  await page.evaluate(() => { window.__run(); }); // fire-and-forget — do NOT await (it blocks until we approve below)
  // Approve via the wallet's OWN privileged popup channel (resolvePending) — the exact path the wallet
  // UI's "Review → Approve" uses. The approval-WINDOW clear-sign DOM (audience shown / "no funds move")
  // is covered by the wallet unit tests (cairn-wallet/test/siwc.ts); here we prove the full live flow.
  let pend = null;
  for (let i = 0; i < 40 && !pend; i++) {
    const pl = await call("pending");
    pend = (pl?.result || []).find((p) => p.method === "signinWithCsd");
    if (!pend) await sleep(300);
  }
  h.ok("signInWithCsd reached the wallet as a pending approval", !!pend, pend && pend.method);
  h.ok("the pending request is bound to the page origin (audience)", !!pend && pend.origin === ORIGIN, pend?.origin);
  if (pend) { const ap = await call("resolve", pend.id, true); h.ok("approved via the wallet popup channel", ap?.result?.done === true); }
  let r = null;
  for (let i = 0; i < 40 && !r; i++) { r = await page.evaluate(() => window.__r); if (!r) await sleep(300); }
  h.ok("performSignIn took the SIWC path", r?.mode === "siwc", JSON.stringify(r).slice(0, 120));
  h.ok("a session was issued to the wallet's address", r?.session && r?.addr === addr0, r?.addr);

  h.section("server-side security checks");
  h.ok("the signed message is bound to THIS origin (audience)", !!lastSigned && new RegExp("^" + EXPECTED_DOMAIN.replace(/\./g, "\\.") + " wants you to sign in").test(parseSiwcMessage(lastSigned.message) ? lastSigned.message : ""));
  // cross-domain replay: the SAME signature verified for a DIFFERENT relying party is rejected
  const replay = verifySiwc({ message: lastSigned.message, sig64: lastSigned.sig64, pub33: lastSigned.pub33 }, { domain: "evil.example", nonce: parseSiwcMessage(lastSigned.message).nonce, chainId: CSD_CHAIN_MAINNET });
  h.ok("cross-domain replay of the signature is REJECTED (domain-mismatch)", replay.ok === false && replay.reason === "domain-mismatch", replay.reason);
  // single-use: the nonce was consumed on success
  h.ok("the sign-in nonce was consumed (single-use)", !nonces.has(parseSiwcMessage(lastSigned.message).nonce));
} finally {
  await ctx.close();
  server.close();
}

process.exit(h.done() ? 0 : 1);
