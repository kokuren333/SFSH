/**
 * M5 takedown drill: create the dummy work `novel-sfsh-takedown-drill-2026` in works/ from the fixture
 * site/fixtures/works/novel-akari-2020 (fictional content), with distinctive title / aliases so traces are easy to
 * search. Public, with gen/public.json, so the next `sfsh publish` puts it on the (test) site.
 *
 *   node harness/probes/m5_dummy_work.ts [--works-dir works] [--id <work_id>]   (default id below; use another id for a
 *   later drill, e.g. the post-opening check — the M5 dummy stays in works/ as a Restricted record)
 *
 * Refuses to overwrite an existing dummy. The drill then runs `sfsh publish`, `sfsh takedown`, `sfsh purge`.
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../src/paths.ts";
import { rebuildIndex } from "../src/works/store.ts";

const argId = process.argv.indexOf("--id");
export const DUMMY_ID = argId > 0 ? process.argv[argId + 1]! : "novel-sfsh-takedown-drill-2026";
if (!/^[a-z]+-[a-z0-9-]+-\d{4}$/.test(DUMMY_ID)) throw new Error(`bad work_id ${DUMMY_ID}`);
// A later drill (--id) gets distinct names, so its traces never mix with the M5 dummy's.
const tag = argId > 0 ? `（${DUMMY_ID}）` : "";
export const DUMMY_TITLE = `取り下げ訓練用ダミー作品${tag}`;
export const DUMMY_ORIGINAL = `SFSH Takedown Drill Dummy${argId > 0 ? ` ${DUMMY_ID}` : ""}`;
export const DUMMY_ALIASES = [`取り下げ訓練ダミー${tag}`, `テイクダウン訓練作品${tag}`];

const argWorks = process.argv.indexOf("--works-dir");
const worksDir = argWorks > 0 ? path.resolve(process.argv[argWorks + 1]!) : paths.works;
const src = path.join(paths.root, "site", "fixtures", "works", "novel-akari-2020");
const dir = path.join(worksDir, DUMMY_ID);
if (fs.existsSync(dir)) {
  console.error(`${dir} exists; refusing to overwrite`);
  process.exit(2);
}
const now = new Date().toISOString();
const work = JSON.parse(fs.readFileSync(path.join(src, "work.json"), "utf8"));
Object.assign(work, {
  work_id: DUMMY_ID,
  title: DUMMY_TITLE,
  title_original: DUMMY_ORIGINAL,
  title_reading: "とりさげくんれんようだみーさくひん",
  title_reading_basis: "estimated",
  title_status: "confirmed",
  aliases: DUMMY_ALIASES.map((text, i) => ({ text, kind: i ? "input" : "common", attested: !i, source_ids: i ? [] : ["s1"], origin_job_id: "m5-drill", first_seen: now })),
  creators: ["訓練用 著者"],
  first_release_year: 2026,
  publish_mode: "Public",
  history: [{ at: now, event: "created", job_id: null, detail: "M5 takedown drill dummy (from fixture novel-akari-2020; fictional content)" }],
  first_published_at: now,
  updated_at: now,
  created_at: now,
});
const pub = JSON.parse(fs.readFileSync(path.join(src, "gen", "public.json"), "utf8"));
Object.assign(pub.work, {
  work_id: DUMMY_ID,
  title: DUMMY_TITLE,
  title_original: DUMMY_ORIGINAL,
  title_reading: work.title_reading,
  aliases_display: [DUMMY_ALIASES[0]],
  creators: [{ name: "訓練用 著者", role: "著" }],
  first_release_year: 2026,
  publisher: "訓練用書房",
  first_published_at: now,
  updated_at: now,
});
// Replace the fixture's identifying strings elsewhere in the public projection.
const text = JSON.stringify(pub).replaceAll("novel-akari-2020", DUMMY_ID).replaceAll("灯りの航路", DUMMY_TITLE).replaceAll("Routes of Light", DUMMY_ORIGINAL).replaceAll("灯路", DUMMY_ALIASES[0]!).replaceAll("架空 葵", "訓練用 著者").replaceAll("架空書房", "訓練用書房");
fs.mkdirSync(path.join(dir, "gen"), { recursive: true });
fs.writeFileSync(path.join(dir, "work.json"), JSON.stringify(work, null, 2) + "\n", "utf8");
fs.writeFileSync(path.join(dir, "gen", "public.json"), JSON.stringify(JSON.parse(text), null, 2) + "\n", "utf8");
rebuildIndex(worksDir);
console.log(`created ${dir} (Public, gen/public.json); INDEX rebuilt`);
