/** M3 WP-3.1 / 3.2 / 3.4: S4 automatic check (A-1, A-2(a), advisory, report, notice) on planted test data. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PublicWork } from "../../site/src/public-types.ts";
import { A1_REWRITE_SCHEMA, buildA1Index, flaggedSpans, makeReducer } from "../src/check/a1.ts";
import { stripMedia } from "../src/check/a2.ts";
import { applyEdits } from "../src/check/fix.ts";
import { removeSpans, sentenceSpans } from "../src/check/leaves.ts";
import { buildNotice, formatNotice } from "../src/check/notice.ts";
import { AUTOCHECK_STAGE, autoCheck, recheckPublic } from "../src/check/stage.ts";
import { ADVISORY_TYPES, type CheckReport } from "../src/check/types.ts";
import { checkCommand } from "../src/commands/check.ts";
import { checkPublicWork } from "../src/gen/check.ts";
import { genContext } from "../src/gen/testFixtures.ts";
import { splitSentences } from "../src/gen/write.ts";
import type { ModelPort, ModelRequest } from "../src/model/types.ts";
import { strictSchemaViolations } from "../src/model/validate.ts";
import { normKey } from "../src/research/textMatch.ts";
import { fakePort, type FakeCall } from "../src/nkg/testFixtures.ts";
import {
  M1_EXPECTED,
  M3_EXPECTED,
  M4_EXPECTED,
  P1_REWRITE,
  P2_EXPECTED,
  P2_STILL_COPIED,
  P3_EXPECTED,
  P4_EXPECTED,
  P4_TEXT,
  P4_VARIANT,
  N1_TEXT,
  RAW_S1,
  buildAdvisoryWork,
  buildPlantedWork,
  basePublic,
  type PlantedWork,
} from "./fixtures/m3/planted.ts";

const read = <T = unknown>(dir: string, rel: string): T => JSON.parse(readFileSync(path.join(dir, rel), "utf8")) as T;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "sfsh-s4-"));

/** Items of an S4 rewrite prompt: "## i01（role・$.path）". */
const promptItems = (prompt: string) => [...prompt.matchAll(/^## (i\d+)（[^\n]*・(\$[^）\n]*)）$/gm)].map((m) => ({ id: m[1], path: m[2] }));

function ports(p: PlantedWork, calls: FakeCall[] = []): { haiku: ModelPort; luna: ModelPort } {
  const handler = (want: Record<string, string>) => (req: ModelRequest) => {
    if (req.task !== "s4.a1.rewrite") return undefined;
    return { items: promptItems(req.prompt).filter((it) => want[it.path]).map((it) => ({ id: it.id, text: want[it.path] })) };
  };
  return {
    haiku: fakePort("haiku", handler({ [p.a1Paths.P1]: P1_REWRITE }), calls),
    luna: fakePort("luna", handler({ [p.a1Paths.P2]: P2_STILL_COPIED }), calls),
  };
}

/** Expected public.json after S4 on the planted work: only the planted parts change (+ the cascade of ev03). */
function expectedAfter(p: PlantedWork, opts: { p1Rewritten: boolean }): PublicWork {
  const e = clone(p.before);
  const i = p.idx;
  e.pages.overview[0].paragraphs[0] = opts.p1Rewritten ? P1_REWRITE : "甲と乙の信頼が物語の軸になる。その記憶が二人の行動を縛る。";
  e.elements.events[i.ev02].summary = opts.p1Rewritten ? P2_EXPECTED : "対立が表に出る。";
  e.pages.themes.items[i.th01].analysis = P3_EXPECTED;
  e.pages.quiz[i.qz01].explanation = P4_EXPECTED;
  e.pages.interpretations.items[i.ip01].positions.splice(0, 1);
  // A-2
  e.pages.overview[1].paragraphs[0] = M1_EXPECTED;
  e.pages.overview[1].heading = null;
  e.viz.relations.characters[i.ch02].summary = M3_EXPECTED;
  e.pages.figure_notes.relations!.paragraphs[0] = M4_EXPECTED;
  e.elements.setups[i.su01].meaning = basePublic().pw.elements.setups[i.su01].meaning;
  // P5: ev03 removed (required label emptied) + dangling references
  e.elements.events.splice(i.ev03, 1);
  for (const ev of e.elements.events) {
    ev.caused_by = ev.caused_by.filter((c) => c.event !== "ev03");
    ev.leads_to = ev.leads_to.filter((c) => c.event !== "ev03");
  }
  if (e.viz.timeline) e.viz.timeline.events = e.viz.timeline.events.filter((x) => x.id !== "ev03");
  for (const a of e.elements.arcs) a.turns_at = a.turns_at.filter((x) => x !== "ev03");
  for (const s of e.elements.setups) s.pays_off = s.pays_off.filter((x) => x !== "ev03");
  for (const m of e.elements.motives) m.drives = m.drives.filter((x) => x !== "ev03");
  for (const b of e.elements.emotion_beats) b.evoked_by = b.evoked_by.filter((x) => x !== "ev03");
  for (const w of e.elements.world_rules) w.constrains = w.constrains.filter((x) => x !== "ev03");
  for (const b of [...e.pages.overview, ...e.pages.themes.intro, ...e.pages.context.intro, ...e.pages.interpretations.intro]) b.based_on = b.based_on.filter((x) => x !== "ev03");
  for (const q of e.pages.quiz) q.based_on = q.based_on.filter((x) => x !== "ev03");
  return e;
}

test("planted work: every planted A-1 / A-2 item is detected (exact counts), only planted parts change, rewrite / removal paths, residual 0", async () => {
  const root = tmp();
  try {
    const p = buildPlantedWork(root);
    const calls: FakeCall[] = [];
    const { haiku, luna } = ports(p, calls);
    const logs: string[] = [];
    const res = await autoCheck(genContext(p.dir, luna, haiku, "2026-11-23T05:00:00Z", logs));
    const report = read<CheckReport>(p.dir, "check/report.json");
    const after = read<PublicWork>(p.dir, "gen/public.json");

    // A-1: exactly the 6 planted sentences (one per planted string); the proper-noun-only copy is not detected
    const planted = Object.values(p.a1Paths).sort();
    assert.equal(report.a1.detected.length, 6);
    assert.deepEqual(report.a1.detected.map((d) => d.path).sort(), planted);
    for (const n of p.a1NegativePaths) assert.ok(!report.a1.detected.some((d) => d.path === n), `negative ${n} must not be detected`);
    const byPath = new Map(report.a1.detected.map((d) => [d.path, d] as const));
    assert.deepEqual([byPath.get(p.a1Paths.P1)!.author, byPath.get(p.a1Paths.P1)!.author_basis], ["haiku", "pages"]);
    assert.deepEqual([byPath.get(p.a1Paths.P2)!.author, byPath.get(p.a1Paths.P2)!.author_basis], ["luna", "nkg"]);
    assert.deepEqual([byPath.get(p.a1Paths.P3)!.author, byPath.get(p.a1Paths.P3)!.author_basis], ["haiku", "nkg"]);
    assert.deepEqual([byPath.get(p.a1Paths.P4)!.author, byPath.get(p.a1Paths.P4)!.author_basis], ["haiku", "pages"]);
    assert.deepEqual([byPath.get(p.a1Paths.P5)!.author, byPath.get(p.a1Paths.P5)!.element_id], ["luna", "ev03"]);
    assert.deepEqual([byPath.get(p.a1Paths.P7)!.author, byPath.get(p.a1Paths.P7)!.element_id], ["haiku", "ip01"]);
    assert.ok(report.a1.detected.every((d) => /^[0-9a-f]{16}$/.test(d.sentence_sha256) && d.chars >= 30));

    // one rewrite call per authoring model, batching all its flagged items
    const rw = calls.filter((c) => c.req.task === "s4.a1.rewrite");
    assert.deepEqual(rw.map((c) => c.port).sort(), ["haiku", "luna"]);
    assert.deepEqual(report.a1.rewrite, { haiku: { calls: 1, items: 4, failed: false }, luna: { calls: 1, items: 2, failed: false } });
    assert.equal(promptItems(rw.find((c) => c.port === "haiku")!.req.prompt).length, 4);
    assert.equal(report.a1.rewritten_ok, 1, "Haiku's clean rewrite of P1 resolves it");
    const sentencesRemoved = report.a1.removed.filter((r) => r.action === "sentence_removed");
    assert.deepEqual(sentencesRemoved.map((r) => r.path).sort(), [p.a1Paths.P2, p.a1Paths.P3, p.a1Paths.P4, p.a1Paths.P5, p.a1Paths.P7].sort());
    assert.ok(report.a1.removed.some((r) => r.action === "element_removed" && r.path === `$.elements.events[${p.idx.ev03}]` && r.element_id === "ev03"));
    assert.ok(report.a1.removed.some((r) => r.action === "element_removed" && r.path === `$.pages.interpretations.items[${p.idx.ip01}].positions[0]`));
    assert.ok(report.a1.cascade_removed.some((c) => c.id === "ev03" && /timeline/.test(c.path)), "timeline mirror of ev03 removed");
    assert.ok(report.a1.cascade_removed.some((c) => c.id === "ev03" && /turns_at/.test(c.path)));
    assert.equal(report.a1.residual_after_fix, 0);
    assert.equal(report.a1.sources_checked, 2);
    assert.deepEqual(report.a1.sources_missing, ["s000000003", "s000000004", "s000000005"]);
    assert.ok(report.a1.allowlist_terms >= 5);

    // A-2: exactly the 5 planted matches; sources[].url (.png) is not one of them
    assert.equal(report.a2.detected.length, 5);
    assert.deepEqual(report.a2.detected.map((d) => `${d.path}|${d.kind}`).sort(), p.a2.map((x) => `${x.path}|${x.kind}`).sort());
    assert.equal(report.a2.removed, 5);
    assert.equal(report.a2.residual_after_fix, 0);
    assert.ok(report.a2.field_actions.some((f) => f.path === "$.pages.overview[1].heading" && f.action === "field_nulled"));
    assert.equal(after.sources[0].url, "https://pub.example/cover.png");

    // only the planted parts changed (everything else deep-equal / byte-identical)
    assert.deepEqual(after, expectedAfter(p, { p1Rewritten: true }));
    assert.deepEqual(checkPublicWork(after), []);
    assert.equal(readFileSync(path.join(p.dir, "check", "public.before.json"), "utf8"), p.beforeText);
    assert.deepEqual(recheckPublic(p.dir), { a1_residual: 0, a2_residual: 0 });

    // report: P-1 + contract, and never the copied text
    assert.equal(report.schema, "sfsh-check/1");
    assert.equal(report.blocking, false);
    assert.equal(report.job_id, "job-gen-test");
    assert.deepEqual(report.params, { a1_run: 30, long_quote_chars: 20, similarity: { ngram: 3, jaccard_gt: 0.5, min_chars: 15 } });
    const reportText = readFileSync(path.join(p.dir, "check", "report.json"), "utf8");
    for (const s of p.secrets) assert.ok(!reportText.includes(s), `report must not contain planted text: ${s.slice(0, 12)}…`);
    for (const s of p.secrets) for (let k = 0; k + 12 <= s.length; k += 6) assert.ok(!reportText.includes(s.slice(k, k + 12)), "no 12-char fragment of planted text in the report");
    assert.match(report.notice.line, /^自動確認: A-1 検出 6・A-2 検出 5（該当箇所を修正済み）／advisory \d+件/);
    assert.ok(report.notice.points.length <= 5 && report.notice.points.length >= 2);

    // stage result
    assert.equal(res.metrics.a1_detected, 6);
    assert.equal(res.metrics.a1_rewritten, 1);
    assert.equal(res.metrics.a1_removed, 5);
    assert.equal(res.metrics.a2_detected, 5);
    assert.equal(res.metrics.a2_removed, 5);
    assert.equal(res.metrics.residual, 0);
    assert.equal(res.metrics.calls, 2);
    assert.deepEqual(res.outputs.sort(), ["check/public.before.json", "check/report.json", "gen/public.json"]);
    assert.ok(logs.some((l) => l.startsWith("s4.autocheck:")));

    // second run (same inputs): nothing left to detect, public.json byte-identical (deterministic)
    const fixedText = readFileSync(path.join(p.dir, "gen", "public.json"), "utf8");
    const res2 = await autoCheck(genContext(p.dir, luna, haiku, "2026-11-23T06:00:00Z"));
    assert.equal(res2.metrics.a1_detected, 0);
    assert.equal(res2.metrics.a2_detected, 0);
    assert.equal(res2.metrics.calls, 0);
    assert.equal(readFileSync(path.join(p.dir, "gen", "public.json"), "utf8"), fixedText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rewrite call failure (both models) → the stage still completes; flagged sentences removed; residual 0", async () => {
  const root = tmp();
  try {
    const p = buildPlantedWork(root);
    const boom = (port: "haiku" | "luna"): ModelPort => ({ port, modelId: `boom-${port}`, call: async () => Promise.reject(new Error("CLI exited 1")) });
    const res = await autoCheck(genContext(p.dir, boom("luna"), boom("haiku")));
    const report = read<CheckReport>(p.dir, "check/report.json");
    assert.deepEqual(report.a1.rewrite, { haiku: { calls: 1, items: 4, failed: true }, luna: { calls: 1, items: 2, failed: true } });
    assert.equal(report.a1.rewritten_ok, 0);
    assert.equal(report.a1.detected.length, 6);
    assert.equal(report.a1.residual_after_fix, 0);
    assert.equal(report.blocking, false);
    assert.ok(res.warnings.some((w) => /haiku rewrite call failed/.test(w)) && res.warnings.some((w) => /luna rewrite call failed/.test(w)));
    const after = read<PublicWork>(p.dir, "gen/public.json");
    assert.deepEqual(after, expectedAfter(p, { p1Rewritten: false }));
    assert.deepEqual(checkPublicWork(after), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("advisory never stops the stage: hundreds of long quotes, provisional title, many guideline warnings, too_concrete, holder policy, lyric genre, similarity, chain dropout", async () => {
  const root = tmp();
  try {
    const w = buildAdvisoryWork(root, { quotes: 300, warnings: 250 });
    const never = (port: "haiku" | "luna"): ModelPort => ({ port, modelId: "never", call: async () => assert.fail("no model call expected") });
    const before = readFileSync(path.join(w.dir, "gen", "public.json"), "utf8");
    const res = await autoCheck(genContext(w.dir, never("luna"), never("haiku")));
    const report = read<CheckReport>(w.dir, "check/report.json");
    assert.equal(report.blocking, false);
    assert.equal(report.a1.detected.length, 0);
    assert.equal(report.a2.detected.length, 0);
    assert.equal(readFileSync(path.join(w.dir, "gen", "public.json"), "utf8"), before, "advisory changes nothing in public.json");
    for (const t of ADVISORY_TYPES) assert.ok(report.advisory_counts[t] > 0, `advisory type ${t} present`);
    assert.equal(report.advisory_counts.long_quote, 300);
    assert.equal(report.advisory_counts.over_guideline, 250);
    assert.equal(report.advisory_counts.title_provisional, 1);
    assert.equal(report.advisory_counts.chain_dropout, 1);
    assert.equal(report.advisory_counts.too_concrete_unresolved, 3, "fact ev01 / ev04 + pages ov01 (overreach is not too_concrete)");
    const tc = new Map(report.advisory.filter((a) => a.type === "too_concrete_unresolved").map((a) => [a.target, a.in_public] as const));
    assert.deepEqual(Object.fromEntries(tc), { ev01: true, ev04: false, ov01: true });
    assert.equal(report.advisory.length, Object.values(report.advisory_counts).reduce((a, b) => a + b, 0));
    assert.equal(res.metrics.advisory, report.advisory.length);
    assert.equal(res.metrics.adv_long_quote, 300);
    assert.equal(report.notice.points.length, 5);
    assert.match(report.notice.line, /^自動確認: A-1 検出 0・A-2 検出 0／advisory \d+件（題名が仮（provisional） 1・権利者の方針の記録 1・詩・歌詞・短い作品 1・/);
    // advisory details never copy the quoted text
    const text = readFileSync(path.join(w.dir, "check", "report.json"), "utf8");
    assert.ok(!text.includes("重心を少しずつ"));
    assert.ok(!text.includes("海辺に集まり") && !text.includes("浜辺に集まり"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cascade: an element emptied by A-2 (character label / matrix secret) removes its dangling references; matrix → null when no secret is left", async () => {
  const root = tmp();
  try {
    const p = buildPlantedWork(root);
    const pw = clone(p.before);
    const ch2 = pw.viz.relations.characters.findIndex((c) => c.id === "ch02");
    pw.viz.relations.characters[ch2].label = '<img src="https://example.com/face.png">';
    assert.ok(pw.viz.matrix && pw.viz.matrix.secrets.length === 1, "fixture has one public secret");
    pw.viz.matrix!.secrets[0].label = "![](https://example.com/s.gif)";
    writeFileSync(path.join(p.dir, "gen", "public.json"), JSON.stringify(pw, null, 2) + "\n");
    const workBefore = read<{ has_matrix?: boolean }>(p.dir, "work.json");
    const { haiku, luna } = ports(p);
    await autoCheck(genContext(p.dir, luna, haiku));
    const after = read<PublicWork>(p.dir, "gen/public.json");
    assert.deepEqual(checkPublicWork(after), []);
    const ids = JSON.stringify(after);
    assert.ok(!after.viz.relations.characters.some((c) => c.id === "ch02"));
    assert.ok(!after.viz.relations.relations.some((r) => r.from === "ch02" || r.to === "ch02"), "relations of ch02 removed");
    assert.ok(!after.elements.motives.some((m) => m.owner === "ch02"));
    assert.ok(!after.elements.arcs.some((a) => a.character === "ch02"));
    for (const w of after.elements.world_rules) assert.ok(!w.constrains.includes("ch02"));
    assert.equal(after.viz.matrix, null);
    assert.equal(after.work.has_matrix, false);
    assert.equal(after.pages.figure_notes.matrix, null);
    assert.ok(!/"se01"/.test(ids), "no reference to the removed secret remains");
    assert.ok(!/"(?:based_on|drives|turns_at|constrains|pays_off|evoked_by)":\s*\[[^\]]*"ch02"/.test(JSON.stringify(after)));
    const report = read<CheckReport>(p.dir, "check/report.json");
    assert.ok(report.a2.cascade_removed.some((c) => /relations\.relations/.test(c.path)));
    assert.ok(report.a2.field_actions.some((f) => f.action === "element_removed" && f.element_id === "ch02"));
    assert.equal(read<{ has_matrix?: boolean }>(p.dir, "work.json").has_matrix, false);
    assert.notEqual(workBefore.has_matrix, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("A-2(a) string rules: each media form is stripped; links, url(#id), ordinary prose are untouched", () => {
  const cases: [string, string, string[]][] = [
    ['前<img src="https://e.com/a.png" alt="x">後', "前後", ["html_media_tag"]],
    ["前<video controls><source src='v.mp4'></video>後", "前後", ["html_media_tag"]],
    ['<svg><image href="https://e.com/i.png"/></svg>', "<svg></svg>", ["html_media_tag"]],
    ["<foreignObject><div>x</div></foreignObject>本文", "本文", ["html_media_tag"]],
    ["図![alt](https://e.com/a.webp)です", "図です", ["markdown_image"]],
    ["背景 background:url(https://e.com/bg.png); 終", "背景 background:; 終", ["css_url"]],
    ["url(#grad) は参照", "url(#grad) は参照", []],
    ["data:audio/mp3;base64,SUQzAAAA で始まる", "で始まる", ["data_uri"]],
    ["動画 https://youtu.be/abc123 を見る", "動画  を見る", ["embed_url"]],
    ["https://player.vimeo.com/video/1", "", ["embed_url"]],
    ["曲は//cdn.example.com/a/b.flac?x=1。", "曲は。", ["media_url"]],
    ["https://example.com/image.png.html は頁", "https://example.com/image.png.html は頁", []],
    ["https://example.com/about は出典", "https://example.com/about は出典", []],
    ["画像や音声には触れない。", "画像や音声には触れない。", []],
  ];
  for (const [inp, out, kinds] of cases) {
    const r = stripMedia(inp);
    assert.equal(r.out, out, inp);
    assert.deepEqual(r.hits.map((h) => h.kind), kinds, inp);
  }
});

test("sentence spans follow gen/write.ts splitSentences; removeSpans keeps the rest byte-for-byte", () => {
  for (const s of ["一文目。二文目！三文目？", "「台詞だ。」と言った。次。", "改行\nを含む。文", "終端なし", "。。。", " 先頭空白。"]) {
    assert.deepEqual(sentenceSpans(s).map((x) => x.text), splitSentences(s), s);
  }
  const s = "甲。乙は長い。丙。";
  const sp = sentenceSpans(s);
  assert.equal(removeSpans(s, [sp[1]]), "甲。丙。");
});

test("applyEdits field rules: nullable → null, string-array entry removed, empty block removed, quiz explanation → \"\"", () => {
  const pw = clone(basePublic().pw);
  const qi = pw.pages.quiz.findIndex((q) => q.id === "qz01");
  const ti = pw.pages.themes.items.findIndex((t) => t.id === "th01");
  const oc = applyEdits(pw, [
    { path: ["pages", "overview", 0, "heading"], value: "", origHash: "h", element_id: "ov01" },
    { path: ["pages", "themes", "items", ti, "values", 0], value: " ", origHash: "h", element_id: "th01" },
    { path: ["pages", "themes", "intro", 0, "paragraphs", 0], value: "", origHash: "h", element_id: "themes_intro01" },
    { path: ["pages", "figure_notes", "relations", "paragraphs", 0], value: "", origHash: "h", element_id: "fn_relations" },
    { path: ["pages", "quiz", qi, "explanation"], value: "", origHash: "h", element_id: "qz01" },
  ]);
  assert.equal(pw.pages.overview[0].heading, null);
  assert.deepEqual(pw.pages.themes.items[ti].values, ["自己保存"]);
  assert.deepEqual(pw.pages.themes.intro, []);
  assert.equal(pw.pages.figure_notes.relations, null);
  assert.equal(pw.pages.quiz[qi].explanation, "");
  assert.ok(pw.pages.quiz.some((q) => q.id === "qz01"), "quiz item kept");
  assert.deepEqual(checkPublicWork(pw), []);
  assert.deepEqual(oc.fieldActions.map((f) => f.action), ["field_nulled", "entry_removed", "entry_removed", "entry_removed", "field_nulled", "element_removed", "element_removed"]);
});

test("rewrite schema is OpenAI-strict; notice text; stage descriptor; check command usage", async () => {
  assert.deepEqual(strictSchemaViolations(A1_REWRITE_SCHEMA), []);
  assert.equal(AUTOCHECK_STAGE.name, "autocheck");
  assert.equal(AUTOCHECK_STAGE.state, "checking");
  assert.equal(AUTOCHECK_STAGE.run, autoCheck);
  const zero = Object.fromEntries(ADVISORY_TYPES.map((t) => [t, 0])) as CheckReport["advisory_counts"];
  const n = buildNotice({ a1: { detected: [], removed: [], rewritten_ok: 0 } as unknown as CheckReport["a1"], a2: { detected: [] } as unknown as CheckReport["a2"], advisory_counts: zero });
  assert.deepEqual(n, { line: "自動確認: A-1 検出 0・A-2 検出 0／advisory 0件", points: [] });
  assert.equal(formatNotice({ line: "L", points: ["a", "b"] }), "L\n- a\n- b");
  assert.equal(await checkCommand([]), 2);
  assert.equal(await checkCommand(["../etc"]), 2);
  assert.equal(await checkCommand(["no-such-work-id-xyz"]), 3);
});

test("A-1 matching: allowlist chars do not count; full-width / space variants match; a copy across a sentence boundary flags both sentences, a shared boundary 。 does not", () => {
  const corpus = { texts: [RAW_S1], checked: 1, missing: [] };
  const withNames = buildA1Index(corpus, makeReducer(["人物甲", "人物乙", "人物丙"].map(normKey)));
  const noNames = buildA1Index(corpus, makeReducer([]));
  assert.equal(flaggedSpans(N1_TEXT, withNames).length, 0, "31 chars with names, 22 without → not a copy");
  assert.equal(flaggedSpans(N1_TEXT, noNames).length, 1, "the same text is a copy when names are counted");
  assert.deepEqual(flaggedSpans(P4_TEXT, withNames).map((s) => s.text), [P4_VARIANT]);
  const a = "古い灯台の扉は錆びつき誰も開けられない。"; // 20 chars
  const b = "鍵は海に沈んだと町では噂されていた。"; // 18 chars
  const idx = buildA1Index({ texts: ["前置き。" + a + b + "以上。"], checked: 1, missing: [] }, makeReducer([]));
  assert.deepEqual(flaggedSpans("自分の文。" + a + b + "別の文。", idx).map((s) => s.text), [a, b]);
  assert.deepEqual(flaggedSpans("自分の文。" + a + "別の文。", idx), []);
});
