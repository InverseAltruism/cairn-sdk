// A hand-written snapshot of the params the Cairn Wallet accepts from a page, read from cairn-wallet v0.3.2: the
// background's dispatch (src/background.ts resolvePending) and the handlers it calls (src/core/wallet.ts propose,
// attest, fillOffer, sealClaim, send/sendMany, signInWithCsd; revealClaim(txid)). Optional where the wallet defaults
// the field, present where it reads it, absent where it ignores it. expectSigner, tokenQuote and reservationAck are
// set by the background from the approval window, after the page's params, so they are not dApp params.
// signInWithCsd types its params as unknown and refuses at run time; the shape below is what it accepts.
// pnpm typecheck compiles this file: an SDK param type in src/connect.ts that differs from the snapshot fails it.
// Nothing here reads the wallet; the snapshot is checked against the wallet by hand at each wallet release.
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
];
