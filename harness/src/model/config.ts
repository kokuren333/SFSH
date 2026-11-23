import fs from "node:fs";
import { paths } from "../paths.ts";
import type { PortName } from "./types.ts";

/** harness/config/models.json (REQUIREMENTS §3.1). */
export interface ModelsConfig {
  haiku: string[];
  luna: string[];
  adopted: { haiku: string; luna: string; probed_at: string };
}

export function loadModelsConfig(file = paths.modelsConfig): ModelsConfig {
  const c = JSON.parse(fs.readFileSync(file, "utf8")) as ModelsConfig;
  for (const p of ["haiku", "luna"] as const) {
    if (!Array.isArray(c[p]) || c[p].length === 0) throw new Error(`models.json: "${p}" must be a non-empty array`);
  }
  if (!c.adopted || typeof c.adopted.haiku !== "string" || typeof c.adopted.luna !== "string") {
    throw new Error(`models.json: "adopted" must have haiku and luna`);
  }
  return c;
}

export function saveModelsConfig(c: ModelsConfig, file = paths.modelsConfig): void {
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n", "utf8");
}

export function adoptedModel(port: PortName, c: ModelsConfig = loadModelsConfig()): string {
  return c.adopted[port];
}
