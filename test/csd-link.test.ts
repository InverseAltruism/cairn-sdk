// web+csd: links: the vectors in test/vectors/csd-link.json, then a seeded property loop over generated strings and
// link objects (parse does not throw, the round trip is exact, format refuses what parse refuses). Offline.
import { parseCsdLink, formatCsdLink, csdLinkToHttps, CairnError, type CsdLink, type CsdLinkParse } from "../src/index.js";
import { readFileSync } from "node:fs";

declare const process: { exit(code: number): void };
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)); };

type Part = string | { repeat: string; times: number };
type Spec = string | { concat: Part[] };
const expand = (v: unknown): unknown =>
  v && typeof v === "object" && !Array.isArray(v) && "concat" in v
    ? (v as { concat: Part[] }).concat.map((p) => (typeof p === "string" ? p : p.repeat.repeat(p.times))).join("")
    : v;
const show = (v: unknown): string => {
  const s = JSON.stringify(expand(v)) ?? String(v);
  return s.length > 80 ? `${s.slice(0, 60)}... (${s.length} chars)` : s;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const LINK_CODES = new Set(["LINK_SCHEME", "LINK_AUTHORITY", "LINK_QUERY", "LINK_NAME", "LINK_PATH", "LINK_TOO_LONG", "LINK_ORIGIN"]);

// The code a call threw, "returned" when it did not throw, or "non-CairnError" for any other throw.
function thrownCode(fn: () => unknown): string {
  try { fn(); return "returned"; }
  catch (e) { return e instanceof CairnError && LINK_CODES.has(e.code) ? e.code : "non-CairnError"; }
}
function parseSafely(input: unknown): CsdLinkParse | "threw" {
  try { return parseCsdLink(input); }
  catch { return "threw"; } // the property under test: any throw is reported as a failure by the caller
}

const V = JSON.parse(readFileSync(new URL("./vectors/csd-link.json", import.meta.url), "utf8")) as {
  accepted: { input: Spec; name: Spec; path?: Spec; canonical: Spec }[];
  refused: { input: unknown; code: string }[];
  formatRefused: { link: unknown; code: string }[];
  https: { link: CsdLink; origin: string; url?: string; code?: string }[];
};

console.log("=== accepted vectors ===");
for (const v of V.accepted) {
  const want: Record<string, unknown> = { ok: true, name: expand(v.name) };
  if (v.path !== undefined) want.path = expand(v.path);
  const got = parseCsdLink(expand(v.input));
  ok(`parse ${show(v.input)}`, same(got, want));
  const link: CsdLink = v.path === undefined ? { name: expand(v.name) as string } : { name: expand(v.name) as string, path: expand(v.path) as string };
  const f = formatCsdLink(link);
  ok(`format gives ${show(v.canonical)} and parses back`, f === expand(v.canonical) && same(parseCsdLink(f), want));
}

console.log("=== refused vectors ===");
for (const v of V.refused) {
  const got = parseSafely(expand(v.input));
  ok(`${show(v.input)} -> ${v.code}`, got !== "threw" && got.ok === false && got.code === v.code && got.reason.length > 0);
}
ok("a 10,000 character input is in the vectors", V.refused.some((v) => String(expand(v.input)).length === 10_000));

console.log("=== format refusals ===");
for (const v of V.formatRefused) {
  ok(`format ${show(v.link)} throws ${v.code}`, thrownCode(() => formatCsdLink(v.link as CsdLink)) === v.code);
}

console.log("=== https beside the link ===");
for (const v of V.https) {
  if (v.url !== undefined) {
    const url = csdLinkToHttps(v.link, v.origin);
    ok(`${show(v.link)} on ${v.origin} -> ${v.url}`, url === v.url && new URL(url).href === url);
  } else {
    ok(`${show(v.link)} on ${show(v.origin)} throws ${v.code}`, thrownCode(() => csdLinkToHttps(v.link, v.origin)) === v.code);
  }
}

console.log("=== the handler's call shape ===");
// A browser's registerProtocolHandler puts the whole link, percent-encoded, where the handler URL has %s; the page
// reads it back with URLSearchParams, which decodes it once.
const handed = new URL(`https://cairn-substrate.com/names/open?link=${encodeURIComponent("web+csd:Alice/blog/post-1")}`).searchParams.get("link");
const opened = parseCsdLink(handed);
ok("a link read back from the handler URL parses", same(opened, { ok: true, name: "alice", path: "blog/post-1" }));
ok("and gives its https page", opened.ok && csdLinkToHttps(opened, "https://cairn-substrate.com") === "https://cairn-substrate.com/names#/name/alice/blog/post-1");
const missing = parseCsdLink(new URL("https://cairn-substrate.com/names/open").searchParams.get("link"));
ok("a handler URL without the parameter (null) is refused, not thrown", !missing.ok && missing.code === "LINK_SCHEME");

console.log("=== property loop (seeded) ===");
let seed = 0x9e3779b9;
const rnd = (n: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
const TOKENS = ["a", "b", "z", "Q", "0", "9", "-", "-", ".", "..", "_", "~", "/", "/", "//", "%", "%2e", "%2F", "?", "#", ":", "@",
  "\\", " ", "\t", "\n", "\r", "\u0000", "K", "а", "ı", "é", "​", "／", "\ud800", "csd", "web+csd:"];
const SCHEMES = ["web+csd:", "WEB+CSD:", "Web+Csd:", "web+csd://", "web+csd:/", "web+csd", "csd:", "", "web+cſd:"];
// Half the strings use only grammar characters, so a fair share is accepted; the rest mix in the hostile tokens.
const CLEAN = ["a", "b", "z", "Q", "0", "9", "-", ".", "_", "~", "/"];
const tokens = (max: number, clean = rnd(2) === 0) => {
  let s = "";
  for (let i = rnd(max); i > 0; i--) s += pick(clean && rnd(50) > 0 ? CLEAN : TOKENS);
  return s;
};
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const N = 20_000;
let threw = 0, roundTripBad = 0, formatLaxer = 0, laxChecked = 0, accepted = 0, objBad = 0, objOk = 0;
for (let i = 0; i < N; i++) {
  const s = (rnd(10) < 8 ? "web+csd:" : pick(SCHEMES)) + tokens(rnd(20) === 0 ? 400 : 24);
  const r = parseSafely(s);
  if (r === "threw" || typeof r.ok !== "boolean" || (!r.ok && (!LINK_CODES.has(r.code) || !r.reason))) { threw++; continue; }
  if (r.ok) {
    accepted++;
    const link: CsdLink = r.path === undefined ? { name: r.name } : { name: r.name, path: r.path };
    if (!same(parseCsdLink(formatCsdLink(link)), r)) roundTripBad++;
  } else if (fold(s.slice(0, 8)) === "web+csd:") {
    // The same name (ASCII-folded) and path handed to format: parse refused the string, so format must refuse them.
    const rest = s.slice(8), slash = rest.indexOf("/");
    const link = slash === -1 ? { name: fold(rest) } : { name: fold(rest.slice(0, slash)), path: rest.slice(slash + 1) };
    laxChecked++;
    if (thrownCode(() => formatCsdLink(link)) === "returned") formatLaxer++;
  }
  // Link objects straight into format: a refusal is a CairnError with a link code, an answer parses back to them.
  const name = pick(["alice", "a", "Alice", "csd", "", "-x", "x".repeat(33), fold(tokens(6)), tokens(4)]);
  const obj: CsdLink = rnd(3) === 0 ? { name } : { name, path: tokens(12) };
  const code = thrownCode(() => formatCsdLink(obj));
  if (code === "returned") { objOk++; if (!same(parseCsdLink(formatCsdLink(obj)), { ok: true, ...obj })) objBad++; }
  else if (code === "non-CairnError") objBad++;
}
ok(`parse answered all ${N} generated strings without a throw, each refusal with a link code and a reason`, threw === 0);
ok(`parse(format(parse(s))) equals parse(s) for every accepted string (${accepted} accepted)`, accepted > 500 && roundTripBad === 0);
ok(`format refused every name and path whose string parse refused (${laxChecked} checked)`, laxChecked > 500 && formatLaxer === 0);
ok(`format: every refusal a CairnError with a link code, every answer parses back to its object (${objOk} answered)`, objOk > 500 && objBad === 0);

console.log(`\ncsd-link: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
