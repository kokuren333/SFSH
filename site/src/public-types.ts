/**
 * Shape of `works/<work_id>/gen/public.json` — the ONLY per-work input the site renderer reads
 * (REQUIREMENTS v1.3 §2.6, §6.3-2). Fixed by the orchestrator (CP-024, logs/m2/PLAN.md §2).
 *
 * Producers: harness S3 (`harness/src/gen/`): project (deterministic) → write (Haiku, reviewed by Luna) → compose.
 * Consumer: site renderer (`site/src/`), through `site/.input/works/<work_id>/public.json` only.
 *
 * Rules (2.6): only display fields of elements that meet the public condition (validation.json
 * public_eligible), plus bibliographic data of sources (title, publisher, URL, accessed date, tier, license).
 * Never: excerpts, raw text, claims, internal notes, review history, rejected elements, check results,
 * authored_by/reviewed_by, model ids, local paths.
 *
 * Erasable TypeScript only (types/interfaces). No runtime code in this file.
 */

export type Medium = "novel" | "manga" | "anime" | "film" | "drama" | "game" | "other";
export type Epistemic = "canon" | "consensus" | "fan_theory" | "sfsh_analysis";
export type Grade = "A" | "B" | "C" | "D";
export type Spoiler = "none" | "mid" | "ending";
export type WorkStatus = "completed" | "ongoing" | "unknown";
export type Valence = "positive" | "negative" | "ambivalent" | "neutral";
export type KnowState = "unknown" | "suspects" | "misbelieves" | "knows";

export interface PublicPhase {
  id: string; // "ph1"
  label: string; // "序盤"
  order: number; // 1-based
}

/** Common display fields of every public element. */
export interface PublicElementBase {
  id: string;
  epistemic: Epistemic;
  grade: Grade;
  spoiler: Spoiler;
  /** Public source ids (subset of PublicWork.sources). */
  source_refs: string[];
}

export interface PublicCharacter extends PublicElementBase {
  label: string;
  summary: string | null;
  /** Faction id when the character belongs to one (nullable). */
  faction: string | null;
  /** Rank for "default N shown" in figure A: 1 = most central (degree-based, deterministic). */
  prominence: number;
}

export interface PublicRelation extends PublicElementBase {
  from: string; // character id
  to: string; // character id
  /** Short relation label (≤10 chars recommended; renderer truncates visually, never the data). */
  kind: string;
  valence: Valence;
  /** Inclusive phase interval in which the relation holds (phase ids). null = from first / to last phase. */
  phase_from: string | null;
  phase_to: string | null;
  /** Event label that changed the relation (display only), or null. */
  changed_by_label: string | null;
}

/** Figure A data: characters + relations with phase intervals. */
export interface VizRelations {
  characters: PublicCharacter[];
  relations: PublicRelation[];
  /** Factions referenced by characters (CP-026). */
  factions: { id: string; label: string }[];
}

/** Figure B node (reverse plot). Root = Outcome (the ending). */
export interface PlotNode {
  id: string;
  kind: "outcome" | "why";
  level: "outcome" | "direct" | "factor" | "root";
  /** Only for kind="why". */
  factor_kind: "political" | "psychological" | "social" | "chance" | "rule" | null;
  label: string;
  summary: string | null;
  /** S2 analysis text (sfsh_analysis prose), or null (CP-026). */
  analysis: string | null;
  epistemic: Epistemic;
  grade: Grade;
  spoiler: Spoiler;
  children: PlotNode[];
}

/** Figure B data: one tree per Outcome (ordered by importance). Empty array = no public tree. */
export interface VizReversePlot {
  trees: PlotNode[];
}

/** Figure C data (only when M05 is enabled and has public secrets). */
export interface VizMatrix {
  /** Rows. */
  secrets: { id: string; label: string; epistemic: Epistemic; grade: Grade; spoiler: Spoiler }[];
  /** Columns: characters, then the reader column (id "audience", is_audience=true) — always present. */
  holders: { id: string; label: string; is_audience: boolean }[];
  /** Sparse cells; a missing cell in a phase = "no information" (renderer shows a neutral mark, not "unknown"). */
  cells: { secret: string; holder: string; phase: string; state: KnowState }[];
}

/** Optional timeline (M04 double axis): main events only. */
export interface VizTimeline {
  events: { id: string; label: string; story_order: number; disclosure_phase: string | null; spoiler: Spoiler }[];
}

/** A block of page text written by Haiku and reviewed by Luna (S3). Plain text only (no markup). */
export interface TextBlock {
  id: string;
  heading: string | null;
  paragraphs: string[];
  spoiler: Spoiler;
  /** Public element ids the block rests on (links / "根拠" display). */
  based_on: string[];
  epistemic: Epistemic;
}

/**
 * AMENDMENT 11: 「あらすじ（全編・ネタバレ）」 — a chronological retelling from the opening to the ending, by chapter
 * (each chapter = heading + sections; a section is a TextBlock whose heading is the subheading). Fact-layer prose.
 */
export interface SynopsisChapter {
  id: string; // "syn_c01"
  heading: string;
  blocks: TextBlock[];
}
export interface SynopsisPage {
  intro: TextBlock[];
  chapters: SynopsisChapter[];
}

export interface QuizItem {
  id: string;
  quiz_type: "causal" | "motive" | "counterfactual";
  question: string;
  answer: string;
  /** Short explanation (why the answer follows). */
  explanation: string;
  based_on: string[];
  spoiler: Spoiler;
}

export interface InterpretationItem {
  id: string;
  topic: string;
  positions: { claim: string; epistemic: "canon" | "consensus" | "fan_theory"; source_refs: string[] }[];
  spoiler: Spoiler;
}

export interface ThemeItem {
  id: string;
  label: string;
  question: string;
  tension: string;
  values: string[];
  summary: string | null;
  analysis: string | null;
  epistemic: Epistemic;
  grade: Grade;
  spoiler: Spoiler;
  source_refs: string[];
}

export interface ContextItem {
  id: string;
  kind: "reception" | "award" | "influence" | "symbolism" | "controversy";
  label: string;
  summary: string | null;
  analysis: string | null;
  epistemic: Epistemic;
  grade: Grade;
  spoiler: Spoiler;
  source_refs: string[];
}

export interface IconicItem {
  id: string;
  label: string;
  why_famous: string;
  analysis: string | null;
  epistemic: Epistemic;
  grade: Grade;
  spoiler: Spoiler;
  source_refs: string[];
}

/** CP-026: element sections that are not figures (C-1: what happened / who wanted what and changed how). */
export interface PublicEvent {
  id: string;
  label: string;
  summary: string | null;
  story_order: number | null;
  phase_ref: string | null;
  epistemic: Epistemic;
  grade: Grade;
  spoiler: Spoiler;
  source_refs: string[];
  /** Public Causes edges where this event is the effect / the cause. */
  caused_by: { event: string; kind: "causes" | "enables" | "motivates" | "prevents" }[];
  leads_to: { event: string; kind: "causes" | "enables" | "motivates" | "prevents" }[];
}

export interface PublicMotive {
  id: string;
  owner: string; // character id
  kind: "goal" | "fear" | "belief" | "conflict";
  label: string;
  summary: string | null;
  analysis: string | null;
  phase_from: string | null;
  phase_to: string | null;
  /** Public event ids this motive drives (Drives edges). */
  drives: string[];
  /** Public motive ids this one conflicts with (ConflictsWith edges). */
  conflicts_with: string[];
  epistemic: Epistemic;
  grade: Grade;
  spoiler: Spoiler;
  source_refs: string[];
}

export interface PublicArc {
  id: string;
  character: string; // character id
  arc_type: string;
  label: string;
  initial_state: string;
  final_state: string;
  summary: string | null;
  analysis: string | null;
  /** Public event ids where the arc turns (TurnsAt edges). */
  turns_at: string[];
  epistemic: Epistemic;
  grade: Grade;
  spoiler: Spoiler;
  source_refs: string[];
}

export interface PublicWorldRule {
  id: string;
  kind: "constraint" | "ability" | "institution";
  label: string;
  summary: string | null;
  consequence: string;
  /** Public event / character ids it constrains (Constrains edges). */
  constrains: string[];
  epistemic: Epistemic;
  grade: Grade;
  spoiler: Spoiler;
  source_refs: string[];
}

export interface PublicSetup {
  id: string;
  label: string;
  meaning: string;
  /** Public event ids that pay it off (PaysOff edges). */
  pays_off: string[];
  epistemic: Epistemic;
  grade: Grade;
  spoiler: Spoiler;
  source_refs: string[];
}

export interface PublicEmotionBeat {
  id: string;
  phase: string;
  emotion: string;
  intensity: number; // 1-5
  label: string;
  summary: string | null;
  /** Public event ids that evoke it (Evokes edges) or cause_refs. */
  evoked_by: string[];
  epistemic: Epistemic;
  grade: Grade;
  spoiler: Spoiler;
  source_refs: string[];
}

export interface PublicSource {
  source_id: string;
  title: string;
  publisher: string | null;
  url: string;
  /** Accessed date YYYY-MM-DD (from fetched_at). */
  accessed: string;
  tier: "T1" | "T2" | "T3" | "T4" | "T5";
  /** License notice to display (e.g. CC BY-SA for T3), or null. */
  license: string | null;
}

export interface PublicGap {
  module: string; // "M04" | ... | "extra"
  /** Japanese display name of the aspect, e.g. "時系列の二重化". */
  aspect_label: string;
  reason: "insufficient_sources" | "conflicting_sources" | "out_of_coverage";
}

export interface PublicWorkHeader {
  work_id: string;
  title: string; // canonical title (4.6-7)
  title_original: string | null;
  title_reading: string | null;
  /** Attested aliases only (4.6: unattested inputs/typos are NOT shown on the work page). */
  aliases_display: string[];
  medium: Medium;
  creators: { name: string; role: string | null }[];
  /** Controlled vocab slugs (harness/config/genres.json). */
  genres: string[];
  /** Controlled vocab slugs (harness/config/tags.json), ≤ 8. */
  tags: string[];
  status: WorkStatus;
  first_release_year: number | null;
  publisher: string | null;
  coverage_label: string; // e.g. "全12話" / "全体"
  spoiler_max: Spoiler;
  has_matrix: boolean;
  first_published_at: string | null;
  updated_at: string | null;
}

export interface PublicWork {
  schema: "sfsh-public/1";
  work: PublicWorkHeader;
  phases: PublicPhase[];
  viz: {
    relations: VizRelations;
    reverse_plot: VizReversePlot;
    matrix: VizMatrix | null;
    timeline: VizTimeline | null;
  };
  pages: {
    /** Work overview (first screen lead + sections). */
    overview: TextBlock[];
    /** Short reading guides placed next to figures A / B / C. */
    figure_notes: { relations: TextBlock | null; reverse_plot: TextBlock | null; matrix: TextBlock | null };
    themes: { intro: TextBlock[]; items: ThemeItem[] };
    context: { intro: TextBlock[]; items: ContextItem[]; iconic: IconicItem[] };
    interpretations: { intro: TextBlock[]; items: InterpretationItem[] };
    quiz: QuizItem[];
    /** AMENDMENT 11: long spoiler synopsis on the work page (absent in files composed before A11). */
    synopsis?: SynopsisPage;
  };
  /** CP-026: non-figure element sections. Pages: /people/ (motives, arcs), /events/ (events, world rules, setups, emotion beats). */
  elements: {
    events: PublicEvent[];
    motives: PublicMotive[];
    arcs: PublicArc[];
    world_rules: PublicWorldRule[];
    setups: PublicSetup[];
    emotion_beats: PublicEmotionBeat[];
  };
  gaps: PublicGap[];
  sources: PublicSource[];
}

/**
 * `site/.input/index.public.json` (written by L0 staging from works/INDEX.json; allowed fields only, §6.5).
 * Also the exact item shape of `dist/catalog.json` (minus nothing; catalog adds `url`).
 */
export interface CatalogItem {
  work_id: string;
  /** Root-relative path WITHOUT leading slash, e.g. "works/<work_id>/" (links stay base-path agnostic, CP-024). */
  url: string;
  title: string;
  title_original: string | null;
  title_reading: string | null;
  /** ALL aliases (text only), including unattested inputs/typos (§6.5 search target). */
  aliases: string[];
  medium: Medium;
  creators: string[];
  genres: string[];
  tags: string[];
  status: WorkStatus;
  first_release_year: number | null;
  coverage_label: string;
  spoiler_max: Spoiler;
  has_matrix: boolean;
  first_published_at: string | null;
  updated_at: string | null;
}

export interface SiteInputIndex {
  schema: "sfsh-index/1";
  generated_from: "works/INDEX.json";
  works: CatalogItem[];
  /** Controlled vocabularies for labels (copied from harness/config by L0; display labels only). */
  vocab: {
    genres: { slug: string; label: string }[];
    tags: { slug: string; label: string }[];
    media: { slug: Medium; label: string }[];
  };
}
