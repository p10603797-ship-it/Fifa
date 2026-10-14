/**
 * [PLT-01] PWA end to end: after the first load the game reloads and boots offline from the service worker cache;
 * a new sw.js build shows "Update available", and Reload activates it. (index.html alone, without sw.js, manifest
 * and icons: tests/e2e/plt-04-build.spec.ts.)
 * Build first:  npx vite build --outDir dist-e2e/plt --emptyOutDir && node tools/postbuild.mjs dist-e2e/plt
 * Run:          PW_DIST=dist-e2e/plt PW_PORT=4205 npx playwright test tests/e2e/plt-01-pwa.spec.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startStaticServer } from './plt-04-server';

const DIST = resolve(process.env.PW_DIST ?? 'dist');
const SW_PATH = resolve(DIST, 'sw.js');

interface SwStatus { build: string; cache: string; lastNavigation: string }

async function waitForController(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!reg && !!reg.active && reg.active.state === 'activated' && !!navigator.serviceWorker.controller;
  }), { timeout: 30_000 }).toBe(true);
}

function swStatus(page: Page): Promise<SwStatus | null> {
  return page.evaluate(() => new Promise<SwStatus | null>((res) => {
    const c = navigator.serviceWorker.controller;
    if (!c) {
      res(null);
      return;
    }
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => res(e.data as SwStatus);
    c.postMessage({ type: 'STATUS' }, [ch.port2]);
    setTimeout(() => res(null), 5000);
  }));
}

test.describe('PLT-01 PWA', () => {
  test('after the first load the game reloads and boots offline from the cache', async ({ page }) => {
    // Our own server, so going offline is real: the server stops and every request (the worker's too) fails.
    const server = await startStaticServer(DIST);
    let stopped = false;
    try {
      await page.goto(server.url);
      await expect(page.getByTestId('splash-start')).toBeVisible();
      await waitForController(page);
      const first = (await swStatus(page))!;
      expect(first.build).toMatch(/^\d+\.\d+\.\d+-[0-9a-f]{10}$/); // postbuild injected the build id
      expect(first.cache).toBe(`dotkick-shell-${first.build}`);
      // The first install never offers an update.
      await expect(page.getByTestId('pwa-update')).toHaveCount(0);

      await server.stop();
      stopped = true;
      // The network really is gone: an uncached URL fails.
      expect(await page.evaluate(() => fetch(`./sw.js?probe=${Date.now()}`).then(() => 'ok', () => 'failed'))).toBe('failed');
      await page.reload();
      await expect(page.getByTestId('splash-start')).toBeVisible();
      expect((await swStatus(page))!.lastNavigation).toBe('cache');
      await page.getByTestId('splash-start').tap();
      await expect(page.getByTestId('main-kickoff')).toBeVisible();
      // The manifest and icons are cached too; a query string shares the one cached shell (?bench=1 offline).
      expect(await page.evaluate(() => fetch('./manifest.webmanifest').then((r) => r.json()).then((m: { name: string }) => m.name))).toBe('DotKick');
      expect(await page.evaluate(() => fetch('./icons/icon-192.png').then((r) => r.status))).toBe(200);
      expect(await page.evaluate(() => fetch('./index.html?x=1').then((r) => r.status))).toBe(200);
    } finally {
      if (!stopped) await server.stop();
    }
  });

  test('a new service worker build shows "Update available"; Reload activates it', async ({ page }) => {
    const original = readFileSync(SW_PATH, 'utf8');
    const next = 'plt01-update-check';
    try {
      await page.goto('/');
      await waitForController(page);
      const before = (await swStatus(page))!;
      expect(before.build).not.toBe(next);
      writeFileSync(SW_PATH, original.replace(/^(const BUILD = )'[^']*'/m, `$1'${next}'`));
      await page.evaluate(() => window.__dotkickPwa!.checkForUpdate());
      const toast = page.getByTestId('pwa-update');
      await expect(toast).toBeVisible({ timeout: 20_000 });
      await expect(toast).toContainText('Update available');
      await Promise.all([page.waitForEvent('load', { timeout: 30_000 }), page.getByTestId('pwa-update-reload').click()]);
      await expect(page.getByTestId('splash-start')).toBeVisible();
      await waitForController(page);
      const after = (await swStatus(page))!;
      expect(after.build).toBe(next);
      expect(after.cache).toBe(`dotkick-shell-${next}`);
      // The old version's cache was removed on activation.
      expect(await page.evaluate(() => caches.keys())).toEqual([`dotkick-shell-${next}`]);
    } finally {
      writeFileSync(SW_PATH, original);
    }
  });
});
