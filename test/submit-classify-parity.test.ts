// classifySubmit against the shared submit vectors (test/fixtures/submit-classify-parity.vectors.json): every answer
// shape POST /tx/submit can produce, with this SDK's verdict and the wallet's. The wallet keeps the same file byte for
// byte and pins the same sha256, so a changed copy fails in either repo; each repo asserts its own column. Every
// answer goes through csd-client's real submit, as Chain.send sends it. Offline.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CsdClient } from "@inversealtruism/csd-client";
import { classifySubmit } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"} ${n}`); };

const VECTORS_SHA256 = "000b5246260a2ae9a8a915573306cd48c58d1dcbf26365becaceaad325265952";
const EXPECTED_VECTORS = 91;
type Answer = { status: number; body: string } | { network: true };
type Vector = { id: string; label: string; answer: Answer; sdk: string; wallet: string; differs?: string };

const raw = readFileSync(new URL("./fixtures/submit-classify-parity.vectors.json", import.meta.url));
const got = createHash("sha256").update(raw).digest("hex");
ok(`sha256(submit-classify-parity.vectors.json) is the pinned constant (got ${got.slice(0, 16)}...)`, got === VECTORS_SHA256);
const file = JSON.parse(raw.toString("utf8")) as { family: string; revision: number; vectors: Vector[] };
ok("the file is the submit-classifier family at revision 1", file.family === "submit-classifier" && file.revision === 1);

async function verdictOf(a: Answer): Promise<string> {
  const fetch = (async () => {
    if ("network" in a) throw new TypeError("fetch failed");
    return new Response(a.body, { status: a.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const c = new CsdClient({ baseUrl: "https://rpc.test/api/rpc", fetch });
  try { return classifySubmit({ answer: await c.submit({}) }).verdict; } catch (e) { return classifySubmit({ error: e }).verdict; }
}

let ran = 0;
for (const v of file.vectors) {
  ran++;
  const verdict = await verdictOf(v.answer);
  ok(`${v.id} ${v.label}: ${verdict}${v.differs ? ` (the wallet reads ${v.wallet})` : ""}`, verdict === v.sdk);
}
ok(`ran exactly the pinned number of vectors (${EXPECTED_VECTORS}, got ${ran})`, ran === EXPECTED_VECTORS);
// A refusal tells the sender it may send again from other coins: the node's own texts that can follow admission
// must not be among them.
const notFinished = file.vectors.filter((v) => "status" in v.answer && v.answer.body.includes("submit validation did not finish"));
ok("the node's \"submit validation did not finish\" vector is present and read in flight by both",
  notFinished.length === 1 && notFinished.every((v) => v.sdk === "inflight" && v.wallet === "unclear"));

console.log(`\nsubmit-classify-parity: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
