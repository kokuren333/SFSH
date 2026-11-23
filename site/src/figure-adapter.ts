import { html } from './html.ts';
import type { Raw } from './html.ts';
import type { PublicWork } from './public-types.ts';
import type { DesignTokens } from './design/tokens-types.ts';
export interface FigureModule {
  renderRelations: (viz: PublicWork['viz']['relations'], ctx: FigureContext) => Raw | null;
  renderReversePlot: (viz: PublicWork['viz']['reverse_plot'], ctx: FigureContext) => Raw | null;
  renderMatrix: (viz: NonNullable<PublicWork['viz']['matrix']>, ctx: FigureContext) => Raw | null;
  renderTimeline?: (viz: NonNullable<PublicWork['viz']['timeline']>, ctx: FigureContext) => Raw | null;
}
interface FigureContext { tokens: DesignTokens; phases: PublicWork['phases']; workId: string }
export async function loadFigures(loader: () => Promise<FigureModule> = () => import('./figures/' + 'index.ts')): Promise<FigureModule | null> {
  try { return await loader(); } catch (e) {
    const error = e as NodeJS.ErrnoException & { url?: string };
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === new URL('./figures/index.ts', import.meta.url).href) return null;
    throw e;
  }
}
export function figure(work: PublicWork, name: 'relations' | 'reverse_plot' | 'matrix' | 'timeline', tokens: DesignTokens, module: FigureModule | null): Raw {
  if (!module) return html`<p>この図は準備中です</p>`;
  const ctx = { tokens, phases: work.phases, workId: work.work.work_id };
  const rendered = name === 'relations' ? module.renderRelations(work.viz.relations, ctx) : name === 'reverse_plot' ? module.renderReversePlot(work.viz.reverse_plot, ctx) : name === 'matrix' ? work.viz.matrix && module.renderMatrix(work.viz.matrix, ctx) : work.viz.timeline && module.renderTimeline?.(work.viz.timeline, ctx);
  return rendered || html`<p>この図は情報不足のため未掲載</p>`;
}
