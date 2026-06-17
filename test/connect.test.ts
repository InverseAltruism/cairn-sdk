// Connector tests — provider detection + typed error mapping. Runs under tsx in Node;
// we stub a minimal `window` backed by a real EventTarget.
import {
  WalletConnection,
  detectProvider,
  discoverProviders,
  isInstalled,
  NotInstalledError,
  UserRejectedError,
  WalletLockedError,
  UnsupportedMethodError,
} from "../src/index.js";
import type { CairnProvider, ProviderReply } from "../src/connect.js";

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
  const pending = detectProvider({ timeoutMs: 500 });
  setTimeout(() => { (globalThis as any).window.cairn = mockProvider(); et.dispatchEvent(new Event("cairn#initialized")); }, 20);
  const p2 = await pending;
  ok("detectProvider resolves after cairn#initialized fires", p2.isCairn === true);

  installWindow(undefined);
  await okThrows("detectProvider times out → NotInstalled", () => detectProvider({ timeoutMs: 60 }), NotInstalledError);
}

console.log("=== connector: EIP-6963-style discovery ===");
{
  // No window.cairn global — the wallet announces only when asked (csd:requestProvider).
  const et = installWindow(undefined);
  const prov = mockProvider();
  const announce = () => et.dispatchEvent(new CustomEvent("csd:announceProvider", { detail: { info: { uuid: "u1", name: "Cairn Wallet", icon: "data:,", rdns: "com.cairn-substrate.wallet" }, provider: prov } }));
  et.addEventListener("csd:requestProvider", announce);
  const p = await detectProvider({ timeoutMs: 300 });
  ok("detectProvider resolves via csd:announceProvider (no global)", p === prov);
  const list = await discoverProviders({ timeoutMs: 80 });
  ok("discoverProviders enumerates announced wallets", list.length === 1 && list[0].info.rdns === "com.cairn-substrate.wallet" && list[0].provider === prov);

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

console.log("=== connector: SIWC + fillOffer + capability detection ===");
{
  const w = new WalletConnection(mockProvider());
  const s = await w.signInWithCsd({ nonce: "abc123def456", statement: "Sign in" });
  ok("signInWithCsd unwraps the signed artifact", s.account === "0xabc" && s.sig64 === "0xsig" && typeof s.message === "string" && s.chainId.startsWith("csd:"));
  ok("supportsSiwc is true when the provider exposes it", w.supportsSiwc === true);
  await okThrows("signInWithCsd without a nonce rejects", () => w.signInWithCsd({} as any), UnsupportedMethodError);

  const fr = await w.fillOffer({ proposalId: "0xp", outputs: [{ to: "0xq", value: 10 }] });
  ok("fillOffer unwraps the txid", fr.txid === "0xfill");

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

clearWindow();
console.log(`\nconnect.test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
