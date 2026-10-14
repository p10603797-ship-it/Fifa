/**
 * [QF-5] Build, install, offline, storage and audio lifecycle in a real browser (QA-39, QA-40, QA-41):
 *  - audio: the tap unlocks; a hide/show quicker than the browser's suspend comes back running without a tap
 *    (glitch: silent after returning from the background); a match started right after the unlock has every sound
 *    pre-rendered at kick-off (warm-up);
 *  - storage blocked (localStorage throws, IndexedDB never opens): the game boots, plays, pauses and quits;
 *  - a new deploy fetched online is never offered as an "update" of itself; its worker takes over quietly and the
 *    offline copy is that new build (no mixed versions); dist/index.html carries the licence notices;
 *  - zero console errors or warnings.
 * Build: npx vite build --outDir dist-e2e/qf-5 --emptyOutDir && node tools/postbuild.mjs dist-e2e/qf-5
 * Run:   PW_DIST=dist-e2e/qf-5 PW_PORT=4405 npx playwright test tests/e2e/qf-5-lifecycle.spec.ts
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { AudioEngineImpl } from '../../src/audio/engine';
import { startStaticServer } from './plt-04-server';

const DIST = resolve(process.env.PW_DIST ?? 'dist');
const NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];

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

const audioInfo = (page: Page) => page.evaluate(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).info());

test.describe('QF-5 lifecycle', () => {
  test('audio: quick hide/show comes back without a tap; a match right after the unlock is fully pre-rendered', async ({ page }) => {
    const messages = collectConsole(page);
    await page.goto('/');
    await page.getByTestId('splash-start').tap();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    // Straight into a match: the menus had no time to pre-render the crowd and effects.
    await page.getByTestId('main-kickoff').tap();
    await page.waitForFunction(() => window.__dotkick!.app.session.loaded === true, null, { timeout: 60_000 });
    expect(await page.evaluate(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).services!.bank.pending)).toBe(0);
    await page.waitForFunction(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).info().state === 'running');
    // Hidden and visible again in the same task: the browser's suspend lands after the return.
    await page.evaluate(() => {
      const set = (s: 'hidden' | 'visible'): void => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      };
      set('hidden');
      set('visible');
    });
    await page.waitForTimeout(600);
    const info = await audioInfo(page);
    expect(info.state).toBe('running');
    expect(info.outputUp).toBe(true);
    expect(info.gestureArmed).toBe(false);
    const t0 = await page.evaluate(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).context!.currentTime);
    await page.waitForFunction((t) => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).context!.currentTime > t + 0.1, t0);
    // The hidden page paused the match: the pause menu is up.
    await expect(page.getByTestId('pause-resume')).toBeVisible();
    expect(messages).toEqual([]);
  });

  test('storage blocked (localStorage throws, IndexedDB never opens): boots, plays, pauses and quits', async ({ page }) => {
    const messages = collectConsole(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
      const never = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      Object.defineProperty(window, 'indexedDB', { configurable: true, value: { open: () => never, deleteDatabase: () => never } });
    });
    await page.goto('/');
    await page.getByTestId('splash-start').tap();
    await page.getByTestId('main-kickoff').tap();
    await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 30, null, { timeout: 60_000 });
    const persistent = await page.evaluate(() => window.__dotkick!.ctx.settings.persistent);
    expect(persistent).toBe(false);
    // Settings still work for the session (in memory).
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.audio.crowd = 0.4; }));
    expect(await page.evaluate(() => window.__dotkick!.ctx.settings.get().audio.crowd)).toBe(0.4);
    // A replay save goes to the blob store, which gives up on the hung IndexedDB and keeps it in memory.
    const saved = await page.evaluate(async () => {
      const st = window.__dotkick!.ctx.settings as unknown as { saveLargeProgress(k: string, v: unknown): Promise<boolean>; loadLargeProgress(k: string): Promise<unknown> };
      const ok = await st.saveLargeProgress('qf5', { a: 1 });
      return { ok, back: await st.loadLargeProgress('qf5') };
    });
    expect(saved.ok).toBe(false);
    expect(saved.back).toEqual({ a: 1 });
    await page.keyboard.press('Escape');
    await page.getByTestId('pause-quit').tap();
    await page.getByTestId('pause-quit-confirm').tap();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    expect(messages).toEqual([]);
  });

  test('a new deploy fetched online is not offered as an update of itself; offline then boots that build', async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'qf5-deploy-'));
    cpSync(DIST, dir, { recursive: true });
    const server = await startStaticServer(dir);
    let stopped = false;
    try {
      const html0 = readFileSync(join(dir, 'index.html'), 'utf8');
      expect(html0).toMatch(/^<!doctype html>\n<!-- dotkick-notices\n/);
      for (const lib of ['three', 'peerjs', 'webrtc-adapter', 'sdp', 'eventemitter3', '@msgpack/msgpack', 'peerjs-js-binarypack', '@fontsource/space-grotesk', '@fontsource/jetbrains-mono']) {
        expect(html0).toContain(`=== ${lib} `);
      }
      const build0 = /<meta name="dotkick-build" content="([^"]+)"/.exec(html0)![1]!;
      await page.goto(server.url);
      await expect(page.getByTestId('splash-start')).toBeVisible();
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
      // Watch for any update toast from here on.
      await page.addInitScript(() => {
        new MutationObserver(() => {
          if (document.querySelector('[data-testid="pwa-update"]')) (window as unknown as { __qf5Toast: boolean }).__qf5Toast = true;
        }).observe(document, { childList: true, subtree: true });
      });

      // Deploy a new build: a changed game, postbuild run again (new build id in index.html and sw.js).
      writeFileSync(join(dir, 'index.html'), html0.replace('<title>DotKick</title>', '<title>DotKick</title><meta name="qf5" content="next" />'));
      const pb = (await import(/* @vite-ignore */ new URL('../../tools/postbuild.mjs', import.meta.url).href)) as {
        runPostbuild(d: string): { ok: boolean; build: string; errors: string[] };
      };
      const r = pb.runPostbuild(dir);
      expect(r.errors).toEqual([]);
      expect(r.build).not.toBe(build0);

      await page.reload(); // online: network first gives the new page while the old worker still controls it
      await expect(page.getByTestId('splash-start')).toBeVisible();
      expect(await page.evaluate(() => document.querySelector('meta[name="dotkick-build"]')!.getAttribute('content'))).toBe(r.build);
      await page.evaluate(() => window.__dotkickPwa?.checkForUpdate());
      // The new worker takes over quietly.
      await expect.poll(() => page.evaluate(() => new Promise<string | null>((res) => {
        const c = navigator.serviceWorker.controller;
        if (!c) return res(null);
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => res((e.data as { build: string }).build);
        c.postMessage({ type: 'STATUS' }, [ch.port2]);
        setTimeout(() => res(null), 3000);
      })), { timeout: 30_000 }).toBe(r.build);
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => (window as unknown as { __qf5Toast?: boolean }).__qf5Toast === true)).toBe(false);
      await expect(page.getByTestId('pwa-update')).toHaveCount(0);

      // Offline: the cached shell is the new build.
      await server.stop();
      stopped = true;
      await page.reload();
      await expect(page.getByTestId('splash-start')).toBeVisible();
      expect(await page.evaluate(() => document.querySelector('meta[name="dotkick-build"]')!.getAttribute('content'))).toBe(r.build);
    } finally {
      if (!stopped) await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
