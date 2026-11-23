/**
 * WP-2.9 responsive / accessibility / discoverability browser suite (Chromium only).
 *
 * Env:
 *   SFSH_BROWSER_WORKS   works dir to build from (default `works/`)
 *   SFSH_BROWSER_DIST    use an already-built dist instead of building (works dir is still read for ground truth if present)
 *   SFSH_SCREENS_DIR     screenshot output dir (default `logs/m2/screens`)
 *   SFSH_BROWSER_REPORT  JSON report path (default `logs/m2/browser_report.json`)
 *   SFSH_BROWSER_WORKERS parallel workers (default 4)
 */
import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: true,
  workers: Number(process.env.SFSH_BROWSER_WORKERS || 4),
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 5_000 },
  forbidOnly: true,
  outputDir: join(tmpdir(), 'sfsh-browser-test-output'),
  globalSetup: './global-setup.ts',
  reporter: [['list'], ['./reporter.ts']],
  use: {
    browserName: 'chromium',
    headless: true,
    serviceWorkers: 'block',
    locale: 'ja-JP',
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: 'chromium' }],
});
