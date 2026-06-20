// node-signer — a server/bot CairnProvider backed by a raw private key, built on the
// SDK's own chain primitives (buildPropose/buildAttest/buildSend + the node RPC proxy).
//
// This is the BACKEND counterpart to the browser wallet: a dApp in the browser uses
// cairn.connect() (window.cairn, user-approved); a bot/server uses makeKeyWallet() to
// sign with a key it holds. Both satisfy the same CairnProvider contract, so the exact
// same cairn.board.propose() / cairn.board.support() code paths work either way.
//
// SECURITY: this holds a private key in process — only for keys you own (treasury bots,
// CI, indexers), never for end users. End users always sign in their wallet.
// chain primitives live under the /chain subpath (tree-shakeable away from browser dApps)
import { buildPropose, buildAttest, buildSendVerified, verifyInputValues, addrFromPriv } from "../dist/chain.js";

/**
 * Build a CairnProvider that signs with `priv` and submits through `cairn.chain`.
 * Usage:
 *   const cairn = new Cairn({ network: "mainnet" });
 *   cairn.attachWallet(new WalletConnection(makeKeyWallet(priv, cairn)));
 *   await cairn.board.propose({ domain: "csd:apps", title: "…", body: "…" });
 */
export function makeKeyWallet(priv, cairn) {
  const addr = addrFromPriv(priv);

  async function spendable() {
    const r = await cairn.chain.utxos(addr);
    return (r.utxos || []).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmations: u.confirmations, coinbase: u.coinbase }));
  }
  async function submit(build, kind) {
    if (!build || !build.ok) throw new Error(`${kind} build failed: ${build?.error || "unknown"}`);
    const res = await cairn.chain.submit(build.nodeJson);
    if (res?.ok === false || res?.err) throw new Error(`${kind} submit rejected: ${res.err || JSON.stringify(res)}`);
    return { ok: true, result: { ok: true, txid: res?.txid || build.txid } };
  }

  return {
    isCairn: true,
    version: "node-signer/1",
    async connect() { return { ok: true, result: { addr } }; },
    async getAddress() { return { ok: true, result: { addr } }; },
    async propose(p) { return submit(buildPropose({ ...p, utxos: await spendable(), priv }), "propose"); },
    async attest(p) { return submit(buildAttest({ ...p, utxos: await spendable(), priv }), "attest"); },
    async send(p) {
      const outputs = Array.isArray(p.outputs) ? p.outputs : [{ to: p.to, value: p.amount }];
      // VP-2: use the VERIFIED builder — recomputes each selected input's real value from its source tx
      // (verifyInputValues), computes change from the verified total, and fails closed. A backend signer
      // copying this template against an untrusted RPC therefore can't be tricked into burning the surplus
      // as an implicit fee (the UTXO-VALUE-1 class). Never the bare buildSend here.
      const build = await buildSendVerified({ outputs, fee: p.fee ?? 1_000_000, utxos: await spendable(), priv, verify: (inputs) => verifyInputValues(cairn.chain.client, inputs) });
      return submit(build, "send");
    },
    async signIn() { return { ok: false, error: "signIn is not implemented in the node-signer" }; },
    async sealClaim() { return { ok: false, error: "sealClaim is not implemented in the node-signer" }; },
    async revealClaim() { return { ok: false, error: "revealClaim is not implemented in the node-signer" }; },
  };
}

// Demo when run directly: print the derived address + spendable balance (no spend).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { Cairn } = await import("../dist/index.js");
  const { readFileSync } = await import("node:fs");
  const keyPath = process.env.CAIRN_KEY || `${process.env.HOME}/.config/cairn/key.json`;
  const priv = JSON.parse(readFileSync(keyPath, "utf8")).privkey;
  const cairn = new Cairn({ network: "mainnet" });
  const provider = makeKeyWallet(priv, cairn);
  const { addr } = (await provider.connect()).result;
  const bal = await cairn.chain.utxos(addr);
  console.log(`node-signer ready for ${addr} — ${(bal.confirmed_balance / 1e8).toFixed(4)} CSD spendable across ${bal.utxos?.length || 0} UTXO(s)`);
}
