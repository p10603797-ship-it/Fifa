/**
 * INT-08 e2e over real WebRTC: the production PeerJS transport (src/net/transport.ts) between two pages, brokered by a
 * local PeerServer (devDependency 'peer') started by this spec, with no ICE servers (host candidates only), so nothing
 * leaves the machine. The online screen's test hook only swaps the broker settings (NET_CONFIG override). Checks: the
 * host's room, the guest's join, the lobby on both sides, ready, and a match running in lockstep over the data channels
 * (inputs unordered, control reliable) with state hashes compared and equal.
 *
 * [NET-FIX, D-044] Also: the optional relay.json beside index.html is fetched when a room opens and does not break the
 * connection, as shipped (no servers), absent (404), present (its servers reach the RTCPeerConnection) or carrying servers
 * the browser would refuse (dropped, the room connects directly); the diagnostics log
 * records the relay and the ICE candidate types; and a connection that cannot open (remote candidates rewritten to an
 * unreachable address) shows the new 'blocked' copy: "ask for a relay" without one, "Could not reach the
 * relay" with an unreachable TURN server in relay.json.
 *
 *   npx vite build --outDir dist-e2e/netb --emptyOutDir
 *   PW_DIST=dist-e2e/netb PW_PORT=4331 npx playwright test tests/e2e/int-08-webrtc.spec.ts
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import { PeerServer } from 'peer';
import { bootToMain, collectConsole, openOnlineFromMenu, ROOM_CODE, route, simTick } from './net-07-harness';

// Real host candidates instead of Chromium's default mDNS names (plain addresses in the ICE logs).
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

async function hookBroker(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript(([p, code, more]) => {
    (window as unknown as { __dotkickNetTest: unknown }).__dotkickNetTest = {
      code,
      startCountdownMs: 300,
      config: { host: '127.0.0.1', port: p, path: '/dk', secure: false, iceServers: [], silenceTimeoutMs: 15_000, ...more },
    };
  }, [port, ROOM_CODE, extra] as const);
}

const stats = (p: Page) => p.evaluate(() => window.__dotkickOnline?.stats() ?? null);
const diag = (p: Page) => p.evaluate(() => window.__dotkick!.ctx.diagnostics.report());

/** Every relay.json request of the context with its status. */
function watchRelay(context: BrowserContext): { url: string; status: number }[] {
  const seen: { url: string; status: number }[] = [];
  context.on('response', (r) => {
    if (r.url().endsWith('/relay.json')) seen.push({ url: r.url(), status: r.status() });
  });
  return seen;
}

/** Records the iceServers of every RTCPeerConnection the page creates. */
const RTC_LOG = `(() => {
  const C = window.RTCPeerConnection;
  window.__rtcIce = [];
  window.RTCPeerConnection = new Proxy(C, { construct(t, a, n) { window.__rtcIce.push(JSON.stringify((a[0] && a[0].iceServers) || null)); return Reflect.construct(t, a, n); } });
})();`;

/** Host and guest pages up to the lobby on both sides (the guest joins by keyboard). */
async function toLobby(a: Page, b: Page): Promise<void> {
  await bootToMain(a);
  await openOnlineFromMenu(a);
  await a.getByTestId('net-nickname').fill('Ana');
  await a.getByTestId('net-create').click();
  await expect(a.getByTestId('net-room-code')).toHaveText('KQZ 7MP');
  await bootToMain(b);
  await openOnlineFromMenu(b);
  await b.getByTestId('net-join').click();
  await b.keyboard.type(ROOM_CODE);
  await expect(b.getByTestId('net-lobby')).toBeVisible({ timeout: 30_000 });
  await expect(b.getByTestId('net-quality')).toContainText('Connected', { timeout: 10_000 });
}

test('real WebRTC through a local PeerServer: room, join, lobby, lockstep match', async ({ context }) => {
  test.setTimeout(180_000);
  expect(port).toBeGreaterThan(0);
  const relay = watchRelay(context);
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
  // [NET-FIX] the shipped relay.json (no servers): asked for by both sides, no relay, no console noise, connected.
  expect(relay.length).toBe(2);
  expect(relay.every((r) => r.status === 200 && new URL(r.url).pathname === '/relay.json')).toBe(true);
  for (const p of [a, b]) {
    const report = await diag(p);
    expect(report).toContain('relay: none configured (relay.json lists no servers; direct connections only)');
    expect(report).toMatch(/\[net\] ice connected: local host/);
  }
  expect(errs).toEqual([]);
});

test('[NET-FIX] relay.json absent (404, e.g. index.html deployed alone): the room still connects', async ({ context }) => {
  test.setTimeout(120_000);
  const relay = watchRelay(context);
  await context.route('**/relay.json', (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));
  const a = await context.newPage();
  const b = await context.newPage();
  const errs = [...collectConsole(a), ...collectConsole(b)];
  for (const p of [a, b]) await hookBroker(p);
  await toLobby(a, b);
  expect(relay.map((r) => r.status)).toEqual([404, 404]);
  for (const p of [a, b]) expect(await diag(p)).toContain('relay: none (no relay.json beside the page; direct connections only)');
  // The browser's own line for the 404 is the only console output.
  expect(errs.filter((e) => !/Failed to load resource: the server responded with a status of 404/.test(e))).toEqual([]);
});

const TURN_DEAD = { urls: 'turn:127.0.0.1:9', username: 'dk', credential: 'test-only' };

test('[NET-FIX] relay.json present: fetched, its servers reach the RTCPeerConnection, the connection still opens', async ({ context }) => {
  test.setTimeout(120_000);
  const relay = watchRelay(context);
  await context.route('**/relay.json', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ iceServers: [{ urls: 'stun:127.0.0.1:3478' }, TURN_DEAD, { urls: 'https://not-ice.example.com' }] }),
  }));
  const a = await context.newPage();
  const b = await context.newPage();
  const errs = [...collectConsole(a), ...collectConsole(b)];
  for (const p of [a, b]) {
    await hookBroker(p);
    await p.addInitScript(RTC_LOG);
  }
  await toLobby(a, b);
  expect(relay.length).toBe(2);
  for (const p of [a, b]) {
    const ice = await p.evaluate(() => (window as unknown as { __rtcIce: string[] }).__rtcIce);
    // The hook's own list ([]) plus relay.json's two valid servers; the malformed one is dropped.
    expect(ice).toContain(JSON.stringify([{ urls: 'stun:127.0.0.1:3478' }, TURN_DEAD]));
    const report = await diag(p);
    expect(report).toContain('relay: relay.json server 2: only stun:, turn: and turns: URLs are allowed');
    expect(report).toContain('relay: 2 server(s) from relay.json (TURN)');
    expect(report).toMatch(/\[net\] ice connected: .* 2 ICE server\(s\) incl\. TURN/);
    expect(report).not.toContain('test-only'); // credentials never logged
  }
  expect(errs).toEqual([]);
});

test('[NET-FIX] relay.json with servers the browser would refuse: they are dropped and logged, the room connects directly', async ({ context }) => {
  test.setTimeout(120_000);
  // Each of these made `new RTCPeerConnection` throw, inside PeerJS: the guest failed 'blocked' and the host never
  // answered, even on one machine. The first two are caught by the URL check, the third (a TURN username longer than
  // Chromium's 509-byte limit, within relay.ts's own 512) only by the browser check (keepAccepted).
  const longUser = 'u'.repeat(510);
  await context.route('**/relay.json', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ iceServers: [
      { urls: 'stun:127.0.0.1:3478?transport=udp' },
      { urls: 'turn:127.0.0.1:99999', username: 'u', credential: 'test-only' },
      { urls: 'turn:127.0.0.1:3478', username: longUser, credential: 'test-only' },
    ] }),
  }));
  const a = await context.newPage();
  const b = await context.newPage();
  const errs = [...collectConsole(a), ...collectConsole(b)];
  for (const p of [a, b]) {
    await hookBroker(p);
    await p.addInitScript(RTC_LOG);
  }
  const t0 = Date.now();
  await toLobby(a, b);
  expect(Date.now() - t0).toBeLessThan(30_000);
  for (const p of [a, b]) {
    const ice = await p.evaluate(() => (window as unknown as { __rtcIce: string[] }).__rtcIce);
    // The browser check built (and closed) one RTCPeerConnection for the third server, which threw; the connection's
    // own RTCPeerConnection got only the hook's list ([]): every relay.json server was dropped.
    expect(ice).toContain(JSON.stringify([{ urls: 'turn:127.0.0.1:3478', username: longUser, credential: 'test-only' }]));
    expect(ice.at(-1)).toBe('[]');
    expect(ice.some((x) => x.includes('99999') || x.includes('transport=udp'))).toBe(false);
    const report = await diag(p);
    expect(report).toContain('relay: relay.json server 0: only stun:, turn: and turns: URLs are allowed');
    expect(report).toContain('relay: relay.json server 1: only stun:, turn: and turns: URLs are allowed');
    expect(report).toContain('relay: relay.json server 0: the browser rejects this server (InvalidAccessError); ignored');
    expect(report).toContain('relay: 0 server(s) from relay.json (no TURN)');
    expect(report).toMatch(/\[net\] ice connected: .* 0 ICE server\(s\), no TURN/);
    expect(report).not.toContain('test-only');
    expect(report).not.toContain(longUser);
  }
  expect(errs).toEqual([]);
});

/**
 * Different networks, simulated: every remote ICE candidate is rewritten to an address nobody answers on (192.0.2.1,
 * TEST-NET-1) before it reaches the RTCPeerConnection, so candidates are exchanged but no pair can connect (stage
 * 'ice'). (mDNS-hidden host candidates do not do it here: Chromium resolves its own mDNS names, even across browsers.)
 */
const UNREACHABLE_PEERS = `(() => {
  const P = RTCPeerConnection.prototype;
  const add = P.addIceCandidate;
  P.addIceCandidate = function (c, ...rest) {
    if (c && typeof c.candidate === 'string' && c.candidate) {
      c = { ...(typeof c.toJSON === 'function' ? c.toJSON() : c), candidate: c.candidate.replace(/^(candidate:\\S+ \\d+ \\S+ \\d+ )\\S+/, '$1192.0.2.1') };
    }
    return add.call(this, c, ...rest);
  };
})();`;

/** Guest page that joins and fails 'blocked' (no pair of candidates can connect, see UNREACHABLE_PEERS). */
async function blockedJoin(context: BrowserContext): Promise<{ a: Page; b: Page }> {
  const a = await context.newPage();
  const b = await context.newPage();
  for (const p of [a, b]) {
    await hookBroker(p, { connectTimeoutMs: 6000 });
    await p.addInitScript(UNREACHABLE_PEERS);
  }
  await bootToMain(a);
  await openOnlineFromMenu(a);
  await a.getByTestId('net-create').click();
  await expect(a.getByTestId('net-room-code')).toHaveText('KQZ 7MP');
  await bootToMain(b);
  await openOnlineFromMenu(b);
  await b.getByTestId('net-join').click();
  await b.keyboard.type(ROOM_CODE);
  await expect(b.getByTestId('net-error-blocked')).toBeVisible({ timeout: 30_000 });
  return { a, b };
}

test.describe('[NET-FIX] blocked connection copy', () => {
  test('no relay configured: could not reach each other directly, same Wi-Fi, or ask for a relay', async ({ context }) => {
    test.setTimeout(120_000);
    await blockedNoRelay(context);
  });

  test('a relay in relay.json that cannot be reached: "Could not reach the relay"', async ({ context }) => {
    test.setTimeout(120_000);
    await blockedRelayUnreachable(context);
  });
});

async function blockedNoRelay(context: BrowserContext): Promise<void> {
  {
    const { b } = await blockedJoin(context);
    await expect(b.getByTestId('net-error-blocked')).toHaveAttribute('data-blocked', 'no-relay');
    await expect(b.getByTestId('net-error-title')).toHaveText('The network blocked the connection');
    await expect(b.getByTestId('net-error-body')).toContainText('could not reach each other directly');
    await expect(b.getByTestId('net-error-body')).toContainText('mobile data');
    await expect(b.getByTestId('net-error-body')).toContainText('same Wi-Fi');
    await expect(b.getByTestId('net-error-body')).toContainText('add a relay');
    await expect(b.getByTestId('net-retry')).toBeVisible();
    const report = await diag(b);
    expect(report).toMatch(/\[net\] ice failed at (ice|signalling): local host.*0 ICE server\(s\), no TURN/);
  }
}

async function blockedRelayUnreachable(context: BrowserContext): Promise<void> {
  {
    await context.route('**/relay.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ iceServers: [TURN_DEAD] }) }));
    const { b } = await blockedJoin(context);
    await expect(b.getByTestId('net-error-blocked')).toHaveAttribute('data-blocked', 'relay-unreachable');
    await expect(b.getByTestId('net-error-title')).toHaveText('Could not reach the relay');
    await expect(b.getByTestId('net-error-body')).toContainText('could not be reached');
    const report = await diag(b);
    expect(report).toMatch(/\[net\] ice failed at \w+: local host[^,]*, .*1 ICE server\(s\) incl\. TURN/);
    expect(report).not.toMatch(/ice failed at \w+: local [a-z+]*relay/);
  }
}
