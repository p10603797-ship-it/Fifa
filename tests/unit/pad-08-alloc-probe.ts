/**
 * [PAD-08] Allocation probe for the per-frame / per-tick input paths (run by tests/unit/pad-08-alloc.test.ts in a
 * child process): node --expose-gc --import tsx tests/unit/pad-08-alloc-probe.ts [n]
 * Prints JSON { <path>: bytes allocated per call }: keyboard pollFrame + sample idle, with keys held (movement,
 * sprint, right stick, D-pad, modifier) and with diagonal movement; menu input poll with an idle pad and with a held
 * D-pad direction (repeat machine).
 */
import '../../tools/lib/env';
import { MenuAction, type FocusNavigator } from '../../src/contracts/app';
import { ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { createInputFrame, type InputSampleContext } from '../../src/contracts/input';
import { createMatchConfig } from '../../src/contracts/state';
import { createKeyboardSource } from '../../src/input/keyboard';
import { createMenuInput } from '../../src/input/menuInput';
import { createPadManager, PadButton } from '../../src/input/pad/manager';
import { initMatch } from '../../src/sim/init';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');
const n = Number(process.argv[2] ?? 20000);

const cfg = createMatchConfig();
cfg.humans = [
  { kind: ControllerKind.HUMAN, side: 0, assist: 0, autoSwitch: 0, fastPower: 0 },
  { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 },
];
const s = initMatch(cfg);
s.match.phase = MatchPhase.IN_PLAY;
s.ctrl[0]!.slot = 9;
s.players[9]!.ctrl = 0;
s.ball.owner = 9;
const ctx: InputSampleContext = { tick: 1, human: 0, side: 0, state: s, projector: null };
const out = createInputFrame();

function key(target: EventTarget, type: string, code: string): void {
  const e = new Event(type);
  Object.defineProperty(e, 'code', { value: code });
  target.dispatchEvent(e);
}

let t = 1000;
function measure(fn: () => void): number {
  for (let i = 0; i < 40000; i++) fn();
  let best = Infinity;
  for (let pass = 0; pass < 3; pass++) {
    gc!();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) fn();
    const b = (process.memoryUsage().heapUsed - h0) / n;
    if (b < best) best = b;
  }
  return best;
}

const result: Record<string, number> = {};

const kt = new EventTarget();
const kb = createKeyboardSource({ onPause: () => {}, target: kt, doc: new EventTarget(), now: () => t });
const kbTick = (): void => { t += 16; kb.pollFrame(t); kb.sample(out, ctx); };
result.keyboardIdle = measure(kbTick);
for (const code of ['KeyD', 'ShiftLeft', 'Numpad6', 'Digit1', 'KeyQ']) key(kt, 'keydown', code);
result.keyboardHeld = measure(kbTick);
// Diagonal movement: non-integer stick values reach the PAD-05 right-stick tracker (left stick for drag-back), whose
// closure variables box doubles (see the PAD-08 report: CR to PAD-05). Measured separately.
key(kt, 'keydown', 'KeyW');
result.keyboardDiagonal = measure(kbTick);

const list: unknown[] = [{
  id: 'Probe pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0.2, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
}];
const pads = createPadManager(() => list as Gamepad[], { eventTarget: null });
let actions = 0;
const focus = { handle: (a: MenuAction) => { if (a >= 0) actions++; } } as unknown as FocusNavigator;
const mi = createMenuInput({ focus, onPause: () => {}, pads, target: new EventTarget(), doc: new EventTarget() });
const pad = list[0] as { buttons: { pressed: boolean; value: number }[] };
pad.buttons[PadButton.SOUTH] = { pressed: true, value: 1 } as never;
mi.poll(t += 16);
pad.buttons[PadButton.SOUTH] = { pressed: false, value: 0 } as never;
const menuTick = (): void => { t += 16; mi.poll(t); };
result.menuIdle = measure(menuTick);
pad.buttons[PadButton.DPAD_DOWN] = { pressed: true, value: 1 } as never;
result.menuRepeat = measure(menuTick);
if (actions < 10) throw new Error('probe: the held D-pad did not repeat');
console.log(JSON.stringify(result));
