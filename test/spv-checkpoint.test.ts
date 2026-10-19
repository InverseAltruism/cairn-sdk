// DEFAULT_SPV_CHECKPOINT is a block on the chain: its hash is recomputed from a committed header fixture (a verbatim
// /api/headers capture), the header meets its own PoW target, and the fixture's prev-links reach it from the capture's
// first header. A wrong anchor makes the light client reject every proof above it, so this fails on any edit to the
// constant that is not a real block. The fixture is re-captured whenever the checkpoint moves (see CHANGELOG).
// The cairn site carries its own copy of the anchor; that copy is checked in the cairn repository, not read from here.
import { readFileSync, readdirSync } from "node:fs";
import { headerHash, headerHashBytes, powOk, type BlockHeader } from "@inversealtruism/csd-codec";
import { DEFAULT_SPV_CHECKPOINT } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

type Row = { height: number; header: BlockHeader; hash: string };
const FIXTURES = new URL("./fixtures/", import.meta.url);
const CP = DEFAULT_SPV_CHECKPOINT;

const rows = readdirSync(FIXTURES)
  .filter((f) => /^spv-headers-\d+-\d+\.json$/.test(f))
  .map((f) => (JSON.parse(readFileSync(new URL(f, FIXTURES), "utf8")) as { headers: Row[] }).headers)
  .find((hs) => hs.some((r) => r.height === CP.height));

/** True when `hash` is the recomputed hash of a PoW-valid header at `height` that the fixture links to from its start. */
function anchoredInFixture(fixture: Row[], height: number, hash: string): boolean {
  const i = fixture.findIndex((r) => r.height === height);
  if (i < 0) return false;
  for (let k = 1; k <= i; k++) {
    if (fixture[k]!.height !== fixture[k - 1]!.height + 1 || fixture[k]!.header.prev !== headerHash(fixture[k - 1]!.header)) return false;
  }
  const h = fixture[i]!.header;
  return headerHash(h) === hash.toLowerCase() && powOk(headerHashBytes(h), h.bits);
}

if (!rows) {
  ok(`a test/fixtures/spv-headers-*.json capture covers the checkpoint height ${CP.height}`, false);
} else {
  ok(`DEFAULT_SPV_CHECKPOINT (${CP.height}) is a PoW-valid, prev-linked block in the header fixture`, anchoredInFixture(rows, CP.height, CP.hash));
  const flipped = CP.hash.slice(0, -1) + (CP.hash.endsWith("0") ? "1" : "0");
  ok("a checkpoint hash one nibble off is not anchored", !anchoredInFixture(rows, CP.height, flipped));
  ok("the right hash at the wrong height is not anchored", !anchoredInFixture(rows, CP.height + 1, CP.hash));
}
console.log(`spv-checkpoint: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
