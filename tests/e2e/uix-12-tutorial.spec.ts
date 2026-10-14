/**
 * UIX-12 e2e: guided tutorial and set-piece hints (iPad 1180 x 820).
 *  - tutorial screen by touch (device follows the input in use) and by keyboard alone (focus ring, select a step,
 *    Start), screenshots reports/uix-12-tutorial-*.png
 *  - the practice match shows the coach card; "move" and "sprint" complete from real keyboard input, "pass" from a
 *    scripted KICK event; progress lands in settings.tutorialDone; quitting returns to the tutorial with the steps done
 *  - set-piece hint cards: the first three corners show one (counted in settings.setPieceHintsSeen), the fourth does
 *    not; a card is dismissed by the action; a penalty against the human shows the saving hint
 */
import { expect, test, type Page } from '@playwright/test';
import { collectConsole, freeze, hudEvents, hudUpdate, shot, waitTicking } from './uix-06-harness';

const EV_KICK = 0;
const KICK_GROUND_PASS = 1;

async function focusedTestId(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector<HTMLElement>('[data-focused]')?.dataset.testid ?? '');
}

/** Press `key` until `id` holds the focus ring (menu input is read once per frame, so each press is awaited). */
async function pressUntilFocused(page: Page, key: string, id: string, max = 6): Promise<void> {
  for (let i = 0; i < max && (await focusedTestId(page)) !== id; i++) {
    const before = await focusedTestId(page);
    await page.keyboard.press(key);
    await expect.poll(() => focusedTestId(page), { timeout: 2000 }).not.toBe(before).catch(() => undefined);
  }
  expect(await focusedTestId(page)).toBe(id);
}

async function done(page: Page, key: string): Promise<boolean> {
  return page.evaluate((k) => window.__dotkick!.ctx.settings.get().tutorialDone[k] === true, key);
}

async function reachInPlay(page: Page): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => {
      const s = window.__dotkick!.ctx.session.getState()!;
      return { phase: s.match.phase, ours: s.match.restart.team === s.ctrl[0]!.side };
    });
    if (st.phase === 2) return;
    if (st.phase === 1 && st.ours) {
      await page.keyboard.down('KeyJ');
      await page.waitForTimeout(120);
      await page.keyboard.up('KeyJ');
    }
    await page.waitForTimeout(500);
  }
  throw new Error('match never reached IN_PLAY');
}

/** Hold movement keys (alternating directions, optionally sprinting) until the step is stored as done. */
async function performUntil(page: Page, key: string, sprint: boolean): Promise<void> {
  const dirs = ['ArrowRight', 'ArrowLeft'];
  if (sprint) await page.keyboard.down('ShiftLeft');
  for (let i = 0; i < 16 && !(await done(page, key)); i++) {
    const d = dirs[i % 2]!;
    await page.keyboard.down(d);
    await page.waitForTimeout(900);
    await page.keyboard.up(d);
  }
  if (sprint) await page.keyboard.up('ShiftLeft');
  expect(await done(page, key)).toBe(true);
}

test.describe('UIX-12 tutorial and control hints', () => {
  test('tutorial advances on performed actions; set-piece hints show for the first three uses only', async ({ page }) => {
    test.setTimeout(300_000);
    const consoleMsgs = collectConsole(page);
    await page.goto('/');
    await page.getByTestId('splash-start').tap();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => {
      s.tutorialDone = {};
      s.setPieceHintsSeen = { 1: 3, 2: 3, 3: 3, 4: 3, 5: 3, 6: 3 };
    }));

    await test.step('tutorial screen by touch: nine steps for the touch controls', async () => {
      await page.evaluate(() => window.__dotkick!.ctx.router.go('tutorial'));
      await expect(page.getByTestId('tutorial-title')).toBeVisible();
      await expect(page.locator('.tut-step')).toHaveCount(9);
      await expect(page.getByTestId('tut-device-touch')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('tut-detail-title')).toHaveText('Move');
      await expect(page.getByTestId('tut-lines')).toContainText('STICK');
      await expect(page.getByTestId('tut-progress')).toHaveText('0/9 done');
      const h = (await page.getByTestId('tut-start').boundingBox())!.height;
      expect(h).toBeGreaterThanOrEqual(60);
      await page.screenshot({ path: shot('uix-12-tutorial-touch.png') });
      for (const [w, hh] of [[1024, 768], [1260, 540]] as const) {
        await page.setViewportSize({ width: w, height: hh });
        await page.waitForTimeout(200);
        for (const id of ['tut-start', 'tut-skip-step', 'tut-device-pad', 'back', 'tut-step-move']) {
          const b = (await page.getByTestId(id).boundingBox())!;
          expect(b.x >= 0 && b.y >= 0 && b.x + b.width <= w && b.y + b.height <= hh, `${id} inside ${w}x${hh}`).toBe(true);
          expect(b.height, `${id} target`).toBeGreaterThanOrEqual(60);
        }
        await page.screenshot({ path: shot(`uix-12-tutorial-${w}x${hh}.png`) });
      }
      await page.setViewportSize({ width: 1180, height: 820 });
    });

    await test.step('keyboard only: the device follows, the focus ring moves, a step is selected, Start', async () => {
      await page.keyboard.press('ArrowDown'); // reveals the ring
      await expect(page.getByTestId('tut-device-keyboard')).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });
      await expect(page.getByTestId('tut-lines')).toContainText('WASD');
      await expect.poll(() => focusedTestId(page)).toMatch(/^tut-step-/);
      // Select "sprint" with the keyboard, then go back to "move".
      await pressUntilFocused(page, 'ArrowDown', 'tut-step-sprint');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('tut-detail-title')).toHaveText('Sprint');
      await pressUntilFocused(page, 'ArrowUp', 'tut-step-move', 2);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('tut-detail-title')).toHaveText('Move');
      await page.screenshot({ path: shot('uix-12-tutorial-keyboard.png') });
      await pressUntilFocused(page, 'ArrowRight', 'tut-start', 1);
      await page.keyboard.press('Enter');
      await waitTicking(page, 10);
    });

    await test.step('practice match: coach card; move and sprint complete from real input, pass from its event', async () => {
      const setup = await page.evaluate(() => {
        const st = window.__dotkick!.ctx.session.getState()!;
        return { mode: st.config.mode, practice: st.config.practice };
      });
      expect(setup).toEqual({ mode: 5, practice: 5 }); // ModeId.PRACTICE, PracticeKind.TUTORIAL
      await expect(page.getByTestId('hud-hint')).toHaveClass(/is-on/);
      await expect(page.getByTestId('hint-eyebrow')).toHaveText('STEP 1');
      await expect(page.getByTestId('hint-title')).toHaveText('Move');
      await expect(page.getByTestId('hud-hint')).toHaveAttribute('data-device', 'keyboard');
      await expect(page.getByTestId('hint-lines')).toContainText('WASD');
      await reachInPlay(page);
      await performUntil(page, 'keyboard.move', false);
      await expect(page.getByTestId('hint-title')).toHaveText('Sprint', { timeout: 10_000 });
      await performUntil(page, 'keyboard.sprint', true);
      await expect(page.getByTestId('hint-title')).toHaveText('Pass', { timeout: 10_000 });
      await freeze(page);
      const slot = await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.ctrl[0]!.slot);
      await hudEvents(page, [[EV_KICK, slot, KICK_GROUND_PASS, 0.5]]);
      expect(await done(page, 'keyboard.pass')).toBe(true);
      await hudUpdate(page, 1);
      await expect(page.getByTestId('hint-eyebrow')).toHaveText('DONE');
      await hudUpdate(page, 1, 1300);
      await expect(page.getByTestId('hint-title')).toHaveText('Through ball');
      await expect(page.getByTestId('hint-count')).toHaveText('3/9');
      await page.waitForTimeout(250);
      await page.screenshot({ path: shot('uix-12-coach.png') });
    });

    await test.step('quitting the practice returns to the tutorial with the steps done', async () => {
      await page.evaluate(() => window.__dotkick!.ctx.session.quit());
      await expect.poll(() => page.evaluate(() => window.__dotkick!.ctx.router.current)).toBe('tutorial');
      await page.addStyleTag({ content: '#ui { visibility: visible !important; }' });
      for (const id of ['move', 'sprint', 'pass']) await expect(page.getByTestId(`tut-step-${id}`)).toHaveAttribute('data-done', '');
      await expect(page.getByTestId('tut-step-through')).not.toHaveAttribute('data-done', '');
      await expect(page.getByTestId('tut-progress')).toHaveText('3/9 done');
      await expect(page.getByTestId('tut-detail-title')).toHaveText('Through ball');
    });

    await test.step('set-piece hints: the first three corners show a card, the fourth does not', async () => {
      await page.evaluate(() => window.__dotkick!.ctx.router.go('main'));
      await page.getByTestId('main-kickoff').tap();
      await waitTicking(page, 10);
      await freeze(page);
      await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.setPieceHintsSeen = {}; }));
      const setPhase = (phase: number, kind: number, team: number): Promise<void> => page.evaluate(({ phase, kind, team }) => {
        const m = window.__dotkick!.ctx.session.getState()!.match as unknown as { phase: number; restart: { kind: number; team: number } };
        m.phase = phase;
        m.restart.kind = kind;
        m.restart.team = team;
      }, { phase, kind, team });
      const seen = (k: string): Promise<number> => page.evaluate((key) => window.__dotkick!.ctx.settings.get().setPieceHintsSeen[key] ?? 0, k);
      for (let i = 1; i <= 4; i++) {
        await setPhase(5, 4, 0); // CORNER for the human's side
        await hudUpdate(page, 1);
        if (i <= 3) {
          await expect(page.getByTestId('hud-hint')).toHaveClass(/is-on/);
          await expect(page.getByTestId('hint-title')).toHaveText('Corner');
          await expect(page.getByTestId('hint-lines')).toContainText('Short pass');
          if (i === 1) {
            await page.waitForTimeout(250);
            await page.screenshot({ path: shot('uix-12-hint-corner.png') });
          }
        } else {
          await expect(page.getByTestId('hud-hint')).not.toHaveClass(/is-on/);
        }
        expect(await seen('4')).toBe(Math.min(i, 3));
        await setPhase(2, 0, 0); // back in play: the card goes
        await hudUpdate(page, 1);
        await expect(page.getByTestId('hud-hint')).not.toHaveClass(/is-on/);
      }
    });

    await test.step('a card is dismissed by the action; a penalty against the human shows the saving hint', async () => {
      await page.evaluate(() => {
        const m = window.__dotkick!.ctx.session.getState()!.match as unknown as { phase: number; restart: { kind: number; team: number } };
        m.phase = 3; // THROW_IN
        m.restart.kind = 2;
        m.restart.team = 0;
      });
      await hudUpdate(page, 1);
      await expect(page.getByTestId('hint-title')).toHaveText('Throw-in');
      await page.evaluate(() => {
        const c = window.__dotkick!.ctx.session.getState()!.ctrl[0]! as unknown as { buttons: number; prevButtons: number };
        c.buttons = 1; // PASS pressed this tick
        c.prevButtons = 0;
      });
      await hudUpdate(page, 1);
      await expect(page.getByTestId('hud-hint')).not.toHaveClass(/is-on/);
      await page.evaluate(() => {
        const s = window.__dotkick!.ctx.session.getState()! as unknown as { ctrl: { buttons: number; prevButtons: number }[]; match: { phase: number; restart: { kind: number; team: number } } };
        s.ctrl[0]!.buttons = 0;
        s.match.phase = 2;
      });
      await hudUpdate(page, 1);
      await page.evaluate(() => {
        const m = window.__dotkick!.ctx.session.getState()!.match as unknown as { phase: number; restart: { kind: number; team: number } };
        m.phase = 7; // PENALTY to the CPU side
        m.restart.kind = 6;
        m.restart.team = 1;
      });
      await hudUpdate(page, 1);
      await expect(page.getByTestId('hint-title')).toHaveText('Save the penalty');
    });

    expect(consoleMsgs).toEqual([]);
  });
});
