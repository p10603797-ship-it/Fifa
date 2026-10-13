/**
 * PAD-01: device registry (touch, keyboard, pad:<n>) with labels and family, subscribe notifications, lastActive,
 * createSource per kind, and the bound-pad disconnect / reconnect callbacks (session auto-pause, PAD-03 card).
 */
import { describe, expect, it, vi } from 'vitest';
import type { PlatformInfo, SettingsStore } from '../../src/contracts/app';
import { PadFamily } from '../../src/contracts/enums';
import { createInputFrame, type InputSampleContext } from '../../src/contracts/input';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createDeviceRegistry, padDeviceLabel, type DeviceRegistryOptions } from '../../src/input/devices';
import { createPadManager, PadButton, type PadManager } from '../../src/input/pad/manager';
import { initMatch } from '../../src/sim/init';

interface MockPad {
  id: string; index: number; connected: boolean; mapping: string; timestamp: number; axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
}
const XBOX = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const DS = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
function mockPad(index: number, id = XBOX): MockPad {
  return {
    id, index, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
}
function setBtn(p: MockPad, b: number, v: number): void {
  p.buttons[b]!.value = v;
  p.buttons[b]!.pressed = v > 0.5;
}

function settingsStore(): SettingsStore & { set(mut: (s: Settings) => void): void } {
  let s = createDefaultSettings();
  const listeners: ((s: Readonly<Settings>) => void)[] = [];
  const set = (mut: (s: Settings) => void): void => {
    s = structuredClone(s);
    mut(s);
    for (const l of listeners) l(s);
  };
  return {
    get: () => s, update: set, set,
    subscribe: (fn) => { listeners.push(fn); return () => { listeners.splice(listeners.indexOf(fn), 1); }; },
    reset: () => {}, persistent: false, loadProgress: () => null, saveProgress: () => {}, clearProgress: () => {},
  };
}
function platform(isIPad: boolean, isTouch: boolean): PlatformInfo {
  return { isIPad, isTouch, isStandalone: false, supportsFullscreen: false, safeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
}
/** Events carry the same clock as the pad polls (in a browser both are performance.now()-based). */
function keyEvent(code: string, target?: unknown, timeStamp?: number): Event {
  const e = new Event('keydown') as Event & { code: string };
  e.code = code;
  if (target) Object.defineProperty(e, 'target', { value: target });
  if (timeStamp !== undefined) Object.defineProperty(e, 'timeStamp', { value: timeStamp });
  return e;
}
function pointerEvent(pointerType: string, timeStamp?: number): Event {
  const e = new Event('pointerdown') as Event & { pointerType: string };
  e.pointerType = pointerType;
  if (timeStamp !== undefined) Object.defineProperty(e, 'timeStamp', { value: timeStamp });
  return e;
}
function sampleCtx(): InputSampleContext {
  return { tick: 1, human: 0, side: 0, state: initMatch(createMatchConfig()) as SimState, projector: null };
}

interface Rig {
  win: EventTarget;
  list: (MockPad | null)[];
  mgr: PadManager;
  settings: ReturnType<typeof settingsStore>;
  reg: ReturnType<typeof createDeviceRegistry>;
  lost: ReturnType<typeof vi.fn>;
  back: ReturnType<typeof vi.fn>;
  frame(): number;
  /** Advance the shared clock by 16 ms without polling (for key / pointer events). */
  tick(): number;
}

function rig(isIPad = true, isTouch = true, extra: Partial<DeviceRegistryOptions> = {}): Rig {
  const win = new EventTarget();
  const list: (MockPad | null)[] = [null, null, null, null];
  const mgr = createPadManager(() => list as unknown as Gamepad[], { eventTarget: win });
  const settings = settingsStore();
  const lost = vi.fn();
  const back = vi.fn();
  const reg = createDeviceRegistry({
    touchRoot: { ownerDocument: { defaultView: win } } as unknown as HTMLElement,
    getProjector: () => null, getState: () => null, settings, platform: platform(isIPad, isTouch), onPause: () => {},
    pads: mgr, onPadDisconnect: lost, onPadReconnect: back, ...extra,
  });
  let t = 5000;
  return {
    win, list, mgr, settings, reg, lost, back,
    frame() { t += 16; mgr.poll(t); return t; },
    tick() { t += 16; return t; },
  };
}

/** Plug a pad in at `index` and press-release a button so it is listed. */
function joinPad(r: Rig, index: number, id = XBOX): MockPad {
  const p = mockPad(index, id);
  r.list[index] = p;
  setBtn(p, PadButton.SOUTH, 1);
  r.frame();
  setBtn(p, PadButton.SOUTH, 0);
  r.frame();
  return p;
}

describe('PAD-01 device registry: listing', () => {
  it('iPad: touch always, keyboard only after a key, pads only after a press', () => {
    const r = rig(true, true);
    r.list[0] = mockPad(0);
    r.frame();
    expect(r.reg.list().map((d) => d.id)).toEqual(['touch']);
    r.win.dispatchEvent(keyEvent('KeyA'));
    expect(r.reg.list().map((d) => d.id)).toEqual(['touch', 'keyboard']);
    setBtn(r.list[0]!, PadButton.SOUTH, 1);
    r.frame();
    expect(r.reg.list().map((d) => d.id)).toEqual(['touch', 'pad:1', 'keyboard']); // section 11 order
  });

  it("the iPad on-screen keyboard typing into a text field does not list a keyboard", () => {
    const r = rig(true, true);
    const fn = vi.fn();
    r.reg.subscribe(fn);
    r.win.dispatchEvent(keyEvent('KeyA', { tagName: 'INPUT' }));
    r.win.dispatchEvent(keyEvent('KeyB', { tagName: 'textarea' }));
    expect(r.reg.list().map((d) => d.id)).toEqual(['touch']);
    expect(fn).not.toHaveBeenCalled();
  });

  it('desktop without touch: keyboard from the start, no touch', () => {
    const r = rig(false, false);
    expect(r.reg.list().map((d) => [d.id, d.kind, d.label])).toEqual([['keyboard', 'keyboard', 'Keyboard']]);
  });

  it('pads are labelled Controller 1 / Controller 2 in the order they were first pressed, with family and product', () => {
    const r = rig(false, false);
    const a = mockPad(0, XBOX), b = mockPad(1, DS);
    r.list[0] = a; r.list[1] = b;
    r.frame();
    setBtn(b, PadButton.SOUTH, 1); // the DualSense at index 1 is pressed first
    r.frame();
    setBtn(a, PadButton.SOUTH, 1);
    r.frame();
    const pads = r.reg.list().filter((d) => d.kind === 'pad');
    expect(pads.map((d) => [d.id, d.label, d.family, d.connected])).toEqual([
      ['pad:2', 'Controller 1', PadFamily.PLAYSTATION, true],
      ['pad:1', 'Controller 2', PadFamily.XBOX, true],
    ]);
    expect(pads[0]!.product).toBe('PlayStation controller');
    expect(padDeviceLabel(0)).toBe('Controller');
  });

  it('a disconnected pad stays listed with connected = false and keeps its label; reconnect at a new index restores it', () => {
    const r = rig(false, false);
    joinPad(r, 0);
    r.list[0] = null;
    r.frame();
    expect(r.reg.list().filter((d) => d.kind === 'pad').map((d) => [d.id, d.label, d.connected])).toEqual([['pad:1', 'Controller 1', false]]);
    r.list[2] = mockPad(2);
    r.frame();
    expect(r.reg.list().filter((d) => d.kind === 'pad').map((d) => [d.id, d.label, d.connected])).toEqual([['pad:1', 'Controller 1', true]]);
  });

  it('the settings family override applies to every pad and notifies subscribers once per change', () => {
    const r = rig(false, false);
    joinPad(r, 0, XBOX);
    const fn = vi.fn();
    r.reg.subscribe(fn);
    r.settings.set((s) => { s.controls.pad.familyOverride = PadFamily.SWITCH; });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0].find((d: { id: string }) => d.id === 'pad:1').family).toBe(PadFamily.SWITCH);
    r.settings.set((s) => { s.audio.master = 0.1; });
    expect(fn).toHaveBeenCalledTimes(1);
    r.settings.set((s) => { s.controls.pad.familyOverride = PadFamily.AUTO; });
    expect(r.reg.list().find((d) => d.id === 'pad:1')!.family).toBe(PadFamily.XBOX);
  });

  it('subscribers hear each list change once: activation, disconnect, reconnect; not every frame, not inactive pads', () => {
    const r = rig(false, false);
    const fn = vi.fn();
    r.reg.subscribe(fn);
    const p = mockPad(0);
    r.list[0] = p;
    r.frame();
    r.list[1] = mockPad(1, DS); // never pressed
    r.frame();
    expect(fn).not.toHaveBeenCalled();
    setBtn(p, PadButton.SOUTH, 1);
    r.frame();
    r.frame();
    r.frame();
    expect(fn).toHaveBeenCalledTimes(1);
    r.list[0] = null;
    r.frame();
    r.list[3] = mockPad(3);
    r.frame();
    expect(fn).toHaveBeenCalledTimes(3);
    r.list[1] = null; // the never-pressed pad leaves: the list is unchanged
    r.frame();
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('PAD-01 device registry: lastActive', () => {
  it('null before any input; then the device used last among touch, keyboard and pads', () => {
    const r = rig(true, true);
    expect(r.reg.lastActive()).toBeNull();
    const p = joinPad(r, 0);
    expect(r.reg.lastActive()).toBe('pad:1');
    r.win.dispatchEvent(pointerEvent('touch', r.tick()));
    expect(r.reg.lastActive()).toBe('touch');
    r.win.dispatchEvent(pointerEvent('mouse', r.tick())); // a mouse is not the touch device
    expect(r.reg.lastActive()).toBe('touch');
    r.win.dispatchEvent(keyEvent('KeyJ', undefined, r.tick()));
    expect(r.reg.lastActive()).toBe('keyboard');
    p.axes[0] = 0.9;
    r.frame();
    expect(r.reg.lastActive()).toBe('pad:1');
  });

  it('a disconnected pad is never the last active device', () => {
    const r = rig(false, true);
    r.win.dispatchEvent(pointerEvent('touch', r.tick()));
    joinPad(r, 0);
    expect(r.reg.lastActive()).toBe('pad:1');
    r.list[0] = null;
    r.frame();
    expect(r.reg.lastActive()).toBe('touch');
  });
});

describe('PAD-01 device registry: createSource', () => {
  it('keyboard, pad and unknown ids give sources of the right kind; unknown ids never throw', () => {
    const r = rig(false, false);
    joinPad(r, 0);
    const kb = r.reg.createSource('keyboard', 0);
    const pad = r.reg.createSource('pad:1', 1);
    const nul = r.reg.createSource('bogus', 0);
    expect([kb.kind, pad.kind, nul.kind]).toEqual(['keyboard', 'pad', 'none']);
    expect(pad.id).toBe('pad:1');
    const f = createInputFrame();
    f.buttons = 5;
    expect(() => nul.sample(f, sampleCtx())).not.toThrow();
    expect(f.buttons).toBe(0);
    kb.dispose(); pad.dispose(); nul.dispose();
  });

  it('every non-pad source polls the pad manager in pollFrame (a pad pressed mid-match is discovered)', () => {
    const r = rig(false, false);
    const kb = r.reg.createSource('keyboard', 0);
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.SOUTH, 1);
    kb.pollFrame!(123);
    expect(r.mgr.lastPollMs).toBe(123);
    expect(r.reg.list().some((d) => d.id === 'pad:1')).toBe(true);
    kb.dispose();
  });
});

describe('PAD-01 device registry: bound pad disconnect mid-match', () => {
  it('disconnect of a bound pad calls onPadDisconnect(human, id) once; reconnect at a new index calls onPadReconnect', () => {
    const r = rig(false, false);
    joinPad(r, 0);
    const src = r.reg.createSource('pad:1', 1);
    src.pollFrame!(9000);
    expect(r.lost).not.toHaveBeenCalled();
    expect(r.reg.boundPads()).toEqual([{ deviceId: 'pad:1', human: 1, connected: true }]);
    r.list[0] = null;
    r.frame();
    r.frame();
    expect(r.lost).toHaveBeenCalledTimes(1);
    expect(r.lost).toHaveBeenCalledWith(1, 'pad:1');
    expect(r.reg.boundPads()).toEqual([{ deviceId: 'pad:1', human: 1, connected: false }]);
    r.list[2] = mockPad(2);
    r.frame();
    expect(r.back).toHaveBeenCalledTimes(1);
    expect(r.back).toHaveBeenCalledWith(1, 'pad:1');
    expect(r.reg.boundPads()[0]!.connected).toBe(true);
    src.dispose();
  });

  it('the gamepaddisconnected event alone (no frame) already reports a bound pad', () => {
    const r = rig(false, false);
    const p = joinPad(r, 0);
    const src = r.reg.createSource('pad:1', 0);
    r.list[0] = null;
    p.connected = false;
    const e = new Event('gamepaddisconnected') as Event & { gamepad: unknown };
    e.gamepad = p;
    r.win.dispatchEvent(e);
    expect(r.lost).toHaveBeenCalledWith(0, 'pad:1');
    src.dispose();
  });

  it('two pads on two sides: only the side whose pad dropped is reported', () => {
    const r = rig(false, false);
    joinPad(r, 0);
    joinPad(r, 1, DS);
    const listener = vi.fn();
    r.reg.onBoundPadChange(listener);
    const s1 = r.reg.createSource('pad:1', 0);
    const s2 = r.reg.createSource('pad:2', 1);
    r.list[1] = null;
    r.frame();
    expect(r.lost).toHaveBeenCalledTimes(1);
    expect(r.lost).toHaveBeenCalledWith(1, 'pad:2');
    expect(listener).toHaveBeenCalledWith('pad:2', 1, false);
    s1.dispose(); s2.dispose();
  });

  it('an unbound pad (menus, or not bound to anyone) disconnecting is not a match event', () => {
    const r = rig(false, false);
    joinPad(r, 0);
    joinPad(r, 1, DS);
    const src = r.reg.createSource('pad:1', 0);
    r.list[1] = null;
    r.frame();
    expect(r.lost).not.toHaveBeenCalled();
    src.dispose();
  });

  it('a disposed source (match over) unbinds its pad: a later disconnect is not reported', () => {
    const r = rig(false, false);
    joinPad(r, 0);
    const src = r.reg.createSource('pad:1', 0);
    src.dispose();
    expect(r.reg.boundPads()).toEqual([]);
    r.list[0] = null;
    r.frame();
    expect(r.lost).not.toHaveBeenCalled();
  });

  it('a pad bound while already disconnected is reported on its source\'s first frame, once', () => {
    const r = rig(false, false);
    joinPad(r, 0);
    r.list[0] = null;
    r.frame();
    const src = r.reg.createSource('pad:1', 1);
    expect(r.lost).not.toHaveBeenCalled(); // never synchronously inside createSource (session start)
    src.pollFrame!(20_000);
    src.pollFrame!(20_016);
    expect(r.lost).toHaveBeenCalledTimes(1);
    expect(r.lost).toHaveBeenCalledWith(1, 'pad:1');
    r.list[1] = mockPad(1);
    src.pollFrame!(20_032);
    expect(r.back).toHaveBeenCalledWith(1, 'pad:1');
    src.dispose();
  });

  it('a pad bound while missing that returns before its first frame reports nothing', () => {
    const r = rig(false, false);
    joinPad(r, 0);
    r.list[0] = null;
    r.frame();
    const src = r.reg.createSource('pad:1', 0);
    r.list[0] = mockPad(0);
    r.frame();
    src.pollFrame!(30_000);
    expect(r.lost).not.toHaveBeenCalled();
    expect(r.back).not.toHaveBeenCalled();
    expect(r.reg.boundPads()[0]!.connected).toBe(true);
    src.dispose();
  });

  it('a listener that disposes its source during the callback (hand-off to touch / CPU) is safe', () => {
    const r = rig(false, false);
    joinPad(r, 0);
    joinPad(r, 1, DS);
    const s1 = r.reg.createSource('pad:1', 0);
    const s2 = r.reg.createSource('pad:1', 1); // the same pad on a second binding (wildcard + explicit)
    r.reg.onBoundPadChange(() => { s1.dispose(); s2.dispose(); });
    r.list[0] = null;
    expect(() => r.frame()).not.toThrow();
    expect(r.lost).toHaveBeenCalledTimes(1); // the second binding was unbound before its turn
    expect(r.reg.boundPads()).toEqual([]);
  });

  it('a throwing callback does not stop the other listeners', () => {
    const r = rig(false, false, { onPadDisconnect: () => { throw new Error('session gone'); } });
    joinPad(r, 0);
    const listener = vi.fn();
    r.reg.onBoundPadChange(listener);
    const src = r.reg.createSource('pad:1', 0);
    r.list[0] = null;
    expect(() => r.frame()).toThrow('session gone');
    expect(listener).toHaveBeenCalledWith('pad:1', 0, false);
    expect(r.mgr.find('pad:1')!.connected).toBe(false);
    src.dispose();
  });

  it('dispose detaches every listener (keys, pads, settings, bound pads)', () => {
    const r = rig(true, true);
    joinPad(r, 0);
    const fn = vi.fn();
    r.reg.subscribe(fn);
    const src = r.reg.createSource('pad:1', 0);
    r.reg.dispose();
    r.win.dispatchEvent(keyEvent('KeyA'));
    r.settings.set((s) => { s.controls.pad.familyOverride = PadFamily.SWITCH; });
    r.list[0] = null;
    r.frame();
    expect(fn).not.toHaveBeenCalled();
    expect(r.lost).not.toHaveBeenCalled();
    src.dispose();
  });
});

describe('PAD-01 device registry: subscriber robustness', () => {
  it('a throwing list subscriber does not starve the others', () => {
    const r = rig(false, false);
    const later = vi.fn();
    r.reg.subscribe(() => { throw new Error('screen gone'); });
    r.reg.subscribe(later);
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.SOUTH, 1);
    expect(() => r.frame()).toThrow('screen gone');
    expect(later).toHaveBeenCalledTimes(1);
    expect(r.reg.list().some((d) => d.id === 'pad:1')).toBe(true);
  });
});
