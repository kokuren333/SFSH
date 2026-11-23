/**
 * `sfsh design check` (WP-2.7) and `sfsh design generate` (WP-2.6: Haiku authors, Luna reviews, max 2 rounds).
 * generate needs the renderer's class list (site/src/design/CLASSES.md) and a built sample (site/dist or --sample-dir).
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.ts";
import { getModelPort } from "../model/index.ts";
import { formatDesignCheck, runDesignChecks } from "../design/checkTokens.ts";
import { generateDesign, writeDesign } from "../design/generate.ts";
import { tokensToCss } from "../../../site/src/design/tokensCss.ts";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function sectionOf(md: string, heading: string, next: string): string {
  const a = md.indexOf(heading);
  const b = md.indexOf(next, a + heading.length);
  return a >= 0 ? md.slice(a, b > a ? b : undefined) : "";
}

function sampleHtml(dir: string): string {
  const pick: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name === "index.html") pick.push(p);
    }
  };
  walk(dir);
  // one of each page kind: top, index, search, work, relations, reverse-plot, matrix
  const want = ["", "works", "search", "relations", "reverse-plot", "matrix"];
  const chosen: string[] = [];
  for (const w of want) {
    const hit = pick.find((p) => (w === "" ? path.dirname(p) === dir : path.basename(path.dirname(p)) === w));
    if (hit && !chosen.includes(hit)) chosen.push(hit);
  }
  const work = pick.find((p) => {
    const parts = path.relative(dir, p).split(path.sep);
    return parts.length === 3 && parts[0] === "works" && parts[2] === "index.html";
  });
  if (work && !chosen.includes(work)) chosen.push(work);
  return chosen
    .map((p) => {
      const h = fs.readFileSync(p, "utf8").replace(/<svg[\s\S]*?<\/svg>/g, "<svg>…</svg>");
      return `<!-- ${path.relative(dir, p).split(path.sep).join("/")} -->\n${h.slice(0, 3500)}`;
    })
    .join("\n\n");
}

export async function designCommand(args: string[]): Promise<number> {
  const [sub] = args;
  const root = paths.root;
  if (sub === "check") {
    const r = runDesignChecks(root);
    console.log(formatDesignCheck(r));
    const out = arg(args, "--json-out");
    if (out) fs.writeFileSync(out, JSON.stringify(r, null, 2) + "\n", "utf8");
    return r.ok ? 0 : 3;
  }
  if (sub === "generate") {
    const siteSrc = path.join(root, "site", "src");
    const sampleDir = arg(args, "--sample-dir") ?? path.join(root, "site", "dist");
    const reqMd = fs.readFileSync(path.join(root, "design", "REQUIREMENTS.md"), "utf8");
    const tokens = JSON.parse(fs.readFileSync(path.join(siteSrc, "design", "tokens.json"), "utf8"));
    const readOr = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
    const inputs = {
      requirementsText: sectionOf(reqMd, "### 6.4 デザイン原則と基準", "### 6.5"),
      classList: readOr(path.join(siteSrc, "design", "CLASSES.md")),
      sampleHtml: sampleHtml(sampleDir),
      baseCss: readOr(path.join(siteSrc, "styles", "base.css")) + "\n" + readOr(path.join(siteSrc, "styles", "figures.css")),
      tokensTypes: readOr(path.join(siteSrc, "design", "tokens-types.ts")),
      // Variable NAMES only (values hidden) so Haiku chooses every value itself instead of copying the
      // current tokens (the first run copied the orchestrator's placeholder values; CP-026).
      cssVarTable: tokensToCss(tokens).replace(/(--[\w-]+):\s*[^;]+;/g, "$1: <tokens の値>;"),
    };
    if (!inputs.classList || !inputs.sampleHtml) {
      console.error("design generate needs site/src/design/CLASSES.md and a built site (site/dist or --sample-dir).");
      return 3;
    }
    const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
    const { final, record } = await generateDesign({ haiku: getModelPort("haiku"), luna: getModelPort("luna"), inputs, log });
    if (args.includes("--dry-run")) {
      console.log(JSON.stringify({ final, record }, null, 2));
      return 0;
    }
    writeDesign(siteSrc, final, record);
    const r = runDesignChecks(root);
    console.log(formatDesignCheck(r));
    return r.ok ? 0 : 3;
  }
  console.error("usage: sfsh design check [--json-out <file>] | sfsh design generate [--sample-dir <dist>] [--dry-run]");
  return 2;
}
