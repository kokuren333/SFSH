import type { CatalogItem } from './public-types.ts';
export const axes = ['medium', 'genre', 'tag', 'status', 'decade', 'matrix'] as const;
export type Axis = typeof axes[number];
export type Filters = Partial<Record<Axis, string[]>>;
export function values(item: CatalogItem, axis: Axis): string[] {
  switch (axis) {
    case 'medium': return [item.medium];
    case 'genre': return item.genres;
    case 'tag': return item.tags;
    case 'status': return [item.status];
    case 'decade': return [item.first_release_year === null ? 'unknown' : String(Math.floor(item.first_release_year / 10) * 10)];
    case 'matrix': return [String(item.has_matrix)];
  }
}
export function filter(items: CatalogItem[], selected: Filters, exclude?: Axis): CatalogItem[] {
  return items.filter(item => axes.every(axis => axis === exclude || !selected[axis]?.length || selected[axis]!.some(v => values(item, axis).includes(v))));
}
export function facets(items: CatalogItem[], selected: Filters, universe = items): Record<Axis, { value: string; count: number; disabled: boolean }[]> {
  return Object.fromEntries(axes.map(axis => {
    const candidates = filter(items, selected, axis);
    return [axis, [...new Set(universe.flatMap(item => values(item, axis)))].sort().map(value => {
      const count = candidates.filter(item => values(item, axis).includes(value)).length;
      return { value, count, disabled: count === 0 };
    })];
  })) as ReturnType<typeof facets>;
}
export interface SearchState { q: string; sort: string; filters: Filters }
export function parseState(params: URLSearchParams): SearchState {
  return { q: params.get('q') || '', sort: ['title', 'added', 'updated'].includes(params.get('sort') || '') ? params.get('sort')! : 'title', filters: Object.fromEntries(axes.map(a => [a, [...new Set(params.getAll(a))].sort()])) };
}
export function stateParams(state: SearchState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.sort !== 'title') params.set('sort', state.sort);
  for (const axis of axes) for (const v of [...new Set(state.filters[axis] || [])].sort()) params.append(axis, v);
  return params;
}
