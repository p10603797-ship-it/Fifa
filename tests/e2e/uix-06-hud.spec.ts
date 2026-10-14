/**
 * UIX-06 e2e: scoreboard and toasts in a real match (iPad 1180 x 820, touch).
 *  - scoreboard shows codes, kit chips, 0-0 and a running mm:ss clock; updates on a goal; +N added time; ET label
 *  - toasts for scripted GOAL / CARD / SUBSTITUTION / OFFSIDE events, queued one after another
 *  - zero DOM mutations under #hud on idle frames (MutationObserver), and a low rate while the match plays
 *  - larger HUD setting scales the scoreboard
 *  - layout at 1180 x 820, 4:3 and 21:9: no HUD part overlaps another, the touch controls or the viewport edge;
 *    screenshots in reports/uix-06-hud-*.png
 */
import { expect, test } from '@playwright/test';
import {
  boxes, collectConsole, expectInside, expectNoOverlap, freeze, hudEvents, hudUpdate, shot, startMatch, startMutations,
  takeMutations, touchBoxes,
} from './uix-06-harness';

const EV_GOAL = 9;
const EV_CARD = 6;
const EV_SUB = 10;
const EV_OFFSIDE = 7;

const HUD_IDS = ['hud-scoreboard', 'hud-toast', 'hud-hint', 'hud-radar', 'pi-p1', 'pi-p2'];

test.describe('UIX-06 scoreboard, clock, toasts', () => {
  test('scoreboard and toasts update on scripted events, idle frames write nothing, layout clear at 3 aspects', async ({ page }) => {
    test.setTimeout(240_000);
    const consoleMsgs = collectConsole(page);
    await startMatch(page);

    await test.step('scoreboard: codes, kit chips, score, running clock', async () => {
      await expect(page.getByTestId('sb-home')).not.toHaveText('---');
      await expect(page.getByTestId('sb-away')).not.toHaveText('---');
      await expect(page.getByTestId('sb-score')).toHaveText('0-0');
      await expect(page.getByTestId('sb-clock')).toHaveText(/^\d\d:\d\d$/);
      const chips = await page.evaluate(() => ['sb-home-kit', 'sb-away-kit'].map((id) => getComputedStyle(document.querySelector(`[data-testid="${id}"]`)!).backgroundColor));
      for (const c of chips) expect(c).toMatch(/^rgb/);
      const codes = await page.evaluate(() => {
        const s = window.__dotkick!.ctx.session.getState()!;
        const clubs = window.__dotkick!.ctx.clubs;
        return [clubs[s.teams[0]!.clubIdx]!.code, clubs[s.teams[1]!.clubIdx]!.code];
      });
      await expect(page.getByTestId('sb-home')).toHaveText(codes[0]!);
      await expect(page.getByTestId('sb-away')).toHaveText(codes[1]!);
      const font = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="sb-clock"]')!).fontVariantNumeric);
      expect(font).toContain('tabular-nums');
    });

    await test.step('idle frames: zero DOM writes', async () => {
      await freeze(page);
      await hudUpdate(page, 2);
      await startMutations(page);
      await hudUpdate(page, 120);
      expect(await takeMutations(page)).toBe(0);
    });

    await test.step('goal: score and GOAL toast with scorer and minute', async () => {
      const scorer = await page.evaluate(() => {
        const s = window.__dotkick!.ctx.session.getState()! as unknown as { teams: { goals: number }[]; players: { rosterIdx: number }[]; squads: { short: string }[][] };
        s.teams[0]!.goals = 1;
        return s.squads[0]![s.players[9]!.rosterIdx]!.short.toUpperCase();
      });
      await hudEvents(page, [[EV_GOAL, 0, 9, -1, 0]]);
      await hudUpdate(page, 1);
      await expect(page.getByTestId('sb-score')).toHaveText('1-0');
      await expect(page.getByTestId('toast-title')).toHaveText('GOAL');
      await expect(page.getByTestId('toast-line')).toHaveText(scorer);
      await expect(page.getByTestId('toast-minute')).toHaveText(/^\d+(\+\d+)?'$/);
      await expect(page.getByTestId('hud-toast')).toHaveClass(/is-in/);
      await page.waitForTimeout(300);
      await page.screenshot({ path: shot('uix-06-hud-goal.png') });
    });

    await test.step('queued toasts: card, substitution, offside follow the goal one at a time', async () => {
      await hudEvents(page, [[EV_CARD, 14, 1], [EV_SUB, 0, 7, 13, 7], [EV_OFFSIDE, 10]]);
      const titles: string[] = [];
      for (let i = 0; i < 12 && titles.length < 4; i++) {
        const t = (await page.getByTestId('toast-title').textContent()) ?? '';
        if (titles[titles.length - 1] !== t) titles.push(t);
        await hudUpdate(page, 1, 1000);
      }
      expect(titles).toEqual(['GOAL', 'YELLOW CARD', 'SUBSTITUTION', 'OFFSIDE']);
      await hudUpdate(page, 4, 1000);
      await expect(page.getByTestId('hud-toast')).toHaveClass(/is-out/);
      // Settled: no more writes.
      await startMutations(page);
      await hudUpdate(page, 60);
      expect(await takeMutations(page)).toBe(0);
    });

    await test.step('added time and the extra-time label', async () => {
      await page.evaluate(() => {
        const m = window.__dotkick!.ctx.session.getState()!.match as unknown as { periodT: number; periodLen: number; addedT: number };
        m.periodT = m.periodLen + 10;
        m.addedT = Math.ceil(m.periodLen / 15); // 3 displayed minutes
      });
      await hudUpdate(page, 1);
      await expect(page.getByTestId('sb-added')).toHaveText(/^\+\d+$/);
      await expect(page.getByTestId('sb-clock')).toHaveText(/^45:\d\d$/);
      await page.evaluate(() => {
        const m = window.__dotkick!.ctx.session.getState()!.match as unknown as { period: number; periodT: number; addedT: number };
        m.period = 3;
        m.periodT = 0;
        m.addedT = 0;
      });
      await hudUpdate(page, 1);
      await expect(page.getByTestId('sb-period')).toHaveText('ET');
      await expect(page.getByTestId('sb-clock')).toHaveText('90:00');
      await expect(page.getByTestId('sb-added')).toHaveText('');
      await page.evaluate(() => {
        const m = window.__dotkick!.ctx.session.getState()!.match as unknown as { period: number };
        m.period = 1;
      });
      await hudUpdate(page, 1);
      await expect(page.getByTestId('sb-period')).toHaveText('');
    });

    await test.step('larger HUD setting scales the scoreboard', async () => {
      const before = (await page.getByTestId('hud-scoreboard').boundingBox())!;
      await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.accessibility.largerHud = true; }));
      const after = (await page.getByTestId('hud-scoreboard').boundingBox())!;
      expect(after.height / before.height).toBeGreaterThan(1.2);
      expect(after.width).toBeGreaterThan(before.width * 1.15);
      await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.accessibility.largerHud = false; }));
    });

    await test.step('layout at 1180 x 820, 4:3 and 21:9 (normal and larger HUD): nothing overlaps', async () => {
      // A busy HUD: a toast, a corner hint card, player 2 on the right of the radar.
      await page.evaluate(() => {
        const s = window.__dotkick!.ctx.session.getState()! as unknown as {
          ctrl: { kind: number; side: number; slot: number }[]; players: { ctrl: number }[];
          match: { phase: number; restart: { kind: number; team: number } };
        };
        s.ctrl[1]!.kind = 1;
        s.ctrl[1]!.side = 1;
        s.ctrl[1]!.slot = 20;
        s.match.phase = 5; // CORNER
        s.match.restart.kind = 4;
        s.match.restart.team = 0;
        window.__dotkick!.ctx.settings.update((st) => { st.setPieceHintsSeen = {}; });
      });
      await hudEvents(page, [[EV_SUB, 1, 15, 14, 3]]);
      await hudUpdate(page, 1);
      for (const [w, h] of [[1180, 820], [1024, 768], [1260, 540]] as const) {
        for (const large of [false, true]) {
          await page.setViewportSize({ width: w, height: h });
          await page.evaluate((l) => window.__dotkick!.ctx.settings.update((s) => { s.accessibility.largerHud = l; }), large);
          await page.waitForTimeout(250);
          await hudUpdate(page, 1, 16.7);
          const hud = await boxes(page, HUD_IDS);
          expect(hud.map((b) => b.name)).toEqual(expect.arrayContaining(['hud-scoreboard', 'hud-toast', 'hud-hint', 'hud-radar', 'pi-p1', 'pi-p2']));
          const touch = await touchBoxes(page);
          const label = `${w}x${h}${large ? ' large' : ''}`;
          expectNoOverlap(hud, touch, label);
          expectInside(hud, w, h, label);
          await page.screenshot({ path: shot(`uix-06-hud-${w}x${h}${large ? '-large' : ''}.png`) });
        }
      }
      await page.setViewportSize({ width: 1180, height: 820 });
      await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.accessibility.largerHud = false; }));
    });

    await test.step('live play: DOM writes stay rare (clock seconds, stamina percent)', async () => {
      await page.evaluate(() => {
        const s = window.__dotkick!.ctx.session.getState()! as unknown as { ctrl: { kind: number; side: number; slot: number }[]; match: { phase: number } };
        s.ctrl[1]!.kind = 0;
        s.ctrl[1]!.side = -1;
        s.ctrl[1]!.slot = -1;
        s.match.phase = 2;
        window.__dotkick!.ctx.session.resume(-1);
      });
      await page.waitForTimeout(500);
      await startMutations(page);
      const f0 = await page.evaluate(() => window.__dotkickFrameStats!.frame);
      await page.waitForTimeout(2500);
      const f1 = await page.evaluate(() => window.__dotkickFrameStats!.frame);
      const muts = await takeMutations(page);
      const frames = Math.max(1, f1 - f0);
      expect(frames).toBeGreaterThan(5);
      expect(muts / frames).toBeLessThan(1.5);
    });

    expect(consoleMsgs).toEqual([]);
  });
});
