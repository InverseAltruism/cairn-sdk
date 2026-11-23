// Page reads of the CairnX public read API, version 1 (`/api/cairnx/v1/<list>`), with the legacy route as the
// fallback. The rule is the site's (cairn `public/trade/apiv1.js`): an answer that is not a 2xx whose JSON body is a
// page (`ok: true`, `rows` an array, `next` a cursor or null) is answered from the legacy read, whatever the cause: a
// host without the v1 mount (404), a 5xx, a body that is not JSON, a timeout, a network error or `ok: false`. Only a
// read the legacy route can answer falls back: one without `at` (the legacy route names no snapshot) and without a
// filter (filters are the v1 handler's, which this SDK does not copy). Any other read throws the v1 read's error.
// Row and envelope types are cairnx-api's 1.0 contract; the root entry re-exports `NameRow` and `At` as types.
import { parseQuery, type At, type Query, type Route } from "@inversealtruism/cairnx-api";
import { CairnError, HttpError } from "./errors.js";
import type { Http } from "./http.js";

const V1 = "/api/cairnx/v1";

/** A page as the SDK returns it. `at` is the snapshot the rows describe; null when the legacy route answered or the
 *  server's `at` is not one cairnx-api's parser takes back (the page is then unpinned). */
export interface ListPage<Row> {
  rows: Row[];
  /** The cursor after the last row, or null: a walk ends on null and on nothing else. */
  next: string | null;
  at: At | null;
  /** Rows matching the read at `at`, when the server counts them; never a reason to end a walk. */
  total?: number;
}

/** `at` of a pinned read: a page's `at`, or a block learned elsewhere (no `rev`). */
export interface AtParam {
  height: number;
  hash: string;
  rev?: string;
}

/** `at` in its query spelling, `<height>:<hash>[:<rev>]`. */
export const atParam = (a: AtParam): string => `${a.height}:${a.hash}${a.rev === undefined ? "" : `:${a.rev}`}`;

/** The parsed read, by cairnx-api's parser, or a CairnError `INVALID_QUERY` naming the parameter; nothing is sent. */
export function checkedQuery<R extends Route>(route: R, params: URLSearchParams): Query<R> {
  const r = parseQuery(route, params);
  if (!r.ok) throw new CairnError(`invalid ${route} read: ${r.error.param} ${r.error.message}`, { code: "INVALID_QUERY" });
  return r.query;
}

/** True when the legacy whole list answers `q` exactly: no snapshot and no filter. */
export const legacyAnswers = (q: Query): boolean => q.at === null && Object.values(q.filters).every((v) => v === null);

/** `a` as an `At` when cairnx-api's parser takes it back as a query's `at`, else null: the SDK echoes a page's `at`
 *  on the next read, so it keeps only one that read can send. The `at` grammar is one for every route. */
function echoableAt(a: unknown): At | null {
  if (!a || typeof a !== "object") return null;
  const { height, hash, rev } = a as Record<string, unknown>;
  if (!Number.isSafeInteger(height) || typeof hash !== "string" || typeof rev !== "string") return null;
  const at = { height: height as number, hash, rev };
  return parseQuery("names", new URLSearchParams({ at: atParam(at) })).ok ? at : null;
}

function pageProblem(body: unknown, rowOk: (r: unknown) => boolean): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "not an object";
  const b = body as Record<string, unknown>;
  if (b.ok !== true) return "ok is not true";
  if (!Array.isArray(b.rows)) return "rows is not an array";
  if (b.next !== null && typeof b.next !== "string") return "next is neither a cursor nor null";
  if (b.total !== undefined && !(Number.isSafeInteger(b.total) && (b.total as number) >= 0)) return "total is malformed";
  const bad = b.rows.findIndex((r) => !rowOk(r));
  return bad < 0 ? null : `row ${bad} is malformed`;
}

/** The v1 page of `route` with `params`, or the error that kept it from being one. Never throws. */
export async function readV1<Row>(http: Http, route: Route, params: URLSearchParams, rowOk: (r: unknown) => r is Row): Promise<{ ok: true; page: ListPage<Row> } | { ok: false; error: Error }> {
  const path = `${V1}/${route}`;
  try {
    const body = await http.getJson<unknown>(path, Object.fromEntries(params));
    const p = pageProblem(body, rowOk);
    if (p) return { ok: false, error: new HttpError(200, http.url(path, Object.fromEntries(params)), `malformed v1 page: ${p}`) };
    const b = body as { rows: Row[]; next: string | null; at: unknown; total?: number };
    return { ok: true, page: { rows: b.rows, next: b.next, at: echoableAt(b.at), ...(b.total === undefined ? {} : { total: b.total }) } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }
}
