// B4b (REBIND W2) corpus + source pins: fillverify's ProvenOfferTerms production is SINGLE-SOURCED
// in the pinned cairnx-core `provenOfferTerms`. The fixture holds every real on-chain offer record
// (55, pre-V16..V24+) plus labeled synthetic envelope variants, each with the terms the OLD
// hand-built producer computed - proven byte-identical to canonical at generation time (0
// divergences over 68). This pins canonical == frozen historical semantics forever, plus source
// pins so an EQUIVALENT hand copy cannot silently return (value-equality alone cannot see one).
//
// B7b (REBIND W2/W7): consuming the 0.1.40 cairnx-core, provenOfferTerms now ALSO emits the additive
// give legs (giveTicker/giveAmount/giveName) + wantType. The fixture was regenerated ONCE against the
// new producer, and the regen ABORTED unless the pre-B6 fields (height/feeBps/value/taker/bid/min)
// stayed byte-identical across all 68 entries - i.e. it PROVED B6 additive (0 drift) before writing.
// The committed fixture now pins the full (existing + additive) canonical output forward.
//
// Mutations executed at authoring (observed RED, restored): re-add a local terms object literal in
// fillverify.ts -> source pin red; corrupt one fixture entry's expected feeBps -> corpus pin red.
import { provenOfferTerms } from "@inversealtruism/cairnx-core";
import { readFileSync } from "node:fs";

declare const process: { exit(code: number): void };
let pass = 0, fail = 0;
// The runtime vacuous-assertion guard the .mjs twins carry (G6 referee R1): this file is outside
// tsconfig include, so tsc never enforces the `c: boolean` annotation, and tsx does not typecheck.
// Throw on a function condition so a future `ok(name, () => ...)` regression goes RED, not silently green.
const ok = (n: string, c: boolean) => {
  if (typeof c === "function") throw new Error(`vacuous assertion (function passed as cond): ${n}`);
  c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n));
};

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
// B7b: the sums seam constructs an OfferState for the single-sourced fillOutputPlan, whose feeBps is the
// PINNED producer's own output (`terms.feeBps`). That single reference is the ONLY feeBps write allowed -
// any LOCALLY-DERIVED feeBps (`feeBps: feeBpsAt(...)`, a literal, an inline branch) would be re-deriving the
// consensus fee and re-opens the hand-copy class this pin exists to forbid.
const feeWrites = (src.match(/feeBps:\s*[^,;}\n]+/g) ?? []).map((w) => w.trim());
ok("no LOCALLY-DERIVED feeBps in fillverify.ts (only the single-sourced `terms.feeBps` reference is allowed)",
  feeWrites.every((w) => /^feeBps:\s*terms\.feeBps$/.test(w)));
ok("exactly one provenOfferTerms call site in fillverify.ts", (src.match(/provenOfferTerms\(/g) ?? []).length === 1);

console.log(`\nproven-terms-corpus: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
