/**
 * REVIEW of FND-05 input skeleton (independent reviewer, not the builder).
 * Adversarial unit tests over the REAL pointer manager (fake DOM made of Node EventTargets), touch controls and
 * mapper, keyboard source, pad manager/source, menu repeat and the device registry:
 *  - pointercancel / lostpointercapture / blur / visibilitychange mid-hold, id reuse, > MAX_POINTERS, dispose;
 *  - a cancelled touch-down must not fire an action (contracts/touch.ts TouchEdge.CANCEL);
 *  - overlapping keys (WASD + arrows) must not drop a held direction;
 *  - pad disconnect mid-hold, pause-menu presses leaking into the first tick after resume, 120 Hz latching;
 *  - menu key repeat identical at 60 and 120 Hz.
 */
import { describe, expect, it, vi } from 'vitest';
import { Btn, createInputFrame, type InputSampleContext } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createTouchIntentState, TouchButtonId, TouchEdge, type TouchControl } from '../../src/contracts/touch';
import { createDefaultSettings } from '../../src/contracts/settings';
import { MenuAction, type PlatformInfo, type SettingsStore } from '../../src/contracts/app';
import { createStick } from '../../src/input/touch/stick';
import { createTouchButton } from '../../src/input/touch/button';
import { createTouchMapper } from '../../src/input/touch/mapper';
import { createPointerManager, MAX_POINTERS } from '../../src/input/touch/pointers';
import { createKeyboardSource } from '../../src/input/keyboard';
import { createPadManager, PadButton } from '../../src/input/pad/manager';
import { createPadSource } from '../../src/input/pad/mapper';
import { createRepeatState, stepRepeat, MENU_REPEAT_DELAY_MS } from '../../src/input/menuInput';
import { createDeviceRegistry } from '../../src/input/devices';
import { MatchPhase } from '../../src/contracts/enums';
import { initMatch } from '../../src/sim/init';

// ------------------------------------------------------------------ fakes

class FakeEl extends EventTarget {
  readonly captured = new Set<number>();
  setPointerCapture(id: number): void { this.captured.add(id); }
  hasPointerCapture(id: number): boolean { return this.captured.has(id); }
  releasePointerCapture(id: number): void { this.captured.delete(id); }
}
class FakeDoc extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
}

function pev(type: string, id: number, x = 0, y = 0, extra: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { pointerId: id, clientX: x, clientY: y, pointerType: 'touch', button: 0, ...extra });
  return e;
}
function kev(type: string, code: string, extra: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { code, repeat: false, ...extra });
  return e;
}

/**
 * A live open-play state with human 0's side on the ball. INT-B: TCH-04/07 treat PRE_MATCH (a fresh initMatch) as a
 * cut-scene (cluster HIDDEN: every touch sends SKIP), so input expectations need play to be live.
 */
function liveState(): SimState {
  const s = initMatch(createMatchConfig()) as SimState;
  s.match.phase = MatchPhase.IN_PLAY;
  const slot = s.ctrl[0]!.slot >= 0 ? s.ctrl[0]!.slot : 9;
  s.ball.owner = slot;
  return s;
}

function sampleCtx(): InputSampleContext {
  return { tick: 1, human: 0, side: 0, state: liveState(), projector: null };
}

/** Real stick + SPRINT + SHOOT + mapper behind the real pointer manager. */
function touchRig() {
  const el = new FakeEl();
  const win = new EventTarget();
  const doc = new FakeDoc();
  const state = createTouchIntentState();
  let t = 0;
  const stick = createStick({ state, zone: (x) => x < 500, radius: 70 });
  const sprint = createTouchButton({ state, id: TouchButtonId.SPRINT_SKILL, geom: { cx: 1100, cy: 720, r: 48 } });
  const shoot = createTouchButton({ state, id: TouchButtonId.SHOOT, geom: { cx: 1100, cy: 580, r: 38 } });
  const controls: TouchControl[] = [shoot, sprint, stick];
  const onChange = vi.fn();
  const pm = createPointerManager({
    el: el as unknown as HTMLElement, controls, onChange, now: () => t,
    win: win as unknown as Window, doc: doc as unknown as Document,
  });
  const mapper = createTouchMapper(state);
  const ctx = sampleCtx();
  const out = createInputFrame();
  const sample = () => { mapper.sample(out, ctx); return out; };
  const advance = (ms: number) => { t += ms; };
  return { el, win, doc, state, pm, sample, advance, onChange, stick, sprint, shoot };
}

// ------------------------------------------------------------------ touch lifecycle

describe('REVIEW FND-05 touch: pointer lifecycle through the real pointer manager', () => {
  it('pointercancel mid-hold releases the stick and SPRINT; the next tick has no movement and no SPRINT', () => {
    const r = touchRig();
    r.el.dispatchEvent(pev('pointerdown', 1, 200, 500));
    r.el.dispatchEvent(pev('pointermove', 1, 270, 500));
    r.el.dispatchEvent(pev('pointerdown', 2, 1100, 720));
    let f = r.sample();
    expect(f.mx).toBeGreaterThan(100);
    expect(f.buttons & Btn.SPRINT).toBe(Btn.SPRINT);
    expect(r.pm.active).toBe(2);
    r.el.dispatchEvent(pev('pointercancel', 1));
    r.el.dispatchEvent(pev('pointercancel', 2));
    expect(r.pm.active).toBe(0);
    f = r.sample();
    expect(f.mx).toBe(0);
    expect(f.mz).toBe(0);
    expect(f.buttons).toBe(0);
    // A late pointerup for a cancelled pointer is ignored (no re-press, no throw).
    r.el.dispatchEvent(pev('pointerup', 2, 1100, 720));
    expect(r.sample().buttons).toBe(0);
  });

  it('lostpointercapture without any pointerup releases the control', () => {
    const r = touchRig();
    r.el.dispatchEvent(pev('pointerdown', 5, 100, 400));
    r.el.dispatchEvent(pev('pointermove', 5, 100, 300));
    expect(r.state.stickActive).toBe(true);
    r.el.dispatchEvent(pev('lostpointercapture', 5));
    expect(r.state.stickActive).toBe(false);
    expect(r.sample().mz).toBe(0);
  });

  it('window blur and visibilitychange(hidden) release every held input; visibilitychange(visible) does not', () => {
    const r = touchRig();
    r.el.dispatchEvent(pev('pointerdown', 1, 200, 500));
    r.el.dispatchEvent(pev('pointermove', 1, 200, 430));
    r.el.dispatchEvent(pev('pointerdown', 2, 1100, 720));
    r.doc.visibilityState = 'visible';
    r.doc.dispatchEvent(new Event('visibilitychange'));
    expect(r.state.stickActive).toBe(true);
    expect(r.state.held).not.toBe(0);
    r.doc.visibilityState = 'hidden';
    r.doc.dispatchEvent(new Event('visibilitychange'));
    expect(r.state.stickActive).toBe(false);
    expect(r.state.held).toBe(0);
    expect(r.pm.active).toBe(0);
    expect(r.el.captured.size).toBe(0);
    // Fresh hold, then blur.
    r.doc.visibilityState = 'visible';
    r.el.dispatchEvent(pev('pointerdown', 3, 1100, 720));
    expect(r.state.held & (1 << TouchButtonId.SPRINT_SKILL)).not.toBe(0);
    r.win.dispatchEvent(new Event('blur'));
    expect(r.state.held).toBe(0);
    r.sample(); // drain
    expect(r.sample().buttons).toBe(0);
  });

  it('a pointer id reused after a cancel works again (no stale slot)', () => {
    const r = touchRig();
    r.el.dispatchEvent(pev('pointerdown', 9, 200, 500));
    r.el.dispatchEvent(pev('pointercancel', 9));
    r.el.dispatchEvent(pev('pointerdown', 9, 200, 500));
    r.el.dispatchEvent(pev('pointermove', 9, 270, 500));
    expect(r.state.stickActive).toBe(true);
    expect(r.sample().mx).toBeGreaterThan(100);
  });

  it(`more than MAX_POINTERS (${MAX_POINTERS}) simultaneous pointers do not throw; the extra one is ignored`, () => {
    const r = touchRig();
    expect(() => {
      for (let i = 0; i < MAX_POINTERS + 2; i++) r.el.dispatchEvent(pev('pointerdown', 100 + i, 50 + i, 400));
    }).not.toThrow();
    expect(r.pm.active).toBeLessThanOrEqual(MAX_POINTERS);
    for (let i = 0; i < MAX_POINTERS + 2; i++) r.el.dispatchEvent(pev('pointerup', 100 + i, 50 + i, 400));
    expect(r.pm.active).toBe(0);
    expect(r.state.stickActive).toBe(false);
  });

  it('dispose() removes every listener (events afterwards change nothing)', () => {
    const r = touchRig();
    r.pm.dispose();
    r.el.dispatchEvent(pev('pointerdown', 1, 200, 500));
    r.el.dispatchEvent(pev('pointermove', 1, 270, 500));
    expect(r.state.stickActive).toBe(false);
    expect(r.pm.active).toBe(0);
  });

  it('a pause mid-hold (releaseAll) and the later pointerup do not re-press anything', () => {
    const r = touchRig();
    r.el.dispatchEvent(pev('pointerdown', 2, 1100, 720));
    r.pm.releaseAll();
    expect(r.state.held).toBe(0);
    r.sample(); // the tick right after the pause drains the queue
    r.el.dispatchEvent(pev('pointerup', 2, 1100, 720));
    expect(r.sample().buttons).toBe(0);
  });

  it('a SHOOT touch-down that the system cancels before the next tick must not fire SHOOT (TouchEdge.CANCEL = release without action)', () => {
    // contracts/touch.ts: CANCEL "Pointer cancelled (system gesture, blur) — treat as release without action".
    // An iPadOS multitasking swipe that starts on the SHOOT button produces pointerdown then pointercancel within a
    // few ms; the mapper latches the DOWN from the queue regardless of the CANCEL that followed it.
    const r = touchRig();
    r.sample(); // tick N
    r.el.dispatchEvent(pev('pointerdown', 4, 1100, 580));
    r.advance(5);
    r.el.dispatchEvent(pev('pointercancel', 4));
    const f = r.sample(); // tick N + 1
    expect(r.state.held).toBe(0);
    expect(f.buttons & Btn.SHOOT).toBe(0);
  });

  it('a real quick tap (down + up between ticks) is still reported for one tick', () => {
    const r = touchRig();
    r.sample();
    r.el.dispatchEvent(pev('pointerdown', 4, 1100, 580));
    r.advance(30);
    r.el.dispatchEvent(pev('pointerup', 4, 1100, 580));
    expect(r.sample().buttons & Btn.SHOOT).toBe(Btn.SHOOT);
    expect(r.sample().buttons & Btn.SHOOT).toBe(0);
    // The queue records TAP for TCH-07 (outside the double-tap window).
    r.advance(1000);
    r.el.dispatchEvent(pev('pointerdown', 4, 1100, 580));
    r.el.dispatchEvent(pev('pointerup', 4, 1100, 580));
    let tap = false;
    for (let i = 0; i < r.state.buttonEventCount; i++) if (r.state.buttonEvents[i]!.edge === TouchEdge.TAP) tap = true;
    expect(tap).toBe(true);
  });
});

// ------------------------------------------------------------------ keyboard

function kbRig() {
  const target = new EventTarget();
  const doc = new FakeDoc();
  const onPause = vi.fn();
  const kb = createKeyboardSource({ onPause, target, doc: doc as unknown as EventTarget & { visibilityState?: string } });
  const ctx = sampleCtx();
  const out = createInputFrame();
  const sample = () => { kb.sample(out, ctx); return out; };
  return { target, doc, kb, sample, onPause };
}

describe('REVIEW FND-05 keyboard', () => {
  it('holding KeyD and ArrowRight, then releasing ArrowRight, keeps moving right (D is still down)', () => {
    const r = kbRig();
    r.target.dispatchEvent(kev('keydown', 'KeyD'));
    r.target.dispatchEvent(kev('keydown', 'ArrowRight'));
    expect(r.sample().mx).toBe(127);
    r.target.dispatchEvent(kev('keyup', 'ArrowRight'));
    expect(r.sample().mx).toBe(127);
  });

  it('holding Left and Right together cancels; releasing one moves the other way', () => {
    const r = kbRig();
    r.target.dispatchEvent(kev('keydown', 'KeyA'));
    r.target.dispatchEvent(kev('keydown', 'KeyD'));
    expect(r.sample().mx).toBe(0);
    r.target.dispatchEvent(kev('keyup', 'KeyA'));
    expect(r.sample().mx).toBe(127);
  });

  it('visibilitychange(hidden) mid-hold releases movement and sprint; auto-repeat re-arms only the direction', () => {
    const r = kbRig();
    r.target.dispatchEvent(kev('keydown', 'KeyD'));
    r.target.dispatchEvent(kev('keydown', 'ShiftLeft'));
    expect(r.sample().buttons & Btn.SPRINT).toBe(Btn.SPRINT);
    r.doc.visibilityState = 'hidden';
    r.doc.dispatchEvent(new Event('visibilitychange'));
    const f = r.sample();
    expect(f.mx).toBe(0);
    expect(f.buttons).toBe(0);
    r.doc.visibilityState = 'visible';
    r.target.dispatchEvent(kev('keydown', 'KeyD', { repeat: true }));
    r.target.dispatchEvent(kev('keydown', 'ShiftLeft', { repeat: true }));
    const g = r.sample();
    expect(g.mx).toBe(127);
    expect(g.buttons & Btn.SPRINT).toBe(0);
  });

  it('Escape / P pause once per press (auto-repeat does not toggle pause)', () => {
    const r = kbRig();
    r.target.dispatchEvent(kev('keydown', 'Escape'));
    r.target.dispatchEvent(kev('keydown', 'Escape', { repeat: true }));
    r.target.dispatchEvent(kev('keydown', 'Escape', { repeat: true }));
    expect(r.onPause).toHaveBeenCalledTimes(1);
  });

  it('dispose removes listeners: keys after dispose do nothing', () => {
    const r = kbRig();
    r.kb.dispose();
    r.target.dispatchEvent(kev('keydown', 'KeyD'));
    r.target.dispatchEvent(kev('keydown', 'KeyP'));
    expect(r.sample().mx).toBe(0);
    expect(r.onPause).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ pads

interface MockPad {
  id: string; index: number; connected: boolean; mapping: string; timestamp: number; axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
}
function mockPad(index: number, id = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'): MockPad {
  return {
    id, index, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
}
function setBtn(p: MockPad, b: number, v: number): void {
  p.buttons[b]!.value = v;
  p.buttons[b]!.pressed = v > 0.5;
}

function padRig() {
  const list: (MockPad | null)[] = [null, null, null, null];
  const mgr = createPadManager(() => list as unknown as Gamepad[]);
  let t = 1000;
  const onPause = vi.fn();
  const src = createPadSource({ key: 'pad:1', onPause, manager: mgr, now: () => t });
  const ctx = sampleCtx();
  const out = createInputFrame();
  /** One animation frame at refresh `hz`: poll, and sample when a tick is due. */
  const frame = (ms: number) => { t += ms; src.pollFrame!(t); };
  const sample = () => { src.sample(out, ctx); return out; };
  return { list, mgr, src, frame, sample, onPause, now: () => t };
}

describe('REVIEW FND-05 pads', () => {
  it('disconnect mid-hold releases stick and SPRINT at once; reconnect at a new index restores input on the same key', () => {
    const r = padRig();
    const pad = mockPad(0);
    r.list[0] = pad;
    setBtn(pad, PadButton.SOUTH, 1);
    r.frame(16);
    setBtn(pad, PadButton.SOUTH, 0);
    r.frame(16);
    r.sample();
    pad.axes[0] = -1;
    setBtn(pad, PadButton.R2, 1);
    r.frame(16);
    let f = r.sample();
    expect(f.mx).toBeLessThan(-100);
    expect(f.buttons & Btn.SPRINT).toBe(Btn.SPRINT);
    r.list[0] = null; // Bluetooth drop
    r.frame(16);
    f = r.sample();
    expect(f.mx).toBe(0);
    expect(f.buttons).toBe(0);
    const again = mockPad(2);
    again.axes[0] = 1;
    r.list[2] = again;
    r.frame(16);
    expect(r.mgr.find('pad:1')!.connected).toBe(true);
    expect(r.mgr.find('pad:1')!.index).toBe(2);
    f = r.sample();
    expect(f.mx).toBeGreaterThan(100);
  });

  it('pause-menu presses do not leak into the first tick after resume (releaseAll on pause and on resume)', () => {
    const r = padRig();
    const pad = mockPad(0);
    r.list[0] = pad;
    setBtn(pad, PadButton.WEST, 1);
    r.frame(16);
    setBtn(pad, PadButton.WEST, 0);
    r.frame(16);
    r.sample();
    r.src.releaseAll(); // session.pause()
    // On the pause menu: B to close a sub-panel, then Cross on "Resume" (frames poll, no ticks).
    setBtn(pad, PadButton.EAST, 1); r.frame(16);
    setBtn(pad, PadButton.EAST, 0); r.frame(16);
    setBtn(pad, PadButton.SOUTH, 1); r.frame(16);
    r.src.releaseAll(); // session.resume() on the Cross press edge
    r.frame(16);
    expect(r.sample().buttons).toBe(0); // neither the B tap nor the held Cross reach the sim
    setBtn(pad, PadButton.SOUTH, 0); r.frame(16);
    expect(r.sample().buttons).toBe(0);
    setBtn(pad, PadButton.SOUTH, 1); r.frame(16);
    expect(r.sample().buttons & Btn.PASS).toBe(Btn.PASS); // a fresh press works
  });

  it('120 Hz: a press lasting one frame between two ticks is reported exactly once', () => {
    const r = padRig();
    const pad = mockPad(0);
    r.list[0] = pad;
    setBtn(pad, PadButton.WEST, 1); r.frame(8.33);
    setBtn(pad, PadButton.WEST, 0); r.frame(8.33);
    r.sample();
    let seen = 0;
    for (let i = 0; i < 20; i++) {
      if (i === 5) setBtn(pad, PadButton.EAST, 1);
      if (i === 6) setBtn(pad, PadButton.EAST, 0);
      r.frame(8.33);
      if (i % 2 === 1 && (r.sample().buttons & Btn.SHOOT) !== 0) seen++;
    }
    expect(seen).toBe(1);
  });

  it('Options pauses once per press even when sample() falls back to its own poll in the same frame', () => {
    const r = padRig();
    const pad = mockPad(0);
    r.list[0] = pad;
    setBtn(pad, PadButton.SOUTH, 1); r.frame(16);
    setBtn(pad, PadButton.SOUTH, 0); r.frame(16);
    setBtn(pad, PadButton.START, 1);
    r.frame(16);
    r.sample();
    r.sample();
    r.frame(16);
    r.sample();
    expect(r.onPause).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------ menu repeat at 60 / 120 Hz

describe('REVIEW FND-05 menu repeat', () => {
  function count(hz: number, holdMs: number): number {
    const st = createRepeatState();
    let n = 0;
    const dt = 1000 / hz;
    for (let t = 0; t <= holdMs; t += dt) stepRepeat(st, 1, t, () => { n++; });
    return n;
  }
  it('the same number of repeats at 60 Hz and 120 Hz', () => {
    for (const ms of [200, MENU_REPEAT_DELAY_MS + 5, 1000, 3000]) expect(count(120, ms)).toBe(count(60, ms));
  });
  it('a release resets the delay; a re-press fires immediately', () => {
    const st = createRepeatState();
    const fired: MenuAction[] = [];
    stepRepeat(st, 1, 0, (a) => fired.push(a));
    stepRepeat(st, 0, 16, (a) => fired.push(a));
    stepRepeat(st, 1, 32, (a) => fired.push(a));
    expect(fired).toEqual([MenuAction.UP, MenuAction.UP]);
  });
});

// ------------------------------------------------------------------ device registry

describe('REVIEW FND-05 device registry', () => {
  function settingsStore(): SettingsStore {
    const s = createDefaultSettings();
    return {
      get: () => s, update: (m) => m(s), subscribe: () => () => {}, reset: () => {}, persistent: false,
      loadProgress: () => null, saveProgress: () => {}, clearProgress: () => {},
    };
  }
  function platform(isIPad: boolean, isTouch: boolean): PlatformInfo {
    return { isIPad, isTouch, isStandalone: false, supportsFullscreen: false, safeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
  }

  it('iPad: keyboard appears after the first key (subscribers notified once); unknown ids give neutral sources; dispose detaches', () => {
    const win = new EventTarget();
    const touchRoot = { ownerDocument: { defaultView: win } } as unknown as HTMLElement;
    const list: (MockPad | null)[] = [];
    const reg = createDeviceRegistry({
      touchRoot, getProjector: () => null, getState: () => null, settings: settingsStore(), platform: platform(true, true),
      onPause: () => {}, pads: createPadManager(() => list as unknown as Gamepad[]),
    });
    expect(reg.list().map((d) => d.id)).toEqual(['touch']);
    const fn = vi.fn();
    reg.subscribe(fn);
    win.dispatchEvent(kev('keydown', 'KeyA'));
    win.dispatchEvent(kev('keydown', 'KeyB'));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(reg.list().map((d) => d.id)).toEqual(['touch', 'keyboard']);
    const nul = reg.createSource('bogus', 0);
    const f = createInputFrame();
    f.buttons = 7;
    expect(() => nul.sample(f, sampleCtx())).not.toThrow();
    expect(f.buttons).toBe(0);
    reg.dispose();
    win.dispatchEvent(kev('keydown', 'KeyC'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a pad appears only after a press, and is not re-announced on every frame', () => {
    const win = new EventTarget();
    const touchRoot = { ownerDocument: { defaultView: win } } as unknown as HTMLElement;
    const pads: (MockPad | null)[] = [mockPad(0)];
    const mgr = createPadManager(() => pads as unknown as Gamepad[]);
    const reg = createDeviceRegistry({
      touchRoot, getProjector: () => null, getState: () => null, settings: settingsStore(), platform: platform(false, false),
      onPause: () => {}, pads: mgr,
    });
    const fn = vi.fn();
    reg.subscribe(fn);
    mgr.poll(1);
    expect(reg.list().some((d) => d.kind === 'pad')).toBe(false);
    setBtn(pads[0]!, PadButton.SOUTH, 1);
    mgr.poll(2);
    mgr.poll(3);
    setBtn(pads[0]!, PadButton.SOUTH, 0);
    mgr.poll(4);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(reg.list().filter((d) => d.kind === 'pad')).toHaveLength(1);
    reg.dispose();
  });
});
