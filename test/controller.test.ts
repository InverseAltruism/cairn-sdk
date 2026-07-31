// CairnController tests (Phase 3 DX): the framework-agnostic reactive store. All the connection logic
// lives here (the React/Vue/etc. adapters are thin), so this is where it's exercised.
import { CairnController } from "../src/controller.js";
import { WalletConnection } from "../src/connect.js";

declare const process: { exit(code: number): void };
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };
const okThrows = async (n: string, fn: () => Promise<unknown>) => { try { await fn(); ok(n, false); } catch { ok(n, true); } };

function mockProvider(addr = "0xabc"): any {
  const events: Record<string, ((d: any) => void)[]> = {};
  const reply = (r: any) => Promise.resolve(r);
  return {
    isCairn: true, version: "0.2.24",
    connect: () => reply({ ok: true, result: { addr } }),
    getAddress: () => reply({ ok: true, result: { addr } }),
    signInWithCsd: () => reply({ ok: true, result: { account: addr, pub33: "0xp", sig64: "0xs", message: "m", chainId: "csd:x" } }),
    revokePermissions: () => reply({ ok: true, result: { revoked: true } }),
    on(ev: string, h: (d: any) => void) { (events[ev] ||= []).push(h); },
    removeListener(ev: string, h: (d: any) => void) { if (events[ev]) events[ev] = events[ev].filter((x) => x !== h); },
    _emit(ev: string, d: any) { (events[ev] || []).forEach((h) => h(d)); },
  };
}
const over = (prov: any) => new CairnController({ getWallet: async () => new WalletConnection(prov) });

async function main() {
  const prov = mockProvider();
  const c = over(prov);
  let notifies = 0; const unsub = c.subscribe(() => notifies++);

  ok("initial snapshot is disconnected", c.getSnapshot().status === "disconnected" && c.getSnapshot().account === null);
  const snap1 = c.getSnapshot();
  ok("getSnapshot is a stable reference when unchanged", c.getSnapshot() === snap1);

  const addr = await c.connect();
  ok("connect() resolves the address", addr === "0xabc");
  ok("state → connected + account set", c.getSnapshot().status === "connected" && c.getSnapshot().account === "0xabc");
  ok("subscribers were notified on connect", notifies > 0);

  // CONNECT-1/CTRL-ADOPT-1: a matching accountsChanged is tracked; a DIFFERENT (forged) one is NEVER adopted.
  prov._emit("accountsChanged", ["0xABC"]); // same addr (case-insensitive) → stays connected
  ok("accountsChanged([same]) → stays connected (matching addr tracked)", c.getSnapshot().status === "connected" && c.getSnapshot().account === "0xABC");
  prov._emit("accountsChanged", ["0xattacker"]); // mismatched → MUST NOT silently adopt
  ok("accountsChanged([different]) → disconnected (never silently adopts a forged addr)", c.getSnapshot().status === "disconnected" && c.getSnapshot().account === null);
  await c.connect();
  prov._emit("accountsChanged", []);
  ok("accountsChanged([]) → disconnected (F11)", c.getSnapshot().status === "disconnected" && c.getSnapshot().account === null);
  await c.connect();
  prov._emit("disconnect", null);
  ok("disconnect event → disconnected", c.getSnapshot().status === "disconnected");

  const snapA = c.getSnapshot();
  prov._emit("disconnect", null); // already disconnected → no state change
  ok("a no-op state change keeps the SAME snapshot ref (no useSyncExternalStore loop)", c.getSnapshot() === snapA);

  const c2 = over(mockProvider());
  await okThrows("signInWithCsd before connect() rejects", () => c2.signInWithCsd({ nonce: "abc123def456" }));
  await c2.connect();
  const r = await c2.signInWithCsd({ nonce: "abc123def456" });
  ok("signInWithCsd after connect returns the artifact", (r as any).account === "0xabc" && typeof (r as any).message === "string");

  let revoked = false;
  const p3 = mockProvider(); p3.revokePermissions = () => { revoked = true; return Promise.resolve({ ok: true, result: { revoked: true } }); };
  const c3 = over(p3); await c3.connect(); await c3.disconnect();
  ok("disconnect() revokes the wallet permission AND clears local state", revoked === true && c3.getSnapshot().status === "disconnected");
  // ghost-reconnect: after disconnect, a (possibly forged) accountsChanged must NOT resurrect the session.
  p3._emit("accountsChanged", ["0xabc"]);
  ok("post-disconnect accountsChanged does NOT ghost-reconnect (listeners detached)", c3.getSnapshot().status === "disconnected");
  ok("disconnect() nulls the connection", c3.connection === null);

  const before = notifies; unsub(); prov._emit("accountsChanged", ["0xz"]);
  ok("unsubscribe() stops notifications", notifies === before);

  const bad = mockProvider(); bad.connect = () => Promise.resolve({ ok: false, error: "rejected by user" });
  const c4 = over(bad);
  await okThrows("a rejected connect propagates the error", () => c4.connect());
  ok("after a failed connect: disconnected + error captured", c4.getSnapshot().status === "disconnected" && !!c4.getSnapshot().error);

  // ===== P75-5 MF-15: connect/disconnect epoch guard + promise contract =====
  const overT = (prov: any, timeoutMs: number) => new CairnController({ getWallet: async () => new WalletConnection(prov, { timeoutMs }) });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // E1 (zombie resurrect): a connect() whose APPROVAL await straddled a disconnect() must NOT commit
  // "connected" over the torn-down session. Pre-fix the pending connect resolves and writes a zombie
  // connected/null-connection state.
  {
    const prov: any = mockProvider();
    let resolveConnect!: (r: any) => void;
    prov.connect = () => new Promise((res) => { resolveConnect = res; });
    const c = overT(prov, 0);
    let rejected = false;
    const p = c.connect();
    p.then(() => {}, () => { rejected = true; });          // attach early so the rejection is never "unhandled"
    await tick();                                          // let connect() reach the approval await (this.conn set)
    await c.disconnect();
    resolveConnect({ ok: true, result: { addr: "0xabc" } }); // approval lands AFTER the teardown
    await tick();
    ok("MF-15 E1: a connect() that straddled disconnect() REJECTS (no zombie resurrect)", rejected === true);
    ok("MF-15 E1: the clean disconnected state stands (no error smeared, connection null)",
      c.getSnapshot().status === "disconnected" && c.getSnapshot().account === null && c.connection === null);
  }

  // E2 (immediate local teardown): a hung revokePermissions() must not hold the session "connected".
  {
    const prov: any = mockProvider();
    prov.revokePermissions = () => new Promise(() => {});   // never resolves
    const c = overT(prov, 0);
    await c.connect();
    const dp = c.disconnect();                              // do NOT await
    ok("MF-15 E2: local teardown is IMMEDIATE (disconnected + connection null before revoke settles)",
      c.getSnapshot().status === "disconnected" && c.connection === null);
    void dp;
  }

  // E3 (signInWithCsd gate): a FAILED connect() leaves conn non-null, but signing must NOT proceed on it.
  {
    const prov: any = mockProvider();
    prov.connect = () => Promise.resolve({ ok: false, error: "rejected by user" });
    const c = overT(prov, 0);
    await okThrows("MF-15 E3: the failed connect propagates", () => c.connect());
    await okThrows("MF-15 E3: signInWithCsd after a FAILED connect REJECTS (gates on status, not just conn)",
      () => c.signInWithCsd({ nonce: "abc123def456" }));
  }

  // E4 (call() sync-throw): a synchronously-throwing provider must REJECT, never escape as a sync throw.
  {
    const sprov: any = { isCairn: true, version: "0.2.24", send: () => { throw new Error("boom"); } };
    const w = new WalletConnection(sprov);
    let sync = true; let p: any;
    try { p = w.send({ to: "0xq", amount: 1 }); sync = false; } catch { /* pre-fix: escapes here */ }
    ok("MF-15 E4: send() on a sync-throwing provider returns a promise (no sync throw escapes call())", sync === false);
    await okThrows("MF-15 E4: that promise REJECTS", () => p);
  }

  // E0b (happy): reconnect after a completed disconnect still resolves + reaches connected.
  {
    const c = over(mockProvider());
    await c.connect(); await c.disconnect();
    const addr = await c.connect();
    ok("MF-15 E0b happy: reconnect after a completed disconnect resolves + reaches connected",
      addr === "0xabc" && c.getSnapshot().status === "connected" && c.connection !== null);
  }

  // E0c (happy): the invoke() wrapper adds no behavior change on the honest send path.
  {
    const gprov: any = mockProvider();
    gprov.send = () => Promise.resolve({ ok: true, result: { ok: true, txid: "0xSEND" } });
    const w = new WalletConnection(gprov);
    ok("MF-15 E0c happy: w.send() on a normal provider still resolves the txid", (await w.send({ to: "0xd", amount: 1 })).txid === "0xSEND");
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
