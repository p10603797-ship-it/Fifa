/**
 * INT-08 e2e over real WebRTC: the production PeerJS transport (src/net/transport.ts) between two pages, brokered by a
 * local PeerServer (devDependency 'peer') started by this spec, with no ICE servers (host candidates only), so nothing
 * leaves the machine. The online screen's test hook only swaps the broker settings (NET_CONFIG override). Checks: the
 * host's room, the guest's join, the lobby on both sides, ready, and a match running in lockstep over the data channels
 * (inputs unordered, control reliable) with state hashes compared and equal.
 *
 *   npx vite build --outDir dist-e2e/netb --emptyOutDir
 *   PW_DIST=dist-e2e/netb PW_PORT=4331 npx playwright test tests/e2e/int-08-webrtc.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import { PeerServer } from 'peer';
import { bootToMain, collectConsole, openOnlineFromMenu, ROOM_CODE, route, simTick } from './net-07-harness';

// Real host candidates (Chromium hides local addresses behind mDNS names by default, which the container cannot resolve).
test.use({
  launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-features=WebRtcHideLocalIpsWithMdns'] },
});

let http: { close(cb: () => void): void; address(): unknown } | null = null;
let port = 0;

test.beforeAll(async () => {
  await new Promise<void>((resolve) => {
    PeerServer({ port: 0, host: '127.0.0.1', path: '/dk', allow_discovery: false }, (s) => {
      http = s;
      port = (s.address() as AddressInfo).port;
      resolve();
    });
  });
});

test.afterAll(async () => {
  const s = http;
  http = null;
  if (s) await new Promise<void>((r) => s.close(() => r()));
});

async function hookBroker(page: Page): Promise<void> {
  await page.addInitScript(([p, code]) => {
    (window as unknown as { __dotkickNetTest: unknown }).__dotkickNetTest = {
      code,
      startCountdownMs: 300,
      config: { host: '127.0.0.1', port: p, path: '/dk', secure: false, iceServers: [], silenceTimeoutMs: 15_000 },
    };
  }, [port, ROOM_CODE] as const);
}

const stats = (p: Page) => p.evaluate(() => window.__dotkickOnline?.stats() ?? null);

test('real WebRTC through a local PeerServer: room, join, lobby, lockstep match', async ({ context }) => {
  test.setTimeout(180_000);
  expect(port).toBeGreaterThan(0);
  const a = await context.newPage();
  const b = await context.newPage();
  const errs = [...collectConsole(a), ...collectConsole(b)];
  await hookBroker(a);
  await hookBroker(b);

  await bootToMain(a);
  await openOnlineFromMenu(a);
  await a.getByTestId('net-nickname').fill('Ana');
  await a.getByTestId('net-create').click();
  await expect(a.getByTestId('net-room-code')).toHaveText('KQZ 7MP');

  await bootToMain(b);
  await b.evaluate(() => {
    window.__dotkick!.ctx.settings.update((s) => { s.nickname = 'Ben'; });
  });
  await openOnlineFromMenu(b);
  await b.getByTestId('net-join').click();
  await b.keyboard.type(ROOM_CODE);
  await expect(b.getByTestId('net-lobby')).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId('net-peer')).toContainText('Ben', { timeout: 30_000 });
  await expect(b.getByTestId('net-peer')).toContainText('Ana');
  await expect(b.getByTestId('net-quality')).toContainText('Connected', { timeout: 10_000 });

  await a.getByTestId('net-ready').click();
  await b.getByTestId('net-ready').click();
  await expect.poll(() => route(a), { timeout: 60_000 }).toBe('match');
  await expect.poll(() => route(b), { timeout: 60_000 }).toBe('match');
  await expect.poll(() => simTick(a), { timeout: 60_000 }).toBeGreaterThan(120);
  await expect.poll(() => simTick(b), { timeout: 60_000 }).toBeGreaterThan(120);
  await expect.poll(async () => (await stats(a))?.hashesCompared ?? 0, { timeout: 60_000 }).toBeGreaterThan(2);
  expect((await stats(a))!.desyncs).toBe(0);
  expect((await stats(b))!.desyncs).toBe(0);
  expect(errs).toEqual([]);
});
