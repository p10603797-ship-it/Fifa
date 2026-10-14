/**
 * UIX-10 e2e: half-time and full-time screens through the real app.
 *  - a short scripted match (2-minute halves, clock fast-forwarded): the half-time screen shows the score and the
 *    stats so far; its Substitutions shortcut opens the pause menu's team page and Resume returns to half time;
 *    Continue by touch starts the second half; the full-time interim continues by keyboard; the final screen shows
 *    exactly the numbers of the session's MatchSummary; Change Teams (keyboard) opens team select in the same mode;
 *  - a crafted summary: scorers with minutes (a brace listed once, an own goal marked), player of the match, Rematch
 *    by touch (new seed), Quit by keyboard (main menu);
 *  - layout: every control >= 60 pt and on screen at 1180x820, 4:3 and 21:9; screenshots in tmp/uix-08/.
 *
 *   npx vite build --outDir dist-e2e/uix-08 --emptyOutDir
 *   PW_DIST=dist-e2e/uix-08 PW_PORT=4208 npx playwright test tests/e2e/uix-10-breaks.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { bootToMain, checkTargets, collectConsole, focusOn, shot, startMatch } from './uix-08-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

const route = (page: Page): Promise<string | null> => page.evaluate(() => window.__dotkick!.ctx.router.current);

/** Expected display text per stat row (mirrors statRows in src/ui/screens/halfTime.ts). */
function expectedRows(sum: any): Record<string, [string, string]> {
  const [a, b] = sum.teams;
  const pa = Math.round(Math.min(1, Math.max(0, a.possession)) * 100);
  const acc = (t: any) => (t.passes > 0 ? Math.round((t.passesCompleted / t.passes) * 100) : 0);
  return {
    possession: [`${pa}%`, `${100 - pa}%`],
    shots: [String(a.shots), String(b.shots)],
    onTarget: [String(a.shotsOnTarget), String(b.shotsOnTarget)],
    passes: [`${a.passesCompleted}/${a.passes}`, `${b.passesCompleted}/${b.passes}`],
    passAccuracy: [`${acc(a)}%`, `${acc(b)}%`],
    tackles: [String(a.tackles), String(b.tackles)],
    fouls: [String(a.fouls), String(b.fouls)],
    yellow: [String(a.yellow), String(b.yellow)],
    red: [String(a.red), String(b.red)],
    offsides: [String(a.offsides), String(b.offsides)],
    corners: [String(a.corners), String(b.corners)],
    saves: [String(a.saves), String(b.saves)],
  };
}

test.describe('UIX-10 half-time and full-time', () => {
  test('scripted match: half-time stats and shortcut, full-time numbers from the summary, Change Teams', async ({ page }) => {
    test.setTimeout(240_000);
    const messages = collectConsole(page);
    await bootToMain(page);
    await startMatch(page, { halfMinutes: 2, seed: 777 });
    // Fast-forward each half to its last half second; hold the half-time break while it is inspected.
    await page.evaluate(() => {
      const w = window as any;
      w.__uix10hold = true;
      w.__uix10timer = setInterval(() => {
        const rt = w.__dotkick?.ctx.session.runtime?.();
        if (!rt) return;
        const m = rt.curr.match;
        if ((m.period === 1 || m.period === 2) && m.clockRunning && m.periodT < m.periodLen - 30) {
          m.periodT = m.periodLen - 30;
          m.addedT = 0;
        }
        if (m.phase === 11 && w.__uix10hold) m.phaseT = 1;
        // Software WebGL runs the sim slowly here: a human-side restart is taken by its default action at once.
        const r = m.restart;
        if (m.phase >= 1 && m.phase <= 7 && r.ready === 1 && r.timeoutT > 5) r.timeoutT = 5;
      }, 50);
    });

    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'half-time', null, { timeout: 90_000 });
    await expect(page.getByTestId('half-time-title')).toHaveText('Half time');
    await expect(page.getByTestId('ht-stats')).toBeVisible();
    const half = await page.evaluate(() => {
      const rt = (window.__dotkick!.ctx.session as any).runtime();
      return JSON.parse(JSON.stringify(rt.stats.summary(rt.curr)));
    });
    const hRows = expectedRows(half);
    for (const k of ['shots', 'onTarget', 'passes', 'corners', 'fouls']) {
      await expect(page.getByTestId(`stat-${k}-home`)).toHaveText(hRows[k]![0]);
      await expect(page.getByTestId(`stat-${k}-away`)).toHaveText(hRows[k]![1]);
    }
    await expect(page.getByTestId('brk-goals-0')).toHaveText(String(half.teams[0].goals));
    await shot(page, 'uix10-half-time-1180');
    expect(await checkTargets(page, '[data-screen="half-time"]')).toEqual([]);

    // Substitutions shortcut: pause menu team page; Resume (labelled "Back to half time") returns here.
    await page.getByTestId('ht-team').tap();
    await expect(page.getByTestId('pause-page-team')).toBeVisible();
    expect(await route(page)).toBe('match');
    await page.getByTestId('pause-back').tap();
    await expect(page.getByTestId('pause-resume')).toHaveText('Back to half time');
    await page.getByTestId('pause-resume').tap();
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'half-time');

    // Continue by touch: the second half starts.
    await page.evaluate(() => {
      (window as any).__uix10hold = false;
    });
    await page.getByTestId('ht-continue').tap();
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'match', null, { timeout: 15_000 });

    // Full time interim: Continue by keyboard (Confirm on the default focus).
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'full-time', null, { timeout: 90_000 });
    await expect(page.getByTestId('ft-continue')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('full-time-panel')).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => clearInterval((window as any).__uix10timer));

    // The final screen shows the summary's numbers.
    const sum = await page.evaluate(() => JSON.parse(JSON.stringify((window.__dotkick!.ctx.session as any).lastSummary)));
    expect(sum).not.toBeNull();
    await expect(page.getByTestId('brk-goals-0')).toHaveText(String(sum.teams[0].goals));
    await expect(page.getByTestId('brk-goals-1')).toHaveText(String(sum.teams[1].goals));
    const rows = expectedRows(sum);
    for (const [k, [home, away]] of Object.entries(rows)) {
      await expect(page.getByTestId(`stat-${k}-home`), k).toHaveText(home);
      await expect(page.getByTestId(`stat-${k}-away`), k).toHaveText(away);
    }
    for (const [w, hgt, name] of [[1180, 820, '1180'], [1024, 768, '4x3'], [1680, 720, '21x9']] as const) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(100);
      await shot(page, `uix10-full-time-${name}`);
      expect(await checkTargets(page, '[data-screen="full-time"]'), name).toEqual([]);
    }
    await page.setViewportSize({ width: 1180, height: 820 });

    // Change Teams by keyboard: team select in the same mode, the match left behind.
    await focusOn(page, 'ft-change-teams');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'team-select');
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.active)).toBe(false);
    expect(messages).toEqual([]);
  });

  test('crafted summary: scorers, player of the match, Rematch by touch, Quit by keyboard', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    await startMatch(page, { seed: 99 });
    const showFinal = async (): Promise<void> => {
      await page.evaluate(() => {
        const ctx = window.__dotkick!.ctx;
        ctx.session.pause(0);
        const t = () => ({
          goals: 0, shots: 7, shotsOnTarget: 4, possession: 0.556, passes: 120, passesCompleted: 101, tackles: 9, tacklesWon: 6,
          fouls: 3, yellow: 1, red: 0, offsides: 2, corners: 5, saves: 2, interceptions: 4,
        });
        const a = t();
        const b = { ...t(), shots: 3, shotsOnTarget: 1, possession: 0.444, passes: 80, passesCompleted: 55, red: 1, saves: 3 };
        a.goals = 3;
        b.goals = 1;
        const summary = {
          teams: [a, b], players: [], playerOfMatch: null, shootout: null, winner: 0, forfeit: -1, ticks: 20000,
          goals: [
            { team: 0, rosterIdx: 9, assistRosterIdx: 7, ownGoal: false, minute: 12 },
            { team: 1, rosterIdx: 10, assistRosterIdx: -1, ownGoal: false, minute: 30 },
            { team: 0, rosterIdx: 9, assistRosterIdx: -1, ownGoal: false, minute: 67 },
            { team: 0, rosterIdx: 4, assistRosterIdx: -1, ownGoal: true, minute: 81 },
          ],
        };
        ctx.router.go('full-time', { final: true, summary });
      });
      await expect(page.getByTestId('full-time-panel')).toBeVisible();
    };
    await showFinal();
    const names = await page.evaluate(() => {
      const sq = (window.__dotkick!.ctx.session as any).runtime().curr.squads;
      return { scorer: sq[0][9].name, away: sq[1][10].name, og: sq[1][4].name };
    });
    await expect(page.getByTestId('brk-scorers-0')).toContainText(`${names.scorer} 12', 67'`);
    await expect(page.getByTestId('brk-scorers-0')).toContainText(`${names.og} 81' (og)`);
    await expect(page.getByTestId('brk-scorers-1')).toContainText(`${names.away} 30'`);
    await expect(page.getByTestId('ft-potm-name')).toHaveText(names.scorer);
    await expect(page.getByTestId('ft-potm-line')).toHaveText('2 goals');
    await expect(page.getByTestId('stat-possession-home')).toHaveText('56%');
    await expect(page.getByTestId('stat-passAccuracy-away')).toHaveText('69%');
    await expect(page.getByTestId('stat-red-away')).toHaveText('1');
    await shot(page, 'uix10-full-time-crafted');
    // The actions stay on screen at every aspect (the stats scroll instead).
    for (const [w, hgt, name] of [[1680, 720, '21x9'], [1260, 540, '21x9-small'], [1024, 768, '4x3']] as const) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(100);
      await shot(page, `uix10-full-time-crafted-${name}`);
      for (const id of ['ft-rematch', 'ft-change-teams', 'ft-quit']) {
        const b = await page.getByTestId(id).boundingBox();
        expect(b && b.y >= 0 && b.y + b.height <= hgt && b.height >= 60, `${id} at ${name}`).toBe(true);
      }
      expect(await checkTargets(page, '[data-screen="full-time"]'), name).toEqual([]);
    }
    await page.setViewportSize({ width: 1180, height: 820 });

    // Rematch by touch: same setup, new seed.
    const seed0 = await page.evaluate(() => window.__dotkick!.ctx.session.getSetup()!.config.seed);
    await page.getByTestId('ft-rematch').tap();
    await page.waitForFunction(() => {
      const c = window.__dotkick!.ctx;
      return c.router.current === 'match' && c.session.getState() !== null;
    }, null, { timeout: 45_000 });
    const seed1 = await page.evaluate(() => window.__dotkick!.ctx.session.getSetup()!.config.seed);
    expect(seed1).not.toBe(seed0);

    // Quit by keyboard: main menu.
    await showFinal();
    await focusOn(page, 'ft-quit');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'main');
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.active)).toBe(false);
    expect(messages).toEqual([]);
  });
});
