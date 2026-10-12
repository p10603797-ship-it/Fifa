import { describe, expect, it, vi } from 'vitest';
import type {
  AppContext, DeviceInfo, DeviceRegistry, HumanBinding, MatchSetup, MatchSummary, Screen, ScreenId, ScreenParams,
} from '../../src/contracts/app';
import { Command, MatchPhase } from '../../src/contracts/enums';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createNullRenderer } from '../../src/app/nullRenderer';
import { createRouter } from '../../src/app/router';
import { createSession, humanForDevice, PAUSE_DEBOUNCE_MS, uiHumanOf, type SessionDeps } from '../../src/app/session';
import { ANY_DEVICE, type LocalInputProvider } from '../../src/app/localInput';
import type { AppSession, MatchRuntime } from '../../src/app/types';
import { createStatsTracker } from '../../src/modes/stats';
import { createEventBuffer } from '../../src/sim/core/events';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

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

function fakeProvider(): LocalInputProvider {
  return {
    ready: () => true, take: vi.fn(), pump: vi.fn(), waiting: false, releaseAll: vi.fn(), dispose: vi.fn(),
    queueCommand: vi.fn(), sourceCount: 0,
  };
}

function harness(over: Partial<SessionDeps> = {}) {
  const screens: { id: ScreenId; params: ScreenParams }[] = [];
  let now = 1000;
  const devicesList: DeviceInfo[] = [{ id: 'touch', kind: 'touch', label: 'Touch', family: 0, connected: true }];
  let lastActive: string | null = 'touch';
  const devices: DeviceRegistry = {
    list: () => devicesList, subscribe: () => () => undefined, createSource: vi.fn() as never, lastActive: () => lastActive,
  };
  const ctxRef: { ctx: AppContext | null } = { ctx: null };
  const focus = { attach: vi.fn(), detach: vi.fn(), handle: vi.fn(), focus: vi.fn(), onAction: vi.fn(() => () => undefined) };
  const root = { appendChild: () => undefined } as unknown as HTMLElement;
  const router = createRouter(root, () => ({ focus } as unknown as AppContext), {
    listen: false,
    createContainer: () => ({ remove() {} }) as unknown as HTMLElement,
  });
  for (const id of ['main', 'loading', 'match', 'half-time', 'full-time', 'recovery', 'team-select', 'cup'] as ScreenId[]) {
    router.register(id, (): Screen => ({ id, mount(_r, _c, p) { screens.push({ id, params: p }); }, unmount() {} }));
  }
  router.go('main');
  const renderer = createNullRenderer();
  const spies = {
    setMatch: vi.spyOn(renderer, 'setMatch'),
    warmUp: vi.spyOn(renderer, 'warmUp'),
    clearMatch: vi.spyOn(renderer, 'clearMatch'),
  };
  const hud = { mount: vi.fn(), setMatch: vi.fn(), update: vi.fn(), onEvents: vi.fn(), setVisible: vi.fn(), dispose: vi.fn() };
  const audio = {
    unlock: vi.fn(), unlocked: true, setVolumes: vi.fn(), onEvents: vi.fn(), update: vi.fn(), playUi: vi.fn(),
    matchStart: vi.fn(), matchEnd: vi.fn(), setPaused: vi.fn(), suspend: vi.fn(), resume: vi.fn(),
  };
  const diagnostics = { log: vi.fn(), recent: () => [], debug: false, setDebug: vi.fn(), report: () => '' };
  const providers: LocalInputProvider[] = [];
  const layer = vi.fn();
  const onError = vi.fn();
  const seeds: number[] = [];
  const session = createSession({
    router, renderer, hud, audio, devices, diagnostics, clubs: [], getProjector: () => null,
    initMatch: (config) => {
      seeds.push(config.seed);
      return fakeState();
    },
    cloneState: () => fakeState(),
    createStats: createStatsTracker,
    createEventBuffer,
    createLocalProvider: () => {
      const p = fakeProvider();
      providers.push(p);
      return p;
    },
    setMatchLayer: layer,
    yieldFrame: () => Promise.resolve(),
    newSeed: () => 777,
    now: () => now,
    onError,
    ...over,
  });
  ctxRef.ctx = { session, devices } as unknown as AppContext;
  return {
    session, router, screens, renderer, spies, hud, audio, providers, layer, onError, seeds, devices,
    setNow: (t: number) => { now = t; },
    advance: (ms: number) => { now += ms; },
    setLastActive: (id: string | null) => { lastActive = id; },
    rt: () => (session as AppSession).runtime() as MatchRuntime,
  };
}

function setupFor(bindings: HumanBinding[] = [{ human: 0, deviceIds: ['touch', ANY_DEVICE] }], extra: Partial<MatchSetup> = {}): MatchSetup {
  const config = createMatchConfig();
  config.seed = 42;
  return { config, bindings, ...extra };
}

async function started(h: ReturnType<typeof harness>, setup = setupFor()) {
  h.session.start(setup);
  await tick();
  await tick();
}

describe('FND-04 session start / quit', () => {
  it('goes loading -> match, builds the match, warms up and shows the layer', async () => {
    const h = harness();
    h.session.start(setupFor());
    expect(h.router.current).toBe('loading');
    expect(h.session.active).toBe(true);
    expect(h.session.loaded).toBe(false);
    expect(h.session.getState()).toBeNull();
    await tick();
    await tick();
    expect(h.router.current).toBe('match');
    expect(h.router.stack).toEqual(['main', 'match']);
    expect(h.session.loaded).toBe(true);
    expect(h.session.ticking).toBe(true);
    expect(h.session.getState()).not.toBeNull();
    expect(h.spies.setMatch).toHaveBeenCalledTimes(1);
    expect(h.spies.warmUp).toHaveBeenCalledTimes(1);
    expect(h.hud.setMatch).toHaveBeenCalledTimes(1);
    expect(h.hud.setVisible).toHaveBeenLastCalledWith(true);
    expect(h.audio.matchStart).toHaveBeenCalledTimes(1);
    expect(h.layer).toHaveBeenLastCalledWith(true);
    expect(h.seeds).toEqual([42]);
  });

  it('quit releases every match resource, reports the quit and returns to main', async () => {
    const h = harness();
    const onFinish = vi.fn();
    await started(h, setupFor(undefined, { onFinish }));
    h.session.quit();
    expect(h.providers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(h.spies.clearMatch).toHaveBeenCalled();
    expect(h.hud.setVisible).toHaveBeenLastCalledWith(false);
    expect(h.audio.matchEnd).toHaveBeenCalledTimes(1);
    expect(h.layer).toHaveBeenLastCalledWith(false);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0]![1]).toBe(true);
    expect(h.session.active).toBe(false);
    expect(h.session.getState()).toBeNull();
    expect(h.router.stack).toEqual(['main']);
  });

  it('a second match starts cleanly after quitting', async () => {
    const h = harness();
    await started(h);
    h.session.quit();
    await started(h);
    expect(h.providers.length).toBe(2);
    expect(h.providers[1]!.dispose).not.toHaveBeenCalled();
    expect(h.router.stack).toEqual(['main', 'match']);
    expect(h.session.paused).toBe(false);
  });

  it('abandons a load that is still warming up when the match is quit', async () => {
    let resolveWarm: () => void = () => undefined;
    const h = harness();
    h.spies.warmUp.mockImplementation(() => new Promise<void>((r) => { resolveWarm = r; }));
    h.session.start(setupFor());
    await tick();
    h.session.quit();
    resolveWarm();
    await tick();
    await tick();
    expect(h.router.stack).toEqual(['main']);
    expect(h.session.active).toBe(false);
    expect(h.providers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(h.hud.setMatch).not.toHaveBeenCalled();
  });

  it('reports a failing load without navigating to the match', async () => {
    const h = harness({ initMatch: () => { throw new Error('init failed'); } });
    await started(h);
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.session.loaded).toBe(false);
  });

  it('restart replays the setup with a fresh seed and a new provider', async () => {
    const h = harness();
    await started(h);
    h.session.restart();
    await tick();
    await tick();
    expect(h.seeds).toEqual([42, 777]);
    expect(h.providers[0]!.dispose).toHaveBeenCalled();
    expect(h.providers.length).toBe(2);
    expect(h.router.current).toBe('match');
  });
});

describe('FND-04 session pause rules', () => {
  it('only the human who paused may resume', async () => {
    const h = harness();
    await started(h);
    h.session.pause(0);
    expect(h.session.paused).toBe(true);
    expect(h.session.pausedBy).toBe(0);
    expect(h.session.ticking).toBe(false);
    expect(h.audio.setPaused).toHaveBeenLastCalledWith(true);
    expect(h.providers[0]!.releaseAll).toHaveBeenCalled();
    expect(h.session.resume(1)).toBe(false);
    expect(h.session.resume(-1)).toBe(false);
    expect(h.session.paused).toBe(true);
    expect(h.session.resume(0)).toBe(true);
    expect(h.session.paused).toBe(false);
    expect(h.session.pausedBy).toBe(-1);
    expect(h.audio.setPaused).toHaveBeenLastCalledWith(false);
  });

  it('a system pause (-1) can be resumed by anyone', async () => {
    const h = harness();
    await started(h);
    h.session.pause(-1);
    expect(h.session.resume(1)).toBe(true);
    h.session.pause(-1);
    expect(h.session.resume(-1)).toBe(true);
  });

  it('a second pause does not steal the pause from the first pauser', async () => {
    const h = harness();
    await started(h);
    h.session.pause(1);
    h.session.pause(0);
    h.session.pause(-1);
    expect(h.session.pausedBy).toBe(1);
    expect(h.session.resume(0)).toBe(false);
  });

  it('resume() while running is a no-op success; pause outside a match does nothing', () => {
    const h = harness();
    h.session.pause(0);
    expect(h.session.paused).toBe(false);
    expect(h.session.resume(0)).toBe(false);
  });

  it('hidden page pauses (-1), suspends audio and never auto-resumes', async () => {
    const h = harness();
    await started(h);
    h.session.setHidden(true);
    expect(h.session.paused).toBe(true);
    expect(h.session.pausedBy).toBe(-1);
    expect(h.audio.suspend).toHaveBeenCalledTimes(1);
    expect(h.session.ticking).toBe(false);
    expect(h.session.resume(0)).toBe(false); // cannot resume while hidden
    h.session.setHidden(false);
    expect(h.audio.resume).toHaveBeenCalledTimes(1);
    expect(h.session.paused).toBe(true);
    expect(h.router.current).toBe('match');
    expect(h.session.resume(0)).toBe(true);
  });

  it('hiding while a human paused keeps that human as the pauser', async () => {
    const h = harness();
    await started(h);
    h.session.pause(1);
    h.session.setHidden(true);
    h.session.setHidden(false);
    expect(h.session.pausedBy).toBe(1);
  });

  it('portrait / too small blocks play and resuming until cleared', async () => {
    const h = harness();
    await started(h);
    h.session.setBlocked(true);
    expect(h.session.paused).toBe(true);
    expect(h.session.resume(0)).toBe(false);
    h.session.setBlocked(false);
    expect(h.session.paused).toBe(true);
    expect(h.session.resume(0)).toBe(true);
  });

  it('a hidden page during loading starts the match paused', async () => {
    const h = harness();
    h.session.start(setupFor());
    h.session.setHidden(true);
    await tick();
    await tick();
    expect(h.session.loaded).toBe(true);
    expect(h.session.paused).toBe(true);
    expect(h.session.ticking).toBe(false);
  });

  it('requestPause toggles but ignores repeats within the debounce window', async () => {
    const h = harness();
    await started(h);
    h.session.requestPause(0);
    expect(h.session.paused).toBe(true);
    h.advance(10);
    h.session.requestPause(0); // same physical press through a second path
    expect(h.session.paused).toBe(true);
    h.advance(PAUSE_DEBOUNCE_MS);
    h.session.requestPause(1); // other human cannot resume
    expect(h.session.paused).toBe(true);
    h.session.requestPause(0);
    expect(h.session.paused).toBe(false);
  });

  it('blur releases every held input', async () => {
    const h = harness();
    await started(h);
    vi.mocked(h.providers[0]!.releaseAll).mockClear();
    h.session.releaseInputs();
    expect(h.providers[0]!.releaseAll).toHaveBeenCalledTimes(1);
  });

  it('queues commands into the provider', async () => {
    const h = harness();
    await started(h);
    h.session.queueCommand(0, Command.SKIP, 0);
    expect(h.providers[0]!.queueCommand).toHaveBeenCalledWith(0, Command.SKIP, 0);
  });

  it('wraps a custom provider without queueCommand so commands still reach its frames', async () => {
    const take = vi.fn();
    const custom = { ready: () => true, take, pump: vi.fn(), waiting: false, releaseAll: vi.fn(), dispose: vi.fn() };
    const h = harness();
    await started(h, setupFor(undefined, { inputProvider: custom }));
    h.session.queueCommand(1, Command.TACTIC_TEAM_PRESS, 0);
    const frames = h.rt().frames;
    h.rt().provider.take(1, frames, h.rt().curr);
    expect(take).toHaveBeenCalledTimes(1);
    expect(frames[1]!.cmd).toBe(Command.TACTIC_TEAM_PRESS);
  });
});

describe('FND-04 session phases', () => {
  it('shows half-time while the sim is in HALF_TIME and returns to the match', async () => {
    const h = harness();
    await started(h);
    const rt = h.rt();
    rt.curr.match.phase = MatchPhase.HALF_TIME;
    h.session.afterTick(rt);
    expect(h.router.current).toBe('half-time');
    rt.curr.match.phase = MatchPhase.KICK_OFF;
    h.session.afterTick(rt);
    expect(h.router.current).toBe('match');
    expect(h.router.stack).toEqual(['main', 'match']);
  });

  it('pausing during half-time shows the pause menu (match) and resuming goes back', async () => {
    const h = harness();
    await started(h);
    const rt = h.rt();
    rt.curr.match.phase = MatchPhase.HALF_TIME;
    h.session.afterTick(rt);
    h.session.setHidden(true);
    expect(h.router.current).toBe('match');
    h.session.setHidden(false);
    h.session.resume(-1);
    expect(h.router.current).toBe('half-time');
  });

  it('FULL_TIME shows the interim full-time screen, POST_MATCH the final one with the summary', async () => {
    const h = harness();
    const onFinish = vi.fn();
    await started(h, setupFor(undefined, { onFinish }));
    const rt = h.rt();
    rt.curr.match.phase = MatchPhase.FULL_TIME;
    h.session.afterTick(rt);
    expect(h.router.current).toBe('full-time');
    expect(h.screens.at(-1)!.params).toEqual({ final: false });
    rt.curr.teams[0]!.goals = 2;
    rt.curr.match.phase = MatchPhase.POST_MATCH;
    h.session.afterTick(rt);
    expect(h.session.finished).toBe(true);
    expect(h.session.ticking).toBe(false);
    expect(onFinish).toHaveBeenCalledTimes(1);
    const [summary, quit] = onFinish.mock.calls[0]! as [MatchSummary, boolean];
    expect(quit).toBe(false);
    expect(summary.teams[0].goals).toBe(2);
    expect(summary.winner).toBe(0);
    expect(h.router.current).toBe('full-time');
    expect(h.screens.at(-1)!.params.final).toBe(true);
    expect(h.session.lastSummary).toBe(summary);
    // Quit after the final whistle does not report a second finish.
    h.session.quit();
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(h.router.stack).toEqual(['main']);
  });

  it('leaves the router alone when onFinish navigates itself', async () => {
    const h = harness();
    await started(h, setupFor(undefined, { onFinish: () => h.router.go('cup') }));
    const rt = h.rt();
    rt.curr.match.phase = MatchPhase.POST_MATCH;
    h.session.afterTick(rt);
    expect(h.router.current).toBe('cup');
  });
});

describe('FND-04 UI human helpers', () => {
  it('maps devices to humans, explicit bindings first', () => {
    const setup = setupFor([{ human: 0, deviceIds: ['touch', ANY_DEVICE] }, { human: 1, deviceIds: ['pad:1'] }]);
    expect(humanForDevice(setup, 'pad:1')).toBe(1);
    expect(humanForDevice(setup, 'touch')).toBe(0);
    expect(humanForDevice(setup, 'pad:9')).toBe(0); // wildcard
    expect(humanForDevice(null, 'touch')).toBe(-1);
    expect(humanForDevice(setup, null)).toBe(-1);
  });

  it('uiHumanOf uses the last active device, else the only human', async () => {
    const h = harness();
    await started(h, setupFor([{ human: 1, deviceIds: ['pad:0'] }]));
    const ctx = { session: h.session, devices: h.devices } as unknown as AppContext;
    h.setLastActive('pad:0');
    expect(uiHumanOf(ctx)).toBe(1);
    h.setLastActive(null);
    expect(uiHumanOf(ctx)).toBe(1);
  });
});
