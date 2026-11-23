/**
 * WP-5.1 push-pre verification (a)–(g) of a built `dist/` (REQUIREMENTS §6.3-4, §6.1, §6.5, §5.1 A-2).
 * Pure and deterministic: reads `distDir` and `worksDir`, never writes anything. Everything except (f) blocks.
 *
 *  (a) file types: extension allow-list (html css js json svg txt xml woff2 ico, case-insensitive) + the root
 *      `.nojekyll`; any other dotfile / dot-directory, extension-less file, symlink or special file blocks.
 *  (b) only Public-set works appear: `dist/works/<id>/` dirs, catalog.json work_ids and same-site
 *      `works/<id>/` link targets must be in P; the work_id of every known non-P work must not occur in any
 *      text file (substring, after NFKC+lowercase / entity / \u decoding; occurrences that are part of a longer
 *      P work_id are not counted).
 *  (c) secret scan (token shapes, private keys, credential assignments, e-mail addresses, local paths, the repo
 *      root) over every text file (raw text and its entity-decoded / JSON-unescaped forms).
 *  (d) external resource references (things that load something) in markup / CSS / JS. Plain `<a>`/`<area>`
 *      hyperlinks, sitemap `<loc>` and JSON data are not resources.
 *  (e) A-2 re-run: every `scanDist()` finding blocks.
 *  (f) growth vs the previous snapshot (warning only).
 *  (g) catalog.json ≡ P with §6.5 fields only and clean titles / aliases / tags; list pages link only to P
 *      (works/index.html exactly P); no non-P needle (work_id, title, title_original, alias) in catalog.json
 *      or any list page.
 *
 * Secret-like values never appear verbatim in the report: they are masked as first 4 chars + "…" + sha256[0:12].
 * Non-P titles / aliases are referred to by label (e.g. `alias[1]`), never by text.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseAttrs, scanDist, tokenize, type Tok } from "../check/dist.ts";

export type CheckId = "a" | "b" | "c" | "d" | "e" | "f" | "g";
export interface VerifyFinding {
  check: CheckId;
  file: string | null;
  kind: string;
  detail: string;
}
export interface VerifyOptions {
  distDir: string;
  worksDir: string;
  /** Previous published snapshot size for (f); null/undefined = first publish (no warning). */
  previous?: { files: number; bytes: number } | null;
  /** Emails allowed by explicit owner config (default none). */
  allowEmails?: string[];
  now?: () => Date;
}
export interface VerifyReport {
  schema: "sfsh-publish-verify/1";
  dist: string;
  checked_at: string;
  files: number;
  bytes: number;
  public_set: string[]; // sorted work_ids
  ok: boolean; // true iff blocking is empty
  blocking: VerifyFinding[]; // a,b,c,d,e,g
  warnings: VerifyFinding[]; // f only (never blocks)
  checks: Record<CheckId, { ok: boolean; findings: number }>;
}

// ------------------------------------------------------------------ constants

export const ALLOWED_EXTENSIONS = ["html", "css", "js", "json", "svg", "txt", "xml", "woff2", "ico"] as const;
const ALLOWED_EXT = new Set<string>(ALLOWED_EXTENSIONS);
/** Allowed binary types: not scanned as text. */
const BINARY_EXT = new Set(["woff2", "ico"]);
const MARKUP_EXT = new Set(["html", "htm", "xhtml", "xml", "svg"]);
const CSS_EXT = new Set(["css"]);
const JS_EXT = new Set(["js", "mjs", "cjs"]);

/** §6.5 catalog fields ("これ以外を入れない"). */
export const CATALOG_FIELDS = [
  "work_id",
  "url",
  "title",
  "title_original",
  "title_reading",
  "aliases",
  "medium",
  "creators",
  "genres",
  "tags",
  "status",
  "first_release_year",
  "coverage_label",
  "spoiler_max",
  "has_matrix",
  "first_published_at",
  "updated_at",
] as const;
const CATALOG_FIELD_SET = new Set<string>(CATALOG_FIELDS);

/** Needles shorter than this (after NFKC) are not searched (same rule as works/ops.ts MIN_NEEDLE_CHARS). */
const MIN_NEEDLE_CHARS = 2;
const MIB = 1024 * 1024;
const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// ------------------------------------------------------------------ small helpers

const sha12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
/** Mask a secret-like value: first 4 chars + "…" + sha256 prefix (12 hex). */
export function mask(value: string): string {
  return Array.from(value).slice(0, 4).join("") + "…" + sha12(value);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (m, h: string) => safeCodePoint(parseInt(h, 16), m))
    .replace(/&#(\d+);?/g, (m, d: string) => safeCodePoint(Number(d), m))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&colon;/gi, ":")
    .replace(/&sol;/gi, "/")
    .replace(/&bsol;/gi, "\\")
    .replace(/&period;/gi, ".")
    .replace(/&commat;/gi, "@")
    .replace(/&Tab;/g, "\t")
    .replace(/&NewLine;/g, "\n")
    .replace(/&amp;/g, "&");
}
function safeCodePoint(n: number, fallback: string): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}
function decodeJsonEscapes(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\(["\\/])/g, "$1");
}
const norm = (s: string) => s.normalize("NFKC").toLowerCase();
/** Text forms searched for needles / secrets: raw, entity-decoded, JSON-unescaped. */
function textForms(raw: string): string[] {
  return [...new Set([raw, decodeEntities(raw), decodeJsonEscapes(raw)])];
}
const extOf = (rel: string) => path.extname(rel).slice(1).toLowerCase();
const lineOf = (s: string, i: number) => {
  let n = 1;
  for (let k = s.indexOf("\n"); k >= 0 && k < i; k = s.indexOf("\n", k + 1)) n++;
  return n;
};
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ the Public set

interface Needle {
  label: string;
  text: string;
}
interface KnownWork {
  work_id: string;
  publish_mode: string;
  needles: Needle[];
}
interface WorksView {
  public: string[];
  nonPublic: KnownWork[];
  /** Needles of P works (for collision filtering). */
  publicNeedles: Map<string, Needle[]>;
  modes: Map<string, string>;
}

interface IndexLike {
  works: { work_id: string; title?: unknown; title_original?: unknown; aliases?: { text?: unknown }[]; publish_mode?: unknown }[];
}
interface WorkLike {
  work_id?: unknown;
  title?: unknown;
  title_original?: unknown;
  aliases?: { text?: unknown }[];
  publish_mode?: unknown;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function needlesOf(workId: string, sources: (WorkLike | null | undefined)[]): Needle[] {
  const out: Needle[] = [{ label: "work_id", text: workId }];
  const seen = new Set<string>([norm(workId)]);
  const add = (label: string, v: unknown) => {
    if (typeof v !== "string" || !v.trim()) return;
    const t = v.trim();
    if (t.normalize("NFKC").trim().length < MIN_NEEDLE_CHARS) return;
    const k = norm(t);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ label, text: t });
  };
  for (const s of sources) {
    if (!s) continue;
    if (typeof s.work_id === "string" && s.work_id !== workId) add("work_id", s.work_id);
    add("title", s.title);
    add("title_original", s.title_original);
    (Array.isArray(s.aliases) ? s.aliases : []).forEach((a, i) => add(`alias[${i}]`, a?.text));
  }
  return out;
}

function loadWorks(worksDir: string): WorksView {
  const root = path.resolve(worksDir);
  const index = readJson<IndexLike>(path.join(root, "INDEX.json"));
  if (!index || !Array.isArray(index.works)) throw new Error(`works/INDEX.json missing or unreadable (${path.join(root, "INDEX.json")})`);
  const entries = new Map<string, IndexLike["works"][number]>();
  for (const e of index.works) if (e && typeof e.work_id === "string" && !entries.has(e.work_id)) entries.set(e.work_id, e);
  const dirs: string[] = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (d.isDirectory() && fs.existsSync(path.join(root, d.name, "work.json"))) dirs.push(d.name);
  }
  const ids = [...new Set([...entries.keys(), ...dirs])].sort(cmp);
  const pub: string[] = [];
  const modes = new Map<string, string>();
  const all: KnownWork[] = [];
  for (const id of ids) {
    const entry = entries.get(id);
    const work = SAFE_SEGMENT.test(id) ? readJson<WorkLike>(path.join(root, id, "work.json")) : null;
    const mode = typeof entry?.publish_mode === "string" ? entry.publish_mode : typeof work?.publish_mode === "string" ? `${work.publish_mode} (not in INDEX)` : "unknown";
    modes.set(id, mode);
    let isPublic = false;
    if (entry && entry.publish_mode === "Public" && SAFE_SEGMENT.test(id)) {
      try {
        isPublic = fs.statSync(path.join(root, id, "gen", "public.json")).isFile();
      } catch {
        isPublic = false;
      }
    }
    if (isPublic) pub.push(id);
    all.push({ work_id: id, publish_mode: mode, needles: needlesOf(id, [work, entry as WorkLike | undefined]) });
  }
  const publicSetIds = new Set(pub);
  const publicNeedles = new Map<string, Needle[]>();
  for (const w of all) if (publicSetIds.has(w.work_id)) publicNeedles.set(w.work_id, w.needles);
  // A non-P needle that is (part of) an identifier of a P work cannot be told apart from that P work: skip it.
  const pNorm = [...publicNeedles.values()].flat().map((n) => norm(n.text));
  const nonPublic = all
    .filter((w) => !publicSetIds.has(w.work_id))
    .map((w) => ({ ...w, needles: w.needles.filter((n) => n.label === "work_id" || !pNorm.some((p) => p.includes(norm(n.text)))) }));
  return { public: pub, nonPublic, publicNeedles, modes };
}

/**
 * P = INDEX.json entries with publish_mode "Public" whose `gen/public.json` exists (the build's input set,
 * harness/src/site/stage.ts). Everything else known (other INDEX entries, `works/<dir>/work.json` missing from
 * INDEX) is non-public, with its needles (work_id, title, title_original, alias texts from work.json + INDEX;
 * ≥ 2 chars after NFKC; needles that are part of a P work's identifiers are dropped).
 */
export function publicSet(worksDir: string): { public: string[]; nonPublic: { work_id: string; publish_mode: string; needles: string[] }[] } {
  const v = loadWorks(worksDir);
  return { public: v.public, nonPublic: v.nonPublic.map((w) => ({ work_id: w.work_id, publish_mode: w.publish_mode, needles: w.needles.map((n) => n.text) })) };
}

// ------------------------------------------------------------------ dist walk

interface DistEntry {
  rel: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
}
function walk(root: string, rel = ""): DistEntry[] {
  const out: DistEntry[] = [];
  const names = fs.readdirSync(path.join(root, rel)).sort(cmp);
  for (const name of names) {
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(path.join(root, r));
    if (st.isSymbolicLink()) out.push({ rel: r, type: "symlink", size: 0 });
    else if (st.isDirectory()) {
      out.push({ rel: r, type: "dir", size: 0 });
      out.push(...walk(root, r));
    } else if (st.isFile()) out.push({ rel: r, type: "file", size: st.size });
    else out.push({ rel: r, type: "other", size: 0 });
  }
  return out;
}

// ------------------------------------------------------------------ (a)

function checkFileTypes(entries: DistEntry[]): VerifyFinding[] {
  const out: VerifyFinding[] = [];
  const dotDirs: string[] = [];
  const inDotDir = (rel: string) => dotDirs.some((d) => rel.startsWith(d + "/"));
  for (const e of entries) {
    const name = e.rel.split("/").pop()!;
    if (inDotDir(e.rel)) continue; // the dot-directory itself is the finding
    const f = (kind: string, detail: string) => out.push({ check: "a", file: e.type === "dir" ? e.rel + "/" : e.rel, kind, detail });
    if (e.type === "symlink") {
      f("symlink", "symbolic links are not publishable");
      continue;
    }
    if (e.type === "other") {
      f("special_file", "not a regular file or directory");
      continue;
    }
    if (e.type === "dir") {
      if (name.startsWith(".")) {
        dotDirs.push(e.rel);
        f("dot_directory", "dot-directories are not publishable (e.g. .git/)");
      }
      continue;
    }
    if (e.rel === ".nojekyll") continue;
    if (name.startsWith(".")) {
      f("dotfile", "dotfiles other than the root .nojekyll are not publishable");
      continue;
    }
    const ext = extOf(name);
    if (!ext) f("no_extension", "files without an extension are not publishable");
    else if (!ALLOWED_EXT.has(ext)) f("extension_not_allowed", `extension .${ext} is not in the allow-list (${ALLOWED_EXTENSIONS.join(", ")})`);
  }
  return out;
}

// ------------------------------------------------------------------ (c) secrets

interface SecretRule {
  kind: string;
  re: () => RegExp;
  keep?: (m: string) => boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The repository root in the forms it could leak in: backslash, slash, JSON-escaped, Git Bash (/c/...). */
function repoRootForms(): string[] {
  const r = REPO_ROOT.replace(/[\\/]+$/, "");
  const slash = r.replace(/\\/g, "/");
  const forms = new Set([r, slash, r.replace(/\\/g, "\\\\")]);
  const drive = /^([A-Za-z]):\/(.*)$/.exec(slash);
  if (drive) forms.add(`/${drive[1].toLowerCase()}/${drive[2]}`);
  return [...forms].filter((f) => f.length >= 4);
}

const PATH_TAIL = "[^\\s\"'<>`]*";

function secretRules(allowEmails: string[]): SecretRule[] {
  const allowed = new Set(allowEmails.map((e) => e.trim().toLowerCase()));
  const repo = repoRootForms();
  return [
    { kind: "github_token", re: () => /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,}(?![A-Za-z0-9_])/g },
    { kind: "github_pat", re: () => /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}/g },
    {
      kind: "discord_token",
      re: () => /(?<![A-Za-z\d_-])[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}(?![A-Za-z\d_-])/g,
      // A dotted chain of plain identifiers (letters only in every segment) is code, not a token.
      keep: (m) => !m.split(".").every((seg) => /^[A-Za-z]+$/.test(seg)),
    },
    { kind: "aws_access_key", re: () => /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g },
    { kind: "anthropic_key", re: () => /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g },
    { kind: "api_key_sk", re: () => /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{20,}/g },
    { kind: "slack_token", re: () => /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g },
    { kind: "google_api_key", re: () => /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g },
    { kind: "private_key", re: () => /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
    { kind: "credential_assignment", re: () => /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["'][^"'\s]{12,}["']/gi },
    {
      kind: "email",
      re: () => /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g,
      keep: (m) => !allowed.has(m.toLowerCase()),
    },
    { kind: "local_path_windows", re: () => new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:\\\\${PATH_TAIL}`, "g") },
    { kind: "local_path_windows", re: () => new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:/(?:Users|Windows|Program)${PATH_TAIL}`, "gi") },
    { kind: "local_path_windows", re: () => new RegExp(`\\\\Users\\\\${PATH_TAIL}`, "gi") },
    // Not inside a URL path (a URL path segment is always preceded by a host / segment character).
    { kind: "local_path_unix", re: () => new RegExp(`(?<![\\w.%~/+-])/(?:Users|home)/[A-Za-z0-9._-]+${PATH_TAIL}`, "g") },
    { kind: "file_uri", re: () => new RegExp(`file://${PATH_TAIL}`, "gi") },
    ...repo.map((form) => ({ kind: "repo_root_path", re: () => new RegExp(escapeRe(form), "gi") })),
  ];
}

interface SecretHit {
  kind: string;
  value: string;
  line: number | null;
}

function scanSecrets(text: string, rules: SecretRule[]): SecretHit[] {
  const hits: SecretHit[] = [];
  const seen = new Set<string>();
  textForms(text).forEach((form, fi) => {
    for (const r of rules) {
      for (const m of form.matchAll(r.re())) {
        if (r.keep && !r.keep(m[0])) continue;
        const key = `${r.kind}\u0000${m[0]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ kind: r.kind, value: m[0], line: fi === 0 ? lineOf(form, m.index) : null });
      }
    }
  });
  return hits;
}

// ------------------------------------------------------------------ (d) external references

/** XML namespace URIs (identifiers, never fetched). */
const NAMESPACE_URIS = new Set([
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/XML/1998/namespace",
  "http://www.w3.org/2000/xmlns/",
  "http://www.w3.org/1998/Math/MathML",
  "http://www.sitemaps.org/schemas/sitemap/0.9",
]);

function cleanUrl(v: string): string {
  // Browsers strip leading/trailing C0/space and remove tab/newline anywhere in URLs.
  return decodeEntities(v).replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
}
/** Absolute (any scheme except data:, which A-2 handles) or protocol-relative (`//host`, `\\host`). */
function isExternal(v: string): boolean {
  const u = cleanUrl(v);
  if (/^[\\/]{2}/.test(u)) return true;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(u);
  return !!m && m[1].toLowerCase() !== "data";
}
/** What to show for an external URL: scheme + host only (never the full URL — it may carry a token). */
function describeUrl(v: string): string {
  const u = cleanUrl(v);
  try {
    const p = new URL(/^[\\/]{2}/.test(u) ? "https:" + u.replace(/\\/g, "/") : u);
    if (p.host) return `${/^[\\/]{2}/.test(u) ? "//" : p.protocol + "//"}${p.host}`;
    return p.protocol;
  } catch {
    return mask(u);
  }
}

interface RefHit {
  kind: string;
  detail: string;
}

function cssRefs(css: string): string[] {
  const s = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ");
  const out: string[] = [];
  for (const m of s.matchAll(/(?<![\w-])url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of s.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) out.push(m[1] ?? m[2] ?? "");
  for (const m of s.matchAll(/(?<![\w-])(?:-webkit-)?image-set\(([^)]*)\)/gi)) for (const q of m[1].matchAll(/"([^"]*)"|'([^']*)'/g)) out.push(q[1] ?? q[2] ?? "");
  return out;
}
function scanCssRefs(css: string, where: string): RefHit[] {
  return cssRefs(css)
    .filter(isExternal)
    .map((u) => ({ kind: "external_css_url", detail: `${where}: url(…)/@import to ${describeUrl(u)}` }));
}

function scanJsRefs(js: string, where: string): RefHit[] {
  const out: RefHit[] = [];
  for (const m of js.matchAll(/(?:https?|wss?):\/\/[^\s"'`<>)\\]*/gi)) {
    if (NAMESPACE_URIS.has(m[0])) continue;
    out.push({ kind: "external_js_url", detail: `${where}: absolute URL to ${describeUrl(m[0])}` });
  }
  for (const m of js.matchAll(/["'`](?:\/\/|\\\/\\\/)[A-Za-z0-9[]/g)) out.push({ kind: "external_js_url", detail: `${where}: protocol-relative URL string (${mask(js.slice(m.index, m.index + 40))})` });
  return out;
}

const URL_ATTRS = new Set(["src", "poster", "data", "action", "formaction", "background", "manifest", "lowsrc", "dynsrc", "codebase", "archive", "longdesc", "icon"]);
const JS_TYPES = new Set(["", "module", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "application/x-javascript", "text/jscript"]);

function scanMarkupRefs(text: string): RefHit[] {
  const out: RefHit[] = [];
  for (const m of text.matchAll(/<\?xml-stylesheet\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const v = m[1] ?? m[2] ?? "";
    if (isExternal(v)) out.push({ kind: "external_xml_stylesheet", detail: `<?xml-stylesheet href> to ${describeUrl(v)}` });
  }
  const toks: Tok[] = tokenize(text);
  for (const t of toks) {
    if (t.close) continue;
    const attrs = parseAttrs(t);
    const attr = (n: string) => attrs.find((a) => a.name === n)?.value ?? null;
    const tag = `<${t.name}>`;
    for (const a of attrs) {
      const v = a.value;
      if (v === null) continue;
      if (URL_ATTRS.has(a.name)) {
        if (isExternal(v)) out.push({ kind: t.name === "script" ? "external_script" : "external_attr", detail: `${tag} ${a.name}= to ${describeUrl(v)}` });
      } else if (a.name === "srcset" || a.name === "imagesrcset") {
        for (const cand of decodeEntities(v).split(",")) {
          const u = cand.trim().split(/\s+/)[0] ?? "";
          if (u && isExternal(u)) out.push({ kind: "external_srcset", detail: `${tag} ${a.name}= to ${describeUrl(u)}` });
        }
      } else if (a.name === "ping") {
        for (const u of decodeEntities(v).split(/\s+/)) if (u && isExternal(u)) out.push({ kind: "external_attr", detail: `${tag} ping= to ${describeUrl(u)}` });
      } else if (a.name === "href" || a.name === "xlink:href") {
        if (t.name === "a" || t.name === "area") continue; // hyperlinks are allowed
        if (!isExternal(v)) continue;
        const kind = t.name === "link" ? "external_link" : t.name === "base" ? "external_base" : "external_svg_href";
        out.push({ kind, detail: `${tag} ${a.name}= to ${describeUrl(v)}` });
      } else if (a.name === "style") {
        out.push(...scanCssRefs(decodeEntities(v), `${tag} style=`));
      } else if (a.name.startsWith("on")) {
        out.push(...scanJsRefs(decodeEntities(v), `${tag} ${a.name}=`));
      } else if (a.name === "content" && t.name === "meta" && (attr("http-equiv") ?? "").trim().toLowerCase() === "refresh") {
        const m = /url\s*=\s*['"]?([^'"]*)/i.exec(decodeEntities(v));
        if (m && isExternal(m[1])) out.push({ kind: "external_meta_refresh", detail: `<meta http-equiv=refresh> to ${describeUrl(m[1])}` });
      }
    }
    if (t.body) {
      const body = text.slice(t.body[0], t.body[1]);
      if (t.name === "style") out.push(...scanCssRefs(body, "<style>"));
      else if (t.name === "script" && attr("src") === null && JS_TYPES.has((attr("type") ?? "").trim().toLowerCase())) out.push(...scanJsRefs(body, "inline <script>"));
    }
  }
  return out;
}

function scanExternalRefs(rel: string, text: string): RefHit[] {
  const ext = extOf(rel);
  if (MARKUP_EXT.has(ext)) return scanMarkupRefs(text);
  if (CSS_EXT.has(ext)) return scanCssRefs(text, "stylesheet");
  if (JS_EXT.has(ext)) return scanJsRefs(text, "script");
  return [];
}

// ------------------------------------------------------------------ links to works

const LINK_ATTRS = new Set(["href", "xlink:href", "src", "action", "formaction"]);
const SITE_BASE = "https://dist.invalid/";

function idFromPath(pathname: string, anywhere: boolean): string | null {
  const m = (anywhere ? /\/works\/([^/]+)\// : /^\/works\/([^/]+)\//).exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Work ids targeted by same-site `works/<id>/…` links in a markup file (and by sitemap `<loc>` URLs). */
function linkedWorkIds(rel: string, text: string): string[] {
  const ext = extOf(rel);
  if (!MARKUP_EXT.has(ext)) return [];
  const ids = new Set<string>();
  const base = SITE_BASE + rel.split("/").map(encodeURIComponent).join("/");
  for (const t of tokenize(text)) {
    if (t.close) continue;
    for (const a of parseAttrs(t)) {
      if (!LINK_ATTRS.has(a.name) || a.value === null) continue;
      let u: URL;
      try {
        u = new URL(cleanUrl(a.value), base);
      } catch {
        continue;
      }
      if (u.origin !== new URL(SITE_BASE).origin) continue; // external hyperlinks are not site pages
      const id = idFromPath(u.pathname, false);
      if (id) ids.add(id);
    }
  }
  // sitemap.xml: <loc>absolute URL</loc> under the configured base URL (unknown here): look for /works/<id>/.
  for (const m of text.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/gi)) {
    try {
      const id = idFromPath(new URL(decodeEntities(m[1]), base).pathname, true);
      if (id) ids.add(id);
    } catch {
      /* not a URL */
    }
  }
  return [...ids].sort(cmp);
}

const isListPage = (rel: string) =>
  ["index.html", "works/index.html", "search/index.html", "sitemap/index.html", "sitemap.xml"].includes(rel) || /^(?:genres|media|creators)\//.test(rel);

// ------------------------------------------------------------------ verify

export function verifyDist(opts: VerifyOptions): VerifyReport {
  const dist = path.resolve(opts.distDir);
  const now = opts.now ?? (() => new Date());
  const blocking: VerifyFinding[] = [];
  const warnings: VerifyFinding[] = [];
  const add = (f: VerifyFinding) => (f.check === "f" ? warnings : blocking).push(f);

  // Public set
  let works: WorksView;
  try {
    works = loadWorks(opts.worksDir);
  } catch (e) {
    add({ check: "b", file: null, kind: "public_set_unavailable", detail: (e as Error).message.replace(/\(.*\)$/, "").trim() });
    works = { public: [], nonPublic: [], publicNeedles: new Map(), modes: new Map() };
  }
  const P = new Set(works.public);
  const kindFor = (id: string) => ((works.modes.get(id) ?? "").startsWith("Restricted") ? "restricted_work" : "not_in_public_set");
  const modeOf = (id: string) => works.modes.get(id) ?? "unknown work";

  // Walk
  let entries: DistEntry[] = [];
  try {
    if (!fs.statSync(dist).isDirectory()) throw new Error("not a directory");
    entries = walk(dist);
  } catch (e) {
    add({ check: "a", file: null, kind: "dist_unreadable", detail: `dist directory unreadable: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` });
  }
  const files = entries.filter((e) => e.type === "file");
  const fileCount = files.length;
  const bytes = files.reduce((s, e) => s + e.size, 0);

  // (a)
  for (const f of checkFileTypes(entries)) add(f);

  // text files (regular files that are not allowed binary types)
  const texts = new Map<string, string>();
  for (const e of files) if (!BINARY_EXT.has(extOf(e.rel))) texts.set(e.rel, fs.readFileSync(path.join(dist, e.rel), "utf8"));

  // (b) work ids appearing in dist
  const appearing = new Map<string, Set<string>>(); // id -> via
  const via = (id: string, how: string) => {
    if (!appearing.has(id)) appearing.set(id, new Set());
    appearing.get(id)!.add(how);
  };
  for (const e of entries) {
    const m = /^works\/([^/]+)$/.exec(e.rel);
    if (m && e.type === "dir") via(m[1], "dist directory works/" + m[1] + "/");
  }
  let catalog: unknown = undefined;
  let catalogError: VerifyFinding | null = null;
  const catalogText = texts.get("catalog.json");
  if (catalogText === undefined) catalogError = { check: "g", file: "catalog.json", kind: "catalog_missing", detail: "catalog.json does not exist" };
  else {
    try {
      catalog = JSON.parse(catalogText);
      if (!Array.isArray(catalog)) catalogError = { check: "g", file: "catalog.json", kind: "catalog_not_array", detail: "catalog.json is not a JSON array" };
    } catch (e) {
      catalogError = { check: "g", file: "catalog.json", kind: "catalog_invalid_json", detail: `catalog.json does not parse: ${(e as Error).message.slice(0, 80)}` };
    }
  }
  const catalogItems: unknown[] = Array.isArray(catalog) ? catalog : [];
  for (const it of catalogItems) {
    const id = it && typeof it === "object" ? (it as { work_id?: unknown }).work_id : undefined;
    if (typeof id === "string") via(id, "catalog.json work_id");
  }
  const linksByFile = new Map<string, string[]>();
  for (const [rel, text] of texts) {
    const ids = linkedWorkIds(rel, text);
    linksByFile.set(rel, ids);
    for (const id of ids) via(id, `link in ${rel}`);
  }
  for (const [id, hows] of [...appearing].sort((a, b) => cmp(a[0], b[0]))) {
    if (P.has(id)) continue;
    const list = [...hows].sort(cmp);
    for (const how of list) {
      const file = how.startsWith("dist directory ") ? how.slice("dist directory ".length) : how.startsWith("link in ") ? how.slice("link in ".length) : "catalog.json";
      add({ check: "b", file, kind: kindFor(id), detail: `work ${id} (${modeOf(id)}) appears via ${how.startsWith("dist directory ") ? "dist directory" : how.startsWith("link in ") ? "works/<id>/ link" : "catalog.json work_id"}` });
    }
  }
  // (b) non-P work_id strings anywhere in text
  const pIds = [...P];
  for (const [rel, text] of texts) {
    const forms = textForms(text).map(norm);
    for (const w of works.nonPublic) {
      const id = norm(w.work_id);
      if (id.length < MIN_NEEDLE_CHARS) continue;
      const hit = forms.some((f) => occursOutsideLongerIds(f, id, pIds.map(norm)));
      if (hit) add({ check: "b", file: rel, kind: kindFor(w.work_id), detail: `work_id of ${w.work_id} (${w.publish_mode}) occurs in the file text` });
    }
  }

  // (c)
  const rules = secretRules(opts.allowEmails ?? []);
  for (const [rel, text] of texts) {
    for (const h of scanSecrets(text, rules)) add({ check: "c", file: rel, kind: h.kind, detail: `value ${mask(h.value)}${h.line !== null ? ` at line ${h.line}` : " (after decoding)"}` });
  }

  // (d)
  for (const [rel, text] of texts) for (const h of scanExternalRefs(rel, text)) add({ check: "d", file: rel, kind: h.kind, detail: h.detail });

  // (e)
  if (entries.length) {
    try {
      for (const f of scanDist(dist)) add({ check: "e", file: f.file, kind: `a2_${f.kind}`, detail: `A-2 ${f.kind} (sha256 ${f.sha256})` });
    } catch (e) {
      add({ check: "e", file: null, kind: "a2_scan_error", detail: `A-2 scan failed: ${(e as NodeJS.ErrnoException).code ?? "error"}` });
    }
  }

  // (f)
  if (opts.previous) {
    const p = opts.previous;
    if (fileCount > p.files * 1.5 && fileCount - p.files > 20)
      add({ check: "f", file: null, kind: "file_count_growth", detail: `files ${p.files} -> ${fileCount} (+${fileCount - p.files})` });
    if (bytes > p.bytes * 1.5 && bytes - p.bytes > MIB) add({ check: "f", file: null, kind: "size_growth", detail: `bytes ${p.bytes} -> ${bytes} (+${bytes - p.bytes})` });
  }

  // (g) catalog
  if (catalogError) add(catalogError);
  else {
    const seen = new Map<string, number>();
    catalogItems.forEach((it, i) => {
      if (!it || typeof it !== "object" || Array.isArray(it) || typeof (it as { work_id?: unknown }).work_id !== "string") {
        add({ check: "g", file: "catalog.json", kind: "catalog_item_invalid", detail: `item [${i}] is not an object with a string work_id` });
        return;
      }
      const item = it as Record<string, unknown>;
      const id = item.work_id as string;
      seen.set(id, (seen.get(id) ?? 0) + 1);
      for (const k of Object.keys(item).sort(cmp))
        if (!CATALOG_FIELD_SET.has(k)) add({ check: "g", file: "catalog.json", kind: "catalog_field_not_allowed", detail: `work ${id}: field "${k}" is not a §6.5 catalog field` });
      const values: [string, unknown][] = [
        ["title", item.title],
        ["title_original", item.title_original],
        ...(Array.isArray(item.aliases) ? item.aliases.map((a, j) => [`aliases[${j}]`, a] as [string, unknown]) : []),
        ...(Array.isArray(item.tags) ? item.tags.map((a, j) => [`tags[${j}]`, a] as [string, unknown]) : []),
      ];
      for (const [field, v] of values) {
        if (typeof v !== "string") continue;
        for (const h of scanSecrets(v, rules)) add({ check: "g", file: "catalog.json", kind: "catalog_secret", detail: `work ${id}: ${field} hits (c) ${h.kind} (${mask(h.value)})` });
      }
    });
    for (const [id, n] of [...seen].sort((a, b) => cmp(a[0], b[0]))) {
      if (n > 1) add({ check: "g", file: "catalog.json", kind: "catalog_duplicate_work", detail: `work ${id} listed ${n} times` });
      if (!P.has(id)) add({ check: "g", file: "catalog.json", kind: kindFor(id) === "restricted_work" ? "catalog_restricted_work" : "catalog_extra_work", detail: `work ${id} (${modeOf(id)}) is not in the Public set` });
    }
    for (const id of works.public) if (!seen.has(id)) add({ check: "g", file: "catalog.json", kind: "catalog_missing_work", detail: `Public work ${id} is missing from catalog.json` });
  }
  // (g) list pages
  const indexLinks = linksByFile.get("works/index.html");
  if (indexLinks === undefined) add({ check: "g", file: "works/index.html", kind: "works_index_missing", detail: "works/index.html does not exist" });
  else {
    const linked = new Set(indexLinks);
    for (const id of works.public) if (!linked.has(id)) add({ check: "g", file: "works/index.html", kind: "works_index_missing_work", detail: `Public work ${id} is not linked from the works index` });
  }
  for (const [rel, ids] of [...linksByFile].sort((a, b) => cmp(a[0], b[0]))) {
    if (!isListPage(rel)) continue;
    for (const id of ids) if (!P.has(id)) add({ check: "g", file: rel, kind: "list_page_non_public_work", detail: `links to work ${id} (${modeOf(id)}), not in the Public set` });
  }
  for (const [rel, text] of [...texts].sort((a, b) => cmp(a[0], b[0]))) {
    if (rel !== "catalog.json" && !isListPage(rel)) continue;
    const forms = textForms(text).map(norm);
    for (const w of works.nonPublic) {
      for (const n of w.needles) {
        if (n.label === "work_id") {
          if (forms.some((f) => occursOutsideLongerIds(f, norm(n.text), pIds.map(norm))))
            add({ check: "g", file: rel, kind: "non_public_trace", detail: `work ${w.work_id} (${w.publish_mode}): ${n.label} found` });
        } else if (forms.some((f) => f.includes(norm(n.text)))) add({ check: "g", file: rel, kind: "non_public_trace", detail: `work ${w.work_id} (${w.publish_mode}): ${n.label} found` });
      }
    }
  }

  // report
  const dedupe = (xs: VerifyFinding[]) => {
    const m = new Map<string, VerifyFinding>();
    for (const f of xs) m.set(`${f.check}\u0000${f.file}\u0000${f.kind}\u0000${f.detail}`, f);
    return [...m.values()].sort((a, b) => cmp(a.check, b.check) || cmp(a.file ?? "", b.file ?? "") || cmp(a.kind, b.kind) || cmp(a.detail, b.detail));
  };
  const B = dedupe(blocking);
  const W = dedupe(warnings);
  const checks = {} as Record<CheckId, { ok: boolean; findings: number }>;
  for (const c of ["a", "b", "c", "d", "e", "f", "g"] as CheckId[]) {
    const n = (c === "f" ? W : B).filter((f) => f.check === c).length;
    checks[c] = { ok: n === 0, findings: n };
  }
  return {
    schema: "sfsh-publish-verify/1",
    dist,
    checked_at: now().toISOString(),
    files: fileCount,
    bytes,
    public_set: [...works.public].sort(cmp),
    ok: B.length === 0,
    blocking: B,
    warnings: W,
    checks,
  };
}

/** `needle` occurs in `hay` at a position that is not just part of a longer P work_id containing it. */
function occursOutsideLongerIds(hay: string, needle: string, pIds: string[]): boolean {
  const longer = pIds.filter((p) => p !== needle && p.includes(needle));
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const covered = longer.some((p) => {
      for (let k = p.indexOf(needle); k >= 0; k = p.indexOf(needle, k + 1)) if (i - k >= 0 && hay.startsWith(p, i - k)) return true;
      return false;
    });
    if (!covered) return true;
  }
  return false;
}
