// The `/testing` subpath: mockCairnProvider's scripted answers, recorded calls and events, and installMockCairn's
// discovery handshake on a fake window. Offline; no global window is set unless a case sets one.
import { CSD_CHAIN_MAINNET } from "@inversealtruism/csd-siwc";
import { CairnError, SubmitInFlightError, UserRejectedError, WalletConnection, detectProvider, discoverProviders } from "../src/index.js";
import { installMockCairn, mockCairnProvider } from "../src/testing.js";
import { WALLET_CAPABILITY_METHODS } from "./types/wallet-params.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}`); };
const grab = async (fn: () => Promise<unknown>): Promise<unknown> => { try { return await fn(); } catch (e) { return e; } };
const fakeWindow = () => {
  const et = new EventTarget();
  return {
    addEventListener: et.addEventListener.bind(et),
    removeEventListener: et.removeEventListener.bind(et),
    dispatchEvent: et.dispatchEvent.bind(et),
  } as { cairn?: unknown; addEventListener: EventTarget["addEventListener"]; removeEventListener: EventTarget["removeEventListener"]; dispatchEvent: EventTarget["dispatchEvent"] };
};

console.log("=== the mock's methods are the wallet's ===");
{
  const mock = mockCairnProvider();
  const caps = await mock.getCapabilities();
  ok("getCapabilities().methods equals the wallet's list (test/types/wallet-params.ts)",
    JSON.stringify([...caps.methods].sort()) === JSON.stringify([...WALLET_CAPABILITY_METHODS].sort()));
  ok("every advertised method is a function on the mock", caps.methods.every((m) => typeof (mock as unknown as Record<string, unknown>)[m] === "function"));
  ok("getCapabilities carries the wallet's fixed fields", caps.siwc === "1" && caps.discovery === "csd" && JSON.stringify(caps.events) === '["accountsChanged","disconnect"]');
  const s = await mock.signInWithCsd({ nonce: "abcdefgh1234" });
  ok("the default sign-in chain id is csd-siwc's mainnet id", s.ok && s.result.chainId === CSD_CHAIN_MAINNET);
}

console.log("=== envelopes and scripted answers ===");
{
  const addr = `0x${"cd".repeat(20)}`;
  const mock = mockCairnProvider({ address: addr });
  const w = new WalletConnection(mock);
  ok("connect answers { ok, result: { addr } } with the set address", JSON.stringify(await mock.connect()) === JSON.stringify({ ok: true, result: { addr } }));
  const sent = await mock.send({ to: addr, amount: 1 });
  ok("an approved write nests a SubmitResult { ok, txid, sighashMatch }",
    sent.ok && sent.result.ok === true && /^0x[0-9a-f]{64}$/.test(String(sent.result.txid)) && sent.result.sighashMatch === true);

  mock.next("propose", { kind: "reject", code: "USER_REJECTED" });
  const pe = await grab(() => w.propose({ domain: "d", payloadHash: `0x${"ab".repeat(32)}`, uri: "u", expiresEpoch: 1 }));
  ok("a scripted reject maps to UserRejectedError with its code", pe instanceof UserRejectedError && pe.code === "USER_REJECTED");
  ok("the scripted answer is used once; the next propose is approved", typeof (await w.propose({ domain: "d", payloadHash: "0x", uri: "u", expiresEpoch: 1 })).txid === "string");

  mock.next("fillOffer", { kind: "refuse", code: "FILL_UNSAFE" });
  const raw = await mock.fillOffer({ proposalId: "0xp", outputs: [] });
  ok("a scripted refusal is outer-ok with the nested { ok:false, code, sighashMatch:false }",
    raw.ok && raw.result.ok === false && raw.result.code === "FILL_UNSAFE" && raw.result.sighashMatch === false);
  mock.next("send", { kind: "refuse", code: "SUBMIT_MAYBE_INFLIGHT", txid: "0xmaybe" });
  const ie = await grab(() => w.send({ to: addr, amount: 1 }));
  ok("a nested in-flight refusal keeps its txid through the SDK", ie instanceof SubmitInFlightError && ie.txid === "0xmaybe");

  mock.next("send", { kind: "approve", txid: "0xchosen" });
  ok("a scripted approve answers with the given txid", (await w.send({ to: addr, amount: 1 })).txid === "0xchosen");
  mock.next("connect", { kind: "reply", reply: { ok: false, error: "wallet locked" } });
  ok("a raw reply is sent as given", JSON.stringify(await mock.connect()) === JSON.stringify({ ok: false, error: "wallet locked" }));
  mock.next("attest", { kind: "reject", code: "RATE_LIMITED" });
  mock.next("attest", { kind: "reject", code: "APPROVAL_CLOSED" });
  const a1 = await grab(() => w.attest({ proposalId: "0xp", score: 1, confidence: 1 }));
  const a2 = await grab(() => w.attest({ proposalId: "0xp", score: 1, confidence: 1 }));
  ok("scripted answers queue in order", a1 instanceof CairnError && a1.code === "RATE_LIMITED" && a2 instanceof UserRejectedError);

  const standing = mockCairnProvider({ answers: { sealClaim: { kind: "reject", code: "WALLET_LOCKED" } } });
  const r1 = await standing.sealClaim({ claim: "c" });
  const r2 = await standing.sealClaim({ claim: "c" });
  ok("a standing answer applies to every call", !r1.ok && !r2.ok && r1.code === "WALLET_LOCKED" && r2.code === "WALLET_LOCKED");
}

console.log("=== recorded calls ===");
{
  const mock = mockCairnProvider();
  const params = { to: `0x${"ef".repeat(20)}`, amount: 5 };
  await mock.connect();
  await mock.send(params);
  await mock.revealClaim("0xseal");
  ok("every call is recorded with its method and params, in order",
    JSON.stringify(mock.calls) === JSON.stringify([{ method: "connect" }, { method: "send", params }, { method: "revealClaim", params: "0xseal" }]));
}

console.log("=== consent and events ===");
{
  const mock = mockCairnProvider();
  ok("not connected: getPermissions is []", JSON.stringify(await mock.getPermissions()) === JSON.stringify({ ok: true, result: [] }));
  await mock.connect();
  const g = await mock.getPermissions();
  ok("after connect: getPermissions holds the grant for the address", g.ok && g.result.length === 1 && g.result[0]!.accounts[0] === mock.address);
  const seen: [string, unknown][] = [];
  const onAcc = (d: unknown) => seen.push(["accountsChanged", d]);
  const onDis = (d: unknown) => seen.push(["disconnect", d]);
  mock.on("accountsChanged", onAcc);
  mock.on("disconnect", onDis);
  const bad = () => { throw new Error("a bad handler (expected in this test)"); };
  mock.on("accountsChanged", bad);
  mock.emit("accountsChanged");
  mock.emit("disconnect", "idle-lock");
  ok("emit sends accountsChanged([]) and disconnect({ reason }), past a throwing handler",
    JSON.stringify(seen) === JSON.stringify([["accountsChanged", []], ["disconnect", { reason: "idle-lock" }]]));
  mock.removeListener("accountsChanged", bad);
  seen.length = 0;
  const rv = await mock.revokePermissions();
  ok("revokePermissions answers { revoked: true } and sends both events", rv.ok && rv.result.revoked === true
    && JSON.stringify(seen) === JSON.stringify([["accountsChanged", []], ["disconnect", { reason: "revoked" }]]));
  ok("after revoke: getPermissions is []", JSON.stringify(await mock.getPermissions()) === JSON.stringify({ ok: true, result: [] }));
  mock.removeListener("accountsChanged", onAcc);
  seen.length = 0;
  mock.emit("accountsChanged");
  ok("removeListener removes the same handler", seen.length === 0);
}

console.log("=== installMockCairn: the discovery handshake ===");
{
  ok("the suite runs with no global window", typeof (globalThis as { window?: unknown }).window === "undefined");
  const win = fakeWindow();
  const events: string[] = [];
  let announced: { info: { rdns: string; uuid: string; name: string; icon: string }; provider: unknown } | undefined;
  win.addEventListener("cairn#initialized", () => events.push("cairn#initialized"));
  win.addEventListener("csd:announceProvider", (e) => { events.push("csd:announceProvider"); announced = (e as CustomEvent).detail; });
  const mock = mockCairnProvider();
  const uninstall = installMockCairn(win, mock);
  ok("install sets cairn on the target", win.cairn === mock);
  ok("install dispatches cairn#initialized, then csd:announceProvider", JSON.stringify(events) === '["cairn#initialized","csd:announceProvider"]');
  ok("the announce carries the wallet's rdns and name, the provider and an SVG icon",
    announced?.info.rdns === "com.cairn-substrate.wallet" && announced.info.name === "Cairn Wallet" && announced.provider === mock
    && announced.info.icon.startsWith("data:image/svg+xml") && Object.isFrozen(announced) && Object.isFrozen(announced.info));
  const firstUuid = announced?.info.uuid;
  ok("the uuid is a version 4 UUID", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(firstUuid)));
  win.dispatchEvent(new Event("csd:requestProvider"));
  ok("csd:requestProvider re-announces with the same uuid", events.length === 3 && announced?.info.uuid === firstUuid);
  ok("the global window is untouched", typeof (globalThis as { window?: unknown }).window === "undefined");

  // The SDK's own detection finds it when the target is the page's window.
  (globalThis as { window?: unknown }).window = win;
  try {
    const found = await discoverProviders({ timeoutMs: 30 });
    ok("discoverProviders finds the installed mock", found.length === 1 && found[0]!.provider === mock);
    ok("detectProvider resolves the installed mock", (await detectProvider({ timeoutMs: 100 })) === mock);
  } finally { delete (globalThis as { window?: unknown }).window; }

  uninstall();
  ok("uninstall removes cairn from the target", !("cairn" in win));
  win.dispatchEvent(new Event("csd:requestProvider"));
  ok("after uninstall csd:requestProvider gets no announce", events.length === 4);

  // An http page other than localhost is not a secure context: crypto.randomUUID is absent there.
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
  try {
    const insecure = fakeWindow();
    let uuid: string | undefined;
    insecure.addEventListener("csd:announceProvider", (e) => { uuid = (e as CustomEvent).detail.info.uuid; });
    const undo = installMockCairn(insecure, mockCairnProvider());
    ok("install works without crypto.randomUUID (an insecure context)", insecure.cairn !== undefined && typeof uuid === "string" && uuid.length === 36);
    undo();
  } catch (e) {
    ok(`install works without crypto.randomUUID (threw ${(e as Error).message})`, false);
  } finally { delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID; }
  ok("crypto.randomUUID is restored", typeof globalThis.crypto.randomUUID === "function");

  const keep = fakeWindow();
  const before = mockCairnProvider({ version: "before" });
  keep.cairn = before;
  installMockCairn(keep, mockCairnProvider())();
  ok("uninstall restores a cairn the target already had", keep.cairn === before);
  const real = fakeWindow();
  Object.defineProperty(real, "cairn", { value: before, writable: false, configurable: false });
  const re = await grab(async () => installMockCairn(real, mockCairnProvider()));
  ok("install throws over a non-configurable cairn (an installed wallet) and leaves it", re instanceof Error && /not configurable/.test(re.message) && real.cairn === before);
}

console.log(`\ntesting.test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
