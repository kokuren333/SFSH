/**
 * Applying S4 edits to a PublicWork in place, with the "field became empty" rules and dangling-reference
 * cleanup of PLAN "A-1 の対象と作成者 / 処置":
 *  - nullable string → null;
 *  - entry of a string array → the entry is removed; a TEXT_BLOCK left with 0 paragraphs is removed
 *    (figure_notes.<fig> → null);
 *  - quiz `explanation` → "" (the item stays: compose already treats it as optional; P-1 "作る側に倒す");
 *  - any other (required) string → the enclosing array item (the element) is removed.
 *    Exceptions: the work header and sources[] have no removable element → the value becomes "" (warning).
 * Cascade (only for ids removed here, so nothing else is touched):
 *  - array items whose `id` was removed (mirrors such as timeline events / matrix holders of a removed character);
 *  - required refs (relations from/to, motives owner, arcs character, cells secret/holder/phase, emotion beat
 *    phase, caused_by/leads_to event) → the item is removed;
 *  - nullable refs (faction, phase_from/to, phase_ref, disclosure_phase) → null;
 *  - id arrays (based_on, drives, conflicts_with, turns_at, constrains, pays_off, evoked_by) → filtered;
 *  - reverse-plot nodes are removed with their whole subtree; interpretation items without positions are removed;
 *  - a matrix left without secrets → matrix null, has_matrix false, figure_notes.matrix null.
 * Removing a matrix holder or timeline entry directly only affects that mirror (cells of the holder), never the
 * character / event element itself.
 */
import type { PublicWork } from "../../../site/src/public-types.ts";
import { fmtPath, getAt, lastKey, setAt, type Seg } from "./leaves.ts";
import type { CascadeEntry, RemovedEntry } from "./types.ts";

export const NULLABLE_KEYS = new Set([
  "heading",
  "summary",
  "analysis",
  "changed_by_label",
  "title_original",
  "title_reading",
  "publisher",
  "faction",
  "phase_from",
  "phase_to",
  "phase_ref",
  "disclosure_phase",
  "factor_kind",
  "license",
  "role",
]);
const REQUIRED_REFS = ["from", "to", "owner", "character", "secret", "holder", "phase", "event"] as const;
const NULLABLE_REFS = ["faction", "phase_from", "phase_to", "phase_ref", "disclosure_phase"] as const;
const ID_ARRAYS = ["based_on", "drives", "conflicts_with", "turns_at", "constrains", "pays_off", "evoked_by"] as const;

export interface LeafEdit {
  path: Seg[];
  /** New value; empty after trim → field rules. */
  value: string;
  /** sha256 prefix recorded for a field action (hash of the original field value). */
  origHash: string;
  element_id: string | null;
}

export interface FixOutcome {
  fieldActions: RemovedEntry[];
  cascade: CascadeEntry[];
  warnings: string[];
  /** Ids of elements removed in this pass (direct + cascade). */
  removedIds: Set<string>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const idOf = (o: Obj): string => (typeof o.id === "string" ? o.id : "");

const isHolders = (p: readonly Seg[]) => p.length === 4 && p[0] === "viz" && p[1] === "matrix" && p[2] === "holders";
const isTimelineEvent = (p: readonly Seg[]) => p.length === 4 && p[0] === "viz" && p[1] === "timeline" && p[2] === "events";
const isPlotItem = (p: readonly Seg[]) => {
  const k = p[p.length - 2];
  return k === "children" || k === "trees";
};
const isCell = (p: readonly Seg[]) => p.length === 4 && p[0] === "viz" && p[1] === "matrix" && p[2] === "cells";

/** Visit every object; `container` = path of the array holding it (null when not an array item). Return false = do not descend. */
function walkObjects(v: unknown, at: Seg[], visit: (o: Obj, path: Seg[], inArray: boolean) => boolean | void, inArray = false): void {
  if (Array.isArray(v)) {
    // iterate over a snapshot: visitors never splice (pruning is separate)
    v.forEach((x, i) => walkObjects(x, [...at, i], visit, true));
    return;
  }
  if (!isObj(v)) return;
  if (visit(v, at, inArray) === false) return;
  for (const [k, x] of Object.entries(v)) if (x && typeof x === "object") walkObjects(x, [...at, k], visit, false);
}

export function applyEdits(pw: PublicWork, edits: LeafEdit[]): FixOutcome {
  const out: FixOutcome = { fieldActions: [], cascade: [], warnings: [], removedIds: new Set() };
  const marked = new Set<object>();
  const entryRemovals = new Map<unknown[], Set<number>>();
  const touchedBlocks: { block: Obj; path: Seg[]; element_id: string | null; origHash: string }[] = [];
  const removedHolders = new Set<string>();
  let secretRemoved = false;

  const mark = (o: Obj, p: Seg[], reason: string | null) => {
    if (marked.has(o)) return;
    marked.add(o);
    const id = idOf(o);
    if (reason !== null) out.cascade.push({ path: fmtPath(p), id: id || cellId(o), reason });
    if (isHolders(p)) {
      if (id) removedHolders.add(id);
    } else if (!isTimelineEvent(p) && id) {
      out.removedIds.add(id);
      if (p[0] === "viz" && p[1] === "matrix" && p[2] === "secrets") secretRemoved = true;
    }
    if (isPlotItem(p) && Array.isArray(o.children)) {
      const sub = (n: Obj, np: Seg[]) => {
        (n.children as unknown[]).forEach((c, i) => {
          if (!isObj(c)) return;
          const cp = [...np, "children", i];
          marked.add(c);
          if (idOf(c)) out.removedIds.add(idOf(c));
          out.cascade.push({ path: fmtPath(cp), id: idOf(c), reason: `subtree of removed plot node ${id}` });
          if (Array.isArray(c.children)) sub(c, cp);
        });
      };
      sub(o, p);
    }
  };

  // 1) leaf edits
  for (const e of edits) {
    if (e.value.trim()) {
      setAt(pw, e.path, e.value);
      continue;
    }
    const key = lastKey(e.path);
    const last = e.path[e.path.length - 1];
    const rec = (action: RemovedEntry["action"], p: Seg[] = e.path) => out.fieldActions.push({ path: fmtPath(p), element_id: e.element_id, action, sentence_sha256: e.origHash });
    if (typeof last === "number") {
      const arr = getAt(pw, e.path.slice(0, -1)) as unknown[];
      if (!entryRemovals.has(arr)) entryRemovals.set(arr, new Set());
      entryRemovals.get(arr)!.add(last);
      rec("entry_removed");
      if (key === "paragraphs") {
        const block = getAt(pw, e.path.slice(0, -2));
        if (isObj(block) && !touchedBlocks.some((t) => t.block === block)) touchedBlocks.push({ block, path: e.path.slice(0, -2), element_id: e.element_id, origHash: e.origHash });
      }
      continue;
    }
    if (key && NULLABLE_KEYS.has(key)) {
      setAt(pw, e.path, null);
      rec("field_nulled");
      continue;
    }
    if (key === "explanation" && e.path[0] === "pages" && e.path[1] === "quiz") {
      setAt(pw, e.path, "");
      rec("field_nulled");
      continue;
    }
    let k = -1;
    for (let i = e.path.length - 2; i >= 0; i--) {
      if (typeof e.path[i] === "number" && isObj(getAt(pw, e.path.slice(0, i + 1)))) {
        k = i;
        break;
      }
    }
    if (k < 0 || e.path[0] === "sources" || e.path[0] === "work") {
      setAt(pw, e.path, "");
      rec("field_nulled");
      out.warnings.push(`check: required field ${fmtPath(e.path)} emptied (no removable element) — left as ""`);
      continue;
    }
    const elPath = e.path.slice(0, k + 1);
    mark(getAt(pw, elPath) as Obj, elPath, null);
    rec("element_removed", elPath);
  }

  // 2) prune + cascade until stable
  const prune = () => {
    for (const [arr, idx] of entryRemovals) for (const i of [...idx].sort((a, b) => b - a)) arr.splice(i, 1);
    entryRemovals.clear();
    for (const t of touchedBlocks.splice(0)) {
      if (!Array.isArray(t.block.paragraphs) || t.block.paragraphs.length) continue;
      const fig = t.path.length === 3 && t.path[0] === "pages" && t.path[1] === "figure_notes" ? (t.path[2] as string) : null;
      if (fig) (pw.pages.figure_notes as Record<string, unknown>)[fig] = null;
      else marked.add(t.block);
      out.fieldActions.push({ path: fmtPath(t.path), element_id: idOf(t.block) || t.element_id, action: "element_removed", sentence_sha256: t.origHash });
    }
    const filter = (v: unknown) => {
      if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0; i--) if (v[i] && typeof v[i] === "object" && marked.has(v[i] as object)) v.splice(i, 1);
        v.forEach(filter);
      } else if (isObj(v)) Object.values(v).forEach(filter);
    };
    filter(pw);
  };
  prune();
  for (let guard = 0; guard < 100; guard++) {
    let changed = false;
    walkObjects(pw, [], (o, p, inArray) => {
      if (marked.has(o)) return false;
      if (inArray) {
        const id = idOf(o);
        if (id && out.removedIds.has(id)) {
          mark(o, p, `mirror of removed element ${id}`);
          changed = true;
          return false;
        }
        for (const k of REQUIRED_REFS) {
          const v = o[k];
          if (typeof v === "string" && out.removedIds.has(v)) {
            mark(o, p, `dangling ref ${k} → ${v}`);
            changed = true;
            return false;
          }
        }
        if (isCell(p) && typeof o.holder === "string" && removedHolders.has(o.holder)) {
          mark(o, p, `cell of removed matrix holder ${o.holder}`);
          changed = true;
          return false;
        }
        if (Array.isArray(o.positions) && o.positions.length === 0 && "topic" in o) {
          mark(o, p, "interpretation without positions");
          changed = true;
          return false;
        }
      }
      for (const k of NULLABLE_REFS) {
        const v = o[k];
        if (typeof v === "string" && out.removedIds.has(v)) {
          o[k] = null;
          out.cascade.push({ path: fmtPath([...p, k]), id: v, reason: `dangling ref ${k} → null` });
          changed = true;
        }
      }
      for (const k of ID_ARRAYS) {
        const arr = o[k];
        if (!Array.isArray(arr)) continue;
        for (let i = arr.length - 1; i >= 0; i--) {
          if (typeof arr[i] === "string" && out.removedIds.has(arr[i] as string)) {
            out.cascade.push({ path: fmtPath([...p, k, i]), id: arr[i] as string, reason: `dangling ref in ${k}` });
            arr.splice(i, 1);
            changed = true;
          }
        }
      }
      return true;
    });
    prune();
    if (!changed) break;
  }
  if (secretRemoved && pw.viz.matrix && pw.viz.matrix.secrets.length === 0) {
    pw.viz.matrix = null;
    pw.work.has_matrix = false;
    pw.pages.figure_notes.matrix = null;
    out.cascade.push({ path: "$.viz.matrix", id: "", reason: "no secret left → matrix null, has_matrix false, figure_notes.matrix null" });
  }
  return out;
}

function cellId(o: Obj): string {
  if (typeof o.secret === "string" && typeof o.holder === "string") return `${o.secret}/${o.holder}/${String(o.phase ?? "")}`;
  if (typeof o.event === "string") return o.event;
  return "";
}
