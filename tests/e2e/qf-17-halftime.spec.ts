/**
 * [QF-17] FIX-10 half-time hitch, in the real app: half time and the second-half kick-off swap no screen DOM.
 *  - the half-time overlay is built ahead on the loading screen (hidden: [data-prepared], zero-size box, not visible to
 *    Playwright) and the very same element is shown at half time, over the match screen's container, which stays
 *    mounted (same element) with the HUD and touch layers hidden (opacity) under the break;
 *  - Continue focuses by default, the second half brings back the same match container (no remount), the HUD shows
 *    again, no hidden overlay is left, and the half-time transition frames stay short (script + style + layout
 *    measured around the swap in the page).
 *
 *   npx vite build --outDir dist-e2e/qf-17 --emptyOutDir
 *   PW_DIST=dist-e2e/qf-17 PW_PORT=4419 npx playwright test tests/e2e/qf-17-halftime.spec.ts
 */
import { expect, test } from '@playwright/test';
import { bootToMain, collectConsole, startMatch } from './uix-08-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

test('QF-17 half time over the mounted match screen: the overlay built ahead is the one shown, the match screen is never remounted', async ({ page }) => {
  test.setTimeout(180_000);
  const messages = collectConsole(page);
  await bootToMain(page);
  await startMatch(page, { halfMinutes: 2, seed: 1717 });
  // Tag the containers: the same DOM elements must come back (no remount).
  const before = await page.evaluate(() => {
    const m = document.querySelector<HTMLElement>('#ui > .screen[data-screen="match"]')!;
    const h = document.querySelector<HTMLElement>('#ui > .screen[data-screen="half-time"]');
    m.dataset.qf17 = 'match-1';
    if (h) h.dataset.qf17 = 'ht-prepared';
    return {
      prepared: !!h && h.hasAttribute('data-prepared'),
      aria: h?.getAttribute('aria-hidden') ?? null,
      box: h ? h.querySelector('button')!.getBoundingClientRect().width : -1,
      order: [...document.querySelectorAll<HTMLElement>('#ui > .screen')].map((e) => e.dataset.screen),
    };
  });
  expect(before).toEqual({ prepared: true, aria: 'true', box: 0, order: ['match', 'half-time'] });
  await expect(page.getByTestId('ht-continue')).toBeHidden();

  // Fast-forward to half time; keep the break while it is inspected.
  await page.evaluate(() => {
    const w = window as any;
    w.__qf17hold = true;
    w.__qf17timer = setInterval(() => {
      const rt = w.__dotkick?.ctx.session.runtime?.();
      if (!rt) return;
      const m = rt.curr.match;
      if (m.period === 1 && m.clockRunning && m.periodT < m.periodLen - 30) {
        m.periodT = m.periodLen - 30;
        m.addedT = 0;
      }
      if (m.phase === 11 && w.__qf17hold) m.phaseT = 1;
      const r = m.restart;
      if (m.phase >= 1 && m.phase <= 7 && r.ready === 1 && r.timeoutT > 5) r.timeoutT = 5;
    }, 50);
  });
  await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'half-time', null, { timeout: 90_000 });
  await expect(page.getByTestId('ht-continue')).toBeVisible();
  await expect(page.getByTestId('half-time-title')).toHaveText('Half time');
  const during = await page.evaluate(() => {
    const ui = [...document.querySelectorAll<HTMLElement>('#ui > .screen')];
    const h = document.querySelector<HTMLElement>('#ui > .screen[data-screen="half-time"]')!;
    const s = window.__dotkick!.ctx.session.getState()!;
    return {
      screens: ui.map((e) => `${e.dataset.screen}:${e.dataset.qf17 ?? 'new'}`),
      prepared: h.hasAttribute('data-prepared') || h.hasAttribute('aria-hidden') || h.style.opacity !== '' || h.style.transform !== '',
      hud: getComputedStyle(document.getElementById('hud')!).opacity,
      covered: document.body.classList.contains('match-covered'),
      inMatch: document.body.classList.contains('in-match'),
      goals: document.querySelector('[data-testid="brk-goals-0"]')!.textContent === String(s.teams[0]!.goals),
      focused: (document.activeElement as HTMLElement | null)?.dataset.testid ?? null,
      mounted: (window.__dotkick!.ctx.router as any).mounted,
    };
  });
  expect(during).toEqual({
    screens: ['match:match-1', 'half-time:ht-prepared'], prepared: false, hud: '0', covered: true, inMatch: true, goals: true,
    focused: 'ht-continue', mounted: ['match', 'half-time'],
  });

  // Second half: Continue; the same match container comes back, nothing is left behind.
  await page.evaluate(() => { (window as any).__qf17hold = false; });
  await page.getByTestId('ht-continue').tap();
  await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'match', null, { timeout: 15_000 });
  const after = await page.evaluate(() => ({
    screens: [...document.querySelectorAll<HTMLElement>('#ui > .screen')].map((e) => `${e.dataset.screen}:${e.dataset.qf17 ?? 'new'}`),
    hud: getComputedStyle(document.getElementById('hud')!).opacity,
    covered: document.body.classList.contains('match-covered'),
    prepared: (window.__dotkick!.ctx.router as any).prepared,
  }));
  expect(after).toEqual({ screens: ['match:match-1'], hud: '1', covered: false, prepared: null });

  // The swap itself, timed in the page with a forced style + layout read (the session's own navigation).
  const cost = await page.evaluate(async () => {
    const ctx = window.__dotkick!.ctx;
    const r = ctx.router as any;
    const raf = (): Promise<void> => new Promise((res) => requestAnimationFrame(() => res()));
    const out: number[] = [];
    for (let i = 0; i < 4; i++) {
      r.prepare('half-time');
      for (let k = 0; k < 3; k++) await raf();
      const t0 = performance.now();
      r.go('half-time');
      void document.body.getBoundingClientRect();
      const t1 = performance.now();
      await raf();
      const t2 = performance.now();
      r.go('match');
      void document.body.getBoundingClientRect();
      const t3 = performance.now();
      out.push(t1 - t0, t3 - t2);
      await raf();
    }
    return out;
  });
  // Unthrottled here the old swap cost ~30 ms of script, style and layout per transition (PERF_REPORT, QF-7R round 5).
  cost.sort((a, b) => a - b);
  expect(cost[Math.floor(cost.length / 2)]!).toBeLessThan(15);
  await page.evaluate(() => clearInterval((window as any).__qf17timer));
  expect(messages.filter((m) => !/WebGL|GPU|swiftshader|GroupMarkerNotSet/i.test(m))).toEqual([]);
});
