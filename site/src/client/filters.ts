import { axes, facets } from '../filter-core.ts';
import type { CatalogItem } from '../public-types.ts';
import type { Filters } from '../filter-core.ts';
export function selectedFilters(form: HTMLFormElement): Filters {
  // Disabled, checked zero-count options still form part of the URL selection.
  const inputs = [...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  return Object.fromEntries(axes.map(axis => [axis, inputs.filter(i => i.name === axis && i.checked).map(i => i.value)]));
}
export function restoreFilters(form: HTMLFormElement, selected: Filters): void {
  for (const input of form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) input.checked = !!selected[input.name as keyof Filters]?.includes(input.value);
}
export function updateFacets(form: HTMLFormElement, results: CatalogItem[], selected: Filters, universe: CatalogItem[]): void {
  const counts = facets(results, selected, universe);
  for (const axis of axes) for (const option of counts[axis]) {
    const input = [...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(i => i.name === axis && i.value === option.value);
    if (input) input.disabled = option.disabled;
    const count = [...form.querySelectorAll<HTMLElement>('[data-count]')].find(n => n.dataset.count === axis + ':' + option.value);
    if (count) count.textContent = String(option.count);
  }
}
