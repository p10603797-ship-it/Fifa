/**
 * [NET-FIX-2, D-045] Same-Wi-Fi devices that cannot see each other, over real WebRTC between two pages brokered by a
 * local PeerServer (devDependency 'peer', as tests/e2e/int-08-webrtc.spec.ts; nothing leaves the machine).
 *
 * WEBKIT_FILTER simulates what Safari does on an iPad without a capture grant, in Chromium: every candidate this page
 * gathers is rewritten to an address nobody answers on (192.0.2.1, TEST-NET-1) before PeerJS sends it, the way an mDNS
 * name the other iPad cannot resolve is unusable; once the page holds a getUserMedia grant, its candidates go out
 * unchanged (WebKit lifts ICE candidate filtering for the document). Two filtered pages fail 'blocked'; one page with
 * a grant is enough, because the other side learns a peer-reflexive candidate from its connectivity checks. The fake
 * microphone comes from Chromium's --use-fake-ui-for-media-stream / --use-fake-device-for-media-stream.
 *
 * Checks:
 *  - the connecting view shows the stage in plain words and a seconds-left count that goes down;
 *  - the host's failed-join notice appears after a blocked attempt, names the stage, stays (no toast), and goes away
 *    when a guest connects;
 *  - the guest's "Try local-network mode" asks for the microphone, connects, and every track is stopped afterwards;
 *  - the host's local-network mode (from the notice) lets a plain retry connect; its track is stopped afterwards;
 *  - a denied microphone: a clear message, and the normal Try again still works.
 *
 *   npx vite build --outDir dist-e2e/netb --emptyOutDir
 *   PW_DIST=dist-e2e/netb PW_PORT=4331 npx playwright test tests/e2e/net-fix-2-local.spec.ts
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import { PeerServer } from 'peer';
import { bootToMain, collectConsole, openOnlineFromMenu, ROOM_CODE } from './net-07-harness';

const BASE_ARGS = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-features=WebRtcHideLocalIpsWithMdns'];
const FAKE_MIC = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

// Chromium flags only (a WebKit run, when its browser is installed, gets none: see D-045 for what it shows).
test.use({ launchOptions: async ({ browserName }, use) => use({ args: browserName === 'chromium' ? [...BASE_ARGS, ...FAKE_MIC] : [] }) });

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

/** See the file header. Also records every microphone track handed to the page (window.__dkMic). */
const WEBKIT_FILTER = `(() => {
  const mic = window.__dkMic = { granted: false, asked: 0, tracks: [] };
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia && !window.__dkDenyMic) {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      mic.asked++;
      const s = await orig(c);
      mic.granted = true;
      for (const t of s.getTracks()) mic.tracks.push(t);
      return s;
    };
  }
  const P = RTCPeerConnection.prototype;
  const d = Object.getOwnPropertyDescriptor(P, 'onicecandidate');
  Object.defineProperty(P, 'onicecandidate', {
    configurable: true,
    get() { return d.get.call(this); },
    set(fn) {
      const pc = this;
      d.set.call(this, typeof fn !== 'function' ? fn : (e) => {
        const c = e && e.candidate;
        if (mic.granted || !c || !c.candidate) return fn.call(pc, e);
        const j = c.toJSON();
        j.candidate = c.candidate.replace(/^(candidate:\\S+ \\d+ \\S+ \\d+ )\\S+/, '$1192.0.2.1');
        return fn.call(pc, { candidate: new RTCIceCandidate(j) });
      });
    },
  });
})();`;

/** getUserMedia refuses, as when the player taps "Don't Allow" (set before WEBKIT_FILTER). */
const DENY_MIC = `(() => {
  window.__dkDenyMic = true;
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
})();`;

const diag = (p: Page): Promise<string> => p.evaluate(() => window.__dotkick!.ctx.diagnostics.report());
const micTracks = (p: Page): Promise<{ asked: number; states: string[] }> =>
  p.evaluate(() => {
    const m = (window as unknown as { __dkMic: { asked: number; tracks: MediaStreamTrack[] } }).__dkMic;
    return { asked: m.asked, states: m.tracks.map((t) => t.readyState) };
  });

/** Host room up, guest joins and fails 'blocked' (both pages filtered). Checks the connecting progress on the way. */
async function blockedJoin(context: BrowserContext, opts: { denyMic?: boolean } = {}): Promise<{ a: Page; b: Page; errs: string[] }> {
  const a = await context.newPage();
  const b = await context.newPage();
  const errs = [...collectConsole(a), ...collectConsole(b)];
  for (const p of [a, b]) {
    await hookBroker(p, { connectTimeoutMs: 8000 });
    if (opts.denyMic) await p.addInitScript(DENY_MIC);
    await p.addInitScript(WEBKIT_FILTER);
  }
  await bootToMain(a);
  await openOnlineFromMenu(a);
  await a.getByTestId('net-nickname').fill('Ana');
  await a.getByTestId('net-create').click();
  await expect(a.getByTestId('net-room-code')).toHaveText('KQZ 7MP');
  await expect(a.getByTestId('net-local-toggle')).toBeVisible();
  await bootToMain(b);
  await openOnlineFromMenu(b);
  await b.getByTestId('net-join').click();
  await b.keyboard.type(ROOM_CODE);
  // [NET-FIX-2] Connecting progress: the stage in plain words and the seconds left, counting down.
  await expect(b.getByTestId('net-progress-stage')).toHaveText('Connecting to your friend…', { timeout: 10_000 });
  const left = b.getByTestId('net-progress-left');
  await expect(left).toHaveText(/^Gives up in \d+ s$/);
  const first = Number((await left.textContent())!.match(/\d+/)![0]);
  expect(first).toBeLessThanOrEqual(8);
  await expect.poll(async () => Number(((await left.textContent()) ?? '').match(/\d+/)?.[0] ?? 99), { timeout: 5000 }).toBeLessThan(first);
  await expect(b.getByTestId('net-error-blocked')).toBeVisible({ timeout: 30_000 });
  return { a, b, errs };
}

/** The host's failed-join notice: present, plain words, no toast. */
async function expectHostNotice(a: Page): Promise<void> {
  const n = a.getByTestId('net-join-failed');
  await expect(n).toBeVisible({ timeout: 20_000 });
  await expect(a.getByTestId('net-join-failed-title')).toHaveText('A friend tried to join, but your devices could not connect');
  await expect(n).toHaveAttribute('data-stage', /^(ice|signalling)$/);
  await expect(a.getByTestId('net-join-failed-stage')).toHaveText(/\.$/);
  await expect(a.getByTestId('net-join-failed-advice')).toContainText('local-network mode');
  await expect(a.getByTestId('net-toast')).toHaveCount(0); // the notice replaces the old toast
  // It stays (a toast would be gone by now).
  await a.waitForTimeout(4000);
  await expect(n).toBeVisible();
}

test('[NET-FIX-2] guest: blocked on the same Wi-Fi, "Try local-network mode" connects; the host notice stays until then; the microphone is stopped', async ({ context }) => {
  test.setTimeout(150_000);
  const { a, b, errs } = await blockedJoin(context);
  await expect(b.getByTestId('net-error-blocked')).toHaveAttribute('data-blocked', 'no-relay');
  await expect(b.getByTestId('net-local-explain')).toContainText('nothing is recorded');
  await expect(b.getByTestId('net-retry')).toBeVisible();
  await expectHostNotice(a);
  expect((await micTracks(b)).asked).toBe(0); // never asked before the tap

  await b.getByTestId('net-local-retry').click();
  await expect(b.getByTestId('net-lobby')).toBeVisible({ timeout: 40_000 });
  await expect(b.getByTestId('net-quality')).toContainText('Connected', { timeout: 10_000 });
  await expect(a.getByTestId('net-peer')).not.toContainText('Waiting', { timeout: 10_000 });
  await expect(a.getByTestId('net-join-failed')).toHaveCount(0); // a guest connected: the notice is gone
  const mic = await micTracks(b);
  expect(mic.asked).toBe(1);
  expect(mic.states.length).toBeGreaterThan(0);
  await expect.poll(async () => (await micTracks(b)).states.every((s) => s === 'ended')).toBe(true); // stopped once open
  expect((await micTracks(a)).asked).toBe(0); // the host never asked
  const rb = await diag(b);
  expect(rb).toContain('local mode on');
  expect(rb).toContain('local mode off (link open)');
  expect(rb).toMatch(/\[net\] ice failed at \w+: .*host addresses local ip/); // the first attempt's snapshot
  expect(rb).toMatch(/peer build \S+, this build \S+/);
  expect(await diag(a)).toMatch(/lobby: peer build \S+/);
  expect(errs).toEqual([]);
});

test('[NET-FIX-2] host: local-network mode from the failed-join notice lets the guest\'s plain retry connect; stopped afterwards', async ({ context }) => {
  test.setTimeout(150_000);
  const { a, b, errs } = await blockedJoin(context);
  await expectHostNotice(a);
  await a.getByTestId('net-join-failed-local').click();
  await expect(a.getByTestId('net-join-failed-advice')).toContainText('Ask your friend to join again');
  await expect(a.getByTestId('net-local-toggle')).toHaveAttribute('aria-checked', 'true');
  expect((await micTracks(a)).states).toEqual(['live']);

  await b.getByTestId('net-retry').click(); // the guest's normal path: no microphone on this side
  await expect(b.getByTestId('net-lobby')).toBeVisible({ timeout: 40_000 });
  await expect(b.getByTestId('net-quality')).toContainText('Connected', { timeout: 10_000 });
  await expect.poll(async () => (await micTracks(a)).states.every((s) => s === 'ended')).toBe(true);
  expect((await micTracks(b)).asked).toBe(0);
  const ra = await diag(a);
  expect(ra).toContain('local mode on');
  expect(ra).toContain('local mode off (link open)');
  expect(errs).toEqual([]);
});

test('[NET-FIX-2] host waiting screen: the toggle turns local-network mode on and off (the track stops)', async ({ context }) => {
  test.setTimeout(60_000);
  const a = await context.newPage();
  const errs = collectConsole(a);
  await hookBroker(a);
  await a.addInitScript(WEBKIT_FILTER);
  await bootToMain(a);
  await openOnlineFromMenu(a);
  await a.getByTestId('net-create').click();
  await expect(a.getByTestId('net-room-code')).toHaveText('KQZ 7MP');
  const toggle = a.getByTestId('net-local-toggle');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(a.getByTestId('net-local-status')).toContainText('Safari will ask for the microphone');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(a.getByTestId('net-local-status')).toContainText('turns off once they connect');
  expect((await micTracks(a)).states).toEqual(['live']);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect((await micTracks(a)).states).toEqual(['ended']);
  // Leaving the room with it on stops it too.
  await toggle.click();
  await expect.poll(async () => (await micTracks(a)).states).toEqual(['ended', 'live']);
  await a.getByTestId('back').click();
  await expect.poll(async () => (await micTracks(a)).states).toEqual(['ended', 'ended']);
  expect(await diag(a)).toContain('local mode off (left the room)');
  expect(errs).toEqual([]);
});

test.describe('[NET-FIX-2] microphone denied', () => {
  // getUserMedia itself refuses (DENY_MIC), whatever the fake-UI flag would answer.
  test('a clear message; the normal Try again still works', async ({ context }) => {
    test.setTimeout(150_000);
    const { b, errs } = await blockedJoin(context, { denyMic: true });
    await b.getByTestId('net-local-retry').click();
    await expect(b.getByTestId('net-local-msg')).toHaveText(/Microphone not allowed, so local-network mode is off\. You can still try again the normal way/);
    await expect(b.getByTestId('net-error-blocked')).toBeVisible(); // still on the blocked screen, nothing dialled
    expect(await diag(b)).toContain('local mode denied');
    await b.getByTestId('net-retry').click();
    await expect(b.getByTestId('net-progress-stage')).toBeVisible({ timeout: 10_000 });
    await expect(b.getByTestId('net-error-blocked')).toBeVisible({ timeout: 40_000 }); // tried again (still filtered)
    await expect(b.getByTestId('net-local-msg')).toHaveCount(0);
    expect(errs).toEqual([]);
  });
});
