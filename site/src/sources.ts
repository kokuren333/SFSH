import { html, type Raw } from './html.ts';
import type { PublicWork, Grade } from './public-types.ts';

/** One bibliography per work; element-to-source mappings stay in public.json. */
export function sourceFooter(prefix: string): Raw {
  return html`<section class="source-summary"><h2>出典と信頼度</h2><p><a href="${prefix}sources/">参照資料・出典カードと信頼度の一覧</a></p></section>`;
}

export function sourceCards(work: PublicWork): Raw {
  const grades = new Map<string, Set<Grade>>();
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.source_refs) && ['A', 'B', 'C', 'D'].includes(String(obj.grade))) {
      for (const id of obj.source_refs as string[]) {
        if (!grades.has(id)) grades.set(id, new Set());
        grades.get(id)!.add(obj.grade as Grade);
      }
    }
    Object.values(obj).forEach(collect);
  };
  collect(work);
  const tierLabels = { T1: '公式', T2: '専門', T3: '編集型', T4: 'ファン', T5: '匿名' };
  return html`<p>参照資料を作品単位でまとめています。出典の区分と、その資料を根拠に含む公開要素の信頼度を示します。信頼度は複数の資料や認識区分から算出した値で、資料単独の評価ではありません。</p><ol class="sources">${work.sources.map(s => html`<li id="${s.source_id}"><h2>${s.title}</h2><p>発行者: ${s.publisher || '不明'}</p><p>${/^https?:\/\/[^\s]+$/i.test(s.url) ? html`<a href="${s.url}" rel="nofollow noopener">${s.url}</a>` : s.url}</p><p>参照日: ${s.accessed} · 出典区分: ${s.tier}（${tierLabels[s.tier]}）</p><p>根拠要素の信頼度: ${[...(grades.get(s.source_id) ?? [])].sort().join('・') || '未付与'}</p>${s.license ? html`<p>${s.license}</p>` : null}</li>`)}</ol>`;
}
