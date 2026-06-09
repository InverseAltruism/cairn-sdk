// hello-csd — a minimal dApp showing the whole flow: connect the Cairn Wallet,
// read the live board, publish a note (wallet-signed), and watch the live feed.
// Bundled by `pnpm build:example` (esbuild) into app.js, which index.html loads.
import { Cairn, NotInstalledError, UserRejectedError } from "../../src/index.js";

const cairn = new Cairn({ network: "mainnet" });
const $ = (id: string) => document.getElementById(id)!;
const log = (m: string) => { const el = $("log"); el.textContent = `${new Date().toLocaleTimeString()}  ${m}\n` + el.textContent; };

async function refreshBoard() {
  const { items, count } = await cairn.board.top({ window: "all" });
  $("board").innerHTML = `<b>${count} board items</b><br>` + items.slice(0, 8)
    .map((i) => `• <b>${escape(i.title)}</b> <span class="dim">(${escape(i.domain)}, score ${i.score})</span>`).join("<br>");
}

$("btn-connect").addEventListener("click", async () => {
  try {
    const addr = await cairn.connect();
    $("addr").textContent = addr;
    ($("btn-connect") as HTMLButtonElement).disabled = true;
    ($("btn-publish") as HTMLButtonElement).disabled = false;
    log(`connected as ${addr}`);
  } catch (e) {
    if (e instanceof NotInstalledError) log("Cairn Wallet not found — install it and serve this page from localhost.");
    else if (e instanceof UserRejectedError) log("connection rejected.");
    else log("connect error: " + (e as Error).message);
  }
});

$("btn-publish").addEventListener("click", async () => {
  const title = ($("title") as HTMLInputElement).value.trim();
  const body = ($("body") as HTMLInputElement).value.trim();
  if (!title) return log("enter a title first.");
  try {
    log("requesting wallet approval…");
    const r = await cairn.board.propose({ domain: "csd:apps", title, body });
    log(`published! txid ${r.txid.slice(0, 18)}…  registered=${r.registered}`);
    setTimeout(refreshBoard, 4000);
  } catch (e) {
    if (e instanceof UserRejectedError) log("you rejected the signing request.");
    else log("publish error: " + (e as Error).message);
  }
});

// live feed (SSE through the public proxy)
cairn.index.streamAll({
  onBlock: (e) => log(`▸ block ${(e as any).height ?? ""}`),
  onProposal: (e) => { log(`▸ new proposal in ${(e as any).domain ?? "?"}`); refreshBoard(); },
  onAttestation: () => log("▸ new attestation"),
  onError: () => { /* reconnects automatically */ },
});

function escape(s: string) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)); }

refreshBoard().catch((e) => log("board load failed: " + e.message));
log("ready — connect your wallet to publish.");
