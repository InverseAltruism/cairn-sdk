// SPV transient-vs-STRUCTURAL classifier REFUSAL-PARITY vectors (Plan 75-A section 7.3),
// cairn-sdk copy = spvIsTransient in src/index.ts.
//
// The classifier is hand-maintained in THREE places: this repo's src/index.ts (spvIsTransient),
// cairn-wallet/src/core/namespv.ts (isTransientSyncError), and cairn/public/trade/swapguard.js (the
// inline regex in ensureSyncedTo). They were ported by hand from one another and have already diverged.
//
// Mechanism (exactly as 7.3 mandates): ONE committed JSON vector file, DUPLICATED byte-for-byte into
// each repo (a cross-repo checkout does not exist in CI, the MF-27 lesson), and each repo's test
// asserts BOTH
//   (a) sha256(vectors.json) == the pinned constant, so a DRIFTED COPY of the vector file reds, and
//   (b) the LOCAL twin classifies every vector the way the vector file says.
// This pins test DATA across repos. It is deliberately NOT a cross-repo byte-identity test on the
// implementations: three models vetoed that.
//
// Why this matters, in money terms: transient means KEEP the verified header cache and fail closed;
// structural means WIPE it and cold-reseed from the pinned checkpoint (withSpvReseed). Calling a
// transport blip structural is the DOS-HDR-3 reseed storm. Calling a chain fault transient wedges the
// client on an orphaned tip.
//
// HARNESS: spvIsTransient is module-private, so this file READS src/index.ts, extracts the two regex
// LITERALS verbatim, and pins the exact combining body. Extraction is strict: a missing or duplicated
// anchor is a hard FAILURE, never a skip, and a reworded body reds so the harness gets re-derived
// instead of silently drifting away from the code it claims to gate.
//
// Mutations executed at authoring (observed RED, restored):
//   - neuter SPV_TRANSIENT_JSON_RE in src/index.ts to a never-matching literal (the swapguard state:
//     no JSON arm at all) -> SPV-3 and SPV-4 go RED, 10 passed / 3 failed.
//   - rewire the combining body from `||` to `&&`, regexes untouched -> the source pin goes RED,
//     11 passed / 2 failed. This is the leg that proves the harness cannot drift away from the code.
//   - flip one byte of test/fixtures/spv-transient-parity.vectors.json -> the sha pin goes RED.
// Recorded because it is instructive: dropping `non-dense` does NOT red SPV-5, and dropping the
// `token` alternative does NOT red SPV-3/SPV-4, because those producer strings ALSO match `headers`
// and `json` respectively. Each vector pins a CLASSIFICATION, not one keyword.
//
// Run: node test/spv-transient-parity.test.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

let pass = 0, fail = 0;
// Vacuous-assertion guard: throw if a function is passed as the condition (always truthy).
const ok = (n, c) => {
  if (typeof c === "function") throw new Error(`vacuous assertion (function passed as cond): ${n}`);
  c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n));
};

// (a) THE VECTOR-FILE PIN. Identical constant in all three repos: whichever copy drifts, that repo reds.
const VECTORS_SHA256 = "013a9b54ac694a202338af680dc66b5e38d3cbe9cf3c18d318ac44a627061cc4";
const VECTORS_PATH = new URL("./fixtures/spv-transient-parity.vectors.json", import.meta.url);
const EXPECTED_LEGS = 7;

console.log("=== (a) the committed vector file is the one this repo was pinned against ===");
const raw = readFileSync(VECTORS_PATH);
const gotSha = createHash("sha256").update(raw).digest("hex");
ok(`sha256(spv-transient-parity.vectors.json) == the pinned constant (got ${gotSha.slice(0, 16)}...)`, gotSha === VECTORS_SHA256);
const V = JSON.parse(raw.toString("utf8"));
ok("the vector file is the spv-transient-classifier family at the pinned revision",
  V.family === "spv-transient-classifier" && V.revision === 1);

console.log("=== the harness reads the LIVE classifier out of src/index.ts ===");
const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
// Strict extraction: exactly one declaration each, or the harness is stale and must be re-derived.
const one = (name) => {
  const hits = src.split(`const ${name} = `).length - 1;
  if (hits !== 1) throw new Error(`spv-transient-parity: expected exactly 1 \`const ${name} =\` in src/index.ts, found ${hits}. The classifier moved or was duplicated: re-derive this harness, do not delete it.`);
  const m = src.match(new RegExp(`^const ${name} = (/.+/[a-z]*);$`, "m"));
  if (!m) throw new Error(`spv-transient-parity: \`const ${name}\` is no longer a single-line regex literal in src/index.ts. Re-derive this harness.`);
  return m[1];
};
const lit = (l) => new RegExp(l.slice(1, l.lastIndexOf("/")), l.slice(l.lastIndexOf("/") + 1));
const RE_MAIN = lit(one("SPV_TRANSIENT_RE"));
const RE_JSON = lit(one("SPV_TRANSIENT_JSON_RE"));
ok(`extracted SPV_TRANSIENT_RE from source: ${RE_MAIN}`, RE_MAIN instanceof RegExp);
ok(`extracted SPV_TRANSIENT_JSON_RE from source: ${RE_JSON}`, RE_JSON instanceof RegExp);

// Source pin on the COMBINING body: the harness below reproduces `RE_MAIN.test || RE_JSON.test`, so if
// spvIsTransient ever combines them differently (an && , an extra guard, a different message read) this
// pin reds and the harness is re-derived rather than quietly testing something the code no longer does.
const BODY = [
  "const spvIsTransient = (e: unknown): boolean => {",
  "  const msg = String((e as Error)?.message || e);",
  "  return SPV_TRANSIENT_RE.test(msg) || SPV_TRANSIENT_JSON_RE.test(msg);",
  "};",
].join("\n");
ok("source pin: spvIsTransient still ORs the two extracted regexes over String(e.message || e)", src.includes(BODY));
const classify = (msg) => (RE_MAIN.test(msg) || RE_JSON.test(msg) ? "transient" : "structural");

console.log("=== (b) the LOCAL twin classifies every vector as the corpus says ===");
let legs = 0;
for (const v of V.vectors) {
  legs++;
  const cls = classify(v.message);
  ok(`${v.id} ${v.class.toUpperCase()}: ${v.label} [${JSON.stringify(v.message)} -> ${cls}]`, cls === v.class);
}

console.log("=== the corpus was actually exercised (a gate that runs nothing is not a gate) ===");
ok(`executed exactly the pinned number of vectors (${EXPECTED_LEGS}, got ${legs})`, legs === EXPECTED_LEGS);

console.log(`\nspv transient-parity: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
