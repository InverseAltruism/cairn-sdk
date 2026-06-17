// React adapter tests (Phase 3 DX): the factory needs NO real react — we pass a mock React whose
// useSyncExternalStore reads the snapshot synchronously, and assert the hooks reflect controller state.
import { createCairnHooks, CairnController } from "../src/react.js";
import { WalletConnection } from "../src/connect.js";

declare const process: { exit(code: number): void };
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

// Mock React: useSyncExternalStore just returns the current snapshot (enough to test the binding).
const React = { useSyncExternalStore: <T>(_sub: any, getSnap: () => T) => getSnap() };

function mockProvider(addr = "0xabc"): any {
  const ev: Record<string, ((d: any) => void)[]> = {}; const reply = (r: any) => Promise.resolve(r);
  return {
    isCairn: true, version: "x",
    connect: () => reply({ ok: true, result: { addr } }),
    on(e: string, h: (d: any) => void) { (ev[e] ||= []).push(h); },
    removeListener() {},
    signInWithCsd: () => reply({ ok: true, result: { account: addr, pub33: "p", sig64: "s", message: "m", chainId: "c" } }),
    revokePermissions: () => reply({ ok: true, result: { revoked: true } }),
    _emit(e: string, d: any) { (ev[e] || []).forEach((h) => h(d)); },
  };
}

async function main() {
  const controller = new CairnController({ getWallet: async () => new WalletConnection(mockProvider()) });
  const { useCairnAccount, useCairn, useCairnState } = createCairnHooks(React as any, controller);

  ok("useCairnState reflects disconnected initially", useCairnState().status === "disconnected");
  ok("useCairnAccount is null initially", useCairnAccount() === null);

  await controller.connect();
  ok("useCairnAccount reflects the connected account", useCairnAccount() === "0xabc");
  ok("useCairnState reflects connected status", useCairnState().status === "connected");

  const h = useCairn();
  ok("useCairn exposes state + bound actions", h.account === "0xabc" && typeof h.connect === "function" && typeof h.disconnect === "function" && typeof h.signInWithCsd === "function");

  // factory without an explicit controller (creates one from opts)
  const hooks2 = createCairnHooks(React as any, { timeoutMs: 500 });
  ok("createCairnHooks(React, opts) builds its own controller", hooks2.controller instanceof CairnController && hooks2.useCairnAccount() === null);

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
