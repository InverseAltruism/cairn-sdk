// What one submit of a signed transaction tells its sender. Chain.send and examples/node-signer.mjs both decide
// with classifySubmit; a signer that keeps the signed bytes reads the verdict the same way.

/** What a submit attempt produced, exactly one of: the parsed 2xx body (not a fetch `Response`), or what it threw
 *  (csd-client's error, an `HttpError`, a fetch `TypeError`, a timeout). */
export type SubmitOutcome = { answer: unknown } | { error: unknown };

/**
 * - `accepted`: the node answered `ok: true`.
 * - `duplicate`: the node answered that it already holds these bytes ("already present"): pending, not a failure.
 * - `rejected`: an explicit refusal: the node's `ok: false` with its `err` text (any text but "already present"),
 *   or HTTP 400, 413 or 429, read as refused from any sender. cairn-substrate.com answers 400 (its body cap) and 429
 *   (its rate limit) before it forwards a submit, and nginx or Cloudflare answer a body cap with 413. Behind a front
 *   of your own that can answer one of them after forwarding, treat a `rejected` verdict that carries `status` as
 *   `inflight`.
 * - `inflight`: no verdict; the node may hold the transaction (no answer, a timeout, a 5xx, any other status, a
 *   2xx body without the node's own boolean `ok`, an `ok: false` without the node's `err` text).
 */
export type SubmitVerdict =
  | { verdict: "accepted" }
  | { verdict: "duplicate"; detail: string }
  | { verdict: "rejected"; detail: string; status?: number }
  | { verdict: "inflight"; detail: string; status?: number };

// Answered before forwarding: cairn-substrate.com's body cap (400) and rate limit (429), a body cap at nginx or
// Cloudflare (413). Any other front is assumed to do the same; SubmitVerdict's doc says what to do when it does not.
const REFUSED_BEFORE_FORWARD = new Set([400, 413, 429]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// A parsed body's own `ok`. A fetch Response, or any object that inherits `ok`, is not the node's answer. Object.hasOwn,
// not a prototype check: a body parsed in another realm has another Object.prototype.
const ownOk = (v: Record<string, unknown>): unknown => (Object.hasOwn(v, "ok") ? v.ok : undefined);

// String() that cannot throw: a thrown value can be a null-prototype object or carry a throwing getter.
function text(v: unknown): string {
  try { return String(v); } catch { return "an unprintable value"; }
}

// A description of a body without a verdict. Not JSON.stringify: a body parsed with exact integers can hold a bigint,
// on which it throws.
function describeBody(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (isRecord(v)) {
    const keys = Object.keys(v).slice(0, 8);
    if (!Object.hasOwn(v, "ok")) return `an object without its own ok (keys: ${keys.join(", ") || "none"})`;
    return v.ok === false ? "ok:false without the node's err text" : `an object whose ok is a ${typeof v.ok}`;
  }
  if (typeof v === "string") return `the text "${v.slice(0, 80)}"`;
  return `a ${typeof v}`;
}

// csd-client's error for a non-2xx answer carries the status only in its message, "POST /tx/submit \u2192 HTTP 413".
// Its `terminal` flag covers every status below 500, 408 included, so the flag is not read as a refusal.
const CLIENT_STATUS = /^[A-Z]+ \/\S* \u2192 HTTP (\d{3})$/;

// The HTTP status of a thrown submit error: an integer `status` field (HttpError), else csd-client's message.
function statusOf(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  try {
    const r = e as { status?: unknown; message?: unknown };
    if (Number.isInteger(r.status) && (r.status as number) >= 100 && (r.status as number) <= 599) return r.status as number;
    const m = typeof r.message === "string" ? CLIENT_STATUS.exec(r.message) : null;
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;   // a throwing getter: no status read, so no refusal
  }
}

function messageOf(e: unknown): string {
  try {
    const m = (e as { message?: unknown } | null | undefined)?.message;
    return text(m ?? e);
  } catch {
    return text(e);
  }
}

/**
 * Classify what one submit attempt produced (see `SubmitVerdict`). Total: it does not throw, whatever the body, the
 * thrown value or the argument (`test/submit-classify.test.ts`); anything it cannot read is `inflight`.
 *
 * A refused answer to a resend of stored bytes decides nothing: the transaction may have been mined in between, and
 * the node then refuses it ("missing utxo"); look the txid up. "missing utxo" is `rejected`, never `duplicate`.
 */
export function classifySubmit(outcome: SubmitOutcome): SubmitVerdict {
  if (typeof outcome !== "object" || outcome === null) return { verdict: "inflight", detail: `no submit outcome given (${text(outcome)})` };
  if ("error" in outcome) {
    const e = outcome.error;
    const detail = messageOf(e);
    const status = statusOf(e);
    if (status !== undefined && REFUSED_BEFORE_FORWARD.has(status)) return { verdict: "rejected", detail, status };
    return { verdict: "inflight", detail, status };
  }
  const a = outcome.answer;
  if (isRecord(a)) {
    const ok = ownOk(a);
    if (ok === true) return { verdict: "accepted" };
    const err = ok === false && Object.hasOwn(a, "err") ? a.err : undefined;
    // The wallet's isSubmitDuplicateErr (cairn-wallet src/core/node.ts) is the rule's home; this matches it.
    if (ok === false && /already present/i.test(text(err ?? ""))) return { verdict: "duplicate", detail: text(err) };
    // The node writes its reason in `err` on every refusal; an ok:false without it is not the node's answer.
    if (ok === false && typeof err === "string" && err) return { verdict: "rejected", detail: err };
  }
  return { verdict: "inflight", detail: `a 2xx answer without the node's verdict: ${describeBody(a)}` };
}
