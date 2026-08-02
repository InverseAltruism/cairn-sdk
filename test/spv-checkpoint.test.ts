// CAIRN-SDK-SPV-CKPT-DUP-1 regression: the SDK's DEFAULT_SPV_CHECKPOINT and cairn /trade swapguard's baked
// `CP` are two independent literals in two repos with no shared module. A drift would make one reject all
// post-checkpoint proofs (fail-closed DoS). This asserts they agree (height + lowercased hash).
//
// I2 (2026-07-17): this guard USED to SKIP (green, zero assertions) when the sibling cairn repo was not
// checked out. The SDK's own CI never checks cairn out, so the parity guard silently provided NO coverage
// and a real drift could hide behind a green skip. Now:
//  - sibling PRESENT (local dev, cairn CI, `pnpm test` on the operator box): ASSERTS -> a real
//    DEFAULT_SPV_CHECKPOINT drift FAILS the build.
//    HONESTY CORRECTION (Plan 75-B C3, 2026-08-02): this suite was described here as gating `npm publish`
//    through prepublishOnly. It does not. `pnpm pack` does not fire prepublishOnly, and publishing a
//    PRE-MADE TARBALL (the sanctioned path here, because the npm 2FA-bypass token cannot publish) fires no
//    hook at all, so nothing in this file runs at publish time. The drift check that IS in the publish
//    path is `scripts/verify-tarball.mjs`: it reads the CP out of the same swapguard.js and compares it to
//    the checkpoint literal inside the PACKED tarball's dist. This suite stays the fast dev/CI drift gate.
//  - sibling ABSENT + CSD_SDK_REQUIRE_PARITY=1: hard FAIL (opt-in strict, for a wired CI).
//  - sibling ABSENT + no flag: LOUD "UNCHECKED" marker to stderr, exit 0. A hard fail here would go
//    PERMANENTLY red on the SDK's own public CI and every fork PR (cairn is private; fork PRs never get
//    the ECOSYSTEM_RO_TOKEN), and a permanently-red CI is its own dead-green rot. Loud-not-silent is the
//    middle ground; the real gate lives where the sibling exists, and at publish time that gate is
//    scripts/verify-tarball.mjs, which FAILS (never skips) when no sibling swapguard.js is found.
// OPERATOR DECISION (still open, plan Batch A): the cleaner long-term home is cairn's CI (public checkout
// of cairn-sdk, both literals present), then drop/demote this test. Until then this is the safe default.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DEFAULT_SPV_CHECKPOINT } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

// Locate cairn's swapguard.js: explicit overrides first, then the default sibling checkout.
const candidates = [
  process.env.CAIRN_SWAPGUARD,
  process.env.CAIRN_REPO && join(process.env.CAIRN_REPO, "public/trade/swapguard.js"),
  fileURLToPath(new URL("../../cairn/public/trade/swapguard.js", import.meta.url)),
].filter((p): p is string => !!p);

const swapguard = candidates.find((p) => existsSync(p));
if (!swapguard) {
  const required = process.env.CSD_SDK_REQUIRE_PARITY === "1";
  console.error("  " + (required ? "❌" : "⚠") + " swapguard.js not found - the SPV-checkpoint parity guard could not run.");
  console.error("     Checked: " + candidates.join(", "));
  console.error("     Check out the sibling cairn repo at ../cairn, or set CAIRN_SWAPGUARD / CAIRN_REPO.");
  if (required) {
    console.error("     CSD_SDK_REQUIRE_PARITY=1: FAILING (a DEFAULT_SPV_CHECKPOINT drift must not hide behind an absent sibling).");
    process.exit(1);
  }
  console.error("     UNCHECKED (I2): not failing here - a hard fail would go permanently red on the SDK's public/fork CI");
  console.error("     (cairn is private; forks never get the token). The real gate is this suite wherever the sibling");
  console.error("     exists (cairn CI, the operator box) plus scripts/verify-tarball.mjs at publish time, which FAILS");
  console.error("     on an absent sibling. Set CSD_SDK_REQUIRE_PARITY=1 to enforce here.");
  process.exit(0);   // loud-unchecked, NEVER a silent green; never a permanent-red on fork CI
}

const src = readFileSync(swapguard, "utf8");
const m = src.match(/const\s+CP\s*=\s*\{\s*height:\s*(\d+)\s*,\s*hash:\s*["']([0-9a-fA-Fx]+)["']/);
ok("found swapguard CP literal", !!m);
if (m) {
  ok("checkpoint height matches swapguard", Number(m[1]) === DEFAULT_SPV_CHECKPOINT.height);
  ok("checkpoint hash matches swapguard (lowercased)", m[2]!.toLowerCase() === DEFAULT_SPV_CHECKPOINT.hash.toLowerCase());
}
console.log(`spv-checkpoint: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
