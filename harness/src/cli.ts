import { pathToFileURL } from "node:url";
import { jobCommand } from "./commands/job.ts";
import { modelsProbe } from "./commands/models.ts";
import { buildCommand, previewCommand } from "./commands/site.ts";
import { designCommand } from "./commands/design.ts";
import { checkCommand } from "./commands/check.ts";
import { holdCommand, purgeCommand, releaseCommand, takedownCommand } from "./commands/ops.ts";
import { answerCommand, cancelCommand, enqueueCommand, statusCommand, workerCommand } from "./commands/queue.ts";
import { importCommand } from "./commands/import.ts";
import { discordCommand } from "./commands/discord.ts";
import { publishCommand } from "./commands/publish.ts";
import { HARNESS_PUBLISH_USAGE, harnessPublishCommand } from "./commands/harnessPublish.ts";
import { REGEN_USAGE, regenCommand } from "./commands/regen.ts";
import type { PortName } from "./model/types.ts";

/** Exit codes: 0 ok / 2 usage error (unknown command, missing args) / 3 command failed. */
export const EXIT_OK = 0;
export const EXIT_USAGE = 2;

interface CommandSpec {
  usage: string;
  summary: string;
  milestone?: string; // set → stub that prints "not implemented (M<n>)"
  /** Number of required positional args. */
  positional?: number;
  run?: (args: string[]) => Promise<number>;
}

const COMMANDS: Record<string, CommandSpec> = {
  enqueue: {
    usage: 'enqueue --work "<title>" [--range "<range>"] [--medium <m>] [--note <t>] [--priority high|normal] [--origin muse|cli] [--url <u>]... [--json]',
    summary: "Put one JobRequest into queue/inbox (§4.3)",
    run: (a) => enqueueCommand(a),
  },
  import: {
    usage: "import <file> [--range <r>] [--medium <m>] [--priority [high|normal]] [--dry-run] [--origin muse|cli] [--json]",
    summary: "Batch-import a title list .txt/.csv (§4.5)",
    positional: 1,
    run: (a) => importCommand(a),
  },
  discord: {
    usage: "discord commands | discord serve [--dry-run] | discord register",
    summary: "Discord bot (§4.2): command JSON / serve / register — real connection refused until U-04 (production_enabled)",
    run: (a) => discordCommand(a),
  },
  status: {
    usage: "status [job_id|--batch <batch_id>] [--json]",
    summary: "Show job / queue / batch status",
    run: (a) => statusCommand(a),
  },
  cancel: { usage: "cancel <job_id> | --batch <batch_id>", summary: "Cancel unfinished job(s) (requester or owner; running jobs stop at the next stage boundary)", positional: 1, run: (a) => cancelCommand(a) },
  answer: {
    usage: "answer <job_id> [--pick <n>] [--work <t>] [--medium <m>] [--range <r>]",
    summary: "Answer a clarifying job: pick a candidate, or give the work / medium / range (§4.1)",
    positional: 1,
    run: (a) => answerCommand(a),
  },
  worker: {
    usage: "worker [--once] [--poll-ms 2000] [--max-jobs <n>]",
    summary: "Run the single queue worker: identify all received jobs first, then process ready jobs (§4.4)",
    run: (a) => workerCommand(a),
  },
  hold: {
    usage: "hold <work_id> [--reason <t>] [--json]",
    summary: "Hold a work: Restricted, excluded from the next build, unfinished jobs -> held (§5.4)",
    positional: 1,
    run: (a) => holdCommand(a),
  },
  release: {
    usage: "release <work_id> [--reason <t>] [--json]",
    summary: "Release a held work: Public again from the next build; held jobs continue via job resume (§5.4)",
    positional: 1,
    run: (a) => releaseCommand(a),
  },
  takedown: {
    usage: "takedown <work_id> [--reason <t>] [--out site/dist] [--base-url <url>] [--json]",
    summary: "Take a work down: Restricted, rebuild without it, verify no trace, snapshot push + 404 check (§5.4)",
    positional: 1,
    run: (a) => takedownCommand(a),
  },
  purge: {
    usage: "purge <work_id> [--reason <t>] [--out site/dist] [--base-url <url>] [--json]",
    summary: "Takedown (incl. push) + delete the work's gen/, releases/, check/ (keeps research/, nkg/, work.json) (§5.4)",
    positional: 1,
    run: (a) => purgeCommand(a),
  },
  publish: {
    usage: "publish [--no-build] [--dry-run] [--reason <t>] [--json] | publish init | publish status | publish verify-url [--base-url <u>] | publish serve-test [--port <n>]",
    summary: "Build, verify (a)–(g), remote check, snapshot-push to the Pages repo — local test bare until the opening gate (§6.3, U-05)",
    run: (a) => publishCommand(a),
  },
  "harness-publish": {
    usage: HARNESS_PUBLISH_USAGE,
    summary: "Allow-listed export of HEAD (code + design docs) → machine scan → push to the public harness repo kokuren333/SFSH (AMENDMENT 08)",
    run: (a) => harnessPublishCommand(a),
  },
  build: { usage: "build [--works-dir <dir>] [--out <dir>] [--base-url <url>]", summary: "Build the static site", run: buildCommand },
  preview: { usage: "preview [--port 8080] [--dir site/dist]", summary: "Local build preview (§WP-2.5)", run: previewCommand },
  check: {
    usage: "check <work_id> [--json]",
    summary: "S4 automatic check on a work: A-1/A-2 (fix only the matching parts) + advisory report (§5.1, §5.2)",
    positional: 1,
    run: checkCommand,
  },
  regen: {
    usage: REGEN_USAGE,
    summary: "Re-run S3 write → compose → S4 autocheck for an existing work from saved research only (no search / fetch; backup under gen/_backup-<stamp>/)",
    positional: 1,
    run: (a) => regenCommand(a),
  },
  design: {
    usage: "design check [--json-out <file>] | design generate [--sample-dir <dist>] [--dry-run]",
    summary: "Design token/CSS machine check (WP-2.7) / Haiku-authored, Luna-reviewed design generation (WP-2.6)",
    run: designCommand,
  },
  models: {
    usage: "models probe [--write] [--port haiku|luna] [--json]",
    summary: "Probe model ids per §3.1 and (with --write) record the adopted ids",
    run: runModels,
  },
  job: {
    usage: 'job run --work "<title>" [--medium m] [--range r] [--url u]... | job resume <job_id> | job status <job_id> [--json]',
    summary: "Run / resume / inspect one S0–S2 job (M1 entry; the queue is M4)",
    run: jobCommand,
  },
  help: { usage: "help", summary: "Show this command list", run: async () => (printHelp(), EXIT_OK) },
};

function printHelp(): void {
  console.log("sfsh — Super Fast Story Harness (private, local)\n");
  console.log("usage: sfsh <command> [args]\n");
  const w = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));
  for (const c of Object.values(COMMANDS)) {
    const tag = c.milestone ? ` [stub: ${c.milestone}]` : "";
    console.log(`  ${c.usage.padEnd(w)}  ${c.summary}${tag}`);
  }
}

async function runModels(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "probe") {
    console.error(`usage: sfsh ${COMMANDS.models.usage}`);
    return EXIT_USAGE;
  }
  let write = false;
  let json = false;
  let ports: PortName[] | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--write") write = true;
    else if (a === "--json") json = true;
    else if (a === "--port" && (rest[i + 1] === "haiku" || rest[i + 1] === "luna")) ports = [rest[++i] as PortName];
    else {
      console.error(`unknown option: ${a}\nusage: sfsh ${COMMANDS.models.usage}`);
      return EXIT_USAGE;
    }
  }
  return modelsProbe({ write, json, ports });
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return EXIT_OK;
  }
  const spec = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!spec) {
    console.error(`sfsh: unknown command "${cmd}". Run "sfsh help".`);
    return EXIT_USAGE;
  }
  const positionals = args.filter((a) => !a.startsWith("-"));
  if ((spec.positional ?? 0) > positionals.length) {
    console.error(`usage: sfsh ${spec.usage}`);
    return EXIT_USAGE;
  }
  if (spec.run) return spec.run(args);
  console.log(`sfsh ${cmd}: not implemented (${spec.milestone})`);
  return EXIT_OK;
}

// Direct execution: `tsx harness/src/cli.ts <cmd>` (npm run sfsh -- <cmd>)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
      process.exitCode = 1;
    },
  );
}
