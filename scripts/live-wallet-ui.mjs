// LIVE wallet-UI walkthrough: headed Chrome + the real MV3 extension + the production site.
// Onboards from a key, reads the account, connects to the site, and CAPTURES clear-sign summaries.
// SAFETY: approves ONLY the non-spend Connect; every fund/fee-bearing popup is READ then REJECTED.
//
//   Needs a display. On a headless box: xvfb-run -a node scripts/live-wallet-ui.mjs
//   Env: WALLET_EXT (default ../cairn-wallet/dist), SITE (default https://cairn-substrate.com),
//        KEY (default ~/.config/cairn/cairnx-treasury.json), GATE_PW (alpha gate; supply if gated),
//        CHROME_BIN (optional explicit chromium), WALLET_PW (throwaway vault password).
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const EXT = process.env.WALLET_EXT || "/opt/cairn_substrate/cairn-wallet/dist";
const SITE = process.env.SITE || "https://cairn-substrate.com";
const GATE_PW = process.env.GATE_PW || ""; // supply the alpha-gate passphrase via env; never hardcoded here
const WALLET_PW = process.env.WALLET_PW || "e2e-throwaway-pw";
const KEY = process.env.KEY || `${homedir()}/.config/cairn/cairnx-treasury.json`;
const tk = JSON.parse(readFileSync(KEY, "utf8"));
const PRIV = tk.privkey.startsWith("0x") ? tk.privkey : "0x" + tk.privkey;
const ADDR = String(tk.addr || tk.addr20).toLowerCase();
const SHOT = process.env.SHOT || "/tmp/cairn-walletui"; mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let n = 0; const shot = async (pg, t) => { try { await pg.screenshot({ path: `${SHOT}/${String(++n).padStart(2, "0")}-${t}.png` }); log("shot", t); } catch {} };
const clearsigns = []; let approvals = 0, rejects = 0;

const ctx = await chromium.launchPersistentContext(`/tmp/cairn-walletui-${process.pid}`, {
  headless: false, executablePath: process.env.CHROME_BIN,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run"],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 20000 }).catch(() => null);
const extId = sw ? new URL(sw.url()).host : null;
log("wallet ext id:", extId); if (!extId) { await ctx.close(); process.exit(1); }

// auto-handler: read the clear-sign; APPROVE only Connect; READ+REJECT any spend
ctx.on("page", (p) => { if (p.url().includes("approve.html")) handleApprove(p); });
async function handleApprove(page) {
  try {
    for (let i = 0; i < 25 && !page.url().includes("approve.html"); i++) await sleep(120);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    for (let i = 0; i < 20; i++) { if (!(await page.locator("#view-locked").isVisible().catch(() => false))) break; await page.fill("#unlock-pw", WALLET_PW).catch(() => {}); await page.click("#btn-unlock").catch(() => {}); await sleep(400); }
    await page.locator("#btn-approve").waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
    let req = ""; try { req = (await page.locator("#req").innerText({ timeout: 3000 })).replace(/\s+/g, " ").trim(); } catch {}
    const isConnect = /connect|grant this site|permission to see|sign in/i.test(req);
    clearsigns.push({ kind: isConnect ? "connect" : "spend", req });
    await shot(page, (isConnect ? "connect" : "spend") + "-clearsign");
    if (isConnect) { await page.locator("#btn-approve").click({ timeout: 5000 }).catch(() => {}); approvals++; log(`[APPROVE connect] "${req.slice(0, 120)}"`); }
    else { await page.locator("#btn-reject, #btn-cancel").click({ timeout: 3000 }).catch(() => {}); rejects++; log(`[READ+REJECT spend] "${req.slice(0, 160)}"`); }
  } catch (e) { log("[approve] err:", e.message); }
}

// 1. onboard: import the key (0.2.51 tucks import behind a <details> disclosure)
const pop = await ctx.newPage();
await pop.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" }); await sleep(1000);
await shot(pop, "onboard-setup");
await pop.locator('summary:has-text("Import a single private key")').click({ timeout: 5000 }).catch(() => {});
await sleep(500);
await pop.fill("#import-key", PRIV).catch(async () => { await sleep(600); await pop.fill("#import-key", PRIV); });
await pop.fill("#import-pw", WALLET_PW).catch(() => {}); await pop.click("#btn-import").catch(() => {}); await sleep(3000);
const shown = (await pop.locator("#addr").innerText().catch(() => "")).toLowerCase();
log("onboarding:", shown.includes(ADDR.slice(2, 10)) ? "PASS key imported, addr " + shown.slice(0, 16) : "FAIL addr=" + shown);
await shot(pop, "onboarded");
log("popup shows:", (await pop.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160));

// 2. site: gate (if GATE_PW given) + connect (captures the connect clear-sign)
const page = await ctx.newPage();
const consoleErrs = []; page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text().slice(0, 120)); });
await page.goto(SITE + "/names", { waitUntil: "domcontentloaded" }); await sleep(2500);
if (GATE_PW && await page.locator("#pw").isVisible().catch(() => false)) { await page.fill("#pw", GATE_PW); await page.click("#go"); await sleep(2500); }
await shot(page, "site");
await page.click("#wallet-btn").catch(() => {}); await sleep(4500);
const wbtn = (await page.locator("#wallet-btn").innerText().catch(() => "")).toLowerCase();
log("connect:", wbtn.length > 2 && !/connect/i.test(wbtn) ? `PASS connected (${wbtn.slice(0, 16)})` : `state=${wbtn.slice(0, 20)}`);
await shot(page, "connected");

log(`\n=== SUMMARY === approvals(connect)=${approvals} reads+rejects(spend)=${rejects} consoleErrs=${consoleErrs.length}`);
clearsigns.forEach((c, i) => log(`  [${i + 1}] ${c.kind}: ${c.req.slice(0, 200)}`));
writeFileSync(`${SHOT}/clearsigns.json`, JSON.stringify(clearsigns, null, 2));
await ctx.close();
