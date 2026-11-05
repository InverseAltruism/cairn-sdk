// Typed errors for the Cairn SDK. The wallet connector maps the provider's string error replies
// ({ ok:false, error }) onto these so dApp code can branch on `instanceof` OR on a stable machine
// `code` (string-matching the human message is brittle). Modeled on viem's BaseError: every error
// carries a stable `code`, a `shortMessage`, an optional `docsPath`, the SDK `version`, and `.walk()`
// to inspect the cause chain.

import type { NodeTxJson } from "@inversealtruism/csd-tx";

/** Stable machine-readable error codes (branch on these, not the message text). */
export type CairnErrorCode =
  | "NOT_INSTALLED"
  | "USER_REJECTED"
  | "WALLET_LOCKED"
  | "UNSUPPORTED_METHOD"
  | "HTTP_ERROR"
  | "CONTENT_VERIFICATION"
  | "CONTENT_NOT_JSON"
  // native wallet codes (0.2.46+): relayed verbatim when the provider supplies them
  | "ACCOUNT_CHANGED"
  | "FIRST_PARTY_ONLY"
  | "RATE_LIMITED"
  | "APPROVAL_CLOSED"
  | "FORBIDDEN"
  | "INTERNAL"
  // nested SubmitResult codes (wallet 0.2.54+): a tx method's INNER {ok:false} fund-safety/refusal contract
  // (F14). Through 0.2.53 only the outer envelope carried a code; these ride the inner `result` of send /
  // propose / attest / fillOffer / sealClaim / revealClaim. WALLET-ERROR-CODES.md in the cairn-wallet repo is
  // canonical. Three buckets: DEFINITIVE fund-safety refusals (retryable=false, nothing was sent), TRANSIENT
  // (retryable=true, nothing was sent), and AMBIGUOUS-INFLIGHT (SubmitInFlightError, maybe sent; carries the
  // txid when the wallet knows it).
  | "GHOST_INPUTS_SKIPPED"
  | "VERIFY_UNAVAILABLE"
  | "VERIFY_TAMPER"
  | "INSUFFICIENT"
  | "TOO_MANY_INPUTS"
  | "FEE_TOO_LOW"
  | "FEE_CAP"
  | "BAD_FEE"
  | "ZERO_ADDR_REFUSED"
  | "BAD_OUTPUTS"
  | "NO_OUTPUTS"
  | "BAD_REQUEST"
  | "OFFER_UNKNOWN"
  | "FILL_UNSAFE"
  | "FILL_WRONG_TARGET"
  | "SOURCE_DIVERGENCE"
  | "SUBMIT_REJECTED"
  | "SUBMIT_MAYBE_INFLIGHT"
  | "SUBMIT_DUPLICATE"
  | "NOTHING_TO_CONSOLIDATE"
  // wallet 0.2.62+ codes listed in WALLET-ERROR-CODES.md (SEAL_NOT_MINED since 0.2.74, RESERVATION_DENIED and
  // RPC_BLOCK_MISMATCH since 0.2.99)
  | "OFFER_SOURCE_CONFLICT"
  | "FILL_LEGACY_SUNSET"
  | "VERIFY_HORIZON"
  | "VERIFY_UNREPRESENTABLE"
  | "WALLET_UNAVAILABLE"
  | "REVIEW_REQUIRED"
  | "SEAL_NOT_MINED"
  | "RESERVATION_DENIED"
  | "RPC_BLOCK_MISMATCH"
  // SDK-side: a write method that outlasted the connection timeout (the wallet may still send it)
  | "WALLET_TIMEOUT"
  | "UNKNOWN";

// Kept in sync with package.json `version` (the build has no JSON import; bump both together). SDK-VERSION-DRIFT:
// errors.test.ts now asserts SDK_VERSION === package.json.version (the old test compared the constant to itself).
export const SDK_VERSION = "0.8.1";
const DOCS_BASE = "https://cairn-substrate.com/docs/sdk";

export interface CairnErrorOptions {
  code?: CairnErrorCode;
  docsPath?: string;
  cause?: unknown;
  /**
   * Whether a dApp may safely AUTO-retry this failure without fresh user intent. Transient infra faults
   * (e.g. a node that was briefly unreachable, nothing signed) are `true`; fund-safety refusals are `false`.
   * Defaults to `false` (fail-closed: never invite a retry unless the error is provably transient).
   */
  retryable?: boolean;
}

export class CairnError extends Error {
  /** Stable machine code for programmatic branching. */
  readonly code: CairnErrorCode;
  /** The human message without the appended docs/version footer. */
  readonly shortMessage: string;
  /** Relative docs path (under the SDK docs base), if any. */
  readonly docsPath?: string;
  /** The cairn-sdk version that produced this error. */
  readonly version = SDK_VERSION;
  /**
   * Whether a dApp may safely AUTO-retry this failure. `false` for fund-safety refusals and user-intent
   * declines (the default); `true` only for provably transient infra faults where nothing was signed.
   * A `SubmitInFlightError` is `false` too: reconcile its `txid`, never blind-retry.
   */
  readonly retryable: boolean;

  constructor(shortMessage: string, opts: CairnErrorOptions = {}) {
    const docs = opts.docsPath;
    super(
      [shortMessage, docs ? `Docs: ${DOCS_BASE}${docs}` : "", `Version: cairn-sdk@${SDK_VERSION}`]
        .filter(Boolean)
        .join("\n"),
      { cause: opts.cause },
    );
    this.name = new.target.name;
    this.code = opts.code ?? "UNKNOWN";
    this.shortMessage = shortMessage;
    this.docsPath = docs;
    this.retryable = opts.retryable ?? false;
  }

  /**
   * Walk the `cause` chain. With a predicate, returns the FIRST matching error (or null). Without one,
   * returns the DEEPEST cause (the root). Mirrors viem's `BaseError.walk()`.
   */
  walk(fn?: (err: unknown) => boolean): unknown {
    let current: unknown = this;
    let last: unknown = this;
    while (current != null) {
      if (fn && fn(current)) return current;
      last = current;
      current = (current as { cause?: unknown })?.cause;
    }
    return fn ? null : last;
  }
}

/** The Cairn Wallet extension is not installed (no `window.cairn` appeared). */
export class NotInstalledError extends CairnError {
  constructor(message = "Cairn Wallet not detected. Install it from cairn-substrate.com.") {
    super(message, { code: "NOT_INSTALLED", docsPath: "/install" });
  }
}

/** The user rejected the request in the wallet's approval window. */
export class UserRejectedError extends CairnError {
  constructor(message = "Request rejected by user.") {
    super(message, { code: "USER_REJECTED", docsPath: "/errors#user-rejected" });
  }
}

/** The wallet is locked; the user must unlock it before approving. */
export class WalletLockedError extends CairnError {
  constructor(message = "Wallet is locked.") {
    super(message, { code: "WALLET_LOCKED", docsPath: "/errors#wallet-locked" });
  }
}

/** The method is not exposed to dApps by the wallet boundary (or the wallet is too old for it). */
export class UnsupportedMethodError extends CairnError {
  constructor(message = "Method not supported by the wallet.") {
    super(message, { code: "UNSUPPORTED_METHOD", docsPath: "/errors#unsupported-method" });
  }
}

/** An HTTP request to a Cairn service failed (network or non-2xx). */
export class HttpError extends CairnError {
  status: number;
  url: string;
  body?: string;
  constructor(status: number, url: string, body?: string) {
    super(`HTTP ${status} for ${url}${body ? `: ${String(body).slice(0, 200)}` : ""}`, { code: "HTTP_ERROR" });
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** Self-certification failed: received bytes do not hash to the expected payload hash. */
export class ContentVerificationError extends CairnError {
  expected: string;
  constructor(expected: string) {
    super(`Content does not match its payload hash ${expected} — bytes were tampered with in transit.`, { code: "CONTENT_VERIFICATION", docsPath: "/content#verification" });
    this.expected = expected;
  }
}

/**
 * The outcome of a write is AMBIGUOUS: the tx MAY already be in the mempool. Thrown by the write wrappers for
 * the nested `SUBMIT_MAYBE_INFLIGHT` (request threw / timed out / 5xx gateway / unreadable body) and
 * `SUBMIT_DUPLICATE` (node answered "already present or mempool conflict") codes, for `WALLET_UNAVAILABLE` on a
 * write (the page lost the wallet's reply, which may come after the submit), for `WALLET_TIMEOUT` (the call
 * outlasted the connection timeout while the request stays open in the wallet), and by `Chain.send` when the
 * submit request fails after signing. It CARRIES the locally-computed consensus `txid` when one is known so a
 * dApp can RECONCILE (check the explorer / balance) instead of blindly re-broadcasting, which would re-invite
 * the double-broadcast this contract exists to prevent (F14). It is NOT retryable (`retryable === false`);
 * `maybeSent === true` distinguishes it from a definitely-not-sent terminal refusal. See WALLET-ERROR-CODES.md
 * in the cairn-wallet repo.
 */
export class SubmitInFlightError extends CairnError {
  /** The locally-computed consensus txid to reconcile against the chain (undefined when it is not known). */
  readonly txid?: string;
  /** The signed transaction, set only when `Chain.send` threw this (a wallet write keeps it in the wallet).
   *  `chain.submit(nodeJson)` resends it unchanged: the same coins under the same txid, so it cannot pay twice,
   *  where a new send may select other coins. */
  readonly nodeJson?: NodeTxJson;
  /** Always true: the tx MAY be in the mempool. Reconcile via `txid` or the balance; never blind-retry. */
  readonly maybeSent = true;
  constructor(message: string, code: "SUBMIT_MAYBE_INFLIGHT" | "SUBMIT_DUPLICATE" | "WALLET_UNAVAILABLE" | "WALLET_TIMEOUT", txid?: string, cause?: unknown, nodeJson?: NodeTxJson) {
    super(message, { code, docsPath: "/errors#submit-inflight", retryable: false, cause });
    this.txid = txid;
    this.nodeJson = nodeJson;
  }
}

/**
 * Map a provider error reply onto a typed error. Wallet 0.2.46+ sends a stable machine `code`
 * next to the human `error` string — that is the PREFERRED branch (B10; UX copy may change).
 * The string matching below stays as the fallback for pre-0.2.46 wallets.
 */
// B7c (REBIND, cairn-sdk LOW): the DEAD entries were removed. `APPROVAL_CLOSED` is already mapped to
// UserRejectedError at the top of mapProviderError, and `ACCOUNT_CHANGED` is in NESTED_TERMINAL (checked
// first), so NEITHER could ever reach this set's branch below - both were unreachable dead code. The
// remaining four are the genuine native-relayed codes with no earlier handler.
const NATIVE_CODES = new Set<CairnErrorCode>(["FIRST_PARTY_ONLY", "RATE_LIMITED", "FORBIDDEN", "INTERNAL"]);

// F14: nested SubmitResult codes (wallet 0.2.54+) classified into buckets. TRANSIENT = nothing was sent,
// safe to auto-retry shortly. TERMINAL = a definitive fund-safety / validation refusal, nothing was sent, no
// auto-retry. The AMBIGUOUS-INFLIGHT codes are handled separately by mapSubmitResultError and
// mapWriteProviderError because they must carry the txid (SubmitInFlightError). WALLET-ERROR-CODES.md is canonical.
// WALLET_UNAVAILABLE is transient for a call that sends nothing (connect, getAddress) and in flight on a write.
const NESTED_TRANSIENT = new Set<CairnErrorCode>(["VERIFY_UNAVAILABLE", "OFFER_UNKNOWN", "WALLET_UNAVAILABLE", "REVIEW_REQUIRED", "SEAL_NOT_MINED"]);
const NESTED_TERMINAL = new Set<CairnErrorCode>([
  "FILL_UNSAFE", "FILL_WRONG_TARGET", "SOURCE_DIVERGENCE", "VERIFY_TAMPER", "SUBMIT_REJECTED",
  "BAD_REQUEST", "BAD_FEE", "BAD_OUTPUTS", "NO_OUTPUTS", "ZERO_ADDR_REFUSED", "TOO_MANY_INPUTS",
  "INSUFFICIENT", "FEE_CAP", "FEE_TOO_LOW", "ACCOUNT_CHANGED", "GHOST_INPUTS_SKIPPED", "NOTHING_TO_CONSOLIDATE",
  "OFFER_SOURCE_CONFLICT", "FILL_LEGACY_SUNSET", "VERIFY_HORIZON", "VERIFY_UNREPRESENTABLE",
  "RESERVATION_DENIED", "RPC_BLOCK_MISMATCH",
]);

export function mapProviderError(error: string, code?: string): CairnError {
  if (code === "USER_REJECTED" || code === "APPROVAL_CLOSED") return new UserRejectedError(error);
  if (code === "WALLET_LOCKED") return new WalletLockedError(error);
  if (code === "UNSUPPORTED_METHOD" || code === "UNKNOWN_KIND") return new UnsupportedMethodError(error);
  // F14: nested SubmitResult fund-safety codes. Transient -> retryable; every other nested refusal -> terminal
  // (retryable=false). The inflight/duplicate pair is routed through mapSubmitResultError so its txid survives.
  if (code && NESTED_TRANSIENT.has(code as CairnErrorCode)) return new CairnError(error || code, { code: code as CairnErrorCode, retryable: true });
  if (code && NESTED_TERMINAL.has(code as CairnErrorCode)) return new CairnError(error || code, { code: code as CairnErrorCode, retryable: false });
  if (code && NATIVE_CODES.has(code as CairnErrorCode)) return new CairnError(error || code, { code: code as CairnErrorCode });
  const e = String(error || "").toLowerCase();
  if (e.includes("rejected by user")) return new UserRejectedError(error);
  if (e.includes("wallet locked")) return new WalletLockedError(error);
  if (e.includes("unsupported dapp method") || e.includes("predates") || e.includes("too old")) return new UnsupportedMethodError(error);
  return new CairnError(error || "Unknown wallet error");
}

/**
 * F14: map a NESTED SubmitResult refusal (`{ ok:false, code, error, txid }`, ridden inside an outer-ok reply)
 * onto a typed error the write wrappers THROW. Without this a fund-safety refusal would RESOLVE with a phantom
 * `txid:undefined`, so a dApp doing `const { txid } = await fillOffer(...); markPaid(txid)` marks a REFUSED
 * fill as paid. Three buckets:
 *   - AMBIGUOUS-INFLIGHT (`SUBMIT_MAYBE_INFLIGHT` / `SUBMIT_DUPLICATE` / `WALLET_UNAVAILABLE`): a
 *     `SubmitInFlightError` that CARRIES the locally-computed `txid` when given, to reconcile (never blind-retry).
 *   - TRANSIENT (`VERIFY_UNAVAILABLE` / `OFFER_UNKNOWN` / `REVIEW_REQUIRED`): `retryable === true` (nothing sent;
 *     retry shortly).
 *   - DEFINITIVE fund-safety refusal (everything else, incl. an unknown / absent code): `retryable === false`.
 * Fail-closed: an explicit `ok:false` with no recognized code still throws a non-retryable refusal.
 */
export function mapSubmitResultError(result: { ok?: boolean; code?: string; error?: string; txid?: string }): CairnError {
  const code = result?.code;
  const msg = (typeof result?.error === "string" && result.error) || code || "The wallet refused the transaction.";
  if (code === "SUBMIT_MAYBE_INFLIGHT" || code === "SUBMIT_DUPLICATE" || code === "WALLET_UNAVAILABLE") {
    return new SubmitInFlightError(msg, code, typeof result?.txid === "string" ? result.txid : undefined);
  }
  // Delegate the classification to mapProviderError (transient -> retryable, everything else -> terminal /
  // fail-closed). A codeless nested refusal falls through to a non-retryable CairnError, never a resolve.
  return mapProviderError(msg, code);
}

/**
 * Map a write method's OUTER refusal (`{ ok:false, error, code }`). As mapProviderError, except that
 * `WALLET_UNAVAILABLE` is maybe-sent: the wallet's content script answers it when the page lost the channel to
 * the extension, which it cannot tell apart from a loss after the background submitted the approved write.
 */
export function mapWriteProviderError(error: string, code?: string): CairnError {
  if (code === "WALLET_UNAVAILABLE") return new SubmitInFlightError(error || code, code);
  return mapProviderError(error, code);
}

/** Convenience: the stable code of any error (or "UNKNOWN" for a non-CairnError). */
export function errorCode(err: unknown): CairnErrorCode {
  return err instanceof CairnError ? err.code : "UNKNOWN";
}
