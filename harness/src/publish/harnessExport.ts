/**
 * `sfsh harness-publish` (M6, AMENDMENT 08, REQUIREMENTS §6.6): publish the harness code and design documents to its
 * own public repository (kokuren333/SFSH) as an allow-listed export of the committed HEAD.
 *
 *  1. Source = the files tracked at HEAD of the harness repository (never the working tree), filtered by the
 *     include / exclude globs of harness/config/harness-export.json; the export config itself and the forbidden
 *     paths (works/, logs/, queue/, _handoff/, BRIEF.md, publish*, site/dist, secrets, keys…) are always excluded.
 *  2. Rewrites on the copy only: `replace_all` (e.g. the owner's name → the public handle) and `file_rewrites`
 *     (exact, must match once: e.g. the private-repo wording of .gitignore / package.json). `add` files (LICENSE,
 *     public README) come from harness/export/.
 *  3. Machine scan of the whole export tree; any finding blocks the push: forbidden paths, private needles (owner's
 *     name / user name), secret-like strings, e-mail addresses and local paths (the same rules as the site's push
 *     verification (c)) except the reviewed allow-list entries (test fixtures and detector sources).
 *  4. The work clone (default `harness-publish/`, git-ignored, its own repository whose only remote is the public
 *     repository) is reset to origin/<branch>, replaced by the export tree, committed under the noreply identity and
 *     pushed (fast-forward, never forced). The harness repository never gets a remote (6.3-8).
 *  5. Records: logs/harness-publish/<stamp>.json and one ledger line.
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.ts";
import { git, gitOut, lsTree, readBlobs } from "./git.ts";
import { scanSecretsText } from "./verify.ts";

export interface HarnessExportConfig {
  remote_url: string;
  branch: string;
  clone_dir: string;
  commit_author: { name: string; email: string };
  license: string;
  include: string[];
  exclude: string[];
  add: Record<string, string>;
  replace_all: { from: string; to: string }[];
  file_rewrites: { path: string; from: string; to: string }[];
  private_needles: string[];
  allow_emails: string[];
  /** Reviewed scan findings that are not leaks: test fixtures, detector regex sources. Exact (path, kind, value). */
  allow_hits: { path: string; kind: string; value: string; why: string }[];
}

export const CONFIG_REL = "harness/config/harness-export.json";

/** Never exported, whatever the config says (AMENDMENT 08 "含めないもの" + the export's own private settings). */
export const FORBIDDEN = [
  // root-level data dirs only: harness/src/works/ (code) and site/fixtures/works/ (fictional test works) are exported
  "works/**", "logs/**", "queue/**", "_handoff/**", "BRIEF.md", "publish/**", "publish-test/**", "harness-publish/**",
  "site/dist/**", "site/.input/**", "site/.publish-stage/**", "node_modules/**", "**/node_modules/**", "secrets/**",
  ".env", ".env.*", "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/research/raw/**", CONFIG_REL,
];

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" = any number of directories (including none); "**" at the end = anything
        if (glob[i + 2] === "/") (re += "(?:.*/)?"), (i += 2);
        else (re += ".*"), i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const matchAny = (p: string, globs: string[]) => globs.some((g) => globToRegExp(g).test(p));

export function loadExportConfig(file = path.join(paths.root, CONFIG_REL)): HarnessExportConfig {
  const c = JSON.parse(fs.readFileSync(file, "utf8")) as HarnessExportConfig;
  for (const k of ["remote_url", "branch", "clone_dir", "include", "exclude", "add", "commit_author"] as const)
    if (c[k] === undefined || c[k] === null) throw new Error(`${CONFIG_REL}: ${k} is required`);
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(c.remote_url)) throw new Error(`${CONFIG_REL}: remote_url must be https://github.com/<owner>/<repo>.git`);
  if (!/@users\.noreply\.github\.com$/.test(c.commit_author.email)) throw new Error(`${CONFIG_REL}: commit_author.email must be a GitHub noreply address`);
  c.replace_all ??= [];
  c.file_rewrites ??= [];
  c.private_needles ??= [];
  c.allow_emails ??= [];
  c.allow_hits ??= [];
  return c;
}

export interface ExportFile {
  path: string;
  data: Buffer;
  /** Where it came from: "HEAD" or the add-source path. */
  from: string;
  rewritten: boolean;
}

export interface ExportTree {
  source_commit: string;
  files: ExportFile[];
  excluded_tracked: number;
  rewrites: { path: string; rule: string; count: number }[];
}

const isText = (b: Buffer) => !b.subarray(0, 8000).includes(0);

/** Build the export tree from HEAD of `repoRoot` (pure apart from reading git objects and the add files). */
export function buildExportTree(cfg: HarnessExportConfig, repoRoot = paths.root): ExportTree {
  const gitDir = path.join(repoRoot, ".git");
  const commit = gitOut(["--git-dir", gitDir, "rev-parse", "HEAD"]);
  const tree = lsTree(gitDir, commit);
  const chosen = [...tree.keys()].filter((p) => matchAny(p, cfg.include) && !matchAny(p, cfg.exclude) && !matchAny(p, FORBIDDEN)).sort();
  const blobs = readBlobs(gitDir, [...new Set(chosen.map((p) => tree.get(p)!))]);
  const rewrites: ExportTree["rewrites"] = [];
  const files: ExportFile[] = chosen.map((p) => ({ path: p, data: Buffer.from(blobs.get(tree.get(p)!)!), from: "HEAD", rewritten: false }));
  for (const f of files) {
    if (!isText(f.data)) continue;
    let s = f.data.toString("utf8");
    const before = s;
    for (const r of cfg.replace_all) {
      const n = s.split(r.from).length - 1;
      if (n) (s = s.split(r.from).join(r.to)), rewrites.push({ path: f.path, rule: "replace_all", count: n });
    }
    for (const r of cfg.file_rewrites.filter((x) => x.path === f.path)) {
      const n = s.split(r.from).length - 1;
      if (n !== 1) throw new Error(`file_rewrites: "${r.from.slice(0, 40)}…" occurs ${n} times in ${f.path} (expected exactly 1; update ${CONFIG_REL})`);
      s = s.replace(r.from, r.to);
      rewrites.push({ path: f.path, rule: "file_rewrite", count: 1 });
    }
    if (s !== before) (f.data = Buffer.from(s, "utf8")), (f.rewritten = true);
  }
  for (const r of cfg.file_rewrites) if (!files.some((f) => f.path === r.path)) throw new Error(`file_rewrites: ${r.path} is not in the export`);
  for (const [dest, src] of Object.entries(cfg.add)) {
    if (files.some((f) => f.path === dest)) throw new Error(`add: ${dest} is already exported from HEAD`);
    // add sources must be committed too (the export reflects HEAD, never uncommitted edits)
    if (!tree.has(src)) throw new Error(`add: ${src} is not tracked at HEAD`);
    files.push({ path: dest, data: Buffer.from(readBlobs(gitDir, [tree.get(src)!]).get(tree.get(src)!)!), from: src, rewritten: false });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { source_commit: commit, files, excluded_tracked: tree.size - chosen.length, rewrites };
}

export interface ScanFinding {
  path: string;
  kind: string;
  value: string;
  line: number | null;
}
export interface ScanReport {
  ok: boolean;
  files: number;
  findings: ScanFinding[];
  allowed: ScanFinding[];
  unused_allow: HarnessExportConfig["allow_hits"];
}

const ALLOWED_EMAIL_DOMAIN = /@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|invalid|users\.noreply\.github\.com)$/i;

/** Machine scan of the export tree (step 3). */
export function scanExport(cfg: HarnessExportConfig, files: { path: string; data: Buffer }[]): ScanReport {
  const findings: ScanFinding[] = [];
  for (const f of files) {
    if (matchAny(f.path, FORBIDDEN)) findings.push({ path: f.path, kind: "forbidden_path", value: f.path, line: null });
    if (!isText(f.data)) continue;
    const text = f.data.toString("utf8");
    const lower = text.normalize("NFKC").toLowerCase();
    for (const n of cfg.private_needles) {
      const i = lower.indexOf(n.normalize("NFKC").toLowerCase());
      if (i >= 0) findings.push({ path: f.path, kind: "private_needle", value: `needle #${cfg.private_needles.indexOf(n) + 1}`, line: text.slice(0, i).split("\n").length });
    }
    for (const h of scanSecretsText(text, cfg.allow_emails)) {
      if (h.kind === "email" && ALLOWED_EMAIL_DOMAIN.test(h.value)) continue;
      if (h.kind === "email" && h.value.toLowerCase() === "git@github.com") continue;
      findings.push({ path: f.path, kind: h.kind, value: h.value, line: h.line });
    }
  }
  const allowed: ScanFinding[] = [];
  const used = new Set<number>();
  const rest = findings.filter((x) => {
    const i = cfg.allow_hits.findIndex((a) => a.path === x.path && a.kind === x.kind && a.value === x.value && x.kind !== "forbidden_path" && x.kind !== "private_needle");
    if (i < 0) return true;
    used.add(i);
    allowed.push(x);
    return false;
  });
  return { ok: rest.length === 0, files: files.length, findings: rest, allowed, unused_allow: cfg.allow_hits.filter((_, i) => !used.has(i)) };
}

export interface CloneCheck {
  ok: boolean;
  problems: string[];
}

/** 6.3-8 for the harness side: the clone is its own repository whose only remote is the configured public repo. */
export function checkClone(cfg: HarnessExportConfig, cloneDir: string, repoRoot = paths.root): CloneCheck {
  const problems: string[] = [];
  const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
  if (norm(cloneDir) === norm(repoRoot)) problems.push("clone_dir is the harness repository");
  const top = git(["rev-parse", "--show-toplevel"], { cwd: cloneDir, allowFail: true });
  if (top.code !== 0 || norm(top.stdout.trim()) !== norm(cloneDir)) problems.push(`clone_dir is not the top of its own repository (${top.stdout.trim() || top.stderr.trim()})`);
  const remotes = gitOut(["remote"], { cwd: cloneDir }).split(/\s+/).filter(Boolean);
  if (remotes.join(",") !== "origin") problems.push(`clone remotes must be exactly [origin], got [${remotes.join(",")}]`);
  for (const kind of ["fetch", "push"] as const) {
    const u = git(["remote", "get-url", ...(kind === "push" ? ["--push"] : []), "origin"], { cwd: cloneDir, allowFail: true }).stdout.trim();
    if (u !== cfg.remote_url) problems.push(`clone origin ${kind} URL is "${u}", expected ${cfg.remote_url}`);
  }
  const harnessRemotes = gitOut(["remote"], { cwd: repoRoot });
  if (harnessRemotes) problems.push(`the harness repository has remote(s) [${harnessRemotes.replace(/\s+/g, ",")}] (U-06: none)`);
  return { ok: problems.length === 0, problems };
}

export interface HarnessPublishResult {
  status: "pushed" | "no_change" | "dry_run" | "blocked" | "failed";
  started_at: string;
  source_commit: string | null;
  files: number;
  excluded_tracked: number;
  rewrites: ExportTree["rewrites"];
  scan: ScanReport | null;
  clone_check: CloneCheck | null;
  diff: { added: string[]; modified: string[]; deleted: string[] } | null;
  commit: string | null;
  remote_ref: string | null;
  error: string | null;
  record: string | null;
  ledger_line: string | null;
}

export interface HarnessPublishEnv {
  repoRoot: string;
  configPath: string;
  logDir: string;
  ledgerPath: string | null;
}

export function defaultHarnessPublishEnv(): HarnessPublishEnv {
  return { repoRoot: paths.root, configPath: path.join(paths.root, CONFIG_REL), logDir: path.join(paths.root, "logs", "harness-publish"), ledgerPath: path.join(paths.root, "logs", "LEDGER.md") };
}

function isoLocal(d: Date): string {
  const off = -d.getTimezoneOffset();
  const p = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(off / 60)}:${p(off % 60)}`;
}

export async function harnessPublish(env: HarnessPublishEnv, opts: { dryRun?: boolean; message?: string; now?: Date } = {}): Promise<HarnessPublishResult> {
  const now = opts.now ?? new Date();
  const r: HarnessPublishResult = { status: "failed", started_at: isoLocal(now), source_commit: null, files: 0, excluded_tracked: 0, rewrites: [], scan: null, clone_check: null, diff: null, commit: null, remote_ref: null, error: null, record: null, ledger_line: null };
  try {
    const cfg = loadExportConfig(env.configPath);
    const tree = buildExportTree(cfg, env.repoRoot);
    r.source_commit = tree.source_commit;
    r.files = tree.files.length;
    r.excluded_tracked = tree.excluded_tracked;
    r.rewrites = tree.rewrites;
    r.scan = scanExport(cfg, tree.files);
    if (!r.scan.ok) {
      r.status = "blocked";
      r.error = `scan: ${r.scan.findings.length} finding(s): ${r.scan.findings.slice(0, 5).map((f) => `${f.kind} ${f.path}${f.line ? `:${f.line}` : ""}`).join("; ")}`;
      return r;
    }
    const cloneDir = path.resolve(env.repoRoot, cfg.clone_dir);
    if (!fs.existsSync(cloneDir)) {
      if (opts.dryRun) {
        r.status = "dry_run";
        r.error = `clone_dir ${cfg.clone_dir} does not exist yet (the first real run clones ${cfg.remote_url})`;
        return r;
      }
      git(["clone", "--branch", cfg.branch, cfg.remote_url, cloneDir], { cwd: env.repoRoot, timeoutMs: 5 * 60_000 });
    }
    r.clone_check = checkClone(cfg, cloneDir, env.repoRoot);
    if (!r.clone_check.ok) {
      r.status = "blocked";
      r.error = `clone check: ${r.clone_check.problems.join("; ")}`;
      return r;
    }
    git(["-c", "core.autocrlf=false", "fetch", "origin", cfg.branch], { cwd: cloneDir, timeoutMs: 5 * 60_000 });
    git(["-c", "core.autocrlf=false", "checkout", "-q", "-B", cfg.branch, `origin/${cfg.branch}`], { cwd: cloneDir });
    git(["-c", "core.autocrlf=false", "reset", "-q", "--hard", `origin/${cfg.branch}`], { cwd: cloneDir });
    git(["clean", "-q", "-fdx"], { cwd: cloneDir });
    // Diff against the current public tree (blob bytes, no line-ending conversion).
    const current = lsTree(path.join(cloneDir, ".git"), "HEAD");
    const curBlobs = readBlobs(path.join(cloneDir, ".git"), [...current.values()]);
    const want = new Map(tree.files.map((f) => [f.path, f.data]));
    const diff = { added: [] as string[], modified: [] as string[], deleted: [] as string[] };
    for (const [p, d] of want) {
      if (!current.has(p)) diff.added.push(p);
      else if (!curBlobs.get(current.get(p)!)!.equals(d)) diff.modified.push(p);
    }
    for (const p of current.keys()) if (!want.has(p)) diff.deleted.push(p);
    r.diff = diff;
    if (!diff.added.length && !diff.modified.length && !diff.deleted.length) {
      r.status = "no_change";
      r.remote_ref = current.size ? gitOut(["rev-parse", "HEAD"], { cwd: cloneDir }) : null;
      return r;
    }
    if (opts.dryRun) {
      r.status = "dry_run";
      return r;
    }
    for (const p of diff.deleted) fs.rmSync(path.join(cloneDir, p), { force: true });
    for (const p of [...diff.added, ...diff.modified]) {
      const abs = path.join(cloneDir, p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, want.get(p)!);
    }
    git(["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "add", "-A"], { cwd: cloneDir });
    const msg = `${opts.message ?? "Update from the harness repository"}\n\nsource: harness commit ${tree.source_commit.slice(0, 12)} (allow-listed export, ${tree.files.length} files: +${diff.added.length} ~${diff.modified.length} -${diff.deleted.length})`;
    git(["-c", `user.name=${cfg.commit_author.name}`, "-c", `user.email=${cfg.commit_author.email}`, "-c", "commit.gpgsign=false", "commit", "-q", "-m", msg], { cwd: cloneDir });
    r.commit = gitOut(["rev-parse", "HEAD"], { cwd: cloneDir });
    // Committed tree = export tree (byte check before anything leaves the machine).
    const committed = lsTree(path.join(cloneDir, ".git"), "HEAD");
    if (committed.size !== want.size || [...want.keys()].some((p) => !committed.has(p))) throw new Error("committed tree differs from the export tree");
    git(["push", "--porcelain", "origin", `${cfg.branch}:${cfg.branch}`], { cwd: cloneDir, timeoutMs: 10 * 60_000 });
    r.remote_ref = (gitOut(["ls-remote", "origin", `refs/heads/${cfg.branch}`], { cwd: cloneDir }).split(/\s+/)[0] ?? "") || null;
    if (r.remote_ref !== r.commit) throw new Error(`remote ${cfg.branch} is ${r.remote_ref} after push, expected ${r.commit}`);
    r.status = "pushed";
    return r;
  } catch (e) {
    r.status = "failed";
    r.error = (e instanceof Error ? e.message : String(e)).slice(0, 800);
    return r;
  } finally {
    try {
      fs.mkdirSync(env.logDir, { recursive: true });
      const stamp = r.started_at.replace(/[-:]/g, "").replace(/\+.*$/, "").replace("T", "-");
      const file = path.join(env.logDir, `${stamp}${r.status === "dry_run" ? ".dry" : ""}.json`);
      fs.writeFileSync(file, JSON.stringify(r, null, 2) + "\n", "utf8");
      r.record = path.relative(env.repoRoot, file).replace(/\\/g, "/");
      if (env.ledgerPath && !opts.dryRun) {
        const d = r.diff;
        r.ledger_line = `- HARNESS-PUBLISH ${r.started_at} | status=${r.status} | source=${r.source_commit?.slice(0, 12) ?? "-"} | files=${r.files} | ${d ? `diff=+${d.added.length}~${d.modified.length}-${d.deleted.length}` : "diff=-"} | scan=${r.scan ? (r.scan.ok ? `ok(allowed ${r.scan.allowed.length})` : `BLOCKED(${r.scan.findings.length})`) : "-"} | commit=${r.commit?.slice(0, 12) ?? "-"} | remote=${r.remote_ref?.slice(0, 12) ?? "-"}${r.error ? ` | error=${r.error.slice(0, 200)}` : ""} | record=${r.record}`;
        fs.appendFileSync(env.ledgerPath, r.ledger_line + "\n", "utf8");
      }
    } catch {
      /* records are best effort; the result is still returned */
    }
  }
}
