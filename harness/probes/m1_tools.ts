// M1: live check of luna tool modes through ModelPort (CP-016). usage: npx tsx harness/probes/m1_tools.ts
import { getModelPort } from "../src/model/index.ts";
const schema = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } };
const port = getModelPort("luna");
for (const tools of ["none", "web_search"] as const) {
  const r = await port.call({
    task: `m1.tools.${tools}`,
    prompt: "Use web search (one search) to find the year the TV anime 魔法少女まどか☆マギカ first aired. If you cannot search, answer UNKNOWN.",
    schema,
    tools,
    timeoutMs: 300000,
  });
  const ws = r.toolEvents?.webSearch ?? [];
  console.log(JSON.stringify({ tools, answer: r.output, reportedModelId: r.reportedModelId, searches: ws.filter((e) => e.action === "search").length, results: ws.reduce((n, e) => n + e.results.length, 0), otherToolItems: r.toolEvents?.otherToolItems, ms: r.durationMs }));
}
