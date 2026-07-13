// Typed errors for the Cairn SDK. The wallet connector maps the provider's string error replies
// ({ ok:false, error }) onto these so dApp code can branch on `instanceof` OR on a stable machine
// `code` (string-matching the human message is brittle). Modeled on viem's BaseError: every error
// carries a stable `code`, a `shortMessage`, an optional `docsPath`, the SDK `version`, and `.walk()`
// to inspect the cause chain.

/** Stable machine-readable error codes (branch on these, not the message text). */
export type CairnErrorCode =
  | "NOT_INSTALLED"
  | "USER_REJECTED"
  | "WALLET_LOCKED"
  | "UNSUPPORTED_METHOD"
  | "HTTP_ERROR"
  | "CONTENT_VERIFICATION"
  // native wallet codes (0.2.46+): relayed verbatim when the provider supplies them
  | "ACCOUNT_CHANGED"
  | "FIRST_PARTY_ONLY"
  | "RATE_LIMITED"
  | "APPROVAL_CLOSED"
  | "FORBIDDEN"
  | "INTERNAL"
  | "UNKNOWN";

// Kept in sync with package.json `version` (the build has no JSON import; bump both together). SDK-VERSION-DRIFT:
// errors.test.ts now asserts SDK_VERSION === package.json.version (the old test compared the constant to itself).
export const SDK_VERSION = "0.2.3";
const DOCS_BASE = "https://cairn-substrate.com/docs/sdk";

export interface CairnErrorOptions {
  code?: CairnErrorCode;
  docsPath?: string;
  cause?: unknown;
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
 * Map a provider error reply onto a typed error. Wallet 0.2.46+ sends a stable machine `code`
 * next to the human `error` string — that is the PREFERRED branch (B10; UX copy may change).
 * The string matching below stays as the fallback for pre-0.2.46 wallets.
 */
const NATIVE_CODES = new Set<CairnErrorCode>(["ACCOUNT_CHANGED", "FIRST_PARTY_ONLY", "RATE_LIMITED", "APPROVAL_CLOSED", "FORBIDDEN", "INTERNAL"]);
export function mapProviderError(error: string, code?: string): CairnError {
  if (code === "USER_REJECTED" || code === "APPROVAL_CLOSED") return new UserRejectedError(error);
  if (code === "WALLET_LOCKED") return new WalletLockedError(error);
  if (code === "UNSUPPORTED_METHOD" || code === "UNKNOWN_KIND") return new UnsupportedMethodError(error);
  if (code && NATIVE_CODES.has(code as CairnErrorCode)) return new CairnError(error || code, { code: code as CairnErrorCode });
  const e = String(error || "").toLowerCase();
  if (e.includes("rejected by user")) return new UserRejectedError(error);
  if (e.includes("wallet locked")) return new WalletLockedError(error);
  if (e.includes("unsupported dapp method") || e.includes("predates") || e.includes("too old")) return new UnsupportedMethodError(error);
  return new CairnError(error || "Unknown wallet error");
}

/** Convenience: the stable code of any error (or "UNKNOWN" for a non-CairnError). */
export function errorCode(err: unknown): CairnErrorCode {
  return err instanceof CairnError ? err.code : "UNKNOWN";
}
