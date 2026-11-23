/**
 * §4.5 list formats.
 *  .txt: one title per line; the whole line is the title (no range inside a line); trimmed; empty lines and lines
 *        starting with `#` are ignored.
 *  .csv: RFC 4180 (quoted fields, "" escapes, CRLF / LF / CR, newlines inside quotes). Header row required;
 *        columns title (required), range, medium, note, priority (optional; names case-insensitive, trimmed);
 *        unknown columns are ignored with a warning. Records whose fields are all blank are skipped like blank lines.
 * Every data row keeps its physical line number (1-based line where the record starts).
 * More than BATCH_LIMIT data rows → the whole file is rejected (never silently truncated).
 */
import { BATCH_LIMIT, type BatchExt, type RowInput } from "./types.ts";

export interface RawRow extends RowInput {
  line: number;
}

export type ParseResult = { ok: true; ext: BatchExt; rows: RawRow[]; header: string[] | null; warnings: string[] } | { ok: false; reason: string };

export const CSV_COLUMNS = ["title", "range", "medium", "note", "priority"] as const;
type CsvColumn = (typeof CSV_COLUMNS)[number];

export function extOf(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "");
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

const NL_RE = /\r\n|\r|\n/;

export function parseTxt(text: string): RawRow[] {
  const rows: RawRow[] = [];
  text.split(NL_RE).forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith("#")) return;
    rows.push({ line: i + 1, title: t, range: "", medium: "", note: "", priority: "" });
  });
  return rows;
}

export interface CsvRecord {
  line: number;
  fields: string[];
}

/** RFC 4180 reader. Unterminated quote or text after a closing quote → error (the file is rejected). */
export function readCsv(text: string): { ok: true; records: CsvRecord[] } | { ok: false; reason: string } {
  const records: CsvRecord[] = [];
  let line = 1;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const startLine = line;
    const fields: string[] = [];
    let endOfRecord = false;
    while (!endOfRecord) {
      let field = "";
      if (text[i] === '"') {
        const quoteLine = line;
        i++;
        for (;;) {
          if (i >= n) return { ok: false, reason: `CSV の引用符が閉じていません（${quoteLine}行目から）` };
          const c = text[i]!;
          if (c === '"') {
            if (text[i + 1] === '"') {
              field += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          if (c === "\r") {
            field += text[i + 1] === "\n" ? "\r\n" : "\r";
            i += text[i + 1] === "\n" ? 2 : 1;
            line++;
            continue;
          }
          if (c === "\n") line++;
          field += c;
          i++;
        }
        if (i < n && text[i] !== "," && text[i] !== "\r" && text[i] !== "\n") return { ok: false, reason: `CSV の閉じ引用符の後に文字があります（${line}行目）` };
      } else {
        while (i < n && text[i] !== "," && text[i] !== "\r" && text[i] !== "\n") field += text[i++];
      }
      fields.push(field);
      if (i >= n) endOfRecord = true;
      else if (text[i] === ",") i++;
      else {
        i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1;
        line++;
        endOfRecord = true;
      }
    }
    records.push({ line: startLine, fields });
  }
  return { ok: true, records };
}

function blankRecord(r: CsvRecord): boolean {
  return r.fields.every((f) => f.trim() === "");
}

export function parseCsv(text: string): { ok: true; rows: RawRow[]; header: string[]; warnings: string[] } | { ok: false; reason: string } {
  const read = readCsv(text);
  if (!read.ok) return read;
  const records = read.records.filter((r) => !blankRecord(r));
  const head = records.shift();
  if (!head) return { ok: false, reason: "CSV にヘッダ行がありません（1行目に title 列などの列名が必要です）" };
  const header = head.fields.map((h) => h.trim());
  const warnings: string[] = [];
  const col: Partial<Record<CsvColumn, number>> = {};
  header.forEach((h, idx) => {
    const k = h.toLowerCase();
    if ((CSV_COLUMNS as readonly string[]).includes(k)) {
      if (col[k as CsvColumn] === undefined) col[k as CsvColumn] = idx;
      else warnings.push(`列「${h}」が重複しています（${idx + 1}列目は無視）`);
    } else warnings.push(`未知の列「${h || "(空)"}」（${idx + 1}列目）は無視します`);
  });
  if (col.title === undefined) return { ok: false, reason: `CSV のヘッダに title 列がありません（${head.line}行目: ${header.join(",")}）` };
  const rows: RawRow[] = [];
  let extra = 0;
  for (const r of records) {
    if (r.fields.length > header.length) extra++;
    const get = (c: CsvColumn) => (col[c] === undefined ? "" : (r.fields[col[c]!] ?? "").trim());
    rows.push({ line: r.line, title: get("title"), range: get("range"), medium: get("medium"), note: get("note"), priority: get("priority") });
  }
  if (extra) warnings.push(`ヘッダより列の多い行が ${extra} 行あります（余分な列は無視）`);
  return { ok: true, rows, header, warnings };
}

/** Parse a decoded list by file extension and apply the row limit. */
export function parseList(fileName: string, text: string, limit: number = BATCH_LIMIT): ParseResult {
  const ext = extOf(fileName);
  let rows: RawRow[];
  let header: string[] | null = null;
  let warnings: string[] = [];
  if (ext === ".txt") rows = parseTxt(text);
  else if (ext === ".csv") {
    const c = parseCsv(text);
    if (!c.ok) return c;
    ({ rows, header, warnings } = c);
  } else return { ok: false, reason: `対応していない形式です（.txt か .csv）: ${ext || "(拡張子なし)"}` };
  if (rows.length > limit) return { ok: false, reason: `上限超過: タイトル行が ${rows.length} 行あります（1ファイル ${limit} 行まで）。1件も投入していません` };
  if (rows.length === 0) return { ok: false, reason: "タイトル行がありません" };
  return { ok: true, ext, rows, header, warnings };
}
