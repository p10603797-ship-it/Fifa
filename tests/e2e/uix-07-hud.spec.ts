/**
 * UIX-07 e2e: radar, controlled-player panel and power bar in a real match (iPad 1180 x 820; keyboard play).
 *  - the radar canvas redraws while the match runs, never faster than 20 Hz
 *  - player 1's panel names the controlled player with his shirt number; stamina drains on the bar while sprinting
 *  - the power bar shows above the player while PASS is held with the ball, and follows ctrl.power exactly
 *  - zero DOM writes while nothing changes; screenshot reports/uix-07-power.png
 */
import { expect, test, type Page } from '@playwright/test';
import { collectConsole, freeze, hudUpdate, reachInPlay, shot, startMatch, startMutations, takeMutations } from './uix-06-harness';

interface Ctl { slot: number; stamina: number; fill: number; phase: number }

async function controlled(page: Page): Promise<Ctl> {
  return page.evaluate(() => {
    const s = window.__dotkick!.ctx.session.getState()!;
    const slot = s.ctrl[0]!.slot;
    const fillEl = document.querySelector<HTMLElement>('[data-testid="pi-p1-fill"]')!;
    const m = /scaleX\(([\d.]+)\)/.exec(fillEl.style.transform);
    return { slot, stamina: slot >= 0 ? s.players[slot]!.stamina : -1, fill: m ? Number(m[1]) : -1, phase: s.match.phase };
  });
}

test.describe('UIX-07 radar, player name and stamina, power bar', () => {
  test('radar redraws at <= 20 Hz, stamina drains while sprinting, power bar while holding PASS', async ({ page }) => {
    test.setTimeout(240_000);
    const consoleMsgs = collectConsole(page);
    await startMatch(page);
    await page.keyboard.press('KeyW'); // keyboard becomes the last used device
    await reachInPlay(page);

    await test.step('radar: visible, redrawing while play runs, at most 20 Hz', async () => {
      await expect(page.getByTestId('hud-radar')).toBeVisible();
      const read = (): Promise<{ draws: number; frame: number; t: number; tick: number }> => page.evaluate(() => {
        const c = document.querySelector('[data-testid="radar-canvas"]') as unknown as { __radarDraws?: number };
        return { draws: c.__radarDraws ?? 0, frame: window.__dotkickFrameStats!.frame, t: performance.now(), tick: window.__dotkick!.ctx.session.getState()!.tick };
      });
      const a = await read();
      await page.waitForTimeout(3000);
      const b = await read();
      const draws = b.draws - a.draws;
      const secs = (b.t - a.t) / 1000;
      expect(b.tick).toBeGreaterThan(a.tick);
      expect(draws).toBeGreaterThan(0);
      expect(draws).toBeLessThanOrEqual(b.frame - a.frame);
      expect(draws / secs).toBeLessThanOrEqual(21);
    });

    await test.step('radar toggle (settings / pause menus): hides the radar, the panel moves in, shows again', async () => {
      const before = (await page.getByTestId('pi-p1').boundingBox())!;
      await page.evaluate(() => window.__dotkickHud!.setRadarEnabled(window.__dotkick!.ctx.settings, false));
      await expect(page.getByTestId('hud-radar')).toBeHidden();
      const moved = (await page.getByTestId('pi-p1').boundingBox())!;
      expect(moved.x).toBeGreaterThan(before.x + 50);
      await page.evaluate(() => window.__dotkickHud!.setRadarEnabled(window.__dotkick!.ctx.settings, true));
      await expect(page.getByTestId('hud-radar')).toBeVisible();
      expect(await page.evaluate(() => window.__dotkick!.ctx.settings.loadProgress<{ on: boolean }>('hud.radar'))).toEqual({ on: true });
    });

    await test.step('player 1 panel: controlled player name and number', async () => {
      await expect(page.getByTestId('pi-p1')).toBeVisible();
      await expect(page.getByTestId('pi-p2')).toBeHidden();
      const want = await page.evaluate(() => {
        const s = window.__dotkick!.ctx.session.getState()!;
        const p = s.players[s.ctrl[0]!.slot]!;
        const d = s.squads[p.team]![p.rosterIdx]!;
        return { name: d.short.toUpperCase(), num: String(d.shirt) };
      });
      await expect(page.getByTestId('pi-p1-name')).toHaveText(want.name);
      await expect(page.getByTestId('pi-p1-num')).toHaveText(want.num);
    });

    await test.step('stamina drains on the bar while sprinting', async () => {
      let minFill = 1;
      let matched = false;
      const dirs = ['ArrowRight', 'ArrowLeft'];
      await page.keyboard.down('ShiftLeft');
      for (let i = 0; i < 8 && minFill >= 1; i++) {
        const phase = await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.match.phase);
        if (phase !== 2) {
          await page.keyboard.up('ShiftLeft');
          await reachInPlay(page);
          await page.keyboard.down('ShiftLeft');
        }
        const dir = dirs[i % 2]!;
        await page.keyboard.down(dir);
        for (let k = 0; k < 6; k++) {
          await page.waitForTimeout(250);
          const c = await controlled(page);
          if (c.fill >= 0 && c.fill < minFill) {
            minFill = c.fill;
            // The bar shows the controlled player's stamina to the percent.
            matched = Math.abs(c.fill - Math.round(c.stamina * 100) / 100) <= 0.011;
          }
        }
        await page.keyboard.up(dir);
      }
      await page.keyboard.up('ShiftLeft');
      expect(minFill).toBeLessThan(1);
      expect(matched).toBe(true);
    });

    await test.step('power bar shows while PASS is held with the ball', async () => {
      let shown = false;
      for (let attempt = 0; attempt < 4 && !shown; attempt++) {
        await reachInPlay(page);
        await page.evaluate(() => {
          const s = window.__dotkick!.ctx.session.getState()! as unknown as {
            tick: number; ctrl: { slot: number }[]; players: { x: number; z: number; team: number }[];
            ball: Record<string, number>;
          };
          const slot = s.ctrl[0]!.slot;
          const p = s.players[slot]!;
          const b = s.ball;
          Object.assign(b, { x: p.x + 0.4, z: p.z, y: 0.11, px: p.x + 0.4, pz: p.z, py: 0.11, vx: 0, vy: 0, vz: 0, grounded: 1 });
          Object.assign(b, { owner: slot, ownerT: 0, heldBy: -1, lastTouch: slot, lastTouchTeam: p.team, lastTouchTick: s.tick, passTarget: -1 });
        });
        await page.keyboard.down('KeyJ');
        for (let k = 0; k < 8 && !shown; k++) {
          await page.waitForTimeout(80);
          shown = await page.evaluate(() => document.querySelector('[data-testid="pb-p1"]')!.classList.contains('is-on'));
        }
        if (shown) await page.screenshot({ path: shot('uix-07-power-live.png') });
        await page.keyboard.up('KeyJ');
        await page.waitForTimeout(400);
      }
      expect(shown).toBe(true);
      // After the release the bar goes away.
      await expect(page.getByTestId('pb-p1')).not.toHaveClass(/is-on/);
    });

    await test.step('power bar follows ctrl.power above the player; idle frames write nothing', async () => {
      await freeze(page);
      const where = await page.evaluate(() => {
        const d = window.__dotkick!;
        const s = d.ctx.session.getState()! as unknown as { ctrl: { powerBtn: number; power: number; slot: number }[]; players: { x: number; z: number }[] };
        s.ctrl[0]!.powerBtn = 1;
        s.ctrl[0]!.power = 0.6;
        const p = s.players[s.ctrl[0]!.slot]!;
        const o = { x: 0, y: 0 };
        d.app.renderer.projector.pitchToScreen(p.x, 2.25, p.z, o);
        return o;
      });
      await hudUpdate(page, 1);
      await expect(page.getByTestId('pb-p1')).toHaveClass(/is-on/);
      const fill = await page.evaluate(() => (document.querySelector('[data-testid="pb-p1-fill"]') as HTMLElement).style.transform);
      expect(fill).toBe('scaleX(0.6)');
      await page.waitForTimeout(200);
      const box = (await page.getByTestId('pb-p1').boundingBox())!;
      expect(Math.abs(box.x + box.width / 2 - where.x)).toBeLessThanOrEqual(2);
      // Above the overhead marker (20..40 px tall) plus a small gap: close to the player, never on him.
      expect(box.y + box.height).toBeLessThanOrEqual(where.y - 20);
      expect(where.y - (box.y + box.height)).toBeLessThanOrEqual(40 + 10);
      await page.screenshot({ path: shot('uix-07-power.png') });
      await startMutations(page);
      await hudUpdate(page, 60);
      expect(await takeMutations(page)).toBe(0);
      await page.evaluate(() => {
        const s = window.__dotkick!.ctx.session.getState()! as unknown as { ctrl: { powerBtn: number; power: number }[] };
        s.ctrl[0]!.power = 0.9;
      });
      await hudUpdate(page, 1);
      expect(await page.evaluate(() => (document.querySelector('[data-testid="pb-p1-fill"]') as HTMLElement).style.transform)).toBe('scaleX(0.9)');
      await page.evaluate(() => {
        const s = window.__dotkick!.ctx.session.getState()! as unknown as { ctrl: { powerBtn: number }[] };
        s.ctrl[0]!.powerBtn = 0;
      });
      await hudUpdate(page, 1);
      await expect(page.getByTestId('pb-p1')).not.toHaveClass(/is-on/);
    });

    await test.step('low stamina turns the bar amber, then red', async () => {
      const set = (v: number): Promise<void> => page.evaluate((st) => {
        const s = window.__dotkick!.ctx.session.getState()! as unknown as { ctrl: { slot: number }[]; players: { stamina: number }[] };
        s.players[s.ctrl[0]!.slot]!.stamina = st;
      }, v);
      await set(0.3);
      await hudUpdate(page, 1);
      await expect(page.getByTestId('pi-p1')).toHaveAttribute('data-stamina', 'low');
      await set(0.1);
      await hudUpdate(page, 1);
      await expect(page.getByTestId('pi-p1')).toHaveAttribute('data-stamina', 'critical');
      expect(await page.evaluate(() => (document.querySelector('[data-testid="pi-p1-fill"]') as HTMLElement).style.transform)).toBe('scaleX(0.1)');
    });

    expect(consoleMsgs).toEqual([]);
  });
});
