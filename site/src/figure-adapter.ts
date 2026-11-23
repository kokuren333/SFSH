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
  /** AMENDMENT 09 card views (shown after the figure on every width since A10). Optional: a module without them shows the figure only. */
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
const FIG_TITLE = { relations: '人物関係図', reverse_plot: 'リバースプロット（結末からさかのぼる木）', matrix: '情報の非対称性マトリクス', timeline: '起きた順と明かされる順（二重の時間軸）' } as const;
/**
 * BRIEF §14 図のルール (2026-11-23 11:54, AMENDMENT 10; REQUIREMENTS §6.4): the figure itself comes first and is
 * shown at every width — never hidden behind a "wide screens" fold. At 360/390px each figure has a phone form
 * that reads as a figure: A = the narrow SVG drawn for the 360px frame (scale ≥ 1, figure text ≥ font.size.small)
 * with the phase switch; B = the cause tree drawn as boxes and connectors (HTML, wraps instead of shrinking);
 * C = one small matrix per secret (rows = phases); timeline = the narrow SVG. Data tables stack into labelled
 * rows below the tablet width and sit behind a visible "一覧表で見る" entry. The AMENDMENT 09 card views follow
 * the figure as the supplementary reading (kept on every width).
 */
export function figure(work: PublicWork, name: 'relations' | 'reverse_plot' | 'matrix' | 'timeline', tokens: DesignTokens, module: FigureModule | null): Raw {
  if (!module) return html`<p>この図は準備中です</p>`;
  const ctx = { tokens, phases: work.phases, workId: work.work.work_id };
  const v = work.viz;
  const rendered = name === 'relations' ? module.renderRelations(v.relations, ctx) : name === 'reverse_plot' ? module.renderReversePlot(v.reverse_plot, ctx) : name === 'matrix' ? v.matrix && module.renderMatrix(v.matrix, ctx) : v.timeline && module.renderTimeline?.(v.timeline, ctx);
  const cards = name === 'relations' ? module.renderRelationsCards?.(v.relations, ctx) : name === 'reverse_plot' ? module.renderReversePlotCards?.(v.reverse_plot, ctx) : name === 'matrix' ? v.matrix && module.renderMatrixCards?.(v.matrix, ctx) : v.timeline && module.renderTimelineCards?.(v.timeline, ctx);
  if (!rendered && !cards) return html`<p>この図は情報不足のため未掲載</p>`;
  const id = `fig-${name.replace('_', '-')}`;
  return html`${rendered ? html`<section class="fig-main" aria-labelledby="${id}-h"><h2 class="fig-heading" id="${id}-h">図: ${FIG_TITLE[name]}</h2>${rendered}</section>` : null}${cards ? html`<div class="fig-cards">${cards}</div>` : null}`;
}
