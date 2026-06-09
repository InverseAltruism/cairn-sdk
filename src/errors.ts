// Typed errors for the Cairn SDK. The wallet connector maps the provider's
// string error replies ({ ok:false, error }) onto these so dApp code can branch
// on `instanceof` instead of string-matching.

export class CairnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The Cairn Wallet extension is not installed (no `window.cairn` appeared). */
export class NotInstalledError extends CairnError {
  constructor(message = "Cairn Wallet not detected. Install it from cairn-substrate.com.") {
    super(message);
  }
}

/** The user rejected the request in the wallet's approval window. */
export class UserRejectedError extends CairnError {
  constructor(message = "Request rejected by user.") {
    super(message);
  }
}

/** The wallet is locked; the user must unlock it before approving. */
export class WalletLockedError extends CairnError {
  constructor(message = "Wallet is locked.") {
    super(message);
  }
}

/** The method is not exposed to dApps by the wallet boundary. */
export class UnsupportedMethodError extends CairnError {
  constructor(message = "Method not supported by the wallet.") {
    super(message);
  }
}

/** An HTTP request to a Cairn service failed (network or non-2xx). */
export class HttpError extends CairnError {
  status: number;
  url: string;
  body?: string;
  constructor(status: number, url: string, body?: string) {
    super(`HTTP ${status} for ${url}${body ? `: ${String(body).slice(0, 200)}` : ""}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** Self-certification failed: received bytes do not hash to the expected payload hash. */
export class ContentVerificationError extends CairnError {
  expected: string;
  constructor(expected: string) {
    super(`Content does not match its payload hash ${expected} — bytes were tampered with in transit.`);
    this.expected = expected;
  }
}

/**
 * Map a provider error string (from the wallet's `{ ok:false, error }`) onto a
 * typed error. The wallet's strings are stable: "rejected by user",
 * "wallet locked", "unsupported dApp method: …".
 */
export function mapProviderError(error: string): CairnError {
  const e = String(error || "").toLowerCase();
  if (e.includes("rejected by user")) return new UserRejectedError(error);
  if (e.includes("wallet locked")) return new WalletLockedError(error);
  if (e.includes("unsupported dapp method")) return new UnsupportedMethodError(error);
  return new CairnError(error || "Unknown wallet error");
}
