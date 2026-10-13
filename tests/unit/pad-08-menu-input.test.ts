/**
 * PAD-08: menu input (src/input/menuInput.ts): pads + keyboard -> MenuAction, repeat timing (300 ms delay, 120 ms
 * interval) on a fake clock, press order, stick hysteresis, several pads, custom remaps, stuck-repeat guards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MenuAction, type FocusNavigator } from '../../src/contracts/app';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import {
  createMenuInput, createRepeatState, MENU_KEY_ACTIONS, MENU_REPEAT_DELAY_MS, MENU_REPEAT_INTERVAL_MS,
  MENU_STICK_RELEASE, MENU_STICK_THRESHOLD, stepRepeat, stickMenuDir,
} from '../../src/input/menuInput';
import { createPadManager, PadButton } from '../../src/input/pad/manager';
import { PAD_ACTION_COUNT, PadAction } from '../../src/input/pad/mapper';

interface KeyExtra { repeat?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; target?: unknown }
function kev(type: string, code: string, extra: KeyExtra = {}): Event {
  const e = new Event(type, { cancelable: true });
  Object.defineProperty(e, 'code', { value: code });
  Object.defineProperty(e, 'repeat', { value: extra.repeat === true });
  Object.defineProperty(e, 'ctrlKey', { value: extra.ctrlKey === true });
  Object.defineProperty(e, 'altKey', { value: extra.altKey === true });
  Object.defineProperty(e, 'metaKey', { value: extra.metaKey === true });
  if (extra.target) Object.defineProperty(e, 'target', { value: extra.target });
  return e;
}

interface MockPad {
  id: string; index: number; connected: boolean; mapping: string; timestamp: number; axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
}
function mockPad(index: number, mapping = 'standard', id = `Mock pad ${index} (STANDARD GAMEPAD Vendor: 045e Product: 0b13)`): MockPad {
  return {
    id, index, connected: true, mapping, timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 20 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
}
function setBtn(p: MockPad, b: number, on: boolean): void {
  p.buttons[b] = { pressed: on, touched: on, value: on ? 1 : 0 };
}

class FakeDoc extends EventTarget {
  visibilityState = 'visible';
}

const live: { dispose(): void }[] = [];
afterEach(() => { for (const m of live.splice(0)) m.dispose(); });

function rig(settings: Settings | null = null) {
  const target = new EventTarget();
  const doc = new FakeDoc();
  const list: (MockPad | null)[] = [null, null, null, null];
  const pads = createPadManager(() => list as unknown as Gamepad[]);
  const handled: MenuAction[] = [];
  const focus = { handle: (a: MenuAction) => { handled.push(a); } } as unknown as FocusNavigator;
  const onPause = vi.fn();
  const mi = createMenuInput({ focus, onPause, pads, target, doc, settings: settings ? { get: () => settings } : null });
  live.push(mi);
  let t = 0;
  const key = (type: 'keydown' | 'keyup', code: string, extra: KeyExtra = {}): void => { target.dispatchEvent(kev(type, code, extra)); };
  const press = (code: string, extra: KeyExtra = {}): void => { key('keydown', code, extra); key('keyup', code, extra); };
  /** Advance the fake clock and poll (one animation frame). */
  const frame = (ms = 16): void => { t += ms; mi.poll(t); };
  /** Hold for `ms` at `hz` frames per second. */
  const run = (ms: number, hz = 60): void => { const dt = 1000 / hz; const end = t + ms; while (t + dt <= end + 1e-9) frame(dt); };
  return { target, doc, list, pads, handled, onPause, mi, key, press, frame, run, now: () => t };
}

describe('PAD-08 menu repeat timing (fake clock)', () => {
  it('initial delay 300 ms, then every 120 ms', () => {
    expect(MENU_REPEAT_DELAY_MS).toBe(300);
    expect(MENU_REPEAT_INTERVAL_MS).toBe(120);
    const st = createRepeatState();
    const times: number[] = [];
    for (let t = 0; t <= 800; t += 1) stepRepeat(st, 2, t, () => { times.push(t); });
    expect(times).toEqual([0, 300, 420, 540, 660, 780]);
  });

  it('the same count at 30, 60, 120 and 144 Hz for any hold length (no drift with the frame rate)', () => {
    const count = (hz: number, holdMs: number): number => {
      const st = createRepeatState();
      let n = 0;
      const dt = 1000 / hz;
      for (let i = 0; i * dt <= holdMs; i++) stepRepeat(st, 1, i * dt, () => { n++; });
      return n;
    };
    for (const ms of [0, 100, 299, 300, 305, 419, 420, 1000, 1234, 3000, 10_000]) {
      const ref = 1 + (ms >= 300 ? 1 + Math.floor((ms - 300) / 120) : 0);
      for (const hz of [60, 120, 144]) expect(count(hz, ms), `${hz} Hz ${ms} ms`).toBeLessThanOrEqual(ref);
      expect(count(60, ms), `60 vs 120 Hz at ${ms} ms`).toBe(count(120, ms));
    }
    // A long hold at a low frame rate catches up by at most one repeat per frame (no burst after a stall).
    const st = createRepeatState();
    let n = 0;
    stepRepeat(st, 1, 0, () => { n++; });
    stepRepeat(st, 1, 5000, () => { n++; });
    expect(n).toBe(2);
  });

  it('a rAF stamp a hair early (sub-ms jitter) still fires on that frame', () => {
    const st = createRepeatState();
    let n = 0;
    stepRepeat(st, 4, 0, () => { n++; });
    stepRepeat(st, 4, MENU_REPEAT_DELAY_MS - 0.2, () => { n++; });
    expect(n).toBe(2);
  });

  it('keyboard: a held arrow repeats 300 ms after the press, then every 120 ms; release stops it', () => {
    const r = rig();
    r.key('keydown', 'ArrowDown');
    r.frame(16); // pressed at t = 16
    expect(r.handled).toEqual([MenuAction.DOWN]);
    r.frame(299);
    expect(r.handled.length).toBe(1);
    r.frame(1); // t = 316
    expect(r.handled.length).toBe(2);
    r.frame(119);
    expect(r.handled.length).toBe(2);
    r.frame(1); // t = 436
    expect(r.handled.length).toBe(3);
    // Browser auto-repeat keydowns never add actions of their own.
    for (let i = 0; i < 10; i++) r.key('keydown', 'ArrowDown', { repeat: true });
    r.frame(1);
    expect(r.handled.length).toBe(3);
    r.key('keyup', 'ArrowDown');
    r.run(1000);
    expect(r.handled.length).toBe(3);
  });
});

describe('PAD-08 menu keyboard', () => {
  it('key table: arrows / WASD, Enter / Space / J, Escape / Backspace / K, Q / PageUp, E / PageDown, P', () => {
    const r = rig();
    for (const [code, a] of Object.entries(MENU_KEY_ACTIONS)) {
      r.handled.length = 0;
      r.press(code);
      r.frame();
      if (a === MenuAction.START) expect(r.handled, code).toEqual([]);
      else expect(r.handled, code).toEqual([a]);
    }
    expect(r.onPause).toHaveBeenCalledTimes(1);
  });

  it('every press is one action in press order, even several inside one frame', () => {
    const r = rig();
    r.press('Enter');
    r.press('ArrowDown');
    r.press('ArrowDown');
    r.press('KeyE');
    r.frame();
    expect(r.handled).toEqual([MenuAction.CONFIRM, MenuAction.DOWN, MenuAction.DOWN, MenuAction.TAB_NEXT]);
  });

  it('typing in a text field is ignored except Escape; Ctrl / Alt / Cmd combos are browser shortcuts', () => {
    const r = rig();
    const input = { tagName: 'INPUT' };
    r.press('KeyS', { target: input });
    r.press('Enter', { target: input });
    r.press('Escape', { target: input });
    r.press('ArrowUp', { target: { tagName: 'INPUT', type: 'range' } }); // a focused slider is not a text field
    r.press('KeyQ', { ctrlKey: true });
    r.press('ArrowLeft', { altKey: true });
    r.press('KeyP', { metaKey: true });
    r.frame();
    expect(r.handled).toEqual([MenuAction.BACK, MenuAction.UP]);
    expect(r.onPause).not.toHaveBeenCalled();
  });

  it('mapped keys are preventDefault-ed (no page scroll / native slider step); text fields and shortcuts are not', () => {
    const r = rig();
    const fire = (code: string, extra: KeyExtra = {}): boolean => {
      const e = kev('keydown', code, extra);
      r.target.dispatchEvent(e);
      r.key('keyup', code);
      return e.defaultPrevented;
    };
    expect(['ArrowDown', 'Space', 'PageDown', 'Enter', 'KeyK'].map((c) => fire(c))).toEqual([true, true, true, true, true]);
    expect([fire('ArrowDown', { target: { tagName: 'INPUT' } }), fire('KeyQ', { ctrlKey: true }), fire('KeyZ')]).toEqual([false, false, false]);
  });

  it('Glitch "runaway menu repeat after a tab switch": blur, a hidden page or the release of Cmd stop a held key', () => {
    for (const lose of ['blur', 'hidden', 'meta'] as const) {
      const r = rig();
      r.key('keydown', 'KeyS');
      r.frame();
      if (lose === 'blur') r.target.dispatchEvent(new Event('blur'));
      if (lose === 'hidden') { r.doc.visibilityState = 'hidden'; r.doc.dispatchEvent(new Event('visibilitychange')); }
      if (lose === 'meta') r.key('keyup', 'MetaLeft'); // macOS: the S keyup never comes
      r.run(2000);
      expect(r.handled, lose).toEqual([MenuAction.DOWN]);
    }
  });
});

describe('PAD-08 menu pads', () => {
  it('Cross / Circle / L1 / R1 / D-pad map to menu actions; Options pauses; Home and Share do nothing', () => {
    const r = rig();
    const pad = mockPad(0);
    r.list[0] = pad;
    const cases: [number, MenuAction | 'pause' | null][] = [
      [PadButton.SOUTH, MenuAction.CONFIRM], [PadButton.EAST, MenuAction.BACK], [PadButton.L1, MenuAction.TAB_PREV],
      [PadButton.R1, MenuAction.TAB_NEXT], [PadButton.DPAD_UP, MenuAction.UP], [PadButton.DPAD_DOWN, MenuAction.DOWN],
      [PadButton.DPAD_LEFT, MenuAction.LEFT], [PadButton.DPAD_RIGHT, MenuAction.RIGHT], [PadButton.START, 'pause'],
      [PadButton.WEST, null], [PadButton.NORTH, null], [16, null], [17, null],
    ];
    for (const [b, want] of cases) {
      r.handled.length = 0;
      r.onPause.mockClear();
      setBtn(pad, b, true);
      r.frame();
      setBtn(pad, b, false);
      r.frame();
      if (want === 'pause') {
        expect(r.onPause, `button ${b}`).toHaveBeenCalledTimes(1);
        expect(r.handled).toEqual([]);
      } else {
        expect(r.handled, `button ${b}`).toEqual(want === null ? [] : [want]);
      }
    }
  });

  it('a held D-pad direction repeats on the same schedule as a key', () => {
    const r = rig();
    const pad = mockPad(0);
    r.list[0] = pad;
    setBtn(pad, PadButton.DPAD_RIGHT, true);
    r.frame();
    r.run(300 + 120 * 2 + 20); // repeats at +300, +420, +540
    expect(r.handled).toEqual([MenuAction.RIGHT, MenuAction.RIGHT, MenuAction.RIGHT, MenuAction.RIGHT]);
    setBtn(pad, PadButton.DPAD_RIGHT, false);
    r.run(1000);
    expect(r.handled.length).toBe(4);
  });

  it('left stick: dominant axis past 0.5, held until it falls below 0.35 (no chatter near the threshold)', () => {
    expect([MENU_STICK_THRESHOLD, MENU_STICK_RELEASE]).toEqual([0.5, 0.35]);
    expect(stickMenuDir(-1, 0, 0.6)).toBe(MenuAction.DOWN);
    expect(stickMenuDir(-1, 0.45, 0.4)).toBe(-1);
    expect(stickMenuDir(-1, 0.7, 0.6)).toBe(MenuAction.RIGHT); // diagonal: one direction only
    expect(stickMenuDir(-1, -0.6, 0.7)).toBe(MenuAction.DOWN);
    expect(stickMenuDir(MenuAction.DOWN, 0, 0.4)).toBe(MenuAction.DOWN); // hysteresis
    expect(stickMenuDir(MenuAction.DOWN, 0, 0.3)).toBe(-1);
    expect(stickMenuDir(MenuAction.UP, 0.8, -0.3)).toBe(MenuAction.RIGHT); // rolled to the side
    expect(stickMenuDir(-1, Number.NaN, -0.9)).toBe(MenuAction.UP);

    const r = rig();
    const pad = mockPad(0);
    r.list[0] = pad;
    setBtn(pad, PadButton.SOUTH, true); r.frame(); setBtn(pad, PadButton.SOUTH, false); r.frame(); // activate
    r.handled.length = 0;
    // A stick wobbling around the threshold (raw values before the 0.15 / 0.95 dead zone).
    for (let i = 0; i < 30; i++) {
      pad.axes[1] = i % 2 === 0 ? 0.62 : 0.5;
      r.frame(8);
    }
    expect(r.handled).toEqual([MenuAction.DOWN]);
    pad.axes[1] = 0;
    r.frame();
    pad.axes[0] = -1;
    r.frame();
    expect(r.handled).toEqual([MenuAction.DOWN, MenuAction.LEFT]);
  });

  it('every connected pad counts: two pads merged, a second pad press is its own action', () => {
    const r = rig();
    const a = mockPad(0);
    const b = mockPad(1, 'standard', 'Second pad (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)');
    r.list[0] = a;
    r.list[1] = b;
    setBtn(a, PadButton.DPAD_DOWN, true);
    r.frame();
    setBtn(b, PadButton.DPAD_DOWN, true); // the other pad presses the same direction: a second press
    setBtn(b, PadButton.SOUTH, true);
    r.frame();
    expect(r.handled).toEqual([MenuAction.DOWN, MenuAction.DOWN, MenuAction.CONFIRM]);
  });

  it('a pad that disconnects mid-hold stops repeating at once', () => {
    const r = rig();
    const pad = mockPad(0);
    r.list[0] = pad;
    setBtn(pad, PadButton.DPAD_UP, true);
    r.frame();
    r.list[0] = null;
    r.run(2000);
    expect(r.handled).toEqual([MenuAction.UP]);
  });

  it('Glitch "double confirm": polling twice in one frame (same timestamp) never repeats a pad press', () => {
    const r = rig();
    const pad = mockPad(0);
    r.list[0] = pad;
    setBtn(pad, PadButton.SOUTH, true);
    r.frame();
    r.mi.poll(r.now());
    r.mi.poll(r.now());
    expect(r.handled).toEqual([MenuAction.CONFIRM]);
  });

  it('a non-standard pad is read through its saved remap (PAD-07): raw buttons past 15 work too', () => {
    const settings = createDefaultSettings();
    const id = 'Odd pad (Vendor: 1234 Product: 5678)';
    const remap = new Array<number>(PAD_ACTION_COUNT).fill(-1);
    remap[PadAction.PASS] = 3;
    remap[PadAction.SHOOT] = 2;
    remap[PadAction.DPAD_DOWN] = 18;
    remap[PadAction.PAUSE] = 11;
    settings.controls.pad.remaps[id] = remap;
    const r = rig(settings);
    const pad = mockPad(0, '', id);
    r.list[0] = pad;
    const tap = (b: number): void => { setBtn(pad, b, true); r.frame(); setBtn(pad, b, false); r.frame(); };
    tap(0); // activates the pad; raw 0 is not bound in the remap
    tap(3);
    tap(2);
    tap(18);
    tap(11);
    expect(r.handled).toEqual([MenuAction.CONFIRM, MenuAction.BACK, MenuAction.DOWN]);
    expect(r.onPause).toHaveBeenCalledTimes(1);
    // Without settings (or for a standard pad) the standard positions apply.
    const s = rig();
    const std = mockPad(0, '', id);
    s.list[0] = std;
    setBtn(std, 0, true); s.frame();
    expect(s.handled).toEqual([MenuAction.CONFIRM]);
  });
});
