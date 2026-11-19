// Under CommonJS each entry of the built package carries its own copy of the error classes, so an error thrown by a
// Chain taken from /chain is not `instanceof` the root entry's classes; its `code` and `maybeSent` are what a caller
// can branch on. docs/SDK-GUIDE.md says so; this pins it on dist/ (pnpm build first). Offline.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(fileURLToPath(new URL("../package.json", import.meta.url)));
const root = require("./dist/index.cjs");
const chainEntry = require("./dist/chain.cjs");
let pass = 0, fail = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

// A stub RPC: one coin the signer owns, served with its real txid, and a submit answered 502.
const PRIV = "0x" + "44".repeat(32);
const from = chainEntry.addrFromPriv(PRIV).toLowerCase();
const src = { version: 1, locktime: 0, inputs: [{ prev_txid: "0x" + "00".repeat(32), vout: 0xffffffff, script_sig: "0x01020304" }], outputs: [{ value: 10_000_000_000, script_pubkey: from }], app: { type: "None" } };
const id = chainEntry.txid(chainEntry.rpcTxToTx(src)).toLowerCase();
const j = (status, o) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const fetch = async (u) => {
  const url = String(u);
  if (url.includes(`/utxos/${from}`)) return j(200, { utxos: [{ txid: id, vout: 0, value: 10_000_000_000, confirmations: 10 }], confirmed_balance: 10_000_000_000 });
  if (url.endsWith(`/tx/${id}`)) return j(200, { ok: true, height: 100, tx: src });
  if (url.endsWith("/tx/submit")) return j(502, { ok: false, error: "node unreachable" });
  return j(404, {});
};

console.log("CommonJS, /chain's errors against the root entry's classes:");
await ok("a Chain from /chain throws an in-flight error with code and maybeSent, which is not instanceof the root's classes", async () => {
  const chain = new chainEntry.Chain({ rpcUrl: "https://rpc.test/api/rpc", fetch });
  const e = await chain.send({ priv: PRIV, outputs: [{ to: "0x" + "ab".repeat(20), value: 100_000_000 }], fee: 1_000_000 }).then(() => null, (x) => x);
  assert.equal(e?.code, "SUBMIT_MAYBE_INFLIGHT");
  assert.equal(e?.maybeSent, true);
  assert.equal(e instanceof root.SubmitInFlightError, false, "if this turns true, the guide's CommonJS sentence is out of date");
  assert.equal(e instanceof root.CairnError, false);
});
await ok("honest: the root entry's own Chain throws the root's classes", async () => {
  const chain = new root.Chain({ rpcUrl: "https://rpc.test/api/rpc", fetch });
  const e = await chain.send({ priv: PRIV, outputs: [{ to: "0x" + "ab".repeat(20), value: 100_000_000 }], fee: 1_000_000 }).then(() => null, (x) => x);
  assert.ok(e instanceof root.SubmitInFlightError && e.code === "SUBMIT_MAYBE_INFLIGHT");
});

console.log(`\ncjs-chain-errors: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
