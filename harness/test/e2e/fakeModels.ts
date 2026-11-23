/**
 * Fake luna / haiku ModelPorts for the job e2e test. Routed by `req.task`; every output is validated against the
 * request schema (luna schemas must be OpenAI-strict). Luna's web_search calls return captured-style events.
 */
import type { ModelPort, ModelRequest, ModelResult, PortName, WebSearchEvent } from "../../src/model/types.ts";
import { strictSchemaViolations, validateAgainst } from "../../src/model/validate.ts";
import { fillGroup, mEdge, mNode } from "../../src/nkg/testFixtures.ts";
import { sourceIdFor } from "../../src/research/fetch/index.ts";
import { CREATOR, PAGES, READING, TITLE, type PageDef } from "./fixture.ts";

export interface FakeCall {
  port: PortName;
  req: ModelRequest;
}

export interface FakeModels {
  luna: ModelPort;
  haiku: ModelPort;
  calls: FakeCall[];
  /** claim tag → claim id, in emission order (ids are assigned c0001.. in the same order by extractClaims). */
  claimIds: Map<string, string>;
  /** Path Luna "remembers" and returns although no search event contains it. */
  selfReportedPath: string;
}

export function makeFakeModels(base: string): FakeModels {
  const u = (p: string) => base + p;
  const calls: FakeCall[] = [];
  const claimIds = new Map<string, string>();
  const selfReportedPath = "/remembered/hoshifuru-full.html";
  const sidToPage = new Map<string, PageDef>(Object.values(PAGES).map((p) => [sourceIdFor(u(p.path)), p]));
  const T = (tag: string): string => {
    const id = claimIds.get(tag);
    if (!id) throw new Error(`fake: claim ${tag} not emitted yet`);
    return id;
  };
  const result = (port: PortName, output: unknown, webSearch?: WebSearchEvent[]): ModelResult => ({
    output,
    modelId: `fake-${port}`,
    reportedModelId: `fake-${port}-reported`,
    toolEvents: port === "luna" ? { webSearch: webSearch ?? [], otherToolItems: 0, otherToolTypes: [] } : undefined,
    durationMs: 1,
    tokens: {},
  });
  const searchEvent = (itemId: string, query: string, paths: string[]): WebSearchEvent => ({
    itemId,
    action: "search",
    query,
    url: null,
    results: paths.map((p) => ({ url: u(p), title: Object.values(PAGES).find((x) => x.path === p)?.title ?? p, domain: "127.0.0.1", snippet: "" })),
  });
  const sel = (p: string, tier: string | null, aspects: string[] = ["bibliographic"]) => ({ url: u(p), why: "検索結果から選択", aspects, tier_suggested: tier });

  function lunaWeb(req: ModelRequest): { output: unknown; events: WebSearchEvent[] } {
    switch (req.task) {
      case "s0.identify.search":
        return {
          events: [searchEvent("ws-s0-1", "星降る灯台 小説", [PAGES.official.path, PAGES.library.path])],
          output: {
            selections: [
              { url: u(PAGES.official.path), why: "版元の作品ページ", tier_suggested: "T1" },
              { url: u(PAGES.library.path), why: "書誌データベース", tier_suggested: "T2" },
            ],
          },
        };
      case "s1.search.r1":
        return {
          events: [
            searchEvent("ws-r1-1", `${TITLE} 全文`, ["/pirate/raw.html", "/private/secret.html", "/missing.html", "/cover.png"]),
            searchEvent("ws-r1-2", `${TITLE} あらすじ 書評`, [PAGES.encyclopedia.path, PAGES.critic.path, PAGES.interview.path]),
          ],
          output: {
            selections: [
              sel("/pirate/raw.html", "T5"),
              sel("/private/secret.html", "T4"),
              sel("/missing.html", "T3"),
              sel("/cover.png", "T1"),
              sel(PAGES.encyclopedia.path, "T3", ["M01", "M03"]),
              sel(PAGES.critic.path, "T2", ["M10", "M12"]),
              sel(PAGES.interview.path, "T2", ["M06", "M10"]),
              sel(selfReportedPath, "T1", ["M03"]), // not in any event → must be rejected, never fetched
            ],
            notes: null,
          },
        };
      case "s1.search.r1.supplement": {
        // code-driven supplement (CP-029 finding a): one aspect per call. For M02 Luna re-finds the encyclopedia page
        // already fetched in r1 (the harness must not GET it again); other aspects find nothing.
        const aspect = /## 調べる観点（この1つだけ）\n- (\S+)/.exec(req.prompt)?.[1] ?? "?";
        if (aspect === "M02")
          return {
            events: [searchEvent("ws-r1s-1", `${TITLE} 結末 理由`, [PAGES.encyclopedia.path])],
            output: { selections: [sel(PAGES.encyclopedia.path, "T3", ["M02"])], notes: null },
          };
        return { events: [searchEvent(`ws-r1s-${aspect}`, `${TITLE} ${aspect}`, [])], output: { selections: [], notes: "見つからない" } };
      }
      case "s1.search.plot":
        // AMENDMENT 12 plot frame: nothing found in this fixture
        return { events: [], output: { selections: [], notes: "見つからない" } };
      case "s1.followup.r1":
      case "s1.followup.r2":
      case "s1.followup.r3":
        // AMENDMENT 12 claim-coverage rounds: the fixture has no synopsis pages
        return { events: [], output: { selections: [], notes: "見つからない" } };
      case "s1.gapfill.r1":
      case "s1.gapfill.r2": {
        // AMENDMENT 12 post-NKG round: Haiku's "missing" M07 target finds the essay / fan pages (the old r2 result)
        if (!req.prompt.includes("不足している点（この1つだけ）\n- M07")) return { events: [], output: { selections: [], notes: "見つからない" } };
        return {
          events: [searchEvent("ws-r2-1", `${TITLE} 成長 結末`, [PAGES.essay.path, PAGES.fan1.path, PAGES.fan2.path])],
          output: {
            selections: [sel(PAGES.essay.path, "T4", ["M07"]), sel(PAGES.fan1.path, "T4", ["M07"]), sel(PAGES.fan2.path, "T4", ["M07"])],
            notes: null,
          },
        };
      }
      case "s1.search.r2":
        return {
          events: [searchEvent("ws-r2-1", `${TITLE} 成長 結末`, [PAGES.essay.path, PAGES.fan1.path, PAGES.fan2.path])],
          output: {
            selections: [sel(PAGES.essay.path, "T4", ["M07"]), sel(PAGES.fan1.path, "T4", ["M07"]), sel(PAGES.fan2.path, "T4", ["M07"])],
            notes: null,
          },
        };
      default:
        throw new Error(`fake luna: unexpected web_search task ${req.task}`);
    }
  }

  function claimsFor(prompt: string): unknown {
    const out: unknown[] = [];
    for (const m of prompt.matchAll(/<source id="(s[0-9a-f]+)"/g)) {
      const page = sidToPage.get(m[1]);
      if (!page) throw new Error(`fake luna: unknown source ${m[1]} in claims prompt`);
      for (const c of page.claims) {
        claimIds.set(c.tag, "c" + String(claimIds.size + 1).padStart(4, "0"));
        out.push({
          source_id: m[1],
          text: c.text,
          evidence_quote: c.quote,
          aspects: c.aspects,
          epistemic: c.epistemic ?? "canon",
          phase_hint: c.phase ?? "unknown",
          spoiler: c.spoiler ?? "none",
          entities: c.entities ?? [],
          story_unit: null,
          characters: [],
        });
      }
    }
    return { claims: out };
  }

  function luna(req: ModelRequest): unknown {
    const g = (partial: Record<string, unknown[]>) => fillGroup(req.schema, partial);
    switch (req.task) {
      case "s0.identify.extract":
        return {
          candidates: [
            {
              title: TITLE,
              title_original: null,
              title_reading: READING,
              medium: "novel",
              creators: [CREATOR],
              first_release_year: 2001,
              evidence: [
                { source_id: sourceIdFor(u(PAGES.official.path)), quote: `『${TITLE}』は${CREATOR}による長編小説` },
                { source_id: sourceIdFor(u(PAGES.library.path)), quote: `書名：${TITLE}` },
              ],
              aliases_seen: [],
            },
          ],
        };
      case "s1.claims":
        return claimsFor(req.prompt);
      case "s2.genre":
        return { genres: [{ genre: "ensemble", reason: "島の住民を並行して描く", claim_refs: [T("o3")] }] };
      case "s2.phases":
        return {
          phases: [
            { label: "異変", order: 1, scope: "灯が消え始める", claim_refs: [T("e3")] },
            { label: "調査", order: 2, scope: "記録と測量で原因を探る", claim_refs: [T("e4"), T("n2")] },
            { label: "再点灯", order: 3, scope: "島に光が戻る", claim_refs: [T("e5")] },
          ],
        };
      case "s2.fact.events":
        return g({
          events: [
            mNode({ id: "ev01", label: "流星の夜の消灯", claim_refs: [T("e3")], phase_ref: "ph1", story_order: 1, disclosure_phase: null }),
            mNode({ id: "ev02", label: "日誌と測量による調査", claim_refs: [T("e4"), T("n2")], phase_ref: "ph2", story_order: 2, disclosure_phase: null }),
            mNode({ id: "ev03", label: "灯台の再点火", claim_refs: [T("e5"), T("n3")], phase_ref: "ph3", spoiler: "ending", story_order: 3, disclosure_phase: null }),
          ],
          causes: [
            mEdge({ id: "cs01", from: "ev01", to: "ev02", kind: "motivates", claim_refs: [T("e4")] }),
            mEdge({ id: "cs02", from: "ev02", to: "ev03", kind: "enables", claim_refs: [T("n2")] }),
          ],
        });
      case "s2.fact.people":
        return g({
          characters: [
            mNode({ id: "ch01", label: "朝凪ミオ", claim_refs: [T("o2"), T("e1")] }),
            mNode({ id: "ch02", label: "久遠", claim_refs: [T("e1")] }),
            mNode({ id: "ch03", label: "灰原", claim_refs: [T("e2")] }),
          ],
          factions: [mNode({ id: "fa01", label: "島の住民", claim_refs: [T("n3")] })],
          relations: [
            mEdge({ id: "rl01", from: "ch02", to: "ch01", kind: "養育", valence: "positive", phase_from: null, phase_to: null, changed_by: null, claim_refs: [T("e1")] }),
            mEdge({ id: "rl02", from: "ch01", to: "ch03", kind: "反発", valence: "negative", phase_from: "ph1", phase_to: "ph2", changed_by: null, claim_refs: [T("n5")] }),
            mEdge({ id: "rl03", from: "ch01", to: "ch03", kind: "信頼", valence: "positive", phase_from: "ph2", phase_to: null, changed_by: "ev02", claim_refs: [T("n5")] }),
          ],
        });
      case "s2.fact.world":
        return g({
          contexts: [
            mNode({ id: "cx01", label: "文学賞の受賞", kind: "award", claim_refs: [T("r2")] }),
            mNode({ id: "cx02", label: "語り口への好評", kind: "reception", claim_refs: [T("r3")], epistemic: "consensus" }),
            mNode({ id: "cx03", label: "舞台版", kind: "influence", claim_refs: [T("n4")] }),
          ],
          about: [mEdge({ id: "ab01", from: "cx01", to: "work", claim_refs: [T("r2")] }), mEdge({ id: "ab02", from: "cx02", to: "work", claim_refs: [T("r3")], epistemic: "consensus" })],
        });
      case "s2.interp.review":
        return { findings: [] };
      default:
        return undefined;
    }
  }

  function haiku(req: ModelRequest): unknown {
    const g = (partial: Record<string, unknown[]>) => fillGroup(req.schema, partial);
    switch (req.task) {
      case "s1.claims.review":
        return {
          findings: [
            { target_id: null, type: "missing", severity: "medium", evidence: "人物の変化を扱う claim が少ない", missing_aspect: "M07", suggested_query: `${TITLE} 主人公 成長` },
          ],
        };
      case "s2.modules.review":
        return { additions: [], removals: [] };
      case "s2.phases.review":
      case "s2.fact.review":
        return { findings: [] };
      case "s2.interp.reverse_plot":
        return g({
          outcomes: [mNode({ id: "oc01", label: "島に光が戻る", claim_refs: [T("e5")], phase_ref: "ph3", spoiler: "ending" })],
          whys: [
            mNode({ id: "wy01", label: "住民の協力", level: "direct", factor_kind: "social", claim_refs: [T("n3")], based_on: ["fa01"] }),
            mNode({ id: "wy02", label: "育ての親の不在による責任", level: "factor", factor_kind: "psychological", claim_refs: [T("n1")], based_on: ["ch02"] }),
          ],
          explains: [
            mEdge({ id: "xp01", from: "wy01", to: "oc01", refs: ["ev03"], claim_refs: [T("n3")] }),
            mEdge({ id: "xp02", from: "wy02", to: "oc01", refs: [], claim_refs: [T("n1")] }),
          ],
        });
      case "s2.interp.motives_arcs":
        return g({
          motives: [
            mNode({ id: "mo01", label: "約束を果たす", owner: "ch01", kind: "goal", phase_from: null, phase_to: null, claim_refs: [T("i1")] }),
            mNode({ id: "mo02", label: "島が忘れられる恐れ", owner: "ch03", kind: "fear", phase_from: null, phase_to: null, claim_refs: [T("i2"), T("x2")] }),
          ],
          drives: [mEdge({ id: "dr01", from: "mo01", to: "ev03", claim_refs: [T("i1")] })],
          conflicts: [mEdge({ id: "cw01", from: "mo01", to: "mo02", epistemic: "sfsh_analysis", based_on: ["mo01", "mo02"] })],
        });
      case "s2.interp.themes_emotion":
        return g({
          themes: [
            mNode({ id: "th01", label: "記憶の継承", question: "受け継いだ記憶を背負えるか", values: ["継承", "自由"], tension: "託されたものと自分の選択", claim_refs: [T("r1"), T("i3")], epistemic: "consensus" }),
            mNode({ id: "th02", label: "孤独と共同体", question: "人は独りで役目を負えるか", values: ["自立", "連帯"], tension: "独りで守ることと皆で守ること", claim_refs: [T("r4")], epistemic: "consensus" }),
          ],
          embodies: [mEdge({ id: "em01", from: "ch01", to: "th01", claim_refs: [T("i3")] }), mEdge({ id: "em02", from: "ev03", to: "th02", claim_refs: [T("n3")] })],
        });
      case "s2.interp.extras":
        return g({
          iconic_moments: [mNode({ id: "im01", label: "再点火", event_ref: "ev03", why_famous: "受賞評で語り口とともに挙げられる", context_refs: ["cx02"], claim_refs: [T("r3"), T("e5")], spoiler: "ending" })],
          interpretations: [
            mNode({
              id: "ip01",
              label: "灯が意味するもの",
              topic: "灯台の明かりは何を表すか",
              claim_refs: [],
              positions: [
                { claim: "作中では島の存続そのものとして描かれる", epistemic: "canon", claim_refs: [T("e5")] },
                { claim: "記憶の継承を表すという評価", epistemic: "consensus", claim_refs: [T("r1")] },
                { claim: "記憶そのものの象徴という読み", epistemic: "fan_theory", claim_refs: [T("x1")] },
              ],
            }),
          ],
          quizzes: [
            mNode({ id: "qz01", label: "再点火の条件", question: "なぜ最後に灯をともすことができたのか", answer: "住民が燃料を出し合ったから", reasoning_refs: ["wy01", "ev03"], quiz_type: "causal", epistemic: "sfsh_analysis", based_on: ["wy01"] }),
          ],
        });
      default:
        return undefined;
    }
  }

  function port(name: PortName): ModelPort {
    return {
      port: name,
      modelId: `fake-${name}`,
      async call(req: ModelRequest): Promise<ModelResult> {
        calls.push({ port: name, req });
        if (name === "luna") {
          const v = strictSchemaViolations(req.schema);
          if (v.length) throw new Error(`fake luna: non-strict schema for ${req.task}: ${v.slice(0, 3).join("; ")}`);
        } else if (req.tools && req.tools !== "none") throw new Error(`fake haiku: ${req.task} must not use tools`);
        let output: unknown;
        let events: WebSearchEvent[] | undefined;
        if (name === "luna" && req.tools === "web_search") ({ output, events } = lunaWeb(req));
        else if (name === "luna") {
          if (req.tools !== "none") throw new Error(`fake luna: ${req.task} must use tools "none" (got ${req.tools})`);
          output = luna(req);
        } else output = haiku(req);
        if (output === undefined) throw new Error(`fake ${name}: no canned output for ${req.task}`);
        const ok = validateAgainst(req.schema, output);
        if (!ok.ok) throw new Error(`fake ${name}: canned output for ${req.task} violates schema: ${ok.summary}`);
        return result(name, output, events);
      },
    };
  }

  return { luna: port("luna"), haiku: port("haiku"), calls, claimIds, selfReportedPath };
}
