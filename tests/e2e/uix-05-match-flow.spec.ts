/**
 * UIX-05 e2e: mode setup, match settings and the loading screen through the real app (router, FocusNavigator, menu
 * input, session, sim).
 *  - touch alone: main menu -> Kick-Off -> mode setup -> teams -> sides -> match settings (every option changed) ->
 *    loading -> match; state.config carries the choices, settings.match / settings.camera remember them;
 *  - controller alone (mocked pad): the same path by D-pad and Cross; the loading screen shows controller tips with
 *    the pad's glyphs; the match is bound to that pad;
 *  - Play a Friend -> Online opens the online lobby; Shoot-out shows only its options; layout of mode setup, match
 *    settings and loading at iPad landscape, 4:3 and 21:9; screenshots.
 *
 *   npx vite build --outDir dist-e2e/uix-345 --emptyOutDir
 *   PW_DIST=dist-e2e/uix-345 PW_PORT=4235 npx playwright test tests/e2e/uix-05-match-flow.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import {
  PAD, VIEWPORTS, checkLayout, collectConsole, expectCleanLayout, focused, frames, mockPads, openMode, padTap, route, shot,
  toMain, walkTo,
} from './uix-03-harness';

interface Cfg {
  mode: number; homeClub: number; awayClub: number; homeKit: number; awayKit: number; difficulty: number; halfMinutes: number;
  cupRules: number; night: number; offside: number; fouls: number; replaySeconds: number; startPhase: number;
  humans: { kind: number; side: number }[];
}

const stateConfig = (page: Page): Promise<Cfg | null> =>
  page.evaluate(() => {
    const s = window.__dotkick!.ctx.session.getState();
    return s ? (JSON.parse(JSON.stringify(s.config)) as Cfg) : null;
  });

async function waitForMatch(page: Page): Promise<void> {
  await expect.poll(() => route(page), { timeout: 90_000 }).toBe('match');
  await expect.poll(async () => (await stateConfig(page)) !== null).toBe(true);
}

test.describe('UIX-05 mode setup, match settings and loading', () => {
  test('touch alone: full Kick-Off path reaches a match with the chosen settings applied', async ({ page }) => {
    test.setTimeout(180_000);
    const messages = collectConsole(page);
    await toMain(page, 'touch');
    await page.getByTestId('main-mode-kickoff').tap();
    await expect.poll(() => route(page)).toBe('mode-setup');
    await expect(page.getByTestId('mode-panel-title')).toHaveText('Kick-Off');
    await page.getByTestId('mode-continue').tap();
    await expect.poll(() => route(page)).toBe('team-select');
    await page.getByTestId('ts-club-3').tap();
    await page.getByTestId('ts-club-9').tap();
    await page.getByTestId('team-continue').tap();
    await expect.poll(() => route(page)).toBe('side-select');
    await page.getByTestId('side-continue').tap();
    await expect.poll(() => route(page)).toBe('match-settings');
    await expect(page.getByTestId('mset-who-home')).toHaveText('P1');
    await expect(page.getByTestId('mset-who-away')).toHaveText('CPU');

    // Difficulty: Professional -> World Class -> Legend (tap the row).
    await page.getByTestId('mset-difficulty').tap();
    await page.getByTestId('mset-difficulty').tap();
    await expect(page.getByTestId('mset-difficulty')).toHaveAttribute('aria-label', /Legend/);
    // Half length 7 min: tap the track at 5/8.
    const track = await page.getByTestId('mset-half').locator('.sld__track').boundingBox();
    await page.touchscreen.tap(track!.x + track!.width * 0.625, track!.y + track!.height / 2);
    await expect(page.getByTestId('mset-half')).toHaveAttribute('aria-valuenow', '7');
    await page.getByTestId('mset-rules-cup').tap();
    await page.getByTestId('mset-night').tap();
    await page.getByTestId('mset-offside').tap();
    await page.getByTestId('mset-fouls').tap();
    await page.getByTestId('mset-replays').tap();
    await page.getByTestId('mset-camera-1').tap();
    await expect(page.getByTestId('mset-offside')).toHaveAttribute('aria-checked', 'false');
    await shot(page, 'uix-05-match-settings-1180x820');

    await page.getByTestId('settings-start').tap();
    await expect.poll(() => route(page)).not.toBe('match-settings');
    if ((await route(page)) === 'loading') await shot(page, 'uix-05-loading-touch');
    await waitForMatch(page);
    const c = (await stateConfig(page))!;
    expect(c.homeClub).toBe(3);
    expect(c.awayClub).toBe(9);
    expect(c.mode).toBe(0);
    expect(c.difficulty).toBe(5);
    expect(c.halfMinutes).toBe(7);
    expect(c.cupRules).toBe(1);
    expect(c.night).toBe(1);
    expect(c.offside).toBe(0);
    expect(c.fouls).toBe(0);
    expect(c.replaySeconds).toBe(0);
    expect(c.humans.map((x) => [x.kind, x.side])).toEqual([[1, 0], [0, -1]]);
    const bindings = await page.evaluate(() => window.__dotkick!.ctx.session.getSetup()!.bindings);
    expect(bindings).toEqual([{ human: 0, deviceIds: ['touch'] }]);
    // Remembered for next time.
    const s = await page.evaluate(() => {
      const v = window.__dotkick!.ctx.settings.get();
      return { m: v.match, cam: v.camera.type };
    });
    expect(s.m).toMatchObject({ homeClub: 3, awayClub: 9, difficulty: 5, halfMinutes: 7, night: true, offside: false, fouls: false, replays: false });
    expect(s.cam).toBe(1);
    expect(messages).toEqual([]);
  });

  test('controller alone: full Kick-Off path by D-pad, controller tips while loading, match bound to the pad', async ({ page }) => {
    test.setTimeout(180_000);
    const messages = collectConsole(page);
    await page.addInitScript(mockPads(1));
    await toMain(page, 'pad');
    await expect.poll(() => focused(page)).toBe('main-kickoff');
    await padTap(page, PAD.RIGHT);
    await expect.poll(() => focused(page)).toBe('main-mode-kickoff');
    await padTap(page, PAD.A);
    await expect.poll(() => route(page)).toBe('mode-setup');
    await expect.poll(() => focused(page)).toBe('mode-continue');
    await padTap(page, PAD.A);
    await expect.poll(() => route(page)).toBe('team-select');
    await expect.poll(() => focused(page)).toBe('ts-club-0');
    await padTap(page, PAD.RIGHT);
    await padTap(page, PAD.A); // home: club 1
    await padTap(page, PAD.DOWN);
    await padTap(page, PAD.A); // away: club 6
    await padTap(page, PAD.UP);
    await padTap(page, PAD.UP);
    await walkTo(page, 'team-continue', () => padTap(page, PAD.RIGHT));
    await padTap(page, PAD.A);
    await expect.poll(() => route(page)).toBe('side-select');
    await expect.poll(() => page.getByTestId('ss-token-pad:1').getAttribute('data-lane')).toBe('home');
    await padTap(page, PAD.A); // Continue has the focus
    await expect.poll(() => route(page)).toBe('match-settings');
    await expect.poll(() => focused(page)).toBe('settings-start');
    const rightCol = ['mset-offside', 'mset-fouls', 'mset-replays', 'settings-start'];
    await walkTo(page, 'mset-half', async () => {
      const f = (await focused(page)) ?? '';
      await padTap(page, rightCol.includes(f) || f.startsWith('mset-camera') ? PAD.LEFT : PAD.DOWN);
    });
    await padTap(page, PAD.RIGHT);
    await padTap(page, PAD.RIGHT);
    await expect(page.getByTestId('mset-half')).toHaveAttribute('aria-valuenow', '6');
    await walkTo(page, 'mset-rules-cup', async () => {
      const f = (await focused(page)) ?? '';
      await padTap(page, f === 'mset-rules-friendly' ? PAD.RIGHT : PAD.DOWN);
    });
    await padTap(page, PAD.A);
    await walkTo(page, 'mset-night', async () => {
      const f = (await focused(page)) ?? '';
      await padTap(page, f === 'mset-day' ? PAD.RIGHT : PAD.DOWN);
    });
    await padTap(page, PAD.A);
    await walkTo(page, 'mset-offside', async () => {
      const f = (await focused(page)) ?? '';
      await padTap(page, f.startsWith('mset-fouls') || f.startsWith('mset-replays') || f.startsWith('mset-camera') ? PAD.UP : PAD.RIGHT);
    });
    await padTap(page, PAD.LEFT); // a toggle: Left = off
    await expect(page.getByTestId('mset-offside')).toHaveAttribute('aria-checked', 'false');
    await shot(page, 'uix-05-match-settings-pad');
    await walkTo(page, 'settings-start', () => padTap(page, PAD.UP));
    await padTap(page, PAD.A);
    await expect.poll(() => route(page)).not.toBe('match-settings');
    if ((await route(page)) === 'loading') {
      await expect(page.getByTestId('loading-tip-kind')).toHaveText('Controller tips');
      await shot(page, 'uix-05-loading-pad');
    }
    await waitForMatch(page);
    const c = (await stateConfig(page))!;
    expect(c.homeClub).toBe(1);
    expect(c.awayClub).toBe(6);
    expect(c.halfMinutes).toBe(6);
    expect(c.cupRules).toBe(1);
    expect(c.night).toBe(1);
    expect(c.offside).toBe(0);
    expect(c.fouls).toBe(1);
    expect(c.humans.map((x) => [x.kind, x.side])).toEqual([[1, 0], [0, -1]]);
    const bindings = await page.evaluate(() => window.__dotkick!.ctx.session.getSetup()!.bindings);
    expect(bindings).toEqual([{ human: 0, deviceIds: ['pad:1'] }]);
    expect(messages).toEqual([]);
  });

  test('friend online, shoot-out options, and layout of mode setup, match settings and loading', async ({ page }) => {
    const messages = collectConsole(page);
    await toMain(page, 'touch');
    await openMode(page, 1);
    await expect(page.getByTestId('mode-panel-title')).toHaveText('Play a Friend');
    await page.getByTestId('mode-friend-online').tap();
    await expect.poll(() => route(page)).toBe('online-lobby');
    // Shoot-out: no clock or open-play rules; the match would start in the shoot-out phase.
    await page.evaluate(() => window.__dotkick!.app.router.resetTo('main'));
    await page.evaluate(() => window.__dotkick!.ctx.router.go('match-settings', { mode: 4 }));
    await expect.poll(() => route(page)).toBe('match-settings');
    await expect(page.getByTestId('settings-start')).toHaveText('Start shoot-out');
    await expect(page.getByTestId('mset-half')).toHaveCount(0);
    await expect(page.getByTestId('mset-offside')).toHaveCount(0);
    await expect(page.getByTestId('mset-time')).toBeVisible();

    for (const v of VIEWPORTS) {
      await page.setViewportSize({ width: v.w, height: v.h });
      await page.evaluate(() => window.__dotkick!.app.router.resetTo('main'));
      await openMode(page, 0);
      await frames(page, 3);
      expectCleanLayout(await checkLayout(page), `mode-setup ${v.name}`);
      await shot(page, `uix-05-mode-setup-${v.name}`);
      await page.evaluate(() => window.__dotkick!.ctx.router.go('match-settings', { mode: 0 }));
      await expect.poll(() => route(page)).toBe('match-settings');
      await frames(page, 3);
      expectCleanLayout(await checkLayout(page), `match-settings ${v.name}`);
      await shot(page, `uix-05-match-settings-${v.name}`);
      await page.evaluate(() => window.__dotkick!.ctx.router.go('loading', {
        setup: { config: { homeClub: 4, awayClub: 11, seed: 7, humans: [{ kind: 1, side: 0 }, { kind: 1, side: 1 }] }, bindings: [{ human: 0, deviceIds: ['touch'] }] },
      }));
      await expect.poll(() => route(page)).toBe('loading');
      await expect(page.getByTestId('loading-tip-kind')).toHaveText('Touch tips');
      await page.waitForTimeout(400);
      await shot(page, `uix-05-loading-${v.name}`);
    }
    await page.evaluate(() => window.__dotkick!.app.router.resetTo('main'));
    expect(messages).toEqual([]);
  });
});
