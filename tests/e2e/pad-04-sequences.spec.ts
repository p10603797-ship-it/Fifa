/**
 * PAD-04 e2e: D-pad tactic sequences in a real browser with a mocked pad (navigator.getGamepads overridden by an init
 * script). The real pad manager (PAD-01) polls the mock once per requestAnimationFrame with the browser's own clock and
 * Gamepad event wiring; the real recogniser (src/input/pad/sequences.ts) is fed with updatePad() and sampled with
 * setContext() + applyTo() every frame, as the pad mapper does. Bundled for the page with esbuild (no app boot, no
 * WebGL: keeps the spec fast). Covers: a sequence -> one command, HUD pending state, interleaved face buttons, the
 * real-time window, and corner context (own corner vs the opponents').
 *
 *   npx vite build --outDir dist-e2e/pad-04 --emptyOutDir
 *   PW_DIST=dist-e2e/pad-04 PW_PORT=4204 npx playwright test tests/e2e/pad-04-sequences.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
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
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [window.__pad, null, null, null] });
`;

const HARNESS = `
import { createPadManager } from './src/input/pad/manager';
import { createPadSequences, getPadSequencePending } from './src/input/pad/sequences';
import { createInputFrame } from './src/contracts/input';

const w = window as unknown as Record<string, unknown> & { __pad: { buttons: { pressed: boolean; value: number }[] } };
const mgr = createPadManager();
const seq = createPadSequences();
// Minimal read-only state for the corner context: phase 5 = CORNER, restart kind 4 = CORNER.
const state = { match: { phase: 2, restart: { kind: 0, team: 0, taken: 0 } } };
const ctx = { state: state as never, side: 0, human: 0 };
const log: { cmd: number; arg: number; t: number }[] = [];
const f = createInputFrame();
let frames = 0;

function frame(now: number): void {
  frames++;
  mgr.poll(now);
  seq.updatePad(mgr.find('pad:1'), now);
  seq.setContext(ctx);
  f.cmd = 0; f.cmdArg = 0;
  seq.applyTo(f);
  if (f.cmd !== 0) log.push({ cmd: f.cmd, arg: f.cmdArg, t: now });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

w.__seq = {
  set(b: number, on: boolean): void { w.__pad.buttons[b]!.pressed = on; w.__pad.buttons[b]!.value = on ? 1 : 0; },
  corner(team: number): void {
    state.match.phase = team < 0 ? 2 : 5;
    state.match.restart.kind = team < 0 ? 0 : 4;
    state.match.restart.team = team < 0 ? 0 : team;
  },
  pending: () => seq.getPending(),
  hud: () => getPadSequencePending(0),
  get frames() { return frames; },
  log,
};
`;

interface SeqWin {
  __seq: {
    set(b: number, on: boolean): void; corner(team: number): void; pending(): string | null; hud(): string | null;
    frames: number; log: { cmd: number; arg: number; t: number }[];
  };
}

const B = { SOUTH: 0, EAST: 1, R2: 7, L3: 10, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const CMD = { TEAM_PRESS: 2, FOCUS_ATTACKING: 7, QUICK_SUB: 8, CORNER_NEAR_POST: 14 };

let bundle = '';

test.beforeAll(async () => {
  const r = await build({
    stdin: { contents: HARNESS, resolveDir: ROOT, loader: 'ts', sourcefile: 'pad-04-harness.ts' },
    bundle: true, format: 'iife', write: false, target: 'es2022', define: { __DEV_BUILD__: 'true' }, logLevel: 'silent',
  });
  bundle = r.outputFiles[0]!.text;
});

async function waitFrames(page: Page, n: number): Promise<void> {
  const f0 = await page.evaluate(() => (window as unknown as SeqWin).__seq.frames);
  await page.waitForFunction((f) => (window as unknown as SeqWin).__seq.frames >= f, f0 + n, { timeout: 10_000 });
}

async function tap(page: Page, b: number): Promise<void> {
  await page.evaluate((x) => (window as unknown as SeqWin).__seq.set(x, true), b);
  await waitFrames(page, 2);
  await page.evaluate((x) => (window as unknown as SeqWin).__seq.set(x, false), b);
  await waitFrames(page, 2);
}

const cmds = (page: Page): Promise<number[]> => page.evaluate(() => (window as unknown as SeqWin).__seq.log.map((x) => x.cmd));
const pending = (page: Page): Promise<[string | null, string | null]> =>
  page.evaluate(() => [(window as unknown as SeqWin).__seq.pending(), (window as unknown as SeqWin).__seq.hud()]);

test('mocked pad D-pad: sequences, HUD pending state, interleaved buttons, real-time window, corner context', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(MOCK_PAD);
  await page.goto('about:blank');
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => (window as unknown as SeqWin).__seq?.frames > 3);
  await tap(page, B.L3); // activate the pad (a button nothing maps)

  // Up, then left: team press, written into exactly one frame with cmdArg 0; the HUD saw the prompt in between.
  await tap(page, B.UP);
  expect(await pending(page)).toEqual(['tactics', 'tactics']);
  await tap(page, B.LEFT);
  expect(await cmds(page)).toEqual([CMD.TEAM_PRESS]);
  expect(await page.evaluate(() => (window as unknown as SeqWin).__seq.log[0]!.arg)).toBe(0);
  expect(await pending(page)).toEqual([null, null]);

  // Interleaved face buttons and a trigger between right and right: attacking focus.
  await tap(page, B.RIGHT);
  await tap(page, B.SOUTH);
  await tap(page, B.R2);
  await tap(page, B.EAST);
  await tap(page, B.RIGHT);
  expect(await cmds(page)).toEqual([CMD.TEAM_PRESS, CMD.FOCUS_ATTACKING]);

  // The window runs on the browser clock: down, wait past T_PAD.dpadSequenceMs (1200 ms), down -> no quick sub.
  await tap(page, B.DOWN);
  expect(await pending(page)).toEqual(['sub', 'sub']);
  await page.waitForFunction(() => (window as unknown as SeqWin).__seq.hud() === null, null, { timeout: 5_000 });
  await page.waitForTimeout(100);
  await tap(page, B.DOWN);
  expect(await cmds(page)).toEqual([CMD.TEAM_PRESS, CMD.FOCUS_ATTACKING]);
  expect(await pending(page)).toEqual(['sub', 'sub']); // the late press opened a fresh sequence
  await page.waitForFunction(() => (window as unknown as SeqWin).__seq.hud() === null, null, { timeout: 5_000 });

  // Own corner: down, down is the near-post routine. Opponents' corner: down, down is a quick sub.
  await page.evaluate(() => (window as unknown as SeqWin).__seq.corner(0));
  await waitFrames(page, 2);
  await tap(page, B.DOWN);
  expect(await pending(page)).toEqual(['corner', 'corner']);
  await tap(page, B.DOWN);
  await page.evaluate(() => (window as unknown as SeqWin).__seq.corner(1));
  await waitFrames(page, 2);
  await tap(page, B.DOWN);
  await tap(page, B.DOWN);
  expect(await cmds(page)).toEqual([CMD.TEAM_PRESS, CMD.FOCUS_ATTACKING, CMD.CORNER_NEAR_POST, CMD.QUICK_SUB]);

  expect(errors).toEqual([]);
});
