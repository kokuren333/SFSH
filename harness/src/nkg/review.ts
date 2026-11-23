/**
 * Reusable cross-review loop (REQUIREMENTS §3.3). The reviewer returns findings only; the author answers
 * every finding with `revised` or `declined` + reason. Used by S2 (fact / interp layers) and S3 (gen/).
 * S1 claim review (research/claimReview.ts) runs its own batched loop with the same semantics.
 *
 * Semantics (WP-2.1, at most REVIEW_MAX_ROUNDS = 2 rounds):
 *  - round k: the reviewer returns findings on the *current* state → the author revises and answers each
 *    finding (revised | declined + reason). Unanswered findings count as declined.
 *  - round k+1 reviews the revised state again (a fresh review: it can re-raise a finding or raise new ones;
 *    it is shown the earlier findings and answers via the optional `prior` argument).
 *  - the loop stops early when a review returns no findings.
 *  - after the last round, per element of the final state: never targeted → `agreed`; otherwise only the
 *    LAST round that targeted it counts — every finding there answered `revised` → `revised` (resolved), any
 *    declined / unanswered → `disputed` (unresolved). Only a re-raised finding can be answered again: a
 *    finding declined in round 1 that round 2 does not re-raise stays unresolved; an element revised in round 1
 *    and not targeted in round 2 stays `revised`.
 *  - `unresolved` lists, per disputed element, the unresolved findings of that last round. Callers apply
 *    C-2: an element whose unresolved types include `copied_phrase` is deleted (`copiedPhraseTargets`);
 *    other unresolved types (`too_concrete` especially) stay and go to `advisory` (`advisoryFrom`, §5.2).
 *  - `disputed` lowers the deterministic confidence by one grade (confidence.ts, §2.3).
 */
import type { ReviewState } from "./types.ts";

/** Max review rounds everywhere (S1 claims, S1 follow-up claims, S2 fact / interp, S3 pages). §3.3-2. */
export const REVIEW_MAX_ROUNDS = 2;

export const FINDING_TYPES = ["unsupported", "overreach", "too_concrete", "copied_phrase", "misclassified", "missing", "contradiction"] as const;
export type FindingType = (typeof FINDING_TYPES)[number];
export type Severity = "low" | "medium" | "high";

export interface RawFinding {
  target_id: string;
  type: FindingType;
  severity: Severity;
  evidence: string;
}
export interface Finding extends RawFinding {
  finding_id: string;
}
export interface FindingResponse {
  finding_id: string;
  action: "revised" | "declined";
  reason: string;
}
export interface ReviewRound {
  round: number;
  findings: Finding[];
  responses: FindingResponse[];
}
/** An element of the final state left `disputed`, with the unresolved findings of the last round that targeted it. */
export interface UnresolvedEntry {
  target_id: string;
  types: FindingType[];
  findings: Finding[];
}
/** Advisory record (§3.3-2, §5.2): unresolved findings that do not delete the element. Picked up by S4. */
export interface AdvisoryEntry {
  target_id: string;
  type: FindingType;
  severity: Severity;
  evidence: string;
  round: number;
}
export interface ReviewOutcome<S> {
  state: S;
  rounds: ReviewRound[];
  status: Record<string, ReviewState>;
  counts: { findings: number; revised: number; declined: number; unanswered: number; rounds: number };
  /** WP-2.1: disputed elements of the final state and their unresolved findings (always filled by runReviewLoop). */
  unresolved?: UnresolvedEntry[];
}
export interface ReviseInfo {
  /** True for the last round allowed by maxRounds (unresolved findings stay unresolved after this). */
  last: boolean;
  maxRounds: number;
}

export const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target_id", "type", "severity", "evidence"],
        properties: {
          target_id: { type: "string" },
          type: { type: "string", enum: [...FINDING_TYPES] },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;

export const RESPONSES_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["finding_id", "action", "reason"],
    properties: {
      finding_id: { type: "string" },
      action: { type: "string", enum: ["revised", "declined"] },
      reason: { type: "string" },
    },
  },
} as const;

export async function runReviewLoop<S>(opts: {
  initial: S;
  maxRounds: number;
  /** Ids of elements in a state (for the status map). */
  ids: (s: S) => string[];
  /** `prior` = completed earlier rounds (findings + answers), for round ≥ 2 prompts. */
  review: (s: S, round: number, prior: ReviewRound[]) => Promise<RawFinding[]>;
  revise: (s: S, findings: Finding[], round: number, info: ReviseInfo) => Promise<{ state: S; responses: FindingResponse[] }>;
}): Promise<ReviewOutcome<S>> {
  let state = opts.initial;
  const rounds: ReviewRound[] = [];
  const maxRounds = Math.max(0, opts.maxRounds);
  for (let round = 1; round <= maxRounds; round++) {
    const raw = await opts.review(state, round, rounds.slice());
    const findings: Finding[] = (raw ?? []).map((f, i) => ({ ...f, finding_id: `r${round}f${String(i + 1).padStart(2, "0")}` }));
    if (!findings.length) {
      rounds.push({ round, findings, responses: [] });
      break;
    }
    const res = await opts.revise(state, findings, round, { last: round === maxRounds, maxRounds });
    state = res.state;
    const known = new Set(findings.map((f) => f.finding_id));
    const responses: FindingResponse[] = [];
    const seen = new Set<string>();
    for (const r of res.responses ?? []) {
      if (!r || !known.has(r.finding_id) || seen.has(r.finding_id)) continue;
      seen.add(r.finding_id);
      responses.push(r);
    }
    rounds.push({ round, findings, responses });
  }

  // status per element: decided by the last round that targeted it
  const status: Record<string, ReviewState> = {};
  for (const id of opts.ids(state)) status[id] = "agreed";
  let revised = 0;
  let declined = 0;
  let unanswered = 0;
  const lastRoundFor = new Map<string, ReviewRound>();
  for (const r of rounds) for (const f of r.findings) lastRoundFor.set(f.target_id, r);
  for (const r of rounds) {
    for (const f of r.findings) {
      const resp = r.responses.find((x) => x.finding_id === f.finding_id);
      if (!resp) unanswered++;
      else if (resp.action === "revised") revised++;
      else declined++;
    }
  }
  const unresolved: UnresolvedEntry[] = [];
  for (const [target, r] of lastRoundFor) {
    if (!(target in status)) continue;
    const open = r.findings.filter((f) => {
      if (f.target_id !== target) return false;
      const resp = r.responses.find((x) => x.finding_id === f.finding_id);
      return !resp || resp.action === "declined";
    });
    status[target] = open.length ? "disputed" : "revised";
    if (open.length) unresolved.push({ target_id: target, types: [...new Set(open.map((f) => f.type))], findings: open });
  }
  const findings = rounds.reduce((n, r) => n + r.findings.length, 0);
  return { state, rounds, status, counts: { findings, revised, declined, unanswered, rounds: rounds.length }, unresolved };
}

/** Ids whose unresolved findings include `copied_phrase` → delete them (C-2, §3.3-2). */
export function copiedPhraseTargets(unresolved: UnresolvedEntry[] | undefined): string[] {
  return (unresolved ?? []).filter((u) => u.types.includes("copied_phrase")).map((u) => u.target_id);
}

/** Unresolved findings of elements that are kept (everything except deleted targets) → advisory (§5.2). */
export function advisoryFrom(unresolved: UnresolvedEntry[] | undefined, deleted: Iterable<string> = []): AdvisoryEntry[] {
  const gone = new Set(deleted);
  const out: AdvisoryEntry[] = [];
  for (const u of unresolved ?? []) {
    if (gone.has(u.target_id)) continue;
    for (const f of u.findings) out.push({ target_id: u.target_id, type: f.type, severity: f.severity, evidence: f.evidence, round: Number(/^r(\d+)/.exec(f.finding_id)?.[1] ?? 0) });
  }
  return out;
}

/** Responses with code-filled entries for unanswered findings (for the saved review file). */
export function completedResponses(r: ReviewRound): FindingResponse[] {
  return r.findings.map(
    (f) => r.responses.find((x) => x.finding_id === f.finding_id) ?? { finding_id: f.finding_id, action: "declined", reason: NO_RESPONSE_REASON },
  );
}
export const NO_RESPONSE_REASON = "no_response (treated as declined by code)";

// ------------------------------------------------------------------ prompt additions (shared by S2 / S3)
/** Appended to a round ≥ 2 review prompt: the earlier findings and the author's answers. */
export function priorRoundsBlock(prior: ReviewRound[], round: number, maxRounds: number): string {
  if (!prior.length) return "";
  const lines = [
    "",
    `# 前回までの指摘と作成側の回答（今回は第${round}回レビュー${round >= maxRounds ? "で、これが最後" : ""}）`,
    "- 上の対象は作成側が直したあとの状態です。改めてレビューしてください。",
    "- まだ問題が残っているもの（前回 declined されたものを含む）は、もう一度指摘してください。作成側がもう一度直す機会になります。指摘し直さなかった declined の指摘は未解決のまま残ります。",
    "- 解消した問題は指摘しないでください。新しい問題があれば指摘してください。",
    "- 最後の対応のあとも未解決の指摘が残った要素は disputed（信頼度1段下げ）になり、copied_phrase が未解決の要素は削除されます。",
  ];
  for (const r of prior) {
    for (const f of r.findings) {
      const resp = r.responses.find((x) => x.finding_id === f.finding_id);
      lines.push(`- 第${r.round}回 ${f.finding_id} [${f.type}] 対象 ${f.target_id}: ${f.evidence} → ${resp ? `${resp.action}（${resp.reason}）` : "回答なし"}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Appended to the author's revision prompt in the last allowed round. */
export function lastRoundNote(round: number, maxRounds: number): string {
  if (round < maxRounds) return `\n# 往復\n- これは第${round}回の対応です（最大${maxRounds}往復）。対応後にもう一度レビューがあります。\n`;
  return `\n# 往復\n- これは第${round}回で最後の対応です。declined のまま残った指摘の要素は disputed（信頼度1段下げ）になり、copied_phrase の指摘が未解決の要素は削除されます。copied_phrase は必ず自分の言葉で言い換えて revised にしてください。\n`;
}
