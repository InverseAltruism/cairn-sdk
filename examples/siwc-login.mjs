// "Sign in with CSD" (SIWC) — end-to-end reference for third-party sites.
//
// SIWC is audience-bound, replay-resistant wallet auth (CAIP-122 / EIP-4361 style). The wallet binds
// the REAL requesting origin + your single-use server nonce into the signed message and returns ONLY
// the signed artifact. You verify it SERVER-SIDE and then issue your OWN session — the signature is
// proof-of-control, NEVER a bearer token. A signature made for another site (or reused) is rejected.
//
// Two halves below: CLIENT (browser, Cairn Wallet installed) and SERVER (your Node backend).
// Install: client → @inversealtruism/cairn-sdk ; server → @inversealtruism/csd-siwc

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT (browser)
// ─────────────────────────────────────────────────────────────────────────────
import { getWallet, errorCode } from "@inversealtruism/cairn-sdk";

export async function signIn() {
  // 1) Ask YOUR server for a fresh single-use nonce (bound to the browser session).
  const { nonce } = await fetch("/auth/siwc/nonce", { method: "POST" }).then((r) => r.json());

  // 2) Have the wallet sign an audience-bound message. `domain` is taken from the REAL page origin by
  //    the wallet (you cannot spoof it); you only supply the server nonce + an optional statement.
  const wallet = await getWallet();
  let signed;
  try {
    signed = await wallet.signInWithCsd({ nonce, statement: "Sign in to Acme" });
  } catch (e) {
    if (errorCode(e) === "USER_REJECTED") return null;       // user closed the prompt
    if (errorCode(e) === "UNSUPPORTED_METHOD") throw new Error("Please update the Cairn Wallet.");
    throw e;
  }

  // 3) POST the artifact to YOUR server, which verifies it and starts a session cookie.
  const res = await fetch("/auth/siwc/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: signed.message, sig64: signed.sig64, pub33: signed.pub33 }),
  });
  return res.json(); // { ok, account } — your server set the session cookie
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVER (your Node backend, e.g. Express) — verify + own-session pattern
// ─────────────────────────────────────────────────────────────────────────────
import { verifySiwc, parseSiwcMessage, generateNonce, CSD_CHAIN_MAINNET } from "@inversealtruism/csd-siwc";

const MY_DOMAIN = "acme.example";          // YOUR site's origin authority (host[:port]).
const nonces = new Map();                  // nonce -> expiry (use Redis in production).

export function mountSiwc(app) {
  app.post("/auth/siwc/nonce", (_req, res) => {
    const nonce = generateNonce();         // 128-bit, single-use
    nonces.set(nonce, Date.now() + 5 * 60_000);
    res.json({ nonce });                   // bind to the browser session (cookie) in production
  });

  app.post("/auth/siwc/verify", (req, res) => {
    const { message, sig64, pub33 } = req.body ?? {};
    if (!message || !sig64 || !pub33) return res.status(400).json({ ok: false, error: "missing fields" });

    // Recover the nonce from the signed message, then check it's one WE issued and not yet used.
    const parsed = parseSiwcMessage(String(message));
    if (!parsed) return res.status(400).json({ ok: false, error: "malformed message" });
    const exp = nonces.get(parsed.nonce);
    if (!exp) return res.status(401).json({ ok: false, error: "unknown nonce" });
    if (exp < Date.now()) { nonces.delete(parsed.nonce); return res.status(401).json({ ok: false, error: "nonce expired" }); }

    // Full verification: domain==OUR origin, chain, nonce, time window, signature, hash160(pub)==account.
    const v = verifySiwc({ message, sig64, pub33 }, { domain: MY_DOMAIN, nonce: parsed.nonce, chainId: CSD_CHAIN_MAINNET });
    if (!v.ok) return res.status(401).json({ ok: false, error: v.reason });

    nonces.delete(parsed.nonce);           // single-use: consume atomically on success
    // Issue YOUR OWN session here (rotate id; HttpOnly+Secure+SameSite cookie; idle+absolute timeout).
    // The SIWC signature is the proof-of-control EVENT — do not store/reuse it as a credential.
    res.json({ ok: true, account: v.account });
  });
}
// cairn's own /auth/v2 (cairn/src/lib/auth.ts verifySiwcLogin) is the canonical reference implementation.
