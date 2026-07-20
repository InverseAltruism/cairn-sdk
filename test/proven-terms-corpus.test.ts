// B4b (REBIND W2) corpus + source pins: fillverify's ProvenOfferTerms production is SINGLE-SOURCED
// in the pinned cairnx-core `provenOfferTerms`. The fixture holds every real on-chain offer record
// (55, pre-V16..V24+) plus labeled synthetic envelope variants, each with the terms the OLD
// hand-built producer computed - proven byte-identical to canonical at generation time (0
// divergences over 68). This pins canonical == frozen historical semantics forever, plus source
// pins so an EQUIVALENT hand copy cannot silently return (value-equality alone cannot see one).
//
// Mutations executed at authoring (observed RED, restored): re-add a local terms object literal in
// fillverify.ts -> source pin red; corrupt one fixture entry's expected feeBps -> corpus pin red.
import { provenOfferTerms } from "@inversealtruism/cairnx-core";
import { readFileSync } from "node:fs";

declare const process: { exit(code: number): void };
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

interface Entry { id: string; source: string; height: number; rec: unknown; terms: unknown }
const corpus = JSON.parse(readFileSync(new URL("./fixtures/proven-terms-corpus.json", import.meta.url), "utf8")) as Entry[];
ok("corpus loaded with the full population (68 = 55 real + 13 synthetic)",
  corpus.length === 68 && corpus.filter((e) => e.source === "real").length === 55);

let mismatches = 0;
for (const e of corpus) {
  const got = provenOfferTerms(e.rec, e.height);
  if (JSON.stringify(got) !== JSON.stringify(e.terms)) { mismatches++; console.log(`    MISMATCH ${e.id}`); }
}
ok("canonical provenOfferTerms matches the frozen historical semantics for EVERY corpus entry", mismatches === 0);

const src = readFileSync(new URL("../src/fillverify.ts", import.meta.url), "utf8").replace(/\/\/[^\n]*/g, "");
ok("no local ProvenOfferTerms interface declaration in fillverify.ts (type re-export only)", !/interface ProvenOfferTerms/.test(src));
ok("no object-literal terms construction in fillverify.ts (no `feeBps:` field writes)", !/feeBps:\s/.test(src));
ok("exactly one provenOfferTerms call site in fillverify.ts", (src.match(/provenOfferTerms\(/g) ?? []).length === 1);

console.log(`\nproven-terms-corpus: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
