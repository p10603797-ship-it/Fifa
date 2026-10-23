/**
 * [TUN-7S] QF-7S (a) in the real app: the loop's copyState(prev, curr) runs sim/core/clone.ts's generated copier (built
 * with `new Function`; the page has no CSP that forbids it) and gives the renderer an exact, unshared previous state.
 * A CPU v CPU match plays a few seconds through the real rAF loop; then prev must be the state one tick before curr
 * (prev.tick = curr.tick - 1 after any frame that ticked), with the same keys and no nested object shared with curr
 * (a shared reference would make interpolation read the current values), and the page must log no error.
 */
import { expect, test, type Page } from '@playwright/test';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('live match: prev is an exact unshared copy one tick behind curr', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await page.getByTestId('splash-start').click();
  await page.getByTestId('main-kickoff').click();
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
  }, null, { timeout: 90_000, polling: 250 });
  await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 240, null, { timeout: 90_000, polling: 250 });
  const res = await page.evaluate(() => {
    const rt = window.__dotkick!.app.session.runtime() as unknown as { prev: Record<string, unknown>; curr: Record<string, unknown> } | null;
    if (!rt) return { error: 'no runtime' };
    let shared = '';
    const walk = (a: unknown, b: unknown, path: string): void => {
      if (shared || typeof a !== 'object' || a === null) return;
      if (a === b) { shared = path; return; }
      for (const k of Object.keys(a as object)) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    };
    for (const k of Object.keys(rt.curr)) if (k !== 'config' && k !== 'squads') walk(rt.prev[k], rt.curr[k], k);
    return {
      prevTick: rt.prev.tick as number,
      currTick: rt.curr.tick as number,
      sameKeys: JSON.stringify(Object.keys(rt.prev)) === JSON.stringify(Object.keys(rt.curr)),
      shared,
      configShared: rt.prev.config === rt.curr.config,
      codegen: typeof new Function('return 1') === 'function',
    };
  });
  expect(res).not.toHaveProperty('error');
  expect(res.currTick! - res.prevTick!).toBe(1);
  expect(res.sameKeys).toBe(true);
  expect(res.shared).toBe('');
  expect(res.configShared).toBe(true);
  expect(res.codegen).toBe(true);
  expect(errors).toEqual([]);
});
