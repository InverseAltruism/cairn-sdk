# cairn-sdk test suite

Four layers, fastest → most involved. All exercise the **built `dist/`** (run `pnpm build` first) so they test what actually ships.

| Suite | Command | Cost | What it proves |
|---|---|---|---|
| **Unit** | `pnpm test` | free, offline | Connector error mapping, client paths, content + merkle verification reject tampered inputs (mock fetch + mock provider, real merkle fixtures). 34 checks. |
| **Live read** | `pnpm test:e2e:read` | free | Every read surface vs mainnet (chain/board/index/content/registry), trust-minimized `verifyInclusion`, self-certifying content, live SSE, **+ adversarial**: bogus inclusion → not-found, unknown content → null, tamper → rejected. 25 checks. |
| **Wallet connector** | `pnpm test:e2e:wallet` | free | Real Chromium + the real Cairn Wallet extension + the real SDK connector under Xvfb: connect → approval window → address; **repeat is silent (consented)**; **send still prompts (signing never auto-approves)**; list + revoke connected sites. 16 checks. |
| **Live write** | `pnpm test:e2e:write` | **spends ~0.30 CSD** | Full pipeline through the SDK: build+sign+submit → `board.propose` → content register → indexer index → content self-cert → `verifyInclusion` of our own tx → `board.support`. Needs a funded key. |

`pnpm test:e2e` runs read + wallet (both free). `pnpm test:all` runs everything except the funded write.

## Requirements

- **read**: network access to `cairn-substrate.com`.
- **wallet**: a built `../cairn-wallet/dist` (`node build.mjs` in the wallet repo), cached Chromium, and `Xvfb`. Override the browser with `CHROME=/path/to/chrome`.
- **write**: a funded CSD key at `~/.config/cairn/key.json` (`{ "privkey": "0x…" }`) or `CAIRN_KEY=/path`. Spends real fees. Depends on chain mining speed, the mine-waits allow up to 20 min because block times are variable; if the chain is congested the run may time out with the tx still pending in the mempool (funds are not lost; the change confirms once it mines). `verify-pending-write.mjs [txidPrefix]` re-verifies an already-submitted propose once it mines, without spending again.

## The node-signer

`examples/node-signer.mjs` is a server/bot `CairnProvider` backed by a raw key (built on the SDK's own `chain` primitives). The write e2e uses it to drive the exact same `cairn.board.propose()/support()` code paths a browser dApp drives through the wallet, so one pipeline is proven for both the browser and backend developer paths.
