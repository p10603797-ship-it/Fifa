/**
 * [AUD-01] Audio engine: unlock in a gesture, buses + limiter, smoothed volumes, pause ducking, module wiring and
 * isolation, services (voice pools, buffer bank pumped from update), suspend/resume and iOS interruption recovery.
 * Named regression tests for the glitch list "Audio" lines:
 *   - silent after returning from the background
 *   - crowd loop clicking
 *   - sounds stacking after a pause
 * The sound modules (AUD-02..05) are mocked: these tests pin the engine, not the sounds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiSound } from '../../src/contracts/app';
import { EventType } from '../../src/contracts/events';
import type { ReadonlySimState } from '../../src/contracts/state';
import { AUDIO_ENGINE_TUNING as T, busTargets, clampVolume, createAudioEngine, rampParam } from '../../src/audio/engine';
import { getAudioServices } from '../../src/audio/services';
import type { AudioCtx } from '../../src/audio/types';
import { createSettingsStore } from '../../src/platform/settingsStore';
import { createMemoryStorage } from '../../src/platform/storage';
import { createEventBuffer } from '../../src/sim/core/events';
import {
  asContext, createFakeContext, createFakeWindow, FakeBuffer, FakeParam, flush, GESTURE_TYPES, type FakeContext, type FakeGain,
} from './aud-01-fakes';

interface ModRecord {
  ctx: AudioCtx | null;
  created: number;
  events: number;
  updates: number;
  lastDt: number;
  paused: boolean[];
  starts: number;
  ends: number;
  disposed: number;
  plays: UiSound[];
  throwOnCreate: boolean;
  throwOnUpdate: boolean;
}

const mods = vi.hoisted(() => {
  const make = () => ({
    ctx: null, created: 0, events: 0, updates: 0, lastDt: 0, paused: [] as boolean[], starts: 0, ends: 0, disposed: 0,
    plays: [] as number[], throwOnCreate: false, throwOnUpdate: false,
  });
  return { crowd: make(), sfx: make(), whistles: make(), eventMap: make(), ui: make(), order: [] as string[] };
});

function mockModule(name: 'crowd' | 'sfx' | 'whistles' | 'eventMap' | 'ui', ctx: AudioCtx) {
  const r = mods[name] as unknown as ModRecord;
  mods.order.push(name);
  if (r.throwOnCreate) throw new Error(`${name} factory bug`);
  r.ctx = ctx;
  r.created++;
  return {
    onEvents() {
      r.events++;
    },
    update(_s: unknown, dt: number) {
      if (r.throwOnUpdate) throw new Error(`${name} update bug`);
      r.updates++;
      r.lastDt = dt;
    },
    setPaused(p: boolean) {
      r.paused.push(p);
    },
    matchStart() {
      r.starts++;
    },
    matchEnd() {
      r.ends++;
    },
    play(kind: UiSound) {
      r.plays.push(kind);
    },
    dispose() {
      r.disposed++;
    },
  };
}

vi.mock('../../src/audio/crowd', () => ({ createCrowd: (c: AudioCtx) => mockModule('crowd', c) }));
vi.mock('../../src/audio/sfx', () => ({ createSfx: (c: AudioCtx) => mockModule('sfx', c) }));
vi.mock('../../src/audio/whistles', () => ({ createWhistles: (c: AudioCtx) => mockModule('whistles', c) }));
vi.mock('../../src/audio/eventMap', () => ({ createEventMap: (c: AudioCtx) => mockModule('eventMap', c) }));
vi.mock('../../src/audio/ui', () => ({ createUi: (c: AudioCtx) => mockModule('ui', c) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ['crowd', 'sfx', 'whistles', 'eventMap', 'ui'] as const) {
    const r = mods[k] as unknown as ModRecord;
    Object.assign(r, {
      ctx: null, created: 0, events: 0, updates: 0, lastDt: 0, paused: [], starts: 0, ends: 0, disposed: 0, plays: [],
      throwOnCreate: false, throwOnUpdate: false,
    });
  }
  mods.order.length = 0;
});

const STATE = {} as ReadonlySimState;

function harness(opts: { pan?: boolean; compressor?: boolean; onModuleError?: (e: unknown, w: string) => void } = {}) {
  const win = createFakeWindow();
  vi.stubGlobal('window', win);
  const ac = createFakeContext({ pan: opts.pan, compressor: opts.compressor });
  const settings = createSettingsStore(createMemoryStorage());
  let clock = 0;
  const make = vi.fn(() => asContext(ac));
  const engine = createAudioEngine(settings, { createContext: make, onModuleError: opts.onModuleError, now: () => clock });
  const bus = () => {
    const [master, crowd, effects, menus, out] = ac.created.gains as FakeGain[];
    return { master: master!, crowd: crowd!, effects: effects!, menus: menus!, out: out! };
  };
  const tick = (ms: number) => {
    clock += ms;
  };
  return { win, ac, settings, engine, make, bus, tick };
}

/** Advance the audio clock and run update() frames of 1/60 s. */
function frames(ac: FakeContext, engine: ReturnType<typeof createAudioEngine>, n: number, dt = 1 / 60): void {
  for (let i = 0; i < n; i++) {
    ac.advance(dt);
    engine.update(STATE, dt);
  }
}

function oneEvent() {
  const ev = createEventBuffer();
  ev.begin(1);
  ev.emit(EventType.KICK, 1, 0, 0.5);
  return ev;
}

describe('AUD-01 pure mixing helpers', () => {
  it('clampVolume maps anything to 0..1 (non-numbers and NaN are silent)', () => {
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(9)).toBe(1);
    expect(clampVolume(-3)).toBe(0);
    expect(clampVolume(Number.NaN)).toBe(0);
    expect(clampVolume('loud')).toBe(0);
    expect(clampVolume(null)).toBe(0);
  });

  it('busTargets: crowd ducked and effects muted while paused, menus and master unchanged', () => {
    const out = { master: 0, crowd: 0, effects: 0, menus: 0 };
    const v = { master: 0.8, crowd: 0.6, effects: 0.9, menus: 0.7 };
    expect(busTargets(v, false, out)).toEqual({ master: 0.8, crowd: 0.6, effects: 0.9, menus: 0.7 });
    busTargets(v, true, out);
    expect(out.crowd).toBeCloseTo(0.6 * T.pauseCrowdDuck, 9);
    expect(out.crowd).toBeGreaterThan(0);
    expect(out.effects).toBe(0);
    expect(out.menus).toBe(0.7);
    expect(out.master).toBe(0.8);
    busTargets({ master: 9, crowd: -1, effects: Number.NaN, menus: 0.2 }, false, out);
    expect(out).toEqual({ master: 1, crowd: 0, effects: 0, menus: 0.2 });
  });

  it('rampParam: cancels pending automation, then approaches the target smoothly (no step)', () => {
    const clock = { currentTime: 1 };
    const p = new FakeParam(clock, 0.8);
    rampParam(p as unknown as AudioParam, 0.2, 1, T.volumeTimeConstant);
    expect(p.log).toEqual(['cancelScheduledValues', 'setTargetAtTime']);
    expect(p.valueAt(1)).toBeCloseTo(0.8, 9);
    expect(p.valueAt(1 + T.volumeTimeConstant)).toBeCloseTo(0.2 + 0.6 * Math.exp(-1), 6);
    expect(p.valueAt(1 + 5 * T.volumeTimeConstant)).toBeCloseTo(0.2, 2);
    // Largest per-sample change at 48 kHz: 0.6 / (tc * 48000) ~ 0.0004, far below an audible step.
    expect(p.maxStep(1, 1.2)).toBeLessThan(0.001);
    // A plain object without automation gets the value directly.
    const plain = { value: 0 };
    rampParam(plain as unknown as AudioParam, 0.7, 0, 0.03);
    expect(plain.value).toBe(0.7);
  });
});

describe('AUD-01 unlock and graph', () => {
  it('creates nothing before the gesture; unlock creates the context once and builds buses -> master -> out -> limiter', async () => {
    const { ac, engine, make, bus } = harness();
    engine.update(null, 1 / 60);
    engine.playUi(UiSound.CONFIRM);
    engine.setPaused(true);
    engine.setPaused(false);
    expect(make).not.toHaveBeenCalled();
    expect(engine.context).toBeNull();
    expect(engine.services).toBeNull();
    await engine.unlock();
    await engine.unlock();
    expect(make).toHaveBeenCalledTimes(1);
    expect(engine.unlocked).toBe(true);
    expect(ac.state).toBe('running');
    const { master, crowd, effects, menus, out } = bus();
    const limiter = ac.created.compressors[0]!;
    expect(crowd.outputs).toEqual([master]);
    expect(effects.outputs).toEqual([master]);
    expect(menus.outputs).toEqual([master]);
    expect(master.outputs).toEqual([out]);
    expect(out.outputs).toEqual([limiter]);
    expect(limiter.outputs).toEqual([ac.destination]);
    expect(limiter.threshold.value).toBe(T.limiterThreshold);
    expect(limiter.ratio.value).toBe(T.limiterRatio);
    // The old-iOS silent buffer went straight to the destination inside the gesture.
    expect(ac.created.sources[0]!.outputs).toEqual([ac.destination]);
    expect(ac.created.sources[0]!.startedAt).toBe(0);
  });

  it('without a compressor the output goes straight to the destination', async () => {
    const { ac, engine, bus } = harness({ compressor: false });
    await engine.unlock();
    expect(bus().out.outputs).toEqual([ac.destination]);
  });

  it('creates every module once with the services attached, in first-needed order', async () => {
    const { engine } = harness();
    await engine.unlock();
    await engine.unlock();
    for (const k of ['crowd', 'sfx', 'whistles', 'eventMap', 'ui'] as const) {
      const r = mods[k] as unknown as ModRecord;
      expect(r.created).toBe(1);
      const svc = getAudioServices(r.ctx!);
      expect(svc).toBe(engine.services);
    }
    expect(mods.order).toEqual(['ui', 'sfx', 'whistles', 'eventMap', 'crowd']);
    const svc = engine.services!;
    // Registry for cross-module cues (event map -> sfx/whistles/crowd), filled after every factory ran.
    for (const k of ['crowd', 'sfx', 'whistles', 'eventMap', 'ui'] as const) expect(svc.modules[k]).not.toBeNull();
    (svc.modules.sfx as unknown as { onEvents(): void }).onEvents();
    expect(mods.sfx.events).toBe(1);
    expect(svc.effects.capacity).toBe(T.effectsVoices);
    expect(svc.crowd.capacity).toBe(T.crowdVoices);
    expect(svc.menus.capacity).toBe(T.menusVoices);
    // Pools feed their own bus.
    const ctx = mods.sfx.ctx as unknown as AudioCtx;
    expect(getAudioServices({ ...ctx, services: undefined } as unknown as AudioCtx)).toBeNull();
  });

  it('a module whose factory throws is isolated: unlock still works, the others run, reported once', async () => {
    const errors: string[] = [];
    (mods.sfx as unknown as ModRecord).throwOnCreate = true;
    const { ac, engine } = harness({ onModuleError: (_e, w) => errors.push(w) });
    await engine.unlock();
    expect(ac.state).toBe('running');
    expect(errors).toEqual(['audio module 1 create']);
    expect(engine.services!.modules.sfx).toBeNull();
    expect(engine.services!.modules.whistles).not.toBeNull();
    engine.onEvents(oneEvent(), STATE);
    frames(ac, engine, 3);
    expect(mods.crowd.events).toBe(1);
    expect(mods.whistles.updates).toBe(3);
    engine.playUi(UiSound.MOVE);
    expect(mods.ui.plays).toEqual([UiSound.MOVE]);
  });

  it('a module that throws every frame is reported once and never stops the others', async () => {
    const errors: string[] = [];
    (mods.whistles as unknown as ModRecord).throwOnUpdate = true;
    const { ac, engine } = harness({ onModuleError: (_e, w) => errors.push(w) });
    await engine.unlock();
    frames(ac, engine, 30);
    expect(errors).toEqual(['audio module 2 update']);
    expect(mods.crowd.updates).toBe(30);
    expect(engine.info().moduleFailures[2]).toBe(30);
  });

  it('is a silent no-op without Web Audio', async () => {
    const engine = createAudioEngine(createSettingsStore(createMemoryStorage()), { createContext: () => null });
    await engine.unlock();
    engine.setPaused(true);
    engine.suspend();
    engine.resume();
    engine.update(null, 0.016);
    engine.onEvents(oneEvent(), STATE);
    engine.playUi(UiSound.BACK);
    engine.matchStart(STATE);
    engine.matchEnd();
    expect(engine.context).toBeNull();
    expect(engine.info().state).toBe('none');
    expect(engine.info().levels).toEqual({ master: 0, crowd: 0, effects: 0, menus: 0, output: 0 });
    engine.dispose();
  });
});

describe('AUD-01 volumes', () => {
  it('volume ramps: settings changes move every bus smoothly to the new level (no zipper/click)', async () => {
    const { ac, engine, settings, bus } = harness();
    await engine.unlock();
    const d = settings.get().audio;
    const { master, crowd, effects, menus } = bus();
    ac.currentTime = 2;
    expect(master.gain.valueAt(2)).toBeCloseTo(d.master, 3);
    settings.update((s) => {
      s.audio.master = 0.1;
      s.audio.crowd = 1;
      s.audio.effects = 0;
      s.audio.menus = 0.4;
    });
    for (const [g, target] of [[master, 0.1], [crowd, 1], [effects, 0], [menus, 0.4]] as const) {
      expect(g.gain.log).toContain('setTargetAtTime');
      expect(g.gain.maxStep(2, 2.3)).toBeLessThan(0.001);
      expect(g.gain.valueAt(2 + 6 * T.volumeTimeConstant)).toBeCloseTo(target, 2);
    }
  });

  it('setVolumes previews apply live and survive a pause toggle', async () => {
    const { ac, engine, bus } = harness();
    await engine.unlock();
    engine.setVolumes({ master: 0.5, crowd: 0.5, effects: 0.25, menus: 0.75 });
    engine.setPaused(true);
    engine.setPaused(false);
    ac.currentTime = 5;
    const { master, crowd, effects, menus } = bus();
    expect(master.gain.value).toBeCloseTo(0.5, 3);
    expect(crowd.gain.value).toBeCloseTo(0.5, 3);
    expect(effects.gain.value).toBeCloseTo(0.25, 3);
    expect(menus.gain.value).toBeCloseTo(0.75, 3);
  });

  it('pause ducks the crowd (ramped), mutes effects, keeps menus, and tells the modules', async () => {
    const { ac, engine, settings, bus } = harness();
    await engine.unlock();
    const d = settings.get().audio;
    ac.currentTime = 1;
    engine.setPaused(true);
    engine.setPaused(true); // idempotent
    expect(engine.paused).toBe(true);
    const { crowd, effects, menus } = bus();
    expect(crowd.gain.maxStep(1, 1.3)).toBeLessThan(0.001);
    expect(crowd.gain.valueAt(1.3)).toBeCloseTo(d.crowd * T.pauseCrowdDuck, 3);
    expect(effects.gain.valueAt(1.3)).toBeCloseTo(0, 3);
    expect(menus.gain.valueAt(1.3)).toBeCloseTo(d.menus, 3);
    expect(mods.crowd.paused).toEqual([true]);
    ac.currentTime = 1.3;
    const lv = engine.info().levels;
    expect(lv.crowd).toBeCloseTo(d.crowd * T.pauseCrowdDuck, 3);
    expect(lv.effects).toBeCloseTo(0, 3);
    expect(lv.menus).toBeCloseTo(d.menus, 3);
    expect(lv.output).toBe(1);
    ac.currentTime = 1;
    engine.setPaused(false);
    expect(crowd.gain.valueAt(1.6)).toBeCloseTo(d.crowd, 3);
    expect(mods.sfx.paused).toEqual([true, false]);
  });
});

describe('AUD-01 glitch: sounds stacking after a pause', () => {
  it('events are not passed on while paused, suspended or interrupted, so nothing queues up for the resume', async () => {
    const { ac, engine } = harness();
    await engine.unlock();
    const ev = oneEvent();
    engine.onEvents(ev, STATE);
    expect(mods.sfx.events).toBe(1);
    engine.setPaused(true);
    for (let i = 0; i < 20; i++) engine.onEvents(ev, STATE);
    expect(mods.sfx.events).toBe(1);
    engine.setPaused(false);
    engine.suspend(); // hidden page
    for (let i = 0; i < 20; i++) engine.onEvents(ev, STATE);
    engine.resume();
    await flush();
    ac.setState('interrupted'); // a call comes in
    for (let i = 0; i < 20; i++) engine.onEvents(ev, STATE);
    expect(mods.sfx.events).toBe(1);
    ac.setState('running');
    engine.onEvents(ev, STATE);
    expect(mods.sfx.events).toBe(2);
    expect(mods.crowd.events).toBe(2);
  });

  it('pausing stops every one-shot (effects and crowd reactions), so nothing resumes on unpause', async () => {
    const { ac, engine } = harness();
    await engine.unlock();
    const svc = engine.services!;
    const b = new FakeBuffer(1, 48000 * 3, 48000) as unknown as AudioBuffer;
    ac.currentTime = 1;
    for (let i = 0; i < 40; i++) svc.effects.play(b, 1);
    svc.crowd.play(b, 1);
    svc.menus.play(b, 1);
    expect(svc.effects.active()).toBe(T.effectsVoices); // capped, not 40
    engine.setPaused(true);
    ac.currentTime = 1 + T.stopFade + 0.001;
    expect(svc.effects.active()).toBe(0);
    expect(svc.crowd.active()).toBe(0);
    expect(svc.menus.active()).toBe(1); // menu sounds belong to the pause menu
    engine.setPaused(false);
    expect(svc.effects.active()).toBe(0);
    expect(engine.info().voices.effects).toBe(0);
  });

  it('match start and end stop leftover one-shots and reach the modules', async () => {
    const { ac, engine } = harness();
    await engine.unlock();
    const svc = engine.services!;
    const b = new FakeBuffer(1, 48000 * 3, 48000) as unknown as AudioBuffer;
    ac.currentTime = 1;
    svc.effects.play(b, 1);
    engine.matchEnd();
    ac.currentTime = 1.2;
    expect(svc.effects.active()).toBe(0);
    svc.effects.play(b, 1);
    engine.matchStart(STATE);
    ac.currentTime = 1.4;
    expect(svc.effects.active()).toBe(0);
    expect(mods.crowd.starts).toBe(1);
    expect(mods.crowd.ends).toBe(1);
  });
});

describe('AUD-01 glitch: silent after returning from the background', () => {
  it('hidden -> visible: suspend, resume and the output fades back in', async () => {
    const { ac, engine, bus } = harness();
    await engine.unlock();
    frames(ac, engine, 10);
    engine.suspend();
    expect(ac.state).toBe('suspended');
    expect(ac.suspend).toHaveBeenCalledTimes(1);
    const out = bus().out.gain;
    expect(out.valueAt(ac.currentTime)).toBe(0);
    engine.resume();
    await flush();
    expect(ac.state).toBe('running');
    const t = ac.currentTime;
    expect(out.valueAt(t + T.resumeFade + 0.001)).toBeCloseTo(1, 6);
    expect(engine.info().outputUp).toBe(true);
  });

  it('iPad touch: a refused resume arms pointerup/touchend/click too (touch pointerdown is no activation on iOS)', async () => {
    const { win, ac, engine } = harness();
    await engine.unlock();
    engine.suspend();
    ac.mode = 'refuse';
    engine.resume();
    await flush();
    expect(ac.state).toBe('suspended');
    for (const type of GESTURE_TYPES) expect(win.count(type)).toBe(1);
    // pointerdown carries no activation: still refused, listeners stay armed for the rest of the tap.
    win.fire('pointerdown');
    await flush();
    expect(ac.state).toBe('suspended');
    expect(win.count('touchend')).toBe(1);
    ac.mode = 'run';
    win.fire('touchend');
    await flush();
    expect(ac.state).toBe('running');
    expect(win.armed()).toBe(0);
  });

  it('iOS "interrupted" (call, Siri) while visible: the output goes down, the next tap brings it back', async () => {
    const { win, ac, engine, bus } = harness();
    await engine.unlock();
    frames(ac, engine, 5);
    ac.setState('interrupted');
    expect(bus().out.gain.valueAt(ac.currentTime)).toBe(0);
    expect(win.armed()).toBeGreaterThan(0);
    ac.mode = 'hang'; // resume() never settles while interrupted
    win.fire('pointerup');
    await flush();
    expect(ac.state).toBe('interrupted');
    expect(win.armed()).toBeGreaterThan(0);
    ac.mode = 'run';
    win.fire('click');
    await flush();
    expect(ac.state).toBe('running');
    expect(engine.info().outputUp).toBe(true);
    expect(bus().out.gain.valueAt(ac.currentTime + T.resumeFade + 0.001)).toBeCloseTo(1, 6);
  });

  it('a browser that misses the statechange event: update() notices the running context and fades the output in', async () => {
    const { ac, engine, bus } = harness();
    await engine.unlock();
    engine.suspend();
    ac.mode = 'refuse';
    engine.resume();
    await flush();
    ac.setStateQuiet('running'); // the OS resumed it, no event
    expect(engine.info().outputUp).toBe(false);
    frames(ac, engine, 1);
    expect(engine.info().outputUp).toBe(true);
    expect(bus().out.gain.valueAt(ac.currentTime + T.resumeFade + 0.001)).toBeCloseTo(1, 6);
    expect(engine.info().gestureArmed).toBe(false);
  });

  it('zombie context (says running, clock stopped after an interruption): detected, restarted on the next tap', async () => {
    const { win, ac, engine } = harness();
    await engine.unlock();
    frames(ac, engine, 10);
    expect(engine.info().stalled).toBe(false);
    // The clock stops but the state stays 'running'.
    const frozen = ac.currentTime;
    const n = Math.ceil(T.stallSec * 60) + 2;
    for (let i = 0; i < n; i++) engine.update(STATE, 1 / 60);
    expect(ac.currentTime).toBe(frozen);
    expect(engine.info().stalled).toBe(true);
    expect(win.armed()).toBeGreaterThan(0);
    win.fire('pointerup');
    await flush();
    expect(ac.suspend).toHaveBeenCalled();
    expect(ac.resume).toHaveBeenCalled();
    expect(ac.state).toBe('running');
    expect(engine.info().stalled).toBe(false);
    expect(engine.info().outputUp).toBe(true);
    expect(win.armed()).toBe(0);
    // A healthy clock after that never re-arms.
    frames(ac, engine, 120);
    expect(engine.info().stalled).toBe(false);
  });

  it('a context the OS resumes while the page is hidden is suspended again (no crowd in the background)', async () => {
    const { ac, engine } = harness();
    await engine.unlock();
    engine.suspend();
    const calls = ac.suspend.mock.calls.length;
    ac.setState('running');
    expect(ac.suspend.mock.calls.length).toBe(calls + 1);
    expect(ac.state).toBe('suspended');
    expect(engine.info().outputUp).toBe(false);
    // While hidden nothing is armed and nothing plays.
    expect(engine.info().gestureArmed).toBe(false);
    engine.playUi(UiSound.CONFIRM);
    expect(mods.ui.plays).toEqual([]);
  });

  it('a gesture-less unlock (pad confirm) that never ran: the next tap starts audio', async () => {
    const { win, ac, engine } = harness();
    ac.mode = 'refuse';
    await engine.unlock();
    expect(engine.unlocked).toBe(false);
    expect(win.armed()).toBeGreaterThan(0);
    engine.suspend();
    expect(win.armed()).toBe(0);
    engine.resume();
    expect(win.armed()).toBeGreaterThan(0);
    ac.mode = 'run';
    win.fire('keydown');
    await flush();
    expect(engine.unlocked).toBe(true);
    expect(ac.state).toBe('running');
  });
});

describe('AUD-01 glitch: crowd loop clicking', () => {
  it('resuming mid-loop never clicks: the output ramps up from silence over resumeFade', async () => {
    const { ac, engine, bus } = harness();
    await engine.unlock();
    frames(ac, engine, 30);
    engine.suspend();
    engine.resume();
    await flush();
    const out = bus().out.gain;
    const t = ac.currentTime;
    expect(out.valueAt(t)).toBe(0);
    expect(out.valueAt(t + T.resumeFade / 2)).toBeCloseTo(0.5, 3);
    // 48 kHz samples: the largest step is 1 / (resumeFade * 48000) ~ 0.00026.
    expect(out.maxStep(t, t + T.resumeFade + 0.01)).toBeLessThan(0.001);
    // Double running notifications do not restart the fade (no dip).
    ac.currentTime = t + 0.5;
    engine.resume();
    frames(ac, engine, 2);
    expect(out.maxStep(t + 0.5, t + 0.6)).toBe(0);
    expect(out.valueAt(t + 0.6)).toBe(1);
  });

  it('the first unlock also fades in, and pause ducking of the crowd bed is a ramp', async () => {
    const { ac, engine, bus } = harness();
    await engine.unlock();
    const { out, crowd } = bus();
    expect(out.gain.valueAt(0)).toBe(0);
    expect(out.gain.maxStep(0, 0.2)).toBeLessThan(0.001);
    ac.currentTime = 3;
    engine.setPaused(true);
    engine.setPaused(false);
    engine.setPaused(true);
    expect(crowd.gain.maxStep(3, 3.5)).toBeLessThan(0.001);
  });
});

describe('AUD-01 update, bank pumping and UI sounds', () => {
  it('update() pumps the buffer bank within its budget and clamps dt for the modules', async () => {
    const { ac, engine, tick } = harness();
    await engine.unlock();
    const bank = engine.services!.bank;
    let chunks = 0;
    const h = bank.define('test.long', 4, 1, (out, from, to) => {
      chunks++;
      tick(1); // 1 ms per chunk
      out[0]!.fill(0.1, from, to);
    });
    engine.update(STATE, 1 / 60);
    expect(chunks).toBeLessThanOrEqual(T.bankBudgetMs + 1);
    expect(bank.get(h)).toBeNull();
    for (let i = 0; i < 200 && bank.pending > 0; i++) frames(ac, engine, 1);
    expect(bank.get(h)).not.toBeNull();
    engine.update(STATE, 5); // a long stall: modules see at most maxDt
    expect(mods.crowd.lastDt).toBe(T.maxDt);
    engine.update(STATE, Number.NaN);
    expect(mods.crowd.lastDt).toBe(0);
  });

  it('modules are not updated while the context is not running (no automation against a frozen clock)', async () => {
    const { ac, engine } = harness();
    await engine.unlock();
    frames(ac, engine, 2);
    expect(mods.crowd.updates).toBe(2);
    engine.suspend();
    frames(ac, engine, 5);
    expect(mods.crowd.updates).toBe(2);
  });

  it('playUi plays only once the context runs', async () => {
    const { ac, engine } = harness();
    ac.mode = 'refuse';
    await engine.unlock();
    engine.playUi(UiSound.CONFIRM);
    expect(mods.ui.plays).toEqual([]);
    ac.setState('running');
    engine.playUi(UiSound.BACK);
    expect(mods.ui.plays).toEqual([UiSound.BACK]);
  });
});

describe('AUD-01 dispose', () => {
  it('closes the context, removes every listener and disposes modules and services; a later unlock starts fresh', async () => {
    const { win, ac, engine, make } = harness();
    ac.mode = 'refuse';
    await engine.unlock();
    expect(win.armed()).toBeGreaterThan(0);
    const svc = engine.services!;
    engine.dispose();
    expect(win.armed()).toBe(0);
    expect(ac.close).toHaveBeenCalled();
    expect(ac.listenerCount('statechange')).toBe(0);
    expect(mods.crowd.disposed).toBe(1);
    expect(mods.ui.disposed).toBe(1);
    expect(svc.effects.play(new FakeBuffer(1, 10, 48000) as unknown as AudioBuffer)).toBe(-1);
    expect(engine.services).toBeNull();
    expect(engine.context).toBeNull();
    expect(engine.unlocked).toBe(false);
    await engine.unlock();
    expect(make).toHaveBeenCalledTimes(2);
  });
});
