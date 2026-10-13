/**
 * PAD-05 e2e: right-stick recogniser in a real browser with a mocked pad (navigator.getGamepads overridden by an init
 * script). The real pad manager (PAD-01) polls the mock once per requestAnimationFrame, the real recogniser
 * (src/input/pad/rightStick.ts) is fed with updatePad() and sampled with applyTo() every frame, exactly as the pad
 * mapper will. The modules are bundled for the page with esbuild (no app boot, no WebGL: keeps the spec fast).
 * A path player moves the mock's right stick (axes 2/3) along scripted paths in page time.
 *
 *   npx vite build --outDir dist-e2e/pad-05 --emptyOutDir
 *   PW_DIST=dist-e2e/pad-05 PW_PORT=4205 npx playwright test tests/e2e/pad-05-rightstick.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const MOCK_PAD = `
  window.__pad = {
    id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', index: 0, connected: true,
    mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], vibrationActuator: null,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [window.__pad, null, null, null] });
`;

/** Page harness: manager + recogniser on rAF, a path player for the mock's sticks, and a log of reported frames. */
const HARNESS = `
import { createPadManager } from './src/input/pad/manager';
import { mapPadButtons } from './src/input/pad/mapper';
import { createRightStick } from './src/input/pad/rightStick';
import { createInputFrame } from './src/contracts/input';

type Key = [number, number, number];
const w = window as unknown as Record<string, unknown> & { __pad: { axes: number[]; buttons: { pressed: boolean; value: number }[] } };
const mgr = createPadManager();
const rs = createRightStick();
const log: { t: number; buttons: number; skill: number; ax: number; az: number }[] = [];
let keys: Key[] = [];
let stick = 'right';
let start = -1;
let done = true;
let facing = [1, 0];
let frames = 0;

function lerp(t: number): [number, number] {
  if (t <= keys[0]![0]) return [keys[0]![1], keys[0]![2]];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!, b = keys[i]!;
    if (t <= b[0]) { const u = (t - a[0]) / Math.max(1e-9, b[0] - a[0]); return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]; }
  }
  done = true;
  return [keys[keys.length - 1]![1], keys[keys.length - 1]![2]];
}

function frame(now: number): void {
  frames++;
  if (!done) {
    if (start < 0) start = now;
    const [deg, mag] = lerp(now - start);
    const th = deg * Math.PI / 180;
    const fx = facing[0]!, fz = facing[1]!;
    // Facing-relative angle (+ = player's right) -> pitch -> screen (broadcast camera: same axes).
    const px = mag * (Math.cos(th) * fx - Math.sin(th) * fz);
    const pz = mag * (Math.cos(th) * fz + Math.sin(th) * fx);
    const o = stick === 'right' ? 2 : 0;
    w.__pad.axes[o] = px; w.__pad.axes[o + 1] = pz;
  }
  mgr.poll(now);
  const s = mgr.find('pad:1');
  if (s && s.connected) {
    rs.updatePad(s, mapPadButtons(s), now);
    const f = createInputFrame();
    rs.applyTo(f);
    if (f.buttons !== 0 || f.skill !== 0) log.push({ t: now, buttons: f.buttons, skill: f.skill, ax: f.ax, az: f.az });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

w.__rs = {
  play(k: Key[], f: [number, number], which: string, held: number[]): void {
    keys = k; facing = f; stick = which; start = -1; done = false; log.length = 0;
    rs.setFacing(f[0], f[1]);
    for (let b = 0; b < 16; b++) { const on = held.includes(b); w.__pad.buttons[b]!.pressed = on; w.__pad.buttons[b]!.value = on ? 1 : 0; }
  },
  get done() { return done; },
  get frames() { return frames; },
  log,
};
`;

interface RsWin { __rs: { play(k: number[][], f: number[], which: string, held: number[]): void; done: boolean; frames: number; log: { t: number; buttons: number; skill: number; ax: number; az: number }[] } }

let bundle = '';

test.beforeAll(async () => {
  const r = await build({
    stdin: { contents: HARNESS, resolveDir: ROOT, loader: 'ts', sourcefile: 'pad-05-harness.ts' },
    bundle: true, format: 'iife', write: false, target: 'es2022', define: { __DEV_BUILD__: 'true' }, logLevel: 'silent',
  });
  bundle = r.outputFiles[0]!.text;
});

async function play(page: Page, keys: number[][], facing: number[], which = 'right', held: number[] = []) {
  await page.evaluate(([k, f, w, h]) => (window as unknown as RsWin).__rs.play(k as number[][], f as number[], w as string, h as number[]), [keys, facing, which, held] as const);
  await page.waitForFunction(() => (window as unknown as RsWin).__rs.done, null, { timeout: 10_000 });
  // Settle a few frames so release-time skills (body feint) and deferred samples are logged.
  const f0 = await page.evaluate(() => (window as unknown as RsWin).__rs.frames);
  await page.waitForFunction((f) => (window as unknown as RsWin).__rs.frames >= f + 6, f0, { timeout: 10_000 });
  return page.evaluate(() => (window as unknown as RsWin).__rs.log.slice());
}

const RS_FLICK = 1 << 8;
const SKILL = { BALL_ROLL: 1, STEP_OVER: 2, BODY_FEINT: 3, DRAG_BACK: 4, ROULETTE: 6, HEEL_FLICK: 7 };

test('mocked pad right stick: skill patterns relative to facing, flicks with direction, no skill from aiming', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(MOCK_PAD);
  await page.goto('about:blank');
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => (window as unknown as RsWin).__rs?.frames > 3);

  const skills = (log: { skill: number }[]) => log.filter((x) => x.skill !== 0).map((x) => x.skill);

  // Step-over right, facing +x (right = +z): one STEP_OVER toward +z.
  let log = await play(page, [[0, 0, 0], [40, 0, 1], [170, 90, 1], [260, 90, 1], [300, 90, 0]], [1, 0]);
  expect(skills(log)).toEqual([SKILL.STEP_OVER]);
  expect(log.find((x) => x.skill !== 0)!.az).toBe(127);

  // Facing -x: a flick toward +z is the player's LEFT -> body feint toward +z.
  log = await play(page, [[0, -90, 0], [30, -90, 1], [90, -90, 1], [120, -90, 0]], [-1, 0]);
  expect(skills(log)).toEqual([SKILL.BODY_FEINT]);
  expect(log.filter((x) => (x.buttons & RS_FLICK) !== 0).map((x) => [x.ax, x.az])).toEqual([[0, 127]]);

  // Hold right -> ball roll; roulette; heel flick.
  log = await play(page, [[0, 90, 0], [30, 90, 1], [500, 90, 1], [530, 90, 0]], [0, -1]);
  expect(skills(log)).toEqual([SKILL.BALL_ROLL]);
  log = await play(page, [[0, 180, 0], [30, 180, 1], [230, 0, 1], [270, 0, 0]], [1, 0]);
  expect(skills(log)).toEqual([SKILL.ROULETTE]);
  log = await play(page, [[0, 0, 0], [30, 0, 1], [80, 0, 1], [110, 0, 0], [140, 180, 0], [170, 180, 1], [220, 180, 1], [250, 180, 0]], [1, 0]);
  expect(skills(log)).toEqual([SKILL.HEEL_FLICK]);

  // Drag-back: L1 + R1 held (indices 4, 5), left stick flicked back.
  log = await play(page, [[0, 180, 0], [30, 180, 1], [120, 180, 1], [150, 180, 0]], [1, 0], 'left', [4, 5]);
  expect(skills(log)).toEqual([SKILL.DRAG_BACK]);

  // Aiming: a slow sweep and small nudges give one flick at most and no skill.
  log = await play(page, [[0, 0, 0], [40, 0, 1], [2400, 360, 1], [2440, 360, 0]], [1, 0]);
  expect(skills(log)).toEqual([]);
  expect(log.filter((x) => (x.buttons & RS_FLICK) !== 0)).toHaveLength(1);
  log = await play(page, [[0, 30, 0.5], [300, 200, 0.55], [600, -60, 0.5], [900, 90, 0.4], [950, 0, 0]], [1, 0]);
  expect(log).toEqual([]);

  expect(errors).toEqual([]);
});
