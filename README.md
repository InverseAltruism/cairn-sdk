# @inversealtruism/cairn-sdk

The **Compute Substrate dApp kit:** one cohesive toolkit for building apps on CSD. It composes everything in the Cairn ecosystem behind a single `Cairn` object:

| | |
|---|---|
| `cairn.wallet` | Connect the **Cairn Wallet**, sign things (clear-signed approvals). The key never leaves the extension. |
| `cairn.chain` | Node RPC + transaction builders + the **light client** primitives (re-exports the `csd-*` primitives). |
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

- **`connect()` / `getAddress()`** grant *address visibility*. The first time a site connects, the user approves once; after that the wallet answers silently (the site shows up under **Settings → Connected sites**, revocable anytime). These are the only calls that can return the address without a prompt. `getPermissions()` (read this site's own grant) and `revokePermissions()` (drop it) are silent too; neither signs anything.
- **Every signing / fund-moving call:** `send`, `propose`, `attest`, `fillOffer`, `sealClaim`, `revealClaim` and `signInWithCsd`, **always** opens the wallet's clear-signing approval window, **every time**, no matter what. Being "connected" never pre-approves a signature. A connected site cannot move a satoshi without an explicit, fully-disclosed approval click. The legacy `signIn()` is deprecated and first-party-only: the wallet refuses it from any other site with `FIRST_PARTY_ONLY` before prompting; use `signInWithCsd()`.
- There is no arbitrary message signing (`signMessage`): the wallet signs transactions and "Sign in with CSD" messages only.
- Detect the wallet with `getWallet()` / `connect()` (they wait up to 3 s for it). The wallet injects after the page starts, so `isInstalled()`, a synchronous read, returns `false` at startup even when the wallet is installed.

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

**`cairn.index`:** `tipHeight()`, `block()/blockTxids()`, `tx()/txStatus()/txMerkleProof()`, `address()/addressTxs()/addressUtxo()` (every unspent output, read in pages of 1,000 up to 100 pages; a full 100th page throws `HttpError`), `domains()/domainProposals(domain)`, `proposal()/attestations()`, `reputation()`, **`verifyInclusion(txid)`** (proves `txid` is a node of a PoW-verified block's merkle tree; an inner node or a block's root folds too, so hash the transaction body you hold to get the id, see the guide), `streamAll()/streamBlocks()/streamDomain()` (SSE), `subscribe()` (WS).

**`cairn.names`:** `resolve(name)` (display-path name to address), `name(name)`/`nameHistory(name)`, `primary(addr)` (reverse lookup)/`namesOf(addr)`, `names()` (the whole list, untyped), `namesPage(opts)` (a typed page of the read API, below), `allNames(opts)` (every row from one state, the walk's rules inside it), `lookup(name)` (one name for display, with its address by cairnx-core's `resolveNameIn`), `tokens()/token(ticker)`, `offers()`/`bids()` (open rows by default; pass `{ status }` for another status, or `{ status: "all" }` for every row), `state()` (the canonical CairnX state). Reads go through the public `/trade/api/cairnx/*` proxy; for payment-grade name resolution verify through the wallet or a replaying resolver, not a bare read (see `src/names.ts` header).

`namesPage` and `lookup` read the CairnX read API (`/api/cairnx/v1/names`); their rows are `NameRow` from
`@inversealtruism/cairnx-api` 1.0, the API's contract, and the root entry re-exports `NameRow` as a type. On a
front door without the read API (a 404) they answer from the legacy list, and a page says so (`source: "legacy"`,
`at: null`, a `total` the SDK counted); every other refusal is thrown. The guide has the walk and the fallback rule
("Names: pages and lookups").

**`cairn.content`:** `prepare(obj)`/`put(obj)` → `{ payloadHash, canonical, bytes }`; `get(hash)` / `getBytes(hash)` (fetch **and verify** `sha256(bytes) === hash`, throws `ContentVerificationError` on tamper); `hash(obj)`.

**`cairn.chain`:** `tip()`, `utxos(addr)`, `submit(nodeJsonTx)`, `.client` (full `CsdClient`), `.light()` (a `LightClient` over the same RPC with no checkpoint and no batch header source: it proves nothing until seeded, and a sync from it reads one block per height through the RPC; for verified reads use `cairn.index.verifyInclusion()` and `cairn.verifyOfferForFill()`, which run the facade's light client seeded from `DEFAULT_SPV_CHECKPOINT`, or build your own `new LightClient({ client, checkpoints, headersBatchProvider })` from a pinned checkpoint). The package also re-exports the primitives under the `/chain` subpath: `buildSendVerified/buildProposeVerified/buildAttestVerified` (they check each input's value against its source transaction; use them over the bare `buildSend/buildPropose/buildAttest` with any RPC you do not run), `signTx`, `keygen`, `payloadHash`, `verifyMerkleProof`, `LightClient`, etc.

**Links:** `parseCsdLink(input)`, `formatCsdLink({ name, path })` and `csdLinkToHttps(link, origin)` read and write `web+csd:<name>[/<path>]` links. A link opens a name page and authorizes nothing; the grammar and the refusal codes are in the [guide](docs/SDK-GUIDE.md#links-webcsd).

Subpath imports are available for tree-shaking: `@inversealtruism/cairn-sdk/{connect,indexer,content,chain,controller,react,testing}`.

**`/replica`:** the CairnX replica, `@inversealtruism/cairnx-replica`'s browser entry re-exported whole: `open`, the
sources, the verdict codes (`NOT_VERIFIED_CODES`, `NOTE_CODES`) and the levels. The replica is an optional peer
dependency: install it with the cairnx-core this SDK pins
(`npm i @inversealtruism/cairnx-replica@0.2.0 @inversealtruism/cairnx-core@0.2.10`) only if you import `/replica`; no
other entry loads it. ES module only, like the replica: TypeScript refuses it from a CommonJS file under
`module: "node16"` (TS1479), and `require()` loads it on Node 22.12 and later only. The guide has an example
("A replica").

## Examples

Every example imports the package by its published name, as your app does. In this repo the name resolves to the built `dist/` through the `exports` map, so run `pnpm build` first; `test/examples.test.mjs` typechecks and loads them.

- **`examples/integrate-wallet/`:** the wallet integration end to end: detect, connect, balances, sign-in verified by its own server, a CSD send, a token send, and the no-wallet, locked, rejected and account-changed cases. `pnpm build:example`, then `node examples/integrate-wallet/server.mjs` and open `http://127.0.0.1:4173/` with the Cairn Wallet installed. Walkthrough: [`docs/SDK-GUIDE.md`, "Integrate the wallet"](docs/SDK-GUIDE.md#integrate-the-wallet).
- **`examples/hello-csd/`:** a no-framework browser dApp (connect, read recent proposals, live feed). Build the bundle with `pnpm build:example`, then serve the folder from `localhost` or `127.0.0.1` with the Cairn Wallet installed.
- **`examples/wallet-connect.mjs`:** browser snippets for discovery, connect, permissions, capability detection, events, the controller and the React adapter.
- **`examples/siwc-login.mjs`:** "Sign in with CSD", the browser half and an Express-style server half in one file (`integrate-wallet/server.mjs` is the runnable server).
- **`examples/read-only.mjs`:** runs against live mainnet with no wallet (`pnpm test:live`): chain and indexer reads, verified merkle inclusion, verified content fetch.
- **`examples/node-signer.mjs`:** a server-side `CairnProvider` that signs with a key you hold (bots, treasury), never for end users.

## Trust model & honest limits

Content bytes are always verified client-side; merkle inclusion is verified when a PoW-verified header backs it (`trustLevel: "verified-inclusion"`); balances are RPC-trusted. The full trust model (each `trustLevel`, the checkpoint, reorgs near the tip) is in [`docs/SDK-GUIDE.md`](docs/SDK-GUIDE.md#what-the-sdk-verifies-vs-trusts-read-this).

- **Content comes from the cairn origin.** `cairn.content` reads `/content/<hash>` on the cairn base and verifies every byte against the hash.
- **The indexer runs behind the cairn proxy.** By default `cairn.index` uses the cairn server's hardened, read-only, rate-limited `/explorer/api` reverse proxy (no separate public indexer needed). **SSE works through that proxy; `subscribe()` (WebSocket) needs a direct indexer endpoint:** set `baseUrls.indexer` to a private/localhost indexer for WS.
- **Where the wallet injects:** the top frame of every https page, and of http pages on `localhost` and `127.0.0.1`; not into iframes and not on other http hosts. Behind a per-origin consent gate: a site sees nothing until the user approves the connection, and the legacy `signIn()` stays first-party-only (the `FIRST_PARTY_ONLY` error code).
- **Compatibility:** each release's [CHANGELOG](CHANGELOG.md) entry names the Cairn Wallet version whose error codes and params it follows.

## Configuration

```ts
new Cairn({
  network: "mainnet",
  baseUrls: {
    cairn:   "https://cairn-substrate.com",        // /api/rpc proxy + /api/headers + /content origin + names
    rpc:     "https://cairn-substrate.com/api/rpc", // node RPC (proxy)
    indexer: "https://cairn-substrate.com/explorer/api",
  },
  fetch,            // custom fetch (Node <18, tests)
  timeoutMs: 15000,
  WebSocketImpl,    // for index.subscribe() in environments without global WebSocket
});
```

## Testing your integration

`@inversealtruism/cairn-sdk/testing` exports a mock of the wallet's provider for your own tests, so they run without
the extension. It is a mock for tests, not a wallet: it holds no key and signs nothing, and its txids, signatures
and public keys are placeholders that no verifier accepts.

- `mockCairnProvider(options)` answers every provider method with the wallet's envelope (`docs/PROVIDER.md` in
  cairn-wallet), the transaction methods with the nested `SubmitResult`. It approves by default; `next(method,
  answer)` scripts the next answer (`approve` with a txid, `reject` with a wallet error code, `refuse` for a nested
  refusal, or a raw `reply`), `answers` sets a standing one, `calls` records each call with its params, and
  `emit("accountsChanged")` or `emit("disconnect", reason)` sends an event.
- `installMockCairn(target, provider)` sets `target.cairn` and runs the wallet's discovery handshake on `target`
  (`cairn#initialized`, then `csd:announceProvider` at install and on each `csd:requestProvider`). It touches no
  global you do not pass, and returns the function that uninstalls it.

```ts
import { CairnError, getWallet } from "@inversealtruism/cairn-sdk";
import { installMockCairn, mockCairnProvider } from "@inversealtruism/cairn-sdk/testing";

const mock = mockCairnProvider({ address: `0x${"ab".repeat(20)}` });
const uninstall = installMockCairn(window, mock); // the test environment's window (jsdom, happy-dom, a browser)

const wallet = await getWallet();                 // detect: the mock announces itself as the wallet does
const address = await wallet.connect();
const post = { domain: "my-app:v1", payloadHash: `0x${"00".repeat(32)}`, uri: "my-app:post/1", expiresEpoch: 1000 };

mock.next("propose", { kind: "reject", code: "USER_REJECTED" });
try {
  await wallet.propose(post);
} catch (e) {
  if (e instanceof CairnError) console.log(e.code);   // "USER_REJECTED"
}

mock.next("propose", { kind: "approve", txid: `0x${"cd".repeat(32)}` });
const { txid } = await wallet.propose(post);          // the scripted txid
console.log(mock.calls.map((c) => c.method));         // ["connect", "propose", "propose"]
uninstall();
```

## Testing this repo

```bash
pnpm build && pnpm test         # unit (offline): error mapping, client paths, content+merkle verify
pnpm test:live                  # examples/read-only.mjs + live reads vs mainnet + adversarial (free)
pnpm test:live:wallet           # real extension + real connector under Xvfb: connect/consent/sign (free)
```

See [`test/e2e/README.md`](test/e2e/README.md) for coverage, requirements, and cost of each layer. All three suites are free; none spends CSD.

## License

MIT
