/**
 * [QF-6] e2e: both sides waiting forever, through the real app on two pages (in-page BroadcastChannel transport from
 * tests/e2e/net-07-harness.ts, never the public network). The friend's game is held with the link up (portrait lock,
 * a system pause): the other page shows the waiting pill, then after the 20 s rejoin window the "is not responding"
 * card with Finish against CPU / End match; the card closes by itself when the friend comes back; Finish against CPU
 * tells the friend at once (its own card), instead of a 20 s rejoin wait.
 *
 *   npx vite build --outDir dist-e2e/qf-6 --emptyOutDir
 *   PW_DIST=dist-e2e/qf-6 PW_PORT=4406 npx playwright test tests/e2e/qf-6-online.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { bootToMain, collectConsole, installNetHook, onlineState, openOnlineFromMenu, route, simTick } from './net-07-harness';

async function typeNickname(page: Page, name: string): Promise<void> {
  const input = page.getByTestId('net-nickname');
  await input.fill(name);
  await input.dispatchEvent('change');
}

const setBlocked = (p: Page, on: boolean): Promise<void> => p.evaluate((b) => {
  (window.__dotkick!.ctx.session as unknown as { setBlocked(v: boolean): void }).setBlocked(b);
}, on);

test('glitch: both sides waiting forever — a friend held with the link up: waiting pill, then the not-responding card; Finish against CPU tells the friend', async ({ context }) => {
  test.setTimeout(300_000);
  const a = await context.newPage();
  const b = await context.newPage();
  const errs = [...collectConsole(a), ...collectConsole(b)];
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
  await expect.poll(() => simTick(a), { timeout: 60_000 }).toBeGreaterThan(120);

  // Ben's iPad goes to portrait: a system pause there; the link stays up.
  await setBlocked(b, true);
  await expect(a.getByTestId('net-indicator')).toContainText('Waiting for Ben', { timeout: 15_000 });
  await expect(a.getByTestId('net-gone')).toBeVisible({ timeout: 40_000 });
  await expect(a.getByTestId('net-gone')).toContainText('Ben is not responding');
  await expect(a.getByTestId('net-finish-cpu')).toBeVisible();
  expect((await onlineState(a)).status).toBe('opponent-gone');

  // Ben is back: the card goes away by itself and play continues.
  await setBlocked(b, false);
  await b.evaluate(() => window.__dotkick!.ctx.session.resume(1));
  await expect(a.getByTestId('net-gone')).toHaveCount(0, { timeout: 15_000 });
  const t0 = await simTick(a);
  // (45 s: two pages on software WebGL in a busy container can drop to a few ticks a second.)
  await expect.poll(() => simTick(a), { timeout: 45_000 }).toBeGreaterThan(t0 + 60);

  // Held again; this time Ana finishes against the CPU and Ben is told at once.
  await setBlocked(b, true);
  await expect(a.getByTestId('net-gone')).toBeVisible({ timeout: 40_000 });
  await a.getByTestId('net-finish-cpu').click();
  await expect.poll(async () => (await onlineState(a)).status, { timeout: 10_000 }).toBe('solo');
  await expect(b.getByTestId('net-gone')).toContainText('Ana left the match', { timeout: 8_000 });
  const s0 = await simTick(a);
  await expect.poll(() => simTick(a), { timeout: 45_000 }).toBeGreaterThan(s0 + 60);
  expect(errs).toEqual([]);
});

test('quitting the full-time screen leaves the room: the friend who went back to the room sees the seat free again', async ({ context }) => {
  test.setTimeout(480_000); // two pages on software WebGL play the (very short) match at ~10 ticks a second
  const a = await context.newPage();
  const b = await context.newPage();
  const errs = [...collectConsole(a), ...collectConsole(b)];
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
  // A very short match (the host's settings travel to the guest with the start).
  await a.evaluate(() => {
    const lobby = window.__dotkickOnline!.lobby()!;
    lobby.setConfig({ ...lobby.config!, halfMinutes: 0.05, replaySeconds: 0 });
  });
  await a.getByTestId('net-ready').click();
  await b.getByTestId('net-ready').click();
  await expect.poll(() => route(a), { timeout: 60_000 }).toBe('match');
  // Two pages on software WebGL run ~10 ticks a second here: jump the host to the last seconds of the second half once
  // play is on (the desync guard hard-syncs the guest to the host's snapshot), then both humans skip to full time.
  const deadline = Date.now() + 300_000;
  let jumped = false;
  const look = (p: Page): Promise<{ route: string | null; phase: number; finished: boolean }> => p.evaluate(() => {
    const sess = window.__dotkick!.ctx.session as unknown as { finished: boolean; getState(): { match: { phase: number } } | null };
    return { route: window.__dotkick!.ctx.router.current, phase: sess.getState()?.match.phase ?? -1, finished: sess.finished };
  });
  while (Date.now() < deadline) {
    const la = await look(a);
    const lb = await look(b);
    if (la.finished && lb.finished) break;
    for (const [p, l] of [[a, la], [b, lb]] as const) {
      if (l.route !== 'match') continue;
      if (l.phase === 1) await p.keyboard.press('KeyJ'); // take the kick-off
      else if (l.phase >= 8 && l.phase <= 10) await p.keyboard.press('Space'); // skip a celebration / replay
    }
    if (!jumped && la.phase === 2) {
      jumped = await a.evaluate(() => {
        const s = window.__dotkick!.ctx.session.getState() as unknown as { match: { phase: number; period: number; periodT: number; periodLen: number; addedT: number } } | null;
        if (!s || s.match.phase !== 2) return false; // IN_PLAY
        s.match.period = 2;
        s.match.periodT = s.match.periodLen - 30;
        s.match.addedT = 0;
        return true;
      });
    }
    await a.waitForTimeout(1000);
  }
  const where = async (p: Page): Promise<string> => p.evaluate(() => {
    const s = window.__dotkick!.ctx.session.getState();
    return `${window.__dotkick!.ctx.router.current} tick ${s?.tick} phase ${s?.match.phase} period ${s?.match.period} ${window.__dotkickOnline!.status()}`;
  });
  expect(await route(a), await where(a)).toBe('full-time');
  expect(await route(b), await where(b)).toBe('full-time');
  // Ana goes back to the room for a rematch; Ben quits to the main menu.
  await a.getByTestId('ft-change-teams').click();
  await expect.poll(() => route(a)).toBe('online-lobby');
  await expect(a.getByTestId('net-peer')).toContainText('Ben');
  await b.getByTestId('ft-quit').click();
  await expect.poll(() => route(b)).toBe('main');
  // was: Ben's room stayed open behind his main menu, so Ana waited for "Ben" to get ready for good
  await expect(a.getByTestId('net-peer')).toContainText('Waiting for a friend', { timeout: 10_000 });
  expect((await onlineState(b)).phase).toBeNull(); // Ben's page holds no room any more
  expect(errs).toEqual([]);
});
