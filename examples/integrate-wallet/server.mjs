// The relying-party half of the integration sample: serves the page and verifies "Sign in with CSD".
//   node examples/integrate-wallet/server.mjs        (after `pnpm build:example`; PORT and SIWC_DOMAIN optional)
// The nonce is single-use and bound to the browser that asked for it; the signature proves control of the account
// once, and the server then issues its own session cookie. The signature is never a credential.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { CSD_CHAIN_MAINNET, generateNonce, parseSiwcMessage, verifySiwc } from "@inversealtruism/csd-siwc";

const HOST = "127.0.0.1"; // the wallet injects on http only for localhost and 127.0.0.1; anything else needs https
const PORT = Number(process.env.PORT ?? 4173);
/** @type {Record<string, { file: string, type: string } | undefined>} */
const FILES = { "/": { file: "index.html", type: "text/html; charset=utf-8" }, "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" } };
const NONCE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 30 * 60_000;
let siwcDomain = process.env.SIWC_DOMAIN ?? ""; // host[:port] the page is served from; set after listen otherwise

/** @type {Map<string, { exp: number, browser: string }>} nonce -> expiry and the pre-login cookie it was issued to */
const nonces = new Map();
/** @type {Map<string, { account: string, exp: number }>} session id -> account */
const sessions = new Map();

/** @param {import("node:http").IncomingMessage} req @param {string} name */
const cookie = (req, name) => (req.headers.cookie ?? "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1] ?? "";
/** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};
// Add `; Secure` to both cookies when the site is served over https (every deployment but this loopback sample).
const COOKIE_FLAGS = "HttpOnly; SameSite=Strict; Path=/";

/** @param {import("node:http").IncomingMessage} req @returns {Promise<Record<string, unknown>>} */
const readJson = (req) => new Promise((resolve, reject) => {
  /** @type {Buffer[]} */ const chunks = [];
  let size = 0;
  req.on("data", (c) => { size += c.length; if (size > 16_384) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
  req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
  req.on("error", reject);
});

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  try {
    if (req.method === "POST" && path === "/auth/siwc/nonce") {
      const browser = cookie(req, "pre") || randomBytes(16).toString("hex");
      const nonce = generateNonce();
      nonces.set(nonce, { exp: Date.now() + NONCE_TTL_MS, browser });
      return json(res, 200, { nonce }, { "set-cookie": `pre=${browser}; ${COOKIE_FLAGS}` });
    }
    if (req.method === "POST" && path === "/auth/siwc/verify") {
      const { message, sig64, pub33 } = await readJson(req);
      if (typeof message !== "string" || typeof sig64 !== "string" || typeof pub33 !== "string") return json(res, 400, { ok: false, error: "missing fields" });
      const parsed = parseSiwcMessage(message);
      if (!parsed) return json(res, 400, { ok: false, error: "malformed message" });
      // Look the nonce up in this server's own store first: verifySiwc only compares the message with what it is
      // given, so passing it the nonce read from the message alone would accept a replay.
      const issued = nonces.get(parsed.nonce);
      if (!issued) return json(res, 401, { ok: false, error: "unknown or used nonce" });
      nonces.delete(parsed.nonce);
      if (issued.exp < Date.now()) return json(res, 401, { ok: false, error: "nonce expired" });
      if (issued.browser !== cookie(req, "pre")) return json(res, 401, { ok: false, error: "nonce issued to another browser" });
      const v = verifySiwc({ message, sig64, pub33 }, { domain: siwcDomain, nonce: parsed.nonce, chainId: CSD_CHAIN_MAINNET });
      if (!v.ok) return json(res, 401, { ok: false, error: v.reason });
      const sid = randomBytes(24).toString("hex");
      sessions.set(sid, { account: v.account, exp: Date.now() + SESSION_TTL_MS });
      return json(res, 200, { ok: true, account: v.account }, { "set-cookie": `sid=${sid}; ${COOKIE_FLAGS}; Max-Age=${SESSION_TTL_MS / 1000}` });
    }
    if (req.method === "GET" && path === "/auth/me") {
      const s = sessions.get(cookie(req, "sid"));
      if (!s || s.exp < Date.now()) return json(res, 401, { ok: false });
      return json(res, 200, { ok: true, account: s.account });
    }
    const served = req.method === "GET" ? FILES[path] : undefined;
    if (!served) return json(res, 404, { ok: false, error: "not found" });
    const body = await readFile(fileURLToPath(new URL(served.file, import.meta.url)));
    res.writeHead(200, { "content-type": served.type, "cache-control": "no-store" });
    res.end(body);
  } catch (e) {
    json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : PORT;
  if (!siwcDomain) siwcDomain = `${HOST}:${port}`;
  console.log(`listening on http://${HOST}:${port}/ (SIWC domain ${siwcDomain})`);
});
