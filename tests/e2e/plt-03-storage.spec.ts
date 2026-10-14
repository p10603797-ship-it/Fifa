/**
 * [PLT-03] Storage in a real browser: debounced settings writes are flushed when the page goes away (reload), corrupt
 * stored settings are moved to the backup key without errors, and large progress persists in IndexedDB.
 * Build first: npx vite build --outDir dist-e2e/plt-03 --emptyOutDir
 * Run: PW_DIST=dist-e2e/plt-03 PW_PORT=4203 npx playwright test tests/e2e/plt-03-storage.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import type { SettingsStoreImpl } from '../../src/platform/settingsStore';

const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];

function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
    out.push(`${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

async function boot(page: Page): Promise<void> {
  await page.waitForFunction(() => !!window.__dotkick, null, { timeout: 30_000 });
}

test('a burst of settings changes is flushed on reload; corrupt settings are backed up', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('plt03-seeded')) return;
    sessionStorage.setItem('plt03-seeded', '1');
    localStorage.setItem('dotkick.settings', '{"schema":1,"audio":{"mas');
  });
  const messages = collectConsole(page);
  await page.goto('/');
  await boot(page);
  const first = await page.evaluate(() => ({
    backup: localStorage.getItem('dotkick.backup.settings'),
    stored: JSON.parse(localStorage.getItem('dotkick.settings') ?? 'null') as { schema: number } | null,
    persistent: window.__dotkick!.ctx.settings.persistent,
  }));
  expect(first.backup).toBe('{"schema":1,"audio":{"mas');
  expect(first.stored?.schema).toBe(1);
  expect(first.persistent).toBe(true);

  const pending = await page.evaluate(() => {
    const s = window.__dotkick!.ctx.settings;
    s.update((x) => { x.audio.master = 0.2; });
    s.update((x) => { x.audio.master = 0.3; });
    s.update((x) => { x.nickname = 'Reloaded'; });
    return (s as unknown as SettingsStoreImpl).pending;
  });
  expect(pending).toBe(true);
  await page.reload();
  await boot(page);
  const after = await page.evaluate(() => {
    const s = window.__dotkick!.ctx.settings.get();
    return { nickname: s.nickname, master: s.audio.master };
  });
  expect(after).toEqual({ nickname: 'Reloaded', master: 0.3 });
  expect(messages).toEqual([]);
});

test('large progress (a replay) persists in IndexedDB across reloads and is cleared by clearProgress', async ({ page }) => {
  const messages = collectConsole(page);
  await page.goto('/');
  await boot(page);
  const saved = await page.evaluate(async () => {
    const s = window.__dotkick!.ctx.settings as unknown as SettingsStoreImpl;
    const frames: number[] = [];
    for (let i = 0; i < 100_000; i++) frames.push(i % 50);
    return s.saveLargeProgress('replay.e2e', { format: 1, frames });
  });
  expect(saved).toBe(true);
  await page.reload();
  await boot(page);
  const back = await page.evaluate(async () => {
    const s = window.__dotkick!.ctx.settings as unknown as SettingsStoreImpl;
    const r = await s.loadLargeProgress<{ frames: number[] }>('replay.e2e');
    return { length: r ? r.frames.length : -1, keys: await s.largeProgressKeys(), describe: s.describe() };
  });
  expect(back.length).toBe(100_000);
  expect(back.keys).toEqual(['replay.e2e']);
  expect(back.describe).toContain('large progress indexeddb');
  const cleared = await page.evaluate(async () => {
    const s = window.__dotkick!.ctx.settings as unknown as SettingsStoreImpl;
    s.clearProgress();
    return s.largeProgressKeys();
  });
  expect(cleared).toEqual([]);
  expect(messages).toEqual([]);
});
