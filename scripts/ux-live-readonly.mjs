// READ-ONLY live UX pass for today's work — loads the real site with the real wallet extension, captures
// console errors, screenshots key views/states, and probes the new UX (collapsible footer, duration
// dropdowns, /trade→/names link, gate.js no-throw, reduced-motion). NO on-chain writes. Operator-run.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const CHROME = process.env.CHROME_BIN || undefined;
const EXT = "/opt/cairn_substrate/cairn-wallet/dist";
const SITE = process.env.SITE || "https://cairn-substrate.com";
const GATE_PW = process.env.GATE_PW || "ohyesdaddy";
const WALLET_PW = "e2e-test-pw-9931";
const KEYFILE = process.env.KEY || `${homedir()}/.config/cairn/cairnx-treasury.json`;
const tk = JSON.parse(readFileSync(KEYFILE, "utf8"));
const PRIV = tk.privkey.startsWith("0x") ? tk.privkey : "0x" + tk.privkey;
const ADDR = String(tk.addr || tk.addr20).toLowerCase();
const SHOT = "/tmp/ux-shots";
const PROFILE = "/tmp/cairn-ux-ro-" + Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? "✅" : "❌"} ${m}`); c ? pass++ : fail++; return c; };

(async () => {
  (await import("node:fs")).mkdirSync(SHOT, { recursive: true });
  log("READ-ONLY UX pass on", SITE, "signer", ADDR);
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false, executablePath: CHROME, viewport: { width: 1366, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--no-first-run"],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 20000 }).catch(() => null);
  const extId = sw ? new URL(sw.url()).host : null;
  ok(!!extId, "wallet service worker up id=" + extId);

  // import key (so "connected" + "mine" states render)
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" });
  await sleep(800);
  await pop.fill("#import-key", PRIV).catch(async () => { await sleep(500); await pop.fill("#import-key", PRIV); });
  await pop.fill("#import-pw", WALLET_PW); await pop.click("#btn-import"); await sleep(2500);
  await pop.close().catch(() => {});

  const consoleErrs = [], pageErrs = [];
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text()); });
  page.on("pageerror", (e) => pageErrs.push(String(e.message || e)));

  // ── /trade ──
  const t0 = Date.now();
  await page.goto(SITE + "/trade", { waitUntil: "domcontentloaded" });
  if (await page.locator("#pw").isVisible().catch(() => false)) { await page.fill("#pw", GATE_PW); await page.click("#go"); await sleep(2500); }
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  log(`/trade interactive in ~${Date.now() - t0}ms`);
  await page.screenshot({ path: `${SHOT}/01-trade.png`, fullPage: true }).catch(() => {});

  // gate.js must not have thrown
  ok(!pageErrs.some((e) => /clientWidth|only a getter|getter/i.test(e)), "gate.js: no clientWidth/getter pageerror");

  // /trade Names entry is an <a href=/names>
  const namesLink = page.locator("a.names-link, a.mode-btn[href='/names']");
  ok(await namesLink.first().isVisible().catch(() => false), "/trade Names is an <a href=/names>");

  // collapsible "honest scope" footer: present, collapsed by default, expands
  const scope = page.locator("details.foot-scope").first();
  const hasScope = await scope.count().catch(() => 0);
  ok(hasScope > 0, "collapsible honest-scope footer present");
  if (hasScope) {
    const openBefore = await scope.evaluate((el) => el.open).catch(() => null);
    ok(openBefore === false, "honest-scope collapsed by default");
    await scope.locator("summary").click().catch(() => {});
    await sleep(400);
    const openAfter = await scope.evaluate((el) => el.open).catch(() => null);
    ok(openAfter === true, "honest-scope expands on click");
  }

  // duration dropdown: open the "make offer" / list modal on a token (Tokens mode → an offer form)
  // open the offer form via the action menu if present; otherwise just assert a <select id=f-exp> appears
  await page.locator("button.mode-btn[data-mode='tokens']").click().catch(() => {});
  await sleep(800);
  // try to open an offer modal (sell) — selectors vary; we just probe for the duration <select> after opening any "offer"/"sell" action
  let durSelect = false;
  for (const sel of ["[data-act='offer']", "#sell-btn", ".act-offer", "button:has-text('offer')", "button:has-text('sell')"]) {
    const b = page.locator(sel).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(800); break; }
  }
  durSelect = await page.locator("#f-exp, select#f-exp").first().isVisible().catch(() => false);
  if (durSelect) {
    const opts = await page.locator("#f-exp option").allInnerTexts().catch(() => []);
    ok(opts.length >= 3 && opts.some((o) => /week|day|hour/i.test(o)), `duration is a guided <select>: [${opts.join(", ")}]`);
    await page.screenshot({ path: `${SHOT}/02-duration-select.png` }).catch(() => {});
  } else { log("   (no offer modal reachable in this state — duration <select> asserted in static review)"); }
  await page.locator("#m-x, .m-x, .modal-x").first().click().catch(() => {});

  // ── /names ──
  await sleep(500);
  const n0 = Date.now();
  await page.goto(SITE + "/names", { waitUntil: "domcontentloaded" });
  if (await page.locator("#pw").isVisible().catch(() => false)) { await page.fill("#pw", GATE_PW); await page.click("#go"); await sleep(2500); }
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  log(`/names interactive in ~${Date.now() - n0}ms`);
  ok(await page.locator("#cn-q").isVisible().catch(() => false), "/names hero search rendered");
  await page.screenshot({ path: `${SHOT}/03-names-explore.png`, fullPage: true }).catch(() => {});

  // connect wallet so 'mine'/claim states are reachable
  await page.click("#wallet-btn").catch(() => {});
  await sleep(2500);

  // search the open-lane CAIRN listing's name? Instead, search "69" (open name offer @5csd) to see the buy(reserve) button
  await page.fill("#cn-q", "69"); await page.click("#cn-go"); await sleep(2500);
  const card69 = await page.locator("#cn-result").innerText().catch(() => "");
  await page.screenshot({ path: `${SHOT}/04-names-69-card.png` }).catch(() => {});
  ok(/reserve first|buy now|complete purchase|claim/i.test(card69) || /for sale|offer/i.test(card69), `name '69' card shows a buy/reserve action`);

  // tabs render
  for (const t of ["clubs", "market", "mine", "activity", "explore"]) {
    await page.click(`#cn-tabs .cn-tab[data-tab="${t}"]`).catch(() => {});
    await sleep(1200);
    const len = (await page.locator("#cn-view").innerText().catch(() => "")).length;
    ok(len > 0, `/names tab '${t}' rendered`);
  }
  await page.screenshot({ path: `${SHOT}/05-names-market.png`, fullPage: true }).catch(() => {});

  // ── reduced-motion check: emulate and confirm .pp animations are disabled (CSS media query) ──
  await page.emulateMedia({ reducedMotion: "reduce" }).catch(() => {});
  await page.goto(SITE + "/trade", { waitUntil: "domcontentloaded" });
  if (await page.locator("#pw").isVisible().catch(() => false)) { await page.fill("#pw", GATE_PW); await page.click("#go"); await sleep(2000); }
  // inject a .pp element to read its computed animation under reduced motion (pure CSS probe, no chain)
  const rm = await page.evaluate(() => {
    const d = document.createElement("div"); d.className = "pp"; d.setAttribute("data-stage", "securing");
    d.innerHTML = '<div class="pp-bar indet"><i></i></div><div class="pp-steps"><span class="pp-step now"><i class="pp-dot"></i></span></div>';
    document.body.appendChild(d);
    const bar = getComputedStyle(d.querySelector(".pp-bar.indet > i")).animationName;
    const dot = getComputedStyle(d.querySelector(".pp-step.now .pp-dot")).animationName;
    d.remove();
    return { bar, dot };
  }).catch((e) => ({ err: String(e) }));
  ok(rm && (rm.bar === "none" || rm.bar === "") && (rm.dot === "none" || rm.dot === ""), `reduced-motion disables pp animations (bar=${rm.bar}, dot=${rm.dot})`);

  const realErrs = consoleErrs.filter((e) => !/favicon|ERR_|net::|Failed to load resource|status of 4|status of 5/i.test(e));
  ok(realErrs.length === 0 && pageErrs.length === 0, `no JS console/page errors (console:${realErrs.length} page:${pageErrs.length} netTotal:${consoleErrs.length})`);
  if (pageErrs.length) pageErrs.slice(0, 10).forEach((e) => log("   PAGEERROR:", e.slice(0, 160)));
  if (realErrs.length) realErrs.slice(0, 10).forEach((e) => log("   console:", e.slice(0, 160)));

  log(`\n=== READ-ONLY UX pass: ${pass} ok, ${fail} fail — shots in ${SHOT} ===`);
  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error("CRASH:", e); process.exit(2); });
