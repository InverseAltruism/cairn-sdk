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
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
}

export class Http {
  readonly baseUrl: string;
  private readonly _fetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(opts: HttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error("No fetch available — pass `fetch` in the SDK options.");
    // Bind to globalThis so the browser doesn't throw "Illegal invocation".
    this._fetch = opts.fetch ? opts.fetch : (f.bind(globalThis) as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.headers = opts.headers ?? {};
  }

  /** Build an absolute URL from a path + optional query params. */
  url(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const p = path.startsWith("/") ? path : `/${path}`;
    const u = new URL(this.baseUrl + p);
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

  async getJson<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const res = await this.raw("GET", path, { query });
    if (!res.ok) throw new HttpError(res.status, this.url(path, query), await safeText(res));
    return (await res.json()) as T;
  }

  async postJson<T = unknown>(path: string, body: unknown, headers?: Record<string, string>): Promise<T> {
    const res = await this.raw("POST", path, { body, headers });
    if (!res.ok) throw new HttpError(res.status, this.url(path), await safeText(res));
    return (await res.json()) as T;
  }

  /** GET raw bytes (for content retrieval). Returns null on 404. */
  async getBytes(path: string): Promise<{ bytes: Uint8Array; headers: Headers } | null> {
    const res = await this.raw("GET", path);
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(res.status, this.url(path), await safeText(res));
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf, headers: res.headers };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
