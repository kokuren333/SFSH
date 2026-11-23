/** WP-2.7: design token + CSS machine checks (REQUIREMENTS §6.4). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { checkTokens, checkCss, contrast, chroma, runDesignChecks } from "../src/design/checkTokens.ts";
import type { DesignTokens } from "../../site/src/design/tokens-types.ts";

const base = (): DesignTokens => JSON.parse(fs.readFileSync("site/src/design/tokens.json", "utf8"));
const failed = (t: DesignTokens) => checkTokens(t).checks.filter((c) => !c.ok).map((c) => c.id);

test("contrast and chroma math (WCAG)", () => {
  assert.equal(Math.round(contrast("#000000", "#ffffff") * 10) / 10, 21);
  assert.equal(Math.round(contrast("#767676", "#ffffff") * 100) / 100, 4.54);
  assert.equal(chroma("#808080"), 0);
  assert.ok(chroma("#1f5fbf") > 100);
});

test("current tokens.json passes every token check", () => {
  const r = checkTokens(base());
  assert.deepEqual(r.checks.filter((c) => !c.ok), []);
});

test("token violations are detected", () => {
  let t = base();
  t.color.text = "#777777";
  assert.ok(failed(t).includes("contrast.body_7"));
  t = base();
  t.color.sub = "#336699"; // chromatic UI tone
  assert.ok(failed(t).includes("color.ui_neutrals_achromatic"));
  t = base();
  t.font.size.small = 12;
  assert.ok(failed(t).includes("font.small_ge_13"));
  t = base();
  t.font.size.body = 15;
  assert.ok(failed(t).includes("font.body_ge_16"));
  t = base();
  (t.font.size as Record<string, number>).xl = 40;
  assert.ok(failed(t).includes("font.size_steps_le_4"));
  t = base();
  t.font.lineHeight.body = 1.5;
  assert.ok(failed(t).includes("font.line_height_body"));
  t = base();
  t.radius = 8;
  assert.ok(failed(t).includes("radius.single_le_4"));
  t = base();
  t.space.m = 18;
  assert.ok(failed(t).includes("space.4px_steps"));
  t = base();
  t.semantic.know_state.suspects.color = "#ff00aa"; // a new hue
  assert.ok(failed(t).includes("color.know_state_from_palette"));
  t = base();
  t.semantic.epistemic.consensus.mark = t.semantic.epistemic.canon.mark;
  assert.ok(failed(t).includes("cue.epistemic_labels_marks"));
  t = base();
  t.semantic.epistemic.fan_theory.color = "#f0e68c"; // too light for figure marks
  assert.ok(failed(t).includes("contrast.figure_marks_3"));
  t = base();
  t.layout.textMax = 720;
  t.layout.gutter = 16;
  t.font.size.body = 16; // 688px / 16px = 43 chars > 40
  assert.ok(failed(t).includes("layout.line_le_40_chars"));
  t = base();
  t.motion.durationMs = 300;
  assert.ok(failed(t).includes("motion.le_200ms"));
  t = base();
  t.breakpoint.tablet = 640;
  assert.ok(failed(t).includes("breakpoint.600_1024"));
  t = base();
  t.font.family = "MyWebFont, url(x.woff2)";
  assert.ok(failed(t).includes("font.os_fonts_only"));
});

test("CSS: token-only values pass", () => {
  const css = `
.a { color: var(--color-text); padding: var(--space-m) 0; margin: 0 auto; font-size: var(--fs-body); border: var(--line-hair) solid var(--color-sub); }
.b:hover { text-decoration: underline; }
@media (min-width: 600px) { .c { max-width: var(--layout-text-max); width: 100%; } }
@media (min-width: 1024px) { .d { grid-template-columns: repeat(2, 1fr); } }
.e { transition: opacity var(--motion-duration); line-height: var(--lh-body); font-family: var(--font-family); }
.f { overflow-x: auto; position: sticky; left: 0; top: 0; }`;
  assert.deepEqual(checkCss(css, "ok.css", base()), []);
});

test("CSS: every forbidden pattern is reported", () => {
  const cases: [string, string][] = [
    [".a { color: #333; }", "color_literal"],
    [".a { background: rgb(1,2,3); }", "color_literal"],
    [".a { color: red; }", "color_literal"],
    [".a { padding: 12px; }", "length_literal"],
    [".a { font-size: 1.2rem; }", "length_literal"],
    [".a { font-weight: 600; }", "value_not_from_token"],
    [".a { background: linear-gradient(red, blue); }", "gradient"],
    [".a { box-shadow: 0 1px 2px var(--color-sub); }", "box_shadow"],
    [".a { text-shadow: 0 0 1px var(--color-sub); }", "text_shadow"],
    [".a { font-style: italic; }", "italic"],
    [".a { background-image: url(x.png); }", "background_image"],
    [".a { animation: spin var(--motion-duration) infinite; }", "infinite_animation"],
    [".a { transition: opacity 300ms; }", "duration_literal"],
    ["@import 'x.css';", "forbidden_at_import"],
    ["@font-face { font-family: X; }", "forbidden_at_font-face"],
    ["@media (min-width: 640px) { .a { display: none; } }", "media_query_not_token_breakpoint"],
    [".a { font-family: Arial, sans-serif; }", "font_family_not_token"],
  ];
  for (const [css, rule] of cases) {
    const rules = checkCss(css, "bad.css", base()).map((i) => i.rule);
    assert.ok(rules.includes(rule), `${css} → expected ${rule}, got ${JSON.stringify(rules)}`);
  }
});

test("runDesignChecks reads tokens.json and site CSS files", () => {
  const r = runDesignChecks(process.cwd());
  assert.equal(r.tokens.ok, true);
  assert.ok(Array.isArray(r.css.files));
});
