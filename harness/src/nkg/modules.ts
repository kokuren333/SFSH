import { BOOK_MENU } from "./bookMenu.ts";
import { selectBookModules } from "./bookSelection.ts";
/**
 * S2 module selection (WP-1.4, REQUIREMENTS §2.5 / §1.3 sufficiency).
 * Luna picks genres from the controlled vocabulary → code expands genre_profiles.json →
 * Haiku proposes additions/removals among selectable modules → code applies →
 * code applies the sufficiency rule (PLAN §3 [暫定]: < 3 active claims per module → not generated, gap).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { StageContext, StageResult } from "../job/context.ts";
import { REPO_ROOT } from "../paths.ts";
import type { Claim } from "../research/claimTypes.ts";
import { NKG_FILES, readActiveClaims, readJson, readSourceCards, writeJson } from "./io.ts";
import {
  GENRE_SCHEMA,
  MODULE_REVIEW_SCHEMA,
  genrePrompt,
  moduleReviewPrompt,
  type GenreOutput,
  type ModuleReviewOutput,
} from "./prompts/modules.ts";
import { MODULE_IDS } from "./schemaSource.ts";
import type { Gap, ModuleChoice, ModuleId } from "./types.ts";

export interface GenreVocabulary {
  genres: { slug: string; label: string }[];
}

export interface GenreProfile {
  add: string[];
  weights: Record<string, number>;
  hints: Record<string, unknown>;
}

export interface GenreProfiles {
  always_on: string[];
  selectable: string[];
  base_weight: number;
  sufficiency_min_claims: number;
  profiles: Record<string, GenreProfile>;
}

export interface ModuleSelectionFile {
  generated_at: string;
  genres: {
    proposed: GenreOutput["genres"];
    accepted: { slug: string; label: string; reason: string; claim_refs: string[] }[];
    dropped: { genre: string; reason: string }[];
  };
  expansion: { enabled: string[]; weights: Record<string, number>; hints: Record<string, unknown>; origin: Record<string, string[]> };
  haiku: {
    proposed: ModuleReviewOutput;
    applied: { action: "add" | "remove"; module: string; reason: string }[];
    rejected: { action: "add" | "remove"; module: string; reason: string; why: string }[];
  };
  claim_counts: Record<string, number>;
  sufficiency_min_claims: number;
  insufficient: { module: string; claims: number; threshold: number }[];
  module_selection: ModuleChoice[];
  gaps: Gap[];
}

const CONFIG_DIR = path.join(REPO_ROOT, "harness", "config");

export function loadGenreVocabulary(file = path.join(CONFIG_DIR, "genres.json")): GenreVocabulary {
  return JSON.parse(readFileSync(file, "utf8")) as GenreVocabulary;
}

export function loadGenreProfiles(file = path.join(CONFIG_DIR, "genre_profiles.json")): GenreProfiles {
  return JSON.parse(readFileSync(file, "utf8")) as GenreProfiles;
}

/** Map a model-supplied genre (slug or Japanese label, any case) to a vocabulary slug, or null. */
export function normalizeGenre(raw: string, vocab: GenreVocabulary): string | null {
  const k = raw.normalize("NFKC").trim().toLowerCase();
  const hit = vocab.genres.find((g) => g.slug.toLowerCase() === k || g.label.normalize("NFKC").toLowerCase() === k);
  return hit ? hit.slug : null;
}

/** Deterministic profile expansion. Weight = base + max delta per module across genres. */
export function expandProfiles(genres: string[], profiles: GenreProfiles): ModuleSelectionFile["expansion"] {
  const enabled = new Set(profiles.always_on);
  const origin: Record<string, string[]> = {};
  for (const m of profiles.always_on) origin[m] = ["always_on"];
  const delta: Record<string, number> = {};
  const hints: Record<string, unknown> = {};
  for (const g of genres) {
    const p = profiles.profiles[g];
    if (!p) continue;
    for (const m of p.add) {
      if (!profiles.selectable.includes(m)) continue;
      enabled.add(m);
      (origin[m] ??= []).push(`genre:${g}`);
    }
    for (const [m, d] of Object.entries(p.weights ?? {})) delta[m] = Math.max(delta[m] ?? 0, d);
    Object.assign(hints, p.hints ?? {});
  }
  const weights: Record<string, number> = {};
  for (const m of enabled) weights[m] = round2(profiles.base_weight + (delta[m] ?? 0));
  return { enabled: sortModules([...enabled]), weights, hints, origin };
}

export function countClaimsByModule(claims: Claim[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of MODULE_IDS) out[m] = 0;
  for (const c of claims) for (const a of new Set(c.aspects ?? [])) if (a in out) out[a] += 1;
  return out;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const sortModules = (ms: string[]) => [...ms].sort();

export function readWorkTitle(workDir: string, fallback: string): string {
  const w = readJson<Record<string, unknown> | null>(workDir, "work.json", null);
  return (typeof w?.title === "string" && w.title) || fallback;
}

/** Stage function: S2 modules. Idempotent (overwrites nkg/module_selection.json). */
export async function selectModules(ctx: StageContext): Promise<StageResult> {
  const kind = readJson<{kind?:string}>(ctx.workDir,"work.json",{}).kind;
  if (kind === "nonfiction") return selectBookModules(ctx);
  const vocab = loadGenreVocabulary();
  const profiles = loadGenreProfiles();
  const claims = readActiveClaims(ctx.workDir);
  const sourceIds = new Set(readSourceCards(ctx.workDir).map((s) => s.source_id));
  const usable = claims.filter((c) => (c.source_ids ?? []).some((s) => sourceIds.has(s)));
  const title = readWorkTitle(ctx.workDir, ctx.workId);
  const warnings: string[] = [];

  // genre claims first so they survive prompt truncation
  const ordered = [...usable].sort((a, b) => rankAspect(a) - rankAspect(b));

  // 1. Luna: genres from the vocabulary only
  const g = await ctx.luna.call({
    task: "s2.genre",
    prompt: genrePrompt({ title, vocabulary: vocab.genres, claims: ordered }),
    schema: GENRE_SCHEMA,
    tools: "none",
    jobId: ctx.jobId,
  });
  const proposed = (g.output as GenreOutput).genres ?? [];
  const accepted: ModuleSelectionFile["genres"]["accepted"] = [];
  const dropped: ModuleSelectionFile["genres"]["dropped"] = [];
  for (const p of proposed) {
    const slug = normalizeGenre(p.genre, vocab);
    if (!slug) dropped.push({ genre: p.genre, reason: "not_in_vocabulary" });
    else if (accepted.some((a) => a.slug === slug)) dropped.push({ genre: p.genre, reason: "duplicate" });
    else accepted.push({ slug, label: vocab.genres.find((v) => v.slug === slug)!.label, reason: p.reason, claim_refs: p.claim_refs });
  }
  if (dropped.length) warnings.push(`genres dropped (outside vocabulary/duplicate): ${dropped.map((d) => d.genre).join(", ")}`);

  // 2. deterministic expansion
  const expansion = expandProfiles(
    accepted.map((a) => a.slug),
    profiles,
  );
  const claimCounts = countClaimsByModule(usable);

  // 3. Haiku review (additions / removals among selectable modules)
  const r = await ctx.haiku.call({
    task: "s2.modules.review",
    prompt: moduleReviewPrompt({
      title,
      genres: accepted,
      alwaysOn: [],
      selectable: MODULE_IDS.filter(m => m.startsWith("M")),
      enabled: expansion.enabled,
      claimCounts,
      claims: ordered,
    }),
    schema: MODULE_REVIEW_SCHEMA,
    jobId: ctx.jobId,
  });
  const review = r.output as ModuleReviewOutput;
  const enabled = new Set(expansion.enabled);
  const reasons: Record<string, string> = {};
  for (const m of expansion.enabled) reasons[m] = expansion.origin[m]?.join(", ") ?? "";
  const applied: ModuleSelectionFile["haiku"]["applied"] = [];
  const rejected: ModuleSelectionFile["haiku"]["rejected"] = [];
  for (const a of review.additions ?? []) {
    const m = a.module.trim().toUpperCase();
    if (!(MODULE_IDS as readonly string[]).includes(m)) rejected.push({ action: "add", module: a.module, reason: a.reason, why: "invalid_module_id" });
    else if (!m.startsWith("M")) rejected.push({ action: "add", module: m, reason: a.reason, why: profiles.always_on.includes(m) ? "always_on" : "not_selectable" });
    else if (enabled.has(m)) rejected.push({ action: "add", module: m, reason: a.reason, why: "already_enabled" });
    else {
      enabled.add(m);
      reasons[m] = `haiku_added: ${a.reason}`;
      applied.push({ action: "add", module: m, reason: a.reason });
    }
  }
  for (const d of review.removals ?? []) {
    const m = d.module.trim().toUpperCase();
    if (!(MODULE_IDS as readonly string[]).includes(m)) rejected.push({ action: "remove", module: d.module, reason: d.reason, why: "invalid_module_id" });
    else if (!enabled.has(m)) rejected.push({ action: "remove", module: m, reason: d.reason, why: "not_enabled" });
    else {
      enabled.delete(m);
      reasons[m] = `haiku_removed: ${d.reason}`;
      applied.push({ action: "remove", module: m, reason: d.reason });
    }
  }

  // 4. sufficiency (applies to always-on modules too)
  const min = profiles.sufficiency_min_claims ?? 3;
  const insufficient: ModuleSelectionFile["insufficient"] = [];
  const gaps: Gap[] = [];
  const selection: ModuleChoice[] = MODULE_IDS.filter(m=>m.startsWith("M")).map((m): ModuleChoice => {
    if (!enabled.has(m)) return { module: m, weight: 0, enabled: false, reason: reasons[m] ?? "not_selected" };
    if (claimCounts[m] < min) {
      insufficient.push({ module: m, claims: claimCounts[m], threshold: min });
      gaps.push({ module: m as ModuleId, what: `関連 claim が ${claimCounts[m]} 件（${min} 件未満）のため未生成`, reason: "insufficient_sources" });
      return { module: m, weight: 0, enabled: false, reason: "insufficient_sources" };
    }
    return { module: m, weight: expansion.weights[m] ?? profiles.base_weight, enabled: true, reason: reasons[m] || "selected" };
  });
  if (insufficient.length) warnings.push(`insufficient modules → gaps: ${insufficient.map((i) => i.module).join(", ")}`);

  const file: ModuleSelectionFile = {
    generated_at: ctx.now().toISOString(),
    genres: { proposed, accepted, dropped },
    expansion,
    haiku: { proposed: review, applied, rejected },
    claim_counts: claimCounts,
    sufficiency_min_claims: min,
    insufficient,
    module_selection: selection,
    gaps,
  };
  if (kind === "mixed") {
    await selectBookModules(ctx);
    const book = readJson<ModuleSelectionFile>(ctx.workDir,NKG_FILES.moduleSelection,file);
    file.module_selection = [...file.module_selection.filter(m=>m.module.startsWith("M")),...book.module_selection];
  }
  const ids=new Set(usable.map(c=>c.claim_id));
  const extra=(review.additional_pages??[]).filter(p=>/^[a-z][a-z-]{1,40}$/.test(p.slug)&&p.label.trim()&&p.claim_refs.some(id=>ids.has(id))&&!['summary','sources','relations','matrix','reverse-plot','themes','events','people','context','quiz','interpretations',...BOOK_MENU.map(m=>m.slug)].includes(p.slug));
  if(extra.length){
    file.module_selection=file.module_selection.filter(m=>m.module!=="B11");
    file.module_selection.push({module:"B11",enabled:true,weight:1,reason:extra.map(p=>p.reason).join('; ')});
    const menu=readJson<{pages:unknown[]}>(ctx.workDir,"nkg/page_menu.json",{pages:[]});
    writeJson(ctx.workDir,"nkg/page_menu.json",{...menu,pages:[...menu.pages,...extra.map(p=>({module:"B11",slug:p.slug,label:p.label}))],additional_pages:extra});
  }
  const out = writeJson(ctx.workDir, NKG_FILES.moduleSelection, file);
  ctx.log(`s2.modules: genres=[${accepted.map((a) => a.slug).join(",")}] enabled=[${selection.filter((s) => s.enabled).map((s) => s.module).join(",")}] insufficient=[${insufficient.map((i) => i.module).join(",")}]`);
  return {
    outputs: [out],
    metrics: {
      genres: accepted.length,
      genres_dropped: dropped.length,
      modules_enabled: selection.filter((s) => s.enabled).length,
      modules_insufficient: insufficient.length,
      haiku_applied: applied.length,
      haiku_rejected: rejected.length,
    },
    warnings,
  };
}

function rankAspect(c: Claim): number {
  const a = c.aspects ?? [];
  if (a.includes("genre")) return 0;
  if (a.includes("bibliographic") || a.includes("title")) return 1;
  return 2;
}

export function readModuleSelection(workDir: string): ModuleSelectionFile | null {
  return readJson<ModuleSelectionFile | null>(workDir, NKG_FILES.moduleSelection, null);
}
