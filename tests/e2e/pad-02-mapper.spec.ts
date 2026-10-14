/**
 * PAD-02 e2e: the pad mapper in a real browser with a mocked Standard Gamepad (navigator.getGamepads overridden by an
 * init script). The real PAD-01 manager is polled on requestAnimationFrame through the real PAD-02 source, which is
 * sampled on every SECOND frame into the real sim step() (an IN_PLAY match, P1 on side 0) - two polls per tick, as on
 * a 120 Hz iPad (so the sim runs at about 30 ticks per wall-clock second here). Taps are made by timers: short taps
 * fall entirely between two samples, and fast taps (up for less than a sample interval) often release and re-press
 * between two samples. Fast taps come no faster than the sim can show them (each distinct press needs one sample
 * down and one up: about 67 ms per press at this tick rate; 30 presses per second at the real 60 Hz). Every tap must reach
 * the sim as exactly one press edge, Options must pause once per press, and the left stick must move the controlled
 * player. The modules are bundled for the page with esbuild (no app boot, no WebGL).
 *
 *   npx vite build --outDir dist-e2e/pad-02 --emptyOutDir
 *   PW_DIST=dist-e2e/pad-02 PW_PORT=4202 npx playwright test tests/e2e/pad-02-mapper.spec.ts
 */
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const MOCK_PAD = `
  window.__pad = {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true,
    mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], vibrationActuator: null,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  window.__pads = [window.__pad, null, null, null];
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => window.__pads });
`;

const HARNESS = `
import { createPadManager } from './src/input/pad/manager';
import { createPadSource } from './src/input/pad/mapper';
import { createInputFrame, Btn } from './src/contracts/input';
import { createMatchConfig } from './src/contracts/state';
import { MatchPhase } from './src/contracts/enums';
import { initMatch } from './src/sim/init';
import { step } from './src/sim/step';
import { createEventBuffer } from './src/sim/core/events';

type MockBtn = { pressed: boolean; touched: boolean; value: number };
type Mock = { id: string; index: number; connected: boolean; mapping: string; timestamp: number; axes: number[]; buttons: MockBtn[] };
const w = window as unknown as Record<string, unknown> & { __pad: Mock; __pads: (Mock | null)[] };
const mgr = createPadManager();
let pauses = 0;
const src = createPadSource({ key: 'pad:1', manager: mgr, onPause: () => { pauses++; } });
/** Second pad: non-standard mapping, read through a saved remap (PadAction -> raw index; SPRINT on analogue raw 17). */
const GENERIC = 'USB Gamepad (Vendor: 0079 Product: 0011)';
const REMAP = [3, 2, 1, 0, 6, 7, 16, 17, 9, 12, 13, 14, 15];
const settings = { controls: { pad: { familyOverride: 0, rumble: true, remaps: { [GENERIC]: REMAP } } } };
let pausesB = 0;
const srcB = createPadSource({ key: 'pad:2', manager: mgr, onPause: () => { pausesB++; }, settings: { get: () => settings as never } });
const frameB = createInputFrame();
const pressesB: Record<string, number> = { PASS: 0, SHOOT: 0, LOB: 0, THROUGH: 0, SPRINT: 0 };
let prevB = 0;
let sprintB = 0;
const s = initMatch(createMatchConfig());
s.match.phase = MatchPhase.IN_PLAY;
s.match.prevPhase = MatchPhase.IN_PLAY;
const frames = [createInputFrame(), createInputFrame()];
const ev = createEventBuffer();
const simPresses: Record<string, number> = { PASS: 0, SHOOT: 0, LOB: 0, THROUGH: 0 };
const names: [string, number][] = [['PASS', Btn.PASS], ['SHOOT', Btn.SHOOT], ['LOB', Btn.LOB], ['THROUGH', Btn.THROUGH]];
let ticks = 0;
let polls = 0;
/** Press edges the manager saw per standard button (what any polling consumer could know), and the longest poll gap. */
const padPresses: number[] = Array.from({ length: 16 }, () => 0);
let lastPoll = -1;
let maxGap = 0;

function frame(now: number): void {
  src.pollFrame!(now);
  srcB.pollFrame!(now); // every source is polled each frame, as the DeviceRegistry loop does (the manager polls once)
  polls++;
  if (lastPoll >= 0 && now - lastPoll > maxGap) maxGap = now - lastPoll;
  lastPoll = now;
  const slot = mgr.find('pad:1');
  if (slot) for (let b = 0; b < 16; b++) if ((slot.pressed & ~slot.prevPressed) & (1 << b)) padPresses[b]!++;
  if (polls % 2 === 1) { requestAnimationFrame(frame); return; }
  src.sample(frames[0]!, { tick: s.tick + 1, human: 0, side: 0, state: s, projector: null });
  srcB.sample(frameB, { tick: s.tick + 1, human: 1, side: 1, state: s, projector: null });
  const eb = frameB.buttons & ~prevB;
  for (const [n, b] of [...names, ['SPRINT', Btn.SPRINT] as [string, number]]) if (eb & b) pressesB[n] = pressesB[n]! + 1;
  prevB = frameB.buttons;
  sprintB = frameB.buttons & Btn.SPRINT ? 1 : 0;
  step(s, frames, ev);
  ticks++;
  const c = s.ctrl[0]!;
  const edge = c.buttons & ~c.prevButtons;
  for (const [n, b] of names) if (edge & b) simPresses[n] = simPresses[n]! + 1;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function set(b: number, on: boolean): void {
  w.__pad.buttons[b]!.pressed = on;
  w.__pad.buttons[b]!.value = on ? 1 : 0;
}

function setB(b: number, v: number): void {
  const p = w.__pads[1];
  if (!p) return;
  p.buttons[b]!.pressed = v > 0.5;
  p.buttons[b]!.value = v;
}

w.__h = {
  /** n quick taps of button b: down for downMs (timer), then up for upMs. */
  taps(b: number, n: number, downMs: number, upMs: number): Promise<void> {
    return new Promise((resolve) => {
      let k = 0;
      const one = (): void => {
        if (k >= n) { resolve(); return; }
        k++;
        set(b, true);
        setTimeout(() => { set(b, false); setTimeout(one, upMs); }, downMs);
      };
      one();
    });
  },
  set,
  setB,
  /** Plug in the second (non-standard) pad at index 1. */
  connectB(): void {
    w.__pads[1] = {
      id: GENERIC, index: 1, connected: true, mapping: '', timestamp: 0, axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 20 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
  },
  /** n quick taps of raw button b on the second pad. */
  tapsB(b: number, n: number, downMs: number, upMs: number): Promise<void> {
    return new Promise((resolve) => {
      let k = 0;
      const one = (): void => {
        if (k >= n) { resolve(); return; }
        k++;
        setB(b, 1);
        setTimeout(() => { setB(b, 0); setTimeout(one, upMs); }, downMs);
      };
      one();
    });
  },
  get pausesB() { return pausesB; },
  get presses2() { return { ...pressesB }; },
  get sprintB() { return sprintB; },
  get remappedB() { return srcB.remapped; },
  stick(x: number, y: number): void { w.__pad.axes[0] = x; w.__pad.axes[1] = y; },
  get pauses() { return pauses; },
  get ticks() { return ticks; },
  get presses() { return { ...simPresses }; },
  get padPresses() { return padPresses.slice(0, 4); },
  get maxGap() { return maxGap; },
  get controlledX() { const c = s.ctrl[0]!; return c.slot >= 0 ? s.players[c.slot]!.x : NaN; },
};
`;

interface H {
  taps(b: number, n: number, downMs: number, upMs: number): Promise<void>;
  set(b: number, on: boolean): void;
  stick(x: number, y: number): void;
  pauses: number;
  ticks: number;
  presses: Record<string, number>;
  padPresses: number[];
  maxGap: number;
  controlledX: number;
  setB(b: number, v: number): void;
  connectB(): void;
  tapsB(b: number, n: number, downMs: number, upMs: number): Promise<void>;
  pausesB: number;
  presses2: Record<string, number>;
  sprintB: number;
  remappedB: boolean;
}

let bundle = '';

test.beforeAll(async () => {
  const r = await build({
    stdin: { contents: HARNESS, resolveDir: ROOT, loader: 'ts', sourcefile: 'pad-02-harness.ts' },
    bundle: true, format: 'iife', write: false, target: 'es2022', define: { __DEV_BUILD__: 'true' }, logLevel: 'silent',
  });
  bundle = r.outputFiles[0]!.text;
});

test('mocked pad: every quick tap reaches the sim once, Options pauses once per press, the left stick moves P1', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(MOCK_PAD);
  await page.goto('about:blank');
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => (window as unknown as { __h: H }).__h?.ticks > 5);
  const h = (fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => {
    const o = (window as unknown as { __h: Record<string, unknown> }).__h;
    const v = o[f as string];
    return typeof v === 'function' ? (v as (...x: unknown[]) => unknown)(...(a as unknown[])) : v;
  }, [fn, args] as const);

  // Quick taps (25 ms down: shorter than a tick at two polls per tick) with long gaps: each one reaches the sim.
  await h('taps', 1, 6, 25, 80);
  // Fast taps: 50 ms down, 25 ms up (13 per second): the 25 ms up is shorter than a sample interval, so release +
  // re-press often happens between two samples; none merged or lost.
  await h('taps', 0, 8, 50, 25);
  await page.waitForTimeout(150);
  // Every press the pad reported to a poll reaches the sim exactly once. (A tap can only be invisible to polling
  // when the browser skipped frames for longer than it lasted: then no consumer can see it.)
  const seen = (await h('padPresses')) as number[];
  const gap = (await h('maxGap')) as number;
  expect(await h('presses')).toEqual({ PASS: seen[0], SHOOT: seen[1], LOB: 0, THROUGH: 0 });
  if (gap < 25) expect(seen.slice(0, 2)).toEqual([8, 6]);
  expect(seen[0]! + seen[1]!).toBeGreaterThanOrEqual(12);

  // Options: one pause per press.
  await h('taps', 9, 2, 25, 80);
  await page.waitForTimeout(100);
  expect(await h('pauses')).toBe(2);

  // Left stick right: the controlled player runs toward +x.
  const x0 = (await h('controlledX')) as number;
  await h('stick', 1, 0);
  await page.waitForTimeout(1500); // ~45 ticks at two polls per tick
  await h('stick', 0, 0);
  expect(((await h('controlledX')) as number) - x0).toBeGreaterThan(1);

  expect(errors).toEqual([]);
});

test('two pads: a non-standard pad joins mid-run and is read through its saved remap; nothing crosses to pad 1', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(MOCK_PAD);
  await page.goto('about:blank');
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => (window as unknown as { __h: H }).__h?.ticks > 5);
  const h = (fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => {
    const o = (window as unknown as { __h: Record<string, unknown> }).__h;
    const v = o[f as string];
    return typeof v === 'function' ? (v as (...x: unknown[]) => unknown)(...(a as unknown[])) : v;
  }, [fn, args] as const);

  await h('connectB');
  await page.waitForTimeout(100);
  expect(await h('remappedB')).toBe(true);
  // Remap: PASS on raw 3, SHOOT on raw 2, SPRINT on analogue raw 17 (past the 16 standard buttons), PAUSE on raw 9.
  await h('tapsB', 3, 4, 50, 60);
  await h('tapsB', 2, 2, 50, 60);
  await h('setB', 17, 0.25);
  await page.waitForTimeout(80);
  expect(await h('sprintB')).toBe(0);
  await h('setB', 17, 0.6);
  await page.waitForTimeout(80);
  expect(await h('sprintB')).toBe(1);
  await h('setB', 17, 0);
  await page.waitForTimeout(80);
  expect(await h('sprintB')).toBe(0);
  await h('tapsB', 9, 1, 50, 60);
  await page.waitForTimeout(80);
  expect(await h('presses2')).toEqual({ PASS: 4, SHOOT: 2, LOB: 0, THROUGH: 0, SPRINT: 1 });
  expect(await h('pausesB')).toBe(1);
  // Pad 1 (standard) saw none of it.
  expect(await h('presses')).toEqual({ PASS: 0, SHOOT: 0, LOB: 0, THROUGH: 0 });
  expect(await h('pauses')).toBe(0);
  expect(errors).toEqual([]);
});
