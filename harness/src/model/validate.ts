import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { stableStringify } from "../util/hash.ts";

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new Map<string, ValidateFunction>();

export interface ValidationOutcome {
  ok: boolean;
  errors: ErrorObject[];
  summary: string;
}

export function validateAgainst(schema: object, data: unknown): ValidationOutcome {
  const key = stableStringify(schema);
  let fn = cache.get(key);
  if (!fn) {
    fn = ajv.compile(schema);
    cache.set(key, fn);
  }
  const ok = fn(data) as boolean;
  const errors = ok ? [] : [...(fn.errors ?? [])];
  const summary = ok
    ? "ok"
    : errors
        .slice(0, 3)
        .map((e) => `${e.instancePath || "/"} ${e.message ?? e.keyword}`)
        .join("; ");
  return { ok, errors, summary };
}

/**
 * OpenAI structured-output "strict" check (needed for codex --output-schema):
 * every object schema has additionalProperties:false and lists all properties in required.
 * Returns a list of violations (empty = strict).
 */
export function strictSchemaViolations(schema: unknown, at = "#"): string[] {
  const out: string[] = [];
  if (!schema || typeof schema !== "object") return out;
  const s = schema as Record<string, unknown>;
  const isObject = s.type === "object" || (Array.isArray(s.type) && s.type.includes("object")) || "properties" in s;
  if (isObject) {
    if (s.additionalProperties !== false) out.push(`${at}: additionalProperties must be false`);
    const props = (s.properties ?? {}) as Record<string, unknown>;
    const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    for (const k of Object.keys(props)) {
      if (!req.has(k)) out.push(`${at}/properties/${k}: not listed in required`);
      out.push(...strictSchemaViolations(props[k], `${at}/properties/${k}`));
    }
  }
  if (s.items) out.push(...strictSchemaViolations(s.items, `${at}/items`));
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const arr = s[key];
    if (Array.isArray(arr)) arr.forEach((sub, i) => out.push(...strictSchemaViolations(sub, `${at}/${key}/${i}`)));
  }
  for (const key of ["$defs", "definitions"] as const) {
    const defs = s[key] as Record<string, unknown> | undefined;
    if (defs && typeof defs === "object") {
      for (const [k, sub] of Object.entries(defs)) out.push(...strictSchemaViolations(sub, `${at}/${key}/${k}`));
    }
  }
  return out;
}
