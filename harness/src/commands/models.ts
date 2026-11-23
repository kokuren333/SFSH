import { isoLocal } from "../model/callLog.ts";
import { loadModelsConfig, saveModelsConfig } from "../model/config.ts";
import { createCliPort } from "../model/index.ts";
import { formatProbeTable, probeModels, type PortFactory } from "../model/probe.ts";
import type { PortName } from "../model/types.ts";

export interface ModelsProbeOptions {
  write: boolean;
  ports?: PortName[];
  json: boolean;
}

/** `sfsh models probe [--write] [--port haiku|luna] [--json]` (REQUIREMENTS §3.1). Returns exit code. */
export async function modelsProbe(opts: ModelsProbeOptions, factory: PortFactory = createCliPort): Promise<number> {
  const config = loadModelsConfig();
  const ports = opts.ports ?? (["luna", "haiku"] as PortName[]);
  const outcome = await probeModels(config, factory, { ports });
  const probedAt = isoLocal(new Date());

  if (opts.json) {
    console.log(JSON.stringify({ probed_at: probedAt, ...outcome }, null, 2));
  } else {
    console.log(`sfsh models probe — ${probedAt}`);
    console.log(formatProbeTable(outcome));
    console.log("");
    for (const p of ports) {
      const now = config.adopted[p];
      const found = outcome.adopted[p];
      const change = found && found !== now ? `  (CHANGE: config has ${now})` : "";
      console.log(`adopted ${p}: ${found ?? "NONE"}${change}`);
    }
  }

  if (opts.write) {
    if (outcome.failed.length > 0) {
      console.error("models.json NOT updated (a port had no responding model).");
    } else {
      for (const p of ports) config.adopted[p] = outcome.adopted[p]!;
      config.adopted.probed_at = probedAt;
      saveModelsConfig(config);
      console.log("models.json updated (adopted, probed_at).");
    }
  } else if (!opts.json) {
    console.log("(dry run: models.json unchanged; use --write to update `adopted`)");
  }

  if (outcome.failed.length > 0) {
    for (const p of outcome.failed) {
      console.error(
        `ERROR: no ${p} model responded (tried: ${config[p].join(", ")}). ` +
          `Do not substitute another tier — stop and report to PM.`,
      );
    }
    return 3;
  }
  return 0;
}
