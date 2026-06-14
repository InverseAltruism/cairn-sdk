# @inversealtruism/cairn-sdk

The **Compute Substrate dApp kit** — one cohesive toolkit for building apps on CSD. It composes everything in the Cairn ecosystem behind a single `Cairn` object:

| | |
|---|---|
| `cairn.wallet` | Connect the **Cairn Wallet**, sign things (clear-signed approvals). The key never leaves the extension. |
| `cairn.chain` | Node RPC + transaction builders + a verifying **light client** (re-exports the `csd-*` primitives). |
| `cairn.board` | The signal **board** + work graph. Reads are public; writes are wallet-signed. |
| `cairn.index` | The L2 **explorer/indexer**: REST + merkle proofs + live SSE/WS feeds. |
| `cairn.content` | **Self-certifying content** — publish via the board, fetch with client-side verification. |
| `cairn.registry` | L3 **peer / gateway / identity** resolution. |

```bash
npm i @inversealtruism/cairn-sdk
```

## Quick start

```ts
import { Cairn } from "@inversealtruism/cairn-sdk";

const cairn = new Cairn({ network: "mainnet" });   // defaults to cairn-substrate.com

// reads need no wallet
const top = await cairn.board.top({ domain: "csd:apps" });
const tip = await cairn.chain.tip();

// connect the user's wallet (browser) — prompts once, then "connected"
await cairn.connect();

// publish a board item, signed by the user's wallet (clear-signed approval)
const { txid } = await cairn.board.propose({
  domain: "csd:apps",
  title: "My dApp",
  body: "Built with the Cairn SDK",
});

// watch it land, live
cairn.index.streamAll({ onProposal: (e) => console.log("new proposal", e) });
```

## How wallet connection works (and why it's safe)

The SDK follows the exact model MetaMask uses — there is **no allowlist you maintain**:

- **`connect()` / `getAddress()`** grant *address visibility*. The first time a site connects, the user approves once; after that the wallet answers silently (the site shows up under **Settings → Connected sites**, revocable anytime). This is the only "silent" call.
- **Every signing / fund-moving call** — `send`, `propose`, `attest`, `signIn`, `sealClaim`, `revealClaim` — **always** opens the wallet's clear-signing approval window, **every time**, no matter what. Being "connected" never pre-approves a signature. A connected site cannot move a satoshi without an explicit, fully-disclosed approval click.

```ts
import { connect, UserRejectedError, NotInstalledError } from "@inversealtruism/cairn-sdk";

try {
  const { wallet, address } = await connect();
  await wallet.send({ to: "0x…", amount: 100_000_000 }); // 1 CSD — still prompts
} catch (e) {
  if (e instanceof NotInstalledError) { /* tell the user to install the wallet */ }
  if (e instanceof UserRejectedError) { /* they declined */ }
}
```

## API by namespace

**`cairn.board`** — `top()/board({domain,window})`, `item(id)`, `domains()`, `quests()/quest(id)`, `profile(addr)`, `leaderboard()`, `network()/networkSeries()/miner(addr)`, `activity()`, `wall()`; writes `propose({domain,title,body,links?,fee?})`, `support(id,{score?,confidence?,fee?})`.

**`cairn.index`** — `tipHeight()`, `block()/blockTxids()`, `tx()/txStatus()/txMerkleProof()`, `address()/addressTxs()/addressUtxo()`, `proposal()/attestations()`, `reputation()`, `registryPeers()/registryGateways()/identity()`, **`verifyInclusion(txid)`** (trust-minimized), `streamAll()/streamBlocks()/streamDomain()` (SSE), `subscribe()` (WS).

**`cairn.content`** — `prepare(obj)`/`put(obj)` → `{ payloadHash, canonical, bytes }`; `get(hash)` / `getBytes(hash)` (fetch **and verify** `sha256(bytes) === hash`, throws `ContentVerificationError` on tamper); `hash(obj)`.

**`cairn.chain`** — `tip()`, `utxos(addr)`, `submit(nodeJsonTx)`, `.client` (full `CsdClient`), `.light()` (verifying light client). The package also re-exports the primitives under the `/chain` subpath: `buildSend/buildPropose/buildAttest`, `signTx`, `keygen`, `payloadHash`, `verifyMerkleProof`, `LightClient`, etc.

**`cairn.registry`** — `gateways()`, `peers()`, `resolveName(handle)`, `reverseName(addr)`, `.fromRecords` (deterministic local resolvers).

Subpath imports are available for tree-shaking: `@inversealtruism/cairn-sdk/{connect,board,indexer,content,registry,chain}`.

## Examples

- **`examples/read-only.mjs`** — runs today against live mainnet, no wallet, no build: `npm run test:live`. Demonstrates chain/board/indexer/registry reads + verified merkle inclusion + verified content fetch.
- **`examples/hello-csd/`** — a no-framework browser dApp (connect → read board → publish → live feed). Build the bundle with `npm run build:example`, then serve the folder from **localhost** (the wallet injects there) with the Cairn Wallet installed.

## Trust model & honest limits

- **Content is always verified client-side.** `cairn.content.get()` rejects bytes that don't hash to the requested `payloadHash` — an untrusted gateway can't serve tampered content.
- **Merkle inclusion is trust-minimized — to the strength of your header source.** `verifyInclusion()` folds the proof and, when a header-merkle source is wired, cross-checks the root against it → `trustLevel: "verified-inclusion"`; otherwise `"proof-consistent"` (indexer trusted). That cross-check only means something against an *independent* header, so the default `Cairn` wiring enables it ONLY when your node RPC is a different origin than the indexer (the default same-origin proxy stays at `"proof-consistent"` — a single compromised server can't be cross-checked against itself). For full trust-minimization against a lying node too, supply a PoW-verifying `headerMerkleAt` (e.g. backed by `cairn.chain.light()`).
- **Balances are RPC-trusted.** Headers don't commit to the UTXO set; balance reads trust the node/proxy (same as every light client).
- **Indexer/swarm run behind the cairn proxy.** By default `cairn.index` and content resolution use the cairn server's hardened, read-only, rate-limited `/explorer/api` reverse proxy (no separate public indexer needed). **SSE works through it; `subscribe()` (WebSocket) needs a direct indexer endpoint** — set `baseUrls.indexer` to a private/localhost indexer for WS.
- **Today the wallet injects only on `cairn-substrate.com` + localhost.** Connecting from an arbitrary third-party origin requires the wallet's "connect anywhere" release (broadened injection), which ships after the per-origin consent layer is proven.

## Configuration

```ts
new Cairn({
  network: "mainnet",
  baseUrls: {
    cairn:   "https://cairn-substrate.com",        // board + /api/rpc proxy + /content origin
    rpc:     "https://cairn-substrate.com/api/rpc", // node RPC (proxy)
    indexer: "https://cairn-substrate.com/explorer/api",
    swarm:   undefined,                             // optional direct swarm gateway
  },
  fetch,            // custom fetch (Node <18, tests)
  timeoutMs: 15000,
  WebSocketImpl,    // for index.subscribe() in environments without global WebSocket
});
```

## Testing

```bash
pnpm build && pnpm test         # unit (offline): error mapping, client paths, content+merkle verify
pnpm test:e2e:read              # live reads vs mainnet + adversarial (free)
pnpm test:e2e:wallet            # real extension + real connector under Xvfb: connect/consent/sign (free)
pnpm test:e2e:write             # full pipeline incl. a real on-chain Propose+Attest (spends ~0.3 CSD)
```

See [`test/e2e/README.md`](test/e2e/README.md) for coverage, requirements, and cost of each layer. The unit + live-read + wallet-connector suites are CI-friendly and free; the write suite needs a funded key and is opt-in.

## License

MIT
