/**
 * Merges per-test measurement records (written by the `rec` fixture) with test outcomes into the JSON report
 * (SFSH_BROWSER_REPORT, default logs/m2/browser_report.json).
 */
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const GATE: Record<string, string> = {
  T00: 'inventory: every page kind classified; >=1 work with each of A, B, C',
  T01: '7.4 M2: no page-level horizontal scroll at 360/390/600/768/1024/1280/1920 (+landscape) for every page kind; scroll only inside C/data-table frames',
  T02: '6.4 崩れ: no text beyond the viewport, header controls do not overlap (360, 1280)',
  T03: '7.4 M2: at 360 body >=16px, figure text >=13px rendered, tap targets >=44x44 with >=8px gaps (effective values)',
  T04: '7.4 M2: A node positions unchanged across phases within a width class; relations change',
  T05: '6.4 図B: tree rooted at the Outcome (>=600), indented list with same root and depth-2 expansion (360)',
  T06: '6.4 図C: reader column at all widths, cells >=44px, horizontal scroll inside the frame only',
  T07: '7.4 M2: every figure has its alternative table/list right after it at every width',
  T08: '7.4 M2: JS disabled - every work page reachable from /works/; A phase switch works via radio + :has()',
  T09: '7.4 M2 / 6.5: title, reading and every alias (typos included) put the work first; <100 ms per input; 0-result links; ?q= round trip',
  T10: '7.4 M2 / 6.5: filters same-axis OR, cross-axis AND, counts, zero-count disabled, URL reflected and restored (reload, resize)',
  T11: '6.4 状態保持: phase (A/C), expansion and search query survive 360 <-> 1280',
  T12: '6.4 色: <= 6 chromatic colours per screen (1280)',
  T13: '7.4 M2: screenshots 360/768/1280 for A, B, C, index, search results, common pages (WP-5.4)',
  T14: '6.3-4(d) / brief: runtime external requests = 0 (asserted in every test by the guard fixture)',
};

export default class SfshReporter implements Reporter {
  private results = new Map<string, { title: string; file: string; status: string; durationMs: number; error?: string; skipReason?: string }>();

  onTestEnd(test: TestCase, result: TestResult): void {
    const err = result.errors.map((e) => (e.message || '').replace(/\u001b\[[0-9;]*m/g, '')).join('\n').slice(0, 6000);
    const skip = test.annotations.find((a) => a.type === 'skip')?.description;
    this.results.set(test.id, { title: test.title, file: test.location.file.split(/[\\/]/).pop()!, status: result.status, durationMs: result.duration, ...(err ? { error: err } : {}), ...(skip ? { skipReason: skip } : {}) });
  }

  onEnd(result: FullResult): void {
    const mf = process.env.SFSH_BROWSER_MANIFEST;
    if (!mf || !existsSync(mf)) return;
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    const recDir = join(m.runDir, 'records');
    const records = new Map<string, unknown[]>();
    if (existsSync(recDir)) for (const f of readdirSync(recDir)) {
      const r = JSON.parse(readFileSync(join(recDir, f), 'utf8'));
      records.set(f.replace(/\.json$/, ''), r.entries);
    }
    const tests: Record<string, { gate: string; cases: unknown[] }> = {};
    const sorted = [...this.results.entries()].sort((a, b) => a[1].title.localeCompare(b[1].title, 'en'));
    for (const [id, r] of sorted) {
      const key = r.title.slice(0, 3);
      tests[key] ??= { gate: GATE[key] ?? '', cases: [] };
      tests[key].cases.push({ ...r, measurements: records.get(id) ?? [] });
    }
    tests.T14 = { gate: GATE.T14!, cases: [{ title: 'guard fixture in every test', status: sorted.every(([, r]) => !(r.error || '').includes('runtime external requests')) ? 'passed' : 'failed' }] };
    const summary = { total: sorted.length, passed: sorted.filter(([, r]) => r.status === 'passed').length, failed: sorted.filter(([, r]) => r.status === 'failed' || r.status === 'timedOut').length, skipped: sorted.filter(([, r]) => r.status === 'skipped').length };
    const report = {
      schema: 'sfsh-browser-report/1',
      generated_at: new Date().toISOString(),
      status: result.status,
      summary,
      setup: { worksDir: m.worksDir, dist: m.dist, build: m.buildOutput, pages: m.pages.length, works: m.works.map((w: { id: string; figures: unknown }) => ({ id: w.id, figures: w.figures })), screensDir: m.screensDir.replace(/\\/g, '/').replace(/^.*?(logs\/)/, '$1') },
      tests,
    };
    mkdirSync(dirname(m.reportPath), { recursive: true });
    writeFileSync(m.reportPath, JSON.stringify(report, null, 1) + '\n');
    console.log(`[sfsh-browser] report: ${m.reportPath.replace(/\\/g, '/').replace(/^.*?(logs\/)/, '$1')} (${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped)`);
    try { rmSync(m.runDir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
