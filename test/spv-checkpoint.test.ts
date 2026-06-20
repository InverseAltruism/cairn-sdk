// CAIRN-SDK-SPV-CKPT-DUP-1 regression: the SDK's DEFAULT_SPV_CHECKPOINT and cairn /trade swapguard's baked
// `CP` are two independent literals in two repos with no shared module. A drift would make one reject all
// post-checkpoint proofs (fail-closed DoS). This asserts they agree (height + lowercased hash). Skips
// gracefully when the sibling cairn repo isn't checked out (the CI-without-cairn case).
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_SPV_CHECKPOINT } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

const SWAPGUARD = new URL("../../cairn/public/trade/swapguard.js", import.meta.url);
if (!existsSync(SWAPGUARD)) {
  console.log("  ⏭  swapguard.js not present (sibling cairn repo not checked out) — skipping cross-repo equality");
} else {
  const src = readFileSync(SWAPGUARD, "utf8");
  const m = src.match(/const\s+CP\s*=\s*\{\s*height:\s*(\d+)\s*,\s*hash:\s*["']([0-9a-fA-Fx]+)["']/);
  ok("found swapguard CP literal", !!m);
  if (m) {
    ok("checkpoint height matches swapguard", Number(m[1]) === DEFAULT_SPV_CHECKPOINT.height);
    ok("checkpoint hash matches swapguard (lowercased)", m[2]!.toLowerCase() === DEFAULT_SPV_CHECKPOINT.hash.toLowerCase());
  }
}
console.log(`spv-checkpoint: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
