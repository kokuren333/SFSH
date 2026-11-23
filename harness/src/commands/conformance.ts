import fs from "node:fs";
import path from "node:path";
import type { PublicWork } from "../../../site/src/public-types.ts";
import { isoLocal } from "../model/callLog.ts";
import { paths } from "../paths.ts";
import {
  conformanceNotice,
  evaluateConformance,
  loadConformanceConfig,
  outcomeOf,
  PUBLISHED_COPY,
  readBaseline,
  readReport,
  savePublishedCopy,
  type ConformanceReport,
} from "../check/conformance.ts";

export const CONFORMANCE_USAGE = "conformance <work_id> [--candidate <public.json|projection.json>] [--out <file>] [--json] | conformance baseline <work_id> --release <release_id>";

/**
 * AMENDMENT 15.
 *  - `sfsh conformance <work_id>`: evaluate the requirement items (check only — no repair, no hold) on gen/public.json, or
 *    on any candidate file (`--candidate`, e.g. a saved projection of an earlier run), against the previous published
 *    version (works/<id>/releases/published.public.json). Prints the item table; `--out` writes the report as JSON
 *    (default: nothing written; the stage's own report is check/conformance.json).
 *  - `sfsh conformance baseline <work_id> --release <id>`: keep the current gen/public.json as the published copy, for
 *    works published before A15 (the publish itself writes the copy from A15 on). Use only when gen/public.json is the
 *    version that is online (check with a build: the work's pages equal publish/works/<id>/).
 * Exit: 0 / 2 usage / 3 error. The check exits 0 whatever the outcome (it is a measurement).
 */
export async function conformanceCommand(args: string[]): Promise<number> {
  if (args[0] === "baseline") return baseline(args.slice(1));
  let workId: string | null = null;
  let candidate: string | null = null;
  let out: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") json = true;
    else if (a === "--candidate" && args[i + 1]) candidate = args[++i]!;
    else if (a === "--out" && args[i + 1]) out = args[++i]!;
    else if (!a.startsWith("-") && !workId) workId = a;
    else {
      console.error(`usage: sfsh ${CONFORMANCE_USAGE}`);
      return 2;
    }
  }
  if (!workId || !/^[a-z0-9][a-z0-9-]*$/.test(workId)) {
    console.error(`usage: sfsh ${CONFORMANCE_USAGE}`);
    return 2;
  }
  const workDir = path.join(paths.works, workId);
  if (!fs.existsSync(path.join(workDir, "work.json"))) {
    console.error(`sfsh conformance: unknown work ${workId}`);
    return 2;
  }
  try {
    const file = path.resolve(candidate ?? path.join(workDir, "gen", "public.json"));
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as PublicWork & { chain_dropout?: unknown };
    const kind = raw.pages?.overview?.length || raw.pages?.synopsis ? "public" : "projection";
    const cfg = loadConformanceConfig();
    const baselineRec = readBaseline(workDir);
    const ev = evaluateConformance({ workDir, candidate: raw, candidateKind: kind, baseline: baselineRec, cfg, rightsFromReport: !candidate });
    const outcome = outcomeOf(ev.items);
    const rep: ConformanceReport = {
      schema: "sfsh-conformance/1",
      work_id: workId,
      job_id: `check-${isoLocal(new Date()).replace(/[^0-9]/g, "").slice(0, 14)}`,
      scope: "check",
      checked_at: isoLocal(new Date()),
      config: cfg,
      candidate: { kind, source: path.relative(paths.root, file).replace(/\\/g, "/") },
      baseline: baselineRec ? { source: baselineRec.source, release_id: baselineRec.release_id, saved_at: baselineRec.saved_at } : null,
      initial: ev.items,
      items: ev.items,
      shape: { candidate: ev.shape, baseline: ev.baseline_shape },
      repairs: [],
      repair_attempts: {},
      unrepairable: [],
      outcome,
      blocking: outcome === "held" ? ev.items.filter((i) => i.mode === "enforce" && i.status === "shortfall").map((i) => i.item) : [],
      notice: [],
    };
    rep.notice = conformanceNotice(rep);
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(path.resolve(out), JSON.stringify(rep, null, 2) + "\n", "utf8");
    }
    if (json) console.log(JSON.stringify(rep, null, 2));
    else {
      console.log(`[conformance ${workId}] candidate ${rep.candidate.source} (${kind}); baseline ${rep.baseline ? `${rep.baseline.source} (release ${rep.baseline.release_id ?? "?"})` : "none"}`);
      for (const it of ev.items) console.log(`  ${it.item.padEnd(15)} ${it.mode.padEnd(7)} ${it.status.padEnd(12)} ${it.shortfalls.join(" / ") || it.note || ""}`);
      console.log(`  elements ${ev.shape.elements}${ev.baseline_shape ? ` (baseline ${ev.baseline_shape.elements})` : ""}; figures ${JSON.stringify(ev.shape.figures)}; synopsis ${ev.shape.synopsis ? `${ev.shape.synopsis.chars} chars / ${ev.shape.synopsis.chapters} ch` : "none"}`);
      console.log(`  → would be: ${outcome}${outcome === "held" ? " (publish held)" : ""}`);
      const last = readReport(workDir);
      if (last) console.log(`  last stage report: check/conformance.json job ${last.job_id} outcome ${last.outcome}`);
      if (out) console.log(`  report: ${out}`);
    }
    return 0;
  } catch (e) {
    console.error(`sfsh conformance: ${e instanceof Error ? e.message : String(e)}`);
    return 3;
  }
}

function baseline(args: string[]): Promise<number> {
  const workId = args.find((a) => !a.startsWith("-"));
  const i = args.indexOf("--release");
  const release = i >= 0 ? args[i + 1] : undefined;
  if (!workId || !release || !/^[a-z0-9][a-z0-9-]*$/.test(workId)) {
    console.error(`usage: sfsh ${CONFORMANCE_USAGE}`);
    return Promise.resolve(2);
  }
  const workDir = path.join(paths.works, workId);
  if (!fs.existsSync(path.join(workDir, "releases", `${release}.json`))) {
    console.error(`sfsh conformance baseline: works/${workId}/releases/${release}.json not found`);
    return Promise.resolve(2);
  }
  const shape = savePublishedCopy(workDir, release, new Date(), "baseline backfill (sfsh conformance baseline)");
  if (!shape) {
    console.error(`sfsh conformance baseline: works/${workId}/gen/public.json missing`);
    return Promise.resolve(3);
  }
  console.log(`[conformance ${workId}] baseline saved: ${PUBLISHED_COPY} (release ${release}); elements ${shape.elements}; figures ${JSON.stringify(shape.figures)}; synopsis ${shape.synopsis ? shape.synopsis.chars : "none"}`);
  return Promise.resolve(0);
}
