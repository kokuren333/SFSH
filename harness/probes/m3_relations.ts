// CP-029 weak point b: count figure-A relation sets per phase from public.json (the data definition).
// usage: node harness/probes/m3_relations.ts <work_id>...
import fs from "node:fs";
import path from "node:path";
import { phaseInfos } from "../../site/src/figures/relations.ts";
for (const id of process.argv.slice(2)) {
  const pw = JSON.parse(fs.readFileSync(path.join("works", id, "gen", "public.json"), "utf8"));
  const rels = pw.viz.relations.relations, phases = pw.phases;
  const infos = phaseInfos(rels, phases) as any[];
  const perPhase = infos.map((inf, i) => {
    const ids = inf.active.map((r: any) => r.id).sort();
    const changed = [...inf.change.entries()].map(([k, v]: any) => `${k}:${v}`).sort();
    return { phase: phases[i].id, label: phases[i].label, relation_ids: ids, change_marks: changed, ended: inf.ended.map((r: any) => r.id).sort() };
  });
  const idSets = new Set(perPhase.map((p) => p.relation_ids.join(",")));
  const visualSets = new Set(perPhase.map((p) => p.relation_ids.join(",") + "|" + p.change_marks.join(",") + "|" + p.ended.join(",")));
  console.log(JSON.stringify({ work_id: id, relations: rels.length, phases: phases.length, distinct_relation_id_sets: idSets.size, distinct_sets_including_change_marks: visualSets.size, perPhase }, null, 1));
}
