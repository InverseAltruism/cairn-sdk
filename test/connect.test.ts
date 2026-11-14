// Connector tests: provider detection + typed error mapping. Runs under tsx in Node;
// we stub a minimal `window` backed by a real EventTarget.
import { readFileSync } from "node:fs";
import {
  WalletConnection,
  detectProvider,
  discoverProviders,
  isInstalled,
  NotInstalledError,
  UserRejectedError,
  WalletLockedError,
  UnsupportedMethodError,
  CairnError,
  SubmitInFlightError,
} from "../src/index.js";
import type { CairnProvider, ProviderReply } from "../src/connect.js";
import { buildSiwcMessage, CSD_CHAIN_MAINNET, generateNonce, SIWC_VERSION } from "@inversealtruism/csd-siwc";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };
const okThrows = async (n: string, fn: () => Promise<unknown>, ctor: new (...a: any[]) => Error) => {
  try { await fn(); ok(n, false); } catch (e) { ok(n, e instanceof ctor); }
};

// --- a fake browser window backed by EventTarget ---
function installWindow(provider?: CairnProvider) {
  const et = new EventTarget();
  (globalThis as any).window = {
    cairn: provider,
    addEventListener: et.addEventListener.bind(et),
    removeEventListener: et.removeEventListener.bind(et),
    dispatchEvent: et.dispatchEvent.bind(et),
  };
  return et;
}
function clearWindow() { delete (globalThis as any).window; }

function mockProvider(over: Partial<CairnProvider> = {}): CairnProvider {
  const reply = <T>(r: ProviderReply<T>) => Promise.resolve(r);
  const events: Record<string, ((d: any) => void)[]> = {};
  return {
    isCairn: true,
    version: "0.2.7",
    connect: () => reply({ ok: true, result: { addr: "0xabc" } }),
    getAddress: () => reply({ ok: true, result: { addr: "0xabc" } }),
    signIn: () => reply({ ok: true, result: { addr: "0xabc", sig64: "0xsig" } }),
    propose: () => reply({ ok: true, result: { ok: true, txid: "0xtx" } }),
    attest: () => reply({ ok: true, result: { ok: true, txid: "0xtx" } }),
    send: () => reply({ ok: true, result: { ok: true, txid: "0xtx" } }),
    fillOffer: () => reply({ ok: true, result: { ok: true, txid: "0xfill" } }),
    signInWithCsd: () => reply({ ok: true, result: { account: "0xabc", pub33: "0xpub", sig64: "0xsig", message: "casino.example wants you to sign in with your Compute Substrate account:\n0xabc", chainId: "csd:00000052c2821f71b19c3d79dfabfb12" } }),
    getCapabilities: () => Promise.resolve({ version: "0.2.24", siwc: "1", methods: ["connect", "signInWithCsd"] }),
    getPermissions: () => reply({ ok: true, result: [{ invoker: "casino.example", accounts: ["0xabc"], grantedAt: 1 }] }),
    requestPermissions: () => reply({ ok: true, result: [{ invoker: "casino.example", accounts: ["0xabc"], grantedAt: 2 }] }),
    revokePermissions: () => reply({ ok: true, result: { revoked: true } }),
    on(ev: string, h: (d: any) => void) { (events[ev] ||= []).push(h); },
    removeListener(ev: string, h: (d: any) => void) { if (events[ev]) events[ev] = events[ev].filter((x) => x !== h); },
    _emit(ev: string, d: any) { (events[ev] || []).forEach((h) => h(d)); },
    sealClaim: () => reply({ ok: true, result: { ok: true, txid: "0xtx" } }),
    revealClaim: () => reply({ ok: true, result: { ok: true, txid: "0xtx" } }),
    ...over,
  } as CairnProvider;
}

console.log("=== connector: detection ===");
{
  clearWindow();
  await okThrows("detectProvider rejects NotInstalled outside a browser", () => detectProvider({ timeoutMs: 50 }), NotInstalledError);
  ok("isInstalled() is false with no window", isInstalled() === false);

  installWindow(mockProvider());
  ok("isInstalled() is true when window.cairn present", isInstalled() === true);
  const p = await detectProvider({ timeoutMs: 100 });
  ok("detectProvider resolves the present provider", p.isCairn === true);

  // provider injected slightly later → resolved via cairn#initialized event
  const et = installWindow(undefined);
  // The real wallet injects after the page's startup (absent at DOMContentLoaded in 0 of 8 Chromium loads): at
  // startup isInstalled() reads false for a wallet user and does not wait; detectProvider is the startup path.
  ok("before the late injection isInstalled() is false, synchronously (a boolean, not a promise)", isInstalled() === false);
  const pending = detectProvider({ timeoutMs: 500 });
  setTimeout(() => { (globalThis as any).window.cairn = mockProvider(); et.dispatchEvent(new Event("cairn#initialized")); }, 20);
  const p2 = await pending;
  ok("detectProvider resolves after cairn#initialized fires", p2.isCairn === true);
  ok("after the injection isInstalled() is true", isInstalled() === true);

  installWindow(undefined);
  await okThrows("detectProvider times out → NotInstalled", () => detectProvider({ timeoutMs: 60 }), NotInstalledError);
}

console.log("=== connector: EIP-6963-style discovery ===");
{
  // No window.cairn global: the wallet announces only when asked (csd:requestProvider).
  const et = installWindow(undefined);
  const prov = mockProvider();
  const announce = () => et.dispatchEvent(new CustomEvent("csd:announceProvider", { detail: { info: { uuid: "u1", name: "Cairn Wallet", icon: "data:,", rdns: "com.cairn-substrate.wallet" }, provider: prov } }));
  et.addEventListener("csd:requestProvider", announce);
  const p = await detectProvider({ timeoutMs: 300 });
  ok("detectProvider resolves via csd:announceProvider (no global)", p === prov);
  const list = await discoverProviders({ timeoutMs: 80 });
  ok("discoverProviders enumerates announced wallets", list.length === 1 && list[0]!.info.rdns === "com.cairn-substrate.wallet" && list[0]!.provider === prov);

  // a non-Cairn announce (isCairn=false) is ignored
  const et2 = installWindow(undefined);
  et2.addEventListener("csd:requestProvider", () => et2.dispatchEvent(new CustomEvent("csd:announceProvider", { detail: { info: { uuid: "x", name: "Other", icon: "", rdns: "com.other" }, provider: { isCairn: false } } })));
  const list2 = await discoverProviders({ timeoutMs: 80 });
  ok("discoverProviders ignores non-Cairn announces", list2.length === 0);
}

console.log("=== connector: method wrappers + error mapping ===");
{
  const w = new WalletConnection(mockProvider());
  ok("connect() returns the address", (await w.connect()) === "0xabc");
  ok("address getter is populated after connect", w.address === "0xabc");
  ok("version getter reflects the provider", w.version === "0.2.7");
  const r = await w.send({ to: "0xdead", amount: 1 });
  ok("send() unwraps the txid", r.txid === "0xtx");

  const rejW = new WalletConnection(mockProvider({ send: () => Promise.resolve({ ok: false, error: "rejected by user" }) }));
  await okThrows("'rejected by user' → UserRejectedError", () => rejW.send({ to: "0x", amount: 1 }), UserRejectedError);

  const lockW = new WalletConnection(mockProvider({ propose: () => Promise.resolve({ ok: false, error: "wallet locked" }) }));
  await okThrows("'wallet locked' → WalletLockedError", () => lockW.propose({ domain: "d", payloadHash: "0x", uri: "u", expiresEpoch: 1, fee: 1 }), WalletLockedError);

  const unsupW = new WalletConnection(mockProvider({ attest: () => Promise.resolve({ ok: false, error: "unsupported dApp method: attest" }) }));
  await okThrows("'unsupported dApp method' → UnsupportedMethodError", () => unsupW.attest({ proposalId: "p", score: 1, confidence: 1, fee: 1 }), UnsupportedMethodError);

  await okThrows("revealClaim('') rejects", () => new WalletConnection(mockProvider()).revealClaim(""), UnsupportedMethodError);
}

console.log("=== propose: outputs and an omitted fee reach the wallet as given ===");
{
  const seen: unknown[] = [];
  const w = new WalletConnection(mockProvider({ propose: (p) => { seen.push(p); return Promise.resolve({ ok: true, result: { ok: true, txid: "0xtx" } }); } }));
  const params = { domain: "cairnx:v1", payloadHash: `0x${"ab".repeat(32)}`, uri: "cairnx:transfer", expiresEpoch: 10, outputs: [{ to: `0x${"cd".repeat(20)}`, value: 5 }] };
  const r = await w.propose(params);
  ok("propose with outputs and no fee resolves the txid", r.txid === "0xtx");
  ok("the provider receives the params unchanged: outputs kept, no fee added", seen.length === 1 && JSON.stringify(seen[0]) === JSON.stringify(params) && !("fee" in (seen[0] as object)));
  await w.propose({ domain: "d", payloadHash: `0x${"ab".repeat(32)}`, uri: "u", expiresEpoch: 1, fee: 25_000_000 });
  ok("honest: an explicit fee still passes through", (seen[1] as { fee?: number }).fee === 25_000_000);
}

console.log("=== signInWithCsd: a nonce shape the wallet refuses after approval is refused before the request ===");
{
  let asked = 0;
  const w = new WalletConnection(mockProvider({ signInWithCsd: (p) => { asked++; return Promise.resolve({ ok: true, result: { account: "0xabc", pub33: "0xpub", sig64: "0xsig", message: `m ${p.nonce}`, chainId: "csd:x" } }); } }));
  const verdict = async (nonce: string): Promise<boolean> => {
    const before = asked;
    try { await w.signInWithCsd({ nonce }); return asked === before + 1; } catch (e) {
      if (!(e instanceof UnsupportedMethodError) || asked !== before) throw e;
      return false;
    }
  };
  const uuid = "3f2b8c1e-9d4a-4f6b-8e2a-1c5d7e9f0a3b";
  ok("a UUID nonce rejects with UnsupportedMethodError and the wallet is not asked", (await verdict(uuid)) === false);
  const honest = generateNonce();
  ok("honest: a generateNonce() value reaches the wallet and resolves", (await verdict(honest)) === true);
  // Parity with csd-siwc buildSiwcMessage, whose rule the wallet applies after approval.
  const siwcAccepts = (nonce: string): boolean => {
    try {
      buildSiwcMessage({ domain: "casino.example", account: `0x${"ab".repeat(20)}`, uri: "https://casino.example/", version: SIWC_VERSION, chainId: CSD_CHAIN_MAINNET, nonce, issuedAt: "2026-11-14T00:00:00Z" });
      return true;
    } catch { return false; }
  };
  const corpus = [honest, uuid, "abc123def456", "a".repeat(8), "a".repeat(7), "ABCDEFGH12", "abcd efgh", "abcdefg\u00e9", "abcdefgh\n",
    "\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff18", "abcdefgh!", "abc_defgh", "abc.defgh", ""];
  const mismatched: string[] = [];
  for (const n of corpus) if ((await verdict(n)) !== siwcAccepts(n)) mismatched.push(JSON.stringify(n));
  ok(`the SDK accepts exactly the nonces csd-siwc buildSiwcMessage accepts (${corpus.length} cases)`, mismatched.length === 0 && corpus.some(siwcAccepts) && !corpus.every(siwcAccepts));
  if (mismatched.length) console.log(`      differ on ${mismatched.join(", ")}`);
}

console.log("=== connector: SIWC + fillOffer + capability detection ===");
{
  const w = new WalletConnection(mockProvider());
  const s = await w.signInWithCsd({ nonce: "abc123def456", statement: "Sign in" });
  ok("signInWithCsd unwraps the signed artifact", s.account === "0xabc" && s.sig64 === "0xsig" && typeof s.message === "string" && s.chainId.startsWith("csd:"));
  ok("supportsSiwc is true when the provider exposes it", w.supportsSiwc === true);
  await okThrows("signInWithCsd without a nonce rejects", () => w.signInWithCsd({} as any), UnsupportedMethodError);

  const fr = await w.fillOffer({ proposalId: "0xp", outputs: [{ to: "0xq", value: 10 }] });
  ok("fillOffer unwraps the txid", fr.txid === "0xfill");

  // F13: the fillOffer/FillParams docs must NOT make an unqualified atomic/DvP PAYMENT-SAFETY claim (the SDK
  // does not SPV-verify the payment recipient; it is resolver-trusted). Source-scan guard so a future edit
  // cannot silently re-introduce the over-claim OR weaken the "MUST verify" instruction back to a soft
  // "should". Anchored to EACH docstring block (the FillParams interface block and the method block) so a
  // caveat surviving only in one place cannot pass. Mutation-sensitive: reverting either docstring fails this.
  {
    const src = readFileSync(new URL("../src/connect.ts", import.meta.url), "utf8");
    // the FillParams interface docstring: the `/** ... */` block immediately above `export interface FillParams`
    const ifaceAt = src.indexOf("export interface FillParams");
    const ifaceDoc = src.slice(src.lastIndexOf("/**", ifaceAt), ifaceAt);
    // the method docstring: the `/** ... */` block immediately above `fillOffer(params: FillParams)`
    const methAt = src.indexOf("fillOffer(params: FillParams)");
    const methDoc = src.slice(src.lastIndexOf("/**", methAt), methAt);
    ok("F13: FillParams docstring carries the RESOLVER-TRUSTED payment caveat", /RESOLVER-TRUSTED/.test(ifaceDoc));
    ok("F13: FillParams docstring MANDATES (MUST) an on-chain offer proof, not a soft 'should'", /MUST merkle-prove/.test(ifaceDoc));
    ok("F13: fillOffer method docstring carries the RESOLVER-TRUSTED payment caveat", /RESOLVER-TRUSTED/.test(methDoc));
    ok("F13: fillOffer method docstring MANDATES (MUST) corroborating the offer on-chain", /MUST corroborate/.test(methDoc));
    ok("F13: no unqualified 'atomic DvP' payment-safety claim survives", !/Atomic fill \(CairnX DvP\): pay \+ attest in ONE tx\. Always prompts/.test(src));
  }

  const caps = await w.getCapabilities();
  ok("getCapabilities returns the wallet caps", !!caps && caps.siwc === "1");

  // an older wallet that predates SIWC / getCapabilities
  const old = mockProvider(); delete (old as any).signInWithCsd; delete (old as any).getCapabilities;
  const wo = new WalletConnection(old);
  ok("supportsSiwc is false on an old wallet", wo.supportsSiwc === false);
  await okThrows("signInWithCsd on an old wallet rejects (UnsupportedMethod)", () => wo.signInWithCsd({ nonce: "abc123def456" }), UnsupportedMethodError);
  ok("getCapabilities returns null on an old wallet", (await wo.getCapabilities()) === null);

  const rej = new WalletConnection(mockProvider({ signInWithCsd: () => Promise.resolve({ ok: false, error: "rejected by user" }) }));
  await okThrows("SIWC 'rejected by user' → UserRejectedError", () => rej.signInWithCsd({ nonce: "abc123def456" }), UserRejectedError);
}

console.log("=== connector: permissions (EIP-2255-style) + events ===");
{
  const w = new WalletConnection(mockProvider());
  ok("getPermissions returns this origin's grant", (await w.getPermissions())[0]?.invoker === "casino.example");
  ok("requestPermissions returns the grant", (await w.requestPermissions())[0]?.accounts[0] === "0xabc");
  ok("revokePermissions returns { revoked:true }", (await w.revokePermissions()).revoked === true);

  // events: on() delegates + fires; off() unsubscribes
  let got: any = "none";
  const h = (d: any) => { got = d; };
  w.on("accountsChanged", h);
  (w.provider as any)._emit("accountsChanged", []);
  ok("on('accountsChanged') fires with [] (lost-access signal)", Array.isArray(got) && got.length === 0);
  w.off("accountsChanged", h);
  got = "none";
  (w.provider as any)._emit("accountsChanged", ["0xnew"]);
  ok("off() unsubscribes (handler no longer fires)", got === "none");

  // older wallet without permissions/events → graceful degradation, never throws on read/no-op
  const old: any = mockProvider();
  delete old.getPermissions; delete old.requestPermissions; delete old.revokePermissions; delete old.on; delete old.removeListener;
  const wo = new WalletConnection(old);
  ok("getPermissions → [] on an old wallet", (await wo.getPermissions()).length === 0);
  ok("revokePermissions → {revoked:false} on an old wallet", (await wo.revokePermissions()).revoked === false);
  await okThrows("requestPermissions throws on an old wallet", () => wo.requestPermissions(), UnsupportedMethodError);
  wo.on("accountsChanged", () => {}); wo.off("accountsChanged", () => {}); // no-op, must not throw
  ok("on/off are safe no-ops on an old wallet", true);
}

console.log("=== connector: F14 nested SubmitResult refusal contract ===");
{
  // Catch and return the thrown error (or null if the call resolved instead of throwing).
  const grab = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try { await fn(); return null; } catch (e) { return e; }
  };

  // (1) A fund-safety refusal nested inside an OUTER-OK reply MUST THROW, not resolve with a phantom txid.
  // Mutation-check: reverting unwrapWrite's throw makes this RESOLVE with { ok:false } (the F14 bug), so the
  // grab() returns null and both asserts below fail.
  const unsafe = new WalletConnection(mockProvider({
    fillOffer: () => Promise.resolve({ ok: true, result: { ok: false, code: "FILL_UNSAFE", error: "fill fund-safety preflight refused" } }),
  }));
  const fe = await grab(() => unsafe.fillOffer({ proposalId: "0xp", outputs: [{ to: "0xq", value: 10 }] }));
  ok("F14: fillOffer FILL_UNSAFE THROWS (does not resolve with a phantom txid)", fe !== null);
  ok("F14: FILL_UNSAFE throws a CairnError with the code preserved", fe instanceof CairnError && fe.code === "FILL_UNSAFE");
  ok("F14: FILL_UNSAFE is terminal (retryable === false)", fe instanceof CairnError && fe.retryable === false);

  // (2) A TRANSIENT nested refusal throws retryable === true (nothing was signed; safe to retry shortly).
  const unavail = new WalletConnection(mockProvider({
    send: () => Promise.resolve({ ok: true, result: { ok: false, code: "VERIFY_UNAVAILABLE", error: "couldn't verify inputs before signing" } }),
  }));
  const ve = await grab(() => unavail.send({ to: "0xd", amount: 1 }));
  ok("F14: VERIFY_UNAVAILABLE throws retryable === true", ve instanceof CairnError && ve.code === "VERIFY_UNAVAILABLE" && ve.retryable === true);

  // (3) AMBIGUOUS-INFLIGHT: throws a SubmitInFlightError that STILL EXPOSES the txid (reconcilable, not a
  // blind re-broadcast). Dropping the txid here would re-invite the double-broadcast the finding warns of.
  const inflight = new WalletConnection(mockProvider({
    send: () => Promise.resolve({ ok: true, result: { ok: false, code: "SUBMIT_MAYBE_INFLIGHT", txid: "0xmaybe", error: "gateway timeout; tx may be inflight" } }),
  }));
  const ie = await grab(() => inflight.send({ to: "0xd", amount: 1 }));
  ok("F14: SUBMIT_MAYBE_INFLIGHT throws a SubmitInFlightError", ie instanceof SubmitInFlightError);
  ok("F14: SUBMIT_MAYBE_INFLIGHT carries the locally-computed txid to reconcile", ie instanceof SubmitInFlightError && ie.txid === "0xmaybe");
  ok("F14: SUBMIT_MAYBE_INFLIGHT is maybeSent + NOT retryable (reconcile, never blind-retry)", ie instanceof SubmitInFlightError && ie.maybeSent === true && ie.retryable === false);

  const dup = new WalletConnection(mockProvider({
    send: () => Promise.resolve({ ok: true, result: { ok: false, code: "SUBMIT_DUPLICATE", txid: "0xdup", error: "already present or mempool conflict" } }),
  }));
  const de = await grab(() => dup.send({ to: "0xd", amount: 1 }));
  ok("F14: SUBMIT_DUPLICATE is a SubmitInFlightError carrying the txid", de instanceof SubmitInFlightError && de.code === "SUBMIT_DUPLICATE" && de.txid === "0xdup");

  // (4) HONEST SUCCESS still resolves normally with the txid (the throw must not swallow real sends).
  const good = new WalletConnection(mockProvider({
    send: () => Promise.resolve({ ok: true, result: { ok: true, txid: "0xgood" } }),
  }));
  const gr = await good.send({ to: "0xd", amount: 1 });
  ok("F14: an honest success resolves normally with the txid", gr.txid === "0xgood");

  // (5) An OUTER { ok:false } user rejection still throws UserRejectedError (unchanged behavior).
  const rej = new WalletConnection(mockProvider({
    send: () => Promise.resolve({ ok: false, error: "rejected by user", code: "USER_REJECTED" }),
  }));
  await okThrows("F14: an outer user-rejection still throws UserRejectedError", () => rej.send({ to: "0xd", amount: 1 }), UserRejectedError);

  // (6) A codeless nested refusal (pre-0.2.54 wallet) still fails CLOSED: it throws non-retryable rather than
  // resolving with a phantom txid.
  const nocode = new WalletConnection(mockProvider({
    fillOffer: () => Promise.resolve({ ok: true, result: { ok: false, error: "refused, no machine code" } }),
  }));
  const ce = await grab(() => nocode.fillOffer({ proposalId: "0xp", outputs: [{ to: "0xq", value: 1 }] }));
  ok("F14: a codeless nested refusal fails closed (throws, retryable === false)", ce instanceof CairnError && ce.retryable === false);

  // (7) The same nested-refusal guard applies to every write wrapper, not just send/fillOffer.
  const badProp = new WalletConnection(mockProvider({
    propose: () => Promise.resolve({ ok: true, result: { ok: false, code: "BAD_REQUEST", error: "payloadHash failed its shape check" } }),
  }));
  const pe = await grab(() => badProp.propose({ domain: "d", payloadHash: "0x", uri: "u", expiresEpoch: 1, fee: 1 }));
  ok("F14: propose also throws on a nested BAD_REQUEST refusal", pe instanceof CairnError && pe.code === "BAD_REQUEST" && pe.retryable === false);
}

console.log("=== a write the wallet may have submitted: WALLET_UNAVAILABLE and the timeout ===");
{
  const grab = async (fn: () => Promise<unknown>): Promise<unknown> => { try { return await fn(); } catch (e) { return e; } };
  // The content script's answer when its channel to the service worker closed, which can happen after the submit.
  const gone = { ok: false as const, error: "the wallet is unavailable - it may have reloaded; refresh this page to reconnect", code: "WALLET_UNAVAILABLE" };
  const writes: [string, (w: WalletConnection) => Promise<unknown>][] = [
    ["send", (w) => w.send({ to: "0xd", amount: 1 })],
    ["fillOffer", (w) => w.fillOffer({ proposalId: "0xp", outputs: [{ to: "0xq", value: 1 }] })],
    ["propose", (w) => w.propose({ domain: "d", payloadHash: "0x", uri: "u", expiresEpoch: 1, fee: 1 })],
    ["attest", (w) => w.attest({ proposalId: "p", score: 1, confidence: 1, fee: 1 })],
    ["sealClaim", (w) => w.sealClaim({ claim: "c" })],
    ["revealClaim", (w) => w.revealClaim("0xseal")],
  ];
  for (const [name, call] of writes) {
    let calls = 0;
    const w = new WalletConnection(mockProvider({ [name]: () => { calls++; return Promise.resolve(gone); } } as Partial<CairnProvider>));
    // a dApp that retries while `retryable` says so
    let e = await grab(() => call(w));
    while (e instanceof CairnError && e.retryable && calls < 3) e = await grab(() => call(w));
    ok(`${name}: WALLET_UNAVAILABLE is maybe-sent (SubmitInFlightError, retryable false, no txid), so a retrying dApp asks once`,
      e instanceof SubmitInFlightError && e.code === "WALLET_UNAVAILABLE" && e.retryable === false && e.maybeSent === true && e.txid === undefined && calls === 1);
  }
  const nested = new WalletConnection(mockProvider({ send: () => Promise.resolve({ ok: true, result: { ok: false, code: "WALLET_UNAVAILABLE", error: "unavailable" } }) }));
  const ne = await grab(() => nested.send({ to: "0xd", amount: 1 }));
  ok("a nested WALLET_UNAVAILABLE on a write is maybe-sent too", ne instanceof SubmitInFlightError && ne.code === "WALLET_UNAVAILABLE" && ne.retryable === false);
  const early = new WalletConnection(mockProvider({ revealClaim: () => Promise.resolve({ ok: true, result: { ok: false, code: "SEAL_NOT_MINED", error: "the commit is not mined yet" } }) }));
  const se = await grab(() => early.revealClaim("0xseal"));
  ok("revealClaim before the commit mines: SEAL_NOT_MINED is retryable with its code", se instanceof CairnError && se.code === "SEAL_NOT_MINED" && se.retryable === true);
  // honest path: connect and getAddress sign nothing, so the same answer stays a plain retryable refusal
  const reads = new WalletConnection(mockProvider({ connect: () => Promise.resolve(gone), getAddress: () => Promise.resolve(gone) }));
  const ce = await grab(() => reads.connect());
  const ge = await grab(() => reads.getAddress());
  ok("connect and getAddress: WALLET_UNAVAILABLE stays retryable (not maybe-sent)",
    [ce, ge].every((x) => x instanceof CairnError && !(x instanceof SubmitInFlightError) && x.code === "WALLET_UNAVAILABLE" && x.retryable === true));

  // A write still pending when the connection timeout fires may be approved and sent later by the wallet.
  const never = () => new Promise<never>(() => { /* never settles: a wallet that does not answer */ });
  const hung = new WalletConnection(mockProvider({ fillOffer: never }), { timeoutMs: 20 });
  const te = await grab(() => hung.fillOffer({ proposalId: "0xp", outputs: [{ to: "0xq", value: 1 }] }));
  ok("a timed-out write is maybe-sent: SubmitInFlightError code WALLET_TIMEOUT, no txid, retryable false",
    te instanceof SubmitInFlightError && te.code === "WALLET_TIMEOUT" && te.maybeSent === true && te.txid === undefined && te.retryable === false
    && /did not respond to fillOffer/.test(te.shortMessage));
  // Checking the chain alone leaves the old approval window able to send a second payment after a resend.
  ok("the timed-out write tells the user to reject the still-open wallet request before sending again",
    te instanceof SubmitInFlightError && /reject it in the wallet/.test(te.shortMessage) && /before sending it again/.test(te.shortMessage));
  const hungRead = new WalletConnection(mockProvider({ getAddress: never }), { timeoutMs: 20 });
  const tr = await grab(() => hungRead.getAddress());
  ok("a timed-out getAddress stays a plain non-retryable CairnError (it sends nothing)",
    tr instanceof CairnError && !(tr instanceof SubmitInFlightError) && tr.retryable === false);
}

console.log("=== wallet codes kept on the error: FILL_IN_PROGRESS, WALLET_RELOADED, a code this release does not list ===");
{
  const grab = async (fn: () => Promise<unknown>): Promise<unknown> => { try { return await fn(); } catch (e) { return e; } };
  const final = (e: unknown, code: string) => e instanceof CairnError && !(e instanceof SubmitInFlightError) && e.code === code && e.retryable === false;
  // wallet 0.3.2 background.ts queueDappRequest: refused on arrival, nothing queued or signed
  const held = { ok: false as const, code: "FILL_IN_PROGRESS", error: "A payment request for this offer is already in your wallet, waiting for your answer or being sent." };
  const fe = await grab(() => new WalletConnection(mockProvider({ fillOffer: () => Promise.resolve(held) })).fillOffer({ proposalId: "0xp", outputs: [{ to: "0xq", value: 1 }] }));
  ok("fillOffer: FILL_IN_PROGRESS keeps its code, final, not maybe-sent", final(fe, "FILL_IN_PROGRESS"));
  const ae = await grab(() => new WalletConnection(mockProvider({ attest: () => Promise.resolve(held) })).attest({ proposalId: "0xp", score: 1, confidence: 1_000_000, fee: 1 }));
  ok("attest at the token-fill confidence: FILL_IN_PROGRESS keeps its code", final(ae, "FILL_IN_PROGRESS"));
  // wallet content.ts: sendMessage threw (extension context invalidated), so the request never left the page
  const reloaded = { ok: false as const, error: "WALLET_RELOADED: the wallet extension was updated or reloaded - refresh this page to reconnect" };
  const se = await grab(() => new WalletConnection(mockProvider({ send: () => Promise.resolve(reloaded) })).send({ to: "0xd", amount: 1 }));
  ok("send: the code-less WALLET_RELOADED: reply gets code WALLET_RELOADED, final, not maybe-sent", final(se, "WALLET_RELOADED"));
  const ce = await grab(() => new WalletConnection(mockProvider({ connect: () => Promise.resolve(reloaded) })).connect());
  ok("connect: the WALLET_RELOADED: reply gets code WALLET_RELOADED", final(ce, "WALLET_RELOADED"));
  // wallet 0.3.3 sends the same reply with the code; both shapes map to the one code
  const reloadedCoded = { ...reloaded, code: "WALLET_RELOADED" };
  const sc = await grab(() => new WalletConnection(mockProvider({ send: () => Promise.resolve(reloadedCoded) })).send({ to: "0xd", amount: 1 }));
  ok("send: the coded WALLET_RELOADED reply (wallet 0.3.3) keeps code WALLET_RELOADED, final, not maybe-sent", final(sc, "WALLET_RELOADED"));
  const cc = await grab(() => new WalletConnection(mockProvider({ connect: () => Promise.resolve(reloadedCoded) })).connect());
  ok("connect: the coded WALLET_RELOADED reply keeps code WALLET_RELOADED", final(cc, "WALLET_RELOADED"));
  const later = { ok: false as const, code: "SOME_CODE_FROM_A_LATER_WALLET", error: "a refusal this SDK release does not know" };
  const le = await grab(() => new WalletConnection(mockProvider({ send: () => Promise.resolve(later) })).send({ to: "0xd", amount: 1 }));
  ok("an outer code this release does not list is kept as sent, final", final(le, "SOME_CODE_FROM_A_LATER_WALLET") && (le as CairnError).shortMessage === later.error);
  const ne = await grab(() => new WalletConnection(mockProvider({ send: () => Promise.resolve({ ok: true, result: { ...later, ok: false } }) })).send({ to: "0xd", amount: 1 }));
  ok("a nested code this release does not list is kept as sent, final", final(ne, "SOME_CODE_FROM_A_LATER_WALLET"));
  const ge = await grab(() => new WalletConnection(mockProvider({ getAddress: () => Promise.resolve(later) })).getAddress());
  ok("a read: a code this release does not list is kept as sent", final(ge, "SOME_CODE_FROM_A_LATER_WALLET"));
  // A code only the SDK assigns keeps its documented meaning: WALLET_TIMEOUT is always a maybe-sent SubmitInFlightError.
  const fake = await grab(() => new WalletConnection(mockProvider({ send: () => Promise.resolve({ ok: false, code: "WALLET_TIMEOUT", error: "x" }) })).send({ to: "0xd", amount: 1 }));
  ok("a provider reply naming an SDK-only code is not kept (UNKNOWN)", fake instanceof CairnError && fake.code === "UNKNOWN");
  // honest path: a known code and the code-less legacy strings map as before
  const re = await grab(() => new WalletConnection(mockProvider({ send: () => Promise.resolve({ ok: false, code: "USER_REJECTED", error: "rejected by user" }) })).send({ to: "0xd", amount: 1 }));
  ok("honest: USER_REJECTED still throws UserRejectedError", re instanceof UserRejectedError);
  const le2 = await grab(() => new WalletConnection(mockProvider({ send: () => Promise.resolve({ ok: false, error: "wallet locked" }) })).send({ to: "0xd", amount: 1 }));
  ok("honest: a code-less 'wallet locked' still throws WalletLockedError", le2 instanceof WalletLockedError);
}

console.log("=== B7c: per-call provider timeout ===");
{
  installWindow();
  const grab = async (fn: () => Promise<unknown>): Promise<unknown> => { try { return await fn(); } catch (e) { return e; } };

  // a fast provider resolves normally even with a tiny timeout (no false rejection of a prompt answer)
  const fast = new WalletConnection(mockProvider(), { timeoutMs: 5000 });
  ok("a fast provider resolves before the timeout", (await fast.send({ to: "0xd", amount: 1 })).txid === "0xtx");

  // a hung write REJECTS with a fail-closed CairnError (retryable:false) once the (short, test-set) timeout fires
  const hung = new WalletConnection(mockProvider({ send: () => new Promise(() => {}) }), { timeoutMs: 20 });
  const te = await grab(() => hung.send({ to: "0xd", amount: 1 }));
  ok("a hung write times out with a fail-closed CairnError (retryable === false, never a blind auto-retry)",
    te instanceof CairnError && te.retryable === false && /did not respond to send/.test((te as CairnError).shortMessage));

  // the timeout is GENEROUS by default (it must never reject an in-flight human approval): a call that
  // resolves after a human-paced delay still succeeds under the default (10-minute) budget
  const slowish = new WalletConnection(mockProvider({ fillOffer: () => new Promise((r) => setTimeout(() => r({ ok: true, result: { ok: true, txid: "0xfill" } }), 40)) }));
  ok("the default (generous) timeout does not reject a normal, human-paced approval",
    (await slowish.fillOffer({ proposalId: "0xp", outputs: [{ to: "0xq", value: 1 }] })).txid === "0xfill");
}

console.log("=== P75-5 MF-10: fill capability advisory (WARN, NEVER BLOCK) ===");
{
  const grab = async (fn: () => Promise<unknown>): Promise<unknown> => { try { return await fn(); } catch (e) { return e; } };
  const grabWarns = () => {
    const seen: string[] = []; const orig = console.warn;
    console.warn = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
    return { seen, restore: () => { console.warn = orig; } };
  };

  // PERMANENT TRIPWIRE: the resolve half of this first assertion must outlive every future hardening
  // pass. A wallet-version HARD GATE in fillOffer is explicitly declined; this reds if one appears.
  const w59 = new WalletConnection(mockProvider({ version: "0.2.59" }));
  const g = grabWarns();
  let r1: unknown, r2: unknown;
  try {
    r1 = await grab(() => w59.fillOffer({ proposalId: "0xp", outputs: [{ to: "0xq", value: 10 }] }));
    r2 = await grab(() => w59.fillOffer({ proposalId: "0xp", outputs: [{ to: "0xq", value: 10 }] }));
  } finally { g.restore(); }
  ok("MF-10 TRIPWIRE: a 0.2.59 wallet's fill STILL RESOLVES with the txid (WARN, NEVER BLOCK)",
    (r1 as { txid?: string })?.txid === "0xfill" && (r2 as { txid?: string })?.txid === "0xfill");
  ok("MF-10: the 0.2.59 advisory fired exactly ONCE across two fills on one connection",
    g.seen.filter((s) => /fill-SPV/.test(s)).length === 1);

  const w64 = new WalletConnection(mockProvider({ version: "0.2.64" }));
  const g2 = grabWarns();
  let r3: unknown;
  try { r3 = await grab(() => w64.fillOffer({ proposalId: "0xp", outputs: [{ to: "0xq", value: 10 }] })); } finally { g2.restore(); }
  ok("MF-10 happy: a 0.2.64 wallet fills with NO advisory", (r3 as { txid?: string })?.txid === "0xfill" && g2.seen.length === 0);

  const wg = new WalletConnection(mockProvider({ version: "lolwut" }));
  const g3 = grabWarns();
  let r4: unknown;
  try { r4 = await grab(() => wg.fillOffer({ proposalId: "0xp", outputs: [{ to: "0xq", value: 10 }] })); } finally { g3.restore(); }
  ok("MF-10 happy: a garbage version fills with NO advisory and still resolves", (r4 as { txid?: string })?.txid === "0xfill" && g3.seen.length === 0);
}

clearWindow();
console.log(`\nconnect.test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
