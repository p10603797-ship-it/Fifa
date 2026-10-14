/**
 * INT-08 e2e: online 1v1 end to end through the real app on two pages of one browser context (in-page transport via
 * the online screen's test hook; never the public network; tests/e2e/net-07-harness.ts):
 *  - the guest opens the host's share link; both pick and ready up; both pages load the same match and run it in
 *    lockstep (the desync guard compares state hashes every 30 ticks: none differ);
 *  - a pause on one page is mirrored on the other as that player's pause, with the pill counting down, and only the
 *    pauser resumes;
 *  - the guest's page disappears: the host holds the sim, shows "Connection lost" for the 20 s rejoin window, then the
 *    Finish against CPU / End match card; Finish against CPU hands the away side to the CPU and the match runs on.
 *
 *   npx vite build --outDir dist-e2e/netb --emptyOutDir
 *   PW_DIST=dist-e2e/netb PW_PORT=4331 npx playwright test tests/e2e/int-08-online.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bootToMain, collectConsole, installNetHook, onlineState, openOnlineFromMenu, ROOM_CODE, route, simTick } from './net-07-harness';

const SHOTS = process.env.INT08_SHOTS || join(process.cwd(), 'tmp', 'int-08');
mkdirSync(SHOTS, { recursive: true });

const stats = (p: Page) => p.evaluate(() => window.__dotkickOnline?.stats() ?? null);
const paused = (p: Page) => p.evaluate(() => ({ paused: window.__dotkick!.ctx.session.paused, by: window.__dotkick!.ctx.session.pausedBy }));

test('online 1v1 end to end: share link, lockstep match, mirrored pause, rejoin window, finish against CPU', async ({ context }) => {
  test.setTimeout(240_000);
  const a = await context.newPage();
  const b = await context.newPage();
  const errs = [...collectConsole(a), ...collectConsole(b)];
  await installNetHook(a);
  await installNetHook(b);

  // Host creates the room.
  await bootToMain(a);
  await openOnlineFromMenu(a);
  await a.getByTestId('net-nickname').fill('Ana');
  await a.getByTestId('net-create').click();
  await expect(a.getByTestId('net-room-link')).toContainText(`?room=${ROOM_CODE}`);
  const link = (await a.getByTestId('net-room-link').textContent())!;

  // Guest opens the share link.
  await bootToMain(b, new URL(link).pathname + new URL(link).search);
  await b.evaluate(() => {
    window.__dotkick!.ctx.settings.update((s) => { s.nickname = 'Ben'; });
    window.__dotkick!.ctx.router.go('online-lobby');
  });
  await expect(b.getByTestId('net-lobby')).toBeVisible({ timeout: 15_000 });
  await expect(a.getByTestId('net-peer')).toContainText('Ben', { timeout: 10_000 });

  // Pick clubs, ready up.
  await b.getByTestId('net-club').click(); // next club
  await a.getByTestId('net-ready').click();
  await b.getByTestId('net-ready').click();
  await expect.poll(() => route(a), { timeout: 60_000 }).toBe('match');
  await expect.poll(() => route(b), { timeout: 60_000 }).toBe('match');

  // Lockstep: both advance, hashes compared, none differ.
  await expect.poll(() => simTick(a), { timeout: 60_000 }).toBeGreaterThan(150);
  await expect.poll(() => simTick(b), { timeout: 60_000 }).toBeGreaterThan(150);
  await expect.poll(async () => (await stats(a))?.hashesCompared ?? 0, { timeout: 60_000 }).toBeGreaterThan(2);
  expect((await stats(a))!.desyncs).toBe(0);
  expect((await stats(b))!.desyncs).toBe(0);
  const seeds = await Promise.all([a, b].map((p) => p.evaluate(() => window.__dotkick!.ctx.session.getSetup()!.config.seed)));
  expect(seeds[0]).toBe(seeds[1]);

  // Pause on the host: mirrored on the guest as player 1's pause; only the host resumes.
  await a.evaluate(() => window.__dotkick!.ctx.session.pause(0));
  await expect.poll(() => paused(b), { timeout: 10_000 }).toEqual({ paused: true, by: 0 });
  await expect(b.getByTestId('net-indicator')).toContainText('Ana paused', { timeout: 10_000 });
  expect(await b.evaluate(() => window.__dotkick!.ctx.session.resume(1))).toBe(false);
  const left = await b.evaluate(() => (window.__dotkick!.ctx.session.getSetup()!.modeData as { pausesLeft: number[] }).pausesLeft);
  expect(left).toEqual([2, 3]);
  await b.screenshot({ path: join(SHOTS, 'guest-sees-pause.png') });
  expect(await a.evaluate(() => window.__dotkick!.ctx.session.resume(0))).toBe(true);
  await expect.poll(() => paused(b), { timeout: 10_000 }).toEqual({ paused: false, by: -1 });
  const before = await simTick(b);
  await expect.poll(() => simTick(b), { timeout: 30_000 }).toBeGreaterThan(before + 30);

  // The guest's page goes away: rejoin window, then the choice.
  await b.close();
  await expect.poll(async () => (await onlineState(a)).status, { timeout: 15_000 }).toBe('reconnecting');
  await expect(a.getByTestId('net-indicator')).toContainText('Connection lost');
  const held = await simTick(a);
  await a.screenshot({ path: join(SHOTS, 'host-reconnecting.png') });
  await expect(a.getByTestId('net-gone')).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId('net-gone')).toContainText('Ben did not come back');
  expect(await simTick(a)).toBeLessThanOrEqual(held + 10); // the sim held while waiting
  await a.screenshot({ path: join(SHOTS, 'host-opponent-gone.png') });
  await a.getByTestId('net-finish-cpu').click();
  await expect.poll(async () => (await onlineState(a)).status, { timeout: 10_000 }).toBe('solo');
  const t0 = await simTick(a);
  await expect.poll(() => simTick(a), { timeout: 30_000 }).toBeGreaterThan(t0 + 60);
  const ctrl = await a.evaluate(() => {
    const s = window.__dotkick!.ctx.session.getState()!;
    return [s.ctrl[0]!.kind, s.ctrl[1]!.kind];
  });
  expect(ctrl[0]).toBe(1); // ControllerKind.HUMAN: the host plays on
  expect(ctrl[1]).not.toBe(1); // the away human was handed to the CPU
  expect(errs).toEqual([]);
});
