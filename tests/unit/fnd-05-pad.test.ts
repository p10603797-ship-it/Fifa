/**
 * FND-05: pad manager + PadInputSource with mock Gamepad objects (dead zone, triggers, bits, connect-on-press,
 * reconnect at a new index, pause, latching, release suppression).
 */
import { describe, expect, it, vi } from 'vitest';
import { AXIS_SCALE, Btn, createInputFrame, type InputSampleContext } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { T_PAD } from '../../src/contracts/tuning';
import { radialDeadZone, quantStick } from '../../src/input/axes';
import { createPadManager, PadButton } from '../../src/input/pad/manager';
import { createPadSource, mapPadButtons } from '../../src/input/pad/mapper';
import { detectPadFamily, buttonLabel } from '../../src/input/pad/glyphs';
import { createRightStick } from '../../src/input/pad/rightStick';
import { createReconnectWatcher } from '../../src/input/pad/reconnect';
import { PadFamily } from '../../src/contracts/enums';
import { initMatch } from '../../src/sim/init';

interface MockPad {
  id: string;
  index: number;
  connected: boolean;
  mapping: string;
  timestamp: number;
  axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
}

function mockPad(index: number, id = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'): MockPad {
  return {
    id, index, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
}

function press(p: MockPad, b: number, value = 1): void {
  p.buttons[b]!.value = value;
  p.buttons[b]!.pressed = value > 0.5 || (b !== 6 && b !== 7 && value > 0);
}
function releaseBtn(p: MockPad, b: number): void {
  p.buttons[b]!.value = 0;
  p.buttons[b]!.pressed = false;
}

function setup() {
  const list: (MockPad | null)[] = [];
  const mgr = createPadManager(() => list as unknown as Gamepad[]);
  let t = 0;
  const tick = (): number => { t += 16; mgr.poll(t); return t; };
  return { list, mgr, tick, now: () => t };
}

function ctx(): InputSampleContext {
  const s = initMatch(createMatchConfig()) as SimState;
  return { tick: 1, human: 0, side: 0, state: s, projector: null };
}

describe('FND-05 pad manager', () => {
  it('lists a pad only after a button press (connect-on-press), never on Home', () => {
    const { list, mgr, tick } = setup();
    const changes = vi.fn();
    mgr.subscribe(changes);
    const p = mockPad(0);
    list[0] = p;
    tick();
    expect(mgr.slots.length).toBe(1);
    expect(mgr.slots[0]!.active).toBe(false);
    expect(changes).not.toHaveBeenCalled();
    // Stick wiggle and Home do not activate.
    p.axes[0] = 0.9;
    press(p, 16);
    tick();
    expect(mgr.slots[0]!.active).toBe(false);
    p.axes[0] = 0;
    releaseBtn(p, 16);
    press(p, PadButton.SOUTH);
    tick();
    expect(mgr.slots[0]!.active).toBe(true);
    expect(mgr.slots[0]!.key).toBe('pad:1');
    expect(changes).toHaveBeenCalledTimes(1);
    expect(mgr.lastActiveKey).toBe('pad:1');
  });

  it('poll is idempotent per timestamp (edges are not lost or doubled)', () => {
    const { list, mgr } = setup();
    const p = mockPad(0);
    list[0] = p;
    mgr.poll(10);
    press(p, 0);
    mgr.poll(20);
    mgr.poll(20);
    const s = mgr.slots[0]!;
    expect(s.pressed & 1).toBe(1);
    expect(s.prevPressed & 1).toBe(0);
  });

  it('radial dead zone 0.15 / 0.95 rescaled', () => {
    const o = { x: 0, y: 0 };
    radialDeadZone(0.1, 0, T_PAD.deadInner, T_PAD.deadOuter, o);
    expect(o.x).toBe(0);
    radialDeadZone(0.1, 0.1, T_PAD.deadInner, T_PAD.deadOuter, o); // |v| = 0.141 < 0.15
    expect(o.x).toBe(0);
    expect(o.y).toBe(0);
    radialDeadZone(0.55, 0, T_PAD.deadInner, T_PAD.deadOuter, o);
    expect(o.x).toBeCloseTo((0.55 - 0.15) / 0.8, 6);
    radialDeadZone(0.97, 0, T_PAD.deadInner, T_PAD.deadOuter, o);
    expect(o.x).toBeCloseTo(1, 6);
    radialDeadZone(0.6, -0.6, T_PAD.deadInner, T_PAD.deadOuter, o); // radial, direction preserved
    const m = Math.hypot(0.6, 0.6);
    expect(Math.hypot(o.x, o.y)).toBeCloseTo((m - 0.15) / 0.8, 6);
    expect(o.x).toBeCloseTo(-o.y, 9);
    radialDeadZone(Number.NaN, 0, 0.15, 0.95, o);
    expect(o.x).toBe(0);
  });

  it('sticks are dead-zoned in the manager', () => {
    const { list, mgr, tick } = setup();
    const p = mockPad(0);
    list[0] = p;
    p.axes = [0.12, -0.05, 0.5, 0];
    tick();
    const s = mgr.slots[0]!;
    expect(s.lx).toBe(0);
    expect(s.ly).toBe(0);
    expect(s.rx).toBeCloseTo((0.5 - 0.15) / 0.8, 5);
  });

  it('reconnect at a new index keeps the slot and key; a new pad id gets a new key', () => {
    const { list, mgr, tick } = setup();
    const changes = vi.fn();
    mgr.subscribe(changes);
    const p = mockPad(0);
    list[0] = p;
    press(p, 0);
    tick();
    expect(changes).toHaveBeenCalledTimes(1);
    // Disconnect.
    list[0] = null;
    tick();
    expect(mgr.slots[0]!.connected).toBe(false);
    expect(mgr.slots[0]!.index).toBe(-1);
    expect(mgr.slots[0]!.pressed).toBe(0);
    expect(changes).toHaveBeenCalledTimes(2);
    // Reconnect at index 2.
    const p2 = mockPad(2);
    list[2] = p2;
    tick();
    expect(mgr.slots.length).toBe(1);
    expect(mgr.slots[0]!.connected).toBe(true);
    expect(mgr.slots[0]!.index).toBe(2);
    expect(mgr.slots[0]!.key).toBe('pad:1');
    expect(mgr.slots[0]!.active).toBe(true);
    expect(changes).toHaveBeenCalledTimes(3);
    // A different controller.
    list[1] = mockPad(1, 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)');
    tick();
    expect(mgr.slots.length).toBe(2);
    expect(mgr.slots[1]!.key).toBe('pad:2');
    expect(mgr.find('pad:2')!.active).toBe(false);
  });

  it('two identical pads keep their own identity across a reconnect', () => {
    const { list, mgr, tick } = setup();
    const a = mockPad(0), b = mockPad(1);
    list[0] = a; list[1] = b;
    press(a, 0); press(b, 1);
    tick();
    expect(mgr.slots.map((s) => s.key)).toEqual(['pad:1', 'pad:2']);
    list[1] = null;
    tick();
    const b2 = mockPad(3);
    list[3] = b2;
    tick();
    expect(mgr.slots.length).toBe(2);
    expect(mgr.find('pad:2')!.index).toBe(3);
    expect(mgr.find('pad:1')!.index).toBe(0);
  });
});

describe('FND-05 pad mapping', () => {
  it('maps the FC Classic positions to Btn bits; triggers are analogue past 0.3', () => {
    const { list, mgr, tick } = setup();
    const p = mockPad(0);
    list[0] = p;
    const expectBits = (b: number, bit: number): void => {
      press(p, b);
      tick();
      expect(mapPadButtons(mgr.slots[0]!)).toBe(bit);
      releaseBtn(p, b);
      tick();
      expect(mapPadButtons(mgr.slots[0]!)).toBe(0);
    };
    expectBits(0, Btn.PASS);
    expectBits(1, Btn.SHOOT);
    expectBits(2, Btn.LOB);
    expectBits(3, Btn.THROUGH);
    expectBits(4, Btn.MOD_L);
    expectBits(5, Btn.MOD_R);
    // Unbound: Create/View, Options, L3, R3, D-pad, Home.
    for (const b of [8, 9, 10, 11, 12, 13, 14, 15, 16]) expectBits(b, 0);
    // Triggers.
    press(p, 6, 0.2);
    press(p, 7, 0.29);
    tick();
    expect(mapPadButtons(mgr.slots[0]!)).toBe(0);
    press(p, 6, 0.35);
    tick();
    expect(mapPadButtons(mgr.slots[0]!)).toBe(Btn.SHIELD);
    press(p, 7, 0.31);
    tick();
    expect(mapPadButtons(mgr.slots[0]!)).toBe(Btn.SHIELD | Btn.SPRINT);
  });

  it('PadInputSource: sticks to pitch axes (up = -z, right = +x), radial magnitude <= 127', () => {
    const { list, mgr, tick, now } = setup();
    const p = mockPad(0);
    list[0] = p;
    press(p, 0);
    tick();
    releaseBtn(p, 0);
    const onPause = vi.fn();
    const src = createPadSource({ key: 'pad:1', onPause, manager: mgr, now });
    const f = createInputFrame();
    const c = ctx();
    p.axes = [0, -1, 1, 0];
    const t = tick();
    src.pollFrame!(t);
    src.sample(f, c);
    expect(f.mx).toBe(0);
    expect(f.mz).toBe(-AXIS_SCALE);
    expect(f.ax).toBe(AXIS_SCALE);
    expect(f.az).toBe(0);
    p.axes = [0.8, 0.8, 0, 0];
    src.pollFrame!(tick());
    src.sample(f, c);
    expect(f.mx).toBeGreaterThan(0);
    expect(f.mz).toBeGreaterThan(0);
    expect(f.mx * f.mx + f.mz * f.mz).toBeLessThanOrEqual(AXIS_SCALE * AXIS_SCALE);
    expect(src.kind).toBe('pad');
    expect(src.id).toBe('pad:1');
  });

  it('Options pauses once per press; a sub-tick tap is latched; releaseAll suppresses held buttons', () => {
    const { list, mgr, tick, now } = setup();
    const p = mockPad(0);
    list[0] = p;
    press(p, 0);
    tick();
    releaseBtn(p, 0);
    tick();
    const onPause = vi.fn();
    const src = createPadSource({ key: 'pad:1', onPause, manager: mgr, now });
    const f = createInputFrame();
    const c = ctx();
    press(p, PadButton.START);
    src.pollFrame!(tick());
    src.pollFrame!(tick());
    expect(onPause).toHaveBeenCalledTimes(1);
    releaseBtn(p, PadButton.START);
    src.pollFrame!(tick());
    src.sample(f, c);
    expect(f.buttons).toBe(0);
    // Tap between two samples (two animation frames at 120 Hz): still reported once.
    press(p, PadButton.EAST);
    src.pollFrame!(tick());
    releaseBtn(p, PadButton.EAST);
    src.pollFrame!(tick());
    src.sample(f, c);
    expect(f.buttons & Btn.SHOOT).toBe(Btn.SHOOT);
    src.pollFrame!(tick());
    src.sample(f, c);
    expect(f.buttons & Btn.SHOOT).toBe(0);
    // Held sprint is suppressed by releaseAll until physically released, then works again.
    press(p, PadButton.R2, 1);
    src.pollFrame!(tick());
    src.sample(f, c);
    expect(f.buttons & Btn.SPRINT).toBe(Btn.SPRINT);
    src.releaseAll();
    src.pollFrame!(tick());
    src.sample(f, c);
    expect(f.buttons & Btn.SPRINT).toBe(0);
    releaseBtn(p, PadButton.R2);
    src.pollFrame!(tick());
    src.sample(f, c);
    press(p, PadButton.R2, 1);
    src.pollFrame!(tick());
    src.sample(f, c);
    expect(f.buttons & Btn.SPRINT).toBe(Btn.SPRINT);
  });

  it('a disconnected pad produces neutral frames; reconnect at a new index resumes the same source', () => {
    const { list, mgr, tick, now } = setup();
    const p = mockPad(0);
    list[0] = p;
    press(p, 0);
    tick();
    const src = createPadSource({ key: 'pad:1', onPause: () => {}, manager: mgr, now });
    const f = createInputFrame();
    const c = ctx();
    p.axes = [1, 0, 0, 0];
    src.pollFrame!(tick());
    src.sample(f, c);
    expect(f.mx).toBe(AXIS_SCALE);
    list[0] = null;
    src.pollFrame!(tick());
    src.sample(f, c);
    expect(f.mx).toBe(0);
    expect(f.buttons).toBe(0);
    const p2 = mockPad(1);
    p2.axes = [-1, 0, 0, 0];
    list[1] = p2;
    src.pollFrame!(tick());
    src.sample(f, c);
    expect(f.mx).toBe(-AXIS_SCALE);
  });

  it('sample() falls back to polling when pollFrame is never called', () => {
    const { list, mgr } = setup();
    const p = mockPad(0);
    list[0] = p;
    let t = 100;
    mgr.poll(t);
    press(p, 0);
    mgr.poll((t += 16));
    releaseBtn(p, 0);
    const src = createPadSource({ key: 'pad:1', onPause: () => {}, manager: mgr, now: () => t });
    const f = createInputFrame();
    p.axes = [0, 1, 0, 0];
    t += 50;
    src.sample(f, ctx());
    expect(f.mz).toBe(AXIS_SCALE);
  });

  it('quantStick keeps integer magnitude within 127 and handles NaN', () => {
    const q = { qx: 0, qy: 0 };
    for (let a = 0; a < Math.PI * 2; a += 0.05) {
      quantStick(Math.cos(a), Math.sin(a), q);
      expect(q.qx * q.qx + q.qy * q.qy).toBeLessThanOrEqual(127 * 127);
      expect(Math.hypot(q.qx, q.qy)).toBeGreaterThan(125);
    }
    quantStick(Number.NaN, 0.5, q);
    expect(q.qx).toBe(0);
    expect(q.qy).toBe(64);
  });

  it('family detection, labels, right-stick flick/hold and the reconnect watcher', () => {
    expect(detectPadFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe(PadFamily.PLAYSTATION);
    expect(detectPadFamily('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)')).toBe(PadFamily.XBOX);
    expect(detectPadFamily('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)')).toBe(PadFamily.SWITCH);
    expect(detectPadFamily('8BitDo thing')).toBe(PadFamily.GENERIC);
    expect(buttonLabel(PadFamily.PLAYSTATION, 0)).toBe('Cross');
    expect(buttonLabel(PadFamily.XBOX, 3)).toBe('Y');
    const rs = createRightStick();
    rs.update(0.9, 0, 0);
    expect(rs.consume() & Btn.RS_FLICK).toBe(Btn.RS_FLICK);
    expect(rs.consume() & Btn.RS_FLICK).toBe(0);
    rs.update(0.9, 0, 400);
    expect(rs.consume() & Btn.RS_HOLD).toBe(Btn.RS_HOLD);
    rs.update(0, 0, 420);
    expect(rs.consume()).toBe(0);

    const { list, mgr, tick } = setup();
    const p = mockPad(0);
    list[0] = p;
    press(p, 0);
    tick();
    const lost = vi.fn(), back = vi.fn();
    const w = createReconnectWatcher({ manager: mgr, keys: ['pad:1'], onDisconnect: lost, onReconnect: back });
    list[0] = null;
    tick();
    expect(lost).toHaveBeenCalledWith('pad:1');
    expect(w.missing()).toEqual(['pad:1']);
    list[4] = mockPad(4);
    tick();
    expect(back).toHaveBeenCalledWith('pad:1');
    expect(w.missing()).toEqual([]);
    w.dispose();
  });
});
