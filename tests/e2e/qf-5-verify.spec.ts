/**
 * [QF-5] Second QA pass in a real browser:
 *  - a lost WebGL context keeps the match paused: the pause menu's Resume is refused until the context is restored
 *    and rebuilt, then it resumes (FIX-11; render/index.ts "the session must not resume while contextLost");
 *  - the update toast's Reload works when another tab already activated the new build while the toast waited (no
 *    button that does nothing, no tab left on the old build under the new worker) (QA-40);
 *  - the diagnostics report's Credits and licences line comes from the notices comment in the built page;
 *  - zero console errors or warnings.
 * Build: npx vite build --outDir dist-e2e/qf-5 --emptyOutDir && node tools/postbuild.mjs dist-e2e/qf-5
 * Run:   PW_DIST=dist-e2e/qf-5 PW_PORT=4405 npx playwright test tests/e2e/qf-5-verify.spec.ts
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startStaticServer } from './plt-04-server';

const DIST = resolve(process.env.PW_DIST ?? 'dist');
const NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/, /WebGL: CONTEXT_LOST_WEBGL/];

function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (NOISE.some((re) => re.test(text))) return;
    out.push(`${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

const tickOf = (page: Page) => page.evaluate(() => window.__dotkick!.ctx.session.getState()?.tick ?? -1);
const frames = (page: Page, n: number) => page.evaluate((k) => new Promise<void>((res) => {
  let left = k;
  const f = (): void => { if (--left <= 0) res(); else requestAnimationFrame(f); };
  requestAnimationFrame(f);
}), n);

test.describe('QF-5 verify', () => {
  test('a lost WebGL context refuses Resume until the context is rebuilt; then the pause menu resumes', async ({ page }) => {
    test.setTimeout(180_000);
    const messages = collectConsole(page);
    await page.goto('/');
    // The diagnostics report reads the licence notices back from the built page (a Document-level comment).
    const report = await page.evaluate(() => window.__dotkick!.ctx.diagnostics.report());
    expect(report).toMatch(/Credits and licences: three \d+\.\d+\.\d+ \(MIT\), peerjs \d/);
    expect(report).toContain('full licence texts in Credits and licences');
    await page.getByTestId('splash-start').tap();
    await page.getByTestId('main-kickoff').tap();
    await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 20, null, { timeout: 90_000 });
    const hasExt = await page.evaluate(() => {
      const gl = (document.getElementById('game') as HTMLCanvasElement).getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_lose_context') ?? null;
      (window as unknown as { __qf5Ext: WEBGL_lose_context | null }).__qf5Ext = ext;
      return ext !== null;
    });
    test.skip(!hasExt, 'WEBGL_lose_context unavailable');
    await page.evaluate(() => (window as unknown as { __qf5Ext: WEBGL_lose_context }).__qf5Ext.loseContext());
    await page.waitForFunction(() => window.__dotkick!.ctx.session.paused, null, { timeout: 10_000 });
    await expect(page.getByTestId('pause-resume')).toBeVisible();
    const t0 = await tickOf(page);
    // The player taps Resume while nothing can be drawn: refused, the match stays paused and does not advance.
    await page.getByTestId('pause-resume').tap();
    await frames(page, 10);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
    expect(await tickOf(page)).toBe(t0);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.resume(-1))).toBe(false);
    // Restore: the renderer rebuilds, then Resume works from the pause menu (never on its own).
    await page.evaluate(() => (window as unknown as { __qf5Ext: WEBGL_lose_context }).__qf5Ext.restoreContext());
    await page.waitForFunction(() => !(window.__dotkick!.app.renderer as unknown as { contextLost: boolean }).contextLost, null, { timeout: 15_000 });
    await frames(page, 3);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
    await expect(page.getByTestId('pause-resume')).toBeVisible();
    await page.getByTestId('pause-resume').tap();
    await page.waitForFunction((t) => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > t + 10, t0, { timeout: 30_000 });
    expect(messages).toEqual([]);
  });

  test('Reload on the update toast works after another tab already activated the new build', async ({ page, context }) => {
    test.setTimeout(180_000);
    const dir = mkdtempSync(join(tmpdir(), 'qf5v-deploy-'));
    cpSync(DIST, dir, { recursive: true });
    const server = await startStaticServer(dir);
    try {
      const messages = collectConsole(page);
      const html0 = readFileSync(join(dir, 'index.html'), 'utf8');
      const build0 = /<meta name="dotkick-build" content="([^"]+)"/.exec(html0)![1]!;
      await page.goto(server.url);
      await expect(page.getByTestId('splash-start')).toBeVisible();
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);

      // Deploy a new build.
      writeFileSync(join(dir, 'index.html'), html0.replace('<title>DotKick</title>', '<title>DotKick</title><meta name="qf5v" content="next" />'));
      const pb = (await import(/* @vite-ignore */ new URL('../../tools/postbuild.mjs', import.meta.url).href)) as {
        runPostbuild(d: string): { ok: boolean; build: string; errors: string[] };
      };
      const r = pb.runPostbuild(dir);
      expect(r.errors).toEqual([]);
      expect(r.build).not.toBe(build0);

      // Tab 1 (old build, on the splash: not busy) finds the new worker and offers it.
      await page.evaluate(() => window.__dotkickPwa?.checkForUpdate());
      await expect(page.getByTestId('pwa-update')).toBeVisible({ timeout: 30_000 });

      // Tab 2 opens the game: the network gives it the new build, and it activates the matching worker quietly,
      // which also takes control of tab 1 (still showing build 0 and the toast).
      const page2 = await context.newPage();
      const messages2 = collectConsole(page2);
      await page2.goto(server.url);
      await expect(page2.getByTestId('splash-start')).toBeVisible();
      const ctlBuild = (p: Page) => p.evaluate(() => new Promise<string | null>((res) => {
        const c = navigator.serviceWorker.controller;
        if (!c) return res(null);
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => res((e.data as { build: string }).build);
        c.postMessage({ type: 'STATUS' }, [ch.port2]);
        setTimeout(() => res(null), 3000);
      }));
      await expect.poll(() => ctlBuild(page), { timeout: 30_000 }).toBe(r.build);
      expect(await page.evaluate(() => document.querySelector('meta[name="dotkick-build"]')!.getAttribute('content'))).toBe(build0);

      // The player taps Reload on tab 1's toast: tab 1 reloads onto the new build.
      await expect(page.getByTestId('pwa-update-reload')).toBeVisible();
      const reloaded = page.waitForEvent('framenavigated', { timeout: 15_000 });
      await page.getByTestId('pwa-update-reload').tap();
      await reloaded;
      await expect(page.getByTestId('splash-start')).toBeVisible();
      expect(await page.evaluate(() => document.querySelector('meta[name="dotkick-build"]')!.getAttribute('content'))).toBe(r.build);
      await page2.close();
      expect(messages).toEqual([]);
      expect(messages2).toEqual([]);
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
