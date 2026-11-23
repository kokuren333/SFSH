// Orchestrator's independent check of S4 (not the worker's fixture): plant contamination into a temp copy of a real work,
// run autoCheck with model ports that never rewrite (→ removal path), and diff the public file.
// usage: node harness/probes/m3_plant_real.ts <work_id> <out.json>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { autoCheck, recheckPublic } from "../src/check/index.ts";
import type { ModelPort } from "../src/model/types.ts";
const [workId, outFile] = process.argv.slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh_plant_"));
const W = path.join(tmp, workId);
fs.cpSync(path.join("works", workId), W, { recursive: true });
fs.rmSync(path.join(W, "check"), { recursive: true, force: true });
const cards = JSON.parse(fs.readFileSync(path.join(W, "research", "sources.json"), "utf8"));
// take 3 long runs of non-space text from 3 different saved sources (the raw text the fetcher stored)
const spans: string[] = [];
for (const c of cards) {
  const t = fs.readFileSync(path.join(W, c.raw_text_path), "utf8").replace(/\s+/g, "");
  const m = t.match(/[^\x00-\x7F]{45,}/u);
  if (m) spans.push(m[0].slice(0, 45));
  if (spans.length === 3) break;
}
const pubFile = path.join(W, "gen", "public.json");
const pw = JSON.parse(fs.readFileSync(pubFile, "utf8"));
const before = JSON.parse(JSON.stringify(pw));
const planted: { path: string; kind: string }[] = [];
pw.pages.overview[0].paragraphs[0] += spans[0] + "。";
planted.push({ path: "$.pages.overview[0].paragraphs[0]", kind: "A-1" });
pw.elements.events[0].summary = (pw.elements.events[0].summary ?? "") + spans[1] + "。";
planted.push({ path: "$.elements.events[0].summary", kind: "A-1" });
pw.elements.motives[0].summary = (pw.elements.motives[0].summary ?? "") + "　" + spans[2].split("").join(" ") + "。";
planted.push({ path: "$.elements.motives[0].summary", kind: "A-1 (spaced variant)" });
pw.pages.context.items[0].summary = (pw.pages.context.items[0].summary ?? "") + '<img src="http://cdn.example.net/poster.webp">';
planted.push({ path: "$.pages.context.items[0].summary", kind: "A-2 img" });
pw.pages.quiz[0].explanation += " 参考映像 https://video.example.org/clip.mp4";
planted.push({ path: "$.pages.quiz[0].explanation", kind: "A-2 media url" });
fs.writeFileSync(pubFile, JSON.stringify(pw, null, 2));
const silent = (port: "luna" | "haiku"): ModelPort => ({ port, modelId: "none", call: async () => { throw new Error("no rewrite in this probe"); } }) as ModelPort;
const r = await autoCheck({ jobId: "m3-plant", workDir: W, workId, range: [{ unit: "whole", from: null, to: null, label: "全体" }], luna: silent("luna"), haiku: silent("haiku"),
  fetcher: { fetchAll: async () => ({ cards: [], decisions: [], gaps: [] }) }, budget: { limits: { searches: 0, fetches: 0, wallMs: 0 }, searchesUsed: 0, fetchesUsed: 0, startedAt: "" }, now: () => new Date(), log: () => {} });
const after = JSON.parse(fs.readFileSync(pubFile, "utf8"));
const report = JSON.parse(fs.readFileSync(path.join(W, "check", "report.json"), "utf8"));
// leaves that differ between the ORIGINAL (pre-plant) public file and the fixed one
const diffs: string[] = [];
const walk = (a: unknown, b: unknown, p: string) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], Array.isArray(a) ? `${p}[${k}]` : `${p}.${k}`);
  } else diffs.push(p);
};
walk(before, after, "$");
const reportText = fs.readFileSync(path.join(W, "check", "report.json"), "utf8");
const out = {
  work_id: workId, planted,
  a1_detected_paths: report.a1.detected.map((d: { path: string }) => d.path), a2_detected: report.a2.detected.map((d: { path: string; kind: string }) => `${d.path} ${d.kind}`),
  residual: recheckPublic(W), metrics: r.metrics, warnings: r.warnings,
  changed_vs_original: diffs,
  planted_text_in_report: spans.some((s) => reportText.includes(s.slice(0, 15))),
};
fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out, null, 1));
