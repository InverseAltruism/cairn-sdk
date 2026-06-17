// Connecting the Cairn Wallet from a third-party site — discovery, connect, permissions, events,
// and the framework-agnostic controller / React adapter. Browser-only (needs window.cairn).
// Install: @inversealtruism/cairn-sdk
import {
  discoverProviders, getWallet, connect, CairnController, errorCode,
} from "@inversealtruism/cairn-sdk";

// ── 1) Discovery (EIP-6963-style, multi-wallet safe) ──────────────────────────
export async function pickWallet() {
  const found = await discoverProviders();          // [{ info:{uuid,name,icon,rdns}, provider }]
  // Show `found` in a wallet picker; here we just take Cairn if present.
  return found.find((w) => w.info.rdns === "com.cairn-substrate.wallet")?.provider ?? null;
}

// ── 2) One-shot connect ───────────────────────────────────────────────────────
export async function quickConnect() {
  try {
    const { wallet, address } = await connect();    // prompts the first time per origin
    console.log("connected as", address, "wallet v" + wallet.version);
    return wallet;
  } catch (e) {
    if (errorCode(e) === "NOT_INSTALLED") console.log("Install the Cairn Wallet.");
    throw e;
  }
}

// ── 3) Permissions (EIP-2255-style; origin-scoped) ────────────────────────────
export async function permissionsDemo() {
  const wallet = await getWallet();
  const perms = await wallet.getPermissions();       // this origin's grant ([] if none) — silent
  if (perms.length === 0) await wallet.requestPermissions(); // prompts (like connect)
  // ... later, "Disconnect" button:
  await wallet.revokePermissions();                  // drops THIS origin's access (silent)
}

// ── 4) Capability / version negotiation (evolve additively) ───────────────────
export async function featureDetect() {
  const wallet = await getWallet();
  if (!wallet.supportsSiwc) return "update-needed";  // cheap sync check
  const caps = await wallet.getCapabilities();        // { version, siwc, discovery, events, methods } | null
  return caps?.siwc === "1" ? "ready" : "legacy";
}

// ── 5) Events (F11-safe: accountsChanged fires with [] on lock/switch/revoke) ──
export async function watch() {
  const wallet = await getWallet();
  const onAccounts = (accounts) => {
    if (!accounts || accounts.length === 0) console.log("locked / disconnected — reconnect to continue");
    else console.log("active account:", accounts[0]);
  };
  wallet.on("accountsChanged", onAccounts);
  wallet.on("disconnect", () => console.log("disconnected"));
  return () => { wallet.off("accountsChanged", onAccounts); }; // cleanup
}

// ── 6) Framework-agnostic reactive controller (vanilla / Vue / Svelte / …) ────
export function makeController() {
  const controller = new CairnController();
  const unsub = controller.subscribe(() => {
    const s = controller.getSnapshot();              // { status, account, error } (immutable)
    document.querySelector("#status").textContent = s.account ?? s.status;
  });
  document.querySelector("#connect").onclick = () => controller.connect();
  document.querySelector("#logout").onclick = () => controller.disconnect();
  return unsub;
}

// ── 7) React (zero react dependency in the SDK — you pass your React) ──────────
//   import * as React from "react";
//   import { createCairnHooks } from "@inversealtruism/cairn-sdk/react";
//   const { useCairn, useCairnAccount } = createCairnHooks(React);
//   function Wallet() {
//     const { status, account, connect, disconnect, signInWithCsd } = useCairn();
//     if (account) return <button onClick={disconnect}>{account}</button>;
//     return <button onClick={connect}>{status === "connecting" ? "…" : "Connect Cairn"}</button>;
//   }
