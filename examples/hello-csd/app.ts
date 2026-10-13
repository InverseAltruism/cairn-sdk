// hello-csd: a minimal dApp. Connect the Cairn Wallet, read recent on-chain proposals from the indexer,
// and watch the live feed. Bundled by `pnpm build:example` (esbuild) into app.js, which index.html loads.
import { Cairn, NotInstalledError, UserRejectedError } from "../../src/index.js";

const cairn = new Cairn({ network: "mainnet" });
const $ = (id: string) => document.getElementById(id)!;
const log = (m: string) => { const el = $("log"); el.textContent = `${new Date().toLocaleTimeString()}  ${m}\n` + el.textContent; };

type Proposal = { txid: string; domain: string; height: number; proposer: string };

async function refreshProposals() {
  const tip = await cairn.chain.tip();
  const domains = (await cairn.index.domains()) as { domain: string; proposals: number }[];
  const rows: Proposal[] = [];
  for (const d of domains.slice(0, 5)) rows.push(...((await cairn.index.domainProposals(d.domain)) as Proposal[]).slice(0, 5));
  rows.sort((a, b) => b.height - a.height);
  $("proposals").innerHTML = `<b>chain tip ${tip.height}</b>, recent proposals<br>` + rows.slice(0, 8)
    .map((p) => `• <code>${escape(p.txid.slice(0, 14))}…</code> <span class="dim">(${escape(p.domain)}, block ${p.height})</span>`).join("<br>");
}

$("btn-connect").addEventListener("click", async () => {
  try {
    const addr = await cairn.connect();
    $("addr").textContent = addr;
    ($("btn-connect") as HTMLButtonElement).disabled = true;
    log(`connected as ${addr}`);
  } catch (e) {
    if (e instanceof NotInstalledError) log("Cairn Wallet not found: install it and serve this page from localhost.");
    else if (e instanceof UserRejectedError) log("connection rejected.");
    else log("connect error: " + (e as Error).message);
  }
});

// live feed (SSE through the public proxy)
cairn.index.streamAll({
  onBlock: (e) => log(`▸ block ${(e as any).height ?? ""}`),
  onProposal: (e) => { log(`▸ new proposal in ${(e as any).domain ?? "?"}`); refreshProposals().catch(() => {}); },
  onAttestation: () => log("▸ new attestation"),
  onError: () => { /* reconnects automatically */ },
});

function escape(s: string) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)); }

refreshProposals().catch((e) => log("proposal load failed: " + e.message));
log("ready: connect your wallet to see your address.");
