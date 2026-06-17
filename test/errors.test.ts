// Typed-error tests (Phase 3 DX): stable codes, viem-style fields, walk(), and provider mapping.
import {
  CairnError, NotInstalledError, UserRejectedError, WalletLockedError, UnsupportedMethodError,
  HttpError, ContentVerificationError, mapProviderError, errorCode, SDK_VERSION,
} from "../src/index.js";

declare const process: { exit(code: number): void };
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

console.log("=== CairnError fields ===");
const e = new CairnError("something went wrong", { code: "HTTP_ERROR", docsPath: "/x" });
ok("has the stable code", e.code === "HTTP_ERROR");
ok("shortMessage is the bare message (no footer)", e.shortMessage === "something went wrong");
ok("version is the SDK version", e.version === SDK_VERSION);
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

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
