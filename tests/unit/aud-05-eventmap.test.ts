/**
 * [AUD-05] Event-to-sound map and menu sounds: every EventType is routed or explicitly ignored, the cues each event
 * produces, same-tick dedupe (no double whistles, one glove per catch), the fallback whistle rules (not during
 * advantage, not when the rules already whistled), PHASE_CHANGE never whistles; the menu sounds (debounce, buffers
 * ready at once, menus pool) and the real event path engine -> eventMap -> sfx / whistles / crowd.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiSound } from '../../src/contracts/app';
import { CardKind, ChallengeKind, ChallengeOutcome, KickKind, MatchPhase, SaveKind } from '../../src/contracts/enums';
import { EventType, WhistleKind } from '../../src/contracts/events';
import { CrowdCue, type CrowdModule } from '../../src/audio/crowd';
import { createAudioEngine } from '../../src/audio/engine';
import { createEventMapScratch, dispatchEvents, EVENT_ROUTES, Route, type EventMapModule, type EventTargets } from '../../src/audio/eventMap';
import type { SfxModule } from '../../src/audio/sfx';
import { createUi, UI_SOUNDS, UI_TUNING, UiDebouncer, uiSoundLength, type UiModule } from '../../src/audio/ui';
import { StingKind, type WhistleModule } from '../../src/audio/whistles';
import { createEventBuffer } from '../../src/sim/core/events';
import { makeScenario } from '../harness/scenario';
import { asContext, bootRealEngine, createFakeContext, sourcesWithLength } from './aud-01-fakes';

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeTargets() {
  const crowd = { cue: vi.fn(), attackBuild: vi.fn() };
  const sfx = { kick: vi.fn(), bounce: vi.fn(), frame: vi.fn(), net: vi.fn(), tackle: vi.fn(), body: vi.fn(), glove: vi.fn() };
  const whistles = { whistle: vi.fn(), sting: vi.fn() };
  const targets = { crowd, sfx, whistles } as unknown as EventTargets;
  return { crowd, sfx, whistles, targets };
}

type Emit = [EventType, number?, number?, number?, number?, number?, number?, number?];

function setup() {
  const state = makeScenario({ phase: MatchPhase.IN_PLAY, ball: { x: 12, z: 3 } });
  state.players[9]!.x = 20;
  state.players[15]!.x = -8;
  const ev = createEventBuffer();
  const scratch = createEventMapScratch();
  const t = fakeTargets();
  let tick = 0;
  /** One sim tick with these events, dispatched. */
  const run = (...events: Emit[]): void => {
    ev.begin(++tick);
    for (const e of events) ev.emit(...e);
    dispatchEvents(ev, state, t.targets, scratch);
  };
  return { state, ev, scratch, run, ...t };
}

describe('AUD-05 map coverage', () => {
  it('every EventType is handled or explicitly ignored', () => {
    const types = Object.values(EventType).filter((v): v is EventType => typeof v === 'number');
    expect(types.length).toBeGreaterThan(30);
    for (const t of types) {
      expect(EVENT_ROUTES[t], EventType[t]).toBeDefined();
      expect(Object.values(Route)).toContain(EVENT_ROUTES[t]);
    }
    expect(Object.keys(EVENT_ROUTES).length).toBe(types.length);
    // The sounds the brief names are routed (not ignored).
    for (const t of [EventType.KICK, EventType.BOUNCE, EventType.POST, EventType.NET, EventType.WHISTLE, EventType.FOUL, EventType.CARD,
      EventType.OFFSIDE, EventType.SAVE, EventType.GOAL, EventType.SHOT, EventType.NEAR_MISS, EventType.TACKLE, EventType.BODY_CONTACT,
      EventType.PHASE_CHANGE, EventType.ATTACK_BUILD]) {
      expect(EVENT_ROUTES[t], EventType[t]).not.toBe(Route.IGNORE);
    }
  });
});

describe('AUD-05 event cues', () => {
  it('KICK -> sfx kick by kind and power at the event x; BOUNCE, POST (+ crowd), NET, TACKLE, BODY_CONTACT', () => {
    const h = setup();
    h.run([EventType.KICK, 9, KickKind.SHOT_POWER, 0.9, 0, 30, 0.1, 2]);
    expect(h.sfx.kick).toHaveBeenCalledWith(KickKind.SHOT_POWER, 0.9, 30);
    h.run([EventType.BOUNCE, 0, 0, 7, 0, -5, 0.1, 0]);
    expect(h.sfx.bounce).toHaveBeenCalledWith(7, -5);
    h.state.ball.lastTouchTeam = 1;
    h.run([EventType.POST, -1, 1, 18, 0, -52.5, 2.4, 1]);
    expect(h.sfx.frame).toHaveBeenCalledWith(true, 18, -52.5);
    expect(h.crowd.cue).toHaveBeenCalledWith(CrowdCue.WOODWORK, 1, 1);
    h.run([EventType.NET, 1, 0, 15]);
    expect(h.sfx.net).toHaveBeenCalledWith(15, 52.5);
    h.run([EventType.TACKLE, 9, 15, 1, ChallengeKind.SLIDE]);
    expect(h.sfx.tackle).toHaveBeenCalledWith(ChallengeKind.SLIDE, true, 20);
    h.run([EventType.BODY_CONTACT, 15, 1]);
    expect(h.sfx.body).toHaveBeenCalledWith(-8);
    // A position-less event falls back to the ball x.
    h.run([EventType.BOUNCE, 0, 0, 4]);
    expect(h.sfx.bounce).toHaveBeenLastCalledWith(4, 12);
  });

  it('WHISTLE -> whistles by kind; GOAL -> goal sting + crowd cheer for the scoring team', () => {
    const h = setup();
    for (const k of [WhistleKind.SHORT, WhistleKind.START, WhistleKind.LONG, WhistleKind.FINAL]) h.run([EventType.WHISTLE, k]);
    expect(h.whistles.whistle.mock.calls.map((c) => c[0])).toEqual([WhistleKind.SHORT, WhistleKind.START, WhistleKind.LONG, WhistleKind.FINAL]);
    h.run([EventType.WHISTLE, 9]); // unknown kind: ignored
    expect(h.whistles.whistle).toHaveBeenCalledTimes(4);
    h.run([EventType.GOAL, 1, 15, -1, 0, 52, 1, 0]);
    expect(h.whistles.sting).toHaveBeenCalledWith(StingKind.GOAL);
    expect(h.crowd.cue).toHaveBeenCalledWith(CrowdCue.GOAL, 1, 1);
  });

  it('SHOT, NEAR_MISS, SAVE, ATTACK_BUILD, SUBSTITUTION and shoot-out kicks drive the crowd', () => {
    const h = setup();
    h.run([EventType.SHOT, 9, 1, 0.3]);
    expect(h.crowd.cue.mock.lastCall!.slice(0, 2)).toEqual([CrowdCue.SHOT, 0]);
    expect(h.crowd.cue.mock.lastCall![2]).toBeCloseTo(0.96, 6);
    h.run([EventType.SHOT, 15, 0, 0.02]);
    const [, team, strength] = h.crowd.cue.mock.lastCall!;
    expect(team).toBe(1);
    expect(strength).toBeLessThan(0.5);
    h.run([EventType.NEAR_MISS, 9, 0, 0.5]);
    expect(h.crowd.cue.mock.lastCall![0]).toBe(CrowdCue.NEAR_MISS);
    expect(h.crowd.cue.mock.lastCall![2]).toBeCloseTo(1 - 0.5 / 4, 6);
    h.run([EventType.SAVE, 11, SaveKind.PARRY, 24, 0, 51, 1, 0]);
    expect(h.sfx.glove).toHaveBeenCalledWith(0.8, 51);
    expect(h.crowd.cue).toHaveBeenLastCalledWith(CrowdCue.SAVE, 1, 0.8);
    h.run([EventType.SAVE, 11, SaveKind.BLOCK, 10, 0, 51, 1, 0]);
    expect(h.sfx.body).toHaveBeenCalledWith(51);
    h.run([EventType.ATTACK_BUILD, 0, 0, 0.7]);
    expect(h.crowd.attackBuild).toHaveBeenCalledWith(0, 0.7);
    h.run([EventType.SUBSTITUTION, 1, 13, 15]);
    expect(h.crowd.cue).toHaveBeenLastCalledWith(CrowdCue.SUBSTITUTION, 1, 1);
    h.run([EventType.SHOOTOUT_KICK, 0, 1, 0]);
    expect(h.crowd.cue).toHaveBeenLastCalledWith(CrowdCue.SHOOTOUT_MISS, 0, 1);
    h.run([EventType.SHOOTOUT_KICK, 1, 1, 1]);
    expect(h.crowd.cue).toHaveBeenLastCalledWith(CrowdCue.GOAL, 1, 1);
  });

  it('PHASE_CHANGE: half-time applause and lull, full-time applause, and never a whistle (avoid duplicates)', () => {
    const h = setup();
    h.run([EventType.PHASE_CHANGE, MatchPhase.IN_PLAY, MatchPhase.HALF_TIME]);
    expect(h.crowd.cue).toHaveBeenLastCalledWith(CrowdCue.HALF_TIME, -1, 1);
    h.run([EventType.PERIOD_END, 1], [EventType.WHISTLE, WhistleKind.FINAL], [EventType.PHASE_CHANGE, MatchPhase.IN_PLAY, MatchPhase.FULL_TIME]);
    expect(h.crowd.cue).toHaveBeenLastCalledWith(CrowdCue.FULL_TIME, -1, 1);
    expect(h.whistles.whistle).toHaveBeenCalledTimes(1);
    expect(h.whistles.whistle).toHaveBeenCalledWith(WhistleKind.FINAL);
    h.run([EventType.PHASE_CHANGE, MatchPhase.KICK_OFF, MatchPhase.IN_PLAY]);
    expect(h.crowd.cue).toHaveBeenCalledTimes(2);
  });

  it('ignored events produce no sound', () => {
    const h = setup();
    h.run([EventType.PASS_COMPLETE, 9, 8], [EventType.POSSESSION, 1, 15], [EventType.SWITCH, 9, 8, 0], [EventType.RESTART_AWARDED, 1, 0],
      [EventType.TACTIC, 0, 1], [EventType.WATCHDOG, 1], [EventType.SKILL, 9, 1], [EventType.AERIAL, 9, 1], [EventType.WALL, 3], [EventType.FORFEIT, 0]);
    for (const fn of [...Object.values(h.sfx), ...Object.values(h.crowd), ...Object.values(h.whistles)]) expect(fn).not.toHaveBeenCalled();
  });
});

describe('AUD-05 dedupe and fallback whistles', () => {
  it('simultaneous duplicates within a tick play once; the next tick plays again', () => {
    const h = setup();
    h.run([EventType.KICK, 9, KickKind.GROUND_PASS, 0.5], [EventType.KICK, 10, KickKind.GROUND_PASS, 0.5], [EventType.INTERCEPT, 15, 9]);
    expect(h.sfx.kick).toHaveBeenCalledTimes(1);
    h.run([EventType.WHISTLE, WhistleKind.SHORT], [EventType.WHISTLE, WhistleKind.SHORT]);
    expect(h.whistles.whistle).toHaveBeenCalledTimes(1);
    expect(h.scratch.deduped).toBe(3);
    h.run([EventType.KICK, 9, KickKind.GROUND_PASS, 0.5]);
    expect(h.sfx.kick).toHaveBeenCalledTimes(2);
    // A catch reported as SAVE plus the KEEPER_HANDS pick-up: one glove.
    h.run([EventType.SAVE, 0, SaveKind.CATCH, 20, 0, -50, 1, 0], [EventType.KEEPER_HANDS, 0, 1]);
    expect(h.sfx.glove).toHaveBeenCalledTimes(1);
    h.run([EventType.KEEPER_HANDS, 0, 1]);
    expect(h.sfx.glove).toHaveBeenCalledTimes(2);
    h.run([EventType.KEEPER_HANDS, 0, 0]); // release: silent
    expect(h.sfx.glove).toHaveBeenCalledTimes(2);
  });

  it('a whistled foul gives one short whistle (the rules whistle with the restart in the same tick)', () => {
    const h = setup();
    h.run([EventType.FOUL, 15, 9, ChallengeOutcome.FOUL_YELLOW, 0, 20, 0, 1], [EventType.CARD, 15, CardKind.YELLOW],
      [EventType.RESTART_AWARDED, 6, 0], [EventType.WHISTLE, WhistleKind.SHORT]);
    expect(h.whistles.whistle).toHaveBeenCalledTimes(1);
    expect(h.whistles.whistle).toHaveBeenCalledWith(WhistleKind.SHORT);
    expect(h.crowd.cue).toHaveBeenCalledWith(CrowdCue.FOUL, 1, 0.75);
    expect(h.crowd.cue).toHaveBeenCalledWith(CrowdCue.CARD, 1, 0.5);
  });

  it('FOUL / CARD / OFFSIDE without a rules whistle blow a short one; a foul with advantage does not', () => {
    const h = setup();
    h.run([EventType.FOUL, 15, 9, ChallengeOutcome.FOUL, 0]);
    expect(h.whistles.whistle).toHaveBeenCalledTimes(1);
    h.run([EventType.FOUL, 15, 9, ChallengeOutcome.FOUL, 0], [EventType.ADVANTAGE, 1, 0]);
    expect(h.whistles.whistle).toHaveBeenCalledTimes(1);
    expect(h.crowd.cue).toHaveBeenCalledTimes(2); // the crowd still reacts to the foul
    h.run([EventType.CARD, 15, CardKind.RED]);
    expect(h.whistles.whistle).toHaveBeenCalledTimes(2);
    expect(h.crowd.cue).toHaveBeenLastCalledWith(CrowdCue.CARD, 1, 1);
    h.run([EventType.OFFSIDE, 9, 0, 0, 0, 30, 0, 4]);
    expect(h.whistles.whistle).toHaveBeenCalledTimes(3);
    h.run([EventType.OFFSIDE, 9], [EventType.WHISTLE, WhistleKind.SHORT]);
    expect(h.whistles.whistle).toHaveBeenCalledTimes(4);
    // A foul in the same tick as a long whistle (period end): only the long whistle.
    h.run([EventType.FOUL, 15, 9, ChallengeOutcome.FOUL, 0], [EventType.WHISTLE, WhistleKind.LONG]);
    expect(h.whistles.whistle).toHaveBeenCalledTimes(5);
    expect(h.whistles.whistle).toHaveBeenLastCalledWith(WhistleKind.LONG);
  });

  it('missing modules and bad slots never throw; an empty tick does nothing', () => {
    const h = setup();
    const none: EventTargets = { crowd: null, sfx: null, whistles: null };
    h.ev.begin(99);
    h.ev.emit(EventType.KICK, 99, KickKind.SHOT_NORMAL, 1);
    h.ev.emit(EventType.FOUL, -4, 77, 1, 0);
    h.ev.emit(EventType.GOAL, 0, 9);
    expect(() => dispatchEvents(h.ev, h.state, none, h.scratch)).not.toThrow();
    h.ev.begin(100);
    const call = h.scratch.call;
    dispatchEvents(h.ev, h.state, h.targets, h.scratch);
    expect(h.scratch.call).toBe(call);
    h.run([EventType.TACKLE, 99, -1, 0, ChallengeKind.STAND]);
    expect(h.sfx.tackle).toHaveBeenCalledWith(ChallengeKind.STAND, false, 12);
  });
});

describe('AUD-05 menu sounds', () => {
  it('debounce: a key-repeat burst gives one sound per interval, per kind independently', () => {
    const d = new UiDebouncer();
    expect(d.accept(UiSound.MOVE, 1)).toBe(true);
    expect(d.accept(UiSound.MOVE, 1.01)).toBe(false);
    expect(d.accept(UiSound.CONFIRM, 1.01)).toBe(true);
    expect(d.accept(UiSound.MOVE, 1 + UI_TUNING.debounce[UiSound.MOVE] + 0.001)).toBe(true);
    // A new context (clock restarted lower) is accepted.
    expect(d.accept(UiSound.MOVE, 0)).toBe(true);
    expect(d.accept(-1 as UiSound, 5)).toBe(false);
    expect(d.accept(UiSound.BACK, Number.NaN)).toBe(false);
    let n = 0;
    for (let t = 0; t < 1; t += 1 / 30) if (d.accept(UiSound.TOGGLE, 10 + t)) n++;
    expect(n).toBeLessThanOrEqual(Math.ceil(1 / UI_TUNING.debounce[UiSound.TOGGLE]) + 1);
    expect(n).toBeGreaterThan(5);
  });

  it('menu buffers are ready right after unlock (the splash START), play on the menus pool, short and soft', async () => {
    const boot = await bootRealEngine({ createEngine: createAudioEngine });
    const ui = boot.engine.services!.modules.ui as UiModule;
    for (const k of UI_SOUNDS) {
      expect(uiSoundLength(k)).toBeLessThan(0.5);
      boot.engine.playUi(k);
      boot.ac.advance(0.5);
    }
    expect(Array.from(ui.stats.played)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(ui.stats.fallback).toBe(0);
    expect(boot.engine.services!.menus.allocator.plays).toBe(7);
    // Key repeat: debounced.
    boot.engine.playUi(UiSound.MOVE);
    boot.engine.playUi(UiSound.MOVE);
    expect(ui.stats.debounced).toBe(1);
    expect(sourcesWithLength(boot.ac, Math.round(uiSoundLength(UiSound.START) * 48000)).length).toBe(1);
    boot.engine.dispose();
  });

  it('the bank renders menu sounds synchronously at module creation (no pump needed)', async () => {
    const { createBufferBank } = await import('../../src/audio/bank');
    const ac = createFakeContext({ state: 'running' });
    const bank = createBufferBank(asContext(ac));
    const g = asContext(ac).createGain();
    const settings = { get: () => ({}), update: () => undefined, subscribe: () => () => undefined } as never;
    const services = { bank, effects: null, crowd: null, menus: { play: vi.fn(() => 0) }, modules: {} };
    const ui = createUi({ ctx: asContext(ac), master: g, crowd: g, effects: g, menus: g, settings, services } as never);
    expect(bank.pending).toBe(0);
    ui.play(UiSound.CONFIRM);
    expect(services.menus.play).toHaveBeenCalledTimes(1);
  });

  it('falls back to an oscillator blip without engine services; silent while the context is not running', () => {
    const ac = createFakeContext({ state: 'running' });
    const g = asContext(ac).createGain();
    const settings = { get: () => ({}), update: () => undefined, subscribe: () => () => undefined } as never;
    const ui = createUi({ ctx: asContext(ac), master: g, crowd: g, effects: g, menus: g, settings });
    ui.play(UiSound.BACK);
    expect(ui.stats.fallback).toBe(1);
    expect(ac.created.oscillators.length).toBe(1);
    ac.state = 'suspended';
    ui.play(UiSound.ERROR);
    expect(ac.created.oscillators.length).toBe(1);
  });
});

describe('AUD-05 real event path (engine -> eventMap -> modules)', () => {
  it('sim events of a tick reach sfx, whistles and crowd; nothing plays while paused; no module errors', async () => {
    const boot = await bootRealEngine({ createEngine: createAudioEngine });
    const mods = boot.engine.services!.modules;
    const sfx = mods.sfx as SfxModule;
    const wh = mods.whistles as WhistleModule;
    const crowd = mods.crowd as CrowdModule;
    const map = mods.eventMap as EventMapModule;
    const state = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0 }] });
    boot.engine.matchStart(state);
    const ev = createEventBuffer();
    ev.begin(1);
    ev.emit(EventType.KICK, 9, KickKind.SHOT_NORMAL, 0.8, 0, 30, 0.1, 0);
    ev.emit(EventType.SHOT, 9, 1, 0.3);
    boot.engine.onEvents(ev, state);
    ev.begin(2);
    ev.emit(EventType.NET, 1, 0, 20, 0, 52.6, 1, 0);
    ev.emit(EventType.GOAL, 0, 9, -1, 0, 52.6, 1, 0);
    ev.emit(EventType.WHISTLE, WhistleKind.SHORT);
    boot.engine.onEvents(ev, state);
    expect(sfx.stats.played.reduce((a, b) => a + b, 0)).toBe(2);
    expect(wh.stats.whistles[WhistleKind.SHORT]).toBe(1);
    expect(wh.stats.stings[StingKind.GOAL]).toBe(1);
    expect(crowd.stats.reactions.reduce((a, b) => a + b, 0)).toBe(2);
    expect(map.scratch.call).toBe(2);
    boot.engine.setPaused(true);
    ev.begin(3);
    ev.emit(EventType.WHISTLE, WhistleKind.LONG);
    boot.engine.onEvents(ev, state);
    expect(wh.stats.whistles[WhistleKind.LONG]).toBe(0);
    expect(boot.errors).toEqual([]);
    expect(boot.engine.info().moduleFailures.every((n) => n === 0)).toBe(true);
    boot.engine.dispose();
  });
});
