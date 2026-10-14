/**
 * PAD-07 rumble: sim event -> rumble kind mapping (GOAL, POST, hard TACKLE), which humans feel it, the guarded
 * vibrationActuator.playEffect('dual-rumble') call (fallbacks and failures), the per-pad priority window and the
 * settings toggle, through createRumbleListener(registry, settings) with mock Gamepad objects.
 */
import { describe, expect, it } from 'vitest';
import type { SettingsStore } from '../../src/contracts/app';
import { ChallengeKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import { createPadManager, type PadManager } from '../../src/input/pad/manager';
import {
  createRumbleListener, playRumble, RUMBLE_PROFILES, RUMBLE_TUNING, rumbleHumans, rumbleKindForEvent, RumbleKind, rumbleTicks,
  stopRumble,
} from '../../src/input/pad/rumble';
import { createEventBuffer } from '../../src/sim/core/events';
import { makeScenario } from '../harness/scenario';
import { MatchPhase } from '../../src/contracts/enums';
import { mockPad, setBtn, type MockPad } from './pad-02-helpers';

function ev(type: EventType, a = 0, b = 0, c = 0, d = 0): SimEvent {
  return { type, tick: 10, a, b, c, d, x: 0, y: 0, z: 0 };
}

interface Effect { type: string; params: Record<string, number> }

function rumblePad(index: number): MockPad & { effects: Effect[]; resets: number } {
  const p = mockPad(index) as MockPad & { effects: Effect[]; resets: number; vibrationActuator: unknown };
  p.effects = [];
  p.resets = 0;
  p.vibrationActuator = {
    effects: ['dual-rumble'],
    playEffect: (type: string, params: Record<string, number>) => { p.effects.push({ type, params }); return Promise.resolve('complete'); },
    reset: () => { p.resets++; return Promise.resolve('complete'); },
  };
  return p;
}

function store(s: Settings): SettingsStore & { emit(): void } {
  const subs: ((v: Readonly<Settings>) => void)[] = [];
  return {
    get: () => s,
    update: (m) => { m(s); for (const f of subs) f(s); },
    subscribe: (f) => { subs.push(f); return () => subs.splice(subs.indexOf(f), 1); },
    reset: () => {}, persistent: false, loadProgress: () => null, saveProgress: () => {}, clearProgress: () => {},
    emit: () => { for (const f of subs) f(s); },
  };
}

function rig(): { mgr: PadManager; pads: ReturnType<typeof rumblePad>[]; t: { now: number } } {
  const pads = [rumblePad(0), rumblePad(1)];
  const list: (MockPad | null)[] = [pads[0]!, pads[1]!, null, null];
  const mgr = createPadManager(() => list as unknown as Gamepad[], { eventTarget: null });
  const t = { now: 1000 };
  // Activate both pads (a pad is listed once a button is pressed).
  for (const p of pads) setBtn(p, 0, 1);
  mgr.poll(t.now += 16);
  for (const p of pads) setBtn(p, 0, 0);
  mgr.poll(t.now += 16);
  return { mgr, pads, t };
}

describe('PAD-07 rumble event mapping', () => {
  it('GOAL, a scored shoot-out kick, POST and a HARD tackle rumble; everything else does not', () => {
    expect(rumbleKindForEvent(ev(EventType.GOAL))).toBe(RumbleKind.GOAL);
    expect(rumbleKindForEvent(ev(EventType.SHOOTOUT_KICK, 0, 1, 1))).toBe(RumbleKind.GOAL);
    expect(rumbleKindForEvent(ev(EventType.SHOOTOUT_KICK, 0, 1, 0))).toBe(RumbleKind.NONE);
    expect(rumbleKindForEvent(ev(EventType.POST, 1, 1))).toBe(RumbleKind.POST);
    expect(rumbleKindForEvent(ev(EventType.TACKLE, 3, 15, 1, ChallengeKind.HARD))).toBe(RumbleKind.HARD_TACKLE);
    for (const k of [ChallengeKind.STAND, ChallengeKind.SLIDE, ChallengeKind.SHOULDER, ChallengeKind.PUSH_PULL]) {
      expect(rumbleKindForEvent(ev(EventType.TACKLE, 3, 15, 1, k))).toBe(RumbleKind.NONE);
    }
    expect(rumbleKindForEvent(ev(EventType.BOUNCE))).toBe(RumbleKind.NONE);
    expect(rumbleKindForEvent(ev(EventType.SAVE))).toBe(RumbleKind.NONE);
  });

  it('goals and posts reach every human; a hard tackle only the humans controlling tackler or victim', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }, { side: 1, slot: 19 }] });
    expect(rumbleHumans(RumbleKind.GOAL, ev(EventType.GOAL), s)).toBe(0b11);
    expect(rumbleHumans(RumbleKind.POST, ev(EventType.POST), s)).toBe(0b11);
    expect(rumbleHumans(RumbleKind.HARD_TACKLE, ev(EventType.TACKLE, 9, 15, 1, ChallengeKind.HARD), s)).toBe(0b01);
    expect(rumbleHumans(RumbleKind.HARD_TACKLE, ev(EventType.TACKLE, 3, 19, 1, ChallengeKind.HARD), s)).toBe(0b10);
    expect(rumbleHumans(RumbleKind.HARD_TACKLE, ev(EventType.TACKLE, 3, 15, 1, ChallengeKind.HARD), s)).toBe(0);
    expect(rumbleHumans(RumbleKind.NONE, ev(EventType.GOAL), s)).toBe(0);
  });

  it('profiles: the goal is the strongest and longest; durations in ticks', () => {
    expect(RUMBLE_PROFILES[RumbleKind.GOAL].ms).toBeGreaterThan(RUMBLE_PROFILES[RumbleKind.POST].ms);
    expect(RUMBLE_PROFILES[RumbleKind.GOAL].strong).toBe(1);
    expect(rumbleTicks(450)).toBe(27);
    expect(rumbleTicks(-1)).toBe(0);
  });
});

describe('PAD-07 playRumble guards', () => {
  it('plays dual-rumble with clamped magnitudes and duration', () => {
    const p = rumblePad(0);
    expect(playRumble(p as unknown as Gamepad, 2, -1, 99999)).toBe(true);
    expect(p.effects[0]).toEqual({ type: 'dual-rumble', params: { startDelay: 0, duration: RUMBLE_TUNING.maxMs, strongMagnitude: 1, weakMagnitude: 0 } });
  });

  it('no actuator, a zero effect, a throwing or rejecting actuator never throw; hapticActuators is the fallback', () => {
    expect(playRumble(null, 1, 1, 100)).toBe(false);
    expect(playRumble(mockPad(0) as unknown as Gamepad, 1, 1, 100)).toBe(false);
    expect(playRumble(rumblePad(0) as unknown as Gamepad, 0, 0, 100)).toBe(false);
    const throwing = { vibrationActuator: { playEffect: () => { throw new Error('nope'); } } };
    expect(playRumble(throwing as unknown as Gamepad, 1, 1, 100)).toBe(false);
    const rejecting = { vibrationActuator: { playEffect: () => Promise.reject(new Error('preempted')) } };
    expect(playRumble(rejecting as unknown as Gamepad, 1, 1, 100)).toBe(true);
    const pulses: number[][] = [];
    const haptic = { vibrationActuator: { effects: ['trigger-rumble'], playEffect: () => 0 }, hapticActuators: [{ pulse: (v: number, ms: number) => { pulses.push([v, ms]); } }] };
    expect(playRumble(haptic as unknown as Gamepad, 0.4, 0.8, 120)).toBe(true);
    expect(pulses).toEqual([[0.8, 120]]);
    const p = rumblePad(0);
    stopRumble(p as unknown as Gamepad);
    expect(p.resets).toBe(1);
    stopRumble({ vibrationActuator: { reset: () => { throw new Error('x'); } } } as unknown as Gamepad);
  });
});

describe('PAD-07 createRumbleListener(registry, settings)', () => {
  function bufferWith(tick: number, ...events: [EventType, number, number, number, number][]) {
    const b = createEventBuffer();
    b.begin(tick);
    for (const [type, a, bb, c, d] of events) b.emit(type, a, bb, c, d);
    return b;
  }

  it('rumbles the pads bound in the match (boundPads) on a goal; unbound pads stay still', () => {
    const r = rig();
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }] });
    const registry = {
      pads: r.mgr, list: () => [], subscribe: () => () => {}, createSource: () => { throw new Error('unused'); }, lastActive: () => null,
      boundPads: () => [{ deviceId: 'pad:1', human: 0, connected: true }],
    };
    const l = createRumbleListener(registry, store(createDefaultSettings()));
    l.onEvents(bufferWith(100, [EventType.GOAL, 0, 9, -1, 0]), s);
    expect(r.pads[0]!.effects).toHaveLength(1);
    expect(r.pads[0]!.effects[0]!.params.strongMagnitude).toBe(RUMBLE_PROFILES[RumbleKind.GOAL].strong);
    expect(r.pads[1]!.effects).toHaveLength(0);
    l.dispose();
  });

  it('hard tackle: only the pad of the human whose player made or took it', () => {
    const r = rig();
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }, { side: 1, slot: 19 }] });
    const registry = {
      pads: r.mgr, list: () => [], subscribe: () => () => {}, createSource: () => { throw new Error('unused'); }, lastActive: () => null,
      boundPads: () => [{ deviceId: 'pad:1', human: 0, connected: true }, { deviceId: 'pad:2', human: 1, connected: true }],
    };
    const l = createRumbleListener(registry, store(createDefaultSettings()));
    l.onEvents(bufferWith(100, [EventType.TACKLE, 19, 4, 1, ChallengeKind.HARD]), s);
    expect(r.pads[0]!.effects).toHaveLength(0);
    expect(r.pads[1]!.effects).toHaveLength(1);
    l.onEvents(bufferWith(200, [EventType.TACKLE, 19, 4, 1, ChallengeKind.STAND]), s);
    expect(r.pads[1]!.effects).toHaveLength(1);
  });

  it('priority window: a post right after a goal does not cut the goal short; a goal replaces a post at once', () => {
    const r = rig();
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }] });
    const l = createRumbleListener(null, store(createDefaultSettings()), { pads: r.mgr });
    l.onEvents(bufferWith(100, [EventType.GOAL, 0, 9, -1, 0]), s);
    l.onEvents(bufferWith(105, [EventType.POST, 1, 0, 20, 0]), s);
    expect(r.pads[0]!.effects).toHaveLength(1);
    l.onEvents(bufferWith(100 + rumbleTicks(RUMBLE_PROFILES[RumbleKind.GOAL].ms) + 1, [EventType.POST, 1, 0, 20, 0]), s);
    expect(r.pads[0]!.effects).toHaveLength(2);
    l.onEvents(bufferWith(400, [EventType.POST, 1, 1, 20, 0]), s);
    l.onEvents(bufferWith(402, [EventType.POST, 1, 0, 20, 0]), s); // rattling bar -> post: one rumble
    expect(r.pads[0]!.effects).toHaveLength(3);
    l.onEvents(bufferWith(403, [EventType.GOAL, 0, 9, -1, 0]), s);
    expect(r.pads[0]!.effects).toHaveLength(4);
    // Every connected, active pad rumbles when the registry does not know the bindings.
    expect(r.pads[1]!.effects).toHaveLength(4);
  });

  it('the rumble setting: off plays nothing and stops a rumble in progress; on again plays', () => {
    const r = rig();
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }] });
    const settings = createDefaultSettings();
    const st = store(settings);
    const l = createRumbleListener(null, st, { pads: r.mgr });
    expect(l.enabled).toBe(true);
    st.update((x) => { x.controls.pad.rumble = false; });
    expect(l.enabled).toBe(false);
    expect(r.pads[0]!.resets).toBe(1);
    l.onEvents(bufferWith(100, [EventType.GOAL, 0, 9, -1, 0]), s);
    expect(r.pads[0]!.effects).toHaveLength(0);
    expect(l.play('pad:1', RumbleKind.POST)).toBe(false);
    st.update((x) => { x.controls.pad.rumble = true; });
    l.onEvents(bufferWith(200, [EventType.GOAL, 0, 9, -1, 0]), s);
    expect(r.pads[0]!.effects).toHaveLength(1);
    expect(l.play('pad:1', RumbleKind.POST)).toBe(true);
    l.dispose();
    l.onEvents(bufferWith(900, [EventType.GOAL, 0, 9, -1, 0]), s);
    expect(r.pads[0]!.effects).toHaveLength(2);
  });

  it('a disconnected pad is skipped; a settings source without subscribe is read on every event', () => {
    const r = rig();
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }] });
    const settings = createDefaultSettings();
    const l = createRumbleListener(null, { get: () => settings }, { pads: r.mgr });
    settings.controls.pad.rumble = false;
    l.onEvents(bufferWith(100, [EventType.GOAL, 0, 9, -1, 0]), s);
    expect(r.pads[0]!.effects).toHaveLength(0);
    settings.controls.pad.rumble = true;
    r.pads[1]!.connected = false;
    r.mgr.poll((r.t.now += 16));
    l.onEvents(bufferWith(200, [EventType.GOAL, 0, 9, -1, 0]), s);
    expect(r.pads[0]!.effects).toHaveLength(1);
    expect(r.pads[1]!.effects).toHaveLength(0);
  });
});
