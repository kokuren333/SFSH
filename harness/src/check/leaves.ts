/**
 * Walking gen/public.json string leaves (paths in the `$.a.b[0].c` format of gen/check.ts), the A-1 scope
 * (PLAN "A-1 の対象と作成者"), author lookup, and sentence spans (same rule as gen/write.ts splitSentences).
 */
import type { Nkg } from "../nkg/types.ts";
import { sha256Hex } from "../util/hash.ts";
import type { Author, AuthorBasis } from "./types.ts";

export type Seg = string | number;

export function fmtPath(p: readonly Seg[]): string {
  return "$" + p.map((s) => (typeof s === "number" ? `[${s}]` : `.${s}`)).join("");
}

export const sha16 = (s: string): string => sha256Hex(s).slice(0, 16);
export const charCount = (s: string): number => [...s].length;

export interface Leaf {
  path: Seg[];
  value: string;
}

/** Every string leaf in document order. */
export function stringLeaves(v: unknown, at: Seg[] = [], out: Leaf[] = []): Leaf[] {
  if (typeof v === "string") out.push({ path: at, value: v });
  else if (Array.isArray(v)) v.forEach((x, i) => stringLeaves(x, [...at, i], out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) stringLeaves(x, [...at, k], out);
  return out;
}

export function getAt(root: unknown, path: readonly Seg[]): unknown {
  let cur: unknown = root;
  for (const s of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[s];
  }
  return cur;
}

export function setAt(root: unknown, path: readonly Seg[], value: unknown): void {
  const parent = getAt(root, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path[path.length - 1]] = value;
}

/** Nearest string key of a path (for `values[2]` → "values"). */
export function lastKey(path: readonly Seg[]): string | null {
  for (let i = path.length - 1; i >= 0; i--) if (typeof path[i] === "string") return path[i] as string;
  return null;
}

/** id / reference / enum keys — never generated prose (PLAN: A-1 除外). `kind` is handled separately. */
export const A1_EXCLUDED_KEYS = new Set([
  "id",
  "from",
  "to",
  "owner",
  "character",
  "faction",
  "secret",
  "holder",
  "phase",
  "phase_ref",
  "phase_from",
  "phase_to",
  "disclosure_phase",
  "source_refs",
  "based_on",
  "drives",
  "conflicts_with",
  "turns_at",
  "constrains",
  "pays_off",
  "evoked_by",
  "event",
  "epistemic",
  "grade",
  "spoiler",
  "level",
  "factor_kind",
  "valence",
  "state",
  "quiz_type",
  "reason",
  "module",
  "schema",
]);

/** `kind` is free text only on relations (`viz.relations.relations[i].kind`); elsewhere it is an enum. */
function isFreeTextKind(path: readonly Seg[]): boolean {
  return path.length === 5 && path[0] === "viz" && path[1] === "relations" && path[2] === "relations" && path[4] === "kind";
}

/**
 * A-1 scope: generated strings of public.json. Excluded: sources[] entirely, the work header (all its string
 * fields are in the PLAN exclusion list), `schema`, and id / reference / enum keys. Everything else is in
 * (when in doubt, include — detection side).
 */
export function inA1Scope(path: readonly Seg[]): boolean {
  const top = path[0];
  if (top === "sources" || top === "work" || top === "schema") return false;
  const k = lastKey(path);
  if (k === null) return false;
  if (k === "kind") return isFreeTextKind(path);
  return !A1_EXCLUDED_KEYS.has(k);
}

/** A-2(a) scope: every string except sources[].url (links to sources are allowed). */
export function inA2Scope(path: readonly Seg[]): boolean {
  return !(path[0] === "sources" && path[path.length - 1] === "url");
}

/** Page text written by Haiku in S3 (overview / figure notes / intros / quiz / synopsis — AMENDMENT 11). */
export function isPageText(path: readonly Seg[]): boolean {
  if (path[0] !== "pages") return false;
  if (path[1] === "overview" || path[1] === "figure_notes" || path[1] === "quiz" || path[1] === "synopsis") return true;
  return path[2] === "intro";
}

/** Nearest enclosing object (excluding the leaf) that has a string `id`. */
export function elementIdOf(root: unknown, path: readonly Seg[]): string | null {
  let found: string | null = null;
  let cur: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur === null || typeof cur !== "object") break;
    cur = (cur as Record<string | number, unknown>)[path[i]];
    if (cur && typeof cur === "object" && !Array.isArray(cur) && typeof (cur as { id?: unknown }).id === "string") found = (cur as { id: string }).id;
  }
  return found;
}

export type AuthorIndex = Map<string, Author>;

export function authorIndex(nkg: Nkg | null): AuthorIndex {
  const m: AuthorIndex = new Map();
  for (const el of [...(nkg?.nodes ?? []), ...(nkg?.edges ?? [])]) {
    const a = el?.meta?.authored_by;
    if (a === "haiku" || a === "luna") m.set(el.id, a);
  }
  return m;
}

export function authorOf(root: unknown, path: readonly Seg[], idx: AuthorIndex): { element_id: string | null; author: Author; basis: AuthorBasis } {
  const element_id = elementIdOf(root, path);
  if (isPageText(path)) return { element_id, author: "haiku", basis: "pages" };
  const a = element_id ? idx.get(element_id) : undefined;
  if (a) return { element_id, author: a, basis: "nkg" };
  return { element_id, author: "haiku", basis: "fallback" };
}

// ------------------------------------------------------------------ sentences
/** Same pattern as gen/write.ts splitSentences, with offsets. Whitespace-only pieces are skipped. */
const SENT_RE = /[^。！？!?\n]+[。！？!?」』）)]*|[。！？!?]+/g;

export interface Span {
  start: number;
  end: number;
  text: string;
}

export function sentenceSpans(s: string): Span[] {
  const out: Span[] = [];
  for (const m of s.matchAll(SENT_RE)) if (m[0].trim()) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  return out;
}

/** Remove the given spans (sorted or not) from `s`; the rest is kept byte-for-byte, then trimmed. */
export function removeSpans(s: string, spans: { start: number; end: number }[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const sp of sorted) {
    if (sp.start < pos) {
      pos = Math.max(pos, sp.end);
      continue;
    }
    out += s.slice(pos, sp.start);
    pos = sp.end;
  }
  out += s.slice(pos);
  return out.trim();
}
