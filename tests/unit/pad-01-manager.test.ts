/**
 * PAD-01: gamepad manager with mock Gamepad objects (pure Node): radial dead zone, analogue triggers and the 0.3
 * sprint threshold, connect-on-press, two pads, reconnect at a new index keeps the identity, connection events
 * (gamepadconnected / gamepaddisconnected + polling diff), robustness against odd browser data.
 */
import { describe, expect, it, vi } from 'vitest';
import { T_PAD } from '../../src/contracts/tuning';
import {
  createPadManager, MAX_PAD_SLOTS, PAD_TRIGGER_RELEASE, PadButton, gamepadHasPress, padAnyPressedEdge, padDown,
  padPressedEdge, padReleasedEdge, type PadEventKind, type PadManager,
} from '../../src/input/pad/manager';

interface MockButton { pressed: boolean; touched: boolean; value: number }
interface MockPad {
  id: string; index: number; connected: boolean; mapping: string; timestamp: number; axes: number[];
  buttons: MockButton[];
}

const XBOX = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const DS = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';

function mockPad(index: number, id = XBOX): MockPad {
  return {
    id, index, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
}
function setBtn(p: MockPad, b: number, value: number, pressed = value > 0.5): void {
  p.buttons[b]!.value = value;
  p.buttons[b]!.pressed = pressed;
}

interface Rig {
  list: (MockPad | null)[];
  mgr: PadManager;
  target: EventTarget;
  events: [PadEventKind, string][];
  changes: ReturnType<typeof vi.fn>;
  /** One animation frame. */
  frame(): number;
  connectEvent(gp: MockPad | null): void;
  disconnectEvent(gp: MockPad | null): void;
}

function rig(): Rig {
  const list: (MockPad | null)[] = [null, null, null, null];
  const target = new EventTarget();
  const mgr = createPadManager(() => list as unknown as Gamepad[], { eventTarget: target });
  const events: [PadEventKind, string][] = [];
  mgr.onPadEvent((k, s) => events.push([k, s.key]));
  const changes = vi.fn();
  mgr.subscribe(changes);
  let t = 1000;
  const fire = (type: string, gp: MockPad | null): void => {
    const e = new Event(type) as Event & { gamepad?: unknown };
    if (gp) e.gamepad = gp;
    target.dispatchEvent(e);
  };
  return {
    list, mgr, target, events, changes,
    frame() { t += 16; mgr.poll(t); return t; },
    connectEvent: (gp) => fire('gamepadconnected', gp),
    disconnectEvent: (gp) => fire('gamepaddisconnected', gp),
  };
}

// ------------------------------------------------------------------ dead zone

describe('PAD-01 radial dead zone (0.15 inner, 0.95 outer, rescaled)', () => {
  it('a stick inside the inner radius reads exactly zero (both sticks)', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    p.axes = [0.1, 0.1, -0.14, 0.02]; // |l| = 0.1414, |r| = 0.1414
    r.frame();
    const s = r.mgr.slots[0]!;
    expect([s.lx, s.ly, s.rx, s.ry]).toEqual([0, 0, 0, 0]);
  });

  it('between inner and outer the magnitude is rescaled to (m - 0.15) / 0.8 and the direction kept', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    for (const m of [0.16, 0.3, 0.55, 0.8, 0.94]) {
      for (const ang of [0, 0.7, 1.9, 3.3, 5.1]) {
        const x = m * Math.cos(ang), y = m * Math.sin(ang);
        p.axes = [x, y, -x, -y];
        r.frame();
        const s = r.mgr.slots[0]!;
        const want = (m - T_PAD.deadInner) / (T_PAD.deadOuter - T_PAD.deadInner);
        expect(Math.hypot(s.lx, s.ly)).toBeCloseTo(want, 5);
        expect(Math.hypot(s.rx, s.ry)).toBeCloseTo(want, 5);
        expect(Math.atan2(s.ly, s.lx)).toBeCloseTo(Math.atan2(y, x), 5);
        expect(s.rx).toBeCloseTo(-s.lx, 6);
      }
    }
  });

  it('at or past the outer radius the magnitude is exactly 1, also for a square-gate corner (1, 1)', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    p.axes = [0.95, 0, 1, 1];
    r.frame();
    const s = r.mgr.slots[0]!;
    expect(s.lx).toBeCloseTo(1, 6);
    expect(s.ly).toBe(0);
    expect(Math.hypot(s.rx, s.ry)).toBeCloseTo(1, 6);
    expect(s.rx).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('the dead zone is radial, not per axis: a diagonal of 0.12 on each axis (|v| = 0.17) is live', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    p.axes = [0.12, 0.12, 0, 0];
    r.frame();
    const s = r.mgr.slots[0]!;
    expect(s.lx).toBeGreaterThan(0);
    expect(s.ly).toBeGreaterThan(0);
    expect(Math.hypot(s.lx, s.ly)).toBeCloseTo((Math.hypot(0.12, 0.12) - 0.15) / 0.8, 5);
  });

  it('NaN, Infinity, missing and non-numeric axes read as zero (never NaN downstream)', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    p.axes = [Number.NaN, 0.9, Number.POSITIVE_INFINITY, 0.5];
    r.frame();
    let s = r.mgr.slots[0]!;
    expect(Number.isFinite(s.lx) && Number.isFinite(s.ly) && Number.isFinite(s.rx) && Number.isFinite(s.ry)).toBe(true);
    expect(s.lx).toBe(0);
    expect(s.ly).toBeCloseTo((0.9 - 0.15) / 0.8, 5);
    expect(s.rx).toBe(0);
    p.axes = [0.5]; // a pad with one axis
    r.frame();
    s = r.mgr.slots[0]!;
    expect([s.ly, s.rx, s.ry]).toEqual([0, 0, 0]);
    (p as unknown as { axes: unknown }).axes = undefined;
    r.frame();
    expect([s.lx, s.ly, s.rx, s.ry]).toEqual([0, 0, 0, 0]);
  });
});

// ------------------------------------------------------------------ triggers

describe('PAD-01 analogue triggers (sprint engages past 0.3)', () => {
  it('trigger value is analogue 0..1 and the pressed bit engages strictly past 0.3', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.R2, 0.3, true); // browsers flag "pressed" at a lower level: ignored for triggers
    r.frame();
    const s = r.mgr.slots[0]!;
    expect(s.value[PadButton.R2]).toBeCloseTo(0.3, 6);
    expect(padDown(s, PadButton.R2)).toBe(false);
    setBtn(p, PadButton.R2, 0.31, true);
    r.frame();
    expect(padDown(s, PadButton.R2)).toBe(true);
    expect(padPressedEdge(s, PadButton.R2)).toBe(true);
    setBtn(p, PadButton.L2, 0.75, true);
    r.frame();
    expect(s.value[PadButton.L2]).toBeCloseTo(0.75, 6);
    expect(padDown(s, PadButton.L2)).toBe(true);
  });

  it('trigger resting near the threshold does not chatter (hysteresis: releases at 0.25 or below)', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    const s = (): ReturnType<PadManager['find']> => r.mgr.find('pad:1');
    let edges = 0;
    let releases = 0;
    for (const v of [0.2, 0.32, 0.29, 0.31, 0.28, 0.33, 0.26, 0.3, 0.27]) {
      setBtn(p, PadButton.R2, v, v > 0.1);
      r.frame();
      if (padPressedEdge(s()!, PadButton.R2)) edges++;
      if (padReleasedEdge(s()!, PadButton.R2)) releases++;
    }
    expect(edges).toBe(1);
    expect(releases).toBe(0);
    expect(padDown(s()!, PadButton.R2)).toBe(true);
    setBtn(p, PadButton.R2, PAD_TRIGGER_RELEASE, true);
    r.frame();
    expect(padDown(s()!, PadButton.R2)).toBe(false);
    expect(padReleasedEdge(s()!, PadButton.R2)).toBe(true);
    setBtn(p, PadButton.R2, 0.29, true); // re-engaging needs the full threshold again
    r.frame();
    expect(padDown(s()!, PadButton.R2)).toBe(false);
  });

  it('a digital-only trigger (pressed, value 0) reads as fully pressed', () => {
    const r = rig();
    const p = mockPad(0, 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)');
    r.list[0] = p;
    setBtn(p, PadButton.L2, 0, true);
    r.frame();
    const s = r.mgr.slots[0]!;
    expect(s.value[PadButton.L2]).toBe(1);
    expect(padDown(s, PadButton.L2)).toBe(true);
  });

  it('out-of-range and non-finite button values are clamped to 0..1; buttons given as plain numbers work', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.R2, 1.7, true);
    setBtn(p, PadButton.L2, Number.NaN, false);
    p.buttons[PadButton.SOUTH]!.value = -3;
    (p.buttons as unknown[])[PadButton.EAST] = 1; // legacy numeric button
    r.frame();
    const s = r.mgr.slots[0]!;
    expect(s.value[PadButton.R2]).toBe(1);
    expect(s.value[PadButton.L2]).toBe(0);
    expect(s.value[PadButton.SOUTH]).toBe(0);
    expect(padDown(s, PadButton.EAST)).toBe(true);
    expect(padDown(s, PadButton.L2)).toBe(false);
    for (let b = 0; b < 16; b++) expect(Number.isFinite(s.value[b]!)).toBe(true);
  });
});

// ------------------------------------------------------------------ connect on press

describe('PAD-01 connect-on-press', () => {
  it('a pad is listed (active) only after a button press; sticks, Home (16) and Share (17) never activate it', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    r.frame();
    expect(r.mgr.slots).toHaveLength(1);
    expect(r.mgr.slots[0]!.active).toBe(false);
    expect(r.events).toEqual([['connect', 'pad:1']]);
    expect(r.changes).not.toHaveBeenCalled();
    p.axes = [1, 0, 0, -1];
    setBtn(p, 16, 1);
    setBtn(p, 17, 1);
    r.frame();
    r.frame();
    expect(r.mgr.slots[0]!.active).toBe(false);
    expect(r.mgr.slots[0]!.ordinal).toBe(0);
    expect(r.mgr.lastActiveKey).toBeNull();
    setBtn(p, PadButton.DPAD_LEFT, 1);
    const t = r.frame();
    const s = r.mgr.slots[0]!;
    expect(s.active).toBe(true);
    expect(s.ordinal).toBe(1);
    expect(r.events).toEqual([['connect', 'pad:1'], ['activate', 'pad:1']]);
    expect(r.changes).toHaveBeenCalledTimes(1);
    expect(r.mgr.lastActiveKey).toBe('pad:1');
    expect(r.mgr.lastActiveMs).toBe(t);
    // Home / Share are never reported as pressed.
    expect(s.pressed & ~0xffff).toBe(0);
  });

  it('a trigger past the threshold activates a pad; a light trigger touch does not', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.R2, 0.2, true);
    r.frame();
    expect(r.mgr.slots[0]!.active).toBe(false);
    setBtn(p, PadButton.R2, 0.6, true);
    r.frame();
    expect(r.mgr.slots[0]!.active).toBe(true);
  });

  it('a button already held when the pad first appears counts as the activating press', () => {
    const r = rig();
    const p = mockPad(0);
    setBtn(p, PadButton.SOUTH, 1);
    r.list[0] = p;
    r.frame();
    const s = r.mgr.slots[0]!;
    expect(s.active).toBe(true);
    expect(padPressedEdge(s, PadButton.SOUTH)).toBe(true);
  });

  it('a first tap shorter than a frame is not lost: the gamepadconnected snapshot activates the pad at the next poll', () => {
    const r = rig();
    const p = mockPad(0);
    setBtn(p, PadButton.SOUTH, 1);
    r.list[0] = p;
    r.connectEvent({ ...p, buttons: p.buttons.map((b) => ({ ...b })) });
    expect(r.mgr.slots).toHaveLength(1);
    expect(r.mgr.slots[0]!.active).toBe(false); // presence only: the press edge is left for the frame poll
    setBtn(p, PadButton.SOUTH, 0); // released before the next animation frame
    r.frame();
    expect(r.mgr.slots[0]!.active).toBe(true);
    expect(r.changes).toHaveBeenCalledTimes(1);
  });

  it('gamepadconnected without a pressed button (a pad switched on) does not list it', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    r.connectEvent(p);
    r.frame();
    r.frame();
    expect(r.mgr.slots[0]!.active).toBe(false);
    expect(r.changes).not.toHaveBeenCalled();
  });

  it('the connection event re-check does not consume a press edge (the next frame poll still sees it)', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.SOUTH, 1);
    r.frame();
    setBtn(p, PadButton.SOUTH, 0);
    r.frame();
    const q = mockPad(1, DS);
    r.list[1] = q;
    setBtn(p, PadButton.EAST, 1);
    r.connectEvent(q); // another pad arrives between two frames while pad 1 presses Circle
    r.frame();
    expect(padPressedEdge(r.mgr.find('pad:1')!, PadButton.EAST)).toBe(true);
  });

  it('gamepadHasPress ignores Home and Share and accepts numeric buttons', () => {
    const p = mockPad(0);
    setBtn(p, 16, 1);
    setBtn(p, 17, 1);
    expect(gamepadHasPress(p as unknown as Gamepad)).toBe(false);
    setBtn(p, PadButton.DPAD_DOWN, 1);
    expect(gamepadHasPress(p as unknown as Gamepad)).toBe(true);
    expect(gamepadHasPress({ buttons: [0, 1] } as unknown as Gamepad)).toBe(true);
    expect(gamepadHasPress(null)).toBe(false);
  });
});

// ------------------------------------------------------------------ edges

describe('PAD-01 edge detection', () => {
  it('poll is idempotent per timestamp: edges are neither lost nor doubled', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    r.mgr.poll(10);
    setBtn(p, PadButton.WEST, 1);
    r.mgr.poll(20);
    r.mgr.poll(20);
    const s = r.mgr.slots[0]!;
    expect(padPressedEdge(s, PadButton.WEST)).toBe(true);
    expect(padAnyPressedEdge(s)).toBe(true);
    r.mgr.poll(30);
    expect(padPressedEdge(s, PadButton.WEST)).toBe(false);
    expect(padDown(s, PadButton.WEST)).toBe(true);
    setBtn(p, PadButton.WEST, 0);
    r.mgr.poll(40);
    expect(padReleasedEdge(s, PadButton.WEST)).toBe(true);
    expect(padAnyPressedEdge(s)).toBe(false);
  });

  it('Home and Share presses are never an "any button" edge', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.SOUTH, 1);
    r.frame();
    setBtn(p, PadButton.SOUTH, 0);
    r.frame();
    setBtn(p, 16, 1);
    setBtn(p, 17, 1);
    r.frame();
    expect(padAnyPressedEdge(r.mgr.slots[0]!)).toBe(false);
  });

  it('lastInputMs and lastActiveKey follow the pad used last (button edge or stick deflection)', () => {
    const r = rig();
    const a = mockPad(0), b = mockPad(1, DS);
    r.list[0] = a; r.list[1] = b;
    setBtn(a, PadButton.SOUTH, 1);
    setBtn(b, PadButton.SOUTH, 1);
    r.frame();
    setBtn(a, PadButton.SOUTH, 0);
    setBtn(b, PadButton.SOUTH, 0);
    r.frame();
    b.axes[0] = 0.8;
    const t = r.frame();
    expect(r.mgr.lastActiveKey).toBe('pad:2');
    expect(r.mgr.find('pad:2')!.lastInputMs).toBe(t);
    b.axes[0] = 0;
    setBtn(a, PadButton.R1, 1);
    const t2 = r.frame();
    expect(r.mgr.lastActiveKey).toBe('pad:1');
    expect(r.mgr.lastActiveMs).toBe(t2);
  });
});

// ------------------------------------------------------------------ two pads, identity, reconnect

describe('PAD-01 two pads and identity', () => {
  it('two pads at once: own keys, own edges, ordinals in press order, instance numbers per identical id', () => {
    const r = rig();
    const a = mockPad(0), b = mockPad(1), c = mockPad(2, DS);
    r.list[0] = a; r.list[1] = b; r.list[2] = c;
    r.frame();
    expect(r.mgr.slots.map((s) => [s.key, s.instance])).toEqual([['pad:1', 1], ['pad:2', 2], ['pad:3', 1]]);
    setBtn(b, PadButton.EAST, 1);
    r.frame();
    setBtn(a, PadButton.SOUTH, 1);
    r.frame();
    const sa = r.mgr.find('pad:1')!, sb = r.mgr.find('pad:2')!;
    expect(sb.ordinal).toBe(1); // pressed first
    expect(sa.ordinal).toBe(2);
    expect(r.mgr.find('pad:3')!.active).toBe(false);
    expect(padPressedEdge(sa, PadButton.SOUTH)).toBe(true);
    expect(padPressedEdge(sb, PadButton.EAST)).toBe(false); // its edge was one frame earlier
    expect(padDown(sb, PadButton.SOUTH)).toBe(false);
    expect(r.changes).toHaveBeenCalledTimes(2);
  });

  it('reconnect at a new index keeps the binding: same key, ordinal and active flag; events disconnect -> reconnect', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.SOUTH, 1);
    r.frame();
    r.list[0] = null;
    r.frame();
    const s = r.mgr.find('pad:1')!;
    expect(s.connected).toBe(false);
    expect(s.index).toBe(-1);
    expect(s.lastIndex).toBe(0);
    expect(s.pad).toBeNull();
    const p2 = mockPad(3);
    r.list[3] = p2;
    r.frame();
    expect(r.mgr.slots).toHaveLength(1);
    expect(s.connected).toBe(true);
    expect(s.index).toBe(3);
    expect(s.active).toBe(true);
    expect(s.ordinal).toBe(1);
    expect(s.pad).toBe(p2 as unknown as Gamepad);
    expect(r.events).toEqual([['connect', 'pad:1'], ['activate', 'pad:1'], ['disconnect', 'pad:1'], ['reconnect', 'pad:1']]);
    expect(r.changes).toHaveBeenCalledTimes(3);
  });

  it('no stuck sprint or stick after a pad disconnect: every button, trigger and stick is zeroed at once', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.R2, 1);
    setBtn(p, PadButton.SOUTH, 1);
    p.axes = [-1, 0, 0.7, 0.7];
    r.frame();
    r.list[0] = null;
    r.frame();
    const s = r.mgr.find('pad:1')!;
    expect(s.pressed).toBe(0);
    expect([s.lx, s.ly, s.rx, s.ry]).toEqual([0, 0, 0, 0]);
    expect(Array.from(s.value).every((v) => v === 0)).toBe(true);
    expect(padReleasedEdge(s, PadButton.R2)).toBe(true);
  });

  it('a held button is a fresh press edge after the reconnect (any button can resume)', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.SOUTH, 1);
    r.frame();
    r.list[0] = null;
    r.frame();
    const p2 = mockPad(1);
    setBtn(p2, PadButton.NORTH, 1);
    r.list[1] = p2;
    r.frame();
    expect(padAnyPressedEdge(r.mgr.find('pad:1')!)).toBe(true);
  });

  it('two identical pads: the one that drops and returns at a new index keeps its own key', () => {
    const r = rig();
    const a = mockPad(0), b = mockPad(1);
    r.list[0] = a; r.list[1] = b;
    setBtn(a, PadButton.SOUTH, 1); setBtn(b, PadButton.SOUTH, 1);
    r.frame();
    r.list[1] = null;
    r.frame();
    r.list[2] = mockPad(2);
    r.frame();
    expect(r.mgr.slots).toHaveLength(2);
    expect(r.mgr.find('pad:1')!.index).toBe(0);
    expect(r.mgr.find('pad:2')!.index).toBe(2);
    expect(r.mgr.find('pad:2')!.connected).toBe(true);
  });

  it('two identical pads both drop: each returns to the slot it had at the same index, whatever the order', () => {
    const r = rig();
    const a = mockPad(0), b = mockPad(1);
    r.list[0] = a; r.list[1] = b;
    setBtn(a, PadButton.SOUTH, 1); setBtn(b, PadButton.SOUTH, 1);
    r.frame();
    r.list[0] = null; r.list[1] = null;
    r.frame();
    r.list[1] = mockPad(1); // pad 2 comes back first, at its old index
    r.frame();
    expect(r.mgr.find('pad:2')!.connected).toBe(true);
    expect(r.mgr.find('pad:1')!.connected).toBe(false);
    r.list[0] = mockPad(0);
    r.frame();
    expect(r.mgr.find('pad:1')!.index).toBe(0);
    expect(r.mgr.find('pad:2')!.index).toBe(1);
  });

  it('a reconnect prefers a pad that was pressed over a never-pressed one with the same id', () => {
    const r = rig();
    const a = mockPad(0), b = mockPad(1);
    r.list[0] = a; r.list[1] = b;
    setBtn(b, PadButton.SOUTH, 1); // only pad:2 is active
    r.frame();
    r.list[0] = null; r.list[1] = null;
    r.frame();
    r.list[3] = mockPad(3);
    r.frame();
    expect(r.mgr.find('pad:2')!.connected).toBe(true);
    expect(r.mgr.find('pad:1')!.connected).toBe(false);
  });

  it('a different controller at the old index is a new pad, not a reconnect', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.SOUTH, 1);
    r.frame();
    r.list[0] = mockPad(0, DS); // swapped within one frame
    r.frame();
    expect(r.mgr.find('pad:1')!.connected).toBe(false);
    expect(r.mgr.find('pad:2')!.gamepadId).toBe(DS);
    expect(r.mgr.find('pad:2')!.active).toBe(false);
  });

  it('a pad whose index changes while connected keeps its key without disconnect / reconnect events', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.SOUTH, 1);
    r.frame();
    r.events.length = 0;
    r.list[0] = null;
    p.index = 2;
    r.list[2] = p;
    r.frame();
    expect(r.mgr.find('pad:1')!.index).toBe(2);
    expect(r.mgr.find('pad:1')!.connected).toBe(true);
    expect(r.events).toEqual([]);
  });
});

// ------------------------------------------------------------------ connection events

describe('PAD-01 disconnect and connection events', () => {
  it('gamepaddisconnected releases the pad at once (no frame needed) and notifies subscribers once', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.R2, 1);
    r.frame();
    expect(r.changes).toHaveBeenCalledTimes(1);
    r.list[0] = null;
    p.connected = false;
    r.disconnectEvent(p);
    const s = r.mgr.find('pad:1')!;
    expect(s.connected).toBe(false);
    expect(s.pressed).toBe(0);
    expect(r.changes).toHaveBeenCalledTimes(2);
    r.frame(); // the polling diff agrees: no second notification
    expect(r.changes).toHaveBeenCalledTimes(2);
    expect(r.events.filter(([k]) => k === 'disconnect')).toHaveLength(1);
  });

  it('a gamepaddisconnected event while getGamepads still lists the pad changes nothing (polling is the truth)', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.SOUTH, 1);
    r.frame();
    r.disconnectEvent(p);
    expect(r.mgr.find('pad:1')!.connected).toBe(true);
    expect(r.changes).toHaveBeenCalledTimes(1);
  });

  it('the polling diff alone detects a disconnect when no event arrives', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.SOUTH, 1);
    r.frame();
    r.list[0] = null;
    r.frame();
    expect(r.mgr.find('pad:1')!.connected).toBe(false);
    expect(r.events.at(-1)).toEqual(['disconnect', 'pad:1']);
  });

  it('a listed Gamepad with connected === false counts as gone', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    setBtn(p, PadButton.SOUTH, 1);
    r.frame();
    p.connected = false;
    r.frame();
    expect(r.mgr.find('pad:1')!.connected).toBe(false);
  });

  it('a never-pressed pad that disconnects emits an event but does not change the device list', () => {
    const r = rig();
    r.list[0] = mockPad(0);
    r.frame();
    r.list[0] = null;
    r.frame();
    expect(r.events).toEqual([['connect', 'pad:1'], ['disconnect', 'pad:1']]);
    expect(r.changes).not.toHaveBeenCalled();
  });

  it('getGamepads throwing for a frame causes no spurious disconnect', () => {
    const list: (MockPad | null)[] = [mockPad(0)];
    let fail = false;
    const mgr = createPadManager(() => {
      if (fail) throw new Error('SecurityError');
      return list as unknown as Gamepad[];
    }, { eventTarget: null });
    setBtn(list[0]!, PadButton.SOUTH, 1);
    mgr.poll(1);
    fail = true;
    expect(() => mgr.poll(2)).not.toThrow();
    expect(mgr.find('pad:1')!.connected).toBe(true);
    expect(mgr.find('pad:1')!.pressed).not.toBe(0);
    fail = false;
    mgr.poll(3);
    expect(mgr.find('pad:1')!.connected).toBe(true);
  });

  it('a throwing listener does not corrupt state or starve other listeners; the error surfaces after', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    const later = vi.fn();
    r.mgr.subscribe(() => { throw new Error('boom'); });
    r.mgr.subscribe(later);
    setBtn(p, PadButton.SOUTH, 1);
    expect(() => r.frame()).toThrow('boom');
    expect(later).toHaveBeenCalledTimes(1);
    expect(r.mgr.find('pad:1')!.active).toBe(true);
    setBtn(p, PadButton.SOUTH, 0);
    expect(() => r.frame()).not.toThrow(); // nothing changed: no listener runs
  });

  it('unsubscribe and dispose stop notifications and detach the window listeners', () => {
    const r = rig();
    const p = mockPad(0);
    r.list[0] = p;
    const fn = vi.fn();
    const off = r.mgr.subscribe(fn);
    off();
    setBtn(p, PadButton.SOUTH, 1);
    r.frame();
    expect(fn).not.toHaveBeenCalled();
    r.mgr.dispose();
    r.list[0] = null;
    r.disconnectEvent(p);
    expect(r.mgr.find('pad:1')!.connected).toBe(true);
    r.frame();
    expect(r.mgr.find('pad:1')!.connected).toBe(true); // a disposed manager no longer polls
  });

  it('non-standard mapping is flagged for the remap screen; a pad with no buttons array does not throw', () => {
    const r = rig();
    const p = mockPad(0, 'Generic USB Joystick (Vendor: 0079 Product: 0006)');
    p.mapping = '';
    r.list[0] = p;
    r.frame();
    expect(r.mgr.slots[0]!.standard).toBe(false);
    (p as unknown as { buttons: unknown }).buttons = undefined;
    expect(() => r.frame()).not.toThrow();
    expect(r.mgr.slots[0]!.pressed).toBe(0);
  });

  it('slot count is capped: never-pressed disconnected pads are recycled, pressed ones are kept', () => {
    const r = rig();
    const keep = mockPad(0, 'Keeper pad');
    r.list[0] = keep;
    setBtn(keep, PadButton.SOUTH, 1);
    r.frame();
    for (let i = 0; i < MAX_PAD_SLOTS * 3; i++) {
      r.list[1] = mockPad(1, `Flaky virtual pad ${i}`);
      r.frame();
      r.list[1] = null;
      r.frame();
    }
    expect(r.mgr.slots.length).toBeLessThanOrEqual(MAX_PAD_SLOTS);
    expect(r.mgr.find('pad:1')!.active).toBe(true);
    expect(r.mgr.find('pad:1')!.connected).toBe(true);
  });
});
