/**
 * tokens.json → CSS custom properties (CP-024). The ONLY place that turns token values into CSS names.
 * Static CSS (styles/*.css, design/theme.css) must use these var() names for every color, font size,
 * weight, line height, spacing, radius, line width and duration. Media queries cannot use var(): they must
 * use exactly `mq.tablet` / `mq.pc` (the WP-2.7 check verifies breakpoint literals equal the tokens).
 */
import type { DesignTokens, ColorRef } from "./tokens-types.ts";

export function resolveColor(t: DesignTokens, c: ColorRef): string {
  return c === "bg" || c === "text" || c === "sub" || c === "accent" ? t.color[c] : c;
}

/** Variable names (stable contract). */
export const V = {
  bg: "--color-bg",
  text: "--color-text",
  sub: "--color-sub",
  accent: "--color-accent",
  ep: (k: string) => `--ep-${k.replace(/_/g, "-")}`,
  val: (k: string) => `--val-${k}`,
  ks: (k: string) => `--ks-${k}`,
  fontFamily: "--font-family",
  fs: (k: "small" | "body" | "h2" | "h1") => `--fs-${k}`,
  fw: (k: "regular" | "bold") => `--fw-${k}`,
  lh: (k: "body" | "heading") => `--lh-${k}`,
  space: (k: "xs" | "s" | "m" | "l" | "xl" | "section") => `--space-${k}`,
  radius: "--radius",
  line: (k: "hair" | "figure" | "strong") => `--line-${k}`,
  layout: (k: "textMax" | "figureMax" | "tap" | "tapGap" | "sectionGap" | "figureGap" | "gutter") =>
    `--layout-${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}`,
  motion: "--motion-duration",
} as const;

export function mq(t: DesignTokens) {
  return {
    tablet: `(min-width: ${t.breakpoint.tablet}px)`,
    pc: `(min-width: ${t.breakpoint.pc}px)`,
  };
}

export function tokensToCss(t: DesignTokens): string {
  const L: string[] = [];
  const p = (k: string, v: string | number) => L.push(`  ${k}: ${v};`);
  p(V.bg, t.color.bg);
  p(V.text, t.color.text);
  p(V.sub, t.color.sub);
  p(V.accent, t.color.accent);
  for (const [k, e] of Object.entries(t.semantic.epistemic).sort()) p(V.ep(k), e.color);
  for (const [k, e] of Object.entries(t.semantic.valence).sort()) p(V.val(k), resolveColor(t, e.color));
  for (const [k, e] of Object.entries(t.semantic.know_state).sort()) p(V.ks(k), resolveColor(t, e.color));
  p(V.fontFamily, t.font.family);
  for (const k of ["small", "body", "h2", "h1"] as const) p(V.fs(k), `${t.font.size[k]}px`);
  for (const k of ["regular", "bold"] as const) p(V.fw(k), t.font.weight[k]);
  for (const k of ["body", "heading"] as const) p(V.lh(k), t.font.lineHeight[k]);
  for (const k of ["xs", "s", "m", "l", "xl", "section"] as const) p(V.space(k), `${t.space[k]}px`);
  p(V.radius, `${t.radius}px`);
  for (const k of ["hair", "figure", "strong"] as const) p(V.line(k), `${t.line[k]}px`);
  for (const k of ["textMax", "figureMax", "tap", "tapGap", "sectionGap", "figureGap", "gutter"] as const) p(V.layout(k), `${t.layout[k]}px`);
  p(V.motion, `${t.motion.durationMs}ms`);
  return `:root {\n${L.join("\n")}\n}\n@media (prefers-reduced-motion: reduce) {\n  :root {\n    ${V.motion}: 0ms;\n  }\n}\n`;
}
