/**
 * FND-04 fixes for the independent review (tests/unit/review-fnd-04-adversarial.test.ts,
 * tests/e2e/review-fnd-04-adversarial.spec.ts). Regression tests per finding:
 *  1/2. Recovery Resume after the final whistle / during half-time returns to the right match screen (the real
 *       recovery screen, router, session and installRecovery; a tiny fake DOM stands in for document).
 *  3.   Audio comes back after backgrounding even when resume() never runs the context.
 *  5.   Square windows are portrait for both CSS and JS.
 *  6.   One loop stage throwing every frame never starves the others.
 *  7.   A refused resume during a system pause never says "Player 0".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppContext, DeviceInfo, DeviceRegistry, FrameInfo, HumanBinding, MatchSetup, Screen, ScreenId, ScreenParams, StatsTracker,
  TickInputProvider,
} from '../../src/contracts/app';
import { MatchPhase } from '../../src/contracts/enums';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { EventType, type EventBuffer } from '../../src/contracts/events';
import { createLoop } from '../../src/app/loop';
import { TICK_MS } from '../../src/app/loopMath';
import { createNullRenderer } from '../../src/app/nullRenderer';
import { createRouter } from '../../src/app/router';
import { createSession } from '../../src/app/session';
import { ANY_DEVICE, type LocalInputProvider } from '../../src/app/localInput';
import type { AppSession, MatchRuntime } from '../../src/app/types';
import { createAudioEngine } from '../../src/audio/engine';
import { createStatsTracker } from '../../src/modes/stats';
import { classifyViewport } from '../../src/platform/ipados';
import { installRecovery, type Recovery } from '../../src/platform/recovery';
import { createSettingsStore } from '../../src/platform/settingsStore';
import { createMemoryStorage } from '../../src/platform/storage';
import { createEventBuffer } from '../../src/sim/core/events';
import { refusalMessage } from '../../src/ui/screens/pause';
import { createRecoveryScreen, resumeNavigation } from '../../src/ui/screens/recovery';

/** Audio modules: crowd can be made to throw, whistles counts its calls (module isolation tests). */
const audioMods = vi.hoisted(() => ({ crowdThrows: false, whistleUpdates: 0, whistleEvents: 0 }));
vi.mock('../../src/audio/crowd', () => ({
  createCrowd: () => ({
    onEvents() {
      if (audioMods.crowdThrows) throw new Error('crowd onEvents bug');
    },
    update() {
      if (audioMods.crowdThrows) throw new Error('crowd update bug');
    },
    dispose() {},
  }),
}));
vi.mock('../../src/audio/whistles', () => ({
  createWhistles: () => ({
    onEvents() {
      audioMods.whistleEvents++;
    },
    update() {
      audioMods.whistleUpdates++;
    },
    dispose() {},
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  audioMods.crowdThrows = false;
  audioMods.whistleUpdates = 0;
  audioMods.whistleEvents = 0;
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

// ================================================================ fake DOM (enough for ui/components h + createButton)

class FakeEl {
  className = '';
  textContent = '';
  type = '';
  hidden = false;
  readonly dataset: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  readonly classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  private readonly listeners = new Map<string, ((e: { preventDefault(): void }) => void)[]>();
  setAttribute(): void {}
  append(...c: unknown[]): void {
    for (const x of c) if (x instanceof FakeEl) this.children.push(x);
  }
  appendChild(c: unknown): void {
    this.append(c);
  }
  remove(): void {}
  addEventListener(type: string, fn: (e: { preventDefault(): void }) => void): void {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn({ preventDefault() {} });
  }
  find(testId: string): FakeEl | null {
    if (this.dataset.testid === testId) return this;
    for (const c of this.children) {
      const f = c.find(testId);
      if (f) return f;
    }
    return null;
  }
}

function stubDocument(): void {
  vi.stubGlobal('document', { createElement: () => new FakeEl(), getElementById: () => null, head: new FakeEl(), body: new FakeEl() });
}

// ================================================================ app harness: real router + session + recovery

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

function appHarness() {
  stubDocument();
  const mounted: { id: ScreenId; params: ScreenParams }[] = [];
  const devicesList: DeviceInfo[] = [{ id: 'touch', kind: 'touch', label: 'Touch', family: 0, connected: true }];
  const devices: DeviceRegistry = {
    list: () => devicesList, subscribe: () => () => undefined, createSource: vi.fn() as never, lastActive: () => 'touch',
  };
  const focus = { attach: vi.fn(), detach: vi.fn(), handle: vi.fn(), focus: vi.fn(), onAction: vi.fn(() => () => undefined) };
  const audio = {
    unlock: vi.fn(), unlocked: true, setVolumes: vi.fn(), onEvents: vi.fn(), update: vi.fn(), playUi: vi.fn(),
    matchStart: vi.fn(), matchEnd: vi.fn(), setPaused: vi.fn(), suspend: vi.fn(), resume: vi.fn(),
  };
  const diagnostics = { log: vi.fn(), recent: () => [], debug: false, setDebug: vi.fn(), report: () => 'report' };
  let ctx: AppContext | null = null;
  let recovery: Recovery | null = null;
  let recoveryRoot: FakeEl | null = null;
  const router = createRouter(new FakeEl() as unknown as HTMLElement, () => ctx!, {
    listen: false,
    createContainer: (id) => {
      const el = new FakeEl();
      if (id === 'recovery') recoveryRoot = el;
      return el as unknown as HTMLElement;
    },
    onError: (err, where) => recovery!.reportError(err, where),
  });
  for (const id of ['main', 'loading', 'match', 'half-time', 'full-time', 'team-select'] as ScreenId[]) {
    router.register(id, (): Screen => ({ id, mount(_r, _c, p) { mounted.push({ id, params: p }); }, unmount() {} }));
  }
  router.register('recovery', createRecoveryScreen);
  const providers: LocalInputProvider[] = [];
  let now = 1000;
  const session = createSession({
    router, renderer: createNullRenderer(),
    hud: { mount: vi.fn(), setMatch: vi.fn(), update: vi.fn(), onEvents: vi.fn(), setVisible: vi.fn(), dispose: vi.fn() },
    audio, devices, diagnostics, clubs: [], getProjector: () => null,
    initMatch: () => fakeState(),
    cloneState: () => fakeState(),
    createStats: createStatsTracker,
    createEventBuffer,
    createLocalProvider: () => {
      const p: LocalInputProvider = {
        ready: () => true, take: vi.fn(), pump: vi.fn(), waiting: false, releaseAll: vi.fn(), dispose: vi.fn(),
        queueCommand: vi.fn(), sourceCount: 0,
      };
      providers.push(p);
      return p;
    },
    yieldFrame: () => Promise.resolve(),
    newSeed: () => 777,
    now: () => now,
    onError: (err, where) => recovery!.reportError(err, where),
  });
  ctx = {
    router, session, devices, focus, audio, diagnostics, clubs: [],
    settings: createSettingsStore(createMemoryStorage()),
    platform: { isIPad: true, isTouch: true, isStandalone: false, supportsFullscreen: false, safeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) },
  } as unknown as AppContext;
  recovery = installRecovery(ctx, { now: () => now });
  router.go('main');
  const app = session as AppSession;
  return {
    ctx: ctx as AppContext,
    session: app,
    router,
    mounted,
    rt: () => app.runtime() as MatchRuntime,
    advance: (ms: number) => { now += ms; },
    /** The recovery screen's root element (to click its buttons). */
    recoveryRoot: () => recoveryRoot!,
    /** Simulate the loop seeing a phase after a tick. */
    setPhase(phase: MatchPhase) {
      const rt = app.runtime() as MatchRuntime;
      rt.curr.match.phase = phase;
      app.afterTick(rt);
    },
    /** An uncaught error, as window.onerror reports it. */
    fail(message = 'injected') {
      now += 2000; // past the recovery rate limit
      recovery!.reportError(new Error(message), 'window.onerror');
    },
  };
}

function setupFor(bindings: HumanBinding[] = [{ human: 0, deviceIds: ['touch', ANY_DEVICE] }], extra: Partial<MatchSetup> = {}): MatchSetup {
  const config = createMatchConfig();
  config.seed = 42;
  return { config, bindings, ...extra };
}

async function startMatch(h: ReturnType<typeof appHarness>, setup = setupFor()): Promise<void> {
  h.session.start(setup);
  await flush();
  expect(h.router.current).toBe('match');
  expect(h.session.loaded).toBe(true);
}

function tapResume(h: ReturnType<typeof appHarness>): void {
  const btn = h.recoveryRoot().find('recovery-resume');
  expect(btn, 'Resume offered').not.toBeNull();
  btn!.click();
}

describe('FND-04 fix: recovery Resume returns to the right match screen', () => {
  it('after the final whistle: Resume goes back to the final full-time screen (button)', async () => {
    const h = appHarness();
    await startMatch(h);
    h.setPhase(MatchPhase.POST_MATCH);
    expect(h.router.current).toBe('full-time');
    expect(h.session.finished).toBe(true);
    h.fail();
    expect(h.router.current).toBe('recovery');
    tapResume(h);
    await flush();
    expect(h.router.current).toBe('full-time');
    expect(h.mounted.at(-1)!.params.final).toBe(true);
    expect(h.router.stack).toEqual(['main', 'match', 'full-time']);
  });

  it('after the final whistle: Back on recovery does the same (queued pop, then resume)', async () => {
    const h = appHarness();
    await startMatch(h);
    h.setPhase(MatchPhase.POST_MATCH);
    h.fail();
    h.router.back();
    await flush();
    expect(h.router.current).toBe('full-time');
    expect(h.mounted.at(-1)!.params.final).toBe(true);
  });

  it('a throwing setup.onFinish (recovery on top of the match screen): Resume lands on the final full-time screen', async () => {
    const h = appHarness();
    await startMatch(h, setupFor(undefined, { onFinish: () => { throw new Error('onFinish bug'); } }));
    h.advance(2000);
    h.setPhase(MatchPhase.POST_MATCH);
    expect(h.router.current).toBe('recovery');
    expect(h.router.stack).toEqual(['main', 'match', 'recovery']);
    tapResume(h);
    await flush();
    expect(h.router.current).toBe('full-time');
    expect(h.mounted.at(-1)!.params.final).toBe(true);
    expect(h.session.finished).toBe(true);
  });

  it('during half-time: Resume returns to the half-time screen and the match is running', async () => {
    const h = appHarness();
    await startMatch(h);
    h.setPhase(MatchPhase.HALF_TIME);
    expect(h.router.current).toBe('half-time');
    h.fail();
    expect(h.session.paused).toBe(true);
    expect(h.router.current).toBe('recovery');
    tapResume(h);
    await flush();
    expect(h.router.current).toBe('half-time');
    expect(h.session.paused).toBe(false);
    expect(h.session.ticking).toBe(true);
  });

  it('during half-time via Back on recovery: same result', async () => {
    const h = appHarness();
    await startMatch(h);
    h.setPhase(MatchPhase.HALF_TIME);
    h.fail();
    h.router.back();
    await flush();
    expect(h.router.current).toBe('half-time');
    expect(h.session.paused).toBe(false);
  });

  it('in play: Resume returns to the running match', async () => {
    const h = appHarness();
    await startMatch(h);
    h.setPhase(MatchPhase.IN_PLAY);
    h.fail();
    tapResume(h);
    await flush();
    expect(h.router.current).toBe('match');
    expect(h.session.paused).toBe(false);
    expect(h.router.stack).toEqual(['main', 'match']);
  });

  it('a human pause stays in place: Resume shows the match (pause menu), still paused by that human', async () => {
    const h = appHarness();
    await startMatch(h);
    h.session.pause(0);
    h.fail();
    tapResume(h);
    await flush();
    expect(h.router.current).toBe('match');
    expect(h.session.paused).toBe(true);
    expect(h.session.pausedBy).toBe(0);
  });

  it('a second tap on Resume while it is leaving does nothing extra', async () => {
    const h = appHarness();
    await startMatch(h);
    h.setPhase(MatchPhase.IN_PLAY);
    h.fail();
    const btn = h.recoveryRoot().find('recovery-resume')!;
    btn.click();
    btn.click();
    await flush();
    expect(h.router.stack).toEqual(['main', 'match']);
  });
});

describe('FND-04 fix: resumeNavigation (pure)', () => {
  it('stays on match screens, replaces loading, keeps a mode screen after the whistle, else goes to the match', () => {
    expect(resumeNavigation('match', false)).toBe('stay');
    expect(resumeNavigation('half-time', false)).toBe('stay');
    expect(resumeNavigation('full-time', true)).toBe('stay');
    expect(resumeNavigation('loading', false)).toBe('replace-match');
    expect(resumeNavigation('cup', true)).toBe('stay');
    expect(resumeNavigation('cup', false)).toBe('go-match');
    expect(resumeNavigation('recovery', true)).toBe('go-match');
    expect(resumeNavigation('recovery', false)).toBe('go-match');
    expect(resumeNavigation(null, false)).toBe('go-match');
  });
});

describe('FND-04 fix: session.resume re-syncs a finished match', () => {
  it('resume() on a finished match shown on the match screen moves to the final full-time screen', async () => {
    const h = appHarness();
    await startMatch(h);
    h.setPhase(MatchPhase.POST_MATCH);
    h.router.go('match'); // stranded (the pre-fix recovery path)
    expect(h.router.current).toBe('match');
    expect(h.session.resume(-1)).toBe(true);
    expect(h.router.current).toBe('full-time');
    expect(h.mounted.at(-1)!.params.final).toBe(true);
  });

  it('resume() while running on the right screen does not navigate', async () => {
    const h = appHarness();
    await startMatch(h);
    const n = h.mounted.length;
    expect(h.session.resume(0)).toBe(true);
    expect(h.mounted.length).toBe(n);
  });
});

// ================================================================ pause menu message

describe('FND-04 fix: refused-resume message', () => {
  it('a system pause never names "Player 0"; a human pause names the pauser', () => {
    expect(refusalMessage(-1)).not.toMatch(/Player/);
    expect(refusalMessage(-1)).toMatch(/landscape|window/);
    expect(refusalMessage(0)).toBe('Only Player 1 can resume');
    expect(refusalMessage(1)).toBe('Only Player 2 can resume');
  });
});

// ================================================================ viewport

describe('FND-04 fix: square windows', () => {
  it('a square window is portrait, as CSS (orientation: portrait) says', () => {
    expect(classifyViewport(900, 900)).toEqual({ portrait: true, tooSmall: false });
    expect(classifyViewport(901, 900)).toEqual({ portrait: false, tooSmall: false });
    expect(classifyViewport(500, 500)).toEqual({ portrait: true, tooSmall: false });
  });

  it('the live media query result wins over the size rule when given', () => {
    expect(classifyViewport(900, 900, 560, 320, false)).toEqual({ portrait: false, tooSmall: false });
    expect(classifyViewport(500, 300, 560, 320, true)).toEqual({ portrait: true, tooSmall: false });
    expect(classifyViewport(500, 300, 560, 320, false)).toEqual({ portrait: false, tooSmall: true });
  });
});

// ================================================================ audio

function fakeAudio() {
  const listeners: Record<string, (() => void)[]> = {};
  const ac = {
    state: 'suspended' as string,
    currentTime: 0,
    destination: {},
    /** 'run' resolves and runs, 'refuse' resolves still suspended, 'hang' never settles, 'reject' rejects. */
    mode: 'run' as 'run' | 'refuse' | 'hang' | 'reject',
    createGain: () => ({ gain: { value: 1, setTargetAtTime() {} }, connect() {}, disconnect() {} }),
    createBuffer: (ch: number, len: number, sr: number) => ({ numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => ({ buffer: null, connect() {}, start() {} }),
    resume: vi.fn(() => {
      if (ac.mode === 'hang') return new Promise<void>(() => undefined);
      if (ac.mode === 'reject') return Promise.reject(new Error('NotAllowedError'));
      if (ac.mode === 'run') ac.setState('running');
      return Promise.resolve();
    }),
    suspend: vi.fn(() => {
      ac.setState('suspended');
      return Promise.resolve();
    }),
    close: vi.fn(() => Promise.resolve()),
    addEventListener: (type: string, fn: () => void) => {
      (listeners[type] ??= []).push(fn);
    },
    setState(s: string) {
      ac.state = s;
      for (const fn of listeners.statechange ?? []) fn();
    },
  };
  return ac;
}

function fakeWindow() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    handlers,
    armed: () => (handlers.get('pointerdown')?.size ?? 0) + (handlers.get('keydown')?.size ?? 0),
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

function audioHarness(onModuleError?: (err: unknown, where: string) => void) {
  const win = fakeWindow();
  vi.stubGlobal('window', win);
  const ac = fakeAudio();
  const engine = createAudioEngine(createSettingsStore(createMemoryStorage()), {
    createContext: () => ac as unknown as AudioContext,
    onModuleError,
  });
  return { win, ac, engine };
}

describe('FND-04 fix: audio after backgrounding', () => {
  it('iOS "interrupted" context whose resume() never settles: the next tap still brings sound back', async () => {
    const { win, ac, engine } = audioHarness();
    await engine.unlock();
    expect(ac.state).toBe('running');
    expect(win.armed()).toBe(0);
    engine.suspend();
    await flush();
    ac.setState('interrupted'); // phone call while hidden (not wanted: no gesture yet)
    expect(win.armed()).toBe(0);
    ac.mode = 'hang';
    engine.resume();
    await flush();
    expect(win.armed()).toBeGreaterThan(0);
    ac.mode = 'run';
    win.fire('keydown');
    await flush();
    expect(ac.state).toBe('running');
    expect(win.armed()).toBe(0);
  });

  it('a rejected resume() keeps the gesture armed; the context reaching running disarms it', async () => {
    const { win, ac, engine } = audioHarness();
    await engine.unlock();
    engine.suspend();
    await flush();
    ac.mode = 'reject';
    engine.resume();
    await flush();
    expect(win.armed()).toBeGreaterThan(0);
    // The OS resumes the context on its own (statechange): listeners are removed.
    ac.setState('running');
    expect(win.armed()).toBe(0);
  });

  it('a gesture that still leaves the context suspended re-arms for the next one', async () => {
    const { win, ac, engine } = audioHarness();
    await engine.unlock();
    engine.suspend();
    await flush();
    ac.mode = 'refuse';
    engine.resume();
    await flush();
    win.fire('pointerdown');
    await flush();
    expect(ac.state).toBe('suspended');
    expect(win.armed()).toBeGreaterThan(0);
    ac.mode = 'run';
    win.fire('pointerdown');
    await flush();
    expect(ac.state).toBe('running');
  });

  it('a gesture-less unlock that never ran, then hidden and shown: the next tap still starts audio', async () => {
    const { win, ac, engine } = audioHarness();
    ac.mode = 'refuse';
    await engine.unlock();
    expect(engine.unlocked).toBe(false);
    engine.suspend();
    expect(win.armed()).toBe(0);
    engine.resume();
    expect(win.armed()).toBeGreaterThan(0);
    ac.mode = 'run';
    win.fire('pointerdown');
    await flush();
    expect(ac.state).toBe('running');
    expect(engine.unlocked).toBe(true);
  });

  it('resume() while hidden is not wanted any more: no gesture is armed after suspend()', async () => {
    const { win, ac, engine } = audioHarness();
    ac.mode = 'refuse';
    await engine.unlock();
    expect(win.armed()).toBeGreaterThan(0);
    engine.suspend();
    expect(win.armed()).toBe(0);
    ac.setState('interrupted');
    expect(win.armed()).toBe(0);
  });

  it('a module that throws in update/onEvents never stops the other modules; reported once per module', async () => {
    const errors: string[] = [];
    const { engine } = audioHarness((_e, where) => errors.push(where));
    await engine.unlock();
    audioMods.crowdThrows = true;
    const ev = createEventBuffer();
    ev.begin(1);
    const state = fakeState();
    for (let i = 0; i < 10; i++) {
      expect(() => engine.update(state, 1 / 60)).not.toThrow();
      expect(() => engine.onEvents(ev, state)).not.toThrow();
    }
    expect(audioMods.whistleUpdates).toBe(10);
    expect(audioMods.whistleEvents).toBe(10);
    // First failure only (crowd is module 0): one report, not 20.
    expect(errors).toEqual(['audio module 0 update']);
  });
});

// ================================================================ loop stage isolation

function loopHarness(over: { hudThrows?: boolean; renderThrows?: boolean; onEventsThrows?: boolean; menuThrows?: boolean; ticking?: boolean } = {}) {
  const curr = { tick: 0 } as unknown as SimState;
  const prev = { tick: 0 } as unknown as SimState;
  const provider: TickInputProvider = {
    ready: () => true, take: vi.fn(), pump: vi.fn(), waiting: false, releaseAll: vi.fn(), dispose: vi.fn(),
  };
  const stats: StatsTracker = { reset: vi.fn(), onTick: vi.fn(), summary: vi.fn() as never };
  const rt: MatchRuntime = { prev, curr, provider, frames: [createInputFrame(), createInputFrame()], events: createEventBuffer(), stats };
  const session = { paused: !over.ticking, ticking: !!over.ticking, runtime: () => rt, afterTick: vi.fn() };
  const renderer = createNullRenderer();
  vi.spyOn(renderer, 'render').mockImplementation(() => {
    if (over.renderThrows) throw new Error('render bug');
  });
  vi.spyOn(renderer, 'onEvents').mockImplementation(() => {
    if (over.onEventsThrows) throw new Error('renderer onEvents bug');
  });
  const hud = {
    mount: vi.fn(), setMatch: vi.fn(), onEvents: vi.fn(), setVisible: vi.fn(), dispose: vi.fn(),
    update: vi.fn(() => {
      if (over.hudThrows) throw new Error('hud bug');
    }),
  };
  const audio = {
    unlock: vi.fn(), unlocked: false, setVolumes: vi.fn(), onEvents: vi.fn(), playUi: vi.fn(), update: vi.fn(),
    matchStart: vi.fn(), matchEnd: vi.fn(), setPaused: vi.fn(), suspend: vi.fn(), resume: vi.fn(),
  };
  const onFrame = vi.fn((f: FrameInfo) => void f);
  const router = { current: 'recovery' as const, currentScreen: () => ({ id: 'recovery' as const, mount() {}, unmount() {}, onFrame }) };
  const menuInput = {
    poll: vi.fn(() => {
      if (over.menuThrows) throw new Error('menu input bug');
    }),
  };
  const afterFrame = vi.fn();
  const onError = vi.fn();
  const step = vi.fn((s: SimState, _f: unknown, ev: EventBuffer) => {
    s.tick++;
    ev.begin(s.tick);
    ev.emit(EventType.BOUNCE);
  });
  const loop = createLoop({
    session, renderer, hud, audio, router, menuInput, getProjector: () => null, onError, step, afterFrame,
    copyState: (d, s) => { (d as { tick: number }).tick = s.tick; },
    raf: () => 1, caf: () => undefined, now: () => 0,
  });
  return { loop, menuInput, onFrame, onError, session, renderer, hud, audio, stats, afterFrame };
}

describe('FND-04 fix: loop stage isolation', () => {
  it('a HUD update that throws every frame: render, audio, menu input, onFrame and afterFrame still run', () => {
    const h = loopHarness({ hudThrows: true });
    for (let i = 0; i < 5; i++) {
      h.loop.invalidate();
      h.loop.frame(i * TICK_MS);
    }
    expect(h.renderer.render).toHaveBeenCalledTimes(5);
    expect(h.audio.update).toHaveBeenCalledTimes(5);
    expect(h.menuInput.poll).toHaveBeenCalledTimes(5);
    expect(h.onFrame).toHaveBeenCalledTimes(5);
    expect(h.afterFrame).toHaveBeenCalledTimes(5);
    expect(h.onError).toHaveBeenCalledTimes(5);
    expect(h.onError.mock.calls[0]![1]).toBe('loop.hud');
  });

  it('a render that throws every frame still updates the HUD and polls menus', () => {
    const h = loopHarness({ renderThrows: true });
    for (let i = 0; i < 3; i++) {
      h.loop.invalidate();
      h.loop.frame(i * TICK_MS);
    }
    expect(h.hud.update).toHaveBeenCalledTimes(3);
    expect(h.menuInput.poll).toHaveBeenCalledTimes(3);
    expect(h.onError.mock.calls.every((c) => c[1] === 'loop.render')).toBe(true);
  });

  it('a renderer.onEvents that throws never hides tick events from HUD, audio, stats or the session', () => {
    const h = loopHarness({ onEventsThrows: true, ticking: true });
    for (let i = 0; i < 4; i++) h.loop.frame(i * TICK_MS);
    expect(h.loop.stats.totalTicks).toBe(3);
    expect(h.hud.onEvents).toHaveBeenCalledTimes(3);
    expect(h.audio.onEvents).toHaveBeenCalledTimes(3);
    expect(h.stats.onTick).toHaveBeenCalledTimes(3);
    expect(h.session.afterTick).toHaveBeenCalledTimes(3);
    expect(h.onError.mock.calls.every((c) => c[1] === 'loop.renderer.onEvents')).toBe(true);
  });

  it('a menu input that throws still runs screen.onFrame', () => {
    const h = loopHarness({ menuThrows: true });
    for (let i = 0; i < 3; i++) h.loop.frame(i * TICK_MS);
    expect(h.onFrame).toHaveBeenCalledTimes(3);
    expect(h.afterFrame).toHaveBeenCalledTimes(3);
  });
});
