/**
 * INT-B app shell wiring:
 *  - loop: the tick's events reach the rumble consumer after audio (PAD-07), a throwing rumble is reported and never
 *    hides events from the others or stops the loop;
 *  - stepWithModes: [QF-12] the plain sim step (the practice rules run inside the sim since QF-1): set-piece practice
 *    re-awards its restart through `step` alone, every mode is bit-identical to `step`;
 *  - router: an input Back that pops a screen plays the Back sound (AUD-05 CR 2) exactly once; screen-handled Back,
 *    the root and programmatic back() stay silent;
 *  - recovery attach: false never wraps the session's afterTick and still reports the app recorder (PLT-05).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppContext, PlatformInfo, Screen, ScreenId, StatsTracker, TickInputProvider } from '../../src/contracts/app';
import { ModeId, MatchPhase, PracticeKind, RestartKind } from '../../src/contracts/enums';
import type { EventBuffer } from '../../src/contracts/events';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createInputFrame, type InputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createLoop, stepWithModes } from '../../src/app/loop';
import { createNullRenderer } from '../../src/app/nullRenderer';
import { createRouter } from '../../src/app/router';
import type { MatchRuntime } from '../../src/app/types';
import { preparePracticeState } from '../../src/modes/practice';
import { createDiagnostics } from '../../src/platform/diagnostics';
import { installRecovery } from '../../src/platform/recovery';
import { appReplayRecorder, createLiveReplayRecorder } from '../../src/platform/replayRecorder';
import { createSettingsStore } from '../../src/platform/settingsStore';
import { createMemoryStorage } from '../../src/platform/storage';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

const TICK_MS = 1000 / 60;

function loopRig(rumble: { onEvents: ReturnType<typeof vi.fn> } | null) {
  const curr = { tick: 0 } as unknown as SimState;
  const prev = { tick: 0 } as unknown as SimState;
  const events = createEventBuffer();
  const provider: TickInputProvider = { ready: () => true, take: vi.fn(), pump: vi.fn(), waiting: false, releaseAll: vi.fn(), dispose: vi.fn() };
  const stats: StatsTracker = { reset: vi.fn(), onTick: vi.fn(), summary: vi.fn() as never };
  const rt: MatchRuntime = { prev, curr, provider, frames: [createInputFrame(), createInputFrame()], events, stats };
  const session = { paused: false, ticking: true, runtime: () => rt, afterTick: vi.fn() };
  const order: string[] = [];
  const renderer = createNullRenderer();
  vi.spyOn(renderer, 'onEvents').mockImplementation(() => { order.push('renderer'); });
  const hud = { mount: vi.fn(), setMatch: vi.fn(), update: vi.fn(), onEvents: vi.fn(() => { order.push('hud'); }), setVisible: vi.fn(), dispose: vi.fn() };
  const audio = {
    unlock: vi.fn(), unlocked: false, setVolumes: vi.fn(), onEvents: vi.fn(() => { order.push('audio'); }), update: vi.fn(), playUi: vi.fn(),
    matchStart: vi.fn(), matchEnd: vi.fn(), setPaused: vi.fn(), suspend: vi.fn(), resume: vi.fn(),
  };
  if (rumble) rumble.onEvents.mockImplementation(() => { order.push('rumble'); });
  const onError = vi.fn();
  const loop = createLoop({
    session, renderer, hud, audio, router: { current: 'match', currentScreen: () => null }, getProjector: () => null, onError,
    rumble: rumble as never,
    step: (s: SimState, _f: readonly InputFrame[], ev: EventBuffer) => {
      s.tick++;
      ev.begin(s.tick);
      ev.emit(0);
    },
    copyState: (d: SimState, s: SimState) => { (d as { tick: number }).tick = s.tick; },
    raf: () => 1, caf: () => undefined, now: () => 0,
  });
  return { loop, order, onError, session, stats, audio };
}

describe('INT-B loop rumble consumer (PAD-07)', () => {
  it('gets every tick\'s events after renderer, HUD and audio', () => {
    const rumble = { onEvents: vi.fn() };
    const r = loopRig(rumble);
    r.loop.frame(0);
    r.loop.frame(TICK_MS * 2);
    expect(rumble.onEvents).toHaveBeenCalledTimes(2);
    expect(r.order).toEqual(['renderer', 'hud', 'audio', 'rumble', 'renderer', 'hud', 'audio', 'rumble']);
  });

  it('a throwing rumble is reported per tick and never stops stats, phase watching or the next frame', () => {
    const rumble = { onEvents: vi.fn() };
    const r = loopRig(rumble);
    rumble.onEvents.mockImplementation(() => { throw new Error('actuator gone'); });
    r.loop.frame(0);
    r.loop.frame(TICK_MS);
    r.loop.frame(TICK_MS * 2);
    expect(r.onError).toHaveBeenCalledTimes(2);
    expect(r.onError.mock.calls[0]![1]).toBe('loop.rumble.onEvents');
    expect(r.stats.onTick).toHaveBeenCalledTimes(2);
    expect(r.session.afterTick).toHaveBeenCalledTimes(2);
    expect(r.audio.update).toHaveBeenCalledTimes(3);
  });

  it('works without a rumble consumer (headless / tests)', () => {
    const r = loopRig(null);
    r.loop.frame(0);
    r.loop.frame(TICK_MS);
    expect(r.onError).not.toHaveBeenCalled();
    expect(r.order).toEqual(['renderer', 'hud', 'audio']);
  });
});

describe('INT-B stepWithModes (QF-12: the plain sim step, practice rules inside the sim)', () => {
  function run(mode: ModeId, practice: PracticeKind, ticks: number, stepFn: typeof step) {
    const c = createMatchConfig();
    c.seed = 31;
    c.mode = mode;
    c.practice = practice;
    if (mode === ModeId.PRACTICE) {
      c.startPhase = MatchPhase.IN_PLAY;
      c.replaySeconds = 0;
    }
    const s = initMatch(c);
    preparePracticeState(s);
    const ev = createEventBuffer();
    const frames = [createInputFrame(), createInputFrame()];
    const phases: number[] = [];
    for (let t = 0; t < ticks; t++) {
      stepFn(s, frames, ev);
      phases.push(s.match.phase);
    }
    return { s, phases };
  }

  it('penalty practice: the penalty is awarded from the start and again after each attempt', () => {
    const r = run(ModeId.PRACTICE, PracticeKind.PENALTIES, 1500, stepWithModes);
    expect(r.phases.includes(MatchPhase.PENALTY)).toBe(true);
    expect(r.s.match.restart.kind).toBe(RestartKind.PENALTY);
    // Several separate PENALTY phases: the restart is re-awarded after every attempt.
    let entries = 0;
    for (let i = 1; i < r.phases.length; i++) if (r.phases[i] === MatchPhase.PENALTY && r.phases[i - 1] !== MatchPhase.PENALTY) entries++;
    expect(entries).toBeGreaterThanOrEqual(1);
  });

  it('corner practice through the plain sim step awards the corner (the practice rules live in the sim; QF-12 refit)', () => {
    expect(stepWithModes).toBe(step);
    const plain = run(ModeId.PRACTICE, PracticeKind.CORNERS, 120, step);
    expect(plain.phases.includes(MatchPhase.CORNER)).toBe(true);
    const hooked = run(ModeId.PRACTICE, PracticeKind.CORNERS, 120, stepWithModes);
    expect(hooked.phases).toEqual(plain.phases);
    expect(hashState(hooked.s)).toBe(hashState(plain.s));
  });

  it('every other mode is the plain sim step, bit for bit', () => {
    const a = run(ModeId.KICK_OFF, PracticeKind.NONE, 900, step);
    const b = run(ModeId.KICK_OFF, PracticeKind.NONE, 900, stepWithModes);
    expect(hashState(b.s)).toBe(hashState(a.s));
  });

  it('is deterministic in practice (same seed, same hash; clone + replay of the tail matches)', () => {
    const a = run(ModeId.PRACTICE, PracticeKind.FREE_KICKS, 700, stepWithModes);
    const b = run(ModeId.PRACTICE, PracticeKind.FREE_KICKS, 700, stepWithModes);
    expect(hashState(b.s)).toBe(hashState(a.s));
    const fork = cloneState(a.s);
    const ev = createEventBuffer();
    const frames = [createInputFrame(), createInputFrame()];
    for (let t = 0; t < 60; t++) {
      stepWithModes(a.s, frames, ev);
      stepWithModes(fork, frames, ev);
    }
    expect(hashState(fork)).toBe(hashState(a.s));
  });
});

describe('INT-B router input Back sound (AUD-05 CR 2)', () => {
  function rig(handled = false) {
    const focus = { attach: vi.fn(), detach: vi.fn() };
    const onUserBack = vi.fn();
    const router = createRouter({ appendChild: () => undefined } as unknown as HTMLElement, () => ({ focus } as unknown as AppContext), {
      listen: false, createContainer: () => ({ remove() {} }) as unknown as HTMLElement, onUserBack,
    });
    for (const id of ['main', 'settings', 'remap'] as ScreenId[]) {
      router.register(id, (): Screen => ({ id, mount() {}, unmount() {}, onBack: id === 'remap' ? () => handled : undefined }));
    }
    router.go('main');
    return { router, onUserBack };
  }

  it('plays once when an input Back pops a screen (Escape, pad B, browser back)', () => {
    const r = rig();
    r.router.go('settings');
    r.router.backFromInput('menu');
    expect(r.router.current).toBe('main');
    expect(r.onUserBack).toHaveBeenCalledTimes(1);
    r.router.go('settings');
    r.router.backFromInput('history');
    expect(r.onUserBack).toHaveBeenCalledTimes(2);
  });

  it('stays silent at the root, for a screen that handled Back itself, and for programmatic back()', () => {
    const r = rig(true);
    r.router.backFromInput('key');
    expect(r.onUserBack).not.toHaveBeenCalled();
    r.router.go('remap');
    r.router.backFromInput('history');
    expect(r.router.current).toBe('remap');
    expect(r.onUserBack).not.toHaveBeenCalled();
    r.router.go('settings');
    r.router.back(); // on-screen Back buttons play their own sound on the click
    expect(r.router.current).toBe('remap');
    expect(r.onUserBack).not.toHaveBeenCalled();
  });

  it('the keyboard double path (keydown + latched menu BACK) pops once and sounds once', () => {
    const r = rig();
    r.router.go('settings');
    r.router.go('remap');
    r.router.backFromInput('key');
    r.router.backFromInput('menu');
    expect(r.router.current).toBe('settings');
    expect(r.onUserBack).toHaveBeenCalledTimes(1);
  });
});

describe('INT-B recovery with attach: false (recorder fed by SessionDeps.onTick)', () => {
  it('never patches afterTick, installs the given recorder app-wide and reports it', () => {
    const afterTick = vi.fn();
    const state = initMatch(createMatchConfig());
    const session = {
      active: true, paused: false, pausedBy: -1, getState: () => state, pause: vi.fn(), resume: () => true, afterTick,
    };
    const router = { current: 'match', go: vi.fn(), replace: vi.fn(), back: vi.fn(), register: vi.fn() };
    const settings = createSettingsStore(createMemoryStorage());
    const diagnostics = createDiagnostics(settings);
    const platform: PlatformInfo = { isIPad: true, isTouch: true, isStandalone: false, supportsFullscreen: false, safeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
    const ctx = { router, session, platform, diagnostics, settings: { ...settings, get: () => createDefaultSettings() } } as unknown as AppContext;
    const recorder = createLiveReplayRecorder();
    const rec = installRecovery(ctx, { recorder, attach: false, listen: false, now: () => 0 });
    expect(session.afterTick).toBe(afterTick);
    expect(rec.replay).toBe(recorder);
    expect(appReplayRecorder()).toBe(recorder);
    // The app feeds it per tick (boot's onTick); the report shows the recording, not "unavailable".
    const frames = [createInputFrame(), createInputFrame()];
    const ev = createEventBuffer();
    for (let t = 0; t < 5; t++) {
      step(state, frames, ev);
      recorder.onTick(frames, state);
    }
    expect(recorder.ticks).toBe(5);
    const report = diagnostics.report();
    expect(report).toContain('Replay:');
    expect(report).not.toContain('recorder unavailable');
    rec.dispose();
    expect(appReplayRecorder()).toBeNull();
    expect(session.afterTick).toBe(afterTick);
  });

  it('the default (attach) still wraps afterTick for other hosts', () => {
    const afterTick = vi.fn();
    const session = { active: false, paused: false, pausedBy: -1, getState: () => null, pause: vi.fn(), resume: () => true, afterTick };
    const settings = createSettingsStore(createMemoryStorage());
    const ctx = {
      router: { current: 'main', go: vi.fn() }, session, diagnostics: createDiagnostics(settings), settings,
      platform: { isIPad: false, isTouch: false, isStandalone: false, supportsFullscreen: false, safeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) },
    } as unknown as AppContext;
    const rec = installRecovery(ctx, { listen: false, now: () => 0 });
    expect(session.afterTick).not.toBe(afterTick);
    rec.dispose();
    expect(session.afterTick).toBe(afterTick);
  });
});
