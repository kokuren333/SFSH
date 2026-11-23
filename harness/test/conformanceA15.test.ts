// AMENDMENT 15: requirement conformance — evaluator, config validation, hold / release file swap (no model calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PublicWork } from "../../site/src/public-types.ts";
import {
  DEFAULT_CONFORMANCE,
  HELD_FILE,
  PUBLISHED_COPY,
  evaluateConformance,
  holdCandidate,
  outcomeOf,
  parseConformanceConfig,
  publicShape,
  readBaseline,
  releaseConformanceHold,
  savePublishedCopy,
  type ConformanceReport,
} from "../src/check/conformance.ts";


function workDir(pw: PublicWork): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-a15-"));
  const dir = path.join(root, pw.work.work_id);
  fs.mkdirSync(path.join(dir, "gen"), { recursive: true });
  fs.mkdirSync(path.join(dir, "check"), { recursive: true });
  fs.writeFileSync(path.join(dir, "gen", "public.json"), JSON.stringify(pw, null, 2));
  fs.writeFileSync(path.join(dir, "check", "report.json"), JSON.stringify({ a1: { residual_after_fix: 0, detected: [] }, a2: { residual_after_fix: 0, detected: [] } }));
  fs.writeFileSync(
    path.join(dir, "work.json"),
    JSON.stringify({ work_id: pw.work.work_id, title: pw.work.title, title_original: null, title_reading: null, aliases: [], medium: pw.work.medium, creators: [], genres: [], tags: [], first_release_year: null, publish_mode: "Public", history: [], first_published_at: null, updated_at: null, created_at: "2026-11-23T00:00:00+09:00" }),
  );
  fs.writeFileSync(path.join(root, "INDEX.json"), JSON.stringify({ schema: "sfsh-works-index/1", works: [] }));
  return dir;
}

function minimalWork(): PublicWork {
  const tb = (id: string, chars: number) => ({ id, heading: "見出し", paragraphs: ["あ".repeat(chars)], spoiler: "ending" as const, based_on: ["ev01"], epistemic: "canon" as const });
  return {
    schema: "sfsh-public/1",
    work: { work_id: "film-a15-test-2001", title: "試験", title_original: null, title_reading: null, aliases_display: [], medium: "film", creators: [], genres: [], tags: [], status: "completed", first_release_year: 2001, publisher: null, coverage_label: "全体", spoiler_max: "ending", has_matrix: false, first_published_at: null, updated_at: null },
    phases: [],
    viz: {
      relations: { characters: [{ id: "ch01" }, { id: "ch02" }] as never, relations: [{ id: "re01" }] as never, factions: [] },
      reverse_plot: { trees: [{ id: "oc01", kind: "outcome", level: "outcome", children: [{ id: "wh01", kind: "why", level: "direct", children: [] }] }] as never },
      matrix: null,
      timeline: null,
    },
    pages: {
      overview: [tb("ov1", 100)],
      figure_notes: { relations: null, reverse_plot: null, matrix: null },
      themes: { intro: [], items: [] },
      context: { intro: [], items: [], iconic: [] },
      interpretations: { intro: [], items: [] },
      quiz: [],
      synopsis: { intro: [tb("syn_intro", 300)], chapters: [{ id: "syn_c01", heading: "章", blocks: [tb("syn_c01_s01", 8000)] }] },
    },
    elements: { events: [{ id: "ev01" }, { id: "ev02" }] as never, motives: [], arcs: [], world_rules: [], setups: [], emotion_beats: [] },
    gaps: [],
    sources: [],
  } as PublicWork;
}

test("A15 config: defaults, strict validation, rights cannot be relaxed", () => {
  const c = parseConformanceConfig({ items: { coverage: { mode: "enforce", repair_max: 1 } }, regression: { max_element_drop_ratio: 0.1 } });
  assert.equal(c.items.coverage.mode, "enforce");
  assert.equal(c.items.synopsis_chars.mode, DEFAULT_CONFORMANCE.items.synopsis_chars.mode);
  assert.equal(c.regression.max_element_drop_ratio, 0.1);
  assert.throws(() => parseConformanceConfig({ items: { rights: { mode: "warn" } } }), /rights\.mode must stay "enforce"/);
  assert.throws(() => parseConformanceConfig({ items: { prose: { mode: "warn" } } }), /unknown item/);
  assert.throws(() => parseConformanceConfig({ items: { figures: { mode: "strict" } } }), /mode must be one of/);
  assert.throws(() => parseConformanceConfig({ items: { figures: { repair_max: 9 } } }), /repair_max/);
});

test("A15 evaluate: synopsis target, regression against the published copy, hold → previous version, release → candidate", () => {
  const good = minimalWork();
  const dir = workDir(good);
  const cfg = parseConformanceConfig({});
  // no baseline yet: regression not measured; synopsis 8,000+ chars for a film → pass
  let ev = evaluateConformance({ workDir: dir, candidate: good, candidateKind: "public", baseline: null, cfg, rightsFromReport: true });
  assert.equal(ev.items.find((i) => i.item === "synopsis_chars")!.status, "pass");
  assert.equal(ev.items.find((i) => i.item === "regression")!.status, "not_measured");
  assert.equal(ev.items.find((i) => i.item === "rights")!.status, "pass");

  savePublishedCopy(dir, "20261123-000000000", new Date());
  const base = readBaseline(dir)!;
  assert.equal(base.release_id, "20261123-000000000");

  // thinner candidate: the reverse plot and an event are gone, synopsis short
  const thin = structuredClone(good);
  thin.viz.reverse_plot.trees = [];
  thin.elements.events = thin.elements.events.slice(0, 1);
  thin.pages.synopsis!.chapters[0]!.blocks[0]!.paragraphs = ["い".repeat(3000)];
  fs.writeFileSync(path.join(dir, "gen", "public.json"), JSON.stringify(thin));
  ev = evaluateConformance({ workDir: dir, candidate: thin, candidateKind: "public", baseline: base, cfg, rightsFromReport: true });
  const reg = ev.items.find((i) => i.item === "regression")!;
  assert.equal(reg.status, "shortfall");
  assert.deepEqual(reg.measured.figures_lost, ["reverse_plot"]);
  assert.ok(reg.shortfalls.some((s) => s.includes("公開要素数の後退")));
  assert.ok(reg.actions.includes("interp") && reg.actions.includes("refact"));
  const syn = ev.items.find((i) => i.item === "synopsis_chars")!;
  assert.equal(syn.status, "shortfall");
  assert.deepEqual(syn.actions, ["synopsis"]);
  assert.equal(outcomeOf(ev.items), "held");
  assert.equal(publicShape(thin).elements < publicShape(good).elements, true);

  // hold: candidate aside, previous published version back in gen/public.json
  const rep = { job_id: "job-x", blocking: ["synopsis_chars", "regression"], items: ev.items } as unknown as ConformanceReport;
  const hold = holdCandidate(dir, rep, new Date());
  assert.equal(hold.public_json, "previous_published");
  assert.equal(fs.readFileSync(path.join(dir, "gen", "public.json"), "utf8"), fs.readFileSync(path.join(dir, PUBLISHED_COPY), "utf8"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, HELD_FILE), "utf8")).viz.reverse_plot.trees.length, 0);
  const w = JSON.parse(fs.readFileSync(path.join(dir, "work.json"), "utf8"));
  assert.deepEqual(w.conformance_hold.items, ["synopsis_chars", "regression"]);
  assert.equal(w.history.at(-1).event, "conformance_hold");

  // release by the owner: the held candidate becomes gen/public.json
  const r = releaseConformanceHold(dir, "owner(test)", "checked by hand", new Date());
  assert.equal(r.released, true);
  assert.equal(fs.existsSync(path.join(dir, HELD_FILE)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "gen", "public.json"), "utf8")).viz.reverse_plot.trees.length, 0);
  const w2 = JSON.parse(fs.readFileSync(path.join(dir, "work.json"), "utf8"));
  assert.equal(w2.conformance_hold, null);
  assert.equal(w2.history.at(-1).event, "conformance_release");
  assert.equal(releaseConformanceHold(dir, "owner(test)", null, new Date()).released, false);
});
