// A hand-written snapshot of the params the Cairn Wallet accepts from a page, read from cairn-wallet v0.3.3: the
// background's dispatch (src/background.ts resolvePending) and the readers it and src/core/wallet.ts build from
// (src/core/signfields.ts: proposeFields, attestFields, fillFields, sealFields, sendFields, revealFields;
// src/core/siwcparams.ts for signInWithCsd). fillOffer's outputs stay required here although the wallet defaults a
// missing list to empty. Optional where the wallet defaults
// the field, present where it reads it, absent where it ignores it. expectSigner, tokenQuote and reservationAck are
// set by the background from the approval window, after the page's params, so they are not dApp params.
// signInWithCsd types its params as unknown and refuses at run time; the shape below is what it accepts.
// pnpm typecheck compiles this file: an SDK param type in src/connect.ts that differs from the snapshot fails it.
// Nothing here reads the wallet; the snapshot is checked against the wallet by hand at each wallet release.
import type { AttestParams, CairnProvider, FillParams, ProposeParams, SealClaimParams, SendParams, SiwcParams } from "../../src/connect.js";

type Out = { to: string; value: number };
interface WalletParams {
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
  same<Equal<Expand<ProposeParams>, Expand<WalletParams["propose"]>>>(),
  same<Equal<Expand<AttestParams>, Expand<WalletParams["attest"]>>>(),
  same<Equal<Expand<FillParams>, Expand<WalletParams["fillOffer"]>>>(),
  same<Equal<Expand<SealClaimParams>, Expand<WalletParams["sealClaim"]>>>(),
  same<Equal<Expand<SendParams>, Expand<WalletParams["send"]>>>(),
  same<Equal<Expand<SiwcParams>, Expand<WalletParams["signInWithCsd"]>>>(),
  same<Equal<Parameters<CairnProvider["revealClaim"]>[0], WalletParams["revealClaim"]>>(),
];

// getCapabilities().methods of cairn-wallet v0.3.3 (src/inpage.ts; docs/PROVIDER.md: every method of its table
// except signIn). test/testing.test.ts requires the /testing mock to advertise exactly these.
export const WALLET_CAPABILITY_METHODS = ["connect", "getAddress", "signInWithCsd", "getPermissions", "requestPermissions",
  "revokePermissions", "propose", "attest", "send", "fillOffer", "sealClaim", "revealClaim"] as const;
