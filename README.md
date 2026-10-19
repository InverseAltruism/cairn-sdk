# @inversealtruism/cairn-sdk

The **Compute Substrate dApp kit:** one cohesive toolkit for building apps on CSD. It composes everything in the Cairn ecosystem behind a single `Cairn` object:

| | |
|---|---|
| `cairn.wallet` | Connect the **Cairn Wallet**, sign things (clear-signed approvals). The key never leaves the extension. |
| `cairn.chain` | Node RPC + transaction builders + a verifying **light client** (re-exports the `csd-*` primitives). |
| `cairn.index` | The L2 **explorer/indexer**: REST + merkle proofs + live SSE/WS feeds. |
| `cairn.content` | **Self-certifying content:** hash for an on-chain Propose, fetch with client-side verification. |
| `cairn.names` | **.csd names + CairnX reads:** name resolution, reverse/primary lookup, tokens, offers, bids, canonical state. |

```bash
npm i @inversealtruism/cairn-sdk
```

## Quick start

```ts
import { Cairn } from "@inversealtruism/cairn-sdk";

const cairn = new Cairn({ network: "mainnet" });   // defaults to cairn-substrate.com

// reads need no wallet
const tip = await cairn.chain.tip();
const domains = await cairn.index.domains();

// connect the user's wallet (browser): prompts once, then "connected"
await cairn.connect();

// a payment, signed by the user's wallet (clear-signed approval every time)
const { txid } = await cairn.wallet!.send({ to: "0x…", amount: 100_000_000 }); // 1 CSD

// watch the chain, live
cairn.index.streamAll({ onBlock: (e) => console.log("new block", e) });
```

## How wallet connection works (and why it's safe)

The SDK follows the exact model MetaMask uses, there is **no allowlist you maintain**:

- **`connect()` / `getAddress()`** grant *address visibility*. The first time a site connects, the user approves once; after that the wallet answers silently (the site shows up under **Settings → Connected sites**, revocable anytime). This is the only "silent" call.
- **Every signing / fund-moving call:** `send`, `propose`, `attest`, `signIn`, `sealClaim`, `revealClaim`, **always** opens the wallet's clear-signing approval window, **every time**, no matter what. Being "connected" never pre-approves a signature. A connected site cannot move a satoshi without an explicit, fully-disclosed approval click.

```ts
import { connect, UserRejectedError, NotInstalledError } from "@inversealtruism/cairn-sdk";

try {
  const { wallet, address } = await connect();
  await wallet.send({ to: "0x…", amount: 100_000_000 }); // 1 CSD, still prompts
} catch (e) {
  if (e instanceof NotInstalledError) { /* tell the user to install the wallet */ }
  if (e instanceof UserRejectedError) { /* they declined */ }
}
```

## API by namespace

**`cairn.index`:** `tipHeight()`, `block()/blockTxids()`, `tx()/txStatus()/txMerkleProof()`, `address()/addressTxs()/addressUtxo()`, `domains()/domainProposals(domain)`, `proposal()/attestations()`, `reputation()`, **`verifyInclusion(txid)`** (trust-minimized), `streamAll()/streamBlocks()/streamDomain()` (SSE), `subscribe()` (WS).

**`cairn.names`:** `resolve(name)` (display-path name to address), `name(name)`/`nameHistory(name)`, `primary(addr)` (reverse lookup)/`namesOf(addr)`, `names()`, `tokens()/token(ticker)`, `offers()`, `bids()`, `state()` (the canonical CairnX state). Reads go through the public `/trade/api/cairnx/*` proxy; for payment-grade name resolution verify through the wallet or a replaying resolver, not a bare read (see `src/names.ts` header).

**`cairn.content`:** `prepare(obj)`/`put(obj)` → `{ payloadHash, canonical, bytes }`; `get(hash)` / `getBytes(hash)` (fetch **and verify** `sha256(bytes) === hash`, throws `ContentVerificationError` on tamper); `hash(obj)`.

**`cairn.chain`:** `tip()`, `utxos(addr)`, `submit(nodeJsonTx)`, `.client` (full `CsdClient`), `.light()` (verifying light client). The package also re-exports the primitives under the `/chain` subpath: `buildSend/buildPropose/buildAttest`, `signTx`, `keygen`, `payloadHash`, `verifyMerkleProof`, `LightClient`, etc.

Subpath imports are available for tree-shaking: `@inversealtruism/cairn-sdk/{connect,indexer,content,chain,controller,react}`.

## Examples

- **`examples/read-only.mjs`:** runs today against live mainnet, no wallet, no build: `npm run test:live`. Demonstrates chain/indexer reads + verified merkle inclusion + verified content fetch.
- **`examples/hello-csd/`:** a no-framework browser dApp (connect → read recent proposals → live feed). Build the bundle with `npm run build:example`, then serve the folder from **localhost** (the wallet injects there) with the Cairn Wallet installed.

## Trust model & honest limits

- **Content is always verified client-side.** `cairn.content.get()` rejects bytes that don't hash to the requested `payloadHash`, an untrusted gateway can't serve tampered content.
- **Merkle inclusion is trust-minimized, to the strength of your header source.** `verifyInclusion()` folds the proof and cross-checks its root against a header merkle from `headerMerkleAt`. The default `Cairn` wiring backs that with a light client that PoW-verifies headers forward from a pinned checkpoint, so a match reads `trustLevel: "verified-inclusion"` with `included: true`. A header within 12 blocks of the light client's cached tip is first compared with the header the base serves at that height, so a block orphaned by a reorg stops counting; the hosted base edge-caches rows at or below its tip minus 6, so there this catches reorgs of up to 6 blocks. When no header can be verified (below the checkpoint, header source unreachable, no source configured) the result is `"proof-consistent"` with `included: false` and a `reason`: the indexer alone vouches for it. Gate on `included` or on `trustLevel === "verified-inclusion"`; they agree.
- **Balances are RPC-trusted.** Headers don't commit to the UTXO set; balance reads trust the node/proxy (same as every light client).
- **Indexer/swarm run behind the cairn proxy.** By default `cairn.index` and content resolution use the cairn server's hardened, read-only, rate-limited `/explorer/api` reverse proxy (no separate public indexer needed). **SSE works through it; `subscribe()` (WebSocket) needs a direct indexer endpoint:** set `baseUrls.indexer` to a private/localhost indexer for WS.
- **The wallet injects on every site** (connect-anywhere shipped in 0.2.4x) behind a per-origin consent gate: a site sees nothing until the user approves the connection, and some request kinds stay first-party-only (the `FIRST_PARTY_ONLY` error code).

## Configuration

```ts
new Cairn({
  network: "mainnet",
  baseUrls: {
    cairn:   "https://cairn-substrate.com",        // /api/rpc proxy + /api/headers + /content origin + names
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
pnpm test:live                  # examples/read-only.mjs + live reads vs mainnet + adversarial (free)
pnpm test:live:wallet           # real extension + real connector under Xvfb: connect/consent/sign (free)
```

See [`test/e2e/README.md`](test/e2e/README.md) for coverage, requirements, and cost of each layer. All three suites are free; none spends CSD.

## License

MIT
