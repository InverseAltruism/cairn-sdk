// The type contract of the fill pre-verify verdict: tsc over test/types/ (the root tsconfig covers src/ only,
// and tsx does not type-check). `OfferFillCheck.terms` must stay MintedProvenOfferTerms so a dApp can pass it
// back to cairnx-core 0.2.0's default `bindOfferTerms` call, and the re-exported `bindOfferTerms` must still
// refuse hand-built terms without `{ give: false, wantType: false }`.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "test", "types", "fillverify-terms.ts");
const r = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "test", "types", "tsconfig.json"), "--listFiles"], { cwd: root, encoding: "utf8" });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
const errors = out.split("\n").filter((l) => /error TS\d+/.test(l));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"} ${n}`); };
console.log("fill pre-verify types (tsc over test/types):");
ok("tsc checked the fixture (it is in the compiled file list)", out.split("\n").some((l) => l.trim() === fixture));
ok("the fixture compiles: terms pass to the default bindOfferTerms; hand-built terms still need the opt-out", r.status === 0 && errors.length === 0);
if (errors.length) console.log(errors.map((l) => `      ${l}`).join("\n"));
console.log(`\nfillverify-types: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
