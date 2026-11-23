import { parseState, stateParams } from '../filter-core.ts';
import type { SearchState } from '../filter-core.ts';
export const readState = (): SearchState => parseState(new URLSearchParams(location.search));
export function writeState(state: SearchState): void {
  const params = stateParams(state).toString();
  history.replaceState(null, '', location.pathname + (params ? '?' + params : '') + location.hash);
}
export function rootUrl(): URL {
  return new URL(document.querySelector<HTMLMetaElement>('meta[name="sfsh-root"]')?.content || './', location.href);
}
