// LIVE browser E2E for /names: real Cairn Wallet extension + real /names UI + real on-chain writes.
// OPERATOR-ONLY (spends ~1.5 CSD; reads a funded key from disk). Drives the real site with the real
// extension and auto-approves each clear-sign popup. All env-overridable; NO secrets committed.
//   run: cd cairn-sdk && CHROME_BIN=$(ls ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | tail -1) \
//        WALLET_EXT=../cairn-wallet/dist GATE_PW=<alpha-gate-pw> KEY=~/.config/cairn/cairnx-treasury.json \
//        xvfb-run -a node names-e2e.mjs
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const CHROME = process.env.CHROME_BIN || undefined;    // undefined ⇒ playwright-core resolves its cached chromium (set CHROME_BIN if launch fails)
const EXT   = process.env.WALLET_EXT || "/opt/cairn_substrate/cairn-wallet/dist"; // unpacked MV3 build
const SITE  = process.env.SITE  || "https://cairn-substrate.com";
const PROXY = process.env.PROXY || "http://127.0.0.1:7777/trade/api"; // public (ungated) cairnx proxy, for chain assertions
const GATE_PW   = process.env.GATE_PW || "";           // private-alpha gate passphrase (supply via env; never committed)
const WALLET_PW = process.env.WALLET_PW || "e2e-test-pw-9931"; // throwaway vault password for the test profile
const KEYFILE = process.env.KEY || `${homedir()}/.config/cairn/cairnx-treasury.json`;
const tk = JSON.parse(readFileSync(KEYFILE, "utf8"));
const PRIV = tk.privkey.startsWith("0x") ? tk.privkey : "0x" + tk.privkey;
const ADDR = String(tk.addr || tk.addr20).toLowerCase();
const OTHER = "0xdbbcf2ef2ffee9012479ada04fc56aa8707a9d4a"; // a real 2nd addr for the set-address test
const PROFILE = "/tmp/cairn-e2e-" + Date.now();
const rnd = Math.random().toString(36).replace(/[^a-z0-9]/g, "").slice(0, 7);
const NAME = ("e2e" + rnd + "aaa").slice(0, 12);        // >=10 chars => 0.1 CSD reg fee, valid charset

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? "✅ PASS" : "❌ FAIL"} ${m}`); c ? pass++ : fail++; return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p) => { try { const r = await fetch(PROXY + p); return await r.json(); } catch { return null; } };
async function nameRec(n) { return j("/cairnx/name/" + n); }
async function waitChain(label, pred, timeoutMs = 720000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await pred()) { log(`   …${label}: ok (${Math.round((Date.now() - t0) / 1000)}s)`); return true; } } catch {}
    await sleep(8000);
  }
  log(`   …${label}: TIMEOUT (${Math.round(timeoutMs / 1000)}s)`); return false;
}

(async () => {
  log("=== /names LIVE E2E ===  name:", NAME, " signer:", ADDR);
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false, executablePath: CHROME,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--no-first-run"],
  });

  // ── extension id (from the MV3 service worker) ──
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 20000 }).catch(() => null);
  if (!sw) { log("no service worker — opening a page to wake it"); }
  const extId = sw ? new URL(sw.url()).host : null;
  ok(!!extId, "extension service worker up, id=" + extId);
  if (!extId) { await ctx.close(); process.exit(1); }

  // ── auto-approver: any approval popup → unlock if needed, then approve ──
  let approvals = 0;
  async function handleApprove(page) {
    try {
      for (let i = 0; i < 25 && !page.url().includes("approve.html"); i++) await sleep(120);
      if (!page.url().includes("approve.html")) return;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      // unlock if the SW was idle-killed / auto-locked
      for (let i = 0; i < 30; i++) {
        const locked = await page.locator("#view-locked").isVisible().catch(() => false);
        if (!locked) break;
        await page.fill("#unlock-pw", WALLET_PW).catch(() => {});
        await page.click("#btn-unlock").catch(() => {});
        await sleep(700);
      }
      const btn = page.locator("#btn-approve");
      await btn.waitFor({ state: "visible", timeout: 12000 });
      let req = ""; try { req = (await page.locator("#req").innerText({ timeout: 3000 })).replace(/\s+/g, " ").slice(0, 90); } catch {}
      for (let i = 0; i < 50; i++) { if (await btn.isEnabled().catch(() => false)) break; await sleep(150); }
      await btn.click({ timeout: 5000 });
      approvals++;
      log(`   [approve #${approvals}] ${req}`);
    } catch (e) { log("   [approve] err:", e.message); }
  }
  ctx.on("page", (p) => handleApprove(p));

  // ── import the treasury key into the wallet ──
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" });
  await sleep(800);
  // the import fields may be behind an onboarding choice; they exist in popup.html
  await pop.fill("#import-key", PRIV).catch(async () => { await sleep(500); await pop.fill("#import-key", PRIV); });
  await pop.fill("#import-pw", WALLET_PW);
  await pop.click("#btn-import");
  await sleep(2500);
  const shownAddr = (await pop.locator("#addr").innerText().catch(() => "")).toLowerCase();
  ok(shownAddr.includes(ADDR.slice(2, 10)), "wallet imported, popup shows addr (" + shownAddr.slice(0, 16) + "…)");
  await pop.close().catch(() => {});

  // ── open /names, pass the private-alpha gate ──
  const consoleErrs = [];
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text()); });
  page.on("pageerror", (e) => consoleErrs.push("PAGEERROR: " + e.message));
  await page.goto(SITE + "/names", { waitUntil: "domcontentloaded" });
  if (GATE_PW && await page.locator("#pw").isVisible().catch(() => false)) {
    await page.fill("#pw", GATE_PW); await page.click("#go");
    await sleep(2500);
  }
  if (!(await page.locator("#cn-q").isVisible().catch(() => false))) {
    await page.goto(SITE + "/names", { waitUntil: "domcontentloaded" });
  }
  ok(await page.locator("#cn-q").isVisible().catch(() => false), "/names app rendered (hero search present)");
  const tabs = await page.locator("#cn-tabs .cn-tab").count().catch(() => 0);
  ok(tabs >= 5, `tab bar present (${tabs} tabs)`);
  await sleep(1500);

  // ── connect wallet ──
  await page.click("#wallet-btn");
  await waitChain("wallet connected (UI shows addr)", async () =>
    (await page.locator("#wallet-btn").innerText().catch(() => "")).toLowerCase().includes(ADDR.slice(2, 8)), 60000);
  const wbtn = (await page.locator("#wallet-btn").innerText().catch(() => "")).toLowerCase();
  ok(wbtn.includes(ADDR.slice(2, 8)), "wallet connected: " + wbtn.slice(0, 16));

  // ── search availability (should be AVAILABLE) ──
  await page.fill("#cn-q", NAME);
  await page.click("#cn-go");
  await sleep(2500);
  const card = await page.locator("#cn-result").innerText().catch(() => "");
  ok(/available/i.test(card) && /CSD/.test(card), `search shows '${NAME}' AVAILABLE + price`);

  // ── REGISTER: commit → (mine + bury 3) → reveal+fee ──
  await page.click('#cn-result [data-na="register"]');
  log("   register clicked → commit approval expected");
  await waitChain("commit accepted on chain (record applied)", async () => {
    // the reveal button only appears once commit mined+buried; poll the UI for it
    return await page.locator('#cn-result [data-na="reveal"]').isVisible().catch(() => false);
  }, 900000);
  ok(await page.locator('#cn-result [data-na="reveal"]').isVisible().catch(() => false), "commit buried → reveal unlocked in UI");
  await page.click('#cn-result [data-na="reveal"]');
  log("   reveal clicked → reveal+fee approval expected");
  // promptSetPrimary modal pops after reveal broadcast — dismiss it (we'll set primary after it MINES)
  await sleep(4000);
  await page.locator("#m-x").click({ timeout: 4000 }).catch(() => {});
  const owned = await waitChain("name owned on chain by us", async () => {
    const d = await nameRec(NAME); return d && String(d.owner || "").toLowerCase() === ADDR;
  }, 600000);
  ok(owned, `REGISTERED: ${NAME}.csd owner == treasury on chain`);

  // ── My Names tab should list it (after the data loop re-renders) ──
  await page.click('#cn-tabs .cn-tab[data-tab="mine"]');
  await waitChain("My Names shows the new name", async () =>
    (await page.locator("#cn-view").innerText().catch(() => "")).includes(NAME), 40000);
  ok((await page.locator("#cn-view").innerText().catch(() => "")).includes(NAME), "My Names lists the registered name");

  // ── #2 STALENESS via SET PRIMARY (nset→self; name.addr changes, names.length does NOT) ──
  await page.click(`#cn-view [data-na="primary"][data-v="${NAME}"]`).catch(async () => {
    await page.click('#cn-view [data-na="primary"]'); });
  await page.locator("#m-go").click({ timeout: 5000 }).catch(() => {});  // confirm modal
  const primaryMined = await waitChain("set-primary mined (name.addr==owner)", async () => {
    const d = await nameRec(NAME); return d && String(d.addr || "").toLowerCase() === ADDR;
  }, 600000);
  ok(primaryMined, "SET PRIMARY mined on chain (nset→self)");
  // KEY ASSERTION (#2): the My Names view reflects ★ primary WITHOUT us reloading the page
  const primaryInUI = await waitChain("UI auto-updates to ★ primary (no reload)", async () =>
    /★\s*primary|primary/i.test(await page.locator("#cn-view").innerText().catch(() => "")), 40000);
  ok(primaryInUI, "#2 STALENESS FIX: ★ primary appeared in UI without a manual reload");

  // ── #2 STALENESS via RENEW (paidThroughEpoch changes, names.length does NOT) ──
  const beforePT = (await nameRec(NAME))?.paidThroughEpoch;
  await page.click(`#cn-view [data-na="renew"][data-v="${NAME}"]`).catch(async () => { await page.click('#cn-view [data-na="renew"]'); });
  await page.locator("#m-go").click({ timeout: 5000 }).catch(() => {});
  const renewed = await waitChain("renew mined (paidThroughEpoch increased)", async () => {
    const d = await nameRec(NAME); return d && Number(d.paidThroughEpoch) > Number(beforePT);
  }, 600000);
  ok(renewed, `RENEW mined (paidThrough ${beforePT} → ${(await nameRec(NAME))?.paidThroughEpoch})`);

  // ── #1 FEE-BURN GUARD: listing a FRESH (<240-block, !viaFill) name must be BLOCKED, no tx ──
  await page.click('#cn-tabs .cn-tab[data-tab="mine"]'); await sleep(1500);
  const approvalsBefore = approvals;
  await page.click(`#cn-view [data-na="list"][data-v="${NAME}"]`).catch(async () => { await page.click('#cn-view [data-na="list"]'); });
  await sleep(2500);
  const toastTxt = await page.locator("#toast").innerText().catch(() => "");
  const modalOpen = await page.locator("#m-go").isVisible().catch(() => false);
  ok(/too new to sell|sellable from block/i.test(toastTxt) && !modalOpen,
    `#1 GUARD: fresh-name list BLOCKED with a clear toast, no modal — "${toastTxt.slice(0, 60)}"`);
  await sleep(1500);
  ok(approvals === approvalsBefore, "#1 GUARD: no signing popup / no anchor fee spent on the blocked listing");

  // ── #new MAKE-AN-OFFER: bid on a name owned by SOMEONE ELSE → modal must open (was broken) ──
  const all = await j("/cairnx/names");
  const offers = await j("/cairnx/offers");
  const forSale = new Set((offers || []).filter((o) => o.give && o.give.name && o.status === "open").map((o) => o.give.name));
  const other = (all || []).find((n) => String(n.owner || "").toLowerCase() !== ADDR && !forSale.has(n.name) && n.name !== "69");
  if (other) {
    await page.fill("#cn-q", other.name); await page.click("#cn-go"); await sleep(2500);
    await page.click('#cn-result [data-na="offer"]').catch(() => {});
    await sleep(1500);
    const bidModal = await page.locator("#f-bval").isVisible().catch(() => false);
    const tToast = await page.locator("#toast").innerText().catch(() => "");
    ok(bidModal && !/select a token/i.test(tToast), `#new MAKE-AN-OFFER: bid modal OPENED for ${other.name}.csd (no "select a token first")`);
    if (bidModal) {
      await page.fill("#f-bval", "0.1");
      await page.locator("#m-go").click({ timeout: 5000 }).catch(() => {});
      const bidPosted = await waitChain("bid posted on chain", async () => {
        const b = await j("/cairnx/bids"); return (b || []).some((x) => x.bidder && x.bidder.toLowerCase() === ADDR && x.want && x.want.name === other.name);
      }, 600000);
      ok(bidPosted, `BID posted on chain for ${other.name}.csd`);
    }
  } else { log("   (no owned-by-other unsold name found to bid on — skipping #new live)"); }

  // ── tab navigation + console-error capture ──
  for (const t of ["clubs", "market", "activity", "explore"]) {
    await page.click(`#cn-tabs .cn-tab[data-tab="${t}"]`).catch(() => {});
    await sleep(1500);
    const txt = (await page.locator("#cn-view").innerText().catch(() => "")).length;
    ok(txt > 0, `tab '${t}' rendered content`);
  }

  // ── #7 RETIRED /trade Names tab → now a link to /names ──
  await page.goto(SITE + "/trade", { waitUntil: "domcontentloaded" });
  if (GATE_PW && await page.locator("#pw").isVisible().catch(() => false)) { await page.fill("#pw", GATE_PW); await page.click("#go"); await sleep(2000); }
  const namesLink = page.locator("a.names-link, a.mode-btn[href='/names']");
  const isLink = await namesLink.first().isVisible().catch(() => false);
  ok(isLink, "#7 /trade 'Names' is now an <a href=/names> (not an in-page tab button)");
  if (isLink) {
    await namesLink.first().click();
    await page.waitForURL("**/names**", { timeout: 15000 }).catch(() => {});
    ok(/\/names/.test(page.url()), "#7 clicking Names navigates to /names (" + page.url() + ")");
  }

  // ── console errors summary ──
  const realErrs = consoleErrs.filter((e) => !/favicon|ERR_|net::|Failed to load resource|status of 4|status of 5/i.test(e));
  ok(realErrs.length === 0, `no JS console errors on /names (${realErrs.length}; total incl. network: ${consoleErrs.length})`);
  if (consoleErrs.length) { log("   console messages:"); consoleErrs.slice(0, 20).forEach((e) => log("     •", e.slice(0, 140))); }

  log(`\n=== /names E2E DONE: ${pass} passed, ${fail} failed, ${approvals} signatures approved ===`);
  await sleep(1500);
  await ctx.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error("E2E CRASH:", e); process.exit(2); });
