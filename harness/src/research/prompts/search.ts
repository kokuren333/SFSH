import { ASPECT_GUIDE, workLine, type WorkBrief } from "./common.ts";

/** Max selections Luna may return per search call (code also truncates). */
export const MAX_SELECTIONS = 25;

/** OpenAI-strict schema for s1.search.r<n>. */
export const SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["selections", "notes"],
  properties: {
    selections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "why", "aspects", "tier_suggested"],
        properties: {
          url: { type: "string" },
          why: { type: "string" },
          aspects: { type: "array", items: { type: "string" } },
          tier_suggested: { type: ["string", "null"], enum: ["T1", "T2", "T3", "T4", "T5", null] },
        },
      },
    },
    notes: { type: ["string", "null"] },
  },
} as const;

export interface SearchPromptInput {
  work: WorkBrief;
  aspects: string[];
  maxSearches: number;
  round: number;
  /** Extra query ideas (e.g. Haiku's suggested_query for missing aspects). */
  hints?: string[];
  instructionUrls?: { url: string; note: string }[];
  /** URLs already fetched or already skipped in this work — do not select again (CP-019). */
  avoidUrls?: string[];
}

/** Cap on how many avoid-URLs are listed in the prompt. */
export const AVOID_URLS_MAX = 80;

export function buildSearchPrompt(i: SearchPromptInput): string {
  const lines: string[] = [];
  lines.push("あなたは物語作品の調査担当です。web_search ツールで検索を計画・実行し、本文を取得すべきページを選んでください。");
  lines.push("ページ本文の取得は別のプログラムが行います。あなたは検索して候補 URL を選ぶだけです。");
  lines.push("");
  lines.push(`## 作品\n${workLine(i.work)}`);
  lines.push("");
  lines.push(`## 調べる観点（第${i.round}回）`);
  for (const a of i.aspects) lines.push(`- ${a}`);
  lines.push("");
  lines.push("観点の意味:");
  lines.push(ASPECT_GUIDE);
  lines.push("");
  if (i.hints && i.hints.length) {
    lines.push("## 検索の手掛かり（参考）");
    for (const h of i.hints) lines.push(`- ${h}`);
    lines.push("");
  }
  if (i.instructionUrls && i.instructionUrls.length) {
    lines.push("## 依頼者が指定した URL（検索しなくても候補に入れてよい）");
    for (const u of i.instructionUrls) lines.push(`- ${u.url}（${u.note}）`);
    lines.push("");
  }
  if (i.avoidUrls && i.avoidUrls.length) {
    lines.push("## 取得済み・取得不可の URL（選ばない）");
    for (const u of i.avoidUrls.slice(0, AVOID_URLS_MAX)) lines.push(`- ${u}`);
    lines.push("");
  }
  const minSearches = Math.min(i.maxSearches, 6);
  lines.push("## 規則");
  lines.push(`- 検索は最大 ${i.maxSearches} 回。観点を分けて少なくとも ${minSearches} 回は検索する（1回の検索で全観点を済ませない）。観点ごとに有効な検索語（日本語と原語）を考えてから実行する。`);
  lines.push("- PDF・画像・動画・音声など HTML 以外のファイルへの URL は選ばない（取得できない）。上の「取得済み・取得不可の URL」も選ばない。");
  lines.push("- 百科事典型の記事（日本語版 Wikipedia 等）が検索結果にあれば1件は含める。");
  lines.push("- 出典の優先順: T1 公式（出版社・製作委員会・公式サイト・作者の発信・国会図書館などの書誌DB）> T2 専門（新聞・専門誌・学術・受賞機関・署名入り批評）> T3 百科事典型（Wikipedia 等）。T4 ファンwiki・個人ブログ、T5 掲示板・SNS は受容や考察の観点に限って少数だけ選ぶ。");
  lines.push("- 次のページは選ばない: 海賊版・違法アップロード・リーク、歌詞サイト、原作の全文や本文の転載、脚本・台本・字幕の書き起こし、ファンによる台詞の書き起こし、ペイウォール回避。");
  lines.push("- selections の url は、この呼び出しの検索結果に実際に表示された URL をそのまま書く。記憶や推測で URL を作らない（検索結果に無い URL は破棄される）。");
  lines.push("- open_page でページを開いて読む必要はない。");
  lines.push(`- selections は最大 ${MAX_SELECTIONS} 件。各件に why（選んだ理由・短く）、aspects（上の観点 ID）、tier_suggested（T1〜T5 の見立て。分からなければ null）を付ける。`);
  lines.push("- notes には検索で見つからなかった観点などを短く書く（無ければ null）。");
  return lines.join("\n");
}

/** Max selections per supplement call (code also truncates). */
export const SUPPLEMENT_MAX_SELECTIONS = 8;

export interface SupplementPromptInput {
  work: WorkBrief;
  /** The single aspect this call covers (e.g. "M10"). */
  aspect: string;
  /** Its line from ASPECT_GUIDE (or the aspect itself). */
  aspectGuide: string;
  maxSearches: number;
  round: number;
  avoidUrls?: string[];
}

/**
 * Narrow prompt for one code-driven supplement call (CP-029 finding a): a single aspect, a small search cap,
 * the same selection rules and the same SEARCH_SCHEMA as the main call.
 */
export function buildSupplementPrompt(i: SupplementPromptInput): string {
  const lines: string[] = [];
  lines.push("あなたは物語作品の調査担当です。web_search ツールで、下の1つの観点に絞って検索し、本文を取得すべきページを選んでください。");
  lines.push("ページ本文の取得は別のプログラムが行います。あなたは検索して候補 URL を選ぶだけです。");
  lines.push(`これは第${i.round}回の調査の補充です。先の検索ではこの観点の出典が見つかっていません（または検索が少なすぎました）。`);
  lines.push("");
  lines.push(`## 作品\n${workLine(i.work)}`);
  lines.push("");
  lines.push("## 調べる観点（この1つだけ）");
  lines.push(`- ${i.aspect}`);
  lines.push(`  意味: ${i.aspectGuide}`);
  lines.push("");
  if (i.avoidUrls && i.avoidUrls.length) {
    lines.push("## 取得済み・取得不可の URL（選ばない）");
    for (const u of i.avoidUrls.slice(0, AVOID_URLS_MAX)) lines.push(`- ${u}`);
    lines.push("");
  }
  lines.push("## 規則");
  lines.push(`- 検索は最大 ${i.maxSearches} 回。この観点に効く検索語（日本語と原語）を考えてから実行する。他の観点は調べない。`);
  lines.push("- PDF・画像・動画・音声など HTML 以外のファイルへの URL は選ばない（取得できない）。上の「取得済み・取得不可の URL」も選ばない。");
  lines.push("- 出典の優先順: T1 公式（出版社・製作委員会・公式サイト・作者の発信・国会図書館などの書誌DB）> T2 専門（新聞・専門誌・学術・受賞機関・署名入り批評）> T3 百科事典型（Wikipedia 等）。T4 ファンwiki・個人ブログ、T5 掲示板・SNS は受容や考察の観点に限って少数だけ選ぶ。");
  lines.push("- 次のページは選ばない: 海賊版・違法アップロード・リーク、歌詞サイト、原作の全文や本文の転載、脚本・台本・字幕の書き起こし、ファンによる台詞の書き起こし、ペイウォール回避。");
  lines.push("- selections の url は、この呼び出しの検索結果に実際に表示された URL をそのまま書く。記憶や推測で URL を作らない（検索結果に無い URL は破棄される）。");
  lines.push("- open_page でページを開いて読む必要はない。");
  lines.push(`- selections は最大 ${SUPPLEMENT_MAX_SELECTIONS} 件。各件に why（選んだ理由・短く）、aspects（この観点 ID を必ず含める）、tier_suggested（T1〜T5 の見立て。分からなければ null）を付ける。`);
  lines.push("- 適切なページが無ければ selections は空でよい。notes には見つからなかった事情を短く書く（無ければ null）。");
  return lines.join("\n");
}

// ---------------------------------------------------------------- AMENDMENT 12

/** Max selections of the plot-frame main call / of one targeted call (code also truncates). [暫定] */
export const PLOT_MAX_SELECTIONS = 20;
export const TARGET_MAX_SELECTIONS = 6;

const PLOT_SOURCE_GUIDE = [
  "- 狙う出典（粗筋枠）: 公式サイトの STORY・各話あらすじ／出版社・配給の作品紹介／百科事典型の記事のあらすじ節・各話リスト（日本語版 Wikipedia 等）／作品データベース（映画・アニメ・書籍のデータベースのあらすじ・各話情報）／新聞・専門誌の作品解説で筋を追っているもの。",
  "- 各話・各章の出来事、物語の転換、結末（最終回・最終章で何が起きたか）が具体的に書かれているページを優先する。紹介文だけで筋が無いページは後回し。",
  "- 出典の優先順は T1 公式 > T2 専門 > T3 百科事典型。T4 ファンwiki・個人ブログは公式・百科事典型で足りない区間に限って少数。",
  "- 次のページは選ばない: 海賊版・違法アップロード・リーク、原作の全文や本文の転載、脚本・台本・字幕の書き起こし、ファンによる台詞の書き起こし、歌詞サイト、ペイウォール回避。PDF・画像・動画・音声など HTML 以外のファイル。",
].join("\n");

export interface PlotSearchPromptInput {
  work: WorkBrief;
  maxSearches: number;
  /** Which part of the story this call should cover (null = the whole story; main call). */
  segment: string | null;
  avoidUrls?: string[];
  maxSelections?: number;
}

/** Plot frame (AMENDMENT 12): event-granular synopsis sources, kept apart from the analysis aspects. */
export function buildPlotSearchPrompt(i: PlotSearchPromptInput): string {
  const lines: string[] = [];
  const maxSel = i.maxSelections ?? PLOT_MAX_SELECTIONS;
  lines.push("あなたは物語作品の調査担当です。web_search ツールで検索し、物語の筋（出来事の連なり）を序盤から結末まで追える出典ページを選んでください。");
  lines.push("ページ本文の取得は別のプログラムが行います。あなたは検索して候補 URL を選ぶだけです。分析・評論の出典は別の調査で集めるので、ここでは選ばなくてよい。");
  lines.push("");
  lines.push(`## 作品\n${workLine(i.work)}`);
  lines.push("");
  lines.push(i.segment ? `## 今回の範囲\n- ${i.segment}（この範囲の出来事が分かるページに絞る）` : "## 今回の範囲\n- 物語全体（序盤・中盤・結末のすべて）");
  lines.push("");
  if (i.avoidUrls && i.avoidUrls.length) {
    lines.push("## 取得済み・取得不可の URL（選ばない）");
    for (const u of i.avoidUrls.slice(0, AVOID_URLS_MAX)) lines.push(`- ${u}`);
    lines.push("");
  }
  const minSearches = Math.min(i.maxSearches, i.segment ? 1 : 5);
  lines.push("## 規則");
  lines.push(`- 検索は最大 ${i.maxSearches} 回、少なくとも ${minSearches} 回。検索語を変えて（「あらすじ」「ストーリー」「各話」「第N話」「最終回」「結末」「ネタバレ」、原語の synopsis / plot / episode list など）、区間ごとに探す。1回の検索で済ませない。`);
  lines.push(PLOT_SOURCE_GUIDE);
  lines.push("- selections の url は、この呼び出しの検索結果に実際に表示された URL をそのまま書く。記憶や推測で URL を作らない（検索結果に無い URL は破棄される）。");
  lines.push("- open_page でページを開いて読む必要はない。");
  lines.push(`- selections は最大 ${maxSel} 件。各件に why（どの区間の筋が分かるか・短く）、aspects（必ず plot を含める。結末が分かるなら M02、因果が分かるなら M03 も）、tier_suggested（T1〜T5 の見立て。分からなければ null）を付ける。`);
  lines.push("- notes には見つからなかった区間などを短く書く（無ければ null）。");
  return lines.join("\n");
}

export interface TargetSearchPromptInput {
  work: WorkBrief;
  /** What is missing, in words (e.g. "第10話の出来事", "結末（最終回）で何が起きたか", "人物「杏子」の物語上の動き"). */
  target: string;
  /** Aspect ids the selections must carry (e.g. ["plot"] or ["M09"]). */
  aspects: string[];
  maxSearches: number;
  hints?: string[];
  avoidUrls?: string[];
}

/** One targeted follow-up call for a single coverage shortfall (AMENDMENT 12). */
export function buildTargetSearchPrompt(i: TargetSearchPromptInput): string {
  const lines: string[] = [];
  const plot = i.aspects.includes("plot");
  lines.push("あなたは物語作品の調査担当です。web_search ツールで、下の「不足している点」だけに絞って検索し、本文を取得すべきページを選んでください。");
  lines.push("ページ本文の取得は別のプログラムが行います。あなたは検索して候補 URL を選ぶだけです。これまでの調査で、この点を裏づける出典が足りませんでした。");
  lines.push("");
  lines.push(`## 作品\n${workLine(i.work)}`);
  lines.push("");
  lines.push(`## 不足している点（この1つだけ）\n- ${i.target}`);
  lines.push("");
  if (i.hints && i.hints.length) {
    lines.push("## 検索の手掛かり（参考）");
    for (const h of i.hints) lines.push(`- ${h}`);
    lines.push("");
  }
  if (i.avoidUrls && i.avoidUrls.length) {
    lines.push("## 取得済み・取得不可の URL（選ばない）");
    for (const u of i.avoidUrls.slice(0, AVOID_URLS_MAX)) lines.push(`- ${u}`);
    lines.push("");
  }
  lines.push("## 規則");
  lines.push(`- 検索は最大 ${i.maxSearches} 回。この点に効く検索語（日本語と原語）を考えてから実行する。他の点は調べない。取得済みの URL とは別のページを探す。`);
  if (plot) lines.push(PLOT_SOURCE_GUIDE);
  else {
    lines.push("- 出典の優先順: T1 公式 > T2 専門（新聞・専門誌・学術・受賞機関・署名入り批評）> T3 百科事典型。T4 ファンwiki・個人ブログ、T5 掲示板・SNS は受容や考察の観点に限って少数だけ選ぶ。");
    lines.push("- 次のページは選ばない: 海賊版・違法アップロード・リーク、歌詞サイト、原作の全文や本文の転載、脚本・台本・字幕の書き起こし、ファンによる台詞の書き起こし、ペイウォール回避。PDF・画像・動画・音声など HTML 以外のファイル。");
  }
  lines.push("- selections の url は、この呼び出しの検索結果に実際に表示された URL をそのまま書く。記憶や推測で URL を作らない（検索結果に無い URL は破棄される）。");
  lines.push("- open_page でページを開いて読む必要はない。");
  lines.push(`- selections は最大 ${TARGET_MAX_SELECTIONS} 件。各件に why（この点のどこが分かるか・短く）、aspects（${i.aspects.join("・")} を必ず含める）、tier_suggested（T1〜T5 の見立て。分からなければ null）を付ける。`);
  lines.push("- 適切なページが無ければ selections は空でよい。notes には見つからなかった事情を短く書く（無ければ null）。");
  return lines.join("\n");
}
