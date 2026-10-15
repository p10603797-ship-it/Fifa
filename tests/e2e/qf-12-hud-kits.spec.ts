/**
 * [QF-12] The HUD shows the kits the players wear. A match whose requested kits clash (every online match asks for
 * HOME / AWAY; Play now after Settings > Match changed a club) is drawn with the renderer's clash-checked kits, and the
 * scoreboard chips used to show the requested, clashing ones. Here a raw HOME / AWAY request for a clashing pairing is
 * started through the session and the scoreboard chips must equal the worn shirts (render/kits resolveKits).
 *
 *   npx vite build --outDir dist-e2e/qf-12 --emptyOutDir && node tools/postbuild.mjs dist-e2e/qf-12
 *   PW_DIST=dist-e2e/qf-12 PW_PORT=4412 npx playwright test tests/e2e/qf-12-hud-kits.spec.ts
 */
import { expect, test } from '@playwright/test';
import { KitSlot } from '../../src/contracts/enums';
import { CLUBS } from '../../src/data/clubs';
import { resolveKits } from '../../src/render/kits';
import { collectConsole, route, waitMatch, waitRoute } from './int-b-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A pairing whose HOME / AWAY request the clash check changes (the away side switches kits). */
function clashingPair(): [number, number] {
  for (let h = 0; h < CLUBS.length; h++) {
    for (let a = 0; a < CLUBS.length; a++) {
      if (h === a) continue;
      const k = resolveKits(CLUBS[h]!, CLUBS[a]!, KitSlot.HOME, KitSlot.AWAY, false);
      if (k.outfield[1].shirt !== CLUBS[a]!.away.shirt && k.outfield[0].shirt === CLUBS[h]!.home.shirt) return [h, a];
    }
  }
  throw new Error('no clashing pairing in the club data');
}

const rgb = (n: number): string => `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;

test('scoreboard kit chips show the kits the players wear when the requested kits clash, also after high contrast is switched on', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectConsole(page);
  const [h, a] = clashingPair();
  const worn = resolveKits(CLUBS[h]!, CLUBS[a]!, KitSlot.HOME, KitSlot.AWAY, false);
  await page.goto('/');
  await expect(page.getByTestId('splash-start')).toBeVisible();
  await page.touchscreen.tap(40, 410);
  await waitRoute(page, 'main');
  await page.getByTestId('main-kickoff').tap();
  await waitMatch(page);
  const base = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__dotkick.ctx.session.getSetup())));
  await page.evaluate(() => (window as any).__dotkick.ctx.session.quit());
  await waitRoute(page, 'main');
  // A raw request, as the online lobby builds it: HOME / AWAY for the two clubs, no clash check.
  await page.evaluate(([setup, hc, ac]) => {
    const s = setup as { config: Record<string, unknown>; bindings: unknown[] };
    s.config.homeClub = hc;
    s.config.awayClub = ac;
    s.config.homeKit = 0;
    s.config.awayKit = 1;
    (window as any).__dotkick.ctx.session.start(s);
  }, [base, h, a] as const);
  await waitMatch(page);
  expect(await route(page)).toBe('match');
  const chips = await page.evaluate(() => {
    const bg = (id: string): string => getComputedStyle(document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!).backgroundColor;
    return [bg('sb-home-kit'), bg('sb-away-kit')];
  });
  expect(chips, `pair ${h}-${a}: requested away shirt ${rgb(CLUBS[a]!.away.shirt)}`).toEqual([rgb(worn.outfield[0].shirt), rgb(worn.outfield[1].shirt)]);
  expect(chips[1]).not.toBe(rgb(CLUBS[a]!.away.shirt));
  // High-contrast kits switched on mid-match (pause menu > settings): the chips follow the boosted kits on the pitch.
  const hc = resolveKits(CLUBS[h]!, CLUBS[a]!, KitSlot.HOME, KitSlot.AWAY, true);
  await page.evaluate(() => (window as any).__dotkick.ctx.settings.update((st: any) => { st.accessibility.highContrastKits = true; }));
  await expect.poll(() => page.evaluate(() => ['sb-home-kit', 'sb-away-kit'].map((id) =>
    getComputedStyle(document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!).backgroundColor))).toEqual([rgb(hc.outfield[0].shirt), rgb(hc.outfield[1].shirt)]);
  await page.evaluate(() => (window as any).__dotkick.ctx.settings.update((st: any) => { st.accessibility.highContrastKits = false; }));
  await page.evaluate(() => (window as any).__dotkick.ctx.session.quit());
  expect(errors).toEqual([]);
});
