// node-signer: a server/bot CairnProvider backed by a raw private key, built on the SDK's
// own chain primitives (the input-verified propose, attest and send builders + the node RPC proxy).
//
// This is the BACKEND counterpart to the browser wallet: a dApp in the browser uses
// cairn.connect() (window.cairn, user-approved); a bot/server uses makeKeyWallet() to
// sign with a key it holds. Both satisfy the same CairnProvider contract, so the same
// WalletConnection calls (send, propose, attest) work either way.
//
// SECURITY: this holds a private key in process: only for keys you own (treasury bots,
// CI, indexers), never for end users. End users always sign in their wallet.
// Install: @inversealtruism/cairn-sdk and @inversealtruism/csd-codec (the fee floors; cairn-sdk depends on it, but
// an app that imports it must declare it).
// chain primitives live under the /chain subpath (tree-shakeable away from browser dApps)
import { buildProposeVerified, buildAttestVerified, buildSendVerified, verifyInputValues, addrFromPriv } from "@inversealtruism/cairn-sdk/chain";
import { MIN_FEE_ATTEST, MIN_FEE_PROPOSE } from "@inversealtruism/csd-codec";

/**
 * Build a CairnProvider that signs with `priv` and submits through `cairn.chain`.
 * Usage:
 *   const cairn = new Cairn({ network: "mainnet" });
 *   const provider = makeKeyWallet(priv, cairn);
 *   cairn.attachWallet(new WalletConnection(provider));
 *   try { await cairn.wallet.send({ to: "0x…", amount: 100_000_000 }); }   // 1 CSD
 *   catch (e) {
 *     if (!(e instanceof SubmitInFlightError)) throw e;   // nothing was broadcast
 *     if (!(await provider.settle(e.txid))) throw new Error(`${e.txid} is still unknown: decide by hand, never send anew`);
 *   }
 */
export function makeKeyWallet(priv, cairn) {
  const addr = addrFromPriv(priv);
  // Signed transactions whose submit may have reached the node, by txid, so settle() resends the same bytes.
  const unsettled = new Map();

  const verify = (inputs) => verifyInputValues(cairn.chain.client, inputs);
  async function spendable() {
    const r = await cairn.chain.utxos(addr);
    return (r.utxos || []).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmations: u.confirmations, coinbase: u.coinbase }));
  }
  // Answers in the wallet's nested SubmitResult shape, so WalletConnection classifies the outcome as it does the
  // wallet's: SUBMIT_MAYBE_INFLIGHT throws SubmitInFlightError (maybeSent, with the txid), SUBMIT_REJECTED a final
  // CairnError. The split is Chain.send's: csd-client marks a 4xx answer `terminal` (nothing was broadcast), while no
  // answer, a timeout, a 5xx or an unreadable body can follow the node taking the transaction. The SDK exports no
  // function for that split (Chain.send inlines it, and send is all it builds), so it is repeated here;
  // test/examples.test.mjs requires the two to agree. The txid is the locally signed one: a proxy's echo is not
  // evidence of what was signed.
  async function submit(build, kind) {
    if (!build || !build.ok) throw new Error(`${kind} build failed: ${build?.error || "unknown"}`);
    const refused = (error) => ({ ok: true, result: { ok: false, code: "SUBMIT_REJECTED", error } });
    let res;
    try { res = await cairn.chain.submit(build.nodeJson); }
    catch (e) {
      if (e?.terminal === true) return refused(`${kind} submit refused, nothing was broadcast: ${e.message}`);
      unsettled.set(build.txid, build.nodeJson);
      return { ok: true, result: { ok: false, code: "SUBMIT_MAYBE_INFLIGHT", txid: build.txid, error: `${kind} submit failed after signing (${e?.message ?? e}); the node may hold ${build.txid}` } };
    }
    if (res?.ok === false || res?.err) return refused(`${kind} submit rejected by the node: ${res.err || JSON.stringify(res)}`);
    return { ok: true, result: { ok: true, txid: build.txid } };
  }

  return {
    isCairn: true,
    version: "node-signer/1",
    async connect() { return { ok: true, result: { addr } }; },
    async getAddress() { return { ok: true, result: { addr } }; },
    // Every builder here verifies each selected input's real value from its source tx (verifyInputValues),
    // computes change from the verified total and fails closed, so an RPC that under-reports a coin cannot make
    // the surplus burn as an implicit fee. Never the bare buildPropose, buildAttest or buildSend here.
    // An omitted fee signs the node's floor, as the browser wallet does.
    async propose(p) { return submit(await buildProposeVerified({ ...p, fee: p.fee ?? MIN_FEE_PROPOSE, utxos: await spendable(), priv, verify }), "propose"); },
    async attest(p) { return submit(await buildAttestVerified({ ...p, fee: p.fee ?? MIN_FEE_ATTEST, utxos: await spendable(), priv, verify }), "attest"); },
    async send(p) {
      const outputs = Array.isArray(p.outputs) ? p.outputs : [{ to: p.to, value: p.amount }];
      return submit(await buildSendVerified({ outputs, fee: p.fee ?? 1_000_000, utxos: await spendable(), priv, verify }), "send");
    },
    async signIn() { return { ok: false, error: "signIn is not implemented in the node-signer" }; },
    async sealClaim() { return { ok: false, error: "sealClaim is not implemented in the node-signer" }; },
    async revealClaim() { return { ok: false, error: "revealClaim is not implemented in the node-signer" }; },
    // Not in the wallet's provider contract: what a caller does after a SubmitInFlightError from this provider. It
    // never builds a new transaction: spendable() hides the first one's coins while the node holds it, so a new one
    // spends other coins and both can be mined. It waits up to `waitMs` (default 10 minutes, five blocks at the 120 s
    // target) for the txid to be mined; if it is not, it resends the same signed bytes once (the same coins under the
    // same txid, which cannot pay twice) and waits again. true: mined. false: still unknown; stop and decide by hand.
    async settle(txid, { waitMs = 10 * 60_000 } = {}) {
      const mined = () => cairn.chain.client.waitForTx(txid, { timeoutMs: waitMs }).then(() => true, () => false);
      let done = await mined();
      if (!done && unsettled.has(txid)) {
        // The resend's answer does not decide ("already present" while the node holds it, a refusal if the first was
        // mined meanwhile); the lookup after it does.
        await submit({ ok: true, nodeJson: unsettled.get(txid), txid }, "resend");
        done = await mined();
      }
      if (done) unsettled.delete(txid);
      return done;
    },
  };
}

// Demo when run directly: print the derived address + spendable balance (no spend).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { Cairn } = await import("@inversealtruism/cairn-sdk");
  const { readFileSync } = await import("node:fs");
  const keyPath = process.env.CAIRN_KEY || `${process.env.HOME}/.config/cairn/key.json`;
  const priv = JSON.parse(readFileSync(keyPath, "utf8")).privkey;
  const cairn = new Cairn({ network: "mainnet" });
  const provider = makeKeyWallet(priv, cairn);
  const { addr } = (await provider.connect()).result;
  const bal = await cairn.chain.utxos(addr);
  console.log(`node-signer ready for ${addr}: ${(bal.confirmed_balance / 1e8).toFixed(4)} CSD spendable across ${bal.utxos?.length || 0} UTXO(s)`);
}
