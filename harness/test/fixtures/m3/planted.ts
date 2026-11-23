/**
 * WP-3.4 planted-contamination test data (tests only; temp dirs, no real work data).
 *
 * buildPlantedWork(root) writes works/<id>/ (from the S3 fixture work) with:
 *  - saved raw source text (research/raw/s000000001.txt) holding distinctive passages, and an excerpt of a source
 *    whose raw text is missing (s000000003);
 *  - gen/public.json = the deterministic projection of the fixture NKG + page text, with planted copies:
 *      A-1 (must be detected, 6 sentences):
 *        P1 overview paragraph (Haiku page text)            ← SRC_A verbatim
 *        P2 Luna-authored event summary (ev02)              ← SRC_B verbatim
 *        P3 Haiku-authored theme analysis (th01)            ← SRC_C verbatim
 *        P4 quiz explanation (qz01)                         ← SRC_D with full-width digits/latin + spaces
 *        P5 required label of a Luna event (ev03)           ← SRC_E (label-only copy: forces element removal + cascade)
 *        P7 interpretation position claim (ip01, Haiku)     ← excerpt EXC_P (raw text missing)
 *      A-1 negative: N1 context summary (cx01) ← SRC_N, ≥ 30 chars only when the character names are counted
 *      A-2 (must be detected, 5 matches): <img src=…png>, markdown image (a whole heading), data:image/png;base64 URI,
 *        YouTube embed <iframe>, bare …mp3 URL. Negative: sources[0].url ends in .png; a plain https link in text.
 *  - gen/projection.json with chain_dropout (from buildProjection).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PublicWork, TextBlock } from "../../../../site/src/public-types.ts";
import { checkPublicWork } from "../../../src/gen/check.ts";
import { loadGenreVocab } from "../../../src/gen/io.ts";
import { buildProjection } from "../../../src/gen/project.ts";
import { GEN_WORK_ID, genCards, genNkg, genValidation, genWork, makeGenWork } from "../../../src/gen/testFixtures.ts";
import type { SourceCard } from "../../../src/research/types.ts";

export const WORK_ID = GEN_WORK_ID;

// ------------------------------------------------------------------ saved source text (distinctive passages)
export const SRC_A = "灯台守の老人は嵐の夜ごとに古い航海日誌を読み返し、沈んだ船の名前を一つずつ声に出して数えていた。";
export const SRC_B = "港町の市場では毎朝夜明け前から魚の競りが始まり、仲買人たちの掛け声が石畳の路地に反響していた。";
export const SRC_C = "この物語における沈黙は単なる欠落ではなく、登場人物が互いを守るために選び取った最後の言語として機能している。";
export const SRC_D = "第3章で明かされる1984年の取引記録は、組織の帳簿にABC商会の名義で残されていたという設定である。";
export const SRC_E_SENTENCE = "嵐の翌朝に二人が灯台の階段で交わした約束を互いに破らないと誓い直す和解の場面が描かれる。";
/** ≥ 30 normalized chars only when the names (人物甲・人物乙・人物丙, on the allowlist) are counted: 31 with, 22 without. */
export const SRC_N = "人物甲と人物乙と人物丙は組織の掟に背いて港で密かに会い続けた。";
/** Excerpt of s000000003 (its raw text is not saved). */
export const EXC_P = "この解釈では離脱は敗北ではなく、自らの居場所を自分で選び直すための静かな出発として読まれている。";

export const RAW_S1 = [
  "公式の紹介文。",
  SRC_A,
  "物語は小さな港町を舞台にしている。",
  SRC_B,
  "評者の多くは次のように述べる。",
  SRC_C,
  "設定資料によれば、",
  SRC_D,
  "終盤では、",
  SRC_E_SENTENCE,
  "なお、",
  SRC_N,
  "以上が紹介文の全体である。",
].join("");

// ------------------------------------------------------------------ planted generated strings
export const P1_CLEAN_BEFORE = "甲と乙の信頼が物語の軸になる。";
export const P1_CLEAN_AFTER = "その記憶が二人の行動を縛る。";
export const P1_TEXT = P1_CLEAN_BEFORE + SRC_A + P1_CLEAN_AFTER;
/** What the fake Haiku returns for P1 (clean). */
export const P1_REWRITE = P1_CLEAN_BEFORE + "老いた番人は荒天のたびに昔の記録をめくり、失われた船を数え上げていた。" + P1_CLEAN_AFTER;
export const P2_TEXT = "対立が表に出る。" + SRC_B;
/** What the fake Luna returns for P2: the clean sentence is reworded, the copied sentence stays → it is removed. */
export const P2_STILL_COPIED = "対立が表面化する。" + SRC_B;
export const P2_EXPECTED = "対立が表面化する。";
export const P3_TEXT = "信頼と沈黙の関係を読む。" + SRC_C;
export const P3_EXPECTED = "信頼と沈黙の関係を読む。";
/** SRC_D with full-width digits / latin letters and inserted (full-width and ASCII) spaces. */
export const P4_VARIANT = "第３章で明かされる　１９８４年の取引記録は、組織の帳簿に ＡＢＣ商会の名義で 残されていたという設定である。";
export const P4_TEXT = "崩壊が直接の原因。" + P4_VARIANT;
export const P4_EXPECTED = "崩壊が直接の原因。";
export const P5_LABEL = "嵐の翌朝に二人が灯台の階段で交わした約束を互いに破らないと誓い直す和解";
export const P7_CLAIM = EXC_P;
export const N1_TEXT = SRC_N + "受賞の経緯は資料が少ない。";

export const M1_TAG = '<img src="https://example.com/x.png">';
export const M1_TEXT = "人物甲の視点で整理する。" + M1_TAG + "図は使わない。";
export const M1_EXPECTED = "人物甲の視点で整理する。図は使わない。";
export const M2_HEADING = "![表紙](https://example.com/cover.jpg)";
export const M3_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
export const M3_TEXT = "甲の相棒。" + M3_URI;
export const M3_EXPECTED = "甲の相棒。";
export const M4_IFRAME = '<iframe src="https://www.youtube.com/embed/abc123" allowfullscreen></iframe>';
export const M4_TEXT = "相棒関係の変化に注目する。" + M4_IFRAME;
export const M4_EXPECTED = "相棒関係の変化に注目する。";
export const M5_URL = "https://media.example.com/theme.mp3";
export const PLAIN_LINK_TEXT = "詳細は https://example.org/about を参照。";

export interface PlantedWork {
  dir: string;
  /** public.json as written (before S4). */
  before: PublicWork;
  beforeText: string;
  /** Planted A-1 sentences by path (exactly the paths expected in report.a1.detected). */
  a1Paths: Record<"P1" | "P2" | "P3" | "P4" | "P5" | "P7", string>;
  a1NegativePaths: string[];
  /** Planted A-2 matches: path → kind. */
  a2: { path: string; kind: string }[];
  /** Strings that must never appear in check/report.json. */
  secrets: string[];
  idx: { ev02: number; ev03: number; th01: number; ip01: number; qz01: number; su01: number; cx01: number; ch02: number; ar01: number; ev03Timeline: number };
}

const block = (o: Partial<TextBlock> & { id: string; paragraphs: string[] }): TextBlock => ({ heading: null, spoiler: "none", based_on: [], epistemic: "sfsh_analysis", ...o });

export function plantedCards(): SourceCard[] {
  return genCards().map((c) => (c.source_id === "s000000003" ? { ...c, excerpts: [{ text: EXC_P, offset: 0, claim_ids: ["c0003"] }] } : c));
}

/** Projection of the S3 fixture NKG + page text (clean, no plants). */
export function basePublic(): { pw: PublicWork; chainDropout: unknown } {
  const nkg = genNkg();
  const r = buildProjection({ nkg, validation: genValidation(nkg), cards: plantedCards(), work: genWork(), tags: [], genreVocab: loadGenreVocab() });
  const pw = r.projection;
  pw.pages.overview = [
    block({ id: "ov01", heading: "骨格", paragraphs: ["二人の信頼が崩れていく過程を追う。", "二つ目の段落は分析を続ける。"], based_on: ["ch01", "ev03"], epistemic: "sfsh_analysis" }),
    block({ id: "ov02", heading: "見方", paragraphs: ["人物甲の視点で整理する。", "因果の順に読む。"], based_on: ["ch01"] }),
  ];
  pw.pages.figure_notes = {
    relations: block({ id: "fn_relations", paragraphs: ["相棒関係の変化に注目する。"], based_on: ["rl01"] }),
    reverse_plot: block({ id: "fn_reverse_plot", paragraphs: ["結末から原因へたどる。"], based_on: ["oc01"] }),
    matrix: pw.viz.matrix ? block({ id: "fn_matrix", paragraphs: ["読者の列を見る。"], based_on: ["se01"] }) : null,
  };
  pw.pages.themes.intro = [block({ id: "themes_intro01", paragraphs: ["信頼の主題を扱う。"], based_on: ["th01"] })];
  return { pw, chainDropout: (r as { chainDropout?: unknown }).chainDropout ?? { count: 0, by_type: {}, roots: [] } };
}

function writeWorkFiles(dir: string, pw: PublicWork, chainDropout: unknown): string {
  mkdirSync(path.join(dir, "gen"), { recursive: true });
  const problems = checkPublicWork(pw);
  if (problems.length) throw new Error(`planted fixture: public.json shape: ${problems.slice(0, 5).join("; ")}`);
  const text = JSON.stringify(pw, null, 2) + "\n";
  writeFileSync(path.join(dir, "gen", "public.json"), text);
  writeFileSync(path.join(dir, "gen", "projection.json"), JSON.stringify({ ...pw, chain_dropout: chainDropout }, null, 2) + "\n");
  return text;
}

export function buildPlantedWork(root: string): PlantedWork {
  const dir = makeGenWork(root);
  writeFileSync(path.join(dir, "research", "raw", "s000000001.txt"), RAW_S1);
  writeFileSync(path.join(dir, "research", "sources.json"), JSON.stringify(plantedCards(), null, 2));

  const { pw, chainDropout } = basePublic();
  const find = <T extends { id: string }>(xs: T[], id: string) => {
    const i = xs.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`planted fixture: ${id} not in projection`);
    return i;
  };
  const idx = {
    ev02: find(pw.elements.events, "ev02"),
    ev03: find(pw.elements.events, "ev03"),
    th01: find(pw.pages.themes.items, "th01"),
    ip01: find(pw.pages.interpretations.items, "ip01"),
    qz01: find(pw.pages.quiz, "qz01"),
    su01: find(pw.elements.setups, "su01"),
    cx01: find(pw.pages.context.items, "cx01"),
    ch02: find(pw.viz.relations.characters, "ch02"),
    ar01: find(pw.elements.arcs, "ar01"),
    ev03Timeline: pw.viz.timeline ? find(pw.viz.timeline.events, "ev03") : -1,
  };

  // A-1 plants
  pw.pages.overview[0].paragraphs[0] = P1_TEXT;
  pw.elements.events[idx.ev02].summary = P2_TEXT;
  pw.pages.themes.items[idx.th01].analysis = P3_TEXT;
  pw.pages.quiz[idx.qz01].explanation = P4_TEXT;
  pw.elements.events[idx.ev03].label = P5_LABEL;
  pw.pages.interpretations.items[idx.ip01].positions[0].claim = P7_CLAIM;
  pw.pages.context.items[idx.cx01].summary = N1_TEXT;
  // A-2 plants
  pw.pages.overview[1].paragraphs[0] = M1_TEXT;
  pw.pages.overview[1].paragraphs[1] = PLAIN_LINK_TEXT;
  pw.pages.overview[1].heading = M2_HEADING;
  pw.viz.relations.characters[idx.ch02].summary = M3_TEXT;
  pw.pages.figure_notes.relations!.paragraphs[0] = M4_TEXT;
  pw.elements.setups[idx.su01].meaning = `${pw.elements.setups[idx.su01].meaning} ${M5_URL}`;
  pw.sources[0].url = "https://pub.example/cover.png";

  const beforeText = writeWorkFiles(dir, pw, chainDropout);
  return {
    dir,
    before: JSON.parse(beforeText) as PublicWork,
    beforeText,
    a1Paths: {
      P1: "$.pages.overview[0].paragraphs[0]",
      P2: `$.elements.events[${idx.ev02}].summary`,
      P3: `$.pages.themes.items[${idx.th01}].analysis`,
      P4: `$.pages.quiz[${idx.qz01}].explanation`,
      P5: `$.elements.events[${idx.ev03}].label`,
      P7: `$.pages.interpretations.items[${idx.ip01}].positions[0].claim`,
    },
    a1NegativePaths: [`$.pages.context.items[${idx.cx01}].summary`],
    a2: [
      { path: "$.pages.overview[1].paragraphs[0]", kind: "html_media_tag" },
      { path: "$.pages.overview[1].heading", kind: "markdown_image" },
      { path: `$.viz.relations.characters[${idx.ch02}].summary`, kind: "data_uri" },
      { path: "$.pages.figure_notes.relations.paragraphs[0]", kind: "html_media_tag" },
      { path: `$.elements.setups[${idx.su01}].meaning`, kind: "media_url" },
    ],
    secrets: [SRC_A, SRC_B, SRC_C, SRC_D, P4_VARIANT, SRC_E_SENTENCE, P5_LABEL, EXC_P, SRC_N, M1_TAG, M2_HEADING, M3_URI, M4_IFRAME, M5_URL],
    idx,
  };
}

/**
 * Advisory stress work: no A-1 / A-2 plants, but hundreds of long quotes, a provisional title, many validation
 * warnings, unresolved too_concrete (S2 + S3 reviews), a holder-policy note, a lyric genre, a sentence similar to a
 * source sentence (no 30-char run), and chain_dropout > 0.
 */
export const SIMILAR_SOURCE = "灯台の明かりが消えた夜に町の人々は海辺に集まり長い沈黙のあとで静かに祈りを捧げた。";
/** SIMILAR_SOURCE with two words changed: high 3-gram overlap (Jaccard > 0.5), longest common run 21 chars (< 30). */
export const SIMILAR_GENERATED = "灯台の明かりが消えた夜に町の人々は浜辺に集まり長い沈黙のあとで静かに祈りを捧げる。";

export function buildAdvisoryWork(root: string, opts: { quotes?: number; warnings?: number } = {}): { dir: string; quotes: number; warnings: number } {
  const quotes = opts.quotes ?? 300;
  const nWarn = opts.warnings ?? 250;
  const dir = makeGenWork(root);
  writeFileSync(path.join(dir, "research", "raw", "s000000001.txt"), `紹介文。${SIMILAR_SOURCE}以上。`);
  writeFileSync(path.join(dir, "research", "sources.json"), JSON.stringify(plantedCards(), null, 2));
  // provisional title
  const work = genWork();
  work.title_status = "provisional";
  writeFileSync(path.join(dir, "work.json"), JSON.stringify(work, null, 2));
  // holder policy note + lyric genre
  const nkg = genNkg();
  nkg.work.rights.holder_policy_note = "公式サイトに二次利用の方針の記載があった";
  nkg.work.genres = [...nkg.work.genres, "poetry"];
  writeFileSync(path.join(dir, "nkg", "nkg.json"), JSON.stringify(nkg, null, 2));
  // many guideline warnings
  const v = { ...genValidation(nkg), warnings: [] as string[] };
  v.warnings = Array.from({ length: nWarn }, (_, i) => `soft: ev${String(i).padStart(2, "0")}.summary ${200 + i} chars > 160`);
  writeFileSync(path.join(dir, "nkg", "validation.json"), JSON.stringify(v, null, 2));
  // unresolved too_concrete
  mkdirSync(path.join(dir, "nkg", "reviews"), { recursive: true });
  mkdirSync(path.join(dir, "gen", "reviews"), { recursive: true });
  const adv = (target_id: string) => ({ target_id, type: "too_concrete", severity: "medium", evidence: "場面の再話に近い", round: 2 });
  writeFileSync(path.join(dir, "nkg", "reviews", "fact.json"), JSON.stringify({ layer: "fact", advisory: [adv("ev01"), adv("ev04"), { ...adv("ev02"), type: "overreach" }] }));
  writeFileSync(path.join(dir, "gen", "reviews", "pages.json"), JSON.stringify({ layer: "pages", advisory: [adv("ov01")] }));

  const { pw, chainDropout } = basePublic();
  pw.pages.overview[0].paragraphs = Array.from({ length: quotes }, (_, i) => `評では「人物の選択が物語全体の重心を少しずつ動かしていく第${i + 1}の局面」と言われる。`);
  pw.pages.overview[1].paragraphs = [SIMILAR_GENERATED];
  writeWorkFiles(dir, pw, { ...(chainDropout as object), count: 3 });
  return { dir, quotes, warnings: nWarn };
}
