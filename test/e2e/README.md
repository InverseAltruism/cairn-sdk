# cairn-sdk test suite

Three layers, fastest → most involved. All exercise the **built `dist/`** (run `pnpm build` first) so they test what actually ships.

| Suite | Command | Cost | What it proves |
|---|---|---|---|
| **Unit** | `pnpm test` | free, offline | Connector error mapping, client paths, content + merkle verification reject tampered inputs (mock fetch + mock provider, real merkle fixtures). 34 checks. |
| **Live read** | `pnpm test:live` | free | Every read surface vs mainnet (chain/index/content), trust-minimized `verifyInclusion` (a recent proposal and a near-tip tx, which runs the reorg re-check), self-certifying content, live SSE, **+ adversarial**: bogus inclusion → not-found, unknown content → null, tamper → rejected. `CAIRN_BASE=http://127.0.0.1:7777` points it at another front door. |
| **Wallet connector** | `pnpm test:live:wallet` | free | Real Chromium + the real Cairn Wallet extension + the real SDK connector under Xvfb: connect → approval window → address; **repeat is silent (consented)**; **send still prompts (signing never auto-approves)**; list + revoke connected sites. 16 checks. |

`pnpm test:all` runs unit, live read and wallet (all free).

## Requirements

- **read**: network access to `cairn-substrate.com`.
- **wallet**: a built `../cairn-wallet/dist` (`node build.mjs` in the wallet repo; `WALLET_EXT` points elsewhere), cached Chromium, and `Xvfb`. Override the browser with `CHROME=/path/to/chrome`.

## The node-signer

`examples/node-signer.mjs` is a server/bot `CairnProvider` backed by a raw key (built on the SDK's own `chain` primitives), so a backend drives the same `WalletConnection` calls a browser dApp drives through the wallet. No e2e layer spends CSD.
