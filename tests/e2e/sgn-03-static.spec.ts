/**
 * [SGN-03] DoD 10: dist/index.html runs from a plain static server with nothing else beside it. The file that
 * `npm run build` wrote (SGN03_STATIC_SRC, default dist/index.html) is copied alone into a fresh empty folder and
 * served by Python's stock http.server (no SPA fallback, no headers of ours); Chromium boots it, starts a Kick-Off
 * match and plays it through the normal rAF loop, then quits to the main menu, with zero console errors. The only
 * other requests allowed are the optional extras that are absent on purpose (sw.js, manifest, icons, favicon).
 *
 *   npm run build && PW_DIST=dist-e2e/sgn-03 PW_PORT=4503 npx playwright test tests/e2e/sgn-03-static.spec.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const SRC = resolve(process.env.SGN03_STATIC_SRC ?? 'dist/index.html');
const PORT = Number(process.env.SGN03_STATIC_PORT ?? 4593);
const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];
const OPTIONAL = /^\/(sw\.js|manifest\.webmanifest|icons\/[^/]+\.png|favicon\.ico)$/;

async function waitServing(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`static server never came up at ${url}`);
}

test('dist/index.html alone, from a plain static server (python http.server), boots and plays a match with zero console errors', async ({ page }) => {
  test.setTimeout(300_000);
  const dir = mkdtempSync(join(tmpdir(), 'sgn03-static-'));
  copyFileSync(SRC, join(dir, 'index.html'));
  expect(readdirSync(dir)).toEqual(['index.html']);
  let server: ChildProcess | null = null;
  try {
    server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', dir], { stdio: 'ignore' });
    const base = `http://127.0.0.1:${PORT}/`;
    await waitServing(base);
    const messages: string[] = [];
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    page.on('console', (m) => {
      if (m.type() !== 'error' && m.type() !== 'warning') return;
      const text = m.text();
      if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
      const url = m.location().url ?? '';
      if (/^Failed to load resource: the server responded with a status of 404/.test(text) && OPTIONAL.test(new URL(url, base).pathname)) return;
      messages.push(`${m.type()}: ${text} (${url})`);
    });
    page.on('pageerror', (e) => messages.push(`pageerror: ${e.message}`));

    await page.goto(base);
    await page.getByTestId('splash-start').tap();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    await page.getByTestId('main-kickoff').tap();
    await page.waitForFunction(() => {
      const d = window.__dotkick;
      return !!d && d.ctx.router.current === 'match' && (d.ctx.session.getState()?.tick ?? 0) > 90;
    }, null, { timeout: 180_000, polling: 500 });
    const tick = await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.tick);
    await page.evaluate(() => window.__dotkick!.ctx.session.quit());
    await expect(page.getByTestId('main-kickoff')).toBeVisible();

    const paths = requests.map((u) => new URL(u)).filter((u) => u.origin === new URL(base).origin).map((u) => u.pathname);
    const other = paths.filter((p) => p !== '/' && p !== '/index.html' && !OPTIONAL.test(p));
    expect(other, 'nothing but index.html (and the optional extras) is requested').toEqual([]);
    const offOrigin = requests.filter((u) => !u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:'));
    expect(offOrigin, 'no network requests outside the page origin').toEqual([]);
    expect(messages).toEqual([]);
    console.log(`static: served ${readdirSync(dir).join(',')} only; match reached tick ${tick}; same-origin paths ${[...new Set(paths)].join(' ')}`);
  } finally {
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
