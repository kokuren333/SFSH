/**
 * AMENDMENT 15: the `conform` stage — after S4 autocheck, before the build / publish.
 *
 *  1. Evaluate the requirement items (check/conformance.ts) on gen/public.json against the previous published version.
 *  2. While an `enforce` item is short and its repair budget (repair_max) is not used up, re-run ONLY the part that is
 *     short, with shape-only hints (counts / presence — never an angle or a wording, P-1), then evaluate again:
 *       synopsis  write (synopsis part only, re-planned from the chapter plan) → compose → autocheck
 *       refact    fact layer rebuilt with raised event minimums → interp → assemble → check → project → write → compose → autocheck
 *       interp    interp layer with the missing figure / counts → assemble → check → project → write → compose → autocheck
 *       gapfill   targeted research inside the job budget (40 / 60) and the 30-minute research wall clock → refact chain
 *     A shortfall that would need research outside the wall clock / budget is recorded as unrepairable (never raised).
 *     `sfsh regen` (saved research only) can repair the synopsis only; deeper repairs are recorded as unrepairable there.
 *  3. Still short after the repairs → "built, publish held": the candidate goes to gen/public.held.json, gen/public.json
 *     keeps the previous published version (absent for a new work), work.json conformance_hold, a ledger line and the
 *     completion notice carry the shortfall. `sfsh release <work_id>` publishes the held candidate by hand.
 *  Warn items are recorded and published. The rights item (A-1 / A-2) is always enforce and is never "repaired" here
 *  (autocheck fixes it; a residual is an implementation bug there).
 *
 * The stage works per job (A13 parallel jobs each run their own); the build and the publish lane stay serialized.
 */
import path from "node:path";
import fs from "node:fs";
import type { PublicWork } from "../../../site/src/public-types.ts";
import { isoLocal } from "../model/callLog.ts";
import {
  appendConformanceLedger,
  blockingOf,
  clearHold,
  conformanceNotice,
  currentFactCoverageOf,
  evaluateConformance,
  holdCandidate,
  loadConformanceConfig,
  outcomeOf,
  readBaseline,
  readReport,
  writeReport,
  type ConformanceItem,
  type ConformanceReport,
  type ItemResult,
  type RepairAction,
  type RepairRun,
} from "../check/conformance.ts";
import { allowance, FRAMES, wallLeftMs } from "../research/frames.ts";
import { TARGETED } from "../research/targeted.ts";
import { COVERAGE_GOALS } from "../research/coverage.ts";
import type { RepairHints, StageContext, StageResult } from "./context.ts";

export type ConformScope = "job" | "regen";
/** Runs one pipeline stage by name with the given context (the runner / regen supply their own stage table). */
export type StageRunFn = (name: string, ctx: StageContext) => Promise<StageResult>;

/** Stage chains of the repairs (pipeline order; `tags` is not re-run — the tag file stays valid for the projection). */
export const REPAIR_CHAINS: Record<RepairAction, string[]> = {
  synopsis: ["write", "compose", "autocheck"],
  refact: ["refact", "interp", "assemble", "check", "project", "write", "compose", "autocheck"],
  interp: ["interp", "assemble", "check", "project", "write", "compose", "autocheck"],
  gapfill: ["gapfill", "refact", "interp", "assemble", "check", "project", "write", "compose", "autocheck"],
};
const ACTION_ORDER: RepairAction[] = ["gapfill", "refact", "interp", "synopsis"];

function readPublic(workDir: string): PublicWork {
  const f = path.join(workDir, "gen", "public.json");
  if (!fs.existsSync(f)) throw new Error("conform: gen/public.json missing — run compose / autocheck first");
  return JSON.parse(fs.readFileSync(f, "utf8")) as PublicWork;
}

/** Can this scope / budget run the action now? null = yes, else the reason it cannot. */
export function whyNot(action: RepairAction, scope: ConformScope, ctx: StageContext): string | null {
  if (scope === "regen" && action !== "synopsis") return `sfsh regen は保存済みの NKG からの書き直しだけ（${action} は job resume で行う）`;
  if (action === "gapfill") {
    const left = wallLeftMs(ctx.budget, ctx.now());
    if (left < TARGETED.gapfillWallMinMs) return `追加調査には研究の壁時計 30 分の内側が要る（残り ${Math.max(0, Math.round(left / 1000))} 秒）`;
    const a = allowance(ctx.budget, (ctx.frames ?? FRAMES).gapfill.cap, (ctx.frames ?? FRAMES).gapfill.reserve);
    if (a.searches < TARGETED.searchesPerTarget || a.fetches <= 0) return `予算の残り不足（検索 ${a.searches}・取得 ${a.fetches}、上限 ${ctx.budget.limits.searches}／${ctx.budget.limits.fetches} は変えない）`;
  }
  return null;
}

/** The action for one item at its attempt k (0-based): the synopsis escalates to more fact-layer material in a job. */
function actionsFor(it: ItemResult, k: number, scope: ConformScope): RepairAction[] {
  if (it.item === "synopsis_chars" && k >= 1 && scope === "job") return ["refact"];
  return it.actions;
}

/** Shape-only hints for the chosen action. */
export function buildHints(action: RepairAction, attempt: number, items: ItemResult[], workDir: string, pw: PublicWork): RepairHints {
  const h: RepairHints = { attempt };
  const syn = items.find((i) => i.item === "synopsis_chars" && i.status === "shortfall");
  const reg = items.find((i) => i.item === "regression" && i.status === "shortfall");
  const fig = items.find((i) => i.item === "figures" && i.status === "shortfall");
  const cov = items.find((i) => i.item === "coverage" && i.status === "shortfall");
  const deltas = ((reg?.measured.kind_deltas ?? {}) as Record<string, { before: number; after: number }>);
  const dropNotes = (kinds: readonly string[]) =>
    Object.entries(deltas)
      .filter(([k, d]) => kinds.includes(k) && d.after < d.before)
      .map(([k, d]) => `前の公開版では ${k} が ${d.before} 件あった（今回 ${d.after}）。claim に根拠のある範囲で、これを下回らないように要素を起こす。`);
  if (action === "synopsis") {
    const target = ((syn?.measured.target as [number, number] | undefined) ?? [8000, 10000]) as [number, number];
    const prev = Number(syn?.measured.chars ?? 0);
    const cited = new Set((pw.pages.synopsis ? [...pw.pages.synopsis.intro, ...pw.pages.synopsis.chapters.flatMap((c) => c.blocks)] : []).flatMap((b) => b.based_on));
    const unassigned = pw.elements.events.filter((e) => !cited.has(e.id)).map((e) => e.id);
    h.synopsis = {
      previousChars: prev,
      target,
      unassignedEventIds: unassigned,
      notes: [
        `前回の版は ${prev}字で、規模別の目安 ${target[0]}〜${target[1]}字の下限に届かなかった（形の要件。語り方・視点は変えなくてよい）。`,
        unassigned.length ? `前回どの節からも根拠として参照されなかった出来事: ${unassigned.join(", ")}。これらも章に割り当てて語る。` : "素材の出来事はすべて参照されていた。各出来事の前提・動機・結果・次へのつながりを省略せずに語る。",
        "素材にない出来事・細部・台詞を足して字数を埋めることはしない（不足は素材の範囲で、説明の省略を減らして埋める）。",
      ],
    };
  }
  if (action === "refact" || action === "gapfill") {
    const fact = currentFactCoverageOf(workDir);
    const phases = fact?.phases.length ?? pw.phases.length;
    const cur = fact?.events ?? pw.elements.events.length;
    const baseEvents = deltas.events?.before ?? 0;
    const minEvents = Math.max(Math.ceil(cur * 1.3), phases * COVERAGE_GOALS.factEventsPerPhase, baseEvents, cur + 3);
    const notes = [
      ...(syn ? [`あらすじ（規模別の目安 ${(syn.measured.target as number[] | undefined)?.join("〜") ?? "?"}字）の素材として、出来事の粒度を細かくする: 1 つの出来事に複数の転換をまとめない。`] : []),
      ...(cov ? cov.shortfalls.map((s) => `${s}。claim に根拠がある範囲で、この区間・人物の出来事を起こす。`) : []),
      ...(fig && fig.shortfalls.some((s) => /関係図|マトリクス|年表/.test(s)) ? fig.shortfalls.filter((s) => /関係図|マトリクス|年表/.test(s)).map((s) => `${s}（Character／Relation／Secret／Knows／順序つき Event を claim の根拠の範囲で起こす）`) : []),
      ...dropNotes(["characters", "relations", "factions", "events", "matrix_secrets", "world_rules", "setups", "contexts", "timeline_events"]),
    ];
    h.fact = { minEvents, minEventsPerPhase: COVERAGE_GOALS.factEventsPerPhase, minEventsLastPhase: COVERAGE_GOALS.factEventsLastPhase, notes };
  }
  if (action === "interp" || action === "refact" || action === "gapfill") {
    const notes = [
      ...(fig && fig.shortfalls.some((s) => /逆算図/.test(s)) ? ["逆算図（M02）: 物語の結末（Outcome）を少なくとも 1 つ、その直接の原因（Why）と Explains でつないで起こす（どの結末を選び、どう説明するかは自由）。"] : []),
      ...(reg && Array.isArray(reg.measured.figures_lost) && (reg.measured.figures_lost as string[]).includes("reverse_plot") ? ["前の公開版には逆算図があった: Outcome と直接の原因を起こす。"] : []),
      ...dropNotes(["plot_nodes", "trees", "motives", "arcs", "themes", "emotion_beats", "iconic", "interpretations", "quiz"]),
    ];
    if (notes.length) h.interp = { notes };
  }
  return h;
}

export interface ConformOptions {
  scope: ConformScope;
  run: StageRunFn;
}

export async function runConform(ctx: StageContext, opts: ConformOptions): Promise<StageResult> {
  const cfg = loadConformanceConfig();
  const baseline = readBaseline(ctx.workDir);
  const t0 = Date.now();
  const evalNow = () => evaluateConformance({ workDir: ctx.workDir, candidate: readPublic(ctx.workDir), candidateKind: "public", baseline, cfg, rightsFromReport: true });

  // A retried stage continues the attempt count of the same job (no extra repairs on a retry).
  const prev = readReport(ctx.workDir);
  const resumed = prev && prev.job_id === ctx.jobId && prev.outcome === "in_progress" ? prev : null;
  const attempts: Partial<Record<ConformanceItem, number>> = { ...(resumed?.repair_attempts ?? {}) };
  const repairs: RepairRun[] = [...(resumed?.repairs ?? [])];
  const unrepairable = new Map<ConformanceItem, string>();
  let ev = evalNow();
  const initial = resumed?.initial ?? ev.items;
  const warnings: string[] = [];
  const report = (outcome: ConformanceReport["outcome"]): ConformanceReport => {
    const r: ConformanceReport = {
      schema: "sfsh-conformance/1",
      work_id: ctx.workId,
      job_id: ctx.jobId,
      scope: opts.scope,
      checked_at: isoLocal(ctx.now()),
      config: cfg,
      candidate: { kind: "public", source: "gen/public.json" },
      baseline: baseline ? { source: baseline.source, release_id: baseline.release_id, saved_at: baseline.saved_at } : null,
      initial,
      items: ev.items,
      shape: { candidate: ev.shape, baseline: ev.baseline_shape },
      repairs,
      repair_attempts: attempts,
      unrepairable: [...unrepairable].map(([item, reason]) => ({ item, reason })),
      outcome,
      blocking: outcome === "held" ? blockingOf(ev.items).map((i) => i.item) : [],
      notice: [],
    };
    r.notice = conformanceNotice(r);
    return r;
  };

  for (let guard = 0; guard < 12; guard++) {
    const blocking = blockingOf(ev.items);
    if (!blocking.length) break;
    // pick the repairable blocking items and the earliest action among them
    const want = new Map<RepairAction, ConformanceItem[]>();
    for (const it of blocking) {
      const k = attempts[it.item] ?? 0;
      if (k >= cfg.items[it.item].repair_max) {
        if (!unrepairable.has(it.item)) unrepairable.set(it.item, `修復の上限 ${cfg.items[it.item].repair_max} 回に達した`);
        continue;
      }
      const acts = actionsFor(it, k, opts.scope);
      if (!acts.length) {
        unrepairable.set(it.item, it.item === "rights" ? "A-1／A-2 の残りは autocheck の実装不具合（修復の対象外）" : "この不足に対応する修復がない");
        continue;
      }
      const ok = acts.find((a) => whyNot(a, opts.scope, ctx) === null);
      if (!ok) {
        unrepairable.set(it.item, acts.map((a) => whyNot(a, opts.scope, ctx)!).join("／"));
        continue;
      }
      unrepairable.delete(it.item);
      want.set(ok, [...(want.get(ok) ?? []), it.item]);
    }
    if (!want.size) break;
    const action = ACTION_ORDER.find((a) => want.has(a))!;
    // every repairable blocking item is re-measured after the chain, so all of them use up one attempt
    const covered = [...want.values()].flat();
    const attempt = repairs.length + 1;
    const hints = buildHints(action, attempt, ev.items, ctx.workDir, readPublic(ctx.workDir));
    const rctx: StageContext = { ...ctx, repair: hints, ...(action === "synopsis" ? { writeParts: ["synopsis"] as const } : {}) };
    const run: RepairRun = { attempt, action, items: covered, hints, started_at: isoLocal(ctx.now()), finished_at: "", duration_ms: 0, stages: [], ok: true };
    ctx.log(`conform: repair ${attempt} action=${action} items=${covered.join(",")} chain=${REPAIR_CHAINS[action].join("→")}`);
    const r0 = Date.now();
    for (const name of REPAIR_CHAINS[action]) {
      const s0 = Date.now();
      try {
        const r = await opts.run(name, rctx);
        run.stages.push({ stage: name, ok: true, duration_ms: Date.now() - s0, metrics: pickMetrics(r.metrics) });
        warnings.push(...r.warnings.slice(0, 3).map((w) => `conform repair ${attempt} ${name}: ${w}`));
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        run.stages.push({ stage: name, ok: false, duration_ms: Date.now() - s0, error: msg });
        run.ok = false;
        warnings.push(`conform repair ${attempt} ${name} failed: ${msg}`);
        ctx.log(`conform: repair ${attempt} stage ${name} failed: ${msg}`);
        break;
      }
    }
    run.finished_at = isoLocal(ctx.now());
    run.duration_ms = Date.now() - r0;
    repairs.push(run);
    for (const it of covered) attempts[it] = (attempts[it] ?? 0) + 1;
    ev = evalNow();
    writeReport(ctx.workDir, report("in_progress"));
    ctx.log(`conform: after repair ${attempt}: ${ev.items.filter((i) => i.status === "shortfall").map((i) => `${i.item}(${i.mode})`).join(",") || "no shortfall"}`);
  }

  const outcome = outcomeOf(ev.items);
  // blocking items left without a recorded reason (loop guard) get one
  for (const it of blockingOf(ev.items)) if (!unrepairable.has(it.item)) unrepairable.set(it.item, `修復の上限 ${cfg.items[it.item].repair_max} 回に達した`);
  for (const k of [...unrepairable.keys()]) if (!blockingOf(ev.items).some((i) => i.item === k)) unrepairable.delete(k);
  const final = report(outcome);
  const outputs = [writeReport(ctx.workDir, final)];
  const now = ctx.now();
  if (outcome === "held") {
    const hold = holdCandidate(ctx.workDir, final, now);
    outputs.push("gen/public.held.json", "work.json");
    warnings.push(`conform: publish held (${final.blocking.join(", ")}): gen/public.json = ${hold.public_json}; release with sfsh release ${ctx.workId}`);
  } else if (clearHold(ctx.workDir, ctx.jobId, now)) warnings.push("conform: an earlier conformance hold of this work was cleared (this run conforms)");
  if (outcome !== "pass") appendConformanceLedger(final, now);
  ctx.log(`conform: outcome=${outcome} repairs=${repairs.length} ${final.notice[0] ?? ""}`);
  const metrics: Record<string, number | string> = {
    outcome,
    repairs: repairs.length,
    repair_actions: repairs.map((r) => r.action).join(",") || "none",
    blocking: final.blocking.join(",") || "none",
    shortfalls: ev.items.filter((i) => i.status === "shortfall").map((i) => i.item).join(",") || "none",
    elements: ev.shape.elements,
    baseline_elements: ev.baseline_shape?.elements ?? "n/a",
    synopsis_chars: ev.shape.synopsis?.chars ?? 0,
    duration_s: Math.round((Date.now() - t0) / 1000),
  };
  for (const it of ev.items) metrics[`item_${it.item}`] = `${it.mode}:${it.status}`;
  return { outputs, metrics, warnings: [...final.notice, ...warnings].slice(0, 50) };
}

function pickMetrics(m: Record<string, number | string>): Record<string, number | string> {
  const keep = ["synopsis_chars", "synopsis_chapters", "elements_included", "events", "trees", "characters", "relations", "rebuilt", "fact_events", "new_active_after_review", "stopped", "a1_detected", "residual", "nodes", "edges"];
  const out: Record<string, number | string> = {};
  for (const k of keep) if (m[k] !== undefined) out[k] = m[k]!;
  return out;
}
