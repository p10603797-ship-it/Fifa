import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// Only Chromium ships in the dev container (/opt/pw-browsers). WebKit and Firefox projects
// run when their browsers are installed (see docs/DECISIONS.md, D-003).
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '';
const hasWebkit = browsersPath !== '' && existsSync(browsersPath) &&
  (await import('node:fs')).readdirSync(browsersPath).some((d) => d.startsWith('webkit'));

const ipad = { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    port: 4173,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium-ipad', use: { ...devices['Desktop Chrome'], ...ipad } },
    ...(hasWebkit ? [{ name: 'webkit-ipad', use: { ...devices['iPad Pro 11 landscape'] } }] : []),
  ],
});
