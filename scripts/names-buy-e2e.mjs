// LIVE /names BUY E2E — buy a LISTED .csd end-to-end with the real 0.2.34 wallet ext + real chain.
// Drives: gate -> import key -> connect -> search -> sale card (fee breakdown) -> doFill(claim) ->
// stepper reserving/securing/ready (reload-persistence mid-securing) -> complete -> swapguard -> fill -> done.
// SAFETY: auto-approver caps at MAX_SIGS=2 (claim+fill); a 3rd/unexpected popup is REJECTED (closed, no sig).
// Budget guard: aborts before the buy if the offer price > MAX_PRICE. Captures clear-sign + screenshots.
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const CHROME = process.env.CHROME_BIN || undefined;
const EXT   = process.env.WALLET_EXT || "/opt/cairn_substrate/cairn-wallet/dist";
const SITE  = process.env.SITE  || "https://cairn-substrate.com";
const PROXY = process.env.PROXY || "http://127.0.0.1:7777/trade/api";
const CXSTATE = "http://127.0.0.1:8794";          // direct cairnx for on-chain truth
const GATE_PW   = process.env.GATE_PW || "ohyesdaddy";
const WALLET_PW = process.env.WALLET_PW || "e2e-test-pw-9931";
const TARGET = process.env.TARGET || "swap";       // name to buy
const MAX_PRICE = BigInt(process.env.MAX_PRICE || "250000000"); // 2.5 CSD budget cap (base units)
const MAX_SPEND = Number(process.env.MAX_SPEND_SIGS || 2); // spend sigs (claim + fill); Connect is NON-spend, always allowed
const KEYFILE = process.env.KEY || `${homedir()}/.config/cairn/cairnx-treasury.json`;
const tk = JSON.parse(readFileSync(KEYFILE, "utf8"));
const PRIV = tk.privkey.startsWith("0x") ? tk.privkey : "0x" + tk.privkey;
const ADDR = String(tk.addr || tk.addr20).toLowerCase();
const SHOT = process.env.SHOT || "/tmp/cairn-e2e-names-buy";
mkdirSync(SHOT, { recursive: true });
const PROFILE = "/tmp/cairn-namesbuy-" + process.pid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let pass = 0, fail = 0, shotN = 0, approvals = 0, rejects = 0, spendSigs = 0;
const ok = (c, m) => { console.log(`  ${c ? "✅ PASS" : "❌ FAIL"} ${m}`); c ? pass++ : fail++; return !!c; };
const note = (m) => console.log(`  • ${m}`);
const j = async (base, p) => { try { return await (await fetch(base + p)).json(); } catch { return null; } };
const shot = async (pg, tag) => { try { const f = `${SHOT}/${String(++shotN).padStart(2, "0")}-${tag}.png`; await pg.screenshot({ path: f, fullPage: false }); log("   📸", tag); return f; } catch (e) { return null; } };
const clearsigns = [];

(async () => {
  log(`=== /names BUY E2E === target=${TARGET}.csd buyer=${ADDR} ext=${EXT}`);
  // baseline on-chain truth
  const nameBefore = await j(CXSTATE, "/cairnx/names");
  const recB = (nameBefore || []).find((n) => n.name === TARGET);
  note(`pre: ${TARGET}.csd owner=${recB ? recB.owner : "(unregistered)"}`);
  const offersAll = await j(CXSTATE, "/cairnx/offers");
  const swapOffers = (offersAll || []).filter((o) => o.give && o.give.name === TARGET);
  note(`pre: ${swapOffers.length} open offer(s) for ${TARGET}: ${swapOffers.map((o) => (Number(o.want.value) / 1e8).toFixed(2) + " CSD@h" + o.height).join(", ")}`);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false, executablePath: CHROME, viewport: { width: 1366, height: 950 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--no-first-run", "--disable-dev-shm-usage"],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 20000 }).catch(() => null);
  const extId = sw ? new URL(sw.url()).host : null;
  ok(!!extId, "wallet service worker up id=" + extId);
  if (!extId) { await ctx.close(); process.exit(1); }

  // ── auto-approver with HARD cap + reject of the unexpected ──
  async function handleApprove(page) {
    try {
      for (let i = 0; i < 25 && !page.url().includes("approve.html"); i++) await sleep(120);
      if (!page.url().includes("approve.html")) return;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      for (let i = 0; i < 30; i++) {
        if (!(await page.locator("#view-locked").isVisible().catch(() => false))) break;
        await page.fill("#unlock-pw", WALLET_PW).catch(() => {});
        await page.click("#btn-unlock").catch(() => {});
        await sleep(700);
      }
      await page.locator("#btn-approve").waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
      let req = ""; try { req = (await page.locator("#req").innerText({ timeout: 3000 })).replace(/\s+/g, " ").trim(); } catch {}
      const isConnect = /connect|grant this site|permission to see/i.test(req);
      const isSpend = !isConnect; // claim (Reserve) or fill (purchase) — moves funds / anchors a fee
      const tag = `approve-${approvals + rejects + 1}-${isConnect ? "connect" : isSpend ? "spend" : "x"}`;
      await shot(page, tag);
      clearsigns.push({ n: approvals + rejects + 1, kind: isConnect ? "connect" : "spend", req });
      if (isSpend && spendSigs >= MAX_SPEND) {
        rejects++;
        log(`   [REJECT #${rejects}] over spend cap (${MAX_SPEND}); closing popup. req="${req.slice(0, 80)}"`);
        await page.locator("#btn-reject, #btn-cancel").click({ timeout: 2000 }).catch(() => {});
        await page.close().catch(() => {});
        return;
      }
      const btn = page.locator("#btn-approve");
      for (let i = 0; i < 50; i++) { if (await btn.isEnabled().catch(() => false)) break; await sleep(150); }
      await btn.click({ timeout: 5000 });
      approvals++; if (isSpend) spendSigs++;
      log(`   [APPROVE #${approvals}${isSpend ? ` spend#${spendSigs}` : " connect"}] clear-sign="${req.slice(0, 110)}"`);
    } catch (e) { log("   [approve] err:", e.message); }
  }
  ctx.on("page", (p) => handleApprove(p));

  // ── import treasury key ──
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" }); await sleep(900);
  await pop.fill("#import-key", PRIV).catch(async () => { await sleep(600); await pop.fill("#import-key", PRIV); });
  await pop.fill("#import-pw", WALLET_PW); await pop.click("#btn-import"); await sleep(2800);
  const shownAddr = (await pop.locator("#addr").innerText().catch(() => "")).toLowerCase();
  ok(shownAddr.includes(ADDR.slice(2, 10)), "key imported, popup shows addr " + shownAddr.slice(0, 16));
  await pop.close().catch(() => {});

  // ── open /names + gate ──
  const consoleErrs = [], headerReqs = [];
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text()); });
  page.on("pageerror", (e) => consoleErrs.push("PAGEERROR: " + e.message));
  page.on("response", (r) => { try { const u = r.url(); if (u.includes("/api/headers")) headerReqs.push(r.status()); } catch {} });
  await page.goto(SITE + "/names", { waitUntil: "domcontentloaded" });
  if (await page.locator("#pw").isVisible().catch(() => false)) { await page.fill("#pw", GATE_PW); await page.click("#go"); await sleep(2500); }
  if (!(await page.locator("#cn-q").isVisible().catch(() => false))) await page.goto(SITE + "/names", { waitUntil: "domcontentloaded" });
  ok(await page.locator("#cn-q").isVisible().catch(() => false), "/names rendered (hero search present)");
  await sleep(1500); await shot(page, "names-landing");

  // ── connect wallet ──
  await page.click("#wallet-btn"); await sleep(4000);
  const wbtn = (await page.locator("#wallet-btn").innerText().catch(() => "")).toLowerCase();
  ok(wbtn.length > 2 && !/connect/i.test(wbtn), `wallet connected (#wallet-btn="${wbtn.slice(0, 18)}")`);
  await shot(page, "connected");

  // ── ADVERSARIAL: search a STALE-offer name (xname-8ma941, owned by someone else, pre-V17 offer) ──
  await page.fill("#cn-q", "xname-8ma941"); await page.click("#cn-go"); await sleep(2500);
  const staleCard = await page.locator("#cn-result").innerText().catch(() => "");
  await shot(page, "stale-xname-card");
  ok(!/buy \(reserve|complete purchase|⚡ buy now/i.test(staleCard) || /unfillable|make an offer/i.test(staleCard),
    `STALE/foreign offer not presented as a naked buy (card mentions: ${/(unfillable|make an offer|for sale|registered)/i.exec(staleCard)?.[0] || "n/a"})`);

  // ── search the TARGET name ──
  await page.fill("#cn-q", TARGET); await page.click("#cn-go"); await sleep(2800);
  const card = await page.locator("#cn-result").innerText().catch(() => "");
  await shot(page, "sale-card");
  ok(/for sale|CSD/i.test(card), `search '${TARGET}': sale card shown`);
  // fee breakdown present?
  const feeBlock = await page.locator("#cn-result .fb, #cn-result .cn-rc-price").first().innerText().catch(() => "");
  note(`card price/fee text: ${feeBlock.replace(/\s+/g, " ").slice(0, 120)}`);
  // expand fee breakdown if collapsible
  await page.locator("#cn-result .fb-toggle, #cn-result summary").first().click({ timeout: 2000 }).catch(() => {});
  await sleep(600); await shot(page, "sale-card-fee-expanded");
  const fbFull = await page.locator("#cn-result").innerText().catch(() => "");
  ok(/you pay|all-in|≈|total/i.test(fbFull), `all-in fee disclosure present on card (${/(you pay[^\\n]{0,40}|≈[^\\n]{0,20})/i.exec(fbFull)?.[0] || "—"})`);

  // ── budget guard: which offer will the UI fill? ──
  const buyBtn = page.locator('#cn-result [data-na="buy"]').first();
  const buyId = await buyBtn.getAttribute("data-v").catch(() => null);
  const chosen = swapOffers.find((o) => o.id === buyId) || swapOffers[0];
  note(`UI buy targets offer ${buyId ? buyId.slice(0, 14) : "?"} = ${chosen ? (Number(chosen.want.value) / 1e8).toFixed(2) + " CSD" : "?"} (of ${swapOffers.length} offers)`);
  ok(!!chosen, "buy button bound to a real offer");
  if (chosen && BigInt(chosen.want.value) > MAX_PRICE) { ok(false, `ABORT: chosen price ${Number(chosen.want.value) / 1e8} CSD > budget cap`); await ctx.close(); process.exit(1); }

  // ── RESUME detection: if I already have a live claim, the saleCard renders the .pp stepper (cs==="mine").
  //     Poll up to ~2 min for it (a prior-run claim may still be burying) before deciding to reserve fresh. ──
  let resumed = false;
  for (let i = 0; i < 12; i++) {
    if (await page.locator("#cn-result .pp").isVisible().catch(() => false)) { resumed = true; break; }
    await sleep(10000);
    await page.fill("#cn-q", TARGET).catch(() => {}); await page.click("#cn-go").catch(() => {}); await sleep(2500);
  }
  if (resumed) {
    ok(true, "RESUMED an existing live claim (stepper present) — skipping fresh reserve (no double-claim)");
    await shot(page, "resumed-stepper");
  } else {
    // ── ADVERSARIAL: double-click the reserve button → must coalesce to ONE claim ──
    const aBefore = approvals;
    await buyBtn.click({ timeout: 8000 }).catch(() => {});
    await buyBtn.click({ timeout: 1500 }).catch(() => {});   // immediate 2nd click
    log("   reserve double-clicked → expect a single claim approval");
    if (await page.locator("#m-go").isVisible().catch(() => false)) { await shot(page, "reserve-modal"); await page.click("#m-go").catch(() => {}); }
    await sleep(4000);
    ok(approvals - aBefore <= 1, `double-click coalesced: ${approvals - aBefore} claim approval(s) fired (≤1)`);
    await shot(page, "after-claim");
  }

  // ── watch the stepper: reserving → securing → ready, reload-persistence mid-securing ──
  const stages = new Set(); let reloaded = false, fillStarted = false, done = false;
  for (let i = 0; i < 220; i++) {        // up to ~37 min
    await sleep(10000);
    const st = await page.locator(".pp").getAttribute("data-stage").catch(() => null);
    const head = (await page.locator(".pp .pp-head").innerText().catch(() => "")).replace(/\s+/g, " ");
    const sub = (await page.locator(".pp .pp-sub").innerText().catch(() => "")).replace(/\s+/g, " ");
    const tip = (await j(PROXY, "/cairnx/health"))?.tip ?? (await j(CXSTATE, "/health"))?.height ?? "?";
    if (st && !stages.has(st)) { stages.add(st); log(`   ▶ stage=${st} · ${head.slice(0, 46)} · ${sub.slice(0, 70)} (tip ${tip})`); await shot(page, `stage-${st}`); }
    else if (st) log(`     · ${st} · ${sub.slice(0, 70)} (tip ${tip})`);

    if (st === "securing" && !reloaded) {
      reloaded = true; log("   ↻ reload mid-securing (persistence test)");
      await page.reload({ waitUntil: "domcontentloaded" });
      if (await page.locator("#pw").isVisible().catch(() => false)) { await page.fill("#pw", GATE_PW); await page.click("#go"); await sleep(2000); }
      await page.fill("#cn-q", TARGET).catch(() => {}); await page.click("#cn-go").catch(() => {}); await sleep(3000);
      const st2 = await page.locator(".pp").getAttribute("data-stage").catch(() => null);
      ok(["securing", "ready", "purchasing"].includes(st2), `reload-persistence: stepper restored to '${st2}' (not lost)`);
      await shot(page, "after-reload");
    }

    if (st === "ready" && !fillStarted) {
      fillStarted = true; ok(true, "reached READY (claim buried, fillable)"); await shot(page, "ready");
      await page.locator("#cn-result .pp-cta, #cn-result [data-na='buy']").first().click({ timeout: 8000 }).catch(() => {});
      await sleep(1500);
      const toastTxt = await page.locator("#toast").innerText().catch(() => "");
      note(`complete-purchase toast: "${toastTxt.slice(0, 80)}"`);
      for (let k = 0; k < 40; k++) { if (await page.locator("#m-go").isVisible().catch(() => false)) break; await sleep(1000); }
      if (await page.locator("#m-go").isVisible().catch(() => false)) {
        await shot(page, "fill-confirm-modal");
        ok(true, "swapguard PASSED → fill-confirm modal opened");
        await page.click("#m-go").catch(() => {});
        log("   fill confirm clicked → expect fill approval (sig #2)");
      } else ok(false, `fill-confirm modal did NOT open — toast: "${toastTxt.slice(0, 90)}"`);
    }
    if (st === "done") { done = true; ok(true, "stepper reached DONE"); await shot(page, "done"); break; }

    // on-chain settle check (authoritative)
    const recNow = (await j(CXSTATE, "/cairnx/names"))?.find?.((n) => n.name === TARGET);
    if (recNow && String(recNow.owner).toLowerCase() === ADDR) { ok(true, "ON-CHAIN: name transferred to buyer"); await shot(page, "filled-onchain"); break; }
  }

  // ── final on-chain assertion ──
  await sleep(3000);
  const recFinal = (await j(CXSTATE, "/cairnx/names"))?.find?.((n) => n.name === TARGET);
  ok(recFinal && String(recFinal.owner).toLowerCase() === ADDR, `FINAL: ${TARGET}.csd owner == buyer 0x6b09 (owner=${recFinal ? recFinal.owner : "?"})`);

  // ── My Names tab shows it ──
  await page.locator('#cn-tabs .cn-tab[data-tab="mine"]').click({ timeout: 4000 }).catch(() => {});
  await sleep(3000); await shot(page, "my-names");
  ok((await page.locator("#cn-view").innerText().catch(() => "")).includes(TARGET), "My Names lists the bought name");

  // ── mobile viewport snapshot ──
  await page.setViewportSize({ width: 390, height: 844 }); await sleep(1200);
  await page.fill("#cn-q", TARGET).catch(() => {}); await page.click("#cn-go").catch(() => {}); await sleep(2000);
  await shot(page, "mobile-390");
  await page.setViewportSize({ width: 1366, height: 950 });

  // ── summary ──
  const realErrs = consoleErrs.filter((e) => !/favicon|ERR_|net::|Failed to load resource|status of 4|status of 5|404/i.test(e));
  ok(realErrs.length === 0, `no real JS console errors (${realErrs.length}; total incl network ${consoleErrs.length})`);
  const h429 = headerReqs.filter((s) => s === 429).length;
  ok(h429 === 0, `no /api/headers 429s (${headerReqs.length} header reqs, ${h429}×429)`);
  writeFileSync(`${SHOT}/clearsigns.json`, JSON.stringify({ clearsigns, stages: [...stages], approvals, rejects, consoleErrs: consoleErrs.slice(0, 30), headerStatuses: headerReqs }, null, 2));
  log(`\n=== BUY E2E DONE: ${pass} pass, ${fail} fail · ${approvals} sigs, ${rejects} rejected · stages: ${[...stages].join("→")} ===`);
  if (consoleErrs.length) consoleErrs.slice(0, 12).forEach((e) => log("     •", e.slice(0, 140)));
  await sleep(1500); await ctx.close(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH:", e); process.exit(2); });
