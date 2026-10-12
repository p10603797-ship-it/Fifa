/**
 * FND-05: keyboard InputSource mapping and the menu input repeat machine (node EventTarget, no DOM).
 */
import { describe, expect, it, vi } from 'vitest';
import { MenuAction, type FocusNavigator } from '../../src/contracts/app';
import { AXIS_SCALE, Btn, createInputFrame, type InputSampleContext } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createKeyboardSource, dirsToStick, DIR_DOWN, DIR_LEFT, DIR_RIGHT, DIR_UP } from '../../src/input/keyboard';
import {
  createMenuInput, createRepeatState, MENU_REPEAT_DELAY_MS, MENU_REPEAT_INTERVAL_MS, stepRepeat,
} from '../../src/input/menuInput';
import { createPadManager } from '../../src/input/pad/manager';
import { initMatch } from '../../src/sim/init';

function keyEvent(type: string, code: string, extra: Record<string, unknown> = {}): Event {
  const e = new Event(type);
  Object.defineProperty(e, 'code', { value: code });
  Object.defineProperty(e, 'repeat', { value: extra.repeat === true });
  if (extra.target) Object.defineProperty(e, 'target', { value: extra.target });
  return e;
}

class FakeDoc extends EventTarget {
  visibilityState = 'visible';
}

function setup() {
  const target = new EventTarget();
  const doc = new FakeDoc();
  const onPause = vi.fn();
  const src = createKeyboardSource({ onPause, target, doc });
  const s = initMatch(createMatchConfig()) as SimState;
  const ctx: InputSampleContext = { tick: 1, human: 0, side: 0, state: s, projector: null };
  const f = createInputFrame();
  const down = (code: string, extra: Record<string, unknown> = {}): void => { target.dispatchEvent(keyEvent('keydown', code, extra)); };
  const up = (code: string): void => { target.dispatchEvent(keyEvent('keyup', code)); };
  return { target, doc, onPause, src, ctx, f, down, up };
}

describe('FND-05 keyboard source', () => {
  it('WASD / arrows move in pitch space (D = +x, S = +z), diagonals normalised', () => {
    const { src, ctx, f, down, up } = setup();
    down('KeyD');
    src.sample(f, ctx);
    expect(f.mx).toBe(AXIS_SCALE);
    expect(f.mz).toBe(0);
    down('KeyS');
    src.sample(f, ctx);
    expect(f.mx).toBe(89);
    expect(f.mz).toBe(89);
    expect(f.mx * f.mx + f.mz * f.mz).toBeLessThanOrEqual(AXIS_SCALE * AXIS_SCALE);
    up('KeyD'); up('KeyS');
    down('ArrowUp');
    src.sample(f, ctx);
    expect(f.mz).toBe(-AXIS_SCALE);
    down('ArrowLeft');
    up('ArrowUp');
    src.sample(f, ctx);
    expect(f.mx).toBe(-AXIS_SCALE);
    up('ArrowLeft');
    src.sample(f, ctx);
    expect(f.mx).toBe(0);
    expect(f.mz).toBe(0);
    expect(src.kind).toBe('keyboard');
  });

  it('dirsToStick: opposite keys cancel', () => {
    const o = { x: 0, y: 0 };
    dirsToStick(DIR_LEFT | DIR_RIGHT, o);
    expect(o.x).toBe(0);
    dirsToStick(DIR_UP | DIR_RIGHT, o);
    expect(o.x).toBeCloseTo(Math.SQRT1_2, 9);
    expect(o.y).toBeCloseTo(-Math.SQRT1_2, 9);
    dirsToStick(DIR_DOWN, o);
    expect(o.y).toBe(1);
  });

  it('button table: J K U I Q E Shift C Space', () => {
    const { src, ctx, f, down, up } = setup();
    const table: [string, number][] = [
      ['KeyJ', Btn.PASS], ['KeyK', Btn.SHOOT], ['KeyU', Btn.LOB], ['KeyI', Btn.THROUGH], ['KeyQ', Btn.MOD_L],
      ['KeyE', Btn.MOD_R], ['ShiftLeft', Btn.SPRINT], ['ShiftRight', Btn.SPRINT], ['KeyC', Btn.SHIELD], ['Space', Btn.SKIP],
    ];
    for (const [code, bit] of table) {
      down(code);
      src.sample(f, ctx);
      expect(f.buttons).toBe(bit);
      src.sample(f, ctx);
      expect(f.buttons).toBe(bit); // held
      up(code);
      src.sample(f, ctx);
      expect(f.buttons).toBe(0);
    }
    // Both shifts: releasing one keeps sprint.
    down('ShiftLeft'); down('ShiftRight'); up('ShiftLeft');
    src.sample(f, ctx);
    expect(f.buttons).toBe(Btn.SPRINT);
    up('ShiftRight');
    src.sample(f, ctx);
    expect(f.buttons).toBe(0);
  });

  it('a tap between two ticks is latched once; auto-repeat keydown does not re-latch', () => {
    const { src, ctx, f, down, up } = setup();
    down('KeyJ');
    up('KeyJ');
    src.sample(f, ctx);
    expect(f.buttons).toBe(Btn.PASS);
    src.sample(f, ctx);
    expect(f.buttons).toBe(0);
    down('KeyK');
    src.sample(f, ctx);
    down('KeyK', { repeat: true });
    up('KeyK');
    src.sample(f, ctx);
    expect(f.buttons).toBe(0);
  });

  it('Esc and P pause; blur and hidden visibility release everything; typing in a field is ignored', () => {
    const { src, ctx, f, down, target, doc, onPause } = setup();
    down('Escape');
    down('KeyP');
    down('KeyP', { repeat: true });
    expect(onPause).toHaveBeenCalledTimes(2);
    down('KeyD'); down('ShiftLeft');
    target.dispatchEvent(new Event('blur'));
    src.sample(f, ctx);
    expect(f.mx).toBe(0);
    expect(f.buttons).toBe(0);
    down('KeyD'); down('KeyJ');
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    src.sample(f, ctx);
    expect(f.mx).toBe(0);
    expect(f.buttons).toBe(0);
    down('KeyD', { target: { tagName: 'input' } });
    src.sample(f, ctx);
    expect(f.mx).toBe(0);
    src.dispose();
    down('KeyD');
    src.sample(f, ctx);
    expect(f.mx).toBe(0);
  });

  it('releaseAll clears held keys', () => {
    const { src, ctx, f, down } = setup();
    down('KeyA'); down('KeyC');
    src.releaseAll();
    src.sample(f, ctx);
    expect(f.mx).toBe(0);
    expect(f.buttons).toBe(0);
  });
});

describe('FND-05 menu input', () => {
  it('repeat machine: fire on press, again after the initial delay, then every interval', () => {
    const st = createRepeatState();
    const fired: MenuAction[] = [];
    const fire = (a: MenuAction): void => { fired.push(a); };
    stepRepeat(st, 2, 0, fire); // DOWN
    expect(fired).toEqual([MenuAction.DOWN]);
    stepRepeat(st, 2, MENU_REPEAT_DELAY_MS - 1, fire);
    expect(fired.length).toBe(1);
    stepRepeat(st, 2, MENU_REPEAT_DELAY_MS, fire);
    expect(fired.length).toBe(2);
    stepRepeat(st, 2, MENU_REPEAT_DELAY_MS + MENU_REPEAT_INTERVAL_MS, fire);
    expect(fired.length).toBe(3);
    stepRepeat(st, 0, MENU_REPEAT_DELAY_MS + 2 * MENU_REPEAT_INTERVAL_MS, fire);
    expect(fired.length).toBe(3);
    stepRepeat(st, 8, 2000, fire); // RIGHT
    expect(fired[3]).toBe(MenuAction.RIGHT);
    // A fresh press edge fires even while the machine still thinks the key is held.
    stepRepeat(st, 8, 2010, fire, 8);
    expect(fired[4]).toBe(MenuAction.RIGHT);
    stepRepeat(st, 8, 2020, fire);
    expect(fired.length).toBe(5);
  });

  it('keyboard and pads drive the focus navigator; Options / P call onPause', () => {
    const target = new EventTarget();
    const list: unknown[] = [];
    const pads = createPadManager(() => list as Gamepad[]);
    const handled: MenuAction[] = [];
    const focus = { handle: (a: MenuAction) => { handled.push(a); } } as unknown as FocusNavigator;
    const onPause = vi.fn();
    const mi = createMenuInput({ focus, onPause, pads, target });
    target.dispatchEvent(keyEvent('keydown', 'ArrowDown'));
    mi.poll(16);
    target.dispatchEvent(keyEvent('keyup', 'ArrowDown'));
    target.dispatchEvent(keyEvent('keydown', 'Enter'));
    target.dispatchEvent(keyEvent('keyup', 'Enter'));
    mi.poll(32);
    target.dispatchEvent(keyEvent('keydown', 'Escape'));
    target.dispatchEvent(keyEvent('keydown', 'KeyE'));
    target.dispatchEvent(keyEvent('keydown', 'KeyP'));
    mi.poll(48);
    expect(handled).toEqual([MenuAction.DOWN, MenuAction.CONFIRM, MenuAction.BACK, MenuAction.TAB_NEXT]);
    // A direction tapped and released between two polls still moves focus exactly once.
    target.dispatchEvent(keyEvent('keydown', 'ArrowUp'));
    target.dispatchEvent(keyEvent('keyup', 'ArrowUp'));
    mi.poll(56);
    mi.poll(60);
    // Two taps inside one frame window: down, up, down, up before the poll that would see the release.
    target.dispatchEvent(keyEvent('keydown', 'ArrowUp'));
    mi.poll(64);
    target.dispatchEvent(keyEvent('keyup', 'ArrowUp'));
    target.dispatchEvent(keyEvent('keydown', 'ArrowUp'));
    target.dispatchEvent(keyEvent('keyup', 'ArrowUp'));
    mi.poll(68);
    expect(handled.slice(4)).toEqual([MenuAction.UP, MenuAction.UP, MenuAction.UP]);
    handled.splice(4, 3);
    expect(onPause).toHaveBeenCalledTimes(1);
    // Pad: B = back, LB = tab prev, D-pad up, Options.
    const btn = () => ({ pressed: false, touched: false, value: 0 });
    const pad = { id: 'Xbox pad 045e', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, btn) };
    list[0] = pad;
    pad.buttons[1] = { pressed: true, touched: true, value: 1 };
    mi.poll(64); // activates + BACK edge
    pad.buttons[1] = btn();
    pad.buttons[4] = { pressed: true, touched: true, value: 1 };
    pad.buttons[12] = { pressed: true, touched: true, value: 1 };
    mi.poll(80);
    pad.buttons[9] = { pressed: true, touched: true, value: 1 };
    mi.poll(96);
    expect(handled.slice(4)).toEqual([MenuAction.BACK, MenuAction.UP, MenuAction.TAB_PREV]);
    expect(onPause).toHaveBeenCalledTimes(2);
    mi.dispose();
  });
});
