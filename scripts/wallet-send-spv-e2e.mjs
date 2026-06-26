// FOCUSED live name-SPV SEND test on 0.2.34: import treasury -> main view -> send 0.01 CSD to 69.csd.
// The send must SPV-RESOLVE 69.csd -> 0xc251... in the clear-sign (c-name/c-to), then settle on-chain.
// Gives the cold SPV header sync proper time. Spends ~0.06 CSD.
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const CHROME = process.env.CHROME_BIN || undefined;
const EXT = "/opt/cairn_substrate/cairn-wallet/dist";
const PW = "wsend-test-9931";
const tk = JSON.parse(readFileSync(`${homedir()}/.config/cairn/cairnx-treasury.json`, "utf8"));
const PRIV = tk.privkey.startsWith("0x") ? tk.privkey : "0x" + tk.privkey;
const ADDR = String(tk.addr || tk.addr20).toLowerCase();
const NAME = "69.csd", NAME_ADDR = "0xc25117a104e2cba2a69ad3981a3c67299f550504", AMT = "0.01";
const SHOT = "/tmp/cairn-e2e-wallet-send";
mkdirSync(SHOT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let pass = 0, fail = 0, n = 0;
const ok = (c, m) => { console.log(`  ${c ? "✅ PASS" : "❌ FAIL"} ${m}`); c ? pass++ : fail++; return !!c; };
const shot = async (pg, t) => { try { await pg.screenshot({ path: `${SHOT}/${String(++n).padStart(2, "0")}-${t}.png` }); log("  📸", t); } catch {} };
const vis = async (pg, s) => pg.locator(s).first().isVisible().catch(() => false);
const balOf = async (a) => { try { return (await (await fetch(`http://127.0.0.1:8793/address/${a}`)).json()).chain_stats.balance; } catch { return null; } };

(async () => {
  const ctx = await chromium.launchPersistentContext("/tmp/cairn-wsend-" + process.pid, {
    headless: false, executablePath: CHROME, viewport: { width: 420, height: 720 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--no-first-run", "--disable-dev-shm-usage"],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 20000 }).catch(() => null);
  const extId = sw ? new URL(sw.url()).host : null;
  ok(!!extId, "sw up");
  const pg = await ctx.newPage();
  const errs = []; pg.on("console", (m) => m.type() === "error" && errs.push(m.text())); pg.on("pageerror", (e) => errs.push("PE:" + e.message));
  await pg.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" }); await sleep(1200);

  // import treasury via the setup IMPORT path -> lands on main (send form visible, no panel)
  await pg.fill("#import-key", PRIV).catch(async () => { await sleep(600); await pg.fill("#import-key", PRIV); });
  await pg.fill("#import-pw", PW).catch(() => {});
  await pg.click("#btn-import").catch(() => {});
  await sleep(2500);
  const addr = (await pg.locator("#addr").innerText().catch(() => "")).toLowerCase();
  ok(addr.includes(ADDR.slice(2, 8)), `imported treasury, main dashboard (#addr=${addr.slice(0, 14)})`);
  await shot(pg, "main");
  // the main view is a DASHBOARD — click "Send CSD" (btn-send-t) to open the send form
  await pg.click("#btn-send-t").catch(() => {});
  await sleep(1000);
  ok(await vis(pg, "#s-to"), "‘Send CSD’ opened the send form (#s-to present)");

  // SEND 0.01 CSD to 69.csd
  await pg.fill("#s-to", NAME); await pg.fill("#s-amt", AMT);
  await shot(pg, "send-form");
  await pg.click("#btn-send").catch(() => {});
  log("  btn-send clicked — waiting for SPV resolve (cold header sync, up to 75s)");
  // poll up to 75s for the confirm panel (cold SPV sync) OR a blocking toast
  let onConfirm = false;
  for (let i = 0; i < 25; i++) {
    await sleep(3000);
    onConfirm = await vis(pg, "#send-confirm");
    const cto = (await pg.locator("#c-to").innerText().catch(() => "")).trim();
    if (onConfirm && cto) break;
    const toast = (await pg.locator("#toast, .toast").innerText().catch(() => "")).trim();
    if (i % 3 === 0) log(`  …resolving (confirm=${onConfirm} toast="${toast.slice(0, 50)}")`);
  }
  ok(onConfirm, "send → confirm/clear-sign panel appeared (SPV resolve completed)");
  const cName = (await pg.locator("#c-name").innerText().catch(() => "")).trim();
  const cTo = (await pg.locator("#c-to").innerText().catch(() => "")).trim().toLowerCase();
  const cAmt = (await pg.locator("#c-amt").innerText().catch(() => "")).trim();
  const cWarn = (await pg.locator("#c-warn").innerText().catch(() => "")).trim();
  log(`  CLEAR-SIGN: name="${cName}" to="${cTo}" amt="${cAmt}" warn="${cWarn.slice(0, 60)}"`);
  await shot(pg, "send-confirm-spv");
  ok(/69/.test(cName), `clear-sign shows resolved name "${cName}"`);
  ok(cTo.includes(NAME_ADDR.slice(2, 10)), `SPV resolved ${NAME} → correct on-chain addr (${cTo.slice(0, 14)} vs ${NAME_ADDR.slice(0, 10)})`);

  const before = await balOf(NAME_ADDR);
  await pg.click("#btn-send-confirm").catch(() => {});
  log("  confirmed — waiting for on-chain settle");
  await sleep(2000); await shot(pg, "sent");
  let settled = false;
  for (let i = 0; i < 50; i++) {
    await sleep(10000);
    const now = await balOf(NAME_ADDR);
    const tip = (await fetch("http://127.0.0.1:8789/health").then((r) => r.json()).catch(() => ({})))?.height;
    if (now != null && before != null && now > before) { settled = true; log(`  ON-CHAIN: ${NAME} addr +${(now - before) / 1e8} CSD (tip ${tip})`); break; }
    if (i % 3 === 0) log(`  …waiting to mine (tip ${tip})`);
  }
  ok(settled, "LIVE name-SPV send settled on-chain (recipient +0.01)");
  await shot(pg, "settled");
  const realErrs = errs.filter((e) => !/favicon|ERR_|net::|status of [45]|404/i.test(e));
  ok(realErrs.length === 0, `no real console errors (${realErrs.length})`);
  log(`\n=== SEND E2E DONE: ${pass} pass, ${fail} fail ===`);
  await sleep(800); await ctx.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH:", e); process.exit(2); });
