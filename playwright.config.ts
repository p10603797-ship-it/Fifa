import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// Only Chromium ships in the dev container (/opt/pw-browsers). WebKit and Firefox projects
// run when their browsers are installed (see docs/DECISIONS.md, D-003).
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '';
const hasWebkit = browsersPath !== '' && existsSync(browsersPath) &&
  (await import('node:fs')).readdirSync(browsersPath).some((d) => d.startsWith('webkit'));

// deviceScaleFactor 1 by default: software WebGL (SwiftShader) in the container is slow at DPR 2.
// PW_HIDPI=1 adds the DPR-2 project. PW_PORT / PW_DIST let concurrent agents use their own build and server:
//   npx vite build --outDir dist-e2e/<id> --emptyOutDir && PW_DIST=dist-e2e/<id> PW_PORT=42xx npx playwright test <spec>
const port = Number(process.env.PW_PORT ?? 4173);
const distDir = process.env.PW_DIST ?? 'dist';
const ipad = { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const ipadHiDpi = { ...ipad, deviceScaleFactor: 2 };
const chromiumArgs = { launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } };

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx vite preview --port ${port} --strictPort --outDir ${distDir}`,
    port,
    reuseExistingServer: !process.env.PW_PORT,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium-ipad', use: { ...devices['Desktop Chrome'], ...ipad, ...chromiumArgs } },
    ...(process.env.PW_HIDPI ? [{ name: 'chromium-ipad-hidpi', use: { ...devices['Desktop Chrome'], ...ipadHiDpi, ...chromiumArgs } }] : []),
    ...(hasWebkit ? [{ name: 'webkit-ipad', use: { ...devices['iPad Pro 11 landscape'] } }] : []),
  ],
});
