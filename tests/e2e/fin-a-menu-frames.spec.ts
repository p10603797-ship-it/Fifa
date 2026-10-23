/**
 * [FIN-A] item 1 in a real browser: after the splash key press (audio unlock) the menus pre-render every sound buffer
 * from the frame loop (bank.pump, 5 ms per menu frame). The crowd-bed loops' crossfade prefix used to render inside
 * one chunk (about seven chunks of work), so one menu frame in the first seconds took 10-25 ms; the first 4096-sample
 * chunks of each sound (cold code) took up to ~11 ms too. Records every pump until the bank is empty and checks the
 * longest stays a normal frame's share (5 ms budget + one 1024-sample unit). Measured before the fix: 13.0 and 22.4 ms.
 * Run: npx vite build --outDir dist-e2e/fin-a --emptyOutDir && PW_DIST=dist-e2e/fin-a PW_PORT=4522 npx playwright test tests/e2e/fin-a-menu-frames.spec.ts
 */
import { expect, test } from '@playwright/test';
import type { AudioEngineImpl } from '../../src/audio/engine';

interface Rec { pumps: number[]; pendingAtStart: number; wrapped: boolean }

test('glitch: menu frame drop after the splash tap - no bank pump in the menus runs past budget + one small unit', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('splash-start')).toBeVisible();
  // Wrap the engine's update (the loop calls audio.update every frame) and, from the first frame with services
  // (created by the unlock), the bank's pump: every pump after the unlock is timed, the first one included.
  await page.evaluate(() => {
    const a = window.__dotkick!.ctx.audio as unknown as AudioEngineImpl & { update: (s: unknown, dt: number) => void };
    const rec: Rec = { pumps: [], pendingAtStart: -1, wrapped: false };
    (window as unknown as { __finA: Rec }).__finA = rec;
    const orig = a.update.bind(a);
    a.update = (s, dt) => {
      const svc = a.services;
      if (svc && !rec.wrapped) {
        rec.wrapped = true;
        rec.pendingAtStart = svc.bank.pending;
        const bank = svc.bank as { pump: (ms: number) => boolean };
        const pump = bank.pump.bind(bank);
        bank.pump = (ms) => {
          const t0 = performance.now();
          const r = pump(ms);
          rec.pumps.push(performance.now() - t0);
          return r;
        };
      }
      orig(s, dt);
    };
  });
  await page.keyboard.press('KeyG');
  await expect(page.getByTestId('main-kickoff')).toBeVisible();
  await page.waitForFunction(() => {
    const a = window.__dotkick!.ctx.audio as unknown as AudioEngineImpl;
    return a.services !== null && a.services.bank.pending === 0;
  }, undefined, { timeout: 60_000 });
  const rec = await page.evaluate(() => (window as unknown as { __finA: Rec }).__finA);
  const sorted = [...rec.pumps].sort((x, y) => x - y);
  const med = sorted[sorted.length >> 1] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  console.log(`FIN-A menu pumps: ${rec.pumps.length} (jobs at unlock ${rec.pendingAtStart}), median ${med.toFixed(2)} ms, max ${max.toFixed(2)} ms, top 5 ${sorted.slice(-5).map((x) => x.toFixed(1)).join(' ')}`);
  expect(rec.wrapped).toBe(true);
  expect(rec.pumps.length).toBeGreaterThan(5);
  // 5 ms menu budget + one unit of work (~0.3-1 ms warm, a few ms cold); the old bed-prefix chunk alone was 10-25 ms.
  expect(max).toBeLessThan(11);
});
