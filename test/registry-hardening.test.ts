// P75-5 MF-12: the L3 registry reads now run over the SDK's hardened Http (typed HttpError, 15s timeout,
// 16 MiB streamed cap, encoded address segment) instead of csd-registry's raw fetch helpers. Exercised
// BOTH through the Cairn facade (index.ts wires RegistryClient with the hardened indexerHttp) and through
// the legacy { baseUrl, fetch } constructor (which now builds the same hardened transport internally).
import { Cairn, RegistryClient, HttpError } from "../src/index.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log("  FAIL " + n)); };
const grab = async (fn: () => Promise<unknown>): Promise<unknown> => { try { return await fn(); } catch (e) { return e; } };
const jsonRes = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

console.log("P75-5 MF-12 registry hardening:");

// D0 (PAIRED HAPPY-PATH): every read surface returns its shape; both name methods return null on 404.
{
  const stub = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : (input as Request).url ?? input);
    if (/\/explorer\/api\/registry\/gateways$/.test(url)) return jsonRes([{ multiaddr: "/ip4/1.2.3.4", score: 1 }]);
    if (/\/explorer\/api\/registry\/peers$/.test(url)) return jsonRes([{ peerId: "12D3Koo", score: 2 }]);
    if (/\/explorer\/api\/identity\/alice$/.test(url)) return jsonRes({ handle: "alice", address: "0xa", verified: true });
    if (/\/explorer\/api\/address\/0xabc\/identity$/.test(url)) return jsonRes({ handle: "bob", address: "0xabc", verified: true });
    if (/\/explorer\/api\/identity\/nobody$/.test(url)) return new Response("nf", { status: 404 });
    if (/\/explorer\/api\/address\/0xnobody\/identity$/.test(url)) return new Response("nf", { status: 404 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://x.test" }, fetch: stub });
  const g = await cairn.registry.gateways();
  const p = await cairn.registry.peers();
  const rn = await cairn.registry.resolveName("alice");
  const rv = await cairn.registry.reverseName("0xabc");
  const rnn = await cairn.registry.resolveName("nobody");
  const rvn = await cairn.registry.reverseName("0xnobody");
  ok("D0 happy: gateways() returns the ranked array", Array.isArray(g) && (g[0] as { multiaddr?: string })?.multiaddr === "/ip4/1.2.3.4");
  ok("D0 happy: peers() returns the ranked array", Array.isArray(p) && (p[0] as { peerId?: string })?.peerId === "12D3Koo");
  ok("D0 happy: resolveName('alice') hits /identity/alice and returns the object", (rn as { handle?: string })?.handle === "alice");
  ok("D0 happy: reverseName('0xabc') hits /address/0xabc/identity and returns the object", (rv as { handle?: string })?.handle === "bob");
  ok("D0 happy: resolveName 404 -> null (preserved csd-registry contract)", rnn === null);
  ok("D0 happy: reverseName 404 -> null (preserved contract)", rvn === null);
}

// D1: a 500 on a registry read rejects with the SDK's typed HttpError (status preserved), not a bare Error.
{
  const stub = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://x.test" }, fetch: stub });
  const e = await grab(() => cairn.registry.gateways());
  ok("D1: a 500 rejects with a typed HttpError carrying status 500 (not a bare Error)", e instanceof HttpError && (e as HttpError).status === 500);
}

// D2: a 17 MiB response body is refused by the 16 MiB streamed cap (typed HttpError), never parsed.
{
  const big = JSON.stringify({ data: "x".repeat(17 * 1024 * 1024) });
  const stub = (async () => new Response(big, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://x.test" }, fetch: stub });
  const e = await grab(() => cairn.registry.peers());
  ok("D2: a 17 MiB body is REFUSED by the byte cap with a typed HttpError (never fully parsed)", e instanceof HttpError && /response (too large|exceeded)/.test(String((e as Error).message)));
}

// D3: reverseName encodes the address segment, so a traversal payload cannot walk above the base.
{
  const calls: string[] = [];
  const stub = (async (input: RequestInfo | URL) => {
    calls.push(String(typeof input === "string" ? input : (input as Request).url ?? input));
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
  const cairn = new Cairn({ baseUrls: { cairn: "https://x.test" }, fetch: stub });
  await cairn.registry.reverseName("0x../../api/rpc/tip");
  ok("D3: reverseName issues exactly ONE request", calls.length === 1);
  ok("D3: the address segment is URL-encoded (no traversal above the base)",
    calls[0]?.includes("/explorer/api/address/0x..%2F..%2Fapi%2Frpc%2Ftip/identity") === true);
}

// D4: the legacy { baseUrl, fetch } constructor is hardened the same way (typed HttpError on failure).
{
  const stub = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  const reg = new RegistryClient({ baseUrl: "https://x.test", fetch: stub });
  const e = await grab(() => reg.gateways());
  ok("D4: the legacy constructor rejects typed too (HttpError status 500)", e instanceof HttpError && (e as HttpError).status === 500);
}

console.log(`\nregistry-hardening: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
