// `web+csd:` links: "open this name", optionally at a path. A link carries no action, amount, address, query or
// fragment, and nothing here makes a request. The grammar (ABNF) and the refusal codes are in docs/SDK-GUIDE.md.
import { isName } from "@inversealtruism/cairnx-core";
import { CairnError, type KnownCode } from "./errors.js";

/** A link's content: a CNS name (lowercase, as cairnx-core's `isName` accepts it) and an optional path. */
export interface CsdLink {
  name: string;
  path?: string;
}

/** Why a link, a link object or a site origin was refused. */
export type CsdLinkCode = Extract<KnownCode, `LINK_${string}`>;

/** `parseCsdLink`'s answer: the link, or a refusal with its code. `path` is absent when the link has none. */
export type CsdLinkParse = ({ ok: true } & CsdLink) | { ok: false; code: CsdLinkCode; reason: string };

const SCHEME = "web+csd:";
const MAX_PATH = 256;
const MAX_NAME = 32;
const MAX_LINK = SCHEME.length + MAX_NAME + 1 + MAX_PATH;
// RFC 3986 unreserved characters only, so an accepted path is valid verbatim in a URL path or fragment and holds no
// `%` to decode. The leading `\.*` then one non-dot refuses a segment made only of dots (`.`, `..`).
const SEGMENT_RE = /^\.*[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;

// Only A-Z is folded: toLowerCase() maps U+212A KELVIN SIGN to "k", which would let a non-ASCII link read as an
// ASCII name.
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

type Refusal = { code: CsdLinkCode; reason: string };

function pathProblem(path: string): Refusal | null {
  if (path.length > MAX_PATH) return { code: "LINK_PATH", reason: `the path is longer than ${MAX_PATH} characters` };
  for (const seg of path.split("/")) {
    if (!SEGMENT_RE.test(seg)) {
      return { code: "LINK_PATH", reason: "a path segment is empty, only dots, or holds a character outside A-Z a-z 0-9 - . _ ~" };
    }
  }
  return null;
}

const NAME_REFUSAL: Refusal = { code: "LINK_NAME", reason: "the name is not a claimable CNS name (lowercase ASCII letters, digits and inner hyphens, 1 to 32 characters, not reserved)" };

// The canonical form only: the name exactly as parseCsdLink returns it, so parse(format(x)) equals x.
function linkProblem(link: unknown): Refusal | null {
  if (!link || typeof link !== "object") return NAME_REFUSAL;
  const { name, path } = link as { name?: unknown; path?: unknown };
  if (!isName(name)) return NAME_REFUSAL;
  if (path === undefined) return null;
  if (typeof path !== "string") return { code: "LINK_PATH", reason: "the path is not a string" };
  return pathProblem(path);
}

/**
 * Read a `web+csd:<name>[/<path>]` link. The scheme and the name are read ASCII case-insensitively and the name is
 * returned lowercase; the path keeps its case. Returns `{ ok: false, code, reason }` for anything outside the
 * grammar and does not throw for any input. It makes no request: the caller opens the name page it names.
 */
export function parseCsdLink(input: unknown): CsdLinkParse {
  const refuse = (r: Refusal): CsdLinkParse => ({ ok: false, ...r });
  if (typeof input !== "string") return refuse({ code: "LINK_SCHEME", reason: "a link is a string" });
  if (input.length > MAX_LINK) return refuse({ code: "LINK_TOO_LONG", reason: `a link is at most ${MAX_LINK} characters` });
  if (asciiLower(input.slice(0, SCHEME.length)) !== SCHEME) return refuse({ code: "LINK_SCHEME", reason: `a link starts with ${SCHEME}` });
  const rest = input.slice(SCHEME.length);
  if (rest.startsWith("//")) return refuse({ code: "LINK_AUTHORITY", reason: `the ${SCHEME}// form is not a link; write ${SCHEME}<name>` });
  if (/[?#]/.test(rest)) return refuse({ code: "LINK_QUERY", reason: "a link carries no query or fragment" });
  const slash = rest.indexOf("/");
  const name = asciiLower(slash === -1 ? rest : rest.slice(0, slash));
  if (!isName(name)) return refuse(NAME_REFUSAL);
  if (slash === -1) return { ok: true, name };
  const path = rest.slice(slash + 1);
  const bad = pathProblem(path);
  return bad ? refuse(bad) : { ok: true, name, path };
}

/**
 * Write a link. Takes the name in its canonical lowercase form (as `parseCsdLink` returns it) and throws a
 * `CairnError` with the refusal's code for anything `parseCsdLink` would not return.
 */
export function formatCsdLink(link: CsdLink): string {
  const bad = linkProblem(link);
  if (bad) throw new CairnError(bad.reason, { code: bad.code });
  return SCHEME + link.name + (link.path === undefined ? "" : `/${link.path}`);
}

/**
 * The https URL of the same name page, for showing beside a `web+csd:` link to readers without a handler:
 * `<origin>/names#/name/<name>[/<path>]`. `origin` is the site's https origin (for example the one the dApp
 * already uses as `baseUrls.cairn`); there is no default. Throws a `CairnError` (`LINK_ORIGIN`, or the link's own
 * code) on a refusal.
 */
export function csdLinkToHttps(link: CsdLink, origin: string): string {
  const bad = linkProblem(link);
  if (bad) throw new CairnError(bad.reason, { code: bad.code });
  const refuseOrigin = (cause?: unknown) =>
    new CairnError("the site origin must be an https origin with no path, query, fragment or credentials", { code: "LINK_ORIGIN", cause });
  let u: URL;
  try {
    u = new URL(String(origin));
  } catch (e) {
    throw refuseOrigin(e);
  }
  if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw refuseOrigin();
  return `${u.origin}/names#/name/${link.name}${link.path === undefined ? "" : `/${link.path}`}`;
}
