/**
 * Public conditions (REQUIREMENTS §2.3):
 *  canon → grade B or better / consensus → C or better / fan_theory → ≥1 provenance entry /
 *  sfsh_analysis → non-empty based_on whose nodes are all public-eligible (recursive; a cycle = not eligible).
 * Edges have no based_on: an sfsh_analysis edge is eligible when both endpoint nodes are eligible
 * (special endpoints "audience" / "work" count as eligible).
 */
import { gradeAtLeast } from "./confidence.ts";
import type { Grade, NkgEdge, NkgNode } from "./types.ts";

export interface Eligibility {
  eligible: boolean;
  reasons: string[];
}

const SPECIAL_ENDPOINTS = new Set(["audience", "work"]);

export function evaluatePublic(nodes: NkgNode[], edges: NkgEdge[]): Map<string, Eligibility> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const memo = new Map<string, Eligibility>();
  const visiting = new Set<string>();

  const base = (grade: Grade, epistemic: string, provCount: number): Eligibility | null => {
    switch (epistemic) {
      case "canon":
        return gradeAtLeast(grade, "B") ? { eligible: true, reasons: [] } : { eligible: false, reasons: [`canon requires grade B+, got ${grade}`] };
      case "consensus":
        return gradeAtLeast(grade, "C") ? { eligible: true, reasons: [] } : { eligible: false, reasons: [`consensus requires grade C+, got ${grade}`] };
      case "fan_theory":
        return provCount >= 1 ? { eligible: true, reasons: [] } : { eligible: false, reasons: ["fan_theory requires provenance"] };
      default:
        return null;
    }
  };

  const nodeElig = (id: string): Eligibility => {
    const cached = memo.get(id);
    if (cached) return cached;
    const n = byId.get(id);
    if (!n) return { eligible: false, reasons: [`unknown node ${id}`] };
    if (visiting.has(id)) return { eligible: false, reasons: [`cycle via ${id}`] };
    const b = base(n.meta.confidence.grade, n.meta.epistemic, n.meta.provenance.length);
    if (b) {
      memo.set(id, b);
      return b;
    }
    // sfsh_analysis
    visiting.add(id);
    let res: Eligibility;
    if (!n.based_on.length) {
      res = { eligible: false, reasons: ["sfsh_analysis requires based_on"] };
    } else {
      const bad: string[] = [];
      for (const dep of n.based_on) {
        const e = nodeElig(dep);
        if (!e.eligible) bad.push(`${dep}: ${e.reasons.join("; ") || "not eligible"}`);
      }
      res = bad.length ? { eligible: false, reasons: [`based_on not eligible (${bad.join(" | ")})`] } : { eligible: true, reasons: [] };
    }
    visiting.delete(id);
    // Results computed while inside a cycle depend on the traversal entry point; only memoize at top level.
    if (visiting.size === 0) memo.set(id, res);
    return res;
  };

  const out = new Map<string, Eligibility>();
  for (const n of nodes) out.set(n.id, nodeElig(n.id));
  for (const e of edges) {
    const b = base(e.meta.confidence.grade, e.meta.epistemic, e.meta.provenance.length);
    if (b) {
      out.set(e.id, b);
      continue;
    }
    const bad = [e.from, e.to].filter((x) => !SPECIAL_ENDPOINTS.has(x) && !(out.get(x)?.eligible ?? false));
    out.set(e.id, bad.length ? { eligible: false, reasons: [`sfsh_analysis edge endpoints not eligible: ${bad.join(", ")}`] } : { eligible: true, reasons: [] });
  }
  return out;
}
