/**
 * In-page measurement functions for page.evaluate(). Each function is self-contained (Playwright serialises the
 * function source), so helpers are nested inside.
 */

/** T1/T2: page-level horizontal overflow, scroll frames, text beyond the viewport, header control overlap. */
export function layoutProbe(frames: string[]) {
  const de = document.documentElement, body = document.body;
  const vw = de.clientWidth;
  const desc = (e: Element) => {
    let s = e.tagName.toLowerCase();
    if (e.id) s += '#' + e.id;
    const c = e.getAttribute('class');
    if (c) s += '.' + c.trim().split(/\s+/).join('.');
    const p = e.parentElement;
    return p && p !== body ? (p.getAttribute('class') ? '.' + p.getAttribute('class')!.trim().split(/\s+/)[0] + ' > ' : p.tagName.toLowerCase() + ' > ') + s : s;
  };
  const shown = (e: Element) => {
    if (!e.checkVisibility({ visibilityProperty: true }) || e.getClientRects().length === 0) return false;
    const s = getComputedStyle(e);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const frameSel = frames.join(',');
  const scrollers: { el: string; scrollWidth: number; clientWidth: number; overflowX: string; allowed: boolean }[] = [];
  for (const e of body.querySelectorAll('*')) {
    const s = getComputedStyle(e);
    if (e.scrollWidth > e.clientWidth + 1 && (s.overflowX === 'auto' || s.overflowX === 'scroll') && shown(e)) {
      scrollers.push({ el: desc(e), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, overflowX: s.overflowX, allowed: e.matches(frameSel) });
    }
  }
  // Frames that exist at this width: they must be scrollable containers (overflow-x auto|scroll).
  const frameStyles = [...document.querySelectorAll(frameSel)].filter(shown).map((e) => ({ el: desc(e), overflowX: getComputedStyle(e).overflowX }));
  const textOut: { el: string; text: string; left: number; right: number }[] = [];
  const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = w.nextNode())) {
    const t = n.textContent || '';
    if (!t.trim()) continue;
    const el = n.parentElement;
    if (!el || !shown(el) || (frameSel && el.closest(frameSel))) continue;
    if (el.closest('script,style,noscript,title')) continue;
    const r = document.createRange();
    r.selectNodeContents(n);
    for (const b of r.getClientRects()) {
      if (b.width === 0 || b.height === 0) continue;
      const left = b.left + scrollX, right = b.right + scrollX;
      if (right > vw + 0.5 || left < -0.5) { textOut.push({ el: desc(el), text: t.trim().slice(0, 40), left: Math.round(left * 10) / 10, right: Math.round(right * 10) / 10 }); break; }
    }
  }
  // Header controls must not overlap each other.
  const header = document.querySelector('.site-header');
  const ctrls = header ? [...header.querySelectorAll('a, button, summary, input:not([type=hidden]), select, label')].filter(shown) : [];
  const overlaps: { a: string; b: string; w: number; h: number }[] = [];
  for (let i = 0; i < ctrls.length; i++) for (let j = i + 1; j < ctrls.length; j++) {
    const a = ctrls[i]!, b = ctrls[j]!;
    if (a.contains(b) || b.contains(a)) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const ow = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const oh = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (ow > 0.5 && oh > 0.5) overlaps.push({ a: desc(a), b: desc(b), w: Math.round(ow * 10) / 10, h: Math.round(oh * 10) / 10 });
  }
  return {
    viewport: vw,
    doc: { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, overflowX: getComputedStyle(de).overflowX },
    body: { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth, overflowX: getComputedStyle(body).overflowX },
    scrollX: (() => { const x0 = scrollX; scrollTo(10000, scrollY); const x = scrollX; scrollTo(x0, scrollY); return x; })(),
    scrollers, frameStyles, textOut, overlaps,
  };
}

/** T3: effective values at the current width (body text, figure text, tap targets and gaps). */
export function effectiveProbe() {
  const body = document.body;
  const desc = (e: Element) => {
    let s = e.tagName.toLowerCase();
    if (e.id) s += '#' + e.id;
    const c = e.getAttribute('class');
    if (c) s += '.' + c.trim().split(/\s+/).join('.');
    const p = e.parentElement;
    return p && p !== body ? (p.getAttribute('class') ? '.' + p.getAttribute('class')!.trim().split(/\s+/)[0] + ' > ' : p.tagName.toLowerCase() + ' > ') + s : s;
  };
  const shown = (e: Element) => {
    if (!e.checkVisibility({ visibilityProperty: true }) || e.getClientRects().length === 0) return false;
    const r = e.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(e);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const ownText = (e: Element) => [...e.childNodes].some((c) => c.nodeType === 3 && (c.textContent || '').trim() !== '');
  const anyText = (e: Element) => (e.textContent || '').trim() !== '';
  const FIG = '.fig-block';
  const r1 = (x: number) => Math.round(x * 100) / 100;

  // Body text: p, li, td, dd in main outside figure blocks and legends. Orchestrator decision (CP-027):
  // legends (the epistemic legend on work pages, figure legends) are figure-related text and follow the
  // ≥13px figure-text rule (measured in figText below), not the 16px body rule.
  const LEGEND = '.legend';
  const bodyText: { el: string; size: number; text: string }[] = [];
  for (const e of document.querySelectorAll('main p, main li, main td, main dd')) {
    if (e.closest(FIG) || e.closest(LEGEND) || !shown(e) || !anyText(e)) continue;
    bodyText.push({ el: desc(e), size: parseFloat(getComputedStyle(e).fontSize), text: (e.textContent || '').trim().slice(0, 30) });
  }
  // Informational: any other visible text in main outside figures (spans, headings, nav).
  const auxText: { el: string; size: number; text: string }[] = [];
  for (const e of document.querySelectorAll('main *')) {
    if (e.closest(FIG) || !ownText(e) || !shown(e)) continue;
    const size = parseFloat(getComputedStyle(e).fontSize);
    if (size < 16) auxText.push({ el: desc(e), size, text: (e.textContent || '').trim().slice(0, 30) });
  }
  // Figure text: SVG text rendered size and HTML text inside figure blocks.
  const figText: { el: string; size: number; computed: number; scale: number; svg: boolean; text: string }[] = [];
  for (const e of document.querySelectorAll(FIG + ' *, main ' + LEGEND + ' *')) {
    if (!ownText(e) || !shown(e)) continue;
    const computed = parseFloat(getComputedStyle(e).fontSize);
    let scale = 1;
    const svg = e instanceof SVGElement ? (e as SVGElement).ownerSVGElement : null;
    if (svg) {
      const vb = svg.viewBox.baseVal;
      if (vb && vb.width > 0) scale = svg.getBoundingClientRect().width / vb.width;
    }
    figText.push({ el: desc(e), size: r1(computed * scale), computed, scale: r1(scale), svg: !!svg, text: (e.textContent || '').trim().slice(0, 30) });
  }

  // Tap targets.
  const scopes: [string, string][] = [
    ['header', '.site-header'],
    ['nav', 'nav'],
    ['figure-controls', '.fig-controls, .fig-toggle, .fig-block summary'],
    ['filter-controls', '#search-filters, .sort-control'],
  ];
  const CAND = 'a, button, summary, select, input[type=search], label[for], label:has(> input[type=radio]), label:has(> input[type=checkbox]), input[type=radio] + label, input[type=checkbox] + label';
  type T = { el: Element; group: string; scope: string };
  const targets: T[] = [];
  const excluded: { el: string; rule: string }[] = [];
  const seen = new Set<Element>();
  for (const [scope, sel] of scopes) {
    for (const root of document.querySelectorAll(sel)) {
      if (scope === 'nav' && root.closest('.site-header')) continue; // header nav belongs to header group
      const cands = root.matches(CAND) ? [root, ...root.querySelectorAll(CAND)] : [...root.querySelectorAll(CAND)];
      for (const e of cands) {
        if (seen.has(e) || !shown(e)) continue;
        if (e.tagName === 'A' && e.closest('p')) { seen.add(e); excluded.push({ el: desc(e), rule: 'inline text link inside <p>' }); continue; }
        if (e.tagName === 'LABEL' && e.getAttribute('for')) {
          const ctl = document.getElementById(e.getAttribute('for')!) as HTMLInputElement | null;
          if (!ctl || !(ctl.tagName === 'INPUT' && (ctl.type === 'radio' || ctl.type === 'checkbox'))) {
            seen.add(e); excluded.push({ el: desc(e), rule: 'caption label of a text/search/select control (the control itself is measured)' }); continue;
          }
        }
        seen.add(e);
        // group = the control group root: header, the nav, the fieldset/form, or the figure block's controls
        const g = e.closest('.site-header') || e.closest('fieldset') || e.closest('nav') || e.closest('.fig-controls, .fig-block') || e.closest('form, .sort-control') || root;
        targets.push({ el: e, group: desc(g) + '#' + [...document.querySelectorAll('*')].indexOf(g), scope });
      }
    }
  }
  // drop targets nested inside another target (e.g. input inside a label)
  const flat = targets.filter((t) => !targets.some((o) => o !== t && o.el.contains(t.el)));
  const tap = flat.map((t) => {
    const r = t.el.getBoundingClientRect();
    return { el: desc(t.el), scope: t.scope, group: t.group.replace(/#\d+$/, ''), groupKey: t.group, w: r1(r.width), h: r1(r.height), rect: [r.left, r.top, r.right, r.bottom], text: (t.el.textContent || (t.el as HTMLInputElement).value || '').trim().slice(0, 20) };
  });
  const gaps: { el: string; nearest: string; gap: number; group: string }[] = [];
  for (const a of tap) {
    let best = Infinity, bestEl = '';
    for (const b of tap) {
      if (a === b || a.groupKey !== b.groupKey) continue;
      const dx = Math.max(0, Math.max(a.rect[0]!, b.rect[0]!) - Math.min(a.rect[2]!, b.rect[2]!));
      const dy = Math.max(0, Math.max(a.rect[1]!, b.rect[1]!) - Math.min(a.rect[3]!, b.rect[3]!));
      const ox = Math.min(a.rect[2]!, b.rect[2]!) - Math.max(a.rect[0]!, b.rect[0]!);
      const oy = Math.min(a.rect[3]!, b.rect[3]!) - Math.max(a.rect[1]!, b.rect[1]!);
      const d = ox > 0 && oy > 0 ? -Math.min(ox, oy) : Math.hypot(dx, dy);
      if (d < best) { best = d; bestEl = b.el; }
    }
    if (best !== Infinity) gaps.push({ el: a.el, nearest: bestEl, gap: r1(best), group: a.group });
  }
  return { bodyText, auxText, figText, tap: tap.map(({ rect, groupKey, ...rest }) => rest), gaps, excluded };
}

/** T12: distinct chromatic colours of rendered elements. */
export function colorProbe() {
  const shown = (e: Element) => {
    if (!e.checkVisibility({ visibilityProperty: true }) || e.getClientRects().length === 0) return false;
    const s = getComputedStyle(e);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) > 0;
  };
  const parse = (c: string): [number, number, number, number] | null => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0]!, p[1]!, p[2]!, p[3] === undefined ? 1 : p[3]!];
  };
  const found = new Map<string, Set<string>>();
  const add = (c: string, where: string) => {
    const v = parse(c);
    if (!v || v[3] === 0) return;
    // composite translucent colours over white
    const rgb = v.slice(0, 3).map((x) => Math.round(x * v[3] + 255 * (1 - v[3])));
    if (Math.max(...rgb) - Math.min(...rgb) <= 12) return;
    const key = `rgb(${rgb.join(', ')})`;
    if (!found.has(key)) found.set(key, new Set());
    if (found.get(key)!.size < 4) found.get(key)!.add(where);
  };
  const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan']);
  for (const e of document.body.querySelectorAll('*')) {
    if (!shown(e)) continue;
    const s = getComputedStyle(e);
    const tag = e.tagName.toLowerCase();
    const where = tag + (e.getAttribute('class') ? '.' + e.getAttribute('class')!.trim().split(/\s+/)[0] : '');
    const ownText = [...e.childNodes].some((c) => c.nodeType === 3 && (c.textContent || '').trim() !== '');
    if (ownText || tag === 'input' || tag === 'select' || tag === 'button') add(s.color, where + ':color');
    add(s.backgroundColor, where + ':background');
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      if (parseFloat((s as any)[`border${side}Width`]) > 0 && (s as any)[`border${side}Style`] !== 'none') add((s as any)[`border${side}Color`], where + ':border');
    }
    if (parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== 'none') add(s.outlineColor, where + ':outline');
    if (e instanceof SVGElement && SHAPES.has(tag)) {
      if (s.fill !== 'none') add(s.fill, where + ':fill');
      if (s.stroke !== 'none' && parseFloat(s.strokeWidth) > 0) add(s.stroke, where + ':stroke');
    }
    if ((e as HTMLInputElement).checked && (tag === 'input') && s.accentColor !== 'auto') add(s.accentColor, where + ':accent-color');
  }
  return [...found.entries()].map(([color, where]) => ({ color, where: [...where] }));
}

/** T4/T8/T11: state of the visible figure-A SVG(s). */
export function readFigA() {
  const shown = (e: Element) => e.checkVisibility({ visibilityProperty: true }) && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const block = document.querySelector('.fig-a');
  if (!block) return null;
  const checked = block.querySelector<HTMLInputElement>('.fig-phase-radio:checked');
  const svgs = [...block.querySelectorAll<SVGSVGElement>('svg.fig-a__svg')].filter(shown);
  return {
    checkedPi: checked?.dataset.pi ?? null,
    checkedValue: checked?.value ?? null,
    svgs: svgs.map((svg) => {
      const sr = svg.getBoundingClientRect();
      const groups = [...svg.querySelectorAll<SVGGElement>('.fig-ph')];
      const vis = groups.filter((g) => getComputedStyle(g).display !== 'none');
      const staticSig: Record<string, string> = {};
      for (const g of groups) staticSig[g.dataset.pi || g.dataset.phase || '?'] = [...g.querySelectorAll('path.fig-a__edge')].map((p) => p.getAttribute('data-rel') + '|' + p.getAttribute('class') + '|' + p.getAttribute('d')).sort().join(';');
      return {
        wclass: svg.dataset.wclass, set: svg.dataset.set,
        renderedWidth: Math.round(sr.width * 100) / 100,
        nodes: [...svg.querySelectorAll<SVGGElement>('.fig-a__node')].filter(shown).map((g) => {
          const c = g.querySelector('circle');
          const r = (c || g).getBoundingClientRect();
          return { id: g.dataset.id, cx: c?.getAttribute('cx') ?? null, cy: c?.getAttribute('cy') ?? null, transform: g.getAttribute('transform'), x: Math.round((r.left - sr.left) * 100) / 100, y: Math.round((r.top - sr.top) * 100) / 100 };
        }).sort((a, b) => String(a.id).localeCompare(String(b.id))),
        visiblePi: [...new Set(vis.map((g) => g.dataset.pi))],
        edges: vis.flatMap((g) => [...g.querySelectorAll('path.fig-a__edge')].filter(shown).map((p) => p.getAttribute('data-rel') + '|' + p.getAttribute('class') + '|' + p.getAttribute('d'))).sort(),
        staticSig,
      };
    }),
  };
}
