import { compareReading } from '../search-core.ts';
import { readState, writeState } from './state.ts';
const select = document.querySelector<HTMLSelectElement>('#sort');
const container = document.querySelector<HTMLElement>('#work-index');
if (select && container) {
  const original = container.innerHTML;
  const render = () => {
    container.innerHTML = original;
    if (select.value !== 'title') {
      const rows = [...container.querySelectorAll<HTMLElement>('.work-row')];
      rows.sort((a, b) => {
        const key = select.value === 'added' ? 'added' : 'updated';
        return (b.dataset[key] || '').localeCompare(a.dataset[key] || '') || compareReading({ title: a.dataset.title!, title_reading: a.dataset.reading!, work_id: a.dataset.workId! }, { title: b.dataset.title!, title_reading: b.dataset.reading!, work_id: b.dataset.workId! });
      });
      const list = document.createElement('ol'); list.className = 'work-list'; list.append(...rows); container.replaceChildren(list);
    }
    const jumps = document.querySelector<HTMLElement>('.index-jumps'); if (jumps) jumps.hidden = select.value !== 'title';
    writeState({ ...readState(), sort: select.value });
  };
  select.value = readState().sort; render();
  select.addEventListener('change', render);
  window.addEventListener('popstate', () => { select.value = readState().sort; render(); });
}
