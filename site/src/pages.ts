/**
 * Common site pages (WP-5.4; REQUIREMENTS §5.4, §6.1, U-10 / U-11 / U-14 / U-15). Static HTML, readable without JS.
 * Every page is at depth 1 (`<dir>/index.html`), so links to siblings use `../`.
 * All text here is code-authored; the only settings-derived values (site name, contact URL) are validated in
 * site-settings.ts and still pass through the escaping html`` template.
 */
import { html } from './html.ts';
import type { Raw } from './html.ts';
import type { Epistemic } from './public-types.ts';
import type { DesignTokens } from './design/tokens-types.ts';
import { badge, commonPages, spoilerLabel } from './templates.ts';
import { displayName } from './site-settings.ts';
import type { SiteSettings } from './site-settings.ts';

const EPISTEMIC_TEXT: Record<Epistemic, string> = {
  canon: '作品の中で明示されている事実です。',
  consensus: '多くの読者や評論のあいだで共有されている読み方です。',
  fan_theory: '読者による推測や仮説です。作品の中では確定していません。',
  sfsh_analysis: 'このサイトが独自に行った分析です。',
};
const FOLDED_SUMMARY = '結末に触れる内容（クリックで表示）';

function related(except: string): Raw {
  return html`<section><h2>関連ページ</h2><ul>${commonPages.filter(c => c.dir !== except).map(c => html`<li><a href="../${c.dir}/">${c.title}</a></li>`)}<li><a href="../sitemap/">サイトマップ</a></li></ul></section>`;
}

export function aboutBody(site: SiteSettings, tokens: DesignTokens): Raw {
  const name = displayName(site);
  return html`${[html`<section><h2>このサイトは</h2><p>${name}は、物語の構造を分析する非公式のサイトです。登場人物の動機と関係、出来事の原因と結果、作品のテーマを、私たち自身の言葉で整理します。作品の権利者とは関係がありません。</p><p>原作の文章・台詞・画像は使わず、引用もしません。詳しくは「方針」をご覧ください。</p></section>`,
    html`<section><h2>作品ページの読み方</h2><p>作品ページの最初に、題名・対象範囲・ネタバレの度合いと、主要な図への入口があります。リバースプロットは、結末から直接の原因、要因、根本原因へとさかのぼる木です。人物関係図は、物語の段階ごとに関係がどう変わるかを示します。どの図にも、同じ内容の表またはリストを添えています。</p></section>`,
    html`<section><h2>認識区分</h2><p>書かれている内容が、どの程度確かなものかを4つに分けて示します。色だけでなく、記号と名前でも区別しています。</p><ul>${(Object.keys(EPISTEMIC_TEXT) as Epistemic[]).map(ep => html`<li>${badge(ep, tokens)}: ${EPISTEMIC_TEXT[ep]}</li>`)}</ul><p>信頼度（A〜D）は、参照した出典の種類と数から機械的に計算した値です。A がもっとも根拠が強く、D がもっとも弱いことを表します。</p></section>`,
    html`<section><h2>出典</h2><p>作品ごとの「出典」ページに、参照した資料の題名・発行者・URL・参照日と、必要なライセンス表示を載せています。</p></section>`,
    html`<section><h2>情報不足の観点</h2><p>根拠が足りない観点は推測で埋めず、作品ページに「この観点は情報不足のため未掲載」と表示します。</p></section>`,
    html`<section><h2>取り下げ依頼・お問い合わせ</h2><p>公開リポジトリの Issues を窓口としています。依頼の方法は「取り下げ依頼の窓口」をご覧ください。</p></section>`,
    related('about')]}`;
}

export function policyBody(site: SiteSettings): Raw {
  const name = displayName(site);
  return html`${[html`<section><h2>非公式であること</h2><p>${name}は非公式のサイトです。作品の作者・出版社・制作会社などの権利者とは関係がなく、承認も受けていません。</p></section>`,
    html`<section><h2>独自の分析であること</h2><p>内容は、公開されている資料をもとにした私たち自身の分析と要約です。文章はすべて自分たちの言葉で書いています。場面を再現するのではなく、物語の構造を要約します。</p></section>`,
    html`<section><h2>引用しないこと</h2><p>原作の文章・台詞・画像は使いません。原則として引用もしません。</p></section>`,
    html`<section><h2>図と画像</h2><p>サイト内の図は、すべてプログラムで自作したものです。書影・場面写真・公式ロゴ・キャラクター画像や、それらに似せた画像は載せません。外部の画像も読み込みません。</p></section>`,
    html`<section><h2>出典の表示</h2><p>参照した資料は作品ごとの「出典」ページに一覧にしています。ライセンスの表示が必要な資料は、その表示を載せています。</p></section>`,
    html`<section><h2>広告とアクセス解析</h2><p>広告は載せません。アクセス解析や、閲覧を追跡する仕組みも使いません。検索エンジンへの登録は許可しています。</p></section>`,
    html`<section><h2>取り下げ</h2><p>権利者などから取り下げの依頼を受けたときは、是非を検討する前に、まず該当するページを取り下げます。検討はその後で行います。依頼の方法は「取り下げ依頼の窓口」をご覧ください。</p></section>`,
    related('policy')]}`;
}

export function takedownBody(site: SiteSettings): Raw {
  const url = site.contact.url;
  const where = url
    ? html`<p>取り下げの依頼は、このサイトの公開リポジトリの Issues で受け付けています。</p><ul><li><a href="${url}" rel="noopener">${url}</a></li></ul>`
    : html`<p>取り下げの依頼は、このサイトの公開リポジトリの Issues で受け付けます。Issues へのリンクは、サイトの開設時にこのページに掲示します。</p>`;
  return html`${[html`<section><h2>依頼の方法</h2>${where}</section>`,
    html`<section><h2>書いていただきたいこと</h2><ul><li>対象の作品名</li><li>対象のページの URL</li><li>取り下げを求める理由</li></ul></section>`,
    html`<section><h2>個人情報について</h2><p>Issues は誰でも読める場所です。住所・電話番号・連絡先などの個人情報は書かないでください。</p></section>`,
    html`<section><h2>対応の流れ</h2><p>依頼を確認したら、是非を検討する前に、まず該当するページを取り下げます。確認から15分以内の取り下げを目標にしています。内容の検討はその後で行います。</p><p>取り下げたページは公開中のサイトから消え、公開リポジトリの履歴にも残りません。ただし、検索エンジンのキャッシュなど、このサイトの外にある写しが消えるまでには時間がかかることがあります。</p></section>`,
    related('takedown')]}`;
}

export function spoilersBody(): Raw {
  const levels: [string, string][] = [
    [spoilerLabel('none'), '物語の前提や序盤の設定だけを扱います。'],
    [spoilerLabel('mid'), '物語の途中の展開に触れます。該当する箇所に「中盤のネタバレ」と表示します。'],
    [spoilerLabel('ending'), `結末や終盤の展開に触れます。該当する箇所は最初は折りたたまれていて、「${FOLDED_SUMMARY}」を開いたときだけ表示されます。`],
  ];
  return html`${[html`<section><h2>ネタバレの度合い</h2><p>作品ページは、結末までの内容を扱うことがあります。そのため、内容がどこまでのネタバレを含むかを次の3段階で示しています。</p><ul>${levels.map(([label, text]) => html`<li><strong>${label}</strong>: ${text}</li>`)}</ul><p>折りたたみは JavaScript を使わずに動作します。理解度テストの答えも、同じように折りたたんでいます。</p></section>`,
    html`<section><h2>作品ページでの表示</h2><p>各作品ページの最初に「対象範囲」と、そのページが含むもっとも強いネタバレの度合い（例: 「${spoilerLabel('ending')}」）を表示しています。対象範囲は、分析の対象にした巻・話数などの範囲です。</p><p>連載中の作品や発売直後の作品でも、公開を遅らせる期間は設けていません。ネタバレを避けたい方は、各ページの表示を確かめてからお読みください。</p></section>`,
    related('spoilers')]}`;
}
