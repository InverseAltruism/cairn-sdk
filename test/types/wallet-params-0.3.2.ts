// The dApp param types of src/connect.ts against what cairn-wallet v0.3.2 accepts from a page: the background's
// dispatch (src/background.ts resolvePending) and the handlers it calls (src/core/wallet.ts propose, attest,
// fillOffer, sealClaim, send/sendMany, signInWithCsd; revealClaim(txid)). Optional where the wallet defaults the
// field, present where it reads it, absent where it ignores it. expectSigner, tokenQuote and reservationAck are
// set by the background from the approval window, after the page's params, so they are not dApp params.
// signInWithCsd types its params as unknown and refuses at run time; the shape below is what it accepts.
// pnpm typecheck compiles this file; a type that drifts from the wallet fails it.
import type { AttestParams, CairnProvider, FillParams, ProposeParams, SealClaimParams, SendParams, SiwcParams } from "../../src/connect.js";

type Out = { to: string; value: number };
interface Wallet032 {
  propose: { domain: string; payloadHash: string; uri: string; expiresEpoch: number; fee?: number; outputs?: Out[] };
  attest: { proposalId: string; score: number; confidence: number; fee?: number };
  fillOffer: { proposalId: string; outputs: Out[]; score?: number; confidence?: number; fee?: number };
  sealClaim: { domain?: string; claim: string; fee?: number };
  send: { to: string; amount: number; fee?: number } | { outputs: Out[]; fee?: number };
  signInWithCsd: { nonce: string; statement?: string; uri?: string; expirationSecs?: number; notBeforeSecs?: number; requestId?: string; resources?: string[]; domain?: string };
  revealClaim: string;
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expand<T> = T extends object ? { [K in keyof T]: T[K] } : T;
const same = <T extends true>(): T | undefined => undefined;

export const checks = [
  same<Equal<Expand<ProposeParams>, Expand<Wallet032["propose"]>>>(),
  same<Equal<Expand<AttestParams>, Expand<Wallet032["attest"]>>>(),
  same<Equal<Expand<FillParams>, Expand<Wallet032["fillOffer"]>>>(),
  same<Equal<Expand<SealClaimParams>, Expand<Wallet032["sealClaim"]>>>(),
  same<Equal<Expand<SendParams>, Expand<Wallet032["send"]>>>(),
  same<Equal<Expand<SiwcParams>, Expand<Wallet032["signInWithCsd"]>>>(),
  same<Equal<Parameters<CairnProvider["revealClaim"]>[0], Wallet032["revealClaim"]>>(),
  // the provider methods take exactly these types
  same<Equal<Parameters<CairnProvider["propose"]>[0], ProposeParams>>(),
  same<Equal<Parameters<CairnProvider["attest"]>[0], AttestParams>>(),
  same<Equal<Parameters<CairnProvider["fillOffer"]>[0], FillParams>>(),
  same<Equal<Parameters<CairnProvider["sealClaim"]>[0], SealClaimParams>>(),
  same<Equal<Parameters<CairnProvider["send"]>[0], SendParams>>(),
  same<Equal<Parameters<CairnProvider["signInWithCsd"]>[0], SiwcParams>>(),
];
