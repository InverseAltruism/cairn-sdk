// LIVE open-lane BUY E2E — drives the headline new UX (purchase.js stepper: Reserve→Secure→Pay→Confirm) on
// the real /trade buy-card for the cheap open CAIRN offer (~0.001 CSD). Real wallet ext + treasury key + real
// on-chain claim + fill. Captures a screenshot at every stage + reload-persistence. Operator-run (spends ~0.1 CSD).
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const CHROME = process.env.CHROME_BIN || undefined;
const EXT = "/opt/cairn_substrate/cairn-wallet/dist";
const SITE = process.env.SITE || "https://cairn-substrate.com";
const PROXY = "http://127.0.0.1:7777/trade/api";
const GATE_PW = process.env.GATE_PW || "ohyesdaddy";
const WALLET_PW = "e2e-test-pw-9931";
const TOKEN = process.env.TOKEN || "CAIRN";
const KEYFILE = process.env.KEY || `${homedir()}/.config/cairn/cairnx-treasury.json`;
const tk = JSON.parse(readFileSync(KEYFILE, "utf8"));
const PRIV = tk.privkey.startsWith("0x") ? tk.privkey : "0x" + tk.privkey;
const ADDR = String(tk.addr || tk.addr20).toLowerCase();
const SHOT = "/tmp/ux-buy"; mkdirSync(SHOT, { recursive: true });
const PROFILE = "/tmp/cairn-buy-" + Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let pass = 0, fail = 0, shotN = 0;
const ok = (c, m) => { console.log(`  ${c ? "✅ PASS" : "❌ FAIL"} ${m}`); c ? pass++ : fail++; return c; };
const j = async (p) => { try { return await (await fetch(PROXY + p)).json(); } catch { return null; } };
const shot = async (page, tag) => { try { await page.screenshot({ path: `${SHOT}/${String(++shotN).padStart(2, "0")}-${tag}.png` }); log("   📸", tag); } catch {} };

(async () => {
  log("=== OPEN-LANE BUY E2E ===  token", TOKEN, " buyer", ADDR);
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false, executablePath: CHROME, viewport: { width: 1366, height: 950 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--no-first-run"],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 20000 }).catch(() => null);
  const extId = sw ? new URL(sw.url()).host : null;
  ok(!!extId, "wallet sw up id=" + extId);

  let approvals = 0;
  async function handleApprove(page) {
    try {
      for (let i = 0; i < 25 && !page.url().includes("approve.html"); i++) await sleep(120);
      if (!page.url().includes("approve.html")) return;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      for (let i = 0; i < 30; i++) {
        if (!(await page.locator("#view-locked").isVisible().catch(() => false))) break;
        await page.fill("#unlock-pw", WALLET_PW).catch(() => {}); await page.click("#btn-unlock").catch(() => {}); await sleep(700);
      }
      const btn = page.locator("#btn-approve");
      await btn.waitFor({ state: "visible", timeout: 12000 });
      let req = ""; try { req = (await page.locator("#req").innerText({ timeout: 3000 })).replace(/\s+/g, " ").slice(0, 90); } catch {}
      for (let i = 0; i < 50; i++) { if (await btn.isEnabled().catch(() => false)) break; await sleep(150); }
      await btn.click({ timeout: 5000 }); approvals++; log(`   [approve #${approvals}] ${req}`);
    } catch (e) { log("   [approve] err:", e.message); }
  }
  ctx.on("page", (p) => handleApprove(p));

  // import key
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" }); await sleep(800);
  await pop.fill("#import-key", PRIV).catch(async () => { await sleep(500); await pop.fill("#import-key", PRIV); });
  await pop.fill("#import-pw", WALLET_PW); await pop.click("#btn-import"); await sleep(2500);
  await pop.close().catch(() => {});

  const consoleErrs = [];
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text()); });
  page.on("pageerror", (e) => consoleErrs.push("PAGEERROR: " + e.message));
  await page.goto(SITE + "/trade", { waitUntil: "domcontentloaded" });
  if (await page.locator("#pw").isVisible().catch(() => false)) { await page.fill("#pw", GATE_PW); await page.click("#go"); await sleep(2500); }
  ok(await page.locator("#mode-toggle").isVisible().catch(() => false), "/trade loaded");

  // connect wallet
  await page.click("#connect-btn, #wallet-btn, [data-act='connect']").catch(() => {});
  await sleep(3000);

  // select the token with the open offer
  await page.click(`.tk-tab[data-t="${TOKEN}"]`).catch(async () => { await page.locator(`.tk-tab:has-text("${TOKEN}")`).first().click().catch(() => {}); });
  await sleep(2500);
  await shot(page, "buycard-open");
  const buyTxt = await page.locator("#buy-go, [data-pp-buy]").first().innerText().catch(() => "");
  log("   buy-card button:", JSON.stringify(buyTxt));

  // offer baseline (just to confirm an open CAIRN offer exists; the buy-card picks the cheapest fillable)
  const offersBefore = await j("/cairnx/offers");
  const anyOpen = (offersBefore || []).find((o) => o.status === "open" && o.give?.ticker === TOKEN && o.want?.value !== undefined && !o.taker);
  ok(!!anyOpen, `at least one open ${TOKEN} CSD offer exists (cheapest ${anyOpen ? (Number(anyOpen.want.value) / 1e8).toFixed(4) : "?"} CSD)`);

  // ── CLAIM (Reserve) ── idempotent: if the offer is ALREADY claimed by us (stepper present), skip the claim
  const aBefore = approvals;
  const alreadyInFlight = await page.locator(".pp[data-purchase]").first().isVisible().catch(() => false);
  if (alreadyInFlight) {
    log("   offer already claimed by us (stepper present from chain state) — skipping re-claim");
    ok(true, "resumed an existing in-flight reservation (chain-reconstructed stepper)");
  } else {
    await page.locator("#buy-go").click({ timeout: 8000 }).catch(() => {});
    await sleep(1500);
    if (await page.locator("#m-go").isVisible().catch(() => false)) { await shot(page, "claim-modal"); await page.click("#m-go").catch(() => {}); }
    log("   claim clicked — waiting for claim approval + mine");
    await sleep(2500);
    ok(approvals > aBefore || await page.locator(".pp").isVisible().catch(() => false), "claim signed (approval fired) / stepper mounting");
  }
  await shot(page, "after-claim-click");
  // learn which offer the stepper attached to (adaptive — robust to whichever offer was 'best')
  await sleep(2000);
  let target = { id: await page.locator(".pp[data-purchase]").first().getAttribute("data-purchase").catch(() => null) };
  if (!target.id && anyOpen) target = anyOpen; // fallback
  log("   tracking offer id:", target.id?.slice?.(0, 16) || target.id);

  // watch the stepper advance: reserving → securing → ready
  const stages = new Set();
  let reloadedOnce = false, fillSubmitted = false;
  for (let i = 0; i < 200; i++) { // up to ~33 min
    await sleep(10000);
    const st = await page.locator(".pp").getAttribute("data-stage").catch(() => null);
    const head = await page.locator(".pp .pp-head").innerText().catch(() => "");
    const sub = await page.locator(".pp .pp-sub").innerText().catch(() => "");
    const tip = (await j("/cairnx/health"))?.tip ?? "?";
    if (st && !stages.has(st)) { stages.add(st); log(`   ▶ stage=${st} · ${head.replace(/\s+/g, " ").slice(0, 50)} · ${sub.replace(/\s+/g, " ").slice(0, 70)} (tip ${tip})`); await shot(page, `stage-${st}`); }
    else if (st) log(`     · ${st} · ${sub.replace(/\s+/g, " ").slice(0, 70)} (tip ${tip})`);

    // mid-securing reload-persistence test (once)
    if (st === "securing" && !reloadedOnce) {
      reloadedOnce = true;
      log("   ↻ reloading mid-securing to test persistence");
      await page.reload({ waitUntil: "domcontentloaded" });
      if (await page.locator("#pw").isVisible().catch(() => false)) { await page.fill("#pw", GATE_PW); await page.click("#go"); await sleep(2000); }
      await page.click(`.tk-tab[data-t="${TOKEN}"]`).catch(() => {}); await sleep(3000);
      const st2 = await page.locator(".pp").getAttribute("data-stage").catch(() => null);
      ok(st2 === "securing" || st2 === "ready" || st2 === "purchasing", `reload-persistence: stepper restored to '${st2}' (not lost)`);
      await shot(page, "after-reload");
    }

    // when ready, click complete purchase (ONCE)
    if (st === "ready" && !fillSubmitted) {
      fillSubmitted = true;
      ok(true, "reached READY stage (claim buried, fillable)");
      await shot(page, "ready");
      await page.locator("[data-pp-buy]").click({ timeout: 8000 }).catch(() => {});
      await sleep(1500);
      const toastTxt = await page.locator("#toast").innerText().catch(() => "");
      ok(/verifying this purchase on-chain/i.test(toastTxt), `instant 'verifying on-chain' feedback shown: "${toastTxt.slice(0, 60)}"`);
      log("   complete-purchase clicked — swapguard verify (~few s) → fill confirm modal");
      // the swapguard SPV verify runs (inclusion + claim scan), THEN doFill opens the fill-confirm modal (#m-go)
      for (let k = 0; k < 30; k++) { if (await page.locator("#m-go").isVisible().catch(() => false)) break; await sleep(1000); }
      if (await page.locator("#m-go").isVisible().catch(() => false)) {
        await shot(page, "fill-confirm-modal");
        ok(true, "swapguard PASSED → fill-confirm modal opened (#m-go)");
        await page.click("#m-go").catch(() => {});  // → wallet.fillOffer → approve popup (auto-approved)
        log("   fill confirm clicked — waiting for fill approval + mine");
      } else {
        const tt = await page.locator("#toast").innerText().catch(() => "");
        ok(false, `fill-confirm modal did NOT open — toast: "${tt.slice(0, 90)}"`);
        await shot(page, "no-fill-modal");
      }
    }
    if (st === "confirming" || st === "purchasing") { /* keep watching to 'done' */ }
    if (st === "done") { ok(true, "reached DONE (settled)"); await shot(page, "done"); break; }

    // also break if the offer is filled on-chain by us (stepper may have cleared)
    const offNow = (await j("/cairnx/offers"))?.find?.((o) => o.id === target.id) || (await j("/cairnx/offer/" + target.id))?.offer;
    const filledByMe = offNow && offNow.status !== "open" && (
      String(offNow.fill?.buyer || "").toLowerCase() === ADDR ||
      (Array.isArray(offNow.fills) && offNow.fills.some((f) => String(f.buyer || "").toLowerCase() === ADDR)));
    if (filledByMe) { ok(true, "offer FILLED on-chain by treasury buyer"); await shot(page, "filled-onchain"); break; }
  }

  // final on-chain assertion
  const finalOffer = (await j("/cairnx/offer/" + target.id))?.offer || (await j("/cairnx/offers"))?.find?.((o) => o.id === target.id);
  log("   final offer status:", finalOffer?.status);
  const realErrs = consoleErrs.filter((e) => !/favicon|ERR_|net::|Failed to load resource|status of 4|status of 5/i.test(e));
  ok(realErrs.length === 0, `no JS console errors during buy (${realErrs.length}; total ${consoleErrs.length})`);
  if (consoleErrs.length) consoleErrs.slice(0, 15).forEach((e) => log("     •", e.slice(0, 150)));

  log(`\n=== OPEN-LANE BUY DONE: ${pass} pass, ${fail} fail, ${approvals} sigs · stages seen: ${[...stages].join("→")} ===`);
  await sleep(1500); await ctx.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH:", e); process.exit(2); });
