/**
 * Row interpretation (§4.5), done before anything is written:
 *  - defaults: row range/medium/priority empty → command --range/--medium/--priority → 全体 / null / normal;
 *  - rows that cannot be interpreted (empty title, invalid range, invalid priority, input the shared validator rejects)
 *    are recorded as errors and never enqueued;
 *  - in-file duplicates: same (normalizeQuery(title), rangeKey(range), medium) → the later row is merged into the first.
 */
import { normalizeMediumHint } from "../../research/identify/decide.ts";
import { normalizeQuery } from "../../research/identify/normalize.ts";
import { formatRange, parseRange, rangeKey } from "../range.ts";
import { validateJobInput } from "../request.ts";
import type { Origin, Priority } from "../types.ts";
import type { RawRow } from "./parse.ts";
import type { BatchRow } from "./types.ts";

export interface PlanDefaults {
  range: string | null;
  medium: string | null;
  priority: Priority | null;
}

/** A row before submission (job fields empty). */
export type PlannedRow = BatchRow;

export function dedupKey(title: string, rangeKeyStr: string, medium: string | null): string {
  return `${normalizeQuery(title)}\u0000${rangeKeyStr}\u0000${normalizeMediumHint(medium) ?? ""}`;
}

export function planRows(rows: RawRow[], defaults: PlanDefaults, origin: Origin): PlannedRow[] {
  const firstByKey = new Map<string, number>();
  return rows.map((r): PlannedRow => {
    const rangeRaw = r.range || defaults.range || "";
    const medium = r.medium || defaults.medium || null;
    const prio = r.priority.toLowerCase();
    const row: PlannedRow = {
      line: r.line,
      input: { title: r.title, range: r.range, medium: r.medium, note: r.note, priority: r.priority },
      effective: { range_raw: rangeRaw.trim(), range_label: null, range_key: null, medium: normalizeMediumHint(medium), priority: defaults.priority ?? "normal" },
      status: "queued",
      job_id: null,
      duplicate_of_line: null,
      error: null,
      state: null,
      work_id: null,
      title_resolved: null,
      correction: false,
      merged_into: null,
      outcome: "",
    };
    const errors: string[] = [];
    if (!r.title) errors.push("title が空です");
    else if (/[\r\n]/.test(r.title)) errors.push("title に改行があります");
    if (prio === "normal" || prio === "high") row.effective.priority = prio;
    else if (prio !== "") errors.push(`priority は normal か high です: ${r.priority}`);
    const parsed = parseRange(rangeRaw);
    if (parsed.ok) {
      row.effective.range_label = formatRange(parsed.items);
      row.effective.range_key = rangeKey(parsed.items);
    } else errors.push(`invalid range: ${parsed.reason}`);
    if (r.title) for (const e of validateJobInput({ origin, work: r.title, note: r.note, medium })) if (!errors.includes(e) && e !== "作品名が空です") errors.push(e);
    if (errors.length) {
      row.status = "error";
      row.error = errors.join("／");
      row.outcome = `エラー: ${row.error}`;
      return row;
    }
    const key = dedupKey(r.title, row.effective.range_key!, medium);
    const first = firstByKey.get(key);
    if (first !== undefined) {
      row.status = "duplicate";
      row.duplicate_of_line = first;
      row.outcome = `${first}行目と重複（合流）`;
    } else {
      firstByKey.set(key, r.line);
      row.outcome = "投入予定";
    }
    return row;
  });
}
