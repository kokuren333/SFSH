/**
 * Figures module (WP-2.3, logs/m2/PLAN.md §5). Pure build-time renderers: public viz data → escaped markup
 * (figure + legend + alternative table/list right after the figure). No fs, no network, deterministic.
 * Return null when there is nothing public to draw (the page then shows "情報不足のため未掲載").
 *
 * CSS: site/src/styles/figures.css. Client: site/src/client/phase.ts (?phase= reflection; optional).
 */
export type { FigureContext } from "./common.ts";
export { renderRelations } from "./relations.ts";
export { renderReversePlot } from "./reversePlot.ts";
export { renderMatrix } from "./matrix.ts";
export { renderTimeline } from "./timeline.ts";
export { renderRelationsCards, renderReversePlotCards, renderMatrixCards, renderTimelineCards } from "./cards.ts";
