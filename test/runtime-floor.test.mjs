// package.json declares a Node floor whose JSON.parse hands a reviver the source text. csd-client reads a u64
// exactly only through it; without it one integer at or above 2^53 in a block makes every tx in that block
// unverifiable through the SDK. CI runs the floor's own major, so the second case checks that line has it.
// Run: pnpm exec tsx test/runtime-floor.test.mjs   (offline)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const floor = Number(/^>=\s*(\d+)(?:\.\d+){0,2}$/.exec(pkg.engines?.node ?? "")?.[1]);

ok("package.json declares engines.node >=22 or higher", () => {
  assert.ok(floor >= 22, `engines.node is ${JSON.stringify(pkg.engines?.node)}`);
});
ok("this Node meets the floor and its JSON.parse hands the reviver the source text", () => {
  assert.ok(Number(process.versions.node.split(".")[0]) >= floor, `node ${process.versions.node}, floor ${floor}`);
  assert.equal(JSON.parse("9007199254740993", (_k, _v, ctx) => ctx?.source), "9007199254740993");
});

console.log(`runtime-floor: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
