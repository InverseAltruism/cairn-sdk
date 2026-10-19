#!/usr/bin/env node
// Fails when a tracked .md outside docs/archive/ contains an em dash (U+2014), or when tracked code reads a
// sibling checkout (a parent-relative cairn* or csd-* directory, or the host's absolute checkout root). Docs may
// name those paths; only code is checked for them. Run: node scripts/check-dashes-paths.mjs [repo root]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Code allowed to read a sibling checkout, each with its reason.
export const PATH_EXCEPTIONS = {
  "scripts/live-wallet-ui.mjs": "maintainer-run live harness (AGENTS.md); loads the built wallet from the host checkout unless WALLET_EXT is set",
  "scripts/names-buy-e2e.mjs": "maintainer-run live harness (AGENTS.md, spends CSD); loads the built wallet from the host checkout unless WALLET_EXT is set",
  "scripts/names-e2e.mjs": "maintainer-run live harness (AGENTS.md, spends CSD); loads the built wallet from the host checkout unless WALLET_EXT is set",
  "scripts/ux-live-readonly.mjs": "maintainer-run live harness (AGENTS.md); loads the built wallet from a fixed host path",
  "scripts/ux-openlane-buy.mjs": "maintainer-run live harness (AGENTS.md, spends CSD); loads the built wallet from a fixed host path",
  "scripts/wallet-send-spv-e2e.mjs": "maintainer-run live harness (AGENTS.md, spends CSD); loads the built wallet from a fixed host path",
  "test/e2e/e2e-wallet-connect.mjs": "opt-in `test:live:wallet`; loads the sibling wallet build unless WALLET_EXT is set",
  "test/e2e/e2e-siwc.mjs": "opt-in e2e helper (AGENTS.md); imports csd-siwc, the wallet build and the cairn console from the host checkouts",
  "test/check-dashes-paths.test.mjs": "fixtures for this check",
};

const SIBLING = /\.\.\/(?:cairn[a-z-]*|csd-[a-z-]+)(?![\w.])|\/opt\/cairn_substrate\//;
const CODE = /\.(?:[cm]?js|[cm]?ts|tsx|sh|json|ya?ml|html)$/;

export function offences(root) {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const out = [];
  for (const f of files) {
    const isDoc = f.endsWith(".md") && !f.startsWith("docs/archive/");
    const isCode = CODE.test(f) && !(f in PATH_EXCEPTIONS);
    if (!isDoc && !isCode) continue;
    const text = readFileSync(join(root, f), "utf8");
    if (isDoc && text.includes("\u2014")) out.push(`${f}: em dash (U+2014)`);
    if (isCode && SIBLING.test(text)) out.push(`${f}: reads a sibling checkout (${text.match(SIBLING)[0]})`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = offences(resolve(process.argv[2] ?? "."));
  for (const line of found) console.error(line);
  console.log(found.length === 0 ? "check-dashes-paths: clean" : `check-dashes-paths: ${found.length} offence(s)`);
  process.exit(found.length === 0 ? 0 : 1);
}
