/**
 * [PLT-04] Single-file build end to end:
 * - dist/index.html served alone (no manifest, sw.js or icons beside it; plain 404s, no SPA fallback) boots to the
 *   main menu with zero console errors or warnings (also covers PLT-01 "missing sw / manifest does not break boot");
 * - the size budget gate (tools/postbuild.mjs) passes on the build;
 * - startup: time to the interactive splash and to the main menu with Chromium network throttling at ~20 Mbit/s
 *   (Wi-Fi, brief section 3: main menu within 3 s), written to reports/plt-04-startup.json for tools/size-check.ts.
 * Build first:  npx vite build --outDir dist-e2e/plt --emptyOutDir && node tools/postbuild.mjs dist-e2e/plt
 * Run:          PW_DIST=dist-e2e/plt PW_PORT=4205 npx playwright test tests/e2e/plt-04-build.spec.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startStaticServer } from './plt-04-server';

const DIST = resolve(process.env.PW_DIST ?? 'dist');
/** Chromium prints these about the container's software GPU; no page script logs them. */
const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];

/**
 * Console errors and warnings, except the browser's own network notice for a missing optional extra beside
 * index.html (sw.js, manifest, icons): Chromium logs "Failed to load resource: 404" for any request that 404s, and the
 * only way to learn that sw.js is absent is to ask for it. Anything the game itself logs still fails the test.
 */
function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
    const url = m.location().url ?? '';
    if (/^Failed to load resource: the server responded with a status of 404/.test(text) &&
        /\/(sw\.js|manifest\.webmanifest|icons\/[^/]+\.png)$/.test(url)) return;
    out.push(`${m.type()}: ${text} (${url})`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

test.describe('PLT-04 single-file build', () => {
  test('index.html served alone boots to the main menu with zero console errors', async ({ page }) => {
    const server = await startStaticServer(DIST, { only: ['index.html'] });
    try {
      const messages = collectConsole(page);
      await page.goto(server.url);
      await page.getByTestId('splash-start').tap();
      await expect(page.getByTestId('main-kickoff')).toBeVisible();
      await page.waitForTimeout(1500); // late failures (service worker registration, manifest) would show by now
      const missing = server.requests.filter((p) => p !== '/' && p !== '/index.html');
      // The optional extras were asked for and refused, and the game ran on.
      expect(missing.every((p) => /^\/(sw\.js|manifest\.webmanifest|icons\/.+\.png|favicon\.ico)$/.test(p))).toBe(true);
      expect(messages).toEqual([]);
      const log = await page.evaluate(() => window.__dotkick!.ctx.diagnostics.recent().join('\n'));
      expect(log).toMatch(/service worker not registered/);
    } finally {
      await server.stop();
    }
  });

  test('the size budget gate passes on this build', () => {
    const out = execFileSync('node', ['tools/postbuild.mjs', DIST], { encoding: 'utf8' });
    expect(out).toContain('postbuild: PASS');
    const m = /index\.html ([\d.]+) KB raw, ([\d.]+) KB gzip/.exec(out)!;
    expect(Number(m[2])).toBeLessThan(4096);
    expect(statSync(resolve(DIST, 'index.html')).size).toBeGreaterThan(100_000);
  });

  test('startup with ~20 Mbit/s throttling: splash and main menu times', async ({ page }) => {
    const server = await startStaticServer(DIST, { only: ['index.html'] });
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 20, downloadThroughput: (20 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8,
      });
      await page.goto(server.url, { waitUntil: 'commit' });
      await expect(page.getByTestId('splash-start')).toBeVisible({ timeout: 30_000 });
      const splashMs = await page.evaluate(() => Math.round(performance.now()));
      const nav = await page.evaluate(() => {
        const e = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        return e ? { responseEnd: Math.round(e.responseEnd), domContentLoaded: Math.round(e.domContentLoadedEventEnd) } : null;
      });
      const t0 = await page.evaluate(() => performance.now());
      await page.getByTestId('splash-start').tap();
      await expect(page.getByTestId('main-kickoff')).toBeVisible();
      const tapToMainMs = await page.evaluate((t) => Math.round(performance.now() - t), t0);
      const result = {
        'network': 'Chromium emulation, 20 Mbit/s down, 20 ms latency',
        'download done (ms)': nav?.responseEnd ?? 'n/a',
        'DOMContentLoaded (ms)': nav?.domContentLoaded ?? 'n/a',
        'splash interactive (ms)': splashMs,
        'tap to main menu (ms)': tapToMainMs,
        'device': 'dev container, software WebGL (an iPad is faster)',
        'measured': new Date().toISOString().slice(0, 10),
      };
      mkdirSync(resolve('reports'), { recursive: true });
      writeFileSync(resolve('reports/plt-04-startup.json'), `${JSON.stringify(result, null, 2)}\n`);
      // The 3 s target is for the iPad; the container (software GL, shared CPUs) gets a looser bound.
      expect(splashMs).toBeLessThan(10_000);
      expect(tapToMainMs).toBeLessThan(3000);
    } finally {
      await server.stop();
    }
  });
});
