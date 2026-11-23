import { defaultHarnessPublishEnv, harnessPublish, type HarnessPublishEnv } from "../publish/harnessExport.ts";

export const HARNESS_PUBLISH_USAGE = 'harness-publish [--dry-run] [--message "<text>"] [--json]';

/**
 * `sfsh harness-publish` (M6, AMENDMENT 08): allow-listed export of HEAD → machine scan → commit + push to the public
 * harness repository (harness/config/harness-export.json). Exit: 0 pushed / no change / dry run, 2 usage,
 * 3 blocked (scan or clone check) or failed. Nothing is pushed unless the scan and the clone check are clean.
 */
export async function harnessPublishCommand(args: string[], env: HarnessPublishEnv = defaultHarnessPublishEnv()): Promise<number> {
  let dryRun = false;
  let json = false;
  let message: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") dryRun = true;
    else if (a === "--json") json = true;
    else if (a === "--message" && args[i + 1] !== undefined) message = args[++i];
    else {
      console.error(`unknown option: ${a}\nusage: sfsh ${HARNESS_PUBLISH_USAGE}`);
      return 2;
    }
  }
  const r = await harnessPublish(env, { dryRun, message });
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`harness-publish: ${r.status.toUpperCase()}  source ${r.source_commit?.slice(0, 12) ?? "-"}  files ${r.files} (tracked but not exported: ${r.excluded_tracked})`);
    if (r.rewrites.length) console.log(`  rewrites (copy only): ${r.rewrites.map((w) => `${w.path} ${w.rule}×${w.count}`).join(", ")}`);
    if (r.scan) {
      console.log(`  scan: ${r.scan.ok ? "ok" : "BLOCKED"} — findings ${r.scan.findings.length}, allow-listed ${r.scan.allowed.length}${r.scan.unused_allow.length ? `, unused allow entries ${r.scan.unused_allow.length}` : ""}`);
      for (const f of r.scan.findings.slice(0, 30)) console.log(`    ${f.kind}  ${f.path}${f.line ? `:${f.line}` : ""}  ${f.kind === "private_needle" ? f.value : JSON.stringify(f.value.slice(0, 80))}`);
    }
    if (r.clone_check) console.log(`  clone check: ${r.clone_check.ok ? "ok" : `FAILED — ${r.clone_check.problems.join("; ")}`}`);
    if (r.diff) console.log(`  diff vs public: +${r.diff.added.length} ~${r.diff.modified.length} -${r.diff.deleted.length}${[...r.diff.added, ...r.diff.modified, ...r.diff.deleted].length <= 40 ? `  [${[...r.diff.added.map((p) => "+" + p), ...r.diff.modified.map((p) => "~" + p), ...r.diff.deleted.map((p) => "-" + p)].join(" ")}]` : ""}`);
    if (r.commit) console.log(`  commit ${r.commit}  remote ${r.remote_ref ?? "-"}`);
    if (r.error) console.log(`  ${r.status === "dry_run" ? "note" : "error"}: ${r.error}`);
    if (r.record) console.log(`  record: ${r.record}`);
  }
  return r.status === "blocked" || r.status === "failed" ? 3 : 0;
}
