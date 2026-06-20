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

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
