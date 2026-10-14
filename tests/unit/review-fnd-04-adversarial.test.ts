/**
 * REVIEW of FND-04 (independent reviewer): adversarial unit tests for the app shell.
 * Pure logic only (node environment): loop timing under hostile rAF timestamps, loop stage isolation, audio resume
 * after backgrounding on iOS, session lifecycle races, router re-entrancy and local input merging.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppContext, DeviceInfo, DeviceRegistry, FrameInfo, HumanBinding, MatchSetup, Screen, ScreenId, ScreenParams, StatsTracker,
  TickInputProvider,
} from '../../src/contracts/app';
import { MatchPhase } from '../../src/contracts/enums';
import { Btn, createInputFrame, type InputFrame, type InputSource } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createLoop } from '../../src/app/loop';
import { beginFrame, createLoopTiming, endFrame, resetLoopTiming, TICK_MS, type LoopTiming } from '../../src/app/loopMath';
import { createNullRenderer } from '../../src/app/nullRenderer';
import { createRouter } from '../../src/app/router';
import { createSession, type SessionDeps } from '../../src/app/session';
import { ANY_DEVICE, createLocalInputProvider, type LocalInputProvider } from '../../src/app/localInput';
import type { AppSession, MatchRuntime } from '../../src/app/types';
import { createAudioEngine } from '../../src/audio/engine';
import { createMemoryStorage } from '../../src/platform/storage';
import { createSettingsStore } from '../../src/platform/settingsStore';
import { createStatsTracker } from '../../src/modes/stats';
import { createEventBuffer } from '../../src/sim/core/events';
import type { EventBuffer } from '../../src/contracts/events';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ================================================================ loop timing under hostile timestamps

/** Feed explicit frame timestamps; returns ticks run. */
function feed(t: LoopTiming, stamps: readonly number[]): number {
  let ticks = 0;
  for (const s of stamps) {
    const due = beginFrame(t, s);
    ticks += due;
    endFrame(t, due, false);
  }
  return ticks;
}

/** Deterministic pseudo-random jitter in [-amp, amp] (no Math.random so failures reproduce). */
function jitterSeq(n: number, amp: number): number[] {
  const out: number[] = [];
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out.push(((x / 0xffffffff) * 2 - 1) * amp);
  }
  return out;
}

describe('REVIEW FND-04 loop timing (adversarial)', () => {
  it('120 Hz ProMotion with +-0.6 ms timestamp jitter keeps real-time speed over 60 s', () => {
    const t = createLoopTiming();
    const j = jitterSeq(7200, 0.6);
    const stamps: number[] = [];
    for (let i = 0; i <= 7200; i++) stamps.push(1000 + i * (1000 / 120) + (i > 0 && i < 7200 ? j[i]! : 0));
    const ticks = feed(t, stamps);
    expect(Math.abs(ticks - 3600)).toBeLessThanOrEqual(2);
  });

  it('Safari-style 1 ms quantised 60 Hz timestamps keep real-time speed over 60 s', () => {
    const t = createLoopTiming();
    const stamps: number[] = [];
    for (let i = 0; i <= 3600; i++) stamps.push(Math.round(1000 + i * (1000 / 60)));
    const ticks = feed(t, stamps);
    expect(Math.abs(ticks - 3600)).toBeLessThanOrEqual(1);
  });

  it('refresh rate switching 120 -> 60 -> 120 Hz mid-match (ProMotion power saving) keeps speed', () => {
    const t = createLoopTiming();
    const stamps: number[] = [];
    let now = 0;
    stamps.push(now);
    for (let i = 0; i < 240; i++) stamps.push((now += 1000 / 120));
    for (let i = 0; i < 120; i++) stamps.push((now += 1000 / 60));
    for (let i = 0; i < 240; i++) stamps.push((now += 1000 / 120));
    const ticks = feed(t, stamps);
    expect(Math.abs(ticks - now / TICK_MS)).toBeLessThanOrEqual(1);
  });

  it('duplicate and backwards timestamps never add time, then real time resumes normally', () => {
    const t = createLoopTiming();
    expect(feed(t, [1000, 1000, 1000, 990, 980])).toBe(0);
    // From the last seen timestamp (980), 1 s at 60 Hz.
    const stamps: number[] = [];
    for (let i = 1; i <= 60; i++) stamps.push(980 + i * (1000 / 60));
    expect(Math.abs(feed(t, stamps) - 60)).toBeLessThanOrEqual(1);
  });

  it('a 5 s hitch (debugger, GC, tab throttling) runs at most MAX_TICKS_PER_FRAME and keeps no backlog', () => {
    const t = createLoopTiming();
    feed(t, [0, 1000 / 60]);
    expect(feed(t, [5000 + 1000 / 60])).toBeLessThanOrEqual(3);
    // The next normal frame runs one tick, not a catch-up burst.
    expect(feed(t, [5000 + 2000 / 60])).toBe(1);
  });

  it('NaN / Infinity timestamps (broken polyfills) never poison the accumulator', () => {
    const t = createLoopTiming();
    feed(t, [0, Number.NaN, Number.POSITIVE_INFINITY, 16.67]);
    expect(Number.isFinite(t.acc)).toBe(true);
    // The loop recovers: one more normal second gives about 60 ticks.
    const base = 2000;
    resetLoopTiming(t);
    const stamps: number[] = [];
    for (let i = 0; i <= 60; i++) stamps.push(base + i * (1000 / 60));
    expect(Math.abs(feed(t, stamps) - 60)).toBeLessThanOrEqual(1);
  });
});

// ================================================================ loop stage isolation

function loopHarness(over: { pumpThrows?: boolean; audioThrows?: boolean; hudThrows?: boolean } = {}) {
  const curr = { tick: 0 } as unknown as SimState;
  const prev = { tick: 0 } as unknown as SimState;
  const provider: TickInputProvider = {
    ready: () => true,
    take: vi.fn(),
    pump: vi.fn(() => {
      if (over.pumpThrows) throw new Error('pad pollFrame bug');
    }),
    waiting: false,
    releaseAll: vi.fn(),
    dispose: vi.fn(),
  };
  const stats: StatsTracker = { reset: vi.fn(), onTick: vi.fn(), summary: vi.fn() as never };
  const rt: MatchRuntime = { prev, curr, provider, frames: [createInputFrame(), createInputFrame()], events: createEventBuffer(), stats };
  const session = { paused: true, ticking: false, runtime: () => rt, afterTick: vi.fn() };
  const renderer = createNullRenderer();
  const hud = {
    mount: vi.fn(), setMatch: vi.fn(), onEvents: vi.fn(), setVisible: vi.fn(), dispose: vi.fn(),
    update: vi.fn(() => {
      if (over.hudThrows) throw new Error('hud part bug');
    }),
  };
  const audio = {
    unlock: vi.fn(), unlocked: false, setVolumes: vi.fn(), onEvents: vi.fn(), playUi: vi.fn(),
    matchStart: vi.fn(), matchEnd: vi.fn(), setPaused: vi.fn(), suspend: vi.fn(), resume: vi.fn(),
    update: vi.fn(() => {
      if (over.audioThrows) throw new Error('crowd module bug');
    }),
  };
  const onFrame = vi.fn((f: FrameInfo) => void f);
  const router = { current: 'recovery' as const, currentScreen: () => ({ id: 'recovery' as const, mount() {}, unmount() {}, onFrame }) };
  const menuInput = { poll: vi.fn() };
  const onError = vi.fn();
  const step = vi.fn((s: SimState, _f: unknown, ev: EventBuffer) => {
    s.tick++;
    ev.begin(s.tick);
  });
  const loop = createLoop({
    session, renderer, hud, audio, router, menuInput, getProjector: () => null, onError, step,
    copyState: (d, s) => { (d as { tick: number }).tick = s.tick; },
    raf: () => 1, caf: () => undefined, now: () => 0,
  });
  return { loop, menuInput, onFrame, onError, session };
}

describe('REVIEW FND-04 loop stage isolation', () => {
  // Brief section 12: every screen works by controller alone. If one per-frame stage throws every frame (a Wave 1
  // bug in a pad source's pollFrame or an audio module's update), the rest of the frame must still run: menu input
  // must still be polled (controller users must be able to use the recovery screen) and screen.onFrame must run.
  it('a provider.pump that throws every frame does not stop menu input polling', () => {
    const h = loopHarness({ pumpThrows: true });
    for (let i = 0; i < 5; i++) h.loop.frame(i * TICK_MS);
    expect(h.onError).toHaveBeenCalled();
    expect(h.menuInput.poll).toHaveBeenCalledTimes(5);
    expect(h.onFrame).toHaveBeenCalledTimes(5);
  });

  it('an audio.update that throws every frame does not stop menu input polling', () => {
    const h = loopHarness({ audioThrows: true });
    for (let i = 0; i < 5; i++) h.loop.frame(i * TICK_MS);
    expect(h.onError).toHaveBeenCalled();
    expect(h.menuInput.poll).toHaveBeenCalledTimes(5);
    expect(h.onFrame).toHaveBeenCalledTimes(5);
  });
});

// ================================================================ audio: iOS resume after backgrounding

function fakeAudio() {
  const listeners: Record<string, (() => void)[]> = {};
  const ac = {
    state: 'suspended' as AudioContextState | 'interrupted',
    currentTime: 0,
    destination: {},
    createGain: () => ({ gain: { value: 1, setTargetAtTime() {} }, connect() {}, disconnect() {} }),
    createBuffer: () => ({}),
    createBufferSource: () => ({ buffer: null, connect() {}, start() {} }),
    /** iOS outside a user gesture: resolves but the context stays suspended. */
    resumeRefused: false,
    resume: vi.fn(() => {
      if (!ac.resumeRefused) {
        ac.state = 'running';
        for (const fn of listeners.statechange ?? []) fn();
      }
      return Promise.resolve();
    }),
    suspend: vi.fn(() => {
      ac.state = 'suspended';
      for (const fn of listeners.statechange ?? []) fn();
      return Promise.resolve();
    }),
    close: vi.fn(() => Promise.resolve()),
    addEventListener: (type: string, fn: () => void) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  return ac;
}

function fakeWindow() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    handlers,
    addEventListener: vi.fn((type: string, fn: () => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: () => void) => {
      handlers.get(type)?.delete(fn);
    }),
    fire(type: string) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn();
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('REVIEW FND-04 audio after backgrounding', () => {
  // Brief section 3 "Audio: resume the audio context after interruptions and when the page becomes visible" and the
  // glitch list "Audio: silent after returning from the background". iOS refuses AudioContext.resume() outside a
  // user gesture: the promise settles but the context stays suspended. The next tap must bring the sound back.
  it('arms a gesture resume when resume() on return from the background leaves the context suspended', async () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);
    const ac = fakeAudio();
    const engine = createAudioEngine(createSettingsStore(createMemoryStorage()), { createContext: () => ac as unknown as AudioContext });
    await engine.unlock(); // splash tap
    expect(ac.state).toBe('running');
    engine.suspend(); // page hidden
    await flush();
    ac.resumeRefused = true; // iOS: no gesture on visibilitychange
    engine.resume(); // page visible again
    await flush();
    expect(ac.state).toBe('suspended');
    // Expected: a pointerdown/keydown listener is now armed so the player's next tap resumes the context.
    const armed = (win.handlers.get('pointerdown')?.size ?? 0) + (win.handlers.get('keydown')?.size ?? 0);
    expect(armed).toBeGreaterThan(0);
    ac.resumeRefused = false;
    win.fire('pointerdown');
    await flush();
    expect(ac.state).toBe('running');
  });

  it('a gesture-less unlock() (pad confirm on the splash) still arms a gesture resume', async () => {
    const win = fakeWindow();
    vi.stubGlobal('window', win);
    const ac = fakeAudio();
    ac.resumeRefused = true;
    const engine = createAudioEngine(createSettingsStore(createMemoryStorage()), { createContext: () => ac as unknown as AudioContext });
    await engine.unlock();
    await flush();
    expect(win.handlers.get('pointerdown')?.size ?? 0).toBeGreaterThan(0);
    ac.resumeRefused = false;
    win.fire('pointerdown');
    await flush();
    expect(ac.state).toBe('running');
    expect(engine.unlocked).toBe(true);
  });
});

// ================================================================ session lifecycle races

function fakeState(): SimState {
  return {
    tick: 0,
    match: { phase: MatchPhase.KICK_OFF, shootout: { active: 0, winner: -1, goals: [0, 0] }, winner: -1, forfeitTeam: -1, period: 1 },
    teams: [{ goals: 0, clubIdx: 0 }, { goals: 0, clubIdx: 1 }],
    ball: { owner: -1 },
    ctrl: [{ side: 0 }, { side: -1 }, { side: -1 }, { side: 1 }],
    players: [],
  } as unknown as SimState;
}

function sessionHarness(over: Partial<SessionDeps> = {}) {
  const devicesList: DeviceInfo[] = [{ id: 'touch', kind: 'touch', label: 'Touch', family: 0, connected: true }];
  const devices: DeviceRegistry = {
    list: () => devicesList, subscribe: () => () => undefined, createSource: vi.fn() as never, lastActive: () => 'touch',
  };
  const focus = { attach: vi.fn(), detach: vi.fn(), handle: vi.fn(), focus: vi.fn(), onAction: vi.fn(() => () => undefined) };
  const router = createRouter({ appendChild: () => undefined } as unknown as HTMLElement, () => ({ focus } as unknown as AppContext), {
    listen: false,
    createContainer: () => ({ remove() {} }) as unknown as HTMLElement,
  });
  for (const id of ['main', 'loading', 'match', 'half-time', 'full-time', 'recovery'] as ScreenId[]) {
    router.register(id, (): Screen => ({ id, mount() {}, unmount() {} }));
  }
  router.go('main');
  const renderer = createNullRenderer();
  const clearMatch = vi.spyOn(renderer, 'clearMatch');
  const hud = { mount: vi.fn(), setMatch: vi.fn(), update: vi.fn(), onEvents: vi.fn(), setVisible: vi.fn(), dispose: vi.fn() };
  const audio = {
    unlock: vi.fn(), unlocked: true, setVolumes: vi.fn(), onEvents: vi.fn(), update: vi.fn(), playUi: vi.fn(),
    matchStart: vi.fn(), matchEnd: vi.fn(), setPaused: vi.fn(), suspend: vi.fn(), resume: vi.fn(),
  };
  const diagnostics = { log: vi.fn(), recent: () => [], debug: false, setDebug: vi.fn(), report: () => '' };
  const providers: (LocalInputProvider & { disposed: boolean })[] = [];
  let now = 1000;
  let yieldResolvers: (() => void)[] = [];
  const session = createSession({
    router, renderer, hud, audio, devices, diagnostics, clubs: [], getProjector: () => null,
    initMatch: () => fakeState(),
    cloneState: () => fakeState(),
    createStats: createStatsTracker,
    createEventBuffer,
    createLocalProvider: () => {
      const p = {
        disposed: false,
        ready: () => true, take: vi.fn(), pump: vi.fn(), waiting: false, releaseAll: vi.fn(),
        dispose: vi.fn(() => { p.disposed = true; }), queueCommand: vi.fn(), sourceCount: 0, rebind: vi.fn(), devicesOf: () => [] as string[],
      };
      providers.push(p);
      return p;
    },
    yieldFrame: () => new Promise<void>((r) => { yieldResolvers.push(r); }),
    newSeed: () => 777,
    now: () => now,
    onError: vi.fn(),
    ...over,
  });
  const releaseYields = async (): Promise<void> => {
    const rs = yieldResolvers;
    yieldResolvers = [];
    for (const r of rs) r();
    await flush();
  };
  return { session: session as AppSession, router, providers, clearMatch, audio, hud, releaseYields, advance: (ms: number) => { now += ms; } };
}

function setupFor(bindings: HumanBinding[] = [{ human: 0, deviceIds: ['touch', ANY_DEVICE] }], extra: Partial<MatchSetup> = {}): MatchSetup {
  const config = createMatchConfig();
  config.seed = 42;
  return { config, bindings, ...extra };
}

describe('REVIEW FND-04 session races', () => {
  it('start() twice during loading leaves exactly one live provider and one match', async () => {
    const h = sessionHarness();
    h.session.start(setupFor());
    h.session.start(setupFor());
    await h.releaseYields();
    await h.releaseYields();
    const live = h.providers.filter((p) => !p.disposed);
    expect(live.length).toBe(1);
    expect(h.router.current).toBe('match');
    expect(h.router.stack).toEqual(['main', 'match']);
  });

  it('quit -> start -> restart -> restart -> quit cycles never leak providers or screens', async () => {
    const h = sessionHarness();
    for (let cycle = 0; cycle < 3; cycle++) {
      h.session.start(setupFor());
      await h.releaseYields();
      h.session.restart();
      await h.releaseYields();
      h.session.restart();
      await h.releaseYields();
      expect(h.providers.filter((p) => !p.disposed).length).toBe(1);
      expect(h.router.stack).toEqual(['main', 'match']);
      h.session.quit();
      expect(h.providers.filter((p) => !p.disposed).length).toBe(0);
      expect(h.router.stack).toEqual(['main']);
      expect(h.session.active).toBe(false);
    }
  });

  it('hidden -> visible -> hidden -> visible flicker never auto-resumes and suspends/resumes audio each time', async () => {
    const h = sessionHarness();
    h.session.start(setupFor());
    await h.releaseYields();
    for (let i = 0; i < 3; i++) {
      h.session.setHidden(true);
      expect(h.session.ticking).toBe(false);
      h.session.setHidden(false);
      expect(h.session.paused).toBe(true);
      expect(h.session.ticking).toBe(false);
    }
    expect(h.audio.suspend).toHaveBeenCalledTimes(3);
    expect(h.audio.resume).toHaveBeenCalledTimes(3);
    expect(h.session.resume(0)).toBe(true);
    expect(h.session.ticking).toBe(true);
  });

  it('both humans pressing pause in the same frame toggles once, and the second human cannot resume', async () => {
    const h = sessionHarness();
    h.session.start(setupFor([{ human: 0, deviceIds: ['touch'] }, { human: 1, deviceIds: ['pad:0'] }]));
    await h.releaseYields();
    h.session.requestPause(0);
    h.session.requestPause(1);
    expect(h.session.paused).toBe(true);
    expect(h.session.pausedBy).toBe(0);
    h.advance(1000);
    h.session.requestPause(1);
    expect(h.session.paused).toBe(true);
    h.advance(1000);
    h.session.requestPause(0);
    expect(h.session.paused).toBe(false);
  });
});

// ================================================================ router re-entrancy

describe('REVIEW FND-04 router re-entrancy', () => {
  function routerHarness() {
    const mounted: ScreenId[] = [];
    const errors: string[] = [];
    const focus = { attach: vi.fn(), detach: vi.fn() };
    const router = createRouter({ appendChild: () => undefined } as unknown as HTMLElement, () => ({ focus } as unknown as AppContext), {
      listen: false,
      createContainer: () => ({ remove() {} }) as unknown as HTMLElement,
      onError: (_e, where) => errors.push(where),
    });
    return { router, mounted, errors, focus };
  }

  it('a screen whose unmount throws still navigates and detaches focus', () => {
    const h = routerHarness();
    h.router.register('main', () => ({ id: 'main', mount() {}, unmount() { throw new Error('unmount bug'); } }));
    h.router.register('settings', () => ({ id: 'settings', mount() {}, unmount() {} }));
    h.router.go('main');
    h.router.go('settings');
    expect(h.router.current).toBe('settings');
    expect(h.errors).toContain('unmount main');
    expect(h.focus.detach).toHaveBeenCalledTimes(1);
  });

  it('onBack that navigates (resetTo inside back) does not also pop the stack', () => {
    const h = routerHarness();
    const mk = (id: ScreenId, onBack?: () => boolean): (() => Screen) => () => ({ id, mount() {}, unmount() {}, onBack });
    h.router.register('main', mk('main'));
    h.router.register('settings', mk('settings'));
    h.router.register('full-time', mk('full-time', () => {
      h.router.resetTo('main');
      return true;
    }));
    h.router.go('main');
    h.router.go('settings');
    h.router.go('full-time');
    h.router.back();
    expect(h.router.stack).toEqual(['main']);
  });

  it('params survive unwinding: go() to an id already in history replaces its params', () => {
    const h = routerHarness();
    const seen: ScreenParams[] = [];
    h.router.register('main', () => ({ id: 'main', mount() {}, unmount() {} }));
    h.router.register('full-time', () => ({ id: 'full-time', mount(_r, _c, p) { seen.push(p); }, unmount() {} }));
    h.router.go('main');
    h.router.go('full-time', { final: false });
    h.router.go('full-time', { final: true });
    expect(seen.at(-1)).toEqual({ final: true });
    expect(h.router.stack).toEqual(['main', 'full-time']);
  });
});

// ================================================================ local input

function source(id: string, fill: (f: InputFrame) => void): InputSource & { released: number } {
  const s = {
    id, kind: 'pad' as const, released: 0,
    sample(out: InputFrame) { fill(out); },
    releaseAll() { s.released++; },
    dispose() {},
  };
  return s as unknown as InputSource & { released: number };
}

describe('REVIEW FND-04 local input', () => {
  it('NaN axes from a broken source never win the merge or reach the frame', () => {
    const list: DeviceInfo[] = [
      { id: 'a', kind: 'pad', label: 'A', family: 0, connected: true },
      { id: 'b', kind: 'pad', label: 'B', family: 0, connected: true },
    ];
    const srcs: Record<string, InputSource> = {
      a: source('a', (f) => { f.mx = Number.NaN; f.mz = Number.NaN; f.buttons = Btn.SPRINT; }),
      b: source('b', (f) => { f.mx = 0.5; f.mz = 0; }),
    };
    const devices: DeviceRegistry = { list: () => list, subscribe: () => () => undefined, createSource: (id) => srcs[id]!, lastActive: () => null };
    const p = createLocalInputProvider([{ human: 0, deviceIds: ['a', 'b'] }], devices, () => null, () => null);
    const frames = [createInputFrame(), createInputFrame()];
    p.take(1, frames, fakeState());
    expect(Number.isFinite(frames[0]!.mx) && Number.isFinite(frames[0]!.mz)).toBe(true);
    expect(frames[0]!.mx).toBe(0.5);
    expect(frames[0]!.buttons & Btn.SPRINT).toBe(Btn.SPRINT);
  });

  it('a pad that connects mid-match through the wildcard is released on pause like the others', () => {
    const list: DeviceInfo[] = [{ id: 'touch', kind: 'touch', label: 'T', family: 0, connected: true }];
    let notify: (() => void) | null = null;
    const made: (InputSource & { released: number })[] = [];
    const devices: DeviceRegistry = {
      list: () => list,
      subscribe: (fn) => { notify = () => fn(list); return () => { notify = null; }; },
      createSource: (id) => { const s = source(id, () => undefined); made.push(s); return s; },
      lastActive: () => null,
    };
    const p = createLocalInputProvider([{ human: 0, deviceIds: ['touch', ANY_DEVICE] }], devices, () => null, () => null);
    list.push({ id: 'pad:0', kind: 'pad', label: 'P', family: 0, connected: true });
    notify!();
    expect(p.sourceCount).toBe(2);
    p.releaseAll();
    expect(made.map((s) => s.released)).toEqual([1, 1]);
    p.dispose();
    // After dispose a late notification must not resurrect sources.
    list.push({ id: 'pad:1', kind: 'pad', label: 'P2', family: 0, connected: true });
    expect(notify).toBeNull();
  });
});
