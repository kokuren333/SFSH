/**
 * Auto-escaping HTML tagged template (WP-0.3 §3.1, CP-024). Every interpolated value is escaped unless it is
 * a `Raw` produced by `raw()` (trusted, code-generated markup such as SVG built by the figures module) or an
 * array of such values. public.json text is LLM-generated: NEVER pass it through raw().
 * `raw(` call sites are audited by the L1 check (grep) in the site tests.
 */
export interface Raw {
  readonly __raw: string;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]!);
}

export function raw(s: string): Raw {
  return { __raw: s };
}

function isRaw(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && typeof (v as Raw).__raw === "string";
}

function part(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(part).join("");
  if (isRaw(v)) return v.__raw;
  return esc(v);
}

/** html`<p>${text}</p>` → Raw (escaped). Nest freely: html results are Raw. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1]!;
  return { __raw: out };
}

export function toString(r: Raw): string {
  return r.__raw;
}
