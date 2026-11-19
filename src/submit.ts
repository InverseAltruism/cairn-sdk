// What one submit of a signed transaction tells its sender. Chain.send and examples/node-signer.mjs both decide
// with classifySubmit; a signer that keeps the signed bytes reads the verdict the same way.

/** What a submit attempt produced: the parsed 2xx body, or what it threw (csd-client's error, an `HttpError`, a
 *  fetch `TypeError`, a timeout). */
export type SubmitOutcome = { answer: unknown } | { error: unknown };

/**
 * - `accepted`: the node answered `ok: true`.
 * - `duplicate`: the node answered that it already holds these bytes ("already present"): pending, not a failure.
 * - `rejected`: an explicit refusal, nothing was taken: the node's `ok: false` with any other text, or a proxy's
 *   400, 413 or 429, which it answers before forwarding.
 * - `inflight`: no verdict; the node may hold the transaction (no answer, a timeout, a 5xx, any other status, a
 *   2xx body without the node's boolean `ok`).
 */
export type SubmitVerdict =
  | { verdict: "accepted" }
  | { verdict: "duplicate"; detail: string }
  | { verdict: "rejected"; detail: string; status?: number }
  | { verdict: "inflight"; detail: string; status?: number };

// The statuses the hosted proxy answers before it forwards a submit: its request body cap and its rate limit.
const REFUSED_BEFORE_FORWARD = new Set([400, 413, 429]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// A description of a body without a verdict. Not JSON.stringify: a body parsed with exact integers can hold a bigint,
// on which it throws.
function describeBody(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (isRecord(v)) {
    const keys = Object.keys(v).slice(0, 8);
    return "ok" in v ? `an object whose ok is a ${typeof v.ok}` : `an object without ok (keys: ${keys.join(", ") || "none"})`;
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
  const r = e as { status?: unknown; message?: unknown };
  if (Number.isInteger(r.status) && (r.status as number) >= 100 && (r.status as number) <= 599) return r.status as number;
  const m = typeof r.message === "string" ? CLIENT_STATUS.exec(r.message) : null;
  return m ? Number(m[1]) : undefined;
}

/**
 * Classify what one submit attempt produced (see `SubmitVerdict`). Total: it never throws, whatever the body.
 *
 * A refused answer to a resend of stored bytes decides nothing: the transaction may have been mined in between, and
 * the node then refuses it ("missing utxo"); look the txid up. "missing utxo" is `rejected`, never `duplicate`.
 */
export function classifySubmit(outcome: SubmitOutcome): SubmitVerdict {
  if ("error" in outcome) {
    const e = outcome.error;
    const detail = String((e as { message?: unknown } | null)?.message ?? e);
    const status = statusOf(e);
    if (status !== undefined && REFUSED_BEFORE_FORWARD.has(status)) return { verdict: "rejected", detail, status };
    return { verdict: "inflight", detail, status };
  }
  const a = outcome.answer;
  if (isRecord(a) && a.ok === true) return { verdict: "accepted" };
  if (isRecord(a) && a.ok === false) {
    // The wallet's isSubmitDuplicateErr (cairn-wallet src/core/node.ts) is the rule's home; this matches it.
    if (/already present/i.test(String(a.err ?? ""))) return { verdict: "duplicate", detail: String(a.err) };
    return { verdict: "rejected", detail: typeof a.err === "string" && a.err ? a.err : "the node gave no reason" };
  }
  return { verdict: "inflight", detail: `a 2xx answer without the node's verdict: ${describeBody(a)}` };
}
