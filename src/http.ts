// Minimal typed fetch wrapper shared by the HTTP clients. Pluggable `fetch` so
// the SDK runs unchanged in the browser, Node 18+, and MV3 service workers.

import { HttpError } from "./errors.js";

export type FetchLike = typeof fetch;

export interface HttpOptions {
  /** Base URL with no trailing slash, e.g. "https://cairn-substrate.com". */
  baseUrl: string;
  /** Custom fetch (defaults to global fetch). */
  fetch?: FetchLike;
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number;
  /** Max response body bytes accepted before aborting (default 16 MiB — matches the cairn proxy cap).
   *  CAIRNSDK-DESER-4: the SDK's sources (indexer/content) are self-classified UNTRUSTED; without a cap a
   *  hostile/MITM'd source can stream an unbounded body and OOM the client (browser tab / MV3 worker / bot). */
  maxBytes?: number;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
  /** Opt-in retry budget for IDEMPOTENT GETs only (default 0 = today's behavior). Retries fire on
   *  network errors/timeouts and 5xx, never on 4xx (mirrors csd-client's posture), with full-jitter
   *  backoff. POSTs are never retried (they may not be idempotent). */
  retries?: number;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const ERR_TEXT_CAP = 8 * 1024; // error-body text is only for a message — cap it hard (DESER-4 safeText sink)

// Read a Response body with a running byte cap: a Content-Length precheck rejects a declared-oversize body,
// and a streamed reader aborts the moment the running total exceeds the cap (defeats a no-Content-Length
// slow-stream OOM). Falls back to a buffered read + post-check when the body stream is unavailable.
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const cl = Number(res.headers.get("content-length"));
  if (Number.isFinite(cl) && cl > maxBytes) throw new HttpError(res.status, res.url, `response too large (content-length ${cl} > ${maxBytes})`);
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new HttpError(res.status, res.url, `response too large (${buf.byteLength} > ${maxBytes})`);
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw new HttpError(res.status, res.url, `response exceeded ${maxBytes} bytes`); }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export class Http {
  readonly baseUrl: string;
  private readonly _fetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly headers: Record<string, string>;
  private readonly retries: number;

  constructor(opts: HttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error("No fetch available — pass `fetch` in the SDK options.");
    // Bind to globalThis so the browser doesn't throw "Illegal invocation".
    this._fetch = opts.fetch ? opts.fetch : (f.bind(globalThis) as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.headers = opts.headers ?? {};
    this.retries = Math.min(10, Math.max(0, Math.floor(opts.retries ?? 0))); // clamped: an Infinity budget must not loop forever
  }

  /** Build an absolute URL from a path + optional query params. */
  url(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const p = path.startsWith("/") ? path : `/${path}`;
    const u = new URL(this.baseUrl + p);
    // CAIRNSDK-CONTENT-HASH-PATH-1 (defense-in-depth): a caller-supplied id containing `../` can make
    // `new URL` walk the resolved path ABOVE the configured base (e.g. /explorer/api → /api/rpc/tip) and
    // return a different endpoint's body verbatim as the requested object. Reject any path that escapes the
    // base prefix. (Per-method id encoding/validation is the primary fix; this is the backstop.)
    const basePath = new URL(this.baseUrl + "/").pathname; // trailing slash → segment-aligned prefix
    if (basePath !== "/" && !(u.pathname + "/").startsWith(basePath)) {
      throw new Error(`illegal path '${path}' — escapes base ${basePath}`);
    }
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private async raw(method: string, path: string, opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; headers?: Record<string, string> }): Promise<Response> {
    const url = this.url(path, opts?.query);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this._fetch(url, {
        method,
        signal: ctrl.signal,
        headers: {
          ...(opts?.body !== undefined ? { "content-type": "application/json" } : {}),
          ...this.headers,
          ...(opts?.headers ?? {}),
        },
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  // A malformed 2xx body must surface as a TYPED HttpError, not a leaked SyntaxError (B10: dApp
  // code branches on `instanceof CairnError`; a raw parse error escaped that contract).
  private parseJson<T>(res: Response, text: string, url: string): T {
    try { return JSON.parse(text) as T; }
    catch (e) { throw new HttpError(res.status, url, `invalid JSON body: ${text.slice(0, 120)}`); }
  }

  async getJson<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const url = this.url(path, query);
    // Opt-in GET retry (default 0): network errors/timeouts and 5xx only, full-jitter backoff.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.raw("GET", path, { query });
        if (!res.ok) {
          // read the body for the error message ONLY when we are actually throwing (terminal); on a
          // to-be-retried 5xx, drain the discarded body (undici holds the socket until GC otherwise).
          if (!(res.status >= 500 && attempt < this.retries)) throw new HttpError(res.status, url, await safeText(res));
          res.body?.cancel().catch(() => {});
          // else: fall through to the jittered sleep and retry
        } else {
          return this.parseJson<T>(res, new TextDecoder().decode(await readCapped(res, this.maxBytes)), url);
        }
      } catch (e) {
        if (e instanceof HttpError && e.status < 500) throw e;      // 4xx: terminal, never retried
        if (attempt >= this.retries) throw e;
      }
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * Math.min(4000, 250 * 2 ** attempt))));
    }
  }

  async postJson<T = unknown>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
    const url = this.url(path);
    const res = await this.raw("POST", path, { body, headers });
    if (!res.ok) throw new HttpError(res.status, url, await safeText(res));
    return this.parseJson<T>(res, new TextDecoder().decode(await readCapped(res, this.maxBytes)), url);
  }

  /** GET raw bytes (for content retrieval). Returns null on 404. */
  async getBytes(path: string): Promise<{ bytes: Uint8Array; headers: Headers } | null> {
    const res = await this.raw("GET", path);
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(res.status, this.url(path), await safeText(res));
    return { bytes: await readCapped(res, this.maxBytes), headers: res.headers };
  }
}

// CAIRNSDK-DESER-4: the error-response body is read only to build an HttpError message — cap it HARD so a
// hostile 4xx/5xx with a multi-GB body can't OOM the client on the error path (the sink the finding missed).
async function safeText(res: Response): Promise<string> {
  try {
    return new TextDecoder().decode(await readCapped(res, ERR_TEXT_CAP));
  } catch {
    return "";
  }
}
