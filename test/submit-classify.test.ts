// classifySubmit, the one reading of a submit attempt that Chain.send and the node-signer example share: each answer
// a node, a proxy or fetch can produce, with csd-client's real error shapes. Offline.
import { CsdClient, parseJsonExact } from "@inversealtruism/csd-client";
import { classifySubmit, HttpError } from "../src/index.js";
import { classifySubmit as fromChain } from "../src/chain.js";
import { runInNewContext } from "node:vm";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"} ${n}`); };

// What csd-client's submit throws or resolves for a stub answer, so the error shapes are the published client's.
async function viaClient(res: () => Response): Promise<{ answer: unknown } | { error: unknown }> {
  const fetch = (async () => res()) as unknown as typeof globalThis.fetch;
  const c = new CsdClient({ baseUrl: "https://rpc.test/api/rpc", fetch });
  try { return { answer: await c.submit({}) }; } catch (e) { return { error: e }; }
}
const body = (status: number, text: string) => () => new Response(text, { status, headers: { "content-type": "application/json" } });

console.log("classifySubmit:");
ok("exported from the root entry and from /chain, one function", classifySubmit === fromChain);

{
  const v = classifySubmit(await viaClient(body(200, JSON.stringify({ ok: true, txid: "0xab" }))));
  ok("the node's ok:true is accepted", v.verdict === "accepted");
}
{
  const v = classifySubmit(await viaClient(body(200, JSON.stringify({ ok: false, txid: "0xab", err: "already present in mempool" }))));
  ok("the node's \"already present\" is duplicate, with the node's text", v.verdict === "duplicate" && v.detail === "already present in mempool");
  ok("the match ignores case, as the wallet's does", classifySubmit({ answer: { ok: false, err: "Already Present" } }).verdict === "duplicate");
}
// The node's refusal texts; "mempool conflict" (another pending transaction spends these coins) must stay a refusal:
// read as a duplicate it would claim these bytes are held.
for (const err of ["fee below the relay floor", "missing utxo", "mempool conflict: a different pending transaction spends these coins"]) {
  const v = classifySubmit(await viaClient(body(200, JSON.stringify({ ok: false, txid: "0xab", err }))));
  ok(`the node's refusal "${err}" is rejected (not duplicate)`, v.verdict === "rejected" && v.detail === err);
}
// The node writes `err` on every refusal; an ok:false without that string is someone else's body, so no verdict.
for (const answer of [{ ok: false }, { ok: false, err: null }, { ok: false, err: "" }, { ok: false, err: { code: 1 } }, { ok: false, err: 12345678901234567890n }]) {
  ok(`an ok:false without the node's err text is in flight, not rejected (${Object.keys(answer).join(",")}: ${typeof answer.err})`, classifySubmit({ answer }).verdict === "inflight");
}
// The hosted proxy's own 502 bodies, handed on at 200 by a relay that drops the status.
for (const error of ["node unreachable", "the node asked first gave no readable answer and may hold this transaction; check before sending again"]) {
  const v = classifySubmit(await viaClient(body(200, JSON.stringify({ ok: false, error }))));
  ok(`the proxy's body {ok:false,error:"${error.slice(0, 24)}..."} at 200 is in flight`, v.verdict === "inflight");
}

for (const status of [400, 413, 429]) {
  const v = classifySubmit(await viaClient(body(status, JSON.stringify({ error: "x" }))));
  ok(`a proxy's HTTP ${status} (csd-client's terminal error) is rejected with the status`, v.verdict === "rejected" && v.status === status);
}
for (const status of [408, 404, 422, 500, 502, 503, 504]) {
  const v = classifySubmit(await viaClient(body(status, JSON.stringify({ error: "x" }))));
  ok(`HTTP ${status} is in flight`, v.verdict === "inflight" && v.status === status);
}
ok("an HttpError's status is read: 413 rejected, 502 in flight",
  classifySubmit({ error: new HttpError(413, "u") }).verdict === "rejected" && classifySubmit({ error: new HttpError(502, "u") }).verdict === "inflight");
ok("csd-client's terminal flag alone, without a status, is in flight",
  classifySubmit({ error: Object.assign(new Error("refused"), { terminal: true }) }).verdict === "inflight");
ok("an \"HTTP 400\" inside another message is not read as a status",
  classifySubmit({ error: Object.assign(new Error("upstream said HTTP 400"), { terminal: true }) }).verdict === "inflight");
{
  const noAnswer = await viaClient(() => { throw new TypeError("fetch failed"); });
  ok("no answer (fetch failed) is in flight", classifySubmit(noAnswer).verdict === "inflight");
  const timeout = await viaClient(() => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
  ok("a timeout is in flight", classifySubmit(timeout).verdict === "inflight");
  const notJson = await viaClient(body(200, "OK"));
  ok("a 2xx body that is not JSON is in flight", classifySubmit(notJson).verdict === "inflight");
  ok("a thrown non-Error value is in flight", classifySubmit({ error: "boom" }).verdict === "inflight" && classifySubmit({ error: null }).verdict === "inflight");
}
for (const text of ["null", "{}", "[]", "\"ok\"", "1", "true", "{\"ok\":\"true\"}", "{\"ok\":1}", "{\"txid\":\"0xab\"}"]) {
  const v = classifySubmit(await viaClient(body(200, text)));
  ok(`the 2xx body ${text} has no verdict: in flight`, v.verdict === "inflight" && v.detail.length > 0);
}
{
  // csd-client parses integers above 2^53 exactly, as bigint; describing such a body must not throw.
  const parsed = parseJsonExact("{\"ok\":\"maybe\",\"n\":9007199254740993}") as { n: unknown };
  ok("the fixture holds a bigint", typeof parsed.n === "bigint");
  let threw = false, v;
  try { v = classifySubmit({ answer: parsed }); } catch { threw = true; }
  ok("a body without a verdict that holds a bigint is in flight, without a throw", !threw && v?.verdict === "inflight");
  ok("a bigint answer itself is in flight", classifySubmit({ answer: 5n }).verdict === "inflight");
}
{
  // A fetch Response carries `ok` on its prototype: it is not a parsed body and gives no node verdict.
  const responses = [new Response(JSON.stringify({ ok: false, err: "x" }), { status: 200 }), new Response("<html></html>", { status: 200 }),
    new Response(null, { status: 204 }), new Response("bad gateway", { status: 502 }), new Response("", { status: 504 }), new Response("", { status: 408 })];
  ok("a fetch Response passed as the answer is in flight, whatever its status", responses.every((r) => classifySubmit({ answer: r }).verdict === "inflight"));
  ok("an object that inherits ok:true or ok:false is in flight",
    classifySubmit({ answer: Object.create({ ok: true }) }).verdict === "inflight" && classifySubmit({ answer: Object.create({ ok: false, err: "x" }) }).verdict === "inflight");
  // Honest: a body parsed in another realm (a test sandbox) has another Object.prototype and still reads its verdict.
  const foreign = runInNewContext('({ ok: true, txid: "0xab" })') as unknown;
  const foreignRefusal = runInNewContext('({ ok: false, err: "missing utxo" })') as unknown;
  ok("a body parsed in another realm keeps its verdict (accepted, rejected)",
    classifySubmit({ answer: foreign }).verdict === "accepted" && classifySubmit({ answer: foreignRefusal }).verdict === "rejected");
}
{
  // Totality over what can be thrown and over a malformed argument.
  const getter = new Error("x");
  Object.defineProperty(getter, "message", { get() { throw new Error("getter"); } });
  const inputs: unknown[] = [{ error: Object.create(null) }, { error: getter }, { answer: Object.assign(Object.create(null), { ok: false, err: Object.create(null) }) }, null, undefined, 7];
  const out = inputs.map((i) => { try { return classifySubmit(i as Parameters<typeof classifySubmit>[0]).verdict; } catch (e) { return `threw ${(e as Error).message}`; } });
  ok("a thrown null-prototype object, a throwing message getter, a null-prototype body and a malformed argument read in flight, no throw",
    out.every((v) => v === "inflight") || (console.log(`    ${out.join(" | ")}`), false));
}

console.log(`\nsubmit-classify: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
