/**
 * NET-07 e2e: the online screens through the real app, with an in-page transport injected via the test hook (two
 * pages of one browser context, never the public network; tests/e2e/net-07-harness.ts):
 *  - create / join / ready by touch: the host's code and share link, the guest's keypad, both nicknames, host settings
 *    reaching the guest, ready -> both pages load the same match; screenshots of both lobbies and the keypad;
 *  - every failure has its plain-language screen with Try again and Back (broker unreachable, code not found, room
 *    full, version mismatch, blocked, disconnected, code taken, unsupported browser); screenshot;
 *  - controller alone: home -> Join -> keypad -> error -> Back with the focus ring; a share link joins by itself.
 *
 *   npx vite build --outDir dist-e2e/netb --emptyOutDir
 *   PW_DIST=dist-e2e/netb PW_PORT=4331 npx playwright test tests/e2e/net-07-online.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  bootToMain, collectConsole, focused, frames, installNetHook, onlineState, openOnlineFromMenu, ROOM_CODE, route,
} from './net-07-harness';

const SHOTS = process.env.NET07_SHOTS || join(process.cwd(), 'tmp', 'net-07');
mkdirSync(SHOTS, { recursive: true });

async function typeNickname(page: Page, name: string): Promise<void> {
  const input = page.getByTestId('net-nickname');
  await input.fill(name);
  await input.dispatchEvent('change');
}

test.describe('NET-07 online screens', () => {
  test('create, join and ready by touch: both pages reach the same match', async ({ context }) => {
    const a = await context.newPage();
    const b = await context.newPage();
    const errs = [...collectConsole(a), ...collectConsole(b)];
    await installNetHook(a);
    await installNetHook(b);
    await bootToMain(a);
    await openOnlineFromMenu(a);
    await expect(a.getByTestId('net-privacy')).toContainText('IP address');
    await typeNickname(a, 'Ana');
    await a.getByTestId('net-create').click();
    await expect(a.getByTestId('net-room-code')).toHaveText('KQZ 7MP');
    await expect(a.getByTestId('net-room-link')).toContainText(`?room=${ROOM_CODE}`);
    await expect(a.getByTestId('net-peer')).toContainText('Waiting for a friend');
    await expect(a.getByTestId('net-ready')).toBeDisabled();

    await bootToMain(b);
    await openOnlineFromMenu(b);
    await typeNickname(b, 'Ben');
    await b.getByTestId('net-join').click();
    await expect(b.getByTestId('net-keypad')).toBeVisible();
    for (const ch of 'KQZ7M') await b.getByTestId(`net-key-${ch}`).click();
    await expect(b.getByTestId('net-code-slots')).toContainText('KQZ7M');
    await b.screenshot({ path: join(SHOTS, 'join-keypad.png') });
    await b.getByTestId('net-key-P').click(); // the 6th character joins
    await expect(b.getByTestId('net-lobby')).toBeVisible();
    await expect(b.getByTestId('net-peer')).toContainText('Ana');
    await expect(a.getByTestId('net-peer')).toContainText('Ben');
    await expect(b.getByTestId('net-room-code')).toHaveText('KQZ 7MP');

    // Host settings reach the guest (read-only there).
    await a.getByTestId('net-set-night').click();
    await expect(b.getByTestId('net-settings')).toContainText('Night match: On');
    await expect(b.getByTestId('net-set-night')).toHaveCount(0);
    await expect(a.getByTestId('net-quality')).toContainText('Connected');
    await a.screenshot({ path: join(SHOTS, 'lobby-host.png') });
    await b.screenshot({ path: join(SHOTS, 'lobby-guest.png') });

    await a.getByTestId('net-ready').click();
    await expect(b.getByTestId('net-peer')).toContainText('Ready');
    await expect(b.getByTestId('net-status')).toContainText('Ana is ready');
    await b.getByTestId('net-ready').click();
    await expect.poll(() => route(a), { timeout: 30_000 }).toBe('match');
    await expect.poll(() => route(b), { timeout: 30_000 }).toBe('match');
    const cfg = (p: Page) => p.evaluate(() => {
      const s = window.__dotkick!.ctx.session.getSetup()!;
      return { seed: s.config.seed, mode: s.config.mode, night: s.config.night, home: s.config.homeClub, away: s.config.awayClub, humans: s.config.humans.map((x) => x.side) };
    });
    const ca = await cfg(a);
    expect(await cfg(b)).toEqual(ca);
    expect(ca.mode).toBe(2); // ModeId.FRIEND_ONLINE
    expect(ca.night).toBe(1);
    expect(ca.humans).toEqual([0, 1]);
    await expect.poll(async () => (await onlineState(b)).status, { timeout: 30_000 }).toMatch(/playing|stalled/);
    expect(errs).toEqual([]);
  });

  test('every failure has a plain-language screen with Try again and Back', async ({ page, context }) => {
    const errs = collectConsole(page);
    await installNetHook(page);
    await bootToMain(page);
    await openOnlineFromMenu(page);
    const expectations: [string, RegExp][] = [
      ['broker-unreachable', /matchmaking server/],
      ['room-full', /Room is full/],
      ['version-mismatch', /Different game versions/],
      ['blocked', /network blocked the connection/],
      ['disconnected', /Connection lost/],
      ['code-not-found', /Room not found/],
    ];
    for (const [reason, title] of expectations) {
      // code-not-found is real: nobody hosts the room. The others are forced in the transport.
      await page.evaluate((r) => { window.__dotkickNetTest!.failOpen = r === 'code-not-found' ? undefined : r; }, reason);
      await page.getByTestId('net-join').click();
      await page.keyboard.type(ROOM_CODE.toLowerCase()); // the hardware keyboard types into the keypad
      await expect(page.getByTestId(`net-error-${reason}`)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('net-error-title')).toHaveText(title);
      await expect(page.getByTestId('net-error-body')).not.toBeEmpty();
      if (reason === 'blocked') {
        await expect(page.getByTestId('net-error-body')).toContainText('same Wi-Fi');
        await page.screenshot({ path: join(SHOTS, 'error-blocked.png') });
      }
      await page.getByTestId('net-retry').click(); // tries again (and fails the same way)
      await expect(page.getByTestId(`net-error-${reason}`)).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('net-error-back').click();
      await expect(page.getByTestId('net-create')).toBeVisible();
    }
    // Host side: a taken code.
    await page.evaluate(() => { window.__dotkickNetTest!.failOpen = 'code-taken'; });
    await page.getByTestId('net-create').click();
    await expect(page.getByTestId('net-error-code-taken')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('net-error-back').click();

    // A browser without WebRTC (and no test transport): unsupported.
    const old = await context.newPage();
    await old.addInitScript(() => { delete (window as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection; });
    await bootToMain(old);
    await openOnlineFromMenu(old);
    await old.getByTestId('net-create').click();
    await expect(old.getByTestId('net-error-unsupported')).toBeVisible();
    await expect(old.getByTestId('net-retry')).toHaveCount(0);
    await old.getByTestId('net-error-back').click();
    await expect(old.getByTestId('net-create')).toBeVisible();
    // Back from the online home returns to the menu.
    await old.getByTestId('back').click();
    await expect.poll(() => route(old)).toBe('mode-setup');
    expect(errs).toEqual([]);
  });

  test('controller alone: join keypad, error and Back with the focus ring; a share link joins by itself', async ({ context }) => {
    const pad = await context.newPage();
    const errs = collectConsole(pad);
    await installNetHook(pad);
    await pad.addInitScript(() => {
      const w = window as unknown as { __net07pad: unknown };
      w.__net07pad = {
        id: 'Mock Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', index: 0, connected: true, mapping: 'standard',
        timestamp: 0, axes: [0, 0, 0, 0], vibrationActuator: null,
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
      };
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [w.__net07pad, null, null, null] });
    });
    const tap = async (b: number): Promise<void> => {
      await pad.evaluate((i) => new Promise<void>((res) => {
        const p = (window as unknown as { __net07pad: { buttons: { pressed: boolean; touched: boolean; value: number }[] } }).__net07pad;
        p.buttons[i] = { pressed: true, touched: true, value: 1 };
        requestAnimationFrame(() => {
          p.buttons[i] = { pressed: false, touched: false, value: 0 };
          res();
        });
      }), b);
      await frames(pad, 3);
    };
    const A = 0, B = 1, DOWN = 13, RIGHT = 15;
    await pad.goto('/');
    await expect(pad.getByTestId('splash-start')).toBeVisible();
    await tap(A);
    await expect.poll(() => route(pad)).toBe('main');
    await pad.evaluate(() => window.__dotkick!.ctx.router.go('online-lobby'));
    await expect(pad.getByTestId('net-create')).toBeVisible();
    await expect.poll(() => focused(pad)).toBe('net-create');
    await tap(DOWN);
    await expect.poll(() => focused(pad)).not.toBe('net-create');
    for (let i = 0; i < 4 && (await focused(pad)) !== 'net-join'; i++) await tap(DOWN);
    expect(await focused(pad)).toBe('net-join');
    expect(await pad.evaluate(() => document.documentElement.hasAttribute('data-focus-visible'))).toBe(true);
    await tap(A);
    await expect(pad.getByTestId('net-keypad')).toBeVisible();
    await expect.poll(() => focused(pad)).toBe('net-key-A');
    await tap(RIGHT);
    await expect.poll(() => focused(pad)).toBe('net-key-B');
    for (let i = 0; i < 6; i++) await tap(A); // BBBBBB: joins by itself; nobody hosts it
    await expect(pad.getByTestId('net-error-code-not-found')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => focused(pad)).toBe('net-retry');
    await tap(RIGHT);
    await expect.poll(() => focused(pad)).toBe('net-error-back');
    await tap(A);
    await expect(pad.getByTestId('net-create')).toBeVisible();
    await tap(B); // Back from the online home leaves the screen
    await expect.poll(() => route(pad)).not.toBe('online-lobby');

    // A share link (?room=CODE) joins a hosted room as soon as the online screen opens.
    const host = await context.newPage();
    await installNetHook(host);
    await bootToMain(host);
    await openOnlineFromMenu(host);
    await host.getByTestId('net-create').click();
    await expect(host.getByTestId('net-room-code')).toBeVisible();
    const guest = await context.newPage();
    await installNetHook(guest);
    await guest.goto(`/?room=${ROOM_CODE}`);
    await guest.getByTestId('splash-start').click(); // the share link opens the room by itself
    await expect.poll(() => route(guest)).toBe('online-lobby');
    await expect(guest.getByTestId('net-lobby')).toBeVisible({ timeout: 10_000 });
    await expect(host.getByTestId('net-peer')).not.toContainText('Waiting');
    await expect.poll(async () => (await onlineState(guest)).phase).toBe('lobby');
    // Leaving clears the link from the address bar (a reload does not join again).
    await guest.getByTestId('back').click();
    await expect(guest.getByTestId('net-leave-confirm')).toBeVisible(); // a friend is there: asks first
    await guest.getByTestId('net-leave-yes').click();
    await expect(guest.getByTestId('net-create')).toBeVisible();
    await expect.poll(() => guest.evaluate(() => location.search)).toBe('');
    await expect(host.getByTestId('net-peer')).toContainText('Waiting for a friend', { timeout: 10_000 });
    expect(errs).toEqual([]);
  });
});
