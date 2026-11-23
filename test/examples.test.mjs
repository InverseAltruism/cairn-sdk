// The examples run from the installed package: they import it by its published name (resolved here to this repo's
// dist/ through the exports map, so `pnpm build` first), they typecheck, the browser sample bundles, and the sample
// server verifies "Sign in with CSD" correctly (single-use nonce, bound to the browser, replay refused), the
// node-signer reports a submit that may have reached the node as in flight, and the two browser samples, bundled and
// run against stub DOM and fetch, keep served text out of markup and tell the user what a timed-out request needs.
// Offline: the server binds 127.0.0.1 on an ephemeral port, every other answer comes from a stub.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { addrFromPriv } from "@inversealtruism/csd-crypto";
import { CSD_CHAIN_MAINNET, rfc3339, signSiwc, SIWC_VERSION } from "@inversealtruism/csd-siwc";
import { Cairn, CairnError, SubmitInFlightError, WalletConnection, errorCode } from "@inversealtruism/cairn-sdk";
import { rpcTxToTx, txid } from "@inversealtruism/cairn-sdk/chain";
import { mockCairnProvider } from "@inversealtruism/cairn-sdk/testing";

let pass = 0, fail = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log("  ✓", name); } catch (e) { fail++; console.log("  ✗", name, "\n      ", e.message); } };

const root = fileURLToPath(new URL("..", import.meta.url));
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "examples"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);

console.log("examples:");
await ok("no example imports this repo's src/ or dist/ by a relative path", () => {
  const relative = /(?:from\s*|import\s*\(\s*)["'](?:\.\.?\/)+(?:src|dist)\//;
  const offenders = tracked.filter((f) => /\.(?:[cm]?[jt]s|html)$/.test(f) && relative.test(readFileSync(join(root, f), "utf8")));
  assert.deepEqual(offenders, []);
});

await ok("the TypeScript examples and the sample server typecheck against the built package (strict)", () => {
  const r = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "examples", "tsconfig.json"), "--listFiles"], { cwd: root, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const listed = new Set(out.split("\n").map((l) => l.trim()));
  for (const f of tracked.filter((x) => x.endsWith(".ts")).concat("examples/integrate-wallet/server.mjs")) assert.ok(listed.has(join(root, f)), `${f} not compiled`);
  assert.ok(listed.has(join(root, "dist", "index.d.ts")), "the package name did not resolve to dist/index.d.ts");
  assert.equal(r.status, 0, out.split("\n").filter((l) => /error TS/.test(l)).join("\n"));
});

await ok("the browser sample bundles with the package resolved by name", async () => {
  const r = await build({ entryPoints: [join(root, "examples/integrate-wallet/app.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, logLevel: "silent" });
  assert.equal(r.errors.length, 0);
  assert.ok(r.outputFiles[0].text.includes("csd:requestProvider"), "the connector is in the bundle");
});

await ok("the module examples load in Node by the package name", async () => {
  for (const f of ["wallet-connect.mjs", "siwc-login.mjs", "node-signer.mjs"]) {
    const m = await import(pathToFileURL(join(root, "examples", f)).href);
    assert.ok(Object.keys(m).length > 0, f);
  }
});

await ok("node-signer: an omitted propose or attest fee gets the node's floor, as the browser wallet's does", async () => {
  const { makeKeyWallet } = await import(pathToFileURL(join(root, "examples", "node-signer.mjs")).href);
  // One coin the stub cannot prove, so every build stops at input verification, after the fee check.
  const cairn = { chain: { client: {}, utxos: async () => ({ utxos: [{ txid: `0x${"aa".repeat(32)}`, vout: 0, value: 10_000_000_000, confirmations: 10, coinbase: false }] }), submit: async () => ({ ok: true }) } };
  const w = makeKeyWallet("11".repeat(32), cairn);
  const calls = [
    ["propose", { domain: "d", payloadHash: `0x${"ab".repeat(32)}`, uri: "u", expiresEpoch: 10 }],
    ["attest", { proposalId: `0x${"ef".repeat(32)}`, score: 80, confidence: 70 }],
  ];
  for (const [method, params] of calls) {
    for (const p of [params, { ...params, fee: 25_000_000 }]) {
      const err = await w[method](p).then(() => null, (e) => String(e.message));
      assert.ok(err !== null && !/fee out of range/.test(err) && /insufficient verifiable balance/.test(err), `${method} ${JSON.stringify(p.fee)}: ${err}`);
    }
  }
});

// A node behind a stub fetch: two coins paying the signer, served with their real txids so verifyInputValues proves
// them. A held transaction's coins leave /utxos, as the node's ?available=true does, and a resend of a held
// transaction answers "already present". `answer(tx, node, json)` replies to the submit of any other transaction.
const SIGNER = "11".repeat(32);
const PAY = { to: `0x${"22".repeat(20)}`, amount: 100_000_000 };
const ECHO = `0x${"ff".repeat(32)}`;
const signerUrl = pathToFileURL(join(root, "examples", "node-signer.mjs")).href;
function stubNode(answer) {
  const owner = addrFromPriv(SIGNER);
  const coins = [1, 2].map((n) => {
    const body = { version: 1, locktime: n, app: { type: "None" }, inputs: [{ prev_txid: `0x${"00".repeat(32)}`, vout: 0, script_sig: "0x" }], outputs: [{ value: 500_000_000, script_pubkey: owner }] };
    return { body, id: txid(rpcTxToTx(body)) };
  });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const spends = (tx) => tx.inputs.map((i) => `0x${Buffer.from(i.prevout.txid).toString("hex")}`).join(",");
  const node = { submitted: [], held: [], mined: new Set(), mineOnResend: null, spends: () => node.submitted.map(spends) };
  node.fetch = async (url, init) => {
    const p = new URL(String(url)).pathname.replace(/^\/api\/rpc/, "");
    if (p.startsWith("/utxos/")) {
      const spent = new Set(node.held.flatMap((t) => spends(t).split(",")));
      const utxos = coins.filter((c) => !spent.has(c.id)).map((c) => ({ txid: c.id, vout: 0, value: 500_000_000, confirmations: 10, coinbase: false }));
      return json(200, { utxos, confirmed_balance: utxos.length * 500_000_000 });
    }
    if (p === "/tip") return json(200, { tip: `0x${"00".repeat(32)}`, height: 200, chainwork: "1" });
    if (p === "/tx/submit") {
      const tx = JSON.parse(init.body).tx;
      node.submitted.push(tx);
      if (node.held.some((t) => JSON.stringify(t) === JSON.stringify(tx))) {
        if (node.mineOnResend) node.mined.add(node.mineOnResend);
        return json(200, { ok: false, err: "already present in mempool" });
      }
      return answer(tx, node, json);
    }
    if (p.startsWith("/tx/")) {
      const id = p.slice(4);
      const coin = coins.find((c) => c.id === id);
      if (coin) return json(200, { ok: true, txid: id, height: 100, tx: coin.body });
      return json(200, node.mined.has(id) ? { ok: true, txid: id, height: 200 } : { ok: false, txid: id });
    }
    return json(404, {});
  };
  return node;
}
// The node takes the transaction, then the proxy answers 502: its few seconds' wait outran the node's ingest.
const ingestThen502 = (tx, node, json) => { node.held.push(tx); return json(502, { error: "node unreachable" }); };
const ingestNoAnswer = (tx, node) => { node.held.push(tx); throw new TypeError("fetch failed"); };
const bodyCap413 = (_tx, _node, json) => json(413, { error: "request body too large" });
const nodeRefusal = (_tx, _node, json) => json(200, { ok: false, err: "fee below the relay floor", txid: ECHO });
const accept = (tx, node, json) => { node.held.push(tx); return json(200, { ok: true, txid: ECHO }); };
async function viaExample(answer, call = (w) => w.send(PAY)) {
  const node = stubNode(answer);
  const { makeKeyWallet } = await import(signerUrl);
  const provider = makeKeyWallet(SIGNER, new Cairn({ fetch: node.fetch }));
  const wallet = new WalletConnection(provider);
  return { node, provider, wallet, ...(await call(wallet).then((r) => ({ r }), (e) => ({ e }))) };
}
async function viaChainSend(answer) {
  const node = stubNode(answer);
  const send = new Cairn({ fetch: node.fetch }).chain.send({ priv: SIGNER, outputs: [{ to: PAY.to, value: PAY.amount }], fee: 1_000_000 });
  return { node, ...(await send.then((r) => ({ r }), (e) => ({ e }))) };
}

// The node takes the transaction, then the task that checked it panics: HTTP 200 with the node's not-finished text.
const ingestThenNotFinished = (tx, node, json) => { node.held.push(tx); return json(200, { ok: false, txid: ECHO, err: "submit validation did not finish: task 12 panicked" }); };
for (const [label, answer] of [["a 502", ingestThen502], ["the node's \"submit validation did not finish\"", ingestThenNotFinished]])
await ok(`node-signer: after ${label} the node took, a caller on the SDK's contract pays once (the same transaction resent, never one from other coins)`, async () => {
  const { node, provider, wallet, e } = await viaExample(answer);
  // The caller: a SubmitInFlightError is settled, never sent anew; any other error broadcast nothing, so it sends again.
  let mined = null;
  if (e instanceof SubmitInFlightError) {
    node.mineOnResend = e.txid;
    mined = await provider.settle(e.txid, { waitMs: 10 });
  } else await wallet.send(PAY).catch(() => null);
  const spends = node.spends();
  assert.equal(new Set(spends).size, 1, `${spends.length} transactions spending different coins: ${spends.join(" | ")} (first error: ${String(e?.message).split("\n")[0]}, code ${errorCode(e)})`);
  assert.ok(e instanceof SubmitInFlightError && e.maybeSent === true && e.code === "SUBMIT_MAYBE_INFLIGHT");
  assert.equal(e.txid, (await viaChainSend(ingestThen502)).e.txid, "the txid is the one Chain.send signs for the same request");
  assert.equal(node.submitted.length, 2, "settle resent once");
  assert.equal(JSON.stringify(node.submitted[1]), JSON.stringify(node.submitted[0]), "the resend is the same signed transaction");
  assert.equal(mined, true);
});

const duplicate = (tx, node, json) => { node.held.push(tx); return json(200, { ok: false, txid: ECHO, err: "already present in mempool" }); };
const missingUtxo = (_tx, _node, json) => json(200, { ok: false, err: "missing utxo", txid: ECHO });
const oddBody = (text) => (tx, node) => { node.held.push(tx); return new Response(text, { status: 200, headers: { "content-type": "application/json" } }); };
await ok("node-signer classifies every submit answer as Chain.send does (one classifier): in flight, duplicate, or sent nothing", async () => {
  const answers = [["502 after ingest", ingestThen502], ["not finished after ingest", ingestThenNotFinished], ["no answer", ingestNoAnswer], ["413 body cap", bodyCap413], ["node refusal", nodeRefusal],
    ["missing utxo", missingUtxo], ["already present", duplicate], ["408", (_t, _n, json) => json(408, {})], ["429", (_t, _n, json) => json(429, {})],
    ...["null", "{}", "[]", "\"ok\"", "{\"ok\":\"maybe\",\"n\":9007199254740993}", "{\"ok\":false}", "{\"ok\":false,\"error\":\"node unreachable\"}"]
      .map((t) => [`2xx ${t}`, oddBody(t)])];
  for (const [name, answer] of answers) {
    const ex = await viaExample(answer);
    const ref = await viaChainSend(answer);
    const inFlight = ref.e instanceof SubmitInFlightError;
    assert.equal(ex.e instanceof SubmitInFlightError, inFlight, `${name}: in flight is ${inFlight} for Chain.send; the example threw ${String(ex.e?.message).split("\n")[0]}`);
    if (inFlight) {
      assert.equal(ex.e.code, ref.e.code, name);
      assert.equal(ex.e.txid, ref.e.txid, name);
    } else {
      // Chain.send throws SUBMIT_REJECTED on a proxy refusal and resolves ok:false on a node refusal: neither broadcast anything.
      assert.ok(errorCode(ref.e) === "SUBMIT_REJECTED" || ref.r?.ok === false, `${name}: Chain.send`);
      assert.ok(ex.e instanceof CairnError && ex.e.maybeSent === undefined && ex.e.code === "SUBMIT_REJECTED", `${name}: the example threw ${errorCode(ex.e)}`);
    }
  }
  // propose and attest submit through the same path: a propose (a token transfer is one) the node took is in flight.
  const post = { domain: "my-app:v1", payloadHash: `0x${"ab".repeat(32)}`, uri: "my-app:post/1", expiresEpoch: 10_000 };
  const pr = await viaExample(ingestThen502, (w) => w.propose(post));
  assert.ok(pr.e instanceof SubmitInFlightError && /^0x[0-9a-f]{64}$/.test(pr.e.txid), `propose: ${String(pr.e?.message).split("\n")[0]}`);
});

await ok("node-signer keeps no copy of the classification: it imports classifySubmit and matches no answer text itself", () => {
  const src = readFileSync(join(root, "examples", "node-signer.mjs"), "utf8");
  assert.match(src, /import \{[^}]*\bclassifySubmit\b[^}]*\} from "@inversealtruism\/cairn-sdk\/chain"/);
  assert.doesNotMatch(src, /\/already present\/|\.terminal\b|JSON\.stringify/);
});

await ok("node-signer: a 2xx body without a verdict that holds an integer above 2^53 is in flight, and settle resends the kept bytes", async () => {
  const { node, provider, e } = await viaExample(oddBody("{\"ok\":\"maybe\",\"n\":9007199254740993}"));
  assert.ok(e instanceof SubmitInFlightError && e.code === "SUBMIT_MAYBE_INFLIGHT", `${e?.constructor?.name}: ${String(e?.message).split("\n")[0]}`);
  node.mineOnResend = e.txid;
  assert.equal(await provider.settle(e.txid, { waitMs: 10 }), true);
  assert.equal(node.submitted.length, 2, "the first submit and one resend of the kept bytes");
  assert.equal(JSON.stringify(node.submitted[1]), JSON.stringify(node.submitted[0]));
});

await ok("node-signer: an accepted submit resolves with the locally signed txid, not the proxy's echo", async () => {
  const ex = await viaExample(accept);
  const ref = await viaChainSend(accept);
  assert.equal(ex.e, undefined, String(ex.e?.message));
  assert.equal(ex.r.txid, ref.r.txid);
  assert.notEqual(ex.r.txid, ECHO);
  assert.equal(ex.node.submitted.length, 1);
});

await ok("node-signer: an HTTP 200 \"already present\" answer is in flight (the proxy failed over to a node that holds it by gossip), and the caller pays once", async () => {
  // The first backend admitted the transaction and gossiped it, then answered too late; the proxy relays the second
  // backend's duplicate answer. Any later, different transaction is accepted.
  let first = true;
  const failoverDuplicate = (tx, node, json) => {
    node.held.push(tx);
    if (!first) return json(200, { ok: true, txid: ECHO });
    first = false;
    return json(200, { ok: false, txid: ECHO, mempool_len: 1, err: "already present in mempool" });
  };
  const { node, provider, wallet, e } = await viaExample(failoverDuplicate);
  let mined = null;
  if (e instanceof SubmitInFlightError) {
    node.mineOnResend = e.txid;
    mined = await provider.settle(e.txid, { waitMs: 10 });
  } else await wallet.send(PAY).catch(() => null);
  const held = node.held.map((t) => t.inputs.map((i) => Buffer.from(i.prevout.txid).toString("hex")).join(","));
  assert.equal(new Set(held).size, 1, `the node holds ${held.length} transactions spending different coins (first error: ${String(e?.message).split("\n")[0]}, code ${errorCode(e)})`);
  assert.ok(e instanceof SubmitInFlightError && e.maybeSent === true && e.code === "SUBMIT_DUPLICATE");
  assert.equal(e.txid, (await viaChainSend(ingestThen502)).e.txid, "the txid is the locally signed one");
  assert.equal(mined, true);
});

await ok("node-signer: settle resolves false when the transaction never appears, builds nothing new, and keeps the bytes for a later call", async () => {
  const { node, provider, e } = await viaExample(ingestThen502);
  assert.ok(e instanceof SubmitInFlightError, String(e?.message));
  assert.equal(await provider.settle(e.txid, { waitMs: 10 }), false);
  assert.equal(node.submitted.length, 2, "the first submit and one resend");
  assert.equal(await provider.settle(e.txid, { waitMs: 10 }), false);
  assert.equal(node.submitted.length, 3, "a later settle resends again: the bytes were kept");
  assert.equal(new Set(node.submitted.map((t) => JSON.stringify(t))).size, 1, "every submit is the same signed transaction");
});

await ok("node-signer: a 2xx body that is not the node's explicit success (null, {}, [], a string) is in flight, not accepted", async () => {
  for (const body of [null, {}, [], "ok"]) {
    const odd = (tx, node, json) => { node.held.push(tx); return json(200, body); };
    const ex = await viaExample(odd);
    assert.ok(ex.e instanceof SubmitInFlightError && ex.e.code === "SUBMIT_MAYBE_INFLIGHT" && /^0x[0-9a-f]{64}$/.test(ex.e.txid),
      `${JSON.stringify(body)}: ${ex.e ? errorCode(ex.e) : `resolved txid ${ex.r?.txid}`}`);
  }
});

console.log("sample server, Sign in with CSD:");
const server = spawn(process.execPath, [join(root, "examples/integrate-wallet/server.mjs")], { env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
try {
  const base = await new Promise((resolve, reject) => {
    let seen = "";
    const t = setTimeout(() => reject(new Error(`no listen line: ${seen}`)), 10_000);
    server.stdout.on("data", (b) => {
      seen += b;
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)\/ \(SIWC domain ([^)]+)\)/.exec(seen);
      if (m) { clearTimeout(t); resolve({ url: m[1], domain: m[2] }); }
    });
    server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  const priv = randomBytes(32).toString("hex");
  const account = addrFromPriv(priv);
  const post = (path, body, cookie = "") => fetch(base.url + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body ?? {}) });
  const nonceFor = async (cookie = "") => {
    const r = await post("/auth/siwc/nonce", {}, cookie);
    return { nonce: (await r.json()).nonce, cookie: cookie || String(r.headers.get("set-cookie")).split(";")[0] };
  };
  const sign = (nonce, domain = base.domain) => {
    const now = Date.now();
    const s = signSiwc({ domain, account, uri: `http://${domain}/`, version: SIWC_VERSION, chainId: CSD_CHAIN_MAINNET, nonce, issuedAt: rfc3339(now), expirationTime: rfc3339(now + 600_000) }, priv);
    return { message: s.message, sig64: s.sig64, pub33: s.pub33 };
  };

  const a = await nonceFor();
  const signed = sign(a.nonce);
  const v = await post("/auth/siwc/verify", signed, a.cookie);
  const vBody = await v.json();
  const sid = String(v.headers.get("set-cookie")).split(";")[0];
  await ok("honest: a signed nonce verifies, the account is the signer's, and the session cookie works", async () => {
    assert.equal(v.status, 200);
    assert.deepEqual(vBody, { ok: true, account });
    const me = await fetch(`${base.url}/auth/me`, { headers: { cookie: sid } });
    assert.deepEqual(await me.json(), { ok: true, account });
  });
  await ok("the same signed message again is refused (the nonce is single-use)", async () => {
    const r = await post("/auth/siwc/verify", signed, a.cookie);
    assert.equal(r.status, 401);
    assert.match((await r.json()).error, /unknown or used nonce/);
  });
  await ok("a nonce verified from another browser is refused", async () => {
    const b = await nonceFor();
    const r = await post("/auth/siwc/verify", sign(b.nonce), "pre=someone-else");
    assert.equal(r.status, 401);
    assert.match((await r.json()).error, /another browser/);
  });
  await ok("a message signed for another site is refused (domain-mismatch)", async () => {
    const c = await nonceFor();
    const r = await post("/auth/siwc/verify", sign(c.nonce, "evil.example"), c.cookie);
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, "domain-mismatch");
  });
  await ok("the page is served; files outside the served list are not", async () => {
    assert.match(await (await fetch(`${base.url}/`)).text(), /Integrate the Cairn Wallet/);
    assert.equal((await fetch(`${base.url}/server.mjs`)).status, 404);
  });
} finally {
  server.kill();
}

console.log("browser samples, bundled and run in Node against stubs:");
// The few DOM calls the two samples make. Serializing a node escapes its text, as a browser does; an innerHTML write
// is kept as written, so markup that reached that sink serializes as markup.
function stubDocument() {
  const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const serialize = (k) => {
    if (typeof k === "string") return escapeText(k);
    if (k.raw !== undefined) return k.raw;
    if (k.tagName === "br") return "<br>";
    return `<${k.tagName}${k.className ? ` class="${k.className}"` : ""}>${k.kids.map(serialize).join("")}</${k.tagName}>`;
  };
  const make = (tagName) => {
    const node = {
      tagName, className: "", value: "", disabled: false, kids: [], handlers: {},
      get textContent() { return node.kids.map((k) => (typeof k === "string" ? k : k.raw ?? k.textContent)).join(""); },
      set textContent(v) { node.kids = [String(v)]; },
      get innerHTML() { return node.kids.map(serialize).join(""); },
      set innerHTML(v) { node.kids = [{ raw: String(v) }]; },
      append(...k) { node.kids.push(...k); },
      replaceChildren(...k) { node.kids = [...k]; },
      addEventListener(type, fn) { node.handlers[type] = fn; },
    };
    return node;
  };
  const byId = new Map();
  return { getElementById: (id) => byId.get(id) ?? byId.set(id, make("div")).get(id), createElement: make };
}
async function runBundle(entry) {
  const out = await build({ entryPoints: [join(root, entry)], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, logLevel: "silent" });
  await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
async function until(cond, what) {
  for (const end = Date.now() + 5_000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (cond()) return;
  throw new Error(`timed out waiting for ${what}`);
}
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;

await ok("hello-csd: a served height that carries markup is written as text", async () => {
  const hostile = '<img src=x onerror="alert(document.domain)">';
  const doc = stubDocument();
  globalThis.document = doc;
  globalThis.fetch = async (url) => {
    const p = new URL(String(url)).pathname;
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (p.endsWith("/api/rpc/tip")) return json({ tip: `0x${"00".repeat(32)}`, height: "<svg onload=alert(1)>", chainwork: "1" });
    if (p.endsWith("/explorer/api/domains")) return json([{ domain: "cairn:v1", proposals: 1 }]);
    if (p.includes("/explorer/api/domain/")) return json([{ txid: `0x${"ab".repeat(32)}`, domain: "cairn:v1", height: hostile, proposer: `0x${"11".repeat(20)}` }]);
    // The live feed: a stream that stays open and sends nothing.
    return new Response(new ReadableStream({ start() { /* never enqueues, never closes */ } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    await runBundle("examples/hello-csd/app.ts");
    const box = doc.getElementById("proposals");
    await until(() => box.kids.length > 0, "the proposals list");
    assert.equal(box.innerHTML,
      '<b>chain tip &lt;svg onload=alert(1)&gt;</b>, recent proposals<br>• <code>0xabababababab…</code> ' +
      '<span class="dim">(cairn:v1, block &lt;img src=x onerror="alert(document.domain)"&gt;)</span>');
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.document;
  }
});

await ok("integrate-wallet: a send that outlasts the timeout tells the user to reject the open request first; the other outcomes read as before", async () => {
  const doc = stubDocument();
  const win = new EventTarget();
  const mock = mockCairnProvider({ address: `0x${"ab".repeat(20)}` });
  const hang = () => new Promise(() => { /* never settles */ });
  const realSend = mock.send;
  win.cairn = mock;
  globalThis.document = doc;
  globalThis.window = win;
  const status = doc.getElementById("status");
  const click = async (id, expect) => {
    status.textContent = "";
    doc.getElementById(id).handlers.click();
    await until(() => status.textContent !== "", `the status after ${id}`);
    assert.match(status.textContent, expect);
  };
  try {
    await runBundle("examples/integrate-wallet/app.ts");
    await until(() => /found/.test(status.textContent), "wallet detection");
    doc.getElementById("send-to").value = `0x${"22".repeat(20)}`;
    doc.getElementById("send-amount").value = "100000000";
    // Only the connection's own timer (10 minutes) is shortened; the wallet never answers this send.
    mock.send = hang;
    globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 600_000 ? 0 : ms, ...a);
    await click("send", /reject[^.]*in the wallet/i);
    globalThis.setTimeout = realSetTimeout;
    mock.send = realSend;
    mock.next("send", { kind: "refuse", code: "SUBMIT_MAYBE_INFLIGHT", txid: `0x${"cd".repeat(32)}` });
    await click("send", /^The transaction may have been sent \(txid 0x(cd){32}\)\. Check your history before you send again\.$/);
    mock.next("send", { kind: "approve", txid: `0x${"ef".repeat(32)}` });
    await click("send", /^Sent, txid 0x(ef){32}\.$/);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    delete globalThis.document;
    delete globalThis.window;
  }
});

console.log(`\nexamples: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
