// A hand-written snapshot of the codes in cairn-wallet's WALLET-ERROR-CODES.md (both tables), read at the wallet's
// master f695b6f (after v0.3.3), plus FILL_ALREADY_SENT, which the wallet sends from its next release.
// pnpm typecheck compiles this file: a wallet code that src/errors.ts does not name fails it. Nothing here reads the
// wallet; at each wallet release compare the snapshot with its table by hand, as for wallet-params.ts.
import type { KnownCode } from "../../src/errors.js";

type WalletCode =
  | "ACCOUNT_CHANGED" | "APPROVAL_CLOSED" | "BAD_FEE" | "BAD_OUTPUTS" | "BAD_REQUEST" | "FEE_CAP" | "FEE_TOO_LOW"
  | "FILL_ALREADY_SENT" | "FILL_IN_PROGRESS" | "FILL_LEGACY_SUNSET" | "FILL_UNSAFE" | "FILL_WRONG_TARGET"
  | "FIRST_PARTY_ONLY" | "FORBIDDEN" | "GHOST_INPUTS_SKIPPED" | "INSUFFICIENT" | "INTERNAL" | "NO_OUTPUTS"
  | "NOTHING_TO_CONSOLIDATE" | "OFFER_SOURCE_CONFLICT" | "OFFER_UNKNOWN" | "RATE_LIMITED" | "RESERVATION_DENIED"
  | "RESERVATION_UNCONFIRMED" | "REVIEW_REQUIRED" | "RPC_BLOCK_MISMATCH" | "SEAL_NOT_MINED" | "SEAL_UNKNOWN"
  | "SOURCE_DIVERGENCE" | "SUBMIT_DUPLICATE" | "SUBMIT_MAYBE_INFLIGHT" | "SUBMIT_REJECTED" | "TOO_MANY_INPUTS"
  | "UNKNOWN_KIND" | "UNSUPPORTED_METHOD" | "USER_REJECTED" | "VERIFY_HORIZON" | "VERIFY_TAMPER"
  | "VERIFY_UNAVAILABLE" | "VERIFY_UNREPRESENTABLE" | "WALLET_LOCKED" | "WALLET_RELOADED" | "WALLET_UNAVAILABLE"
  | "ZERO_ADDR_REFUSED";

// Not named on purpose: UNKNOWN_KIND reaches a caller as UnsupportedMethodError (code UNSUPPORTED_METHOD), and
// RESERVATION_UNCONFIRMED goes to the wallet's approval window only, never to a page.
type ReportedOtherwise = "UNKNOWN_KIND" | "RESERVATION_UNCONFIRMED";

type Unnamed = Exclude<WalletCode, KnownCode | ReportedOtherwise>;
// Fails to compile, naming the code, when a wallet code is missing from KnownCode.
export const everyWalletCodeNamed: [Unnamed] extends [never] ? true : { unnamed: Unnamed } = true;
