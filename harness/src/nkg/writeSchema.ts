/** Regenerates harness/schema/nkg.schema.json from schemaSource.ts. Run: npx tsx harness/src/nkg/writeSchema.ts */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../paths.ts";
import { buildNkgSchema } from "./schemaSource.ts";

export const NKG_SCHEMA_PATH = path.join(REPO_ROOT, "harness", "schema", "nkg.schema.json");

export function renderNkgSchema(): string {
  return JSON.stringify(buildNkgSchema(), null, 2) + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(NKG_SCHEMA_PATH, renderNkgSchema(), "utf8");
  console.log(`wrote ${NKG_SCHEMA_PATH}`);
}
