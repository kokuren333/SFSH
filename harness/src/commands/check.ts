import { existsSync } from "node:fs";
import path from "node:path";
import { autoCheck } from "../check/stage.ts";
import { formatNotice } from "../check/notice.ts";
import { CHECK_FILES, type CheckReport } from "../check/types.ts";
import type { StageContext } from "../job/context.ts";
import { getModelPort } from "../model/index.ts";
import { readJson } from "../nkg/io.ts";
import { paths } from "../paths.ts";
import { DEFAULT_BUDGET } from "../research/types.ts";

/**
 * `sfsh check <work_id> [--json]` — run the S4 automatic check (A-1 / A-2 / advisory, §5.1–5.2) on an existing
 * work's gen/public.json with the adopted model ports (Haiku / Luna, one rewrite call each at most), then print
 * the completion notice (or the whole check/report.json with --json). Exit: 0 ok / 2 usage / 3 failed.
 * Registered in harness/src/cli.ts by the orchestrator.
 */
export async function checkCommand(args: string[], opts: { worksDir?: string } = {}): Promise<number> {
  let workId: string | null = null;
  let json = false;
  for (const a of args) {
    if (a === "--json") json = true;
    else if (!a.startsWith("--") && workId === null) workId = a;
    else {
      console.error(`unknown option: ${a}\nusage: sfsh check <work_id> [--json]`);
      return 2;
    }
  }
  if (!workId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(workId)) {
    console.error("usage: sfsh check <work_id> [--json]");
    return 2;
  }
  const workDir = path.join(opts.worksDir ?? paths.works, workId);
  if (!existsSync(path.join(workDir, "gen", "public.json"))) {
    console.error(`check: ${workId}: gen/public.json not found (run the job through compose first)`);
    return 3;
  }
  const now = new Date();
  const ctx: StageContext = {
    jobId: `check-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}`,
    workDir,
    workId,
    range: [],
    luna: getModelPort("luna"),
    haiku: getModelPort("haiku"),
    fetcher: {
      fetchAll: async () => {
        throw new Error("check: no fetching in S4");
      },
    },
    budget: { limits: { ...DEFAULT_BUDGET }, searchesUsed: 0, fetchesUsed: 0, startedAt: now.toISOString() },
    now: () => new Date(),
    log: (m) => console.error(m),
  };
  try {
    const res = await autoCheck(ctx);
    const report = readJson<CheckReport | null>(workDir, CHECK_FILES.report, null);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      if (report) console.log(formatNotice(report.notice));
      for (const w of res.warnings) console.error(`warning: ${w}`);
    }
    return 0;
  } catch (e) {
    console.error(`check: ${workId}: ${(e as Error).message}`);
    return 3;
  }
}
