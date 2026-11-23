/**
 * Figure A — dynamic relationship map (REQUIREMENTS §6.4, wp03 §6-4).
 *
 * - One force layout per width class (narrow / medium / wide) over the UNION of all phases' relations, so
 *   node positions never move when the phase changes. Nodes are drawn once, outside the phase groups; each
 *   phase gets `<g data-phase>` with only its edges and edge labels.
 * - Three static `<svg>` siblings per node set, shown/hidden by CSS media queries (no JS).
 * - Default: top 12 characters by prominence (narrow: 8); "全員を表示" checkbox + CSS :has() shows a second
 *   set laid out with everyone. The full set is always in the alternative tables.
 * - Changed relations (new / modified / ended vs the previous phase) get an accent underlay AND a text
 *   marker ("変化：…"). Polarity = token color + token dash + legend label.
 */
import type { PublicCharacter, PublicPhase, PublicRelation, Valence, VizRelations } from "../public-types.ts";
import type { DesignTokens } from "../design/tokens-types.ts";
import { type Raw, esc, raw } from "../html.ts";
import {
  type Box,
  type FigureContext,
  type WidthClass,
  byId,
  cmpStr,
  epHtml,
  fmt,
  inside,
  intervalLabel,
  phaseAttrs,
  phaseSwitch,
  sortedPhases,
  textWidth,
  truncate,
  truncateToWidth,
  widthClasses,
} from "./common.ts";
import { type GNode, layoutGraph, nodeBox } from "./layout.ts";

const SEED = 0x5f3759df;
const TICKS = 300;
/** Edge labels show at most this many characters (REQUIREMENTS §6.4: 10字以内). */
export const EDGE_LABEL_MAX = 10;
export const CHANGE_TEXT = { new: "変化：新規", changed: "変化：変更", ended: "変化：終了" } as const;
type Change = keyof typeof CHANGE_TEXT;

export interface NodeGeom {
  r: number;
  labelGap: number;
  lineH: number;
  f: number;
}

export function nodeGeom(t: DesignTokens): NodeGeom {
  const f = t.font.size.small;
  return { r: t.space.s, labelGap: t.space.xs, lineH: Math.ceil(f * 1.25), f };
}

/** Label box of a node label (text centered under the circle). Used by the renderer and the tests. */
export function nodeLabelBox(g: NodeGeom, x: number, y: number, label: string): Box {
  const w = textWidth(label, g.f);
  const y0 = y + g.r + g.labelGap;
  return { x0: x - w / 2, y0, x1: x + w / 2, y1: y0 + g.lineH };
}

export function nodeLabelMaxWidth(cls: WidthClass, f: number): number {
  return (cls.key === "narrow" ? 7 : 9) * f;
}

interface PhaseInfo {
  active: PublicRelation[];
  /** relation id → change kind for active relations. */
  change: Map<string, Change>;
  /** relations of the previous phase whose pair has no relation now. */
  ended: PublicRelation[];
}

function pairKey(r: PublicRelation): string {
  return `${r.from}\u0000${r.to}`;
}

function signature(rs: PublicRelation[]): string {
  return rs
    .map((r) => `${r.kind}\u0000${r.valence}`)
    .sort(cmpStr)
    .join("\u0001");
}

/** Phase index range [lo, hi] of a relation (unknown phase ids are treated as open ends). */
function range(r: PublicRelation, orderOf: Map<string, number>, n: number): [number, number] {
  const lo = r.phase_from !== null && orderOf.has(r.phase_from) ? orderOf.get(r.phase_from)! : 0;
  const hi = r.phase_to !== null && orderOf.has(r.phase_to) ? orderOf.get(r.phase_to)! : n - 1;
  return [lo, hi];
}

export function phaseInfos(rels: PublicRelation[], phases: PublicPhase[]): PhaseInfo[] {
  const orderOf = new Map(phases.map((p, i) => [p.id, i]));
  const infos: PhaseInfo[] = [];
  for (let i = 0; i < phases.length; i++) {
    const active = rels.filter((r) => {
      const [lo, hi] = range(r, orderOf, phases.length);
      return lo <= i && i <= hi;
    });
    const change = new Map<string, Change>();
    const ended: PublicRelation[] = [];
    if (i > 0) {
      const prev = infos[i - 1]!.active;
      const group = (rs: PublicRelation[]) => {
        const m = new Map<string, PublicRelation[]>();
        for (const r of rs) m.set(pairKey(r), [...(m.get(pairKey(r)) ?? []), r]);
        return m;
      };
      const pm = group(prev);
      const cm = group(active);
      for (const [k, rs] of cm) {
        const before = pm.get(k);
        if (!before) for (const r of rs) change.set(r.id, "new");
        else if (signature(before) !== signature(rs)) {
          const old = new Set(before.map((r) => `${r.kind}\u0000${r.valence}`));
          for (const r of rs) if (!old.has(`${r.kind}\u0000${r.valence}`)) change.set(r.id, "changed");
        }
      }
      for (const [k, rs] of pm) if (!cm.has(k)) ended.push(...rs);
    }
    infos.push({ active, change, ended });
  }
  return infos;
}

/** Curve offsets: relations sharing an unordered pair are fanned out (union-based → same in every phase). */
function pairOffsets(rels: PublicRelation[], step: number): Map<string, number> {
  const m = new Map<string, PublicRelation[]>();
  for (const r of rels) {
    const k = cmpStr(r.from, r.to) <= 0 ? `${r.from}\u0000${r.to}` : `${r.to}\u0000${r.from}`;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  const out = new Map<string, number>();
  for (const rs of m.values()) rs.forEach((r, k) => out.set(r.id, (k - (rs.length - 1) / 2) * step));
  return out;
}

interface Pt {
  x: number;
  y: number;
}

function curve(a: Pt, b: Pt, from: string, to: string, offset: number) {
  // Normal is oriented by the id-sorted pair so opposite-direction relations fan to opposite sides.
  const flip = cmpStr(from, to) > 0 ? -1 : 1;
  const dx = (b.x - a.x) * flip;
  const dy = (b.y - a.y) * flip;
  const len = Math.hypot(dx, dy) || 1;
  const c = { x: (a.x + b.x) / 2 + (-dy / len) * 2 * offset, y: (a.y + b.y) / 2 + (dx / len) * 2 * offset };
  const at = (t: number): Pt => ({
    x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x,
    y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y,
  });
  return { d: `M${fmt(a.x)} ${fmt(a.y)} Q${fmt(c.x)} ${fmt(c.y)} ${fmt(b.x)} ${fmt(b.y)}`, at };
}

const LABEL_T = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.12, 0.88];
/** Label shifts perpendicular to the edge, in label half-heights. */
const LABEL_SHIFT = [0, 1, -1, 2, -2, 3, -3];

function overlapArea(a: Box, b: Box, gap: number): number {
  const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + gap;
  const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + gap;
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

const CHANGE_RANK: Record<string, number> = { new: 0, changed: 0, ended: 1, none: 2 };

interface SvgInput {
  cls: WidthClass;
  set: "main" | "all";
  chars: PublicCharacter[];
  rels: PublicRelation[];
  phases: PublicPhase[];
  infos: PhaseInfo[];
  offsets: Map<string, number>;
  t: DesignTokens;
}

function renderSvg(p: SvgInput): string {
  const { cls, t, phases } = p;
  const g = nodeGeom(t);
  const f = g.f;
  const maxLW = nodeLabelMaxWidth(cls, f);
  const ids = new Set(p.chars.map((c) => c.id));
  const labels = new Map(p.chars.map((c) => [c.id, truncateToWidth(c.label, maxLW, f)]));
  const gnodes: GNode[] = p.chars.map((c) => {
    const lw = textWidth(labels.get(c.id)!, f);
    return { id: c.id, group: c.faction ?? "", halfW: Math.max(g.r, lw / 2) + 2, top: g.r + 2, bottom: g.r + g.labelGap + g.lineH + 2 };
  });
  const within = (r: PublicRelation) => ids.has(r.from) && ids.has(r.to);
  const pad = t.space.xs;
  const labelSize = (r: PublicRelation, change: Change | null) => {
    const lines = [truncate(r.kind, EDGE_LABEL_MAX)];
    if (change) lines.push(CHANGE_TEXT[change]);
    return { lines, w: Math.max(...lines.map((l) => textWidth(l, f))) + 2 * pad, h: lines.length * g.lineH + 2 * pad };
  };
  const phaseItems = p.infos.map((info) =>
    [
      ...info.active.filter(within).map((r) => ({ r, change: info.change.get(r.id) ?? null })),
      ...info.ended.filter(within).map((r) => ({ r, change: "ended" as Change })),
    ].sort((x, y) => CHANGE_RANK[x.change ?? "none"]! - CHANGE_RANK[y.change ?? "none"]! || cmpStr(x.r.id, y.r.id)),
  );
  const labelArea = Math.max(
    0,
    ...phaseItems.map((items) =>
      items.reduce((s, it) => {
        const z = labelSize(it.r, it.change);
        return s + z.w * z.h;
      }, 0),
    ),
  );
  const lay = layoutGraph(
    gnodes,
    p.rels.filter(within).map((r) => ({ source: r.from, target: r.to })),
    cls.frame,
    cls.aspect,
    { margin: t.space.s, gap: t.space.s, seed: SEED, ticks: TICKS, extraArea: labelArea },
  );
  const { W, H, pos } = lay;
  const nodeBoxes = gnodes.map((n) => nodeBox(n, pos.get(n.id)!.x, pos.get(n.id)!.y));
  const valAttr = (v: Valence) => {
    const dash = t.semantic.valence[v].dash;
    return dash && dash !== "none" ? ` stroke-dasharray="${esc(dash)}"` : "";
  };

  const groups: string[] = [];
  phases.forEach((ph, i) => {
    const items = phaseItems[i]!;
    const under: string[] = [];
    const edges: string[] = [];
    const labs: string[] = [];
    const placed: Box[] = [];
    for (const { r, change } of items) {
      const cv = curve(pos.get(r.from)!, pos.get(r.to)!, r.from, r.to, p.offsets.get(r.id) ?? 0);
      const chg = change ? ` data-change="${change}"` : "";
      if (change && change !== "ended") under.push(`<path class="fig-a__hl" data-rel="${esc(r.id)}" d="${cv.d}"/>`);
      const cls2 = change === "ended" ? "fig-a__edge fig-a__edge--ended" : `fig-a__edge fig-val--${r.valence}`;
      edges.push(`<path class="${cls2}" data-rel="${esc(r.id)}"${chg} d="${cv.d}"${valAttr(r.valence)}/>`);
      const { lines, w, h } = labelSize(r, change);
      const pa = pos.get(r.from)!;
      const pb = pos.get(r.to)!;
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
      const nx = -(pb.y - pa.y) / len;
      const ny = (pb.x - pa.x) / len;
      const step = h / 2 + 3;
      let box: Box | null = null;
      let best = Infinity;
      for (const tt of LABEL_T) {
        for (const k of LABEL_SHIFT) {
          const c = cv.at(tt);
          const cx = c.x + nx * step * k;
          const cy = c.y + ny * step * k;
          const b = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
          if (!inside(b, W, H)) continue;
          const score = nodeBoxes.reduce((s2, nb) => s2 + 3 * overlapArea(nb, b, 2), 0) + placed.reduce((s2, q) => s2 + overlapArea(q, b, 2), 0);
          if (score < best) {
            best = score;
            box = b;
          }
          if (best === 0) break;
        }
        if (best === 0) break;
      }
      if (!box) {
        const c = cv.at(0.5);
        const x0 = Math.min(Math.max(c.x - w / 2, 0), W - w);
        const y0 = Math.min(Math.max(c.y - h / 2, 0), H - h);
        box = { x0, y0, x1: x0 + w, y1: y0 + h };
      }
      placed.push(box);
      const cx = (box.x0 + box.x1) / 2;
      const texts = lines
        .map(
          (l, k) =>
            `<text class="${k === 0 ? "fig-a__kind" : "fig-a__chg"}" x="${fmt(cx)}" y="${fmt(box.y0 + pad + k * g.lineH + f * 0.95)}" text-anchor="middle">${esc(l)}</text>`,
        )
        .join("");
      labs.push(
        `<g class="fig-a__elabel${change ? " fig-a__elabel--changed" : ""}" data-rel="${esc(r.id)}"${chg}><rect x="${fmt(box.x0)}" y="${fmt(box.y0)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(Math.min(t.radius.control, h / 2))}"/>${texts}</g>`,
      );
    }
    groups.push(`<g ${phaseAttrs(phases, i)}>${under.join("")}${edges.join("")}${labs.join("")}</g>`);
  });

  const nodes = p.chars
    .map((c) => {
      const { x, y } = pos.get(c.id)!;
      const lab = labels.get(c.id)!;
      const title = lab !== c.label ? `<title>${esc(c.label)}</title>` : "";
      const lb = nodeLabelBox(g, x, y, lab);
      return `<g class="fig-a__node" data-id="${esc(c.id)}">${title}<circle class="fig-a__dot" cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(g.r)}"/><rect class="fig-a__nbg" x="${fmt(lb.x0)}" y="${fmt(lb.y0)}" width="${fmt(lb.x1 - lb.x0)}" height="${fmt(lb.y1 - lb.y0)}"/><text class="fig-a__nlabel" x="${fmt(x)}" y="${fmt(y + g.r + g.labelGap + f * 0.95)}" text-anchor="middle">${esc(lab)}</text></g>`;
    })
    .join("");
  const aria = `人物関係図（${cls.name}向けの配置、${p.chars.length}名）`;
  return `<svg class="fig-svg fig-a__svg fig-w--${cls.key}" viewBox="0 0 ${fmt(W)} ${fmt(H)}" data-wclass="${cls.key}" data-min-frame="${fmt(cls.frame)}" data-set="${p.set}" role="img" aria-label="${esc(aria)}"><g class="fig-a__phases">${groups.join("")}</g><g class="fig-a__nodes">${nodes}</g></svg>`;
}

function legend(t: DesignTokens): string {
  const sw = (cls: string, dash: string, hl = false) =>
    `<svg class="fig-legend__swatch" viewBox="0 0 40 16" aria-hidden="true">${hl ? `<path class="fig-a__hl" d="M2 8 L38 8"/>` : ""}<path class="${cls}" d="M2 8 L38 8"${dash && dash !== "none" ? ` stroke-dasharray="${esc(dash)}"` : ""}/></svg>`;
  const vals = (["positive", "negative", "ambivalent", "neutral"] as const)
    .map((v) => {
      const e = t.semantic.valence[v];
      return `<li class="fig-legend__item">${sw(`fig-a__edge fig-val--${v}`, e.dash)}<span>${esc(e.label)}</span></li>`;
    })
    .join("");
  const chg =
    `<li class="fig-legend__item">${sw("fig-a__edge fig-val--neutral", t.semantic.valence.neutral.dash, true)}<span>太い強調線と「変化：新規／変更」＝前のフェーズから新しく生じた・変わった関係</span></li>` +
    `<li class="fig-legend__item">${sw("fig-a__edge fig-a__edge--ended", "none")}<span>細い線と「変化：終了」＝このフェーズで終わった関係</span></li>`;
  return `<ul class="fig-legend" aria-label="凡例">${vals}${chg}</ul>`;
}

/** Faction display names from `viz.factions` (CP-026). An id without a published label is shown as unnamed, never as an invented name. */
export function factionNames(chars: PublicCharacter[], factions: VizRelations["factions"] | undefined): Map<string, string> {
  const labels = new Map((factions ?? []).filter((f) => f && f.id && f.label).map((f) => [f.id, f.label]));
  const m = new Map<string, string>();
  for (const id of new Set(chars.map((c) => c.faction).filter((f): f is string => !!f))) m.set(id, labels.get(id) ?? "所属あり（名称未掲載）");
  return m;
}

function altTables(
  t: DesignTokens,
  chars: PublicCharacter[],
  factions: VizRelations["factions"] | undefined,
  ranked: PublicCharacter[],
  rels: PublicRelation[],
  phases: PublicPhase[],
  infos: PhaseInfo[],
): string {
  const name = new Map(chars.map((c) => [c.id, c.label]));
  const fac = factionNames(chars, factions);
  const crow = ranked
    .map(
      (c, i) =>
        `<tr><th scope="row">${esc(c.label)}</th><td>${esc(c.faction ? fac.get(c.faction)! : "—")}</td><td>${i + 1}</td><td>${esc(c.summary ?? "—")}</td><td>${epHtml(t, c.epistemic)}</td><td>${esc(c.grade)}</td></tr>`,
    )
    .join("");
  const orderOf = new Map(phases.map((p, i) => [p.id, i]));
  const sortedRels = [...rels].sort((a, b) => {
    const [al, ah] = range(a, orderOf, phases.length);
    const [bl, bh] = range(b, orderOf, phases.length);
    return al - bl || ah - bh || cmpStr(a.id, b.id);
  });
  const rrow = sortedRels
    .map(
      (r) =>
        `<tr><td>${esc(name.get(r.from)!)}</td><td>${esc(name.get(r.to)!)}</td><td>${esc(r.kind)}</td><td>${esc(t.semantic.valence[r.valence].label)}</td><td>${esc(intervalLabel(phases, r.phase_from, r.phase_to))}</td><td>${esc(r.changed_by_label ?? "—")}</td><td>${epHtml(t, r.epistemic)}</td><td>${esc(r.grade)}</td></tr>`,
    )
    .join("");
  const changes = phases
    .map((ph, i) => {
      if (i === 0) return "";
      const info = infos[i]!;
      const items = [
        ...info.active.filter((r) => info.change.has(r.id)).map((r) => ({ r, c: info.change.get(r.id)! })),
        ...info.ended.map((r) => ({ r, c: "ended" as Change })),
      ];
      if (!items.length) return `<li><span class="fig-alt__ph">${esc(ph.label)}</span>：変化なし</li>`;
      const txt = items
        .map(({ r, c }) => `${CHANGE_TEXT[c].replace("変化：", "")} ${name.get(r.from)!}→${name.get(r.to)!}（${r.kind}）`)
        .join("、");
      return `<li><span class="fig-alt__ph">${esc(ph.label)}</span>：${esc(txt)}</li>`;
    })
    .join("");
  const changeList = phases.length > 1 ? `<p class="fig-alt__title">フェーズごとの関係の変化</p><ul class="fig-alt__list">${changes}</ul>` : "";
  return (
    `<div class="fig-alt" data-alt-for="relations">` +
    `<div class="fig-table-wrap"><table class="fig-table"><caption>関係の一覧（代替表示・全${rels.length}件）</caption><thead><tr><th scope="col">人物（から）</th><th scope="col">人物（へ）</th><th scope="col">関係</th><th scope="col">極性</th><th scope="col">期間</th><th scope="col">変化のきっかけ</th><th scope="col">認識区分</th><th scope="col">確度</th></tr></thead><tbody>${rrow}</tbody></table></div>` +
    changeList +
    `<div class="fig-table-wrap"><table class="fig-table"><caption>登場人物（全${chars.length}名・主要度順）</caption><thead><tr><th scope="col">人物</th><th scope="col">所属</th><th scope="col">主要度</th><th scope="col">説明</th><th scope="col">認識区分</th><th scope="col">確度</th></tr></thead><tbody>${crow}</tbody></table></div>` +
    `</div>`
  );
}

export function renderRelations(viz: VizRelations, ctx: FigureContext): Raw | null {
  const t = ctx.tokens;
  const phases = sortedPhases(ctx.phases);
  const seen = new Set<string>();
  const chars = [...viz.characters].sort(byId).filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  const ids = new Set(chars.map((c) => c.id));
  const relSeen = new Set<string>();
  const rels = [...viz.relations]
    .sort(byId)
    .filter((r) => ids.has(r.from) && ids.has(r.to) && r.from !== r.to && (relSeen.has(r.id) ? false : (relSeen.add(r.id), true)));
  if (chars.length === 0 || rels.length === 0) return null;

  const infos = phaseInfos(rels, phases);
  const offsets = pairOffsets(rels, Math.ceil(t.font.size.small * 1.6));
  const ranked = [...chars].sort((a, b) => a.prominence - b.prominence || cmpStr(a.id, b.id));
  const classes = widthClasses(t);
  const minDefault = Math.min(...classes.map((c) => c.defaultNodes));
  const maxDefault = Math.max(...classes.map((c) => c.defaultNodes));
  const hasToggle = chars.length > minDefault;
  const narrowOnly = chars.length <= maxDefault;

  const memo = new Map<string, string>();
  const svg = (cls: WidthClass, set: "main" | "all", subset: PublicCharacter[]) => {
    const sorted = [...subset].sort(byId);
    const key = `${cls.key}|${set}|${sorted.map((c) => c.id).join(",")}`;
    if (!memo.has(key)) memo.set(key, renderSvg({ cls, set, chars: sorted, rels, phases, infos, offsets, t }));
    return memo.get(key)!;
  };
  const mainSet = classes.map((c) => svg(c, "main", ranked.slice(0, c.defaultNodes))).join("");
  const allSet = hasToggle ? classes.map((c) => svg(c, "all", ranked)).join("") : "";

  const toggle = hasToggle
    ? `<label class="fig-toggle${narrowOnly ? " fig-toggle--narrow-only" : ""}"><input class="fig-a__all" type="checkbox"><span>全員を表示（全${chars.length}名）</span></label>`
    : "";
  const shown = hasToggle
    ? `既定では主要人物を表示しています（スマートフォンは${Math.min(minDefault, chars.length)}名、タブレット・PCは${Math.min(maxDefault, chars.length)}名）。`
    : "";
  const caption = `人物関係図。フェーズを切り替えると関係（線とラベル）だけが変わり、人物の位置は動きません。${shown}全員と全関係は図の直後の表にあります。`;

  const out =
    `<div class="fig-block fig-a fig-phased" data-fig="relations">` +
    `<div class="fig-controls">${phaseSwitch(phases, "fig-a-phase", "フェーズ")}${toggle}</div>` +
    `<figure class="fig-figure"><figcaption class="fig-caption">${esc(caption)}</figcaption>${legend(t)}` +
    `<div class="fig-a__set fig-a__set--main">${mainSet}</div>` +
    (hasToggle ? `<div class="fig-a__set fig-a__set--all">${allSet}</div>` : "") +
    `</figure>` +
    altTables(t, chars, viz.factions, ranked, rels, phases, infos) +
    `</div>`;
  return raw(out);
}
