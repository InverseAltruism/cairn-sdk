// Chain.send, the SDK's key-backed signer, over a stub node RPC: the input values it signs against are the ones
// the chain commits (a source tx whose txid is the outpoint), the node's verdict reaches `ok`, and a submit
// request that fails after signing keeps the signed txid. Offline.
import { Chain, SubmitInFlightError } from "../src/index.js";
import { addrFromPriv, txid, rpcTxToTx } from "../src/chain.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"} ${n}`); };
const grab = async <T>(fn: () => Promise<T>): Promise<T | unknown> => { try { return await fn(); } catch (e) { return e; } };

const PRIV = "0x" + "44".repeat(32);
const FROM = addrFromPriv(PRIV).toLowerCase();
const TO = "0x" + "ab".repeat(20);
const REAL = 10_000_000_000;   // 100 CSD in the source tx the outpoint commits
const src = { version: 1, locktime: 0, inputs: [{ prev_txid: "0x" + "00".repeat(32), vout: 0xffffffff, script_sig: "0x01020304" }], outputs: [{ value: REAL, script_pubkey: FROM }], app: { type: "None" } };
const SRC_ID = txid(rpcTxToTx(src as unknown as Parameters<typeof rpcTxToTx>[0])).toLowerCase();

// reported: the value the RPC's /utxos claims; submit: what POST /tx/submit answers.
function rpc(reported: number, submit: () => Response) {
  const seen: string[] = [];
  const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes(`/utxos/${FROM}`)) return j({ utxos: [{ txid: SRC_ID, vout: 0, value: reported, confirmations: 10 }], confirmed_balance: reported });
    if (url.endsWith(`/tx/${SRC_ID}`)) return j({ ok: true, height: 100, tx: src });
    if (url.endsWith("/tx/submit")) return submit();
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { chain: new Chain({ rpcUrl: "https://rpc.test/api/rpc", fetch }), seen };
}
const accepted = () => new Response(JSON.stringify({ ok: true, txid: "x" }), { status: 200, headers: { "content-type": "application/json" } });
const send = (chain: Chain) => chain.send({ priv: PRIV, outputs: [{ to: TO, value: 100_000_000 }], fee: 1_000_000 });
const submits = (seen: string[]) => seen.filter((s) => s.startsWith("POST") && s.endsWith("/tx/submit")).length;

console.log("Chain.send:");

{
  const { chain, seen } = rpc(REAL, accepted);
  const r = await send(chain);
  ok("honest: signs, submits once, ok true, change is the real input minus amount and fee", r.ok === true && submits(seen) === 1 && r.change === REAL - 100_000_000 - 1_000_000);
}
{
  // An RPC that under-reports the coin: change comes from the value the source tx commits, so nothing is burned.
  const { chain, seen } = rpc(200_000_000, accepted);
  const r = await send(chain);
  ok("an under-reported coin: change is computed from the committed value (no implicit fee)", r.ok === true && submits(seen) === 1 && r.change === REAL - 100_000_000 - 1_000_000 && r.fee === 1_000_000);
}
{
  // An RPC that over-reports the coin: the committed value cannot cover the send, so nothing is signed.
  const { chain, seen } = rpc(REAL * 10, accepted);
  const big = await chain.send({ priv: PRIV, outputs: [{ to: TO, value: REAL * 5 }], fee: 1_000_000 });
  ok("an over-reported coin: refuses to sign and submits nothing", big.ok === false && !big.txid && submits(seen) === 0);
}
{
  // The node refuses at HTTP 200 with a populated txid: the top-level ok follows the node.
  const { chain } = rpc(REAL, () => new Response(JSON.stringify({ ok: false, err: "fee below floor", txid: "x" }), { status: 200, headers: { "content-type": "application/json" } }));
  const r = await send(chain);
  ok("a node {ok:false} reflects in ok (false) with the node's answer kept", r.ok === false && r.submitResult?.ok === false);
}
{
  // The submit request fails after signing (a proxy 502 can follow the node taking the tx): keep the signed txid.
  const { chain, seen } = rpc(REAL, () => new Response("bad gateway", { status: 502 }));
  const signed = await chain.send({ priv: PRIV, outputs: [{ to: TO, value: 100_000_000 }], fee: 1_000_000, broadcast: false });
  const e = await grab(() => send(chain));
  ok("a submit that throws after signing is SubmitInFlightError carrying the signed txid (maybe sent, not retryable)",
    e instanceof SubmitInFlightError && e.code === "SUBMIT_MAYBE_INFLIGHT" && e.maybeSent === true && e.retryable === false
    && typeof signed.txid === "string" && e.txid === signed.txid && /HTTP 502/.test(e.shortMessage));
  ok("the failed submit was sent once (no retry of a POST)", submits(seen) === 1);
}

console.log(`\nchain-send: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
