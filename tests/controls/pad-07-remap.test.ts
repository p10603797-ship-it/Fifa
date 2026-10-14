/**
 * PAD-07 remap for pads without the standard mapping: the capture walk (press the button for each action), the DOM-free
 * view controller (pick / pad / walk / done, Back, Undo, Skip, hold to cancel, disconnects), saving to
 * settings.controls.pad.remaps[gamepad.id], and the saved remap driving the real mapper through the device registry
 * (PAD-01 devices.ts now passes the settings to every pad source).
 */
import { describe, expect, it } from 'vitest';
import type { PlatformInfo, SettingsStore } from '../../src/contracts/app';
import { MenuAction } from '../../src/contracts/app';
import { MatchPhase, PadFamily } from '../../src/contracts/enums';
import { Btn, createInputFrame } from '../../src/contracts/input';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import { createDeviceRegistry } from '../../src/input/devices';
import { createPadManager, type PadManager } from '../../src/input/pad/manager';
import { PAD_ACTION_COUNT, PadAction } from '../../src/input/pad/mapper';
import {
  CaptureResult, createRemapCapture, createRemapController, readRawButtons, REMAP_STEPS, REMAP_TUNING, stepHint,
} from '../../src/ui/screens/remap';
import { makeScenario } from '../harness/scenario';
import { mockPad, setBtn, STANDARD_ID, type MockPad } from './pad-02-helpers';

const ODD_ID = 'Retro Arcade Pad (Vendor: 1234 Product: 5678)';

interface Rig {
  list: (MockPad | null)[];
  pad: MockPad;
  mgr: PadManager;
  t: number;
  poll(): void;
  tap(raw: number): void;
}

function rig(id = ODD_ID, mapping = '', nButtons = 20): Rig {
  const pad = mockPad(0, id, mapping, nButtons);
  const list: (MockPad | null)[] = [pad, null, null, null];
  const mgr = createPadManager(() => list as unknown as Gamepad[], { eventTarget: null });
  const r: Rig = {
    list, pad, mgr, t: 1000,
    poll() { r.t += 16; mgr.poll(r.t); },
    tap(raw) { setBtn(pad, raw, 1); r.poll(); setBtn(pad, raw, 0); r.poll(); },
  };
  // First press activates (lists) the pad.
  r.tap(0);
  return r;
}

function store(s: Settings = createDefaultSettings()): SettingsStore & { s: Settings } {
  return {
    s,
    get: () => s,
    update: (m) => m(s),
    subscribe: () => () => {},
    reset: () => {}, persistent: true, loadProgress: () => null, saveProgress: () => {}, clearProgress: () => {},
  };
}

describe('PAD-07 remap capture', () => {
  it('raw buttons 0..31 are read; buttons held when the walk starts never count', () => {
    const r = rig();
    setBtn(r.pad, 17, 1);
    r.poll();
    expect(readRawButtons(r.mgr.find('pad:1'))).toBe(1 << 17);
    const cap = createRemapCapture(r.mgr, 'pad:1');
    expect(cap.poll(r.t)).toBe(CaptureResult.NONE);
    expect(cap.step).toBe(0);
    setBtn(r.pad, 17, 0);
    r.poll();
    setBtn(r.pad, 3, 1);
    r.poll();
    expect(cap.poll(r.t)).toBe(CaptureResult.CAPTURED);
    expect(cap.binding[PadAction.PASS]).toBe(3);
    expect(cap.lastRaw).toBe(3);
    expect(cap.step).toBe(1);
  });

  it('pressing a button already used skips the step (an action the pad lacks); Skip and Undo work', () => {
    const r = rig();
    const cap = createRemapCapture(r.mgr, 'pad:1');
    setBtn(r.pad, 5, 1);
    r.poll();
    expect(cap.poll(r.t)).toBe(CaptureResult.CAPTURED);
    setBtn(r.pad, 5, 0);
    r.poll();
    cap.poll(r.t);
    setBtn(r.pad, 5, 1);
    r.poll();
    expect(cap.poll(r.t)).toBe(CaptureResult.SKIPPED_DUPLICATE);
    expect(cap.binding[PadAction.SHOOT]).toBe(-1);
    setBtn(r.pad, 5, 0);
    r.poll();
    cap.poll(r.t);
    cap.skip();
    expect(cap.step).toBe(3);
    cap.undo();
    expect(cap.step).toBe(2);
    expect(cap.binding[2]).toBe(-1);
  });

  it('holding the last pressed button cancels the walk (controller-only Back)', () => {
    const r = rig();
    const cap = createRemapCapture(r.mgr, 'pad:1');
    setBtn(r.pad, 6, 1);
    r.poll();
    cap.poll(r.t);
    const t0 = r.t;
    while (r.t - t0 < REMAP_TUNING.holdHintMs + 400) { r.poll(); cap.poll(r.t); }
    expect(cap.holdProgress).toBeGreaterThan(0);
    while (r.t - t0 < REMAP_TUNING.holdCancelMs + 32 && cap.state === 'listening') { r.poll(); cap.poll(r.t); }
    expect(cap.state).toBe('cancelled');
  });

  it('a disconnect pauses the walk; after the reconnect a button still held does not count', () => {
    const r = rig();
    const cap = createRemapCapture(r.mgr, 'pad:1');
    r.list[0] = null;
    r.pad.connected = false;
    r.poll();
    expect(cap.poll(r.t)).toBe(CaptureResult.DISCONNECTED);
    expect(cap.state).toBe('disconnected');
    r.pad.connected = true;
    r.list[0] = r.pad;
    setBtn(r.pad, 9, 1);
    r.poll();
    expect(cap.poll(r.t)).toBe(CaptureResult.RECONNECTED);
    r.poll();
    expect(cap.poll(r.t)).toBe(CaptureResult.NONE);
    expect(cap.step).toBe(0);
  });
});

describe('PAD-07 remap controller (screen logic)', () => {
  it('the only non-standard pad opens directly; a full walk saves remaps[gamepad.id] in PadAction order', () => {
    const r = rig();
    const st = store();
    const c = createRemapController({ pads: r.mgr, settings: st });
    expect(c.view).toBe('pad');
    expect(c.saved()).toBeNull();
    expect(c.start()).toBe(true);
    expect(c.view).toBe('walk');
    const raws = [10, 11, 12, 13, 4, 5, 6, 7, 9, 14, 15, 16, 17];
    for (const raw of raws) {
      setBtn(r.pad, raw, 1);
      r.t += 16;
      c.frame(r.t);
      setBtn(r.pad, raw, 0);
      r.t += 16;
      c.frame(r.t);
    }
    expect(c.view).toBe('done');
    expect(st.s.controls.pad.remaps[ODD_ID]).toEqual(raws);
    expect(c.current()).toEqual(raws);
    expect(c.notice).toMatch(/Saved/);
    c.resetSaved();
    expect(st.s.controls.pad.remaps[ODD_ID]).toBeUndefined();
  });

  it('Back during the walk cancels without saving; a walk that bound nothing saves nothing', () => {
    const r = rig();
    const st = store();
    const c = createRemapController({ pads: r.mgr, settings: st });
    c.start();
    r.tap(8);
    c.frame(r.t);
    expect(c.back()).toBe(true);
    expect(c.view).toBe('pad');
    expect(st.s.controls.pad.remaps[ODD_ID]).toBeUndefined();
    c.start();
    for (let i = 0; i < PAD_ACTION_COUNT; i++) c.skip();
    expect(c.view).toBe('pad');
    expect(c.notice).toMatch(/nothing changed/i);
    expect(st.s.controls.pad.remaps[ODD_ID]).toBeUndefined();
  });

  it('while walking, menu actions the remapped pad produces are consumed (its presses are being captured)', () => {
    const r = rig();
    const c = createRemapController({ pads: r.mgr, settings: store() });
    c.start();
    setBtn(r.pad, 0, 1);
    r.t += 16;
    c.frame(r.t);
    expect(c.consumeAction(MenuAction.CONFIRM)).toBe(true);
    setBtn(r.pad, 0, 0);
    r.t += 16;
    c.frame(r.t);
    expect(c.consumeAction(MenuAction.CONFIRM)).toBe(false); // keyboard / touch / another pad still work
  });

  it('a standard-mapping pad needs no remap: start() refuses and the bindings are the standard positions', () => {
    const r = rig(STANDARD_ID, 'standard', 17);
    const c = createRemapController({ pads: r.mgr, settings: store(), padKey: 'pad:1' });
    expect(c.view).toBe('pad');
    expect(c.start()).toBe(false);
    expect(c.current()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9, 12, 13, 14, 15]);
    expect(c.family()).toBe(PadFamily.PLAYSTATION);
  });

  it('with no pad pressed yet it waits on the picker and opens the first non-standard pad that appears', () => {
    const pad = mockPad(0, ODD_ID, '', 20);
    const list: (MockPad | null)[] = [null, null, null, null];
    const mgr = createPadManager(() => list as unknown as Gamepad[], { eventTarget: null });
    const c = createRemapController({ pads: mgr, settings: store() });
    expect(c.view).toBe('pick');
    expect(c.pads()).toHaveLength(0);
    list[0] = pad;
    c.frame(100);
    setBtn(pad, 2, 1);
    c.frame(116);
    expect(c.view).toBe('pad');
    expect(c.padKey).toBe('pad:1');
  });

  it('steps cover every PadAction in order with a hint of where the action usually is', () => {
    expect(REMAP_STEPS.map((s) => s.action)).toEqual(Array.from({ length: PAD_ACTION_COUNT }, (_, i) => i));
    expect(REMAP_STEPS.map((s) => s.label)).toEqual([
      'Pass', 'Shoot', 'Lob', 'Through ball', 'Left shoulder', 'Right shoulder', 'Shield', 'Sprint', 'Pause',
      'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right',
    ]);
    expect(stepHint(REMAP_STEPS[1]!, PadFamily.PLAYSTATION).text).toBe('Usually the Circle button');
    expect(stepHint(REMAP_STEPS[1]!, PadFamily.SWITCH).text).toBe('Usually the A button');
    expect(stepHint(REMAP_STEPS[0]!, PadFamily.GENERIC).text).toBe('Usually the bottom face button');
    expect(stepHint(REMAP_STEPS[9]!, PadFamily.GENERIC).text).toBe('Usually up on the D-pad');
  });
});

describe('PAD-07 a saved remap drives the match input (device registry passes settings to pad sources)', () => {
  it('raw button 10 bound to PASS presses Btn.PASS through registry.createSource()', () => {
    const r = rig();
    const st = store();
    const remap = [10, 11, 12, 13, 4, 5, 6, 7, 9, 14, 15, 16, 17];
    st.s.controls.pad.remaps[ODD_ID] = remap;
    const platform: PlatformInfo = { isIPad: false, isTouch: false, isStandalone: false, supportsFullscreen: false, safeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
    const reg = createDeviceRegistry({
      touchRoot: { ownerDocument: { defaultView: null } } as unknown as HTMLElement,
      getProjector: () => null, getState: () => null, settings: st, platform, onPause: () => {}, pads: r.mgr,
    });
    const src = reg.createSource('pad:1', 0);
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }] });
    const f = createInputFrame();
    setBtn(r.pad, 10, 1);
    r.t += 16;
    src.pollFrame!(r.t);
    src.sample(f, { tick: 1, human: 0, side: 0, state: s, projector: null });
    expect(f.buttons & Btn.PASS).toBe(Btn.PASS);
    setBtn(r.pad, 10, 0);
    setBtn(r.pad, 0, 1); // the standard PASS position does nothing on this pad now
    r.t += 16;
    src.pollFrame!(r.t);
    src.sample(f, { tick: 2, human: 0, side: 0, state: s, projector: null });
    expect(f.buttons & Btn.PASS).toBe(0);
    expect((src as unknown as { remapped: boolean }).remapped).toBe(true);
    src.dispose();
    reg.dispose();
  });
});
