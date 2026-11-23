import { html } from './html.ts';
import type { Raw } from './html.ts';
import type { PublicWork } from './public-types.ts';
import type { DesignTokens } from './design/tokens-types.ts';
type Viz = PublicWork['viz'];
export interface FigureModule {
  renderRelations: (viz: Viz['relations'], ctx: FigureContext) => Raw | null;
  renderReversePlot: (viz: Viz['reverse_plot'], ctx: FigureContext) => Raw | null;
  renderMatrix: (viz: NonNullable<Viz['matrix']>, ctx: FigureContext) => Raw | null;
  renderTimeline?: (viz: NonNullable<Viz['timeline']>, ctx: FigureContext) => Raw | null;
  /** AMENDMENT 09 card views (primary on every width). Optional: a module without them shows the figure only. */
  renderRelationsCards?: (viz: Viz['relations'], ctx: FigureContext) => Raw | null;
  renderReversePlotCards?: (viz: Viz['reverse_plot'], ctx: FigureContext) => Raw | null;
  renderMatrixCards?: (viz: NonNullable<Viz['matrix']>, ctx: FigureContext) => Raw | null;
  renderTimelineCards?: (viz: NonNullable<Viz['timeline']>, ctx: FigureContext) => Raw | null;
}
interface FigureContext { tokens: DesignTokens; phases: PublicWork['phases']; workId: string }
export async function loadFigures(loader: () => Promise<FigureModule> = () => import('./figures/' + 'index.ts')): Promise<FigureModule | null> {
  try { return await loader(); } catch (e) {
    const error = e as NodeJS.ErrnoException & { url?: string };
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === new URL('./figures/index.ts', import.meta.url).href) return null;
    throw e;
  }
}
const FULL_LABEL = { relations: '関係図と一覧表で見る', reverse_plot: '木の図と一覧表で見る', matrix: 'マトリクス（表）で見る', timeline: '二つの時間軸の図で見る' } as const;
/**
 * Card view first (AMENDMENT 09: readable at 390px without horizontal scrolling or scaled-down drawings), then the
 * original figure + alternative table folded in `details.fig-more` ("図で見る"), which the CSS shows from the
 * tablet width up only. Without card views the figure is shown as before.
 */
export function figure(work: PublicWork, name: 'relations' | 'reverse_plot' | 'matrix' | 'timeline', tokens: DesignTokens, module: FigureModule | null): Raw {
  if (!module) return html`<p>この図は準備中です</p>`;
  const ctx = { tokens, phases: work.phases, workId: work.work.work_id };
  const v = work.viz;
  const rendered = name === 'relations' ? module.renderRelations(v.relations, ctx) : name === 'reverse_plot' ? module.renderReversePlot(v.reverse_plot, ctx) : name === 'matrix' ? v.matrix && module.renderMatrix(v.matrix, ctx) : v.timeline && module.renderTimeline?.(v.timeline, ctx);
  const cards = name === 'relations' ? module.renderRelationsCards?.(v.relations, ctx) : name === 'reverse_plot' ? module.renderReversePlotCards?.(v.reverse_plot, ctx) : name === 'matrix' ? v.matrix && module.renderMatrixCards?.(v.matrix, ctx) : v.timeline && module.renderTimelineCards?.(v.timeline, ctx);
  if (!cards) return rendered || html`<p>この図は情報不足のため未掲載</p>`;
  return html`${cards}${rendered ? html`<details class="fig-more"><summary>${FULL_LABEL[name]}（広い画面向け）</summary>${rendered}</details>` : null}`;
}
