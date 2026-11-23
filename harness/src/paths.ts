import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (sfsh/). This file lives at harness/src/paths.ts. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const paths = {
  root: REPO_ROOT,
  modelsConfig: path.join(REPO_ROOT, "harness", "config", "models.json"),
  callLogDir: path.join(REPO_ROOT, "logs", "calls"),
  jobLogDir: path.join(REPO_ROOT, "logs", "jobs"),
  queue: path.join(REPO_ROOT, "queue"),
  works: path.join(REPO_ROOT, "works"),
};
