// Typed-error tests (Phase 3 DX): stable codes, viem-style fields, walk(), and provider mapping.
import {
  CairnError, NotInstalledError, UserRejectedError, WalletLockedError, UnsupportedMethodError,
  HttpError, ContentVerificationError, SubmitInFlightError, mapProviderError, mapSubmitResultError,
  errorCode, SDK_VERSION,
} from "../src/index.js";
import { readFileSync } from "node:fs";

declare const process: { exit(code: number): void };
const pkgVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

console.log("=== CairnError fields ===");
const e = new CairnError("something went wrong", { code: "HTTP_ERROR", docsPath: "/x" });
ok("has the stable code", e.code === "HTTP_ERROR");
ok("shortMessage is the bare message (no footer)", e.shortMessage === "something went wrong");
ok("version is the SDK version", e.version === SDK_VERSION);
// SDK-VERSION-DRIFT: SDK_VERSION MUST equal package.json (was a tautology comparing the constant to itself).
ok("SDK_VERSION === package.json version (no drift)", SDK_VERSION === pkgVersion);
ok("full message appends docs + version footer", e.message.includes("something went wrong") && e.message.includes("Docs:") && e.message.includes(`cairn-sdk@${SDK_VERSION}`));
ok("is an Error + a CairnError", e instanceof Error && e instanceof CairnError);

console.log("=== subclasses ===");
ok("NotInstalledError code+name", new NotInstalledError().code === "NOT_INSTALLED" && new NotInstalledError().name === "NotInstalledError");
ok("UserRejectedError code", new UserRejectedError().code === "USER_REJECTED");
ok("WalletLockedError code", new WalletLockedError().code === "WALLET_LOCKED");
ok("UnsupportedMethodError code", new UnsupportedMethodError().code === "UNSUPPORTED_METHOD");
const he = new HttpError(503, "https://x/y", "down");
ok("HttpError keeps status/url + code", he.code === "HTTP_ERROR" && he.status === 503 && he.url === "https://x/y");
ok("ContentVerificationError keeps expected + code", new ContentVerificationError("0xhash").code === "CONTENT_VERIFICATION" && new ContentVerificationError("0xhash").expected === "0xhash");

console.log("=== walk() the cause chain ===");
const root = new HttpError(500, "https://api/x");
const wrapped = new CairnError("connect failed", { cause: root });
ok("walk(predicate) finds the matching cause", wrapped.walk((x) => x instanceof HttpError) === root);
ok("walk(predicate) returns null when no match", wrapped.walk((x) => x instanceof WalletLockedError) === null);
ok("walk() (no predicate) returns the deepest cause", wrapped.walk() === root);
ok("walk() on a leaf returns itself", root.walk() === root);

console.log("=== mapProviderError + errorCode ===");
ok("'rejected by user' → USER_REJECTED", mapProviderError("rejected by user").code === "USER_REJECTED");
ok("'wallet locked' → WALLET_LOCKED", mapProviderError("wallet locked").code === "WALLET_LOCKED");
ok("'unsupported dApp method: x' → UNSUPPORTED_METHOD", mapProviderError("unsupported dApp method: x").code === "UNSUPPORTED_METHOD");
ok("'…predates Sign-in-with-CSD' → UNSUPPORTED_METHOD", mapProviderError("this wallet predates Sign-in-with-CSD").code === "UNSUPPORTED_METHOD");
ok("unknown string → UNKNOWN", mapProviderError("weird backend error").code === "UNKNOWN");
ok("errorCode(CairnError) returns its code", errorCode(new WalletLockedError()) === "WALLET_LOCKED");
ok("errorCode(plain Error) → UNKNOWN", errorCode(new Error("x")) === "UNKNOWN");

console.log("=== F14: nested SubmitResult code buckets ===");
// DEFINITIVE fund-safety refusals -> code preserved, retryable === false.
for (const code of ["FILL_UNSAFE", "FILL_WRONG_TARGET", "SOURCE_DIVERGENCE", "VERIFY_TAMPER", "SUBMIT_REJECTED",
  "BAD_REQUEST", "BAD_FEE", "BAD_OUTPUTS", "NO_OUTPUTS", "ZERO_ADDR_REFUSED", "TOO_MANY_INPUTS", "INSUFFICIENT",
  "FEE_CAP", "FEE_TOO_LOW", "ACCOUNT_CHANGED", "GHOST_INPUTS_SKIPPED", "NOTHING_TO_CONSOLIDATE"]) {
  const e = mapSubmitResultError({ ok: false, code, error: `${code} refusal` });
  ok(`${code} -> terminal (code preserved, retryable=false)`, e.code === code && e.retryable === false && !(e instanceof SubmitInFlightError));
}
// TRANSIENT -> retryable === true.
for (const code of ["VERIFY_UNAVAILABLE", "OFFER_UNKNOWN"]) {
  const e = mapSubmitResultError({ ok: false, code, error: `${code} transient` });
  ok(`${code} -> transient (retryable=true)`, e.code === code && e.retryable === true);
}
// AMBIGUOUS-INFLIGHT -> SubmitInFlightError that carries the txid; NOT retryable; maybeSent.
for (const code of ["SUBMIT_MAYBE_INFLIGHT", "SUBMIT_DUPLICATE"]) {
  const e = mapSubmitResultError({ ok: false, code, txid: "0xabc", error: `${code} ambiguous` });
  ok(`${code} -> SubmitInFlightError carrying the txid, not retryable`,
    e instanceof SubmitInFlightError && e.code === code && e.txid === "0xabc" && (e as SubmitInFlightError).maybeSent === true && e.retryable === false);
}
// A missing txid does not fabricate one (undefined, still reconcilable-by-explicit-absence).
ok("SUBMIT_MAYBE_INFLIGHT without a txid -> txid undefined", (mapSubmitResultError({ ok: false, code: "SUBMIT_MAYBE_INFLIGHT" }) as SubmitInFlightError).txid === undefined);
// Fail-closed: an explicit ok:false with NO code still throws a non-retryable refusal (never resolves).
ok("codeless nested refusal -> non-retryable CairnError (fail closed)", mapSubmitResultError({ ok: false, error: "no code here" }).retryable === false);
// mapProviderError itself classifies the nested codes (the finding's 'extend mapProviderError' requirement).
ok("mapProviderError classifies FILL_UNSAFE terminal", mapProviderError("x", "FILL_UNSAFE").retryable === false && mapProviderError("x", "FILL_UNSAFE").code === "FILL_UNSAFE");
ok("mapProviderError classifies VERIFY_UNAVAILABLE transient", mapProviderError("x", "VERIFY_UNAVAILABLE").retryable === true);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
