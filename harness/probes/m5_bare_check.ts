/**
 * Independent check of the local test bare (M5 evidence; does not reuse the publish code's verdicts).
 *
 *   node harness/probes/m5_bare_check.ts [--needles-of <work_id>] [--gc] [--out <file.json>]
 *
 * Reports: refs, commit count (rev-list --all), files in main vs site/.publish-stage manifest (sha256 of every blob),
 * files outside the site manifest, and — with --needles-of — every occurrence of the work's identifying strings in
 * the main tree (by file, flagged for search data / index / genre & media lists / sitemaps), the Pages stand-in
 * status of works/<id>/, and (with --gc: reflog expire + gc --prune=now on the bare first) occurrences in ANY object
 * of the bare's store.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPublishConfig, resolveTarget } from "../src/publish/config.ts";
import { git, gitOut, lsTree, readBlobs } from "../src/publish/git.ts";
import { servePagesFromBare } from "../src/publish/url.ts";
import { paths } from "../src/paths.ts";
import { distTraces } from "../src/works/ops.ts";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const cfg = loadPublishConfig();
const target = resolveTarget(cfg);
if (target.kind !== "test" || !target.barePath) throw new Error("only for the local test bare (gate closed)");
const bare = target.barePath;
const guard = target.gitGuard;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const refs = gitOut(["--git-dir", bare, "for-each-ref", "--format=%(refname) %(objectname)"], { guard }).split(/\r?\n/).filter(Boolean);
const commits = Number(gitOut(["--git-dir", bare, "rev-list", "--all", "--count"], { guard }));
const head = gitOut(["--git-dir", bare, "rev-parse", `refs/heads/${cfg.branch}`], { guard });
const parents = gitOut(["--git-dir", bare, "log", "-1", "--format=%P", head], { guard });
const tree = lsTree(bare, head, guard);
const stage = path.join(paths.root, "site", ".publish-stage");
const manifest = new Map((JSON.parse(fs.readFileSync(path.join(stage, "release-manifest.json"), "utf8")) as { files: { path: string; sha256: string }[] }).files.map((f) => [f.path, f.sha256]));
manifest.set("release-manifest.json", sha(fs.readFileSync(path.join(stage, "release-manifest.json"))));
const blobs = readBlobs(bare, [...new Set(tree.values())], guard);
const mismatched = [...tree].filter(([p, oid]) => manifest.has(p) && sha(blobs.get(oid)!) !== manifest.get(p)).map(([p]) => p);
const nonSite = [...tree.keys()].filter((p) => !manifest.has(p));
const missing = [...manifest.keys()].filter((p) => !tree.has(p));
const forbiddenPaths = [...tree.keys()].filter((p) => /^(harness|logs|design|queue|publish|site)\//.test(p) || /(^|\/)(nkg\.json|work\.json|INDEX\.json|LEDGER\.md|\.env|sources\.json|claims\.json)$/.test(p) || p.includes("research/"));

const out: Record<string, unknown> = {
  checked_at: new Date().toISOString(),
  bare,
  refs,
  commits_in_history: commits,
  head,
  head_parents: parents || "(none: root commit)",
  files_in_main: tree.size,
  files_in_manifest: manifest.size,
  sha256_mismatches: mismatched,
  files_not_in_site_manifest: nonSite,
  manifest_files_missing: missing,
  forbidden_paths: forbiddenPaths,
};

const workId = arg("--needles-of");
if (workId) {
  const w = JSON.parse(fs.readFileSync(path.join(paths.works, workId, "work.json"), "utf8")) as { title: string; title_original: string | null; aliases: { text: string }[] };
  const needles = [workId, w.title, w.title_original, ...w.aliases.map((a) => a.text)].filter((x): x is string => !!x && x.normalize("NFKC").trim().length >= 2);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sfsh-barecheck-"));
  for (const [p, oid] of tree) {
    fs.mkdirSync(path.dirname(path.join(tmp, "head", p)), { recursive: true });
    fs.writeFileSync(path.join(tmp, "head", p), blobs.get(oid)!);
  }
  const traces = distTraces(path.join(tmp, "head"), needles);
  const isList = (f: string) => f === "catalog.json" || f === "index.html" || f === "works/index.html" || f === "search/index.html" || f === "sitemap/index.html" || f === "sitemap.xml" || /^(genres|media|creators)\//.test(f);
  const listFiles = [...tree.keys()].filter(isList);
  out.needles = needles;
  out.list_files_checked = listFiles;
  out.traces_in_main = traces;
  out.traces_in_list_files = traces.filter((t) => isList(t.file));
  out.work_dir_in_main = [...tree.keys()].filter((p) => p.startsWith(`works/${workId}/`)).length;
  const srv = await servePagesFromBare(bare, cfg.branch);
  try {
    const r = await fetch(new URL(`works/${workId}/`, srv.url), { redirect: "manual" });
    out.stand_in_status = { url: new URL(`works/${workId}/`, srv.url).href, status: r.status };
    const s = await fetch(new URL("search/?q=" + encodeURIComponent(w.title), srv.url));
    out.stand_in_search_page_status = s.status;
  } finally {
    await srv.close();
  }
  if (process.argv.includes("--gc")) {
    git(["--git-dir", bare, "reflog", "expire", "--expire=now", "--all"], { guard });
    git(["--git-dir", bare, "gc", "--prune=now", "--quiet"], { guard });
  }
  const all = gitOut(["--git-dir", bare, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"], { guard }).split(/\r?\n/).filter(Boolean);
  const blobOids = all.filter((l) => l.endsWith(" blob")).map((l) => l.split(" ")[0]!);
  const allBlobs = readBlobs(bare, blobOids, guard);
  fs.mkdirSync(path.join(tmp, "objects"), { recursive: true });
  for (const [oid, b] of allBlobs) fs.writeFileSync(path.join(tmp, "objects", `${oid}.txt`), b);
  out.gc_before_object_scan = process.argv.includes("--gc");
  out.objects_total = all.length;
  out.blobs_scanned = allBlobs.size;
  out.traces_in_any_object = distTraces(path.join(tmp, "objects"), needles);
  fs.rmSync(tmp, { recursive: true, force: true });
}
const text = JSON.stringify(out, null, 2);
const o = arg("--out");
if (o) fs.writeFileSync(o, text + "\n", "utf8");
console.log(text);
