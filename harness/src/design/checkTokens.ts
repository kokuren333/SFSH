/**
 * WP-2.7: machine check of the design tokens and the static CSS against REQUIREMENTS §6.4 (CP-025).
 * Pure functions + one file-system entry point (`runDesignChecks`). Deterministic; no model calls.
 *
 * Token checks (tokens.json): UI = 3 achromatic tones + 1 accent; 4 epistemic colors; 2 polarity colors
 * (ambivalent/neutral achromatic); knowledge-state colors drawn from the existing palette (no new hues);
 * contrast (body ≥ 7:1, secondary text / accent text ≥ 4.5:1, figure marks/lines ≥ 3:1); non-color cues
 * (distinct labels + marks / dashes); ≤ 4 font sizes (body ≥ 16, small ≥ 13), ≤ 2 weights, body line height
 * 1.7–1.8, OS fonts only; 8px spacing base with 4px steps; single radius ≤ 4; layout limits; breakpoints
 * 600/1024; motion ≤ 200ms.
 * CSS checks (styles/*.css, design/theme.css): no color literals, no px/rem/em literals except 0 and media
 * queries (which must equal the token breakpoints), font-size/weight/line-height/spacing/radius/durations via
 * var(), no gradients / shadows / text-shadow / italics / background images / infinite animations / url() /
 * @import / @font-face.
 * The per-screen "≤ 6 chromatic colors at once" rule is measured on rendered pages by the WP-2.9 Playwright
 * suite; here we report the palette's distinct chromatic colors.
 */
import fs from "node:fs";
import path from "node:path";
import type { DesignTokens, ColorRef } from "../../../site/src/design/tokens-types.ts";

export interface Check {
  id: string;
  ok: boolean;
  detail: string;
}
export interface CheckReport {
  ok: boolean;
  checks: Check[];
}

// ---------- color math ----------
const HEX = /^#[0-9a-fA-F]{6}$/;

export function hexToRgb(hex: string): [number, number, number] {
  if (!HEX.test(hex)) throw new Error(`not a #rrggbb color: ${hex}`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** HSL-style chroma (max−min of 0..255 channels). ≤ 12 counts as achromatic (gray). */
export function chroma(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return Math.max(r, g, b) - Math.min(r, g, b);
}
export const ACHROMATIC_MAX_CHROMA = 12;
export const isChromatic = (hex: string) => chroma(hex) > ACHROMATIC_MAX_CHROMA;

function resolve(t: DesignTokens, c: ColorRef): string {
  return c === "bg" || c === "text" || c === "sub" || c === "accent" ? t.color[c] : c;
}

// ---------- token checks ----------
export function checkTokens(t: DesignTokens): CheckReport {
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  const r2 = (n: number) => Math.round(n * 100) / 100;

  // structure / hex validity
  const allHex: [string, string][] = [
    ["color.bg", t.color?.bg],
    ["color.text", t.color?.text],
    ["color.sub", t.color?.sub],
    ["color.accent", t.color?.accent],
    ...Object.entries(t.semantic?.epistemic ?? {}).map(([k, v]) => [`epistemic.${k}`, v.color] as [string, string]),
    ...Object.entries(t.semantic?.valence ?? {}).map(([k, v]) => [`valence.${k}`, resolve(t, v.color)] as [string, string]),
    ...Object.entries(t.semantic?.know_state ?? {}).map(([k, v]) => [`know_state.${k}`, resolve(t, v.color)] as [string, string]),
  ];
  const badHex = allHex.filter(([, v]) => typeof v !== "string" || !HEX.test(v));
  add("schema.colors_hex", badHex.length === 0 && t.schema === "sfsh-tokens/1", badHex.length ? `invalid: ${badHex.map(([k]) => k).join(", ")}` : `${allHex.length} colors are #rrggbb`);
  if (badHex.length) return { ok: false, checks };

  const ep = t.semantic.epistemic;
  const val = t.semantic.valence;
  const ks = t.semantic.know_state;
  const EP = ["canon", "consensus", "fan_theory", "sfsh_analysis"] as const;
  const KS = ["unknown", "suspects", "misbelieves", "knows"] as const;
  const VAL = ["positive", "negative", "ambivalent", "neutral"] as const;
  add("schema.keys", EP.every((k) => ep[k]) && KS.every((k) => ks[k]) && VAL.every((k) => val[k]), "epistemic 4 / know_state 4 / valence 4 keys present");

  // UI palette: 3 achromatic + 1 accent
  const neutrals = [t.color.bg, t.color.text, t.color.sub];
  add("color.ui_neutrals_achromatic", neutrals.every((c) => !isChromatic(c)), `chroma bg=${chroma(t.color.bg)} text=${chroma(t.color.text)} sub=${chroma(t.color.sub)} (≤${ACHROMATIC_MAX_CHROMA})`);
  add("color.ui_three_tones_distinct", new Set(neutrals.map((c) => c.toLowerCase())).size === 3, neutrals.join(" / "));
  add("color.accent_chromatic", isChromatic(t.color.accent), `accent ${t.color.accent} chroma=${chroma(t.color.accent)}`);
  // semantic colors
  const epColors = EP.map((k) => ep[k].color.toLowerCase());
  add("color.epistemic_4_chromatic_distinct", new Set(epColors).size === 4 && epColors.every(isChromatic), epColors.join(" "));
  const pol = [resolve(t, val.positive.color).toLowerCase(), resolve(t, val.negative.color).toLowerCase()];
  add("color.polarity_2_chromatic_distinct", pol[0] !== pol[1] && pol.every(isChromatic), pol.join(" "));
  const neutralVal = [resolve(t, val.ambivalent.color), resolve(t, val.neutral.color)];
  add("color.valence_neutral_achromatic", neutralVal.every((c) => !isChromatic(c)), `ambivalent ${neutralVal[0]} / neutral ${neutralVal[1]}`);
  const palette = new Set([t.color.accent.toLowerCase(), ...epColors, ...pol]);
  const ksNew = KS.map((k) => resolve(t, ks[k].color).toLowerCase()).filter((c) => isChromatic(c) && !palette.has(c));
  add("color.know_state_from_palette", ksNew.length === 0, ksNew.length ? `new hues: ${ksNew.join(" ")}` : "all knowledge-state colors reuse the palette or are achromatic");
  const chromaticAll = [...palette].filter(isChromatic);
  add("color.palette_chromatic_count", chromaticAll.length <= 7, `${chromaticAll.length} distinct chromatic colors in the palette (accent + epistemic 4 + polarity 2 ≤ 7; per-screen ≤ 6 measured by WP-2.9)`);

  // contrast
  const bg = t.color.bg;
  add("contrast.body_7", contrast(t.color.text, bg) >= 7, `text/bg ${r2(contrast(t.color.text, bg))}:1`);
  add("contrast.secondary_4_5", contrast(t.color.sub, bg) >= 4.5, `sub/bg ${r2(contrast(t.color.sub, bg))}:1`);
  add("contrast.accent_text_4_5", contrast(t.color.accent, bg) >= 4.5, `accent/bg ${r2(contrast(t.color.accent, bg))}:1 (links/UI text)`);
  const figColors: [string, string][] = [
    ...EP.map((k) => [`epistemic.${k}`, ep[k].color] as [string, string]),
    ...VAL.map((k) => [`valence.${k}`, resolve(t, val[k].color)] as [string, string]),
    ...KS.map((k) => [`know_state.${k}`, resolve(t, ks[k].color)] as [string, string]),
  ];
  const lowFig = figColors.filter(([, c]) => contrast(c, bg) < 3);
  add("contrast.figure_marks_3", lowFig.length === 0, lowFig.length ? `below 3:1: ${lowFig.map(([k, c]) => `${k} ${r2(contrast(c, bg))}`).join(", ")}` : `min ${r2(Math.min(...figColors.map(([, c]) => contrast(c, bg))))}:1 over ${figColors.length} figure colors`);

  // non-color cues
  const distinctNonEmpty = (xs: string[]) => xs.every((x) => typeof x === "string" && x.trim() !== "") && new Set(xs).size === xs.length;
  add("cue.epistemic_labels_marks", distinctNonEmpty(EP.map((k) => ep[k].label)) && distinctNonEmpty(EP.map((k) => ep[k].mark)), EP.map((k) => `${ep[k].mark}${ep[k].label}`).join(" "));
  add("cue.know_state_labels_marks", distinctNonEmpty(KS.map((k) => ks[k].label)) && distinctNonEmpty(KS.map((k) => ks[k].mark)), KS.map((k) => `${ks[k].mark}${ks[k].label}`).join(" "));
  add("cue.valence_labels_dashes", distinctNonEmpty(VAL.map((k) => val[k].label)) && distinctNonEmpty(VAL.map((k) => val[k].dash)), VAL.map((k) => `${val[k].label}(${val[k].dash})`).join(" "));

  // typography
  const fs4 = t.font.size;
  const sizes = [fs4.small, fs4.body, fs4.h2, fs4.h1];
  add("font.size_steps_le_4", Object.keys(fs4).length <= 4 && new Set(sizes).size === sizes.length && sizes.every((v, i) => i === 0 || v > sizes[i - 1]!), `small ${fs4.small} < body ${fs4.body} < h2 ${fs4.h2} < h1 ${fs4.h1} (${Object.keys(fs4).length} steps)`);
  add("font.body_ge_16", fs4.body >= 16, `body ${fs4.body}px`);
  add("font.small_ge_13", fs4.small >= 13, `small (figure text) ${fs4.small}px`);
  add("font.weights_le_2", Object.keys(t.font.weight).length <= 2 && t.font.weight.regular !== t.font.weight.bold, `${t.font.weight.regular} / ${t.font.weight.bold}`);
  add("font.line_height_body", t.font.lineHeight.body >= 1.7 && t.font.lineHeight.body <= 1.8, `body ${t.font.lineHeight.body}`);
  add("font.line_height_heading", t.font.lineHeight.heading >= 1.2 && t.font.lineHeight.heading <= 1.8, `heading ${t.font.lineHeight.heading}`);
  add("font.os_fonts_only", !/url\(|@font-face|\.woff|\.ttf|\.otf/i.test(t.font.family) && /sans-serif|serif|system-ui/.test(t.font.family), t.font.family);

  // spacing / radius / layout
  const sp = Object.values(t.space);
  add("space.4px_steps", sp.every((v) => Number.isFinite(v) && v > 0 && v % 4 === 0), sp.join(" "));
  add("space.8px_base", t.space.s === 8, `s = ${t.space.s}`);
  add("space.section_ge_48", t.space.section >= 48 && t.layout.sectionGap >= 48, `space.section ${t.space.section} / layout.sectionGap ${t.layout.sectionGap}`);
  add("radius.single_le_4", typeof t.radius === "number" && t.radius >= 0 && t.radius <= 4, `radius ${t.radius}`);
  const L = t.layout;
  add("layout.text_max_720", L.textMax <= 720 && L.textMax >= 320, `textMax ${L.textMax}`);
  // §6.4 "1行は全角40字以内": the text box (column minus side gutters) holds at most 40 full-width chars at body size.
  add("layout.line_le_40_chars", L.textMax - 2 * L.gutter <= 40 * fs4.body, `(textMax ${L.textMax} − 2×gutter ${L.gutter}) / body ${fs4.body} = ${r2((L.textMax - 2 * L.gutter) / fs4.body)} chars (≤ 40)`);
  add("layout.figure_max_1080", L.figureMax <= 1080 && L.figureMax >= L.textMax, `figureMax ${L.figureMax}`);
  add("layout.tap_44_gap_8", L.tap >= 44 && L.tapGap >= 8, `tap ${L.tap} / gap ${L.tapGap}`);
  add("layout.figure_gap_24", L.figureGap >= 24, `figureGap ${L.figureGap}`);
  add("layout.gutter_16", L.gutter >= 16, `gutter ${L.gutter}`);
  add("layout.values_4px_steps", Object.values(L).every((v) => v % 4 === 0), Object.entries(L).map(([k, v]) => `${k}=${v}`).join(" "));
  const lines = Object.values(t.line);
  add("line.widths_positive", lines.every((v) => v > 0 && v <= 4), lines.join(" "));
  add("breakpoint.600_1024", t.breakpoint.tablet === 600 && t.breakpoint.pc === 1024, `tablet ${t.breakpoint.tablet} / pc ${t.breakpoint.pc} (§6.4 width classes)`);
  add("motion.le_200ms", t.motion.durationMs >= 0 && t.motion.durationMs <= 200, `${t.motion.durationMs}ms`);

  return { ok: checks.every((c) => c.ok), checks };
}

// ---------- CSS checks ----------
const NAMED_COLORS =
  /\b(black|white|red|green|blue|gray|grey|silver|maroon|purple|fuchsia|lime|olive|yellow|navy|teal|aqua|orange|pink|brown|gold|crimson|indigo|violet|cyan|magenta|beige|ivory|khaki|lavender|salmon|tomato|coral|turquoise|tan|plum|orchid|darkgray|lightgray|whitesmoke|gainsboro|dimgray)\b/i;
const VAR_ONLY_PROPS = /^(font-size|font-weight|line-height|border-radius|margin(-\w+)?|padding(-\w+)?|gap|row-gap|column-gap|inset(-\w+)?|top|right|bottom|left|transition-duration|animation-duration|letter-spacing|outline-offset|outline-width|border(-\w+)?-width)$/;

export interface CssIssue {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function lineOf(src: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

export function checkCss(css: string, file: string, t: DesignTokens): CssIssue[] {
  const issues: CssIssue[] = [];
  // blank out comments, keep offsets
  const src = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const push = (idx: number, rule: string, text: string) => issues.push({ file, line: lineOf(src, idx), rule, text: text.trim().slice(0, 120) });
  const allowedMq = new Set([t.breakpoint.tablet, t.breakpoint.pc, t.breakpoint.tablet - 1, t.breakpoint.pc - 1]);

  // at-rules
  for (const m of src.matchAll(/@(import|font-face)\b/g)) push(m.index!, `forbidden_at_${m[1]}`, m[0]);
  for (const m of src.matchAll(/@media([^{]*)\{/g)) {
    for (const px of m[1]!.matchAll(/(\d+(?:\.\d+)?)px/g)) if (!allowedMq.has(Number(px[1]))) push(m.index!, "media_query_not_token_breakpoint", m[0]);
    if (/\d+(?:\.\d+)?(em|rem)\b/.test(m[1]!)) push(m.index!, "media_query_not_token_breakpoint", m[0]);
  }
  // declarations (outside @media preludes): prop: value;
  const preludeless = src.replace(/@media[^{]*\{/g, (m) => " ".repeat(m.length - 1) + "{");
  for (const m of preludeless.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
    const prop = m[1]!.toLowerCase();
    const value = m[2]!;
    const idx = m.index!;
    if (prop.startsWith("--")) continue;
    // selectors like a:hover / input:checked are caught by the regex when followed by {...}; skip if value contains "{"
    const v = value.replace(/var\([^)]*\)/g, "VAR");
    if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bhwb\(|\blab\(|\blch\(|\boklch\(|\bcolor\(/.test(v) || (NAMED_COLORS.test(v) && !/^(font-family|content|grid-template-areas|grid-area|list-style-type|counter-reset|counter-increment)$/.test(prop))) push(idx, "color_literal", `${prop}: ${value}`);
    if (/gradient\(/i.test(v)) push(idx, "gradient", `${prop}: ${value}`);
    if (prop === "box-shadow" && !/^\s*none\s*$/.test(v)) push(idx, "box_shadow", `${prop}: ${value}`);
    if (prop === "text-shadow" && !/^\s*none\s*$/.test(v)) push(idx, "text_shadow", `${prop}: ${value}`);
    if (prop === "font-style" && /italic|oblique/.test(v)) push(idx, "italic", `${prop}: ${value}`);
    if (prop === "font" && /italic|oblique/.test(v)) push(idx, "italic", `${prop}: ${value}`);
    if (/^background(-image)?$/.test(prop) && /url\(|image\(|gradient/.test(v)) push(idx, "background_image", `${prop}: ${value}`);
    if (/url\(/.test(v)) push(idx, "url", `${prop}: ${value}`);
    if (/^animation(-iteration-count)?$/.test(prop) && /infinite/.test(v)) push(idx, "infinite_animation", `${prop}: ${value}`);
    if (/^(transition|animation)(-duration)?$/.test(prop) && /\b\d+(\.\d+)?m?s\b/.test(v)) push(idx, "duration_literal", `${prop}: ${value}`);
    if (prop === "-webkit-text-stroke" || prop === "filter" && /drop-shadow/.test(v)) push(idx, "decoration", `${prop}: ${value}`);
    // length literals: px/rem/em/pt/vw-based font sizes etc. 0 allowed.
    const lens = [...v.matchAll(/(?<![\w-])(\d*\.?\d+)(px|rem|em|pt|pc|cm|mm|in|ex|ch)\b/g)].filter((x) => Number(x[1]) !== 0);
    if (lens.length) push(idx, "length_literal", `${prop}: ${value}`);
    if (VAR_ONLY_PROPS.test(prop)) {
      const rest = v.replace(/VAR|calc|\(|\)|\*|\+|-(?=\s)|\/|,|\s+/g, " ").trim();
      const bad = rest.split(/\s+/).filter((x) => x && !/^(0|auto|inherit|initial|unset|normal|none|100%|50%|0%|-?1|-1|max-content|min-content|fit-content|bold|bolder|thin|medium)$/.test(x) && !/^-?\d*\.?\d+%$/.test(x) && !/^[a-z-]+$/.test(x));
      // bare numbers (font-weight 600, line-height 1.5, margin 2) must come from var()
      const bareNum = bad.filter((x) => /^-?\d*\.?\d+$/.test(x));
      if (bareNum.length && !(prop === "line-height" && bareNum.every((x) => x === "1"))) push(idx, "value_not_from_token", `${prop}: ${value}`);
    }
    if (prop === "font-family" && !/var\(--font-family\)|inherit/.test(value)) push(idx, "font_family_not_token", `${prop}: ${value}`);
  }
  return issues;
}

// ---------- entry point ----------
export interface DesignCheckResult {
  ok: boolean;
  tokens: CheckReport;
  css: { files: string[]; issues: CssIssue[] };
}

/** Checks site/src/design/tokens.json and every static CSS file (styles/*.css, design/theme.css). */
export function runDesignChecks(repoRoot: string): DesignCheckResult {
  const siteSrc = path.join(repoRoot, "site", "src");
  const tokens = JSON.parse(fs.readFileSync(path.join(siteSrc, "design", "tokens.json"), "utf8")) as DesignTokens;
  const tokRep = checkTokens(tokens);
  const files: string[] = [];
  const stylesDir = path.join(siteSrc, "styles");
  if (fs.existsSync(stylesDir)) for (const f of fs.readdirSync(stylesDir).sort()) if (f.endsWith(".css")) files.push(path.join(stylesDir, f));
  const theme = path.join(siteSrc, "design", "theme.css");
  if (fs.existsSync(theme)) files.push(theme);
  const issues: CssIssue[] = [];
  for (const f of files) issues.push(...checkCss(fs.readFileSync(f, "utf8"), path.relative(repoRoot, f).replace(/\\/g, "/"), tokens));
  return { ok: tokRep.ok && issues.length === 0, tokens: tokRep, css: { files: files.map((f) => path.relative(repoRoot, f).replace(/\\/g, "/")), issues } };
}

export function formatDesignCheck(r: DesignCheckResult): string {
  const L: string[] = [];
  L.push(`design check: ${r.ok ? "PASS" : "FAIL"}  (tokens ${r.tokens.checks.filter((c) => c.ok).length}/${r.tokens.checks.length}, css files ${r.css.files.length}, css issues ${r.css.issues.length})`);
  for (const c of r.tokens.checks) L.push(`  ${c.ok ? "ok  " : "FAIL"} ${c.id.padEnd(38)} ${c.detail}`);
  for (const i of r.css.issues) L.push(`  FAIL css ${i.file}:${i.line} ${i.rule}: ${i.text}`);
  return L.join("\n");
}
