// Integrate the Cairn Wallet in a web page: detect, connect, balances, sign-in verified by your server, a CSD send
// and a token send, and the no-wallet, locked, rejected and account-changed cases. It imports the packages by their
// published names, as an app that installed them does. docs/SDK-GUIDE.md, "Integrate the wallet", walks through it.
import { Cairn, CairnError, SubmitInFlightError, errorCode, getWallet, type WalletConnection } from "@inversealtruism/cairn-sdk";
import { DOMAIN, epochOf, transfer } from "@inversealtruism/cairnx-core";

const BASE = "https://cairn-substrate.com";
const cairn = new Cairn({ network: "mainnet" });
let wallet: WalletConnection | null = null;

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};
const field = (id: string): string => el<HTMLInputElement>(id).value.trim();
const say = (text: string): void => { el("status").textContent = text; };
const setConnected = (address: string | null): void => {
  el("address").textContent = address ?? "not connected";
  for (const id of ["signin", "send", "token-send"]) el<HTMLButtonElement>(id).disabled = address === null;
  if (address === null) el("balances").textContent = "";
};

// Branch on the error code, never on the message text: the wallet rewords messages, the codes are its contract.
function explain(e: unknown): string {
  // Not a CairnError: this page failed before the wallet was asked (a record that does not validate, a failed read).
  if (!(e instanceof CairnError)) return `Not sent to the wallet: ${String((e as Error)?.message ?? e).split("\n")[0]}`;
  if (e instanceof SubmitInFlightError) {
    // A timed-out request can still be open in the wallet: approving it after a resend sends twice, and the chain
    // shows nothing until it is approved.
    if (e.code === "WALLET_TIMEOUT") {
      return "The wallet did not answer in time, and the request may still be open in it. Reject that request in the wallet first, then check your history before you send again: approving it after a new send sends twice.";
    }
    return `The transaction may have been sent${e.txid ? ` (txid ${e.txid})` : ""}. Check your history before you send again.`;
  }
  switch (errorCode(e)) {
    case "NOT_INSTALLED":
      return "No Cairn Wallet found. Install it from cairn-substrate.com and reload. It runs only in the top frame of an https page, or of an http page on localhost or 127.0.0.1.";
    case "USER_REJECTED": return "You declined in the wallet. Nothing was signed.";
    case "WALLET_LOCKED": return "The wallet is locked. Unlock it and try again.";
    case "ACCOUNT_CHANGED": return "The wallet's account changed while the request was open. Review it again.";
    case "WALLET_RELOADED": return "The wallet was updated or reloaded. Reload this page.";
    case "RATE_LIMITED": return "Too many requests are waiting in the wallet. Answer those first.";
    case "UNSUPPORTED_METHOD": return `This wallet cannot do that: ${(e as Error).message.split("\n")[0]}`;
    case "HTTP_ERROR": return `A read from the Cairn API failed (the wallet was not asked): ${e.shortMessage}`;
    default: return `Wallet error ${errorCode(e)}: ${e.shortMessage}`;
  }
}
async function run(task: () => Promise<void>): Promise<void> {
  try { await task(); } catch (e) { say(explain(e)); }
}

// Detect: getWallet() waits up to 3 s for the wallet to announce itself. The wallet injects after the page starts,
// so a synchronous isInstalled() at startup would tell a wallet user to install it.
async function detect(): Promise<void> {
  wallet = await getWallet();
  // Fires with [] when this site loses access: the wallet locked, switched account or revoked the site. It never
  // carries the new address; connect again to get it.
  wallet.on("accountsChanged", (accounts: string[]) => {
    if (accounts.length === 0) { setConnected(null); say("The wallet disconnected this site (locked, switched account or revoked). Connect again."); }
  });
  el<HTMLButtonElement>("connect").disabled = false;
  say(`Cairn Wallet ${wallet.version} found.`);
}

// Balances are served reads for display, not proofs: never gate a payment on them.
async function showBalances(address: string): Promise<void> {
  const csd = await cairn.chain.utxos(address);
  const r = await fetch(`${BASE}/trade/api/cairnx/address/${address}`);
  if (!r.ok) throw new Error(`token balances: HTTP ${r.status}`);
  const { balances } = (await r.json()) as { balances: Record<string, { available: string; locked: string }> };
  const tokens = Object.entries(balances).map(([ticker, b]) => `${ticker} ${b.available} available, ${b.locked} locked (base units)`);
  el("balances").textContent = [`CSD ${csd.confirmed_balance} base units (1 CSD = 100,000,000)`, ...tokens].join("\n");
}

async function connectWallet(): Promise<void> {
  if (!wallet) return;
  const address = await wallet.connect();
  setConnected(address);
  say("Connected.");
  await showBalances(address);
}

// Sign in: your server issues a single-use nonce, the wallet signs a message bound to this page's origin, and your
// server verifies it with csd-siwc and starts its own session (server.mjs).
async function postJson(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return (await r.json()) as Record<string, unknown>;
}
async function signIn(): Promise<void> {
  if (!wallet) return;
  const { nonce } = (await postJson("/auth/siwc/nonce")) as { nonce: string };
  const signed = await wallet.signInWithCsd({ nonce, statement: "Sign in to the Cairn SDK integration sample" });
  const v = await postJson("/auth/siwc/verify", { message: signed.message, sig64: signed.sig64, pub33: signed.pub33 });
  say(v.ok ? `Signed in as ${String(v.account)} (your server's session cookie is set).` : `Your server refused the sign-in: ${String(v.error)}`);
}

// A CSD send. The wallet picks the inputs, returns change to itself and shows the user every output and the fee.
async function sendCsd(): Promise<void> {
  if (!wallet) return;
  const { txid } = await wallet.send({ to: field("send-to"), amount: Number(field("send-amount")) });
  say(`Sent, txid ${txid}.`);
}

// A token send: a cairnx:v1 transfer record anchored by a Propose. The fee is left to the wallet, which signs its
// Propose floor. The token balance changes once the resolver reads the block that mines it. The expiry window is
// the one the wallet's own token transfer uses: 720 epochs, about 30 days (an epoch is 30 blocks at a 120 s target).
const TRANSFER_EXPIRY_EPOCHS = 720;
async function sendToken(): Promise<void> {
  if (!wallet) return;
  const record = transfer({ ticker: field("token-ticker"), to: field("token-to"), amount: field("token-amount"), ts: Math.floor(Date.now() / 1000) });
  const { height } = await cairn.chain.tip();
  const { txid } = await wallet.propose({ domain: DOMAIN, payloadHash: record.payloadHash, uri: record.uri, expiresEpoch: epochOf(height) + TRANSFER_EXPIRY_EPOCHS });
  say(`Token transfer anchored, txid ${txid}.`);
}

el("connect").addEventListener("click", () => void run(connectWallet));
el("signin").addEventListener("click", () => void run(signIn));
el("send").addEventListener("click", () => void run(sendCsd));
el("token-send").addEventListener("click", () => void run(sendToken));
setConnected(null);
void run(detect);
