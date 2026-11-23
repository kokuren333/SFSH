/**
 * WP-2.6: site design generation (REQUIREMENTS §3.2 last row, §6.4). Development-time, not per work.
 * Haiku authors the design tokens (tokens.json values) and the visual stylesheet (design/theme.css) for the
 * renderer's fixed class list; Luna reviews against §6.4 (findings only); Haiku revises; max 2 rounds (§3.3).
 * The machine check (WP-2.7) runs on every candidate; its issues are given to Haiku with the review findings.
 * Code never edits the generated values. Output: site/src/design/{tokens.json, theme.css, design_review.json}.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ModelPort } from "../model/types.ts";
import type { DesignTokens } from "../../../site/src/design/tokens-types.ts";
import { Ajv } from "ajv";
import { checkCss, checkTokens, type Check, type CssIssue } from "./checkTokens.ts";

export const DESIGN_MAX_ROUNDS = 2;
const DESIGN_FINDING_TYPES = ["violates_rule", "readability", "inconsistent", "missing_style", "decoration", "other"] as const;

const hex = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
const colorRef = { type: "string", pattern: "^(#[0-9a-fA-F]{6}|bg|text|sub|accent)$" };
const labeled = (colorSchema: object, extra: string) => ({
  type: "object",
  additionalProperties: false,
  required: ["color", extra, "label"],
  properties: { color: colorSchema, [extra]: { type: "string", minLength: 1, maxLength: 12 }, label: { type: "string", minLength: 1, maxLength: 12 } },
});
const num = { type: "number" };
const obj = (keys: string[], prop: object = num) => ({
  type: "object",
  additionalProperties: false,
  required: keys,
  properties: Object.fromEntries(keys.map((k) => [k, prop])),
});

export const TOKENS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "color", "semantic", "font", "space", "radius", "line", "layout", "breakpoint", "motion"],
  properties: {
    schema: { type: "string", enum: ["sfsh-tokens/1"] },
    color: obj(["bg", "surface", "border", "text", "sub", "accent"], hex),
    semantic: {
      type: "object",
      additionalProperties: false,
      required: ["epistemic", "valence", "know_state"],
      properties: {
        epistemic: obj(["canon", "consensus", "fan_theory", "sfsh_analysis"], labeled(hex, "mark")),
        valence: obj(["positive", "negative", "ambivalent", "neutral"], labeled(colorRef, "dash")),
        know_state: obj(["unknown", "suspects", "misbelieves", "knows"], labeled(colorRef, "mark")),
      },
    },
    font: {
      type: "object",
      additionalProperties: false,
      required: ["family", "size", "weight", "lineHeight"],
      properties: {
        family: { type: "string", minLength: 1, maxLength: 200 },
        size: obj(["small", "body", "h2", "h1"]),
        weight: obj(["regular", "bold"]),
        lineHeight: obj(["body", "heading"]),
      },
    },
    space: obj(["xs", "s", "m", "l", "xl", "section"]),
    radius: obj(["control", "card", "pill"]),
    line: obj(["hair", "figure", "strong"]),
    layout: obj(["textMax", "figureMax", "tap", "tapGap", "sectionGap", "figureGap", "gutter"]),
    breakpoint: obj(["tablet", "pc"]),
    motion: obj(["durationMs"]),
  },
} as const;

const RESPONSES = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["finding_id", "action", "reason"],
    properties: { finding_id: { type: "string" }, action: { type: "string", enum: ["revised", "declined"] }, reason: { type: "string" } },
  },
};

/**
 * The Haiku CLI's structured output gives up ("structured_output_retry_exhausted") on the full nested tokens
 * object (each part alone succeeds; measured CP-026). So Haiku returns the tokens as a JSON *string*
 * (`tokens_json`); code parses it and validates it against TOKENS_SCHEMA (ajv) — structure errors and the
 * machine-check failures are fed back to Haiku. Values are never edited by code.
 */
export const GENERATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tokens_json", "theme_css", "rationale"],
  properties: { tokens_json: { type: "string" }, theme_css: { type: "string" }, rationale: { type: "string" } },
} as const;

export const REVISE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tokens_json", "theme_css", "responses"],
  properties: { tokens_json: { type: "string" }, theme_css: { type: "string" }, responses: RESPONSES },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateTokens = ajv.compile(TOKENS_SCHEMA);

/**
 * The first balanced top-level JSON object in s (string-aware). Haiku sometimes appends stray characters after
 * a complete object inside tokens_json (measured CP-026); the object itself is taken verbatim.
 */
export function firstJsonObject(s: string): string {
  const start = s.indexOf("{");
  if (start < 0) return s;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return s.slice(start);
}

/** Parse + structurally validate Haiku's tokens_json. Returns problems (empty = ok). */
function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
/** Deep merge (patch over base); used when Haiku's revision returns only the changed token keys (CP-026). */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObj(base) || !isObj(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

export function parseTokens(json: string, base?: DesignTokens): { tokens: DesignTokens | null; problems: string[]; patched: boolean } {
  const r = parseTokens0(json, base);
  return r;
}

function parseTokens0(json: string, base?: DesignTokens): { tokens: DesignTokens | null; problems: string[]; patched: boolean } {
  let t: unknown;
  try {
    t = JSON.parse(firstJsonObject(json));
  } catch (e) {
    return { tokens: null, problems: [`tokens_json が JSON として読めない: ${e instanceof Error ? e.message : String(e)}`], patched: false };
  }
  if (t && typeof t === "object") {
    delete (t as Record<string, unknown>)._generated;
    delete (t as Record<string, unknown>)._note;
  }
  if (validateTokens(t)) return { tokens: t as DesignTokens, problems: [], patched: false };
  const problems = (validateTokens.errors ?? []).slice(0, 30).map((e) => `tokens${e.instancePath} ${e.message}${e.params ? " " + JSON.stringify(e.params) : ""}`);
  if (base) {
    const merged = deepMerge(base, t);
    if (validateTokens(merged)) return { tokens: merged as DesignTokens, problems: [], patched: true };
  }
  return { tokens: null, problems, patched: false };
}

/** Luna (OpenAI strict). */
export const DESIGN_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target", "type", "severity", "evidence"],
        properties: {
          target: { type: "string" },
          type: { type: "string", enum: [...DESIGN_FINDING_TYPES] },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;

export interface DesignCandidate {
  tokens: DesignTokens;
  theme_css: string;
}
export interface DesignFinding {
  finding_id: string;
  target: string;
  type: (typeof DESIGN_FINDING_TYPES)[number];
  severity: "low" | "medium" | "high";
  evidence: string;
}
export interface MachineResult {
  ok: boolean;
  tokenFailures: Check[];
  cssIssues: CssIssue[];
}

export function machineCheck(c: DesignCandidate): MachineResult {
  const tr = checkTokens(c.tokens);
  const cssIssues = checkCss(c.theme_css, "site/src/design/theme.css", c.tokens);
  const tokenFailures = tr.checks.filter((x) => !x.ok);
  return { ok: tokenFailures.length === 0 && cssIssues.length === 0, tokenFailures, cssIssues };
}

function machineText(m: MachineResult): string {
  if (m.ok) return "機械検査: すべて合格。";
  return [
    "機械検査で不合格になった項目（必ず直すこと）:",
    ...m.tokenFailures.map((f) => `- tokens ${f.id}: ${f.detail}`),
    ...m.cssIssues.map((i) => `- theme.css 行${i.line} ${i.rule}: ${i.text}`),
  ].join("\n");
}

export interface DesignInputs {
  requirementsText: string; // §6.4 verbatim
  classList: string; // site/src/design/CLASSES.md
  sampleHtml: string; // a few rendered pages (trimmed)
  baseCss: string; // functional CSS already applied (base.css + figures.css)
  tokensTypes: string; // site/src/design/tokens-types.ts
  cssVarTable: string; // the CSS variable names produced by tokensToCss
}

const COMMON = (i: DesignInputs) => `あなたは静的サイト「物語の認知モデル（非公式の独自分析サイト）」のデザイナーです。日本語サイト、ライトテーマ1種のみ。
作るもの: (1) デザイントークン tokens（下の型どおりの JSON。値だけを決める。出力では tokens_json に、その JSON を1つの文字列として入れる） (2) 見た目のスタイルシート theme_css（下のクラス一覧に対する見た目の規則）。
HTML の構造と機能的な配置（グリッド、横スクロール枠、固定列、メニューの開閉、フェーズ切替の表示制御）はすでに base.css / figures.css にあるので、theme_css では色・文字・余白・罫線・強調など「見た目」だけを担当し、配置を壊さないこと（display / position / overflow / width を変えない）。

最優先の基準（要件 6.4。数値は厳守）:
${i.requirementsText}

AMENDMENT 09・10 と図のルール（2026-11-23 本人指示。ChatGPT の説明 UI＝OpenAI Apps SDK UI guidelines に寄せる。スマホ 390px 幅で読めることが必須）の規則。上の 6.4 と食い違う古い記述（無彩色3階調・角丸4px以下の単一値、図をカードに置き換える記述）が残っていても、こちらが優先する:
- 色: UI は無彩色5階調（color.bg 背景・color.surface 面（カード・チップの地）・color.border 罫線・color.text 本文・color.sub 補助文字）＋アクセント1色（color.accent）。本文の背景に色を敷かない。
- コントラスト: 本文は背景比 7:1 以上かつ面（surface）の上でも 7:1 以上。補助文字とアクセントの文字は背景・面の両方で 4.5:1 以上。
- 角丸: radius は {"control":<数>,"card":<数>,"pill":<数>}。control ≤ card ≤ 24（4px 刻み）、pill は layout.tap 以上（完全な丸みのチップ）。
- 提示の形: カード・チップは入口とナビゲーション（作品ページの本質ページ導線、作品情報、一覧、関連ページ）に使う（見出し → 補足 → 操作の順、操作は2つまで、カードの中に深い階層や入れ子のスクロールを作らない）。追加の項目は折りたたみで開く。
- 本文（AMENDMENT 10 執筆仕様 v2）: 概要・図のページの本文・テーマ／文脈／解釈のページ本文（.text-block.prose）は、カードの枠で囲まず連続した散文として読ませる。小見出し＋通常の長さの段落、段落間は余白で区切り、本文の行間は lh.body。リードを太字で大きくするようなカード的な強調をしない。
- 図（図のルール、2026-11-23 11:54 本人指示）: 図表はスマホでも「図として」見られること。図（.fig-main）はどの幅でも最初に表示し、「広い画面向け」等の断りで隠さない。360/390px では、その幅のために描いた形（関係図の narrow SVG、枠と連結線の原因の木、秘密ごとの小さなマトリクス、行ブロック表示の表）をそのまま読ませる。カード表示（.fc）は図の後に置く補助。横スクロール前提の表や縮小して読ませる図を主の表示にしない。図内の文字は 13px 以上。
- 文字: システムフォントのみ。サイズは small と body を中心に4段階まで、太さは2種まで。影・グラデーションは使わない。

theme_css の書き方の規則（機械検査で落ちる）:
- 色・文字サイズ・太さ・行間・余白・角丸・線幅・時間は必ず var(--…) を使う。使える変数は下の表だけ。色の直書き（#…、rgb()、色名）禁止。px・rem・em の直書きは 0 以外禁止。
- @media を使うなら (min-width: ${"600"}px) と (min-width: ${"1024"}px) だけ。
- グラデーション、box-shadow、text-shadow、斜体、背景画像、url()、@import、@font-face、無限アニメーション禁止。transition は var(--motion-duration) のみ。font-family は var(--font-family) のみ。
- 装飾目的の要素を足さない。迷ったら削る。枠で囲むより余白で区切る。

tokens の型（TypeScript）:
${i.tokensTypes}

tokens_json の骨組み（キーはすべて必須。省略しない。<…> を自分で決めた値に置き換える）:
{"schema":"sfsh-tokens/1","color":{"bg":"<#rrggbb>","surface":"<#rrggbb>","border":"<#rrggbb>","text":"<#rrggbb>","sub":"<#rrggbb>","accent":"<#rrggbb>"},
 "semantic":{"epistemic":{"canon":{"color":"<#rrggbb>","label":"確定設定","mark":"<記号>"},"consensus":{"color":"<#rrggbb>","label":"一般的解釈","mark":"<記号>"},"fan_theory":{"color":"<#rrggbb>","label":"考察","mark":"<記号>"},"sfsh_analysis":{"color":"<#rrggbb>","label":"独自分析","mark":"<記号>"}},
  "valence":{"positive":{"color":"<#rrggbb>","dash":"<線種>","label":"友好"},"negative":{"color":"<#rrggbb>","dash":"<線種>","label":"敵対"},"ambivalent":{"color":"<sub など>","dash":"<線種>","label":"両義"},"neutral":{"color":"<sub など>","dash":"<線種>","label":"中立"}},
  "know_state":{"unknown":{"color":"<色>","mark":"<記号>","label":"知らない"},"suspects":{"color":"<色>","mark":"<記号>","label":"疑っている"},"misbelieves":{"color":"<色>","mark":"<記号>","label":"誤解している"},"knows":{"color":"<色>","mark":"<記号>","label":"知っている"}}},
 "font":{"family":"<OS標準フォントの並び>","size":{"small":<数>,"body":<数>,"h2":<数>,"h1":<数>},"weight":{"regular":<数>,"bold":<数>},"lineHeight":{"body":<数>,"heading":<数>}},
 "space":{"xs":<数>,"s":<数>,"m":<数>,"l":<数>,"xl":<数>,"section":<数>},"radius":{"control":<数>,"card":<数>,"pill":<数>},"line":{"hair":<数>,"figure":<数>,"strong":<数>},
 "layout":{"textMax":<数>,"figureMax":<数>,"tap":<数>,"tapGap":<数>,"sectionGap":<数>,"figureGap":<数>,"gutter":<数>},"breakpoint":{"tablet":<数>,"pc":<数>},"motion":{"durationMs":<数>}}
注意: 1行は全角40字以内 = (layout.textMax − 2×layout.gutter) ≤ 40 × font.size.body（textMax は左右の余白 gutter を含む幅）。

CSS 変数の対応表（tokens のどの値がどの変数になるか）:
${i.cssVarTable}

クラス一覧（レンダラが出力する。これ以外のクラスは存在しない）:
${i.classList}

適用済みの機能 CSS（参考。重複して書かない）:
${i.baseCss.slice(0, 12000)}

出力されたページの HTML の例（抜粋）:
${i.sampleHtml.slice(0, 16000)}`;

export async function generateDesign(opts: {
  haiku: ModelPort;
  luna: ModelPort;
  inputs: DesignInputs;
  maxRounds?: number;
  log?: (m: string) => void;
}): Promise<{ final: DesignCandidate; record: Record<string, unknown> }> {
  const log = opts.log ?? (() => {});
  const maxRounds = opts.maxRounds ?? DESIGN_MAX_ROUNDS;
  const calls: Record<string, unknown>[] = [];
  const note = (task: string, r: { modelId: string; reportedModelId: string | null; durationMs: number; costUsd?: number | null }) =>
    calls.push({ task, modelId: r.modelId, reportedModelId: r.reportedModelId, durationMs: r.durationMs, costUsd: r.costUsd ?? null });

  /** One Haiku call → candidate; structurally invalid tokens_json is sent back (max 2 extra calls). */
  const structureRetries: Record<string, unknown>[] = [];
  const haikuCandidate = async (task: string, schema: object, prompt: string, base?: DesignTokens) => {
    let p = prompt;
    for (let attempt = 1; ; attempt++) {
      const r = await opts.haiku.call({ task, schema, timeoutMs: 600_000, prompt: p });
      note(task, r);
      const out = r.output as { tokens_json: string; theme_css: string; rationale?: string; responses?: { finding_id: string; action: string; reason: string }[] };
      const parsed = parseTokens(out.tokens_json, base);
      if (parsed.patched) structureRetries.push({ task, attempt, note: "tokens_json was a partial patch; deep-merged over the previous Haiku tokens" });
      if (parsed.tokens) return { cand: { tokens: parsed.tokens, theme_css: out.theme_css } as DesignCandidate, out };
      structureRetries.push({ task, attempt, problems: parsed.problems });
      log(`${task}: tokens_json invalid (${parsed.problems.length} problems), attempt ${attempt}`);
      if (attempt >= 3) throw new Error(`${task}: tokens_json invalid after 3 attempts: ${parsed.problems.slice(0, 3).join(" | ")}`);
      p = `${prompt}\n\n前回の出力の tokens_json は型に合わなかった。次の問題を直して、全体を出し直すこと:\n${parsed.problems.map((x) => "- " + x).join("\n")}`;
    }
  };

  const g = await haikuCandidate(
    "design.generate",
    GENERATE_SCHEMA,
    `${COMMON(opts.inputs)}\n\n課題: tokens と theme_css を作り、rationale に設計の要点（色の選び方、コントラスト、余白の考え方）を300字以内で書く。`,
  );
  let cand: DesignCandidate = g.cand;
  const rationale = g.out.rationale ?? "";
  let machine = machineCheck(cand);
  const rounds: Record<string, unknown>[] = [];
  log(`design.generate machine ok=${machine.ok} tokenFailures=${machine.tokenFailures.length} cssIssues=${machine.cssIssues.length}`);

  for (let round = 1; round <= maxRounds; round++) {
    const rv = await opts.luna.call({
      task: "design.review",
      tools: "none",
      schema: DESIGN_REVIEW_SCHEMA,
      timeoutMs: 600_000,
      prompt: `あなたはサイトデザインのレビュー担当です。成果物を書き換えず、指摘だけを返します（findings）。
基準は要件 6.4（下記）。基準に反する点、可読性・一覧性を損なう点、一貫性の欠如、クラス一覧にあるのに見た目が未定義で読みにくくなる点、装飾過多を指摘する。好みの問題は指摘しない。問題がなければ findings は空配列。
target には "tokens.<パス>" または "theme.css:<セレクタ>" を書く。evidence は根拠を短く。

要件 6.4:
${opts.inputs.requirementsText}

クラス一覧:
${opts.inputs.classList}

${machineText(machine)}

tokens:
${JSON.stringify(cand.tokens, null, 2)}

theme.css:
${cand.theme_css}`,
    });
    note("design.review", rv);
    const findings: DesignFinding[] = ((rv.output as { findings: Omit<DesignFinding, "finding_id">[] }).findings ?? []).map((f, i) => ({
      ...f,
      finding_id: `r${round}f${String(i + 1).padStart(2, "0")}`,
    }));
    log(`design.review round ${round}: ${findings.length} findings`);
    if (!findings.length && machine.ok) {
      rounds.push({ round, findings, responses: [], machine_ok_before: machine.ok });
      break;
    }
    const rs = await haikuCandidate(
      "design.revise",
      REVISE_SCHEMA,
      `${COMMON(opts.inputs)}

あなたが作った tokens と theme_css に、レビュー担当（別のモデル）から指摘が来ました（第${round}往復／最大${maxRounds}往復）。
各指摘に revised（直した）か declined（直さない。理由必須）で答え、修正後の tokens（tokens_json。変更したキーだけでもよい）と theme_css の全体を返す。機械検査の不合格は必ず直す。

${machineText(machine)}

指摘:
${JSON.stringify(findings, null, 2)}

現在の tokens:
${JSON.stringify(cand.tokens, null, 2)}

現在の theme_css:
${cand.theme_css}`,
      cand.tokens,
    );
    const out = { responses: rs.out.responses ?? [] };
    const before = machine.ok;
    cand = rs.cand;
    machine = machineCheck(cand);
    rounds.push({ round, findings, responses: out.responses, machine_ok_before: before, machine_ok_after: machine.ok });
    log(`design.revise round ${round}: machine ok=${machine.ok}`);
  }

  // Machine-check repair (not a review round): only the machine issues, at most 2 attempts.
  const repairs: Record<string, unknown>[] = [];
  for (let k = 1; k <= 2 && !machine.ok; k++) {
    const fx = await haikuCandidate(
      "design.repair",
      REVISE_SCHEMA,
      `${COMMON(opts.inputs)}\n\n機械検査の不合格だけを直し、tokens と theme_css の全体を返す（responses は空配列でよい）。\n\n${machineText(machine)}\n\n現在の tokens:\n${JSON.stringify(cand.tokens, null, 2)}\n\n現在の theme_css:\n${cand.theme_css}`,
      cand.tokens,
    );
    cand = fx.cand;
    machine = machineCheck(cand);
    repairs.push({ attempt: k, machine_ok_after: machine.ok });
  }

  // status per finding target: last round that targeted it
  const status: Record<string, "revised" | "disputed"> = {};
  for (const r of rounds) {
    for (const f of r.findings as DesignFinding[]) {
      const resp = ((r.responses as { finding_id: string; action: string }[]) ?? []).find((x) => x.finding_id === f.finding_id);
      status[f.target] = resp?.action === "revised" ? "revised" : "disputed";
    }
  }
  const record = {
    artifact: "site design (site/src/design/tokens.json + theme.css)",
    authored_by: "haiku",
    reviewed_by: "luna",
    max_rounds: maxRounds,
    rounds,
    repairs,
    structure_retries: structureRetries,
    target_status: status,
    counts: {
      findings: rounds.reduce((n, r) => n + (r.findings as unknown[]).length, 0),
      revised: Object.values(status).filter((s) => s === "revised").length,
      disputed: Object.values(status).filter((s) => s === "disputed").length,
      rounds: rounds.length,
    },
    machine_check_final: { ok: machine.ok, token_failures: machine.tokenFailures, css_issues: machine.cssIssues },
    rationale,
    calls,
    output_hashes: {
      tokens: crypto.createHash("sha256").update(JSON.stringify(cand.tokens)).digest("hex"),
      theme_css: crypto.createHash("sha256").update(cand.theme_css).digest("hex"),
    },
  };
  return { final: cand, record };
}

export function writeDesign(siteSrc: string, final: DesignCandidate, record: Record<string, unknown>): void {
  const dir = path.join(siteSrc, "design");
  const tokens = { ...final.tokens, _generated: { authored_by: "haiku", reviewed_by: "luna", review_file: "design_review.json" } };
  fs.writeFileSync(path.join(dir, "tokens.json"), JSON.stringify(tokens, null, 2) + "\n", "utf8");
  const css = final.theme_css.replace(/\r\n/g, "\n").trimEnd() + "\n";
  fs.writeFileSync(path.join(dir, "theme.css"), `/* Generated by Haiku (claude-haiku-5-5), reviewed by Luna (gpt-6-luna) — WP-2.6. Do not hand-edit; regenerate. */\n${css}`, "utf8");
  fs.writeFileSync(path.join(dir, "design_review.json"), JSON.stringify(record, null, 2) + "\n", "utf8");
}
