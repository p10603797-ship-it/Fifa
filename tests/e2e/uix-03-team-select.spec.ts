/**
 * UIX-03 e2e: team and kit select through the real app (router, FocusNavigator, menu input).
 *  - touch alone: Kick-Off -> mode setup -> team select; pick home and away clubs, a kit; the clash check result shows;
 *    Continue reaches side select with the partial MatchSetup (clubs, kits, formations) in its params;
 *  - keyboard alone and controller alone: arrows / D-pad browse the grid, Enter / Cross pick, Q E / L1 R1 switch the
 *    active side; the selection reaches side select;
 *  - layout at iPad landscape, 4:3 and 21:9: every control >= 60 pt, inside the viewport, no overlaps; screenshots.
 *
 *   npx vite build --outDir dist-e2e/uix-345 --emptyOutDir
 *   PW_DIST=dist-e2e/uix-345 PW_PORT=4235 npx playwright test tests/e2e/uix-03-team-select.spec.ts
 */
import { expect, test } from '@playwright/test';
import {
  PAD, VIEWPORTS, checkLayout, collectConsole, expectCleanLayout, focused, frames, mockPads, navParams, openMode, padTap,
  recordNavigation, route, shot, toMain, walkTo,
} from './uix-03-harness';

test.describe('UIX-03 team and kit select', () => {
  test('touch alone: pick clubs and kits, clash result shown, selection reaches side select', async ({ page }) => {
    const messages = collectConsole(page);
    await toMain(page, 'touch');
    await page.getByTestId('main-mode-kickoff').tap();
    await expect.poll(() => route(page)).toBe('mode-setup');
    await shot(page, 'uix-05-mode-setup-1180x820');
    await recordNavigation(page);
    await page.getByTestId('mode-continue').tap();
    await expect.poll(() => route(page)).toBe('team-select');
    const clubs = await page.evaluate(() => window.__dotkick!.ctx.clubs.map((c) => ({ code: c.code, formation: c.formation })));
    expect(clubs.length).toBe(20);
    await expect(page.getByTestId('ts-grid').locator('.ts-card')).toHaveCount(20);
    // Crests are generated images (GFX-08).
    expect(await page.getByTestId('ts-club-0').locator('img').getAttribute('src')).toMatch(/^data:image\/svg\+xml/);

    // Home is active first; a pick moves the active side to away.
    await expect(page.getByTestId('ts-panel-home')).toHaveClass(/is-active/);
    await page.getByTestId('ts-club-5').tap();
    await expect(page.getByTestId('ts-panel-away')).toHaveClass(/is-active/);
    await page.getByTestId('ts-club-12').tap();
    await expect(page.getByTestId('ts-name-home')).toHaveText(await page.evaluate(() => window.__dotkick!.ctx.clubs[5]!.name));
    await expect(page.getByTestId('ts-name-away')).toHaveText(await page.evaluate(() => window.__dotkick!.ctx.clubs[12]!.name));
    // Away kit chosen by touch; the clash line always reports the check.
    await page.getByTestId('ts-kit-away-away').tap();
    await expect(page.getByTestId('ts-kit-away-away')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('ts-clash-away')).toHaveText(/clash/i);
    // Same club on both sides: the clash check moves the away side off the home kit.
    await page.getByTestId('ts-side-away').tap();
    await page.getByTestId('ts-club-5').tap();
    await expect(page.getByTestId('ts-kit-away-away')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('ts-kit-away-home').tap();
    await expect(page.getByTestId('ts-clash-away')).toHaveText(/Clash: (switch|wear)/);
    await expect(page.getByTestId('ts-clash-away')).toHaveClass(/is-warn/);
    await shot(page, 'uix-03-team-select-clash-1180x820');
    // Back to a clear fixture, then Random for the active (away) side never equals home.
    await page.getByTestId('ts-club-12').tap();
    await page.getByTestId('ts-kit-away-away').tap();
    await page.getByTestId('ts-random').tap();
    const randomAway = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll<HTMLElement>('.ts-card.is-away'));
      return cards.map((c) => Number(c.dataset.testid!.replace('ts-club-', '')));
    });
    expect(randomAway.length).toBe(1);
    expect(randomAway[0]).not.toBe(5);
    await page.getByTestId(`ts-club-12`).tap();
    await page.getByTestId('ts-kit-away-away').tap();
    await shot(page, 'uix-03-team-select-1180x820');

    await page.getByTestId('team-continue').tap();
    await expect.poll(() => route(page)).toBe('side-select');
    const p = await navParams(page, 'side-select');
    expect(p?.mode).toBe(0);
    expect(p?.setup?.config.homeClub).toBe(5);
    expect(p?.setup?.config.awayClub).toBe(12);
    expect(p?.setup?.config.homeKit).toBe(0);
    expect(p?.setup?.config.awayKit).toBe(1);
    expect(p?.setup?.config.homeFormation).toBe(clubs[5]!.formation);
    expect(p?.setup?.config.awayFormation).toBe(clubs[12]!.formation);
    // Back keeps the choices made on team select.
    await page.getByTestId('back').tap();
    await expect.poll(() => route(page)).toBe('team-select');
    await expect(page.getByTestId('ts-club-5')).toHaveClass(/is-home/);
    await expect(page.getByTestId('ts-club-12')).toHaveClass(/is-away/);
    expect(messages).toEqual([]);
  });

  test('keyboard alone and controller alone: browse, pick, switch side, continue', async ({ page }) => {
    const messages = collectConsole(page);
    await page.addInitScript(mockPads(1));
    await toMain(page, 'key');
    await openMode(page, 0);
    await recordNavigation(page);
    await expect.poll(() => focused(page)).toBe('mode-continue');
    await page.keyboard.press('Enter');
    await expect.poll(() => route(page)).toBe('team-select');
    const start = await page.evaluate(() => window.__dotkick!.ctx.settings.get().match.homeClub);
    await expect.poll(() => focused(page)).toBe(`ts-club-${start}`);
    // Keyboard: Right twice and Enter picks for home; Q switches back to home, E to away.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => focused(page)).toBe(`ts-club-${start + 2}`);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(`ts-club-${start + 2}`)).toHaveClass(/is-home/);
    await expect(page.getByTestId('ts-panel-away')).toHaveClass(/is-active/);
    await page.keyboard.press('KeyQ');
    await expect(page.getByTestId('ts-panel-home')).toHaveClass(/is-active/);
    await page.keyboard.press('KeyE');
    await expect(page.getByTestId('ts-panel-away')).toHaveClass(/is-active/);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const away = Number((await focused(page))!.replace('ts-club-', ''));
    await expect(page.getByTestId(`ts-club-${away}`)).toHaveClass(/is-away/);
    await shot(page, 'uix-03-team-select-keyboard');

    // Controller: D-pad right + Cross picks for away; L1 to home, D-pad down + Cross picks for home.
    await padTap(page, PAD.RIGHT);
    await expect.poll(() => focused(page)).toBe(`ts-club-${away + 1}`);
    await padTap(page, PAD.A);
    await expect(page.getByTestId(`ts-club-${away + 1}`)).toHaveClass(/is-away/);
    await padTap(page, PAD.L1);
    await expect(page.getByTestId('ts-panel-home')).toHaveClass(/is-active/);
    await padTap(page, PAD.DOWN);
    const home = Number((await focused(page))!.replace('ts-club-', ''));
    await padTap(page, PAD.A);
    await expect(page.getByTestId(`ts-club-${home}`)).toHaveClass(/is-home/);
    // Up out of the grid to Continue, Cross confirms.
    await walkTo(page, 'team-continue', async () => {
      const f = await focused(page);
      await padTap(page, f && f.startsWith('ts-club') ? PAD.UP : PAD.RIGHT);
    }, 14);
    await padTap(page, PAD.A);
    await expect.poll(() => route(page)).toBe('side-select');
    const p = await navParams(page, 'side-select');
    expect(p?.setup?.config.homeClub).toBe(home);
    expect(p?.setup?.config.awayClub).toBe(away + 1);
    // Circle goes back.
    await padTap(page, PAD.B);
    await expect.poll(() => route(page)).toBe('team-select');
    expect(messages).toEqual([]);
  });

  test('layout at iPad landscape, 4:3 and 21:9', async ({ page }) => {
    const messages = collectConsole(page);
    await toMain(page, 'touch');
    for (const v of VIEWPORTS) {
      await page.setViewportSize({ width: v.w, height: v.h });
      await openMode(page, 0);
      await page.getByTestId('mode-continue').tap();
      await expect.poll(() => route(page)).toBe('team-select');
      await frames(page, 3);
      expectCleanLayout(await checkLayout(page), `team-select ${v.name}`);
      await shot(page, `uix-03-team-select-${v.name}`);
      await page.evaluate(() => window.__dotkick!.app.router.resetTo('main'));
    }
    expect(messages).toEqual([]);
  });
});
