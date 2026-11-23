/**
 * A-2(b) image / media contamination in the build output (§5.1, PLAN "A-2 (b)"). Our renderer only emits
 * html / css / js / json / txt (+ .nojekyll) with inline, code-generated SVG; anything else that looks like media
 * is removed, and what cannot be removed safely fails the build (implementation bug).
 *
 * Rules (per file, `kind` → action):
 *  - media extension (MEDIA_EXTENSIONS)                                → media_file   → delete the file
 *  - media magic bytes, any extension (PNG, JPEG, GIF, WebP/WAV/AVI, BMP, ICO, TIFF, MP3, Ogg, FLAC, MIDI,
 *    ISO-BMFF ftyp (mp4/mov/heic/avif), Matroska/WebM, ASF, AIFF, AMR, MPEG-PS, JPEG XL, PSD, SWF, FLV)
 *                                                                      → media_magic  → delete the file
 *  - HTML / XML / SVG markup:
 *      media elements img, picture, source, video, audio, track, iframe, embed, object, applet, frame(set),
 *      portal, bgsound, input[type=image], sitemap image:image / video:video   → html_media_tag → element removed
 *      SVG <image>, <feImage>                                                 → svg_image      → element removed
 *      SVG <foreignObject>                                                    → svg_foreign_object → element removed
 *      SVG <use> whose href is not a #fragment                                → svg_use_external → element removed
 *      <link> icons / image|audio|video preloads / media hrefs, <meta> og:image|video|audio, twitter:image|player
 *                                                                             → html_media_tag → tag removed
 *      srcset / imagesrcset attributes                                        → srcset         → attribute removed
 *      poster / background / lowsrc / dynsrc attributes                       → media_attr     → attribute removed
 *      style attribute declarations with url(…) (not url(#…)) or image-set(…) → css_url        → declaration removed
 *      other attributes containing url(…) (not #fragment)                     → css_url        → attribute removed
 *      attributes containing data:image|audio|video URIs                      → data_uri       → attribute removed
 *      attributes (except <a>/<area> links) with media-extension / embed URLs → media_url / embed_url → attribute removed
 *      <style> contents → CSS rules; inline <script> contents → JS rules
 *  - CSS: declarations with url(…) except url(#…), image-set(…)            → css_url    → declaration removed
 *         @import of an external (http(s): or //) or data: target          → css_import → statement removed
 *  - JS: new Image( / new Audio(, createElement("img"|"video"|"audio"|"iframe"|…), media tags in strings,
 *        data: media URIs, media-extension / embed URLs, CSS url(…)        → js_media / data_uri / media_url / embed_url / css_url → unremovable
 *  - JSON: strings with A-2(a) matches                                     → (A-2(a) kind) → stripped (re-serialized)
 *  - other text: data:image|audio|video URIs                               → data_uri   → stripped
 * Text nodes of HTML are not scanned (the renderer escapes all text, so a URL there is inert text, not an embed).
 */
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { MEDIA_EXTENSIONS, RE, stripMedia } from "./a2.ts";

export type DistKind =
  | "media_file"
  | "media_magic"
  | "html_media_tag"
  | "srcset"
  | "media_attr"
  | "css_url"
  | "css_import"
  | "svg_image"
  | "svg_foreign_object"
  | "svg_use_external"
  | "data_uri"
  | "media_url"
  | "embed_url"
  | "markdown_image"
  | "js_media";

export interface DistFinding {
  /** Path relative to the dist root, "/" separated. */
  file: string;
  kind: DistKind;
  action: "delete" | "strip" | "unremovable";
  /** sha256 prefix (16 hex) of the matched snippet (or of the whole file for file-level findings). */
  sha256: string;
}

export interface DistA2Report {
  schema: "sfsh-a2-dist/1";
  checked_at: string;
  out: string;
  files_scanned: number;
  detected: DistFinding[];
  removed: number;
  unremovable: DistFinding[];
  residual_after_fix: number;
  residual: DistFinding[];
}

const h16 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const MEDIA_EXT = new Set(MEDIA_EXTENSIONS);
const MARKUP_EXT = new Set(["html", "htm", "xhtml", "xml", "svg"]);
const CSS_EXT = new Set(["css"]);
const JS_EXT = new Set(["js", "mjs", "cjs"]);
const JSON_EXT = new Set(["json", "webmanifest"]);
const FONT_EXT = new Set(["woff2", "woff", "ttf", "otf", "eot"]);

type Hit = { kind: DistKind; sha256: string; action: DistFinding["action"] };

// ------------------------------------------------------------------ magic bytes
export function mediaMagic(b: Buffer): string | null {
  const ascii = (s: number, e: number) => (b.length >= e ? b.toString("latin1", s, e) : "");
  if (b.length >= 4 && b[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ["WEBP", "WAVE", "AVI "].includes(ascii(8, 12))) return ascii(8, 12).trim().toLowerCase();
  if (b.length >= 14 && b[0] === 0x42 && b[1] === 0x4d && b.readUInt32LE(6) === 0) return "bmp";
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0 && b[4] > 0) return "ico";
  if (ascii(0, 4) === "II*\u0000" || ascii(0, 4) === "MM\u0000*") return "tiff";
  if (ascii(0, 3) === "ID3") return "mp3";
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "mpeg-audio";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(0, 4) === "MThd") return "midi";
  if (ascii(4, 8) === "ftyp") return "isobmff";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "matroska";
  if (b.length >= 4 && b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return "asf";
  if (ascii(0, 4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(8, 12))) return "aiff";
  if (ascii(0, 5) === "#!AMR") return "amr";
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && (b[3] === 0xba || b[3] === 0xb3)) return "mpeg";
  if ((b.length >= 2 && b[0] === 0xff && b[1] === 0x0a) || ascii(4, 8) === "JXL ") return "jxl";
  if (ascii(0, 4) === "8BPS") return "psd";
  if (["FWS", "CWS", "ZWS"].includes(ascii(0, 3))) return "swf";
  if (ascii(0, 3) === "FLV") return "flv";
  return null;
}

// ------------------------------------------------------------------ CSS
export type Range = [number, number];

function mergeRanges(rs: Range[]): Range[] {
  const s = [...rs].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r] as Range);
  }
  return out;
}
function cut(s: string, rs: Range[]): string {
  let out = "";
  let pos = 0;
  for (const [a, b] of mergeRanges(rs)) {
    out += s.slice(pos, a);
    pos = b;
  }
  return out + s.slice(pos);
}

/** Index just after the parenthesized group that opens at `open` (s[open] === "("), honoring quotes. */
function closeParen(s: string, open: number): number {
  let depth = 0;
  let q: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return s.length;
}

/** Remove media declarations / imports from CSS text (a stylesheet, a <style> body, or a style attribute value). */
export function sanitizeCss(css: string): { out: string; hits: Hit[] } {
  const comments: Range[] = [...css.matchAll(/\/\*[\s\S]*?(?:\*\/|$)/g)].map((m) => [m.index, m.index + m[0].length]);
  const inComment = (i: number) => comments.some(([a, b]) => i >= a && i < b);
  const ranges: Range[] = [];
  const hits: Hit[] = [];
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?(['"]?)\s*([^'")\s;]+)/gi)) {
    if (inComment(m.index)) continue;
    if (!/^(?:https?:)?\/\//i.test(m[2]) && !/^data:/i.test(m[2])) continue;
    let end = css.indexOf(";", m.index);
    end = end < 0 ? css.length : end + 1;
    ranges.push([m.index, end]);
    hits.push({ kind: "css_import", sha256: h16(css.slice(m.index, end)), action: "strip" });
  }
  const inRanges = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
  const decls: Range[] = [];
  for (const m of css.matchAll(/(?<![\w-])(url|(?:-webkit-)?image-set)\(/gi)) {
    if (inComment(m.index) || inRanges(m.index)) continue;
    const open = m.index + m[0].length - 1;
    if (m[1].toLowerCase() === "url" && /^\(\s*['"]?\s*#/.test(css.slice(open))) continue;
    let start = Math.max(css.lastIndexOf(";", m.index), css.lastIndexOf("{", m.index), css.lastIndexOf("}", m.index)) + 1;
    while (start < m.index && /\s/.test(css[start])) start++;
    let end = closeParen(css, open);
    while (end < css.length && css[end] !== ";" && css[end] !== "}") end++;
    if (css[end] === ";") {
      end++;
      while (end < css.length && (css[end] === " " || css[end] === "	")) end++;
    }
    if (decls.some(([a, b]) => start >= a && start < b)) continue;
    decls.push([start, end]);
    hits.push({ kind: "css_url", sha256: h16(css.slice(start, end)), action: "strip" });
  }
  ranges.push(...decls);
  return { out: hits.length ? cut(css, ranges) : css, hits };
}

// ------------------------------------------------------------------ JS (detection only: never rewritten)
const JS_RULES: { kind: DistKind; re: () => RegExp }[] = [
  { kind: "js_media", re: () => /\bnew\s+(?:Image|Audio)\s*\(/g },
  { kind: "js_media", re: () => /createElement(?:NS)?\s*\(\s*(?:[^,()]*,\s*)?(['"`])(?:img|image|video|audio|iframe|embed|object|source|track|picture|frame|applet)\1/gi },
  { kind: "js_media", re: () => /<(?:img|video|audio|iframe|embed|object|source|track|picture|image|foreignObject)\b/gi },
  { kind: "data_uri", re: RE.dataUri },
  { kind: "embed_url", re: RE.embedUrl },
  { kind: "media_url", re: RE.mediaUrl },
  { kind: "css_url", re: () => /(?<![\w$.])url\(\s*(?!['"`]?\s*#)/g },
];

export function scanJs(js: string): Hit[] {
  const hits: Hit[] = [];
  for (const r of JS_RULES) for (const m of js.matchAll(r.re())) hits.push({ kind: r.kind, sha256: h16(m[0]), action: "unremovable" });
  return hits;
}

// ------------------------------------------------------------------ HTML / XML / SVG
export interface Tok {
  start: number;
  end: number;
  close: boolean;
  name: string;
  /** Offset of the attribute text in the document. */
  attrsAt: number;
  attrs: string;
  selfClosing: boolean;
  /** For <script>/<style>: body range. */
  body?: Range;
}

const TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<(\/?)([A-Za-z][A-Za-z0-9:_-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

export function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  const re = new RegExp(TOKEN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[2] === undefined) continue; // comment / doctype / CDATA / PI
    const name = m[2].toLowerCase();
    const attrs = m[3] ?? "";
    const tok: Tok = { start: m.index, end: m.index + m[0].length, close: m[1] === "/", name, attrsAt: m.index + 1 + m[1].length + m[2].length, attrs, selfClosing: /\/\s*$/.test(attrs) };
    toks.push(tok);
    if (!tok.close && !tok.selfClosing && (name === "script" || name === "style")) {
      const closeRe = new RegExp(`</${name}\\s*>`, "gi");
      closeRe.lastIndex = tok.end;
      const c = closeRe.exec(s);
      const bodyEnd = c ? c.index : s.length;
      tok.body = [tok.end, bodyEnd];
      if (c) {
        toks.push({ start: c.index, end: c.index + c[0].length, close: true, name, attrsAt: c.index, attrs: "", selfClosing: false });
        re.lastIndex = c.index + c[0].length;
      } else re.lastIndex = s.length;
    }
  }
  return toks;
}

export interface Attr {
  name: string;
  value: string | null;
  /** Range in the document, including leading whitespace. */
  range: Range;
  /** Range of the value (without quotes) in the document. */
  valueRange: Range | null;
}

export function parseAttrs(t: Tok): Attr[] {
  const out: Attr[] = [];
  for (const m of t.attrs.matchAll(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    let a = m.index;
    while (a > 0 && /\s/.test(t.attrs[a - 1])) a--;
    const value = m[2] ?? m[3] ?? m[4] ?? null;
    let valueRange: Range | null = null;
    if (value !== null) {
      const vi = m[0].lastIndexOf(value);
      valueRange = [t.attrsAt + m.index + vi, t.attrsAt + m.index + vi + value.length];
    }
    out.push({ name: m[1].toLowerCase(), value, range: [t.attrsAt + a, t.attrsAt + m.index + m[0].length], valueRange });
  }
  return out;
}

const MEDIA_ELEMENTS = new Set(["img", "picture", "source", "video", "audio", "track", "iframe", "embed", "object", "applet", "frame", "frameset", "portal", "bgsound", "image:image", "video:video"]);
const SVG_IMAGE = new Set(["image", "feimage"]);
const MEDIA_ATTRS = new Set(["poster", "background", "lowsrc", "dynsrc"]);
const LINK_ICON = /(?:^|\s)(?:icon|shortcut|apple-touch-icon(?:-precomposed)?|mask-icon|image_src|apple-touch-startup-image)(?:\s|$)/i;
const META_MEDIA = /^(?:og:(?:image|video|audio)|twitter:(?:image|player)|msapplication-tileimage|thumbnail)/i;

const hasMatch = (re: () => RegExp, v: string) => re().test(v);
const hasCssUrl = (v: string) => /(?<![\w-])url\(\s*(?!['"]?\s*#)/i.test(v) || /(?<![\w-])(?:-webkit-)?image-set\(/i.test(v);

export function sanitizeMarkup(s: string): { out: string; hits: Hit[] } {
  const toks = tokenize(s);
  const edits: { range: Range; text: string }[] = [];
  const hits: Hit[] = [];
  const removeElement = (i: number, kind: DistKind): number => {
    const t = toks[i];
    let endIdx = -1;
    if (!t.selfClosing) {
      let depth = 0;
      for (let j = i + 1; j < toks.length; j++) {
        if (toks[j].name !== t.name) continue;
        if (!toks[j].close) {
          if (!toks[j].selfClosing) depth++;
        } else if (depth === 0) {
          endIdx = j;
          break;
        } else depth--;
      }
    }
    const end = endIdx >= 0 ? toks[endIdx].end : t.end;
    edits.push({ range: [t.start, end], text: "" });
    hits.push({ kind, sha256: h16(s.slice(t.start, end)), action: "strip" });
    if (endIdx < 0) return i;
    let k = endIdx;
    // skip tokens inside the removed range
    while (k + 1 < toks.length && toks[k + 1].start < end) k++;
    return k;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.close) continue;
    const attrs = parseAttrs(t);
    const attr = (n: string) => attrs.find((a) => a.name === n)?.value ?? null;
    if (MEDIA_ELEMENTS.has(t.name) || (t.name === "input" && (attr("type") ?? "").toLowerCase() === "image")) {
      i = removeElement(i, "html_media_tag");
      continue;
    }
    if (SVG_IMAGE.has(t.name)) {
      i = removeElement(i, "svg_image");
      continue;
    }
    if (t.name === "foreignobject") {
      i = removeElement(i, "svg_foreign_object");
      continue;
    }
    if (t.name === "use") {
      const href = attr("href") ?? attr("xlink:href");
      if (href !== null && !href.trim().startsWith("#")) {
        i = removeElement(i, "svg_use_external");
        continue;
      }
    }
    if (t.name === "link") {
      const rel = attr("rel") ?? "";
      const as = (attr("as") ?? "").toLowerCase();
      const href = attr("href") ?? "";
      if (LINK_ICON.test(rel) || ["image", "audio", "video", "track"].includes(as) || attr("imagesrcset") !== null || hasMatch(RE.dataUri, href) || hasMatch(RE.mediaUrl, href) || /\.(?:png|jpe?g|gif|webp|avif|ico|svg|mp3|mp4|webm)(?:[?#]|$)/i.test(href)) {
        i = removeElement(i, "html_media_tag");
        continue;
      }
    }
    if (t.name === "meta") {
      const key = attr("property") ?? attr("name") ?? attr("itemprop") ?? "";
      const content = attr("content") ?? "";
      if (META_MEDIA.test(key) || hasMatch(RE.dataUri, content) || hasMatch(RE.mediaUrl, content)) {
        i = removeElement(i, "html_media_tag");
        continue;
      }
    }
    // attribute-level rules
    for (const a of attrs) {
      const v = a.value ?? "";
      let kind: DistKind | null = null;
      if (a.name === "srcset" || a.name === "imagesrcset") kind = "srcset";
      else if (MEDIA_ATTRS.has(a.name)) kind = "media_attr";
      else if (a.name === "style" && a.valueRange) {
        const r = sanitizeCss(v);
        if (r.hits.length) {
          hits.push(...r.hits);
          if (r.out.trim()) edits.push({ range: a.valueRange, text: r.out });
          else edits.push({ range: a.range, text: "" });
        }
        continue;
      } else if (hasMatch(RE.dataUri, v)) kind = "data_uri";
      else if (hasCssUrl(v)) kind = "css_url";
      else if (t.name !== "a" && t.name !== "area") {
        if (hasMatch(RE.embedUrl, v)) kind = "embed_url";
        else if (hasMatch(RE.mediaUrl, v)) kind = "media_url";
      }
      if (!kind) continue;
      edits.push({ range: a.range, text: "" });
      hits.push({ kind, sha256: h16(s.slice(a.range[0], a.range[1]).trim()), action: "strip" });
    }
    if (t.body) {
      const body = s.slice(t.body[0], t.body[1]);
      if (t.name === "style") {
        const r = sanitizeCss(body);
        if (r.hits.length) {
          hits.push(...r.hits);
          edits.push({ range: t.body, text: r.out });
        }
      } else if (attr("src") === null) hits.push(...scanJs(body));
    }
  }
  if (!edits.length) return { out: s, hits };
  const sorted = edits.sort((a, b) => b.range[0] - a.range[0]);
  let out = s;
  let floor = Infinity;
  for (const e of sorted) {
    if (e.range[1] > floor) continue; // nested in an already-removed range
    out = out.slice(0, e.range[0]) + e.text + out.slice(e.range[1]);
    floor = e.range[0];
  }
  return { out, hits };
}

// ------------------------------------------------------------------ JSON / text
function sanitizeJson(text: string): { out: string; hits: Hit[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON: only flag data URIs (cannot rewrite safely)
    return { out: text, hits: [...text.matchAll(RE.dataUri())].map((m) => ({ kind: "data_uri" as const, sha256: h16(m[0]), action: "unremovable" as const })) };
  }
  const hits: Hit[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = stripMedia(v);
      for (const x of r.hits) hits.push({ kind: x.kind, sha256: x.sha256, action: "strip" });
      return r.out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const next = walk(data);
  return { out: hits.length ? JSON.stringify(next, null, 2) + "\n" : text, hits };
}

function sanitizeText(text: string): { out: string; hits: Hit[] } {
  const hits: Hit[] = [];
  const out = text.replace(RE.dataUri(), (m) => {
    hits.push({ kind: "data_uri", sha256: h16(m), action: "strip" });
    return "";
  });
  return { out: hits.length ? out : text, hits };
}

// ------------------------------------------------------------------ per file
interface FileResult {
  hits: Hit[];
  /** "delete", new content, or null (unchanged). */
  next: "delete" | string | null;
}

export function processFile(rel: string, buf: Buffer): FileResult {
  const ext = path.extname(rel).slice(1).toLowerCase();
  if (MEDIA_EXT.has(ext)) return { hits: [{ kind: "media_file", sha256: h16(buf), action: "delete" }], next: "delete" };
  if (mediaMagic(buf)) return { hits: [{ kind: "media_magic", sha256: h16(buf), action: "delete" }], next: "delete" };
  if (FONT_EXT.has(ext)) return { hits: [], next: null };
  const text = buf.toString("utf8");
  let r: { out: string; hits: Hit[] };
  if (MARKUP_EXT.has(ext)) r = sanitizeMarkup(text);
  else if (CSS_EXT.has(ext)) r = sanitizeCss(text);
  else if (JS_EXT.has(ext)) r = { out: text, hits: scanJs(text) };
  else if (JSON_EXT.has(ext)) r = sanitizeJson(text);
  else r = sanitizeText(text);
  return { hits: r.hits, next: r.out !== text ? r.out : null };
}

function listAll(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listAll(root, p));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

/** Scan a build output directory (no writes). */
export function scanDist(dir: string): DistFinding[] {
  const out: DistFinding[] = [];
  for (const rel of listAll(dir)) for (const h of processFile(rel, readFileSync(path.join(dir, rel))).hits) out.push({ file: rel, ...h });
  return out;
}

/** Apply the removals for the files named in `findings`. Unremovable findings are returned (never "fixed"). */
export function sanitizeDist(dir: string, findings: DistFinding[]): { removed: number; unremovable: DistFinding[] } {
  let removed = 0;
  const unremovable: DistFinding[] = [];
  for (const rel of [...new Set(findings.map((f) => f.file))]) {
    const abs = path.join(dir, rel);
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    const r = processFile(rel, buf);
    for (const h of r.hits) {
      if (h.action === "unremovable") unremovable.push({ file: rel, ...h });
      else removed++;
    }
    if (r.next === "delete") unlinkSync(abs);
    else if (r.next !== null) writeFileSync(abs, r.next, "utf8");
  }
  return { removed, unremovable };
}

/**
 * Build step (harness/src/site/build.ts): scan → sanitize → rescan, report to `reportPath` (outside dist).
 * Throws (build failure) when something cannot be removed or a finding remains.
 */
export function applyA2ToDist(dir: string, reportPath: string, now: Date = new Date()): DistA2Report {
  const files = listAll(dir).length;
  const detected = scanDist(dir);
  const san = detected.length ? sanitizeDist(dir, detected) : { removed: 0, unremovable: [] };
  const residual = detected.length ? scanDist(dir) : [];
  const report: DistA2Report = {
    schema: "sfsh-a2-dist/1",
    checked_at: now.toISOString(),
    out: dir,
    files_scanned: files,
    detected,
    removed: san.removed,
    unremovable: san.unremovable,
    residual_after_fix: residual.length,
    residual,
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  if (san.unremovable.length || residual.length)
    throw new Error(`A-2 (dist): ${san.unremovable.length} unremovable / ${residual.length} residual media finding(s) — build failed (report: ${reportPath})`);
  return report;
}
