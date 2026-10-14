/**
 * UIX-04 e2e: side select and device assignment through the real app (device registry, pad manager, menu input).
 *  - touch + a mocked pad: touch starts at home as P1; the pad's joining press (Cross) never confirms; its own D-pad
 *    moves only its token (P2, cyan, away); touch arrows, lane taps and a drag move tokens; a third human is refused;
 *    Continue writes the right HumanBinding[] and config.humans into match settings' params;
 *  - two mocked pads (Play a Friend): P1 / P2 on opposite sides by each pad's own D-pad; two humans on the same side
 *    (co-op) are allowed; numbering follows assignment order;
 *  - layout at iPad landscape, 4:3 and 21:9; screenshots.
 *
 *   npx vite build --outDir dist-e2e/uix-345 --emptyOutDir
 *   PW_DIST=dist-e2e/uix-345 PW_PORT=4235 npx playwright test tests/e2e/uix-04-side-select.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import {
  PAD, VIEWPORTS, checkLayout, collectConsole, expectCleanLayout, frames, mockPads, navParams, openMode, padTap, recordNavigation,
  route, shot, toMain, walkTo,
} from './uix-03-harness';

const lane = (page: Page, id: string): Promise<string | null> => page.getByTestId(`ss-token-${id}`).getAttribute('data-lane');
const human = (page: Page, id: string): Promise<string | null> => page.getByTestId(`ss-token-${id}`).getAttribute('data-human');

async function toSideSelect(page: Page, mode: number, by: 'touch' | 'pad'): Promise<void> {
  await openMode(page, mode);
  if (by === 'touch') {
    await page.getByTestId(mode === 1 ? 'mode-friend-local' : 'mode-continue').tap();
    await expect.poll(() => route(page)).toBe('team-select');
    await page.getByTestId('team-continue').tap();
  } else {
    await padTap(page, PAD.A);
    await expect.poll(() => route(page)).toBe('team-select');
    await padTap(page, PAD.UP);
    await walkTo(page, 'team-continue', () => padTap(page, PAD.RIGHT));
    await padTap(page, PAD.A);
  }
  await expect.poll(() => route(page)).toBe('side-select');
}

test.describe('UIX-04 side select', () => {
  test('touch + mocked pad: own-device moves, P1/P2 by assignment order, max two, right bindings', async ({ page }) => {
    const messages = collectConsole(page);
    await page.addInitScript(mockPads(1));
    await toMain(page, 'touch');
    await toSideSelect(page, 0, 'touch');
    await recordNavigation(page);
    // Touch (last used) starts at home as P1; the keyboard sits out; away is CPU.
    expect(await lane(page, 'touch')).toBe('home');
    expect(await human(page, 'touch')).toBe('0');
    await expect(page.getByTestId('ss-marker-touch')).toHaveText('P1');
    expect(await lane(page, 'keyboard')).toBe('centre');
    await expect(page.getByTestId('ss-away-ctrl')).toHaveText('CPU');
    await expect(page.getByTestId('ss-token-pad:1')).toHaveCount(0);

    // A pad appears when pressed; its joining press (Cross) does not confirm Continue.
    await padTap(page, PAD.A);
    await expect(page.getByTestId('ss-token-pad:1')).toBeVisible();
    await frames(page, 4);
    expect(await route(page)).toBe('side-select');
    expect(await lane(page, 'pad:1')).toBe('centre');
    // The pad's D-pad moves only its own token.
    await padTap(page, PAD.RIGHT);
    await expect.poll(() => lane(page, 'pad:1')).toBe('away');
    expect(await lane(page, 'touch')).toBe('home');
    expect(await human(page, 'pad:1')).toBe('1');
    await expect(page.getByTestId('ss-marker-pad:1')).toHaveText('P2');
    await expect(page.getByTestId('ss-away-ctrl')).toHaveText('P2');
    await expect(page.getByTestId('ss-token-pad:1')).toHaveCSS('border-top-color', 'rgb(62, 209, 246)'); // cyan
    await expect(page.getByTestId('ss-token-touch')).toHaveCSS('border-top-color', 'rgb(255, 107, 53)'); // ember
    // A third human is refused: the keyboard's own arrow keys cannot leave the centre.
    await page.keyboard.press('ArrowLeft');
    await frames(page, 2);
    expect(await lane(page, 'keyboard')).toBe('centre');
    await expect(page.getByTestId('ss-toast')).toBeVisible();
    await shot(page, 'uix-04-side-select-touch-pad-1180x820');

    // Touch arrows: touch to the centre -> the pad becomes P1; back home -> touch is P2 now.
    await page.getByTestId('ss-touch-right').tap();
    expect(await lane(page, 'touch')).toBe('centre');
    expect(await human(page, 'pad:1')).toBe('0');
    // The keyboard may join now (arrow keys), then leaves again.
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => lane(page, 'keyboard')).toBe('away');
    await page.keyboard.press('KeyA');
    await expect.poll(() => lane(page, 'keyboard')).toBe('centre');
    await page.getByTestId('ss-touch-left').tap();
    expect(await lane(page, 'touch')).toBe('home');
    expect(await human(page, 'touch')).toBe('1');
    // Drag (pointer) the pad token from away to home: a side-to-side drop keeps its number (P1).
    const tok = await page.getByTestId('ss-token-pad:1').boundingBox();
    const row = await page.getByTestId('ss-row-pad:1').boundingBox();
    expect(tok && row).toBeTruthy();
    const y = tok!.y + tok!.height / 2;
    await page.mouse.move(tok!.x + tok!.width / 2, y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(tok!.x + tok!.width / 2 - (i * (row!.width * 2 / 3)) / 8, y);
    await page.mouse.up();
    await expect.poll(() => lane(page, 'pad:1')).toBe('home');
    expect(await human(page, 'pad:1')).toBe('0');
    // Tapping a lane of a row moves that row's token there.
    await page.getByTestId('ss-lane-pad:1-away').tap({ position: { x: 20, y: 20 } });
    await expect.poll(() => lane(page, 'pad:1')).toBe('away');

    // Continue: touch home (P2), pad away (P1).
    await page.getByTestId('side-continue').tap();
    await expect.poll(() => route(page)).toBe('match-settings');
    const p = await navParams(page, 'match-settings');
    expect(p?.setup?.bindings).toEqual([{ human: 0, deviceIds: ['pad:1'] }, { human: 1, deviceIds: ['touch'] }]);
    expect(p?.setup?.config.humans.map((x) => [x.kind, x.side])).toEqual([[1, 1], [1, 0]]);
    const settings = await page.evaluate(() => window.__dotkick!.ctx.settings.get().controls);
    expect((p?.setup?.config.humans[0] as unknown as { assist: number }).assist).toBe(settings.assist);
    // Back restores the assignment.
    await page.getByTestId('back').tap();
    await expect.poll(() => route(page)).toBe('side-select');
    expect(await lane(page, 'pad:1')).toBe('away');
    expect(await lane(page, 'touch')).toBe('home');
    expect(await human(page, 'pad:1')).toBe('0');
    expect(messages).toEqual([]);
  });

  test('two pads (Play a Friend): P1 and P2 on opposite sides; same-side co-op allowed', async ({ page }) => {
    const messages = collectConsole(page);
    await page.addInitScript(mockPads(2));
    await toMain(page, 'pad');
    await toSideSelect(page, 1, 'pad');
    await recordNavigation(page);
    // Pad 1 (last used) is P1 at home; pad 2 is not known yet; Continue is blocked until a second player joins.
    expect(await lane(page, 'pad:1')).toBe('home');
    expect(await lane(page, 'touch')).toBe('centre');
    await expect(page.getByTestId('ss-status')).toHaveText(/second player/);
    await padTap(page, PAD.A); // Continue has the focus: refused with a reason
    expect(await route(page)).toBe('side-select');
    // Pad 2 joins with Cross (no confirm), then slides away with its own D-pad.
    await padTap(page, PAD.A, 1);
    await expect(page.getByTestId('ss-token-pad:2')).toBeVisible();
    expect(await route(page)).toBe('side-select');
    await padTap(page, PAD.RIGHT, 1);
    await expect.poll(() => lane(page, 'pad:2')).toBe('away');
    expect(await lane(page, 'pad:1')).toBe('home');
    expect(await human(page, 'pad:1')).toBe('0');
    expect(await human(page, 'pad:2')).toBe('1');
    await expect(page.getByTestId('ss-home-ctrl')).toHaveText('P1');
    await expect(page.getByTestId('ss-away-ctrl')).toHaveText('P2');
    await shot(page, 'uix-04-side-select-two-pads-1180x820');
    // Pad 1 steps right twice: through the centre (gives up P1) to the away side: co-op, CPU at home.
    await padTap(page, PAD.RIGHT, 0);
    await expect.poll(() => lane(page, 'pad:1')).toBe('centre');
    expect(await human(page, 'pad:2')).toBe('0');
    await padTap(page, PAD.RIGHT, 0);
    await expect.poll(() => lane(page, 'pad:1')).toBe('away');
    expect(await human(page, 'pad:1')).toBe('1');
    await expect(page.getByTestId('ss-home-ctrl')).toHaveText('CPU');
    await expect(page.getByTestId('ss-status')).toHaveText(/together/);
    // Back to opposite sides and continue with the controller.
    await padTap(page, PAD.LEFT, 0);
    await padTap(page, PAD.LEFT, 0);
    await expect.poll(() => lane(page, 'pad:1')).toBe('home');
    await padTap(page, PAD.A, 0);
    await expect.poll(() => route(page)).toBe('match-settings');
    const p = await navParams(page, 'match-settings');
    expect(p?.mode).toBe(1);
    expect(p?.setup?.bindings).toEqual([{ human: 0, deviceIds: ['pad:2'] }, { human: 1, deviceIds: ['pad:1'] }]);
    expect(p?.setup?.config.humans.map((x) => [x.kind, x.side])).toEqual([[1, 1], [1, 0]]);
    expect(messages).toEqual([]);
  });

  test('layout at iPad landscape, 4:3 and 21:9', async ({ page }) => {
    const messages = collectConsole(page);
    await page.addInitScript(mockPads(2));
    await toMain(page, 'touch');
    for (const v of VIEWPORTS) {
      await page.setViewportSize({ width: v.w, height: v.h });
      await toSideSelect(page, 0, 'touch');
      if (v === VIEWPORTS[0]) {
        // Both pads join here (their joining presses never confirm) and one slides away.
        await padTap(page, PAD.A, 0);
        await padTap(page, PAD.A, 1);
        await padTap(page, PAD.RIGHT, 1);
        await expect.poll(() => lane(page, 'pad:2')).toBe('away');
      }
      await frames(page, 3);
      expectCleanLayout(await checkLayout(page), `side-select ${v.name}`);
      await shot(page, `uix-04-side-select-${v.name}`);
      await page.evaluate(() => window.__dotkick!.app.router.resetTo('main'));
    }
    expect(messages).toEqual([]);
  });
});
