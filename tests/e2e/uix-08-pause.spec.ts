/**
 * UIX-08 e2e: pause menu and team management through the real app (router, FocusNavigator, menu input, session).
 *  - pause / resume rules with two humans (P1 touch, P2 keyboard): only the pauser resumes or quits; Quit confirms;
 *  - substitutions queued by touch (drag a substitute onto a player) and by controller (select-and-swap with the
 *    keyboard) show as pending while paused and appear on the pitch after the next stoppage; a formation change
 *    applies; Back on a sub-page returns to the pause menu instead of resuming;
 *  - layout: every control >= 60 pt and on screen at 1180x820, 4:3 and 21:9; screenshots in tmp/uix-08/.
 *
 *   npx vite build --outDir dist-e2e/uix-08 --emptyOutDir
 *   PW_DIST=dist-e2e/uix-08 PW_PORT=4208 npx playwright test tests/e2e/uix-08-pause.spec.ts
 */
import { expect, test } from '@playwright/test';
import { bootToMain, checkTargets, collectConsole, focused, focusOn, shot, startMatch, touchDrag } from './uix-08-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

test.describe('UIX-08 pause menu', () => {
  test('two humans: only the pauser resumes or quits; Quit asks to confirm', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    await startMatch(page, { twoHumans: true });
    await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 5);

    // P2 (keyboard) pauses with Escape.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.pausedBy)).toBe(1);
    await expect(page.locator('.pause-who')).toHaveText('Paused by Player 2');
    await shot(page, 'uix08-pause-main-1180');
    for (const [w, hgt, name] of [[1024, 768, '4x3'], [1260, 540, '21x9-small']] as const) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(100);
      await shot(page, `uix08-pause-main-${name}`);
      expect(await checkTargets(page, '[data-testid="pause-page-main"]'), name).toEqual([]);
    }
    await page.setViewportSize({ width: 1180, height: 820 });

    // P1 (touch) may not resume or quit.
    await page.getByTestId('pause-resume').tap();
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
    await expect(page.locator('.pause-who')).toHaveText('Only Player 2 can resume');
    await page.getByTestId('pause-quit').tap();
    await expect(page.locator('.pause-who')).toHaveText('Only Player 2 can quit');
    await expect(page.getByTestId('pause-quit-dialog')).toHaveCount(0);
    // The note returns to who paused.
    await expect(page.locator('.pause-who')).toHaveText('Paused by Player 2', { timeout: 5000 });

    // P2 resumes with the keyboard (Confirm on the focused Resume).
    await focusOn(page, 'pause-resume');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !window.__dotkick!.ctx.session.paused);
    await expect(page.getByTestId('pause-menu')).toBeHidden();

    // P1 pauses; P2's Back (Escape) cannot resume.
    await page.waitForTimeout(350);
    await page.evaluate(() => window.__dotkick!.ctx.session.pause(0));
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.waitForTimeout(350);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.pausedBy)).toBe(0);

    // P1 quits: the confirmation can be dismissed, then confirmed.
    await page.getByTestId('pause-quit').tap();
    await expect(page.getByTestId('pause-quit-dialog')).toBeVisible();
    await shot(page, 'uix08-pause-quit-confirm');
    await page.getByTestId('pause-quit-cancel').tap();
    await expect(page.getByTestId('pause-quit-dialog')).toHaveCount(0);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.active)).toBe(true);
    await page.getByTestId('pause-quit').tap();
    await page.getByTestId('pause-quit-confirm').tap();
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'main');
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.active)).toBe(false);
    expect(messages).toEqual([]);
  });

  test('substitutions by touch drag and by controller apply at the next stoppage; formation change applies', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    await startMatch(page);
    // Pause at once, during the kick-off stoppage.
    await page.evaluate(() => window.__dotkick!.ctx.session.pause(0));
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.getByTestId('pause-team').tap();
    await expect(page.getByTestId('pause-page-team')).toBeVisible();
    await expect(page.getByTestId('pause-subs-left')).toHaveText('Subs left 5/5');
    // Eleven on the pitch with stamina bars, the seven substitutes on the bench.
    await expect(page.locator('[data-testid^="pause-xi-"]')).toHaveCount(11);
    await expect(page.locator('[data-testid^="pause-bench-"]')).toHaveCount(7);
    await expect(page.locator('.tm-tok .tm-sta')).toHaveCount(11);
    // Squad indices 11..17: two outfield substitutes and the bench keeper.
    const subs = await page.evaluate(() => {
      const sq = (window.__dotkick!.ctx.session as any).runtime().curr.squads[0];
      const field: number[] = [];
      let keeper = -1;
      for (let r = 11; r < 18; r++) {
        if (sq[r].pos === 0) keeper = r;
        else field.push(r);
      }
      return { a: field[0]!, b: field[1]!, k: keeper };
    });
    expect(subs.k).toBeGreaterThan(0);

    // Touch: drag substitute A onto player slot 9.
    await touchDrag(page, page.getByTestId(`pause-bench-${subs.a}`), page.getByTestId('pause-xi-9'));
    await expect(page.getByTestId(`pause-pending-${subs.a}`)).toBeVisible();
    await expect(page.getByTestId('pause-xi-9')).toHaveClass(/is-pending/);
    await expect(page.getByTestId('pause-subs-left')).toHaveText('Subs left 4/5');

    // Controller: select substitute B (Confirm), move left onto the pitch, Confirm on a player.
    await focusOn(page, `pause-bench-${subs.b}`);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(`pause-bench-${subs.b}`)).toHaveAttribute('data-selected', '');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => focused(page)).toMatch(/^pause-xi-/);
    let target = await focused(page);
    if (target === 'pause-xi-9') {
      await page.keyboard.press('ArrowUp');
      await expect.poll(() => focused(page)).not.toBe('pause-xi-9');
      target = await focused(page);
    }
    expect(target).toMatch(/^pause-xi-/);
    expect(target).not.toBe('pause-xi-9');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(`pause-pending-${subs.b}`)).toBeVisible();
    const slot2 = Number(target!.replace('pause-xi-', ''));

    // The bench keeper can only replace the keeper.
    await focusOn(page, `pause-bench-${subs.k}`);
    await page.keyboard.press('Enter');
    // Menu keys are read on the next animation frame: wait for the selection before moving the focus.
    await expect(page.getByTestId(`pause-bench-${subs.k}`)).toHaveAttribute('data-selected', '');
    await focusOn(page, 'pause-xi-5');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('pause-sub-note')).toHaveText('A keeper can only replace the keeper');
    await expect(page.getByTestId('pause-subs-left')).toHaveText('Subs left 3/5');

    // Formation: Right on the focused selector picks the next formation (pending).
    await focusOn(page, 'pause-formation');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('pause-formation')).toContainText('4-3-3');
    await expect(page.getByTestId('pause-formation')).toContainText('pending');

    // Nothing reached the sim while paused.
    const before = await page.evaluate(({ a, b }) => {
      const s = (window.__dotkick!.ctx.session as any).runtime().curr;
      return { a: s.teams[0].roster[a], b: s.teams[0].roster[b], f: s.teams[0].formation, q: s.teams[0].subCount };
    }, subs);
    expect(before).toEqual({ a: 0, b: 0, f: 0, q: 0 });

    for (const [w, hgt, name] of [[1180, 820, '1180'], [1024, 768, '4x3'], [1680, 720, '21x9'], [1260, 540, '21x9-small']] as const) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(100);
      await shot(page, `uix08-team-${name}`);
      expect(await checkTargets(page, '[data-testid="pause-page-team"]'), `targets at ${name}`).toEqual([]);
    }
    await page.setViewportSize({ width: 1180, height: 820 });

    // Back (Escape) on a sub-page returns to the pause menu; it does not resume.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-page-main')).toBeVisible();
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
    await expect(page.getByTestId('pause-team')).toHaveAttribute('data-focused', '');

    // Resume: the orders go out and the substitutions are made at the stoppage.
    await page.getByTestId('pause-resume').tap();
    await page.waitForFunction(({ slot, a, b }) => {
      const s = (window.__dotkick!.ctx.session as any).runtime().curr;
      const t = s.teams[0];
      return t.roster[a] === 1 && t.roster[b] === 1 && t.formation === 1 && s.players[9].rosterIdx === a && s.players[slot].rosterIdx === b;
    }, { slot: slot2, a: subs.a, b: subs.b }, { timeout: 30_000 });

    // The new players are on the team-management pitch; subs left 3.
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__dotkick!.ctx.session.pause(0));
    await page.getByTestId('pause-team').tap();
    const shirtA = await page.evaluate((a) => (window.__dotkick!.ctx.session as any).runtime().curr.squads[0][a].shirt, subs.a);
    await expect(page.getByTestId('pause-xi-9').locator('.tm-tok__num')).toHaveText(String(shirtA));
    await expect(page.getByTestId('pause-subs-left')).toHaveText('Subs left 3/5');
    await expect(page.getByTestId('pause-bench-9')).toBeDisabled();
    await expect(page.getByTestId('pause-formation')).toContainText('4-3-3');
    await shot(page, 'uix08-team-after');

    // Quick sub (D-pad down, down -> Command.QUICK_SUB; the loop hook is a change request, so the menu's own entry
    // point is driven here): the compact prompt pauses the match for that human.
    await page.getByTestId('pause-back').tap();
    await page.getByTestId('pause-resume').tap();
    await page.waitForFunction(() => !window.__dotkick!.ctx.session.paused);
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).__dotkickPause.openQuickSub(0));
    await expect(page.getByTestId('pause-page-quick')).toBeVisible();
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.pausedBy)).toBe(0);
    await expect(page.locator('[data-testid="pause-tired"] [data-drop="xi"]')).toHaveCount(4);
    await shot(page, 'uix08-quick-sub');
    expect(await checkTargets(page, '[data-testid="pause-page-quick"]')).toEqual([]);
    await page.getByTestId('pause-quick-done').tap();
    await page.waitForFunction(() => !window.__dotkick!.ctx.session.paused);
    expect(messages).toEqual([]);
  });
});
