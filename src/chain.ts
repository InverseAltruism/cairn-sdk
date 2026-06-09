// Chain layer — re-exports the published csd-* primitives and provides a `Chain`
// helper wired to a Compute Substrate node RPC (defaults to the public Cairn proxy
// at /api/rpc, so a dApp needs no local node).
//
// Everything here is browser-safe (the csd-* packages have zero node: imports).

export {
  CsdClient,
  rpcTxToTx,
  rpcHeaderToHeader,
} from "@inversealtruism/csd-client";
export type {
  ClientOptions,
  RpcTip,
  RpcBlock,
  RpcTxJson,
  RpcHeaderJson,
  RpcUtxo,
  RpcUtxos,
  RpcSubmit,
} from "@inversealtruism/csd-client";

// Transaction builders (build + sign send/propose/attest entirely client-side).
export {
  selectInputs,
  txSize,
  txToNodeJson,
  signTx,
  buildSend,
  buildPropose,
  buildAttest,
} from "@inversealtruism/csd-tx";
export type { Utxo, Selection, Signed, BuildResult } from "@inversealtruism/csd-tx";

// Codec: canonical content hashing, tx/header serialization, merkle proof verification.
export {
  payloadHash,
  canonicalJson,
  verifyContentBytes,
  txid,
  sighash,
  serialize,
  deserialize,
  strippedTx,
  merkleRoot,
  merkleBranch,
  verifyMerkleProof,
  headerHash,
  hb,
  hx,
  strip0x,
  sha256d,
} from "@inversealtruism/csd-codec";
export type { Tx, TxInput, TxOutput, App, BlockHeader } from "@inversealtruism/csd-codec";

// Crypto: keygen, address derivation, low-S signing/verification.
export {
  keygen,
  pubFromPriv,
  addrFromPriv,
  addrFromPub,
  hash160,
  isValidAddr,
  isValidPriv,
  signDigest,
  verifyDigest,
  randomNonce,
  ADDR_RE,
} from "@inversealtruism/csd-crypto";

// Light client: headers-first PoW/LWMA/chainwork verification + merkle inclusion.
export { LightClient, expectedBits, expectedBitsFromWindow } from "@inversealtruism/csd-light";
export type { VerifiedHeader, InclusionResult, ReorgResult, TrustLevel } from "@inversealtruism/csd-light";

import { CsdClient } from "@inversealtruism/csd-client";
import { LightClient } from "@inversealtruism/csd-light";
import type { FetchLike } from "./http.js";

export interface ChainOptions {
  /** Node RPC base URL — defaults to the public Cairn proxy (no local node needed). */
  rpcUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Convenience handle over a CSD node RPC. `client` is the full typed RPC client;
 * `light()` lazily builds a verifying light client over the same endpoint.
 */
export class Chain {
  readonly client: CsdClient;
  private readonly opts: ChainOptions;
  private _light: LightClient | null = null;

  constructor(opts: ChainOptions) {
    this.opts = opts;
    this.client = new CsdClient({ baseUrl: opts.rpcUrl, fetch: opts.fetch, timeoutMs: opts.timeoutMs });
  }

  /** Current chain tip ({ tip, height, chainwork }). */
  tip() {
    return this.client.tip();
  }

  /** Spendable UTXOs + confirmed balance for an address. */
  utxos(addr: string) {
    return this.client.utxos(addr);
  }

  /** Submit a signed transaction (node-shaped JSON from `signTx().nodeJson`). */
  submit(nodeJsonTx: unknown) {
    return this.client.submit(nodeJsonTx);
  }

  /** A verifying light client over the same RPC (built once, reused). */
  light(): LightClient {
    if (!this._light) {
      this._light = new LightClient({ client: this.client });
    }
    return this._light;
  }
}
