/**
 * FND-INT: walking-skeleton end-to-end gate (Wave 0 exit). One continuous session on an iPad-like viewport
 * (1180 x 820, touch, DPR 2) with a mocked gamepad:
 *   boot -> splash -> main -> Kick-Off -> loading -> match
 *   -> default setup: human 0 at home on every local device, away side CPU
 *   -> screenshot of the match (reports/skeleton.png)
 *   -> pixel probes of the real renderer (paused, deterministic frames): the pitch (grass + lines), 22 capsules each
 *      drawn at its sim position in its team colour, the ball, and the raised broadcast camera on the +z touchline
 *      that follows the ball
 *   -> the controlled player moves with the keyboard, a touch drag in the left half and a mocked gamepad
 *   -> pause (Escape and the touch PAUSE button) freezes the sim; Resume continues
 *   -> Restart gives a fresh match that still renders and takes input; Quit returns to the main menu and releases
 *      the match (touch overlay, canvas layer, state); a second Kick-Off works
 *   -> zero console errors or warnings (except the container's software-GPU notices), zero reported app errors.
 * Requires `npx vite build` first (playwright.config.ts serves dist/ with vite preview).
 *
 * WAVE 0 ASSUMPTION: the Wave 0 sim never leaves PRE_MATCH and its stub resolver moves the controlled player in any
 * phase. Once RUL-01 (PRE_MATCH -> KICK_OFF after 2 s), SIM-15 (free movement only in IN_PLAY) and the CPU kick-off
 * (TAI-08/13) land, the movement steps must first get the match into IN_PLAY (take or wait for the kick-off).
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SimState } from '../../src/contracts/state';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCREENSHOT = resolve(REPO_ROOT, 'reports/skeleton.png');

/**
 * Messages Chromium itself prints about the container's software GPU (SwiftShader): no page script logs them and
 * they do not occur on devices with a GPU (same filter as tests/e2e/fnd-04-boot.spec.ts).
 */
const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];

/** Mock gamepad installed before any page script: navigator.getGamepads() returns window.__mockPad. */
const MOCK_PAD_SCRIPT = `
  window.__mockPad = {
    id: 'Mock Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard',
    timestamp: 0, axes: [0, 0, 0, 0], vibrationActuator: null,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [window.__mockPad, null, null, null] });
`;

interface MockPad { buttons: { pressed: boolean; value: number }[]; axes: number[] }
interface Controlled { slot: number; x: number; z: number; tick: number }
type Rgb = [number, number, number];

function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
    out.push(`${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

const current = (page: Page): Promise<string | null> => page.evaluate(() => window.__dotkick!.ctx.router.current);
const tick = (page: Page): Promise<number> => page.evaluate(() => window.__dotkick!.ctx.session.getState()?.tick ?? -1);

async function controlled(page: Page): Promise<Controlled> {
  return page.evaluate(() => {
    const s = window.__dotkick!.ctx.session.getState()!;
    const slot = s.ctrl[0]!.slot;
    const p = s.players[slot]!;
    return { slot, x: p.x, z: p.z, tick: s.tick };
  });
}

/** Wait until the match screen shows a loaded, ticking match with a controlled player. */
async function waitMatchRunning(page: Page, minTick = 10): Promise<void> {
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
  }, null, { timeout: 30_000 });
  await page.waitForFunction((t) => {
    const s = window.__dotkick!.ctx.session.getState();
    return !!s && s.tick > t && s.ctrl[0]!.slot >= 0;
  }, minTick, { timeout: 30_000 });
}

/**
 * Keep an input held for at least `ms` of real time AND `ticks` sim ticks. Headless Chromium renders with SwiftShader
 * at a few fps and the loop runs at most 3 ticks per frame, so wall time alone is not enough.
 */
async function holdFor(page: Page, startTick: number, ticks = 60, ms = 1000): Promise<void> {
  await page.waitForTimeout(ms);
  await page.waitForFunction((t) => (window.__dotkick!.ctx.session.getState()?.tick ?? -1) >= t, startTick + ticks, { timeout: 60_000 });
}

/** The controlled player comes to rest after an input is released (no stuck input). */
async function expectStops(page: Page): Promise<void> {
  await holdFor(page, await tick(page), 45, 300);
  const a = await controlled(page);
  await holdFor(page, a.tick, 15, 0);
  const b = await controlled(page);
  expect(Math.hypot(b.x - a.x, b.z - a.z), 'player at rest after release').toBeLessThan(0.2);
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
}

async function tapPoint(cdp: CDPSession, x: number, y: number): Promise<void> {
  await touch(cdp, 'touchStart', x, y);
  await touch(cdp, 'touchEnd', x, y);
}

async function setPad(page: Page, fn: string): Promise<void> {
  await page.evaluate((body) => {
    const pad = (window as unknown as { __mockPad: MockPad }).__mockPad;
    new Function('pad', body)(pad);
  }, fn);
}

/** Sim ticks advance while running and freeze while paused. */
async function expectFrozen(page: Page): Promise<void> {
  const t0 = await tick(page);
  await page.waitForTimeout(600);
  expect(await tick(page), 'sim frozen while paused').toBe(t0);
}

const dist = (a: Rgb, b: Rgb): number => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const grassLike = (c: Rgb): boolean => c[1] > c[0] + 8 && c[1] > c[2] + 8;
const mean = (cs: Rgb[]): Rgb => {
  const m: Rgb = [0, 0, 0];
  for (const c of cs) for (let i = 0; i < 3; i++) m[i] += c[i]! / cs.length;
  return m;
};

interface Probe {
  W: number;
  H: number;
  slots: { team: number; keeper: boolean; sx: number; sy: number; a: Rgb; b: Rgb }[];
  ball: { sx: number; sy: number; a: Rgb; b: Rgb };
  grass: Rgb[];
  lineMax: number;
  lineGrass: number;
  spot: { x: number; y: number };
  ellipse: { w: number; h: number };
  plusX: number;
  minusX: number;
  nearZ: number;
  farZ: number;
  farTouch: { x: number; y: number };
  follow: { ballX: number; spotX: number; groundX: number };
  restoredOk: boolean;
}

/**
 * Pixel probes of the real renderer. Runs in the page while the match is paused (the loop then only renders when
 * invalidated), as ONE synchronous task: it writes positions into prev and curr, draws frames with
 * GameRenderer.render exactly as the loop does (alpha 1, dt 100 ms so the broadcast camera settles), and reads the
 * drawing buffer with readPixels in the same task (valid without preserveDrawingBuffer). Frame A: 22 players in two
 * rows and the ball in the air; frame B: every player inactive and the ball below the grass. Frame C: ball near the
 * right box (camera follow). Everything written is restored afterwards.
 */
function runProbe(): Probe {
  const d = window.__dotkick!;
  const rt = d.app.session.runtime()!;
  const r = d.app.renderer;
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const gl = canvas.getContext('webgl2')!;
  const W = window.innerWidth, H = window.innerHeight;
  const info = { nowMs: performance.now(), dtMs: 100, frame: 1_000_000, ticks: 0, paused: true };
  const states = [rt.prev, rt.curr] as unknown as SimState[];
  const curr = rt.curr as unknown as SimState;
  /** Draw n frames of 100 ms: the critically damped camera (smoothTime 0.4 s) converges to < 1 mm in 16. */
  const settle = (n: number): void => {
    for (let i = 0; i < n; i++) {
      info.frame++;
      info.nowMs += 100;
      r.render(rt.prev, rt.curr, 1, info);
    }
  };
  const out = { x: 0, y: 0 };
  const proj = (x: number, y: number, z: number): { x: number; y: number } => {
    if (!r.projector.pitchToScreen(x, y, z, out)) return { x: NaN, y: NaN };
    return { x: out.x, y: out.y };
  };
  const buf = new Uint8Array(4 * 81);
  /** Mean colour of a (2k+1)^2 block of the drawing buffer around CSS point (sx, sy). */
  const read = (sx: number, sy: number, k = 1): Rgb => {
    const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
    const bx = Math.round((sx * bw) / W), by = Math.round(bh - 1 - (sy * bh) / H);
    const n = 2 * k + 1;
    gl.readPixels(bx - k, by - k, n, n, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const c: Rgb = [0, 0, 0];
    for (let i = 0; i < n * n; i++) for (let j = 0; j < 3; j++) c[j] += buf[i * 4 + j]! / (n * n);
    return c;
  };
  /** Brightest pixel (r+g+b) of a horizontal run of 2k+1 buffer pixels around CSS point (sx, sy). */
  const maxBrightRow = (sx: number, sy: number, k = 6): number => {
    const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
    const bx = Math.round((sx * bw) / W), by = Math.round(bh - 1 - (sy * bh) / H);
    gl.readPixels(bx - k, by, 2 * k + 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let m = 0;
    for (let i = 0; i < 2 * k + 1; i++) m = Math.max(m, buf[i * 4]! + buf[i * 4 + 1]! + buf[i * 4 + 2]!);
    return m;
  };

  // Save what is written.
  const saved = states.map((s) => ({
    players: s.players.map((p) => ({ x: p.x, z: p.z, fx: p.fx, fz: p.fz, active: p.active })),
    ball: { x: s.ball.x, y: s.ball.y, z: s.ball.z },
  }));

  // Frame A: team 0 on a row at z = -12, team 1 at z = +5, 2.7 m apart and staggered, facing the camera; ball in
  // the air. Chosen so that the grass seen behind each probe point (once the player is removed) is clear of the
  // halfway line and the centre circle, and nobody hides anybody from the raised camera.
  const layout = (s: SimState): void => {
    for (let i = 0; i < s.players.length; i++) {
      const p = s.players[i]!;
      const k = p.team === 0 ? i : i - 11;
      p.x = (p.team === 0 ? -14.85 : -12.15) + 2.7 * k;
      p.z = p.team === 0 ? -12 : 5;
      p.fx = 0;
      p.fz = 1;
      p.active = 1;
    }
    s.ball.x = 1; s.ball.y = 1.6; s.ball.z = 1.5;
  };
  states.forEach(layout);
  settle(16);
  const chest = curr.players.map((p, i) => proj(p.x, 0.95 * (curr.attrs[i]!.height > 0 ? curr.attrs[i]!.height / 180 : 1), p.z));
  const slotsA = chest.map((c) => read(c.x, c.y));
  const ballS = proj(curr.ball.x, curr.ball.y, curr.ball.z);
  const ballA = read(ballS.x, ballS.y);
  // Camera geometry (frame A camera).
  const spot = proj(0, 0, 0);
  const e1 = proj(9.15, 0, 0), e2 = proj(-9.15, 0, 0), e3 = proj(0, 0, 9.15), e4 = proj(0, 0, -9.15);
  const ellipse = { w: Math.abs(e1.x - e2.x), h: Math.abs(e3.y - e4.y) };
  const plusX = proj(10, 0, 0).x, minusX = proj(-10, 0, 0).x;
  const nearZ = proj(0, 0, 10).y, farZ = proj(0, 0, -10).y;
  const farTouch = proj(0, 0, -34);

  // Frame B: no players, ball below the grass (same x/z: the camera follows x/z only, so it does not move).
  states.forEach((s) => {
    for (const p of s.players) p.active = 0;
    s.ball.y = -3;
  });
  settle(2);
  const slotsB = chest.map((c) => read(c.x, c.y));
  const ballB = read(ballS.x, ballS.y);
  const grass = [proj(-10, 0, -15), proj(10, 0, -15), proj(-10, 0, 15), proj(10, 0, 15)].map((g) => read(g.x, g.y, 2));
  const line = proj(0, 0, -20);
  const lineMax = maxBrightRow(line.x, line.y);
  const lg = read(proj(-3, 0, -20).x, line.y, 2);
  const lineGrass = lg[0] + lg[1] + lg[2];

  // Frame C: ball near the right box; the broadcast camera slides along the touchline and turns to it.
  states.forEach((s) => {
    for (const p of s.players) p.active = 1;
    s.ball.x = 25; s.ball.y = 0.11; s.ball.z = 0;
  });
  settle(16);
  const fb = proj(25, 0.11, 0);
  const g = { x: 0, z: 0 };
  r.projector.screenToPitch(W / 2, H / 2, g);
  const follow = { ballX: fb.x, spotX: proj(0, 0, 0).x, groundX: g.x };

  // Restore; the loop's own frames glide the camera back once the match resumes.
  states.forEach((s, si) => {
    const sv = saved[si]!;
    s.players.forEach((p, i) => Object.assign(p, sv.players[i]));
    Object.assign(s.ball, sv.ball);
  });
  d.app.loop.invalidate();
  const restoredOk = curr.players.every((p, i) => p.x === saved[1]!.players[i]!.x && p.active === saved[1]!.players[i]!.active);

  return {
    W, H,
    slots: curr.players.map((p, i) => ({
      team: p.team, keeper: curr.teams[p.team]!.keeperSlot === i, sx: chest[i]!.x, sy: chest[i]!.y, a: slotsA[i]!, b: slotsB[i]!,
    })),
    ball: { sx: ballS.x, sy: ballS.y, a: ballA, b: ballB },
    grass, lineMax, lineGrass, spot, ellipse, plusX, minusX, nearZ, farZ, farTouch, follow, restoredOk,
  };
}

test.describe('FND-INT walking skeleton', () => {
  test('boot -> Kick-Off -> render, keyboard/touch/pad input, pause, restart, quit with zero errors', async ({ page }) => {
    test.setTimeout(420_000);
    await page.addInitScript(MOCK_PAD_SCRIPT);
    const consoleMsgs = collectConsole(page);
    const cdp = await page.context().newCDPSession(page);

    await test.step('boot -> splash -> main', async () => {
      await page.goto('/');
      await expect(page.locator('canvas#game')).toHaveCount(1);
      for (const id of ['hud', 'touch', 'ui']) await expect(page.locator(`div#${id}`)).toHaveCount(1);
      const start = page.getByTestId('splash-start');
      await expect(start).toBeVisible();
      expect(await current(page)).toBe('splash');
      await start.tap();
      await expect(page.getByTestId('main-kickoff')).toBeVisible();
      expect(await current(page)).toBe('main');
      // The renderer stats hook is installed at boot.
      expect(await page.evaluate(() => typeof window.__dotkickRendererStats)).toBe('function');
    });

    await test.step('Kick-Off -> loading -> match with the default setup', async () => {
      await page.getByTestId('main-kickoff').tap();
      await waitMatchRunning(page);
      const setup = await page.evaluate(() => {
        const ctx = window.__dotkick!.ctx;
        const st = ctx.session.getSetup()!;
        const s = ctx.session.getState()!;
        return {
          bindings: st.bindings,
          humans: st.config.humans.map((h) => ({ kind: h.kind, side: h.side })),
          ctrl: s.ctrl.map((c) => ({ kind: c.kind, side: c.side, slot: c.slot })),
          ctrlTeam: s.ctrl[0]!.slot >= 0 ? s.players[s.ctrl[0]!.slot]!.team : -1,
          players: s.players.length,
          matchLayer: document.body.classList.contains('match-active'),
          inMatch: document.body.classList.contains('in-match'),
        };
      });
      // Human 0 plays home with every local device (touch + the wildcard for keyboard / pads that appear later).
      expect(setup.bindings).toHaveLength(1);
      expect(setup.bindings[0]!.human).toBe(0);
      expect(setup.bindings[0]!.deviceIds).toContain('touch');
      expect(setup.bindings[0]!.deviceIds).toContain('*');
      expect(setup.humans[0]).toEqual({ kind: 1, side: 0 }); // ControllerKind.HUMAN, home
      expect(setup.humans[1]!.kind).toBe(0); // no second human
      expect(setup.ctrl[3]).toMatchObject({ kind: 2, side: 1 }); // CPU brain drives the away side
      expect(setup.ctrlTeam).toBe(0);
      expect(setup.players).toBe(22);
      expect(setup.matchLayer).toBe(true);
      expect(setup.inMatch).toBe(true);
      // Touch overlay: one stick zone, four action buttons and the PAUSE button.
      await expect(page.locator('#touch .dk-touch')).toHaveCount(1);
      await expect(page.locator('#touch .dk-tbtn')).toHaveCount(5);
      await expect(page.locator('#touch .dk-tbtn--pause')).toBeVisible();
      await expect(page.locator('#hud')).toBeVisible();
      const stats = await page.evaluate(() => window.__dotkickRendererStats!());
      expect(stats.drawCalls).toBeGreaterThan(3);
      expect(stats.drawCalls).toBeLessThanOrEqual(80);
      expect(stats.triangles).toBeGreaterThan(1000);
    });

    await test.step('screenshot of the match at 1180 x 820 -> reports/skeleton.png', async () => {
      await page.waitForTimeout(800);
      mkdirSync(dirname(SCREENSHOT), { recursive: true });
      await page.screenshot({ path: SCREENSHOT });
    });

    await test.step('render probes: pitch, 22 capsules, ball, broadcast camera', async () => {
      await page.evaluate(() => window.__dotkick!.ctx.session.pause(-1));
      expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
      const p = await page.evaluate(runProbe);
      const where = (i: number): string => `slot ${i} at (${p.slots[i]!.sx.toFixed(0)}, ${p.slots[i]!.sy.toFixed(0)})`;

      // 22 capsules: each one inside the view and drawn exactly where its sim position projects
      // (pixel differs from the same pixel with every player removed, which is grass behind).
      expect(p.slots).toHaveLength(22);
      for (let i = 0; i < 22; i++) {
        const s = p.slots[i]!;
        expect(s.sx > 0 && s.sx < p.W && s.sy > 0 && s.sy < p.H, `${where(i)} on screen`).toBe(true);
        expect(dist(s.a, s.b), `${where(i)} capsule drawn (A ${s.a.map(Math.round)} vs B ${s.b.map(Math.round)})`).toBeGreaterThan(45);
        expect(grassLike(s.b), `${where(i)} grass behind when removed (${s.b.map(Math.round)})`).toBe(true);
      }
      // Team colours: outfield players of a team share a colour; the two teams differ.
      const t0 = p.slots.filter((s) => s.team === 0 && !s.keeper).map((s) => s.a);
      const t1 = p.slots.filter((s) => s.team === 1 && !s.keeper).map((s) => s.a);
      expect(t0).toHaveLength(10);
      expect(t1).toHaveLength(10);
      const m0 = mean(t0), m1 = mean(t1);
      for (const c of t0) expect(dist(c, m0), 'team 0 shirt colour consistent').toBeLessThan(90);
      for (const c of t1) expect(dist(c, m1), 'team 1 shirt colour consistent').toBeLessThan(90);
      expect(dist(m0, m1), `team colours differ (${m0.map(Math.round)} vs ${m1.map(Math.round)})`).toBeGreaterThan(60);

      // The ball: drawn at its sim position (in the air), grass there once it is gone.
      expect(dist(p.ball.a, p.ball.b), `ball drawn (A ${p.ball.a.map(Math.round)} vs B ${p.ball.b.map(Math.round)})`).toBeGreaterThan(60);
      expect(grassLike(p.ball.a), 'ball is not grass-coloured').toBe(false);
      expect(grassLike(p.ball.b)).toBe(true);

      // The pitch: grass inside the lines, a bright halfway line.
      for (const g of p.grass) expect(grassLike(g), `grass (${g.map(Math.round)})`).toBe(true);
      expect(p.lineMax - p.lineGrass, `halfway line brighter than grass (${p.lineMax} vs ${Math.round(p.lineGrass)})`).toBeGreaterThan(60);

      // Broadcast camera: raised (centre circle seen as an ellipse, neither top-down nor ground level), on the +z
      // touchline looking across (+x to the right, +z toward the bottom), far touchline in the upper part of the view.
      const ratio = p.ellipse.h / p.ellipse.w;
      expect(ratio, `centre circle aspect ${ratio.toFixed(2)}`).toBeGreaterThan(0.15);
      expect(ratio).toBeLessThan(0.7);
      expect(p.plusX - p.minusX).toBeGreaterThan(100);
      expect(p.nearZ - p.farZ).toBeGreaterThan(30);
      expect(p.farTouch.y).toBeGreaterThan(0);
      expect(p.farTouch.y).toBeLessThan(p.H * 0.6);
      expect(p.spot.x).toBeGreaterThan(p.W * 0.3);
      expect(p.spot.x).toBeLessThan(p.W * 0.7);
      // It follows the ball along the touchline: ball near the right box stays in frame, the centre spot moves left.
      expect(p.follow.ballX).toBeGreaterThan(p.W * 0.2);
      expect(p.follow.ballX).toBeLessThan(p.W * 0.8);
      expect(p.follow.spotX).toBeLessThan(p.follow.ballX - p.W * 0.25);
      expect(p.follow.groundX).toBeGreaterThan(10);
      expect(p.restoredOk).toBe(true);

      await page.evaluate(() => window.__dotkick!.ctx.session.resume(-1));
      expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(false);
    });

    await test.step('keyboard: holding D moves the controlled player toward +x, release stops', async () => {
      const before = await controlled(page);
      await page.keyboard.down('KeyD');
      await holdFor(page, before.tick);
      const during = await controlled(page);
      await page.keyboard.up('KeyD');
      expect(during.slot).toBe(before.slot);
      expect(during.x - before.x).toBeGreaterThan(1.5);
      expect(Math.abs(during.z - before.z)).toBeLessThan(1);
      await expectStops(page);
    });

    await test.step('touch: an upward drag in the left half moves the player toward -z, lift stops', async () => {
      const before = await controlled(page);
      await touch(cdp, 'touchStart', 280, 620);
      for (let i = 1; i <= 6; i++) await touch(cdp, 'touchMove', 280, 620 - i * 20);
      await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(1);
      await holdFor(page, before.tick);
      const during = await controlled(page);
      await touch(cdp, 'touchEnd', 280, 500);
      await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(0);
      expect(during.z - before.z).toBeLessThan(-1.5);
      expect(Math.abs(during.x - before.x)).toBeLessThan(1);
      await expectStops(page);
    });

    await test.step('mocked gamepad: joins on a button press, left stick moves the player toward -x', async () => {
      expect(await page.evaluate(() => window.__dotkick!.ctx.devices.list().some((d) => d.kind === 'pad'))).toBe(false);
      await setPad(page, 'pad.buttons[2].pressed = true; pad.buttons[2].value = 1;');
      await page.waitForFunction(() => window.__dotkick!.ctx.devices.list().some((d) => d.kind === 'pad'), null, { timeout: 15_000 });
      await setPad(page, 'pad.buttons[2].pressed = false; pad.buttons[2].value = 0;');
      const before = await controlled(page);
      await setPad(page, 'pad.axes[0] = -1;');
      await holdFor(page, before.tick);
      const during = await controlled(page);
      await setPad(page, 'pad.axes[0] = 0;');
      expect(before.x - during.x).toBeGreaterThan(1.5);
      expect(Math.abs(during.z - before.z)).toBeLessThan(1);
      await expectStops(page);
    });

    await test.step('pause: Escape and the touch PAUSE button freeze the sim; Resume continues', async () => {
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('pause-menu')).toBeVisible();
      expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
      await expectFrozen(page);
      await page.getByTestId('pause-resume').tap();
      await expect(page.getByTestId('pause-menu')).toBeHidden();
      const t0 = await tick(page);
      await holdFor(page, t0, 10, 300);

      await page.waitForTimeout(300); // pause debounce
      const box = (await page.locator('#touch .dk-tbtn--pause').boundingBox())!;
      await tapPoint(cdp, box.x + box.width / 2, box.y + box.height / 2);
      await expect(page.getByTestId('pause-menu')).toBeVisible();
      expect(await page.evaluate(() => window.__dotkick!.ctx.session.pausedBy)).toBe(0);
      await expectFrozen(page);
      await page.getByTestId('pause-resume').tap();
      await expect(page.getByTestId('pause-menu')).toBeHidden();
      const t1 = await tick(page);
      await holdFor(page, t1, 10, 300);
    });

    await test.step('restart: a fresh match that renders and takes input', async () => {
      const seed0 = await page.evaluate(() => window.__dotkick!.ctx.session.getSetup()!.config.seed);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('pause-menu')).toBeVisible();
      await page.getByTestId('pause-restart').tap();
      await waitMatchRunning(page, 5);
      const after = await page.evaluate(() => {
        const ctx = window.__dotkick!.ctx;
        return {
          seed: ctx.session.getSetup()!.config.seed,
          paused: ctx.session.paused,
          tick: ctx.session.getState()!.tick,
          overlays: document.querySelectorAll('#touch .dk-touch').length,
          screens: document.querySelectorAll('#ui .screen--match').length,
        };
      });
      expect(after.seed).not.toBe(seed0);
      expect(after.paused).toBe(false);
      expect(after.tick).toBeLessThan(2000);
      expect(after.overlays).toBe(1);
      expect(after.screens).toBe(1);
      await expect(page.getByTestId('pause-menu')).toBeHidden();
      expect((await page.evaluate(() => window.__dotkickRendererStats!())).drawCalls).toBeGreaterThan(3);
      const before = await controlled(page);
      await page.keyboard.down('ArrowRight');
      await holdFor(page, before.tick);
      const during = await controlled(page);
      await page.keyboard.up('ArrowRight');
      expect(during.x - before.x).toBeGreaterThan(1.5);
      await expectStops(page);
    });

    await test.step('quit: back to the main menu with the match released; a second Kick-Off works', async () => {
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('pause-menu')).toBeVisible();
      await page.getByTestId('pause-quit').tap();
      await expect(page.getByTestId('main-kickoff')).toBeVisible();
      const gone = await page.evaluate(() => {
        const ctx = window.__dotkick!.ctx;
        return {
          screen: ctx.router.current,
          active: ctx.session.active,
          state: ctx.session.getState() === null,
          overlays: document.querySelectorAll('#touch .dk-touch').length,
          matchLayer: document.body.classList.contains('match-active'),
          inMatch: document.body.classList.contains('in-match'),
        };
      });
      expect(gone).toEqual({ screen: 'main', active: false, state: true, overlays: 0, matchLayer: false, inMatch: false });

      await page.getByTestId('main-kickoff').tap();
      await waitMatchRunning(page, 5);
      await expect(page.locator('#touch .dk-touch')).toHaveCount(1);
      const before = await controlled(page);
      await page.keyboard.down('KeyA');
      await holdFor(page, before.tick, 40, 500);
      const during = await controlled(page);
      await page.keyboard.up('KeyA');
      expect(before.x - during.x).toBeGreaterThan(0.8);
      await page.keyboard.press('Escape');
      await page.getByTestId('pause-quit').tap();
      await expect(page.getByTestId('main-kickoff')).toBeVisible();
    });

    await test.step('zero console errors and zero reported app errors', async () => {
      const appErrors = await page.evaluate(() => ({
        recovery: window.__dotkick!.app.recovery.errors,
        log: window.__dotkick!.ctx.diagnostics.recent().filter((l) => /error/i.test(l)),
      }));
      expect(appErrors.recovery).toBe(0);
      expect(appErrors.log).toEqual([]);
      expect(consoleMsgs).toEqual([]);
    });
  });
});
