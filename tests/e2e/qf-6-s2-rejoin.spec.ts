/**
 * [QF-6, second pass] e2e: a guest page that reloads mid-match rejoins through the real app (in-page BroadcastChannel
 * transport from tests/e2e/net-07-harness.ts, never the public network). The reloaded page offers "Rejoin match"; its
 * first attempt fails (the network blocks it), and "Try again" must still rejoin: leaving the failed room used to clear
 * the page's rejoin token, so the retry joined as a stranger and the host refused it ("Room is full") while the match
 * it belonged to waited for it.
 *
 *   npx vite build --outDir dist-e2e/qf-6 --emptyOutDir
 *   PW_DIST=dist-e2e/qf-6 PW_PORT=4406 npx playwright test tests/e2e/qf-6-s2-rejoin.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { bootToMain, collectConsole, installNetHook, onlineState, openOnlineFromMenu, route, simTick } from './net-07-harness';

async function typeNickname(page: Page, name: string): Promise<void> {
  const input = page.getByTestId('net-nickname');
  await input.fill(name);
  await input.dispatchEvent('change');
}

test('glitch: both sides waiting forever — a reloaded guest rejoins from "Rejoin match", also when its first attempt failed', async ({ context }) => {
  test.setTimeout(300_000);
  const a = await context.newPage();
  const b = await context.newPage();
  const errs = [...collectConsole(a)];
  await installNetHook(a);
  await installNetHook(b);
  await bootToMain(a);
  await openOnlineFromMenu(a);
  await typeNickname(a, 'Ana');
  await a.getByTestId('net-create').click();
  await bootToMain(b);
  await openOnlineFromMenu(b);
  await typeNickname(b, 'Ben');
  await b.getByTestId('net-join').click();
  for (const ch of 'KQZ7MP') await b.getByTestId(`net-key-${ch}`).click();
  await expect(a.getByTestId('net-peer')).toContainText('Ben');
  await a.getByTestId('net-ready').click();
  await b.getByTestId('net-ready').click();
  await expect.poll(() => route(a), { timeout: 60_000 }).toBe('match');
  await expect.poll(() => route(b), { timeout: 60_000 }).toBe('match');
  await expect.poll(() => simTick(b), { timeout: 60_000 }).toBeGreaterThan(120);

  // Ben's page reloads (Safari dropped the tab): the home view offers the rejoin.
  await b.reload();
  await expect(b.getByTestId('splash-start')).toBeVisible();
  await b.getByTestId('splash-start').click();
  await expect.poll(() => route(b)).toBe('main');
  await openOnlineFromMenu(b);
  await expect(b.getByTestId('net-rejoin')).toBeVisible();
  // The first attempt fails: the network blocks it.
  await b.evaluate(() => { window.__dotkickNetTest!.failOpen = 'blocked'; });
  await b.getByTestId('net-rejoin').click();
  await expect(b.getByTestId('net-error-blocked')).toBeVisible({ timeout: 15_000 });
  await b.evaluate(() => { window.__dotkickNetTest!.failOpen = undefined; });
  await b.getByTestId('net-retry').click();
  // was: the retry joined without the token -> the host refused a stranger -> "Room is full"
  await expect.poll(() => route(b), { timeout: 60_000 }).toBe('match');
  await expect(b.getByTestId('net-error-room-full')).toHaveCount(0);
  await expect.poll(async () => (await onlineState(a)).status, { timeout: 60_000 }).toBe('playing');
  await expect.poll(async () => (await onlineState(b)).status, { timeout: 60_000 }).toBe('playing');
  const ta = await simTick(a);
  await expect.poll(() => simTick(a), { timeout: 30_000 }).toBeGreaterThan(ta + 60);
  await expect.poll(() => simTick(b), { timeout: 30_000 }).toBeGreaterThan(ta + 30); // the new page plays the same match
  const stats = await a.evaluate(() => window.__dotkickOnline!.stats());
  expect(stats?.rejoins).toBe(1);
  expect(errs).toEqual([]);
});
