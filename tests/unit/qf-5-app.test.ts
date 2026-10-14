/**
 * [QF-5] App / session lifecycle QA (FIX-11, QA-39): the real session + loop + sim step with fake presentation.
 * Pause rules, hidden page, tab switch, refresh rate, rematch / quit leaks.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppContext, DeviceRegistry, MatchSetup, Screen, ScreenId } from '../../src/contracts/app';
import { ControllerKind } from '../../src/contracts/enums';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createLoop } from '../../src/app/loop';
import { createNullRenderer } from '../../src/app/nullRenderer';
import { createRouter } from '../../src/app/router';
import { createSession } from '../../src/app/session';
import type { AppSession } from '../../src/app/types';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export function appRig() {
  const focus = { attach: vi.fn(), detach: vi.fn(), handle: vi.fn(), focus: vi.fn(), onAction: vi.fn(() => () => undefined) };
  const root = { appendChild: () => undefined } as unknown as HTMLElement;
  const router = createRouter(root, () => ({ focus } as unknown as AppContext), {
    listen: false,
    createContainer: () => ({ remove() {} }) as unknown as HTMLElement,
  });
  for (const id of ['main', 'loading', 'match', 'half-time', 'full-time', 'recovery'] as ScreenId[]) {
    router.register(id, (): Screen => ({ id, mount() {}, unmount() {} }));
  }
  router.go('main');
  const renderer = createNullRenderer();
  const hud = { mount: vi.fn(), setMatch: vi.fn(), update: vi.fn(), onEvents: vi.fn(), setVisible: vi.fn(), dispose: vi.fn() };
  const audio = {
    unlock: vi.fn(), unlocked: true, setVolumes: vi.fn(), onEvents: vi.fn(), update: vi.fn(), playUi: vi.fn(),
    matchStart: vi.fn(), matchEnd: vi.fn(), setPaused: vi.fn(), suspend: vi.fn(), resume: vi.fn(),
  };
  const devices: DeviceRegistry = {
    list: () => [], subscribe: () => () => undefined, lastActive: () => null,
    createSource: ((id: string) => ({ id, kind: 'pad', sample() {}, releaseAll() {}, dispose() {} })) as never,
  };
  const diagnostics = { log: vi.fn(), recent: () => [], debug: false, setDebug: vi.fn(), report: () => '' };
  const onError = vi.fn();
  let now = 0;
  const session = createSession({
    router, renderer, hud, audio, devices, diagnostics, clubs: CLUBS, getProjector: () => null, onError,
    yieldFrame: () => Promise.resolve(), now: () => now,
  });
  const loop = createLoop({
    session, renderer, hud, audio, router, getProjector: () => null, onError,
    raf: () => 1, caf: () => undefined, now: () => 0,
  });
  /** boot.ts page lifecycle: hidden stops the loop; visible restarts it and forgets the time away. */
  const setHidden = (h: boolean): void => {
    session.setHidden(h);
    if (h) loop.stop();
    else {
      loop.start();
      loop.resetTiming();
      loop.invalidate();
    }
  };
  /** Run frames every `dtMs` (optional jitter in ms) for `ms`; returns the ticks run. */
  const run = (ms: number, dtMs = 1000 / 60, jitter = 0): number => {
    let ticks = 0;
    const end = now + ms;
    let k = 0;
    while (now < end - 1e-9) {
      now += dtMs + (jitter ? (k++ % 2 === 0 ? jitter : -jitter) : 0);
      loop.frame(now);
      ticks += loop.info.ticks;
    }
    return ticks;
  };
  return {
    router, renderer, hud, audio, session: session as AppSession, loop, onError, setHidden, run,
    advance: (ms: number) => { now += ms; },
  };
}

export function botSetup(seed = 7): MatchSetup {
  const config = createMatchConfig();
  config.seed = seed;
  config.humans[0]!.kind = ControllerKind.NONE;
  config.humans[0]!.side = -1;
  return { config, bindings: [] };
}

describe('QF-5 app loop through the real session and sim', () => {
  it('glitch: game runs fast after a pause, a tab switch or on a 120 Hz display (real session, loop and sim)', async () => {
    const r = appRig();
    r.loop.start();
    r.session.start(botSetup());
    await tick();
    await tick();
    expect(r.session.loaded).toBe(true);
    const s = () => r.session.getState()!;
    // 60 Hz: real time.
    expect(r.run(2000)).toBeGreaterThanOrEqual(119);
    const t0 = s().tick;
    expect(t0).toBeLessThanOrEqual(121);
    // A 10 s pause runs nothing, and the frame after the resume adds nothing.
    r.session.pause(0);
    expect(r.run(10_000)).toBe(0);
    expect(r.session.resume(0)).toBe(true);
    r.advance(5000); // a long first frame (the pause menu closing on a slow device)
    r.loop.frame(Number.NaN); // never NaN-poisons the accumulator
    expect(r.run(1000)).toBeLessThanOrEqual(61);
    // Tab switch: 30 s away, then a burst of fast frames on return.
    const t1 = s().tick;
    r.setHidden(true);
    r.advance(30_000);
    expect(r.loop.running).toBe(false);
    r.setHidden(false);
    expect(r.session.paused).toBe(true); // the pause menu shows; nothing ran while away
    expect(s().tick).toBe(t1);
    expect(r.session.resume(-1)).toBe(true);
    const back = r.run(1000);
    expect(back).toBeGreaterThanOrEqual(59);
    expect(back).toBeLessThanOrEqual(61);
    // 120 Hz with timestamp jitter: still 60 ticks per second.
    const hz120 = r.run(3000, 1000 / 120, 0.3);
    expect(hz120).toBeGreaterThanOrEqual(179);
    expect(hz120).toBeLessThanOrEqual(181);
    // 144 Hz and 90 Hz too.
    expect(Math.abs(r.run(2000, 1000 / 144) - 120)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.run(2000, 1000 / 90) - 120)).toBeLessThanOrEqual(1);
    expect(r.onError).not.toHaveBeenCalled();
  });
});

describe('QF-5 local input provider: one broken device never freezes the match', () => {
  it('a source that throws in pollFrame and sample is reported once; the other human keeps playing', async () => {
    const { createLocalInputProvider } = await import('../../src/app/localInput');
    const { createInputFrame, Btn } = await import('../../src/contracts/input');
    const polled: number[] = [];
    const sources = {
      bad: {
        sample() { throw new Error('pad gone'); },
        pollFrame() { throw new Error('pad gone'); },
        releaseAll() {},
        dispose() {},
      },
      good: {
        sample(f: { buttons: number; mx: number }) { f.buttons |= Btn.SHOOT; f.mx = 1; },
        pollFrame(t: number) { polled.push(t); },
        releaseAll() {},
        dispose() {},
      },
    };
    const devices: DeviceRegistry = {
      list: () => [], subscribe: () => () => undefined, lastActive: () => null,
      createSource: ((id: string) => sources[id as 'bad' | 'good']) as never,
    };
    const errors: string[] = [];
    const p = createLocalInputProvider(
      [{ human: 0, deviceIds: ['bad'] }, { human: 1, deviceIds: ['good'] }], devices, () => null, () => null,
      { onError: (_e, where) => errors.push(where) },
    );
    const frames = [createInputFrame(), createInputFrame()];
    const state = { ctrl: [{ side: 0 }, { side: 1 }] } as never;
    for (let t = 1; t <= 30; t++) {
      p.pump(t * 16);
      p.take(t, frames, state);
      expect(frames[1]!.buttons & Btn.SHOOT).toBe(Btn.SHOOT);
      expect(frames[0]!.buttons).toBe(0);
    }
    expect(polled).toHaveLength(30);
    expect(errors).toEqual(['source.pollFrame']);
    p.dispose();
  });
});

describe('QF-5 match warm-up (QA-39)', () => {
  it('the session finishes the audio pre-render while the match loads, before audio.matchStart and the first tick', async () => {
    const r = appRig();
    const order: string[] = [];
    const audio = r.audio as unknown as Record<string, unknown>;
    audio.warmUp = vi.fn(() => order.push('audio.warmUp'));
    (r.audio.matchStart as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('audio.matchStart'));
    vi.spyOn(r.renderer, 'warmUp').mockImplementation(() => {
      order.push('renderer.warmUp');
      return Promise.resolve();
    });
    r.loop.start();
    r.session.start(botSetup(3));
    await tick();
    await tick();
    expect(order).toEqual(['audio.warmUp', 'renderer.warmUp', 'audio.matchStart']);
    expect(r.session.getState()!.tick).toBe(0);
    // A throwing warm-up never blocks the match.
    const r2 = appRig();
    (r2.audio as unknown as Record<string, unknown>).warmUp = () => { throw new Error('bank'); };
    r2.session.start(botSetup(4));
    await tick();
    await tick();
    expect(r2.session.loaded).toBe(true);
    expect(r2.onError).toHaveBeenCalledWith(expect.any(Error), 'audio.warmUp');
  });
});

describe('QF-5 rematch / quit leaks (FIX-11)', () => {
  it('15 rematches and quits with the real session, local input and audio engine leave nothing behind', async () => {
    const { createAudioEngine } = await import('../../src/audio/engine');
    const { createSettingsStore } = await import('../../src/platform/settingsStore');
    const { createMemoryStorage } = await import('../../src/platform/storage');
    const { asContext, createFakeContext, createFakeWindow, flush } = await import('./aud-01-fakes');
    const { perspectiveTeam, setLocalPerspective } = await import('../../src/audio/crowd');
    vi.stubGlobal('window', createFakeWindow());
    const ac = createFakeContext();
    const engine = createAudioEngine(createSettingsStore(createMemoryStorage()), { createContext: () => asContext(ac), now: () => 0 });
    await engine.unlock();
    await flush();
    engine.services!.bank.flush();

    const live = new Set<string>();
    let subs = 0;
    let made = 0;
    const devices: DeviceRegistry = {
      list: () => [{ id: 'pad:0', kind: 'pad', label: 'Pad', family: 0, connected: true }],
      subscribe: () => {
        subs++;
        return () => { subs--; };
      },
      lastActive: () => 'pad:0',
      createSource: ((id: string) => {
        const key = `${id}#${made++}`;
        live.add(key);
        return { id, kind: 'pad', sample() {}, releaseAll() {}, dispose() { live.delete(key); } };
      }) as never,
    };
    const focus = { attach: vi.fn(), detach: vi.fn(), handle: vi.fn(), focus: vi.fn(), onAction: vi.fn(() => () => undefined) };
    const router = createRouter({ appendChild: () => undefined } as unknown as HTMLElement, () => ({ focus } as unknown as AppContext), {
      listen: false, createContainer: () => ({ remove() {} }) as unknown as HTMLElement,
    });
    for (const id of ['main', 'loading', 'match', 'half-time', 'full-time', 'recovery'] as ScreenId[]) {
      router.register(id, (): Screen => ({ id, mount() {}, unmount() {} }));
    }
    router.go('main');
    const renderer = createNullRenderer();
    const setMatch = vi.spyOn(renderer, 'setMatch');
    const clearMatch = vi.spyOn(renderer, 'clearMatch');
    const hud = { mount: vi.fn(), setMatch: vi.fn(), update: vi.fn(), onEvents: vi.fn(), setVisible: vi.fn(), dispose: vi.fn() };
    const onError = vi.fn();
    const session = createSession({
      router, renderer, hud, audio: engine, devices, clubs: CLUBS, getProjector: () => null, onError,
      diagnostics: { log: vi.fn(), recent: () => [], debug: false, setDebug: vi.fn(), report: () => '' },
      yieldFrame: () => Promise.resolve(),
    });
    const loop = createLoop({ session, renderer, hud, audio: engine, router, getProjector: () => null, onError, raf: () => 1, caf: () => undefined, now: () => 0 });
    loop.start();
    let now = 0;
    const frames = (n: number): void => {
      for (let i = 0; i < n; i++) {
        now += 1000 / 60;
        ac.advance(1 / 60);
        loop.frame(now);
      }
    };
    const loopSources = () => ac.created.sources.filter((x) => x.loop && x.stoppedAt < 0).length;
    const setup = (): MatchSetup => {
      const s = botSetup(21);
      s.config.humans[0]!.kind = ControllerKind.HUMAN;
      s.config.humans[0]!.side = 0;
      s.bindings = [{ human: 0, deviceIds: ['pad:0'] }];
      return s;
    };
    const stackLens: number[] = [];
    session.start(setup());
    for (let round = 0; round < 15; round++) {
      await tick();
      await tick();
      expect(session.loaded).toBe(true);
      frames(30);
      if (round % 3 === 2) session.pause(0); // rematch from the pause menu
      expect(live.size).toBe(1);
      expect(loopSources()).toBe(2); // one crowd bed: murmur + roar
      stackLens.push(router.stack.length);
      if (round === 14) break;
      session.restart();
    }
    expect(new Set(stackLens).size).toBe(1); // the history never grows
    expect(setMatch.mock.calls.length - clearMatch.mock.calls.length).toBe(1);
    session.quit();
    frames(5);
    expect(router.stack).toEqual(['main']);
    expect(live.size).toBe(0);
    expect(subs).toBe(0);
    expect(loopSources()).toBe(0); // the bed is stopped (fading out), never left looping
    expect(setMatch.mock.calls.length).toBe(clearMatch.mock.calls.length);
    expect(engine.paused).toBe(false);
    expect(perspectiveTeam(null)).toBe(0);
    setLocalPerspective(-1);
    expect(onError).not.toHaveBeenCalled();
    engine.dispose();
    vi.unstubAllGlobals();
  });
});

describe('QF-5 pause rules: nobody is ever locked out', () => {
  it('a pause held by a human handed to the CPU (pad died during his pause menu) can be resumed by the other player', async () => {
    const r = appRig();
    const setup = botSetup(9);
    setup.config.humans[0] = { ...setup.config.humans[0]!, kind: ControllerKind.HUMAN, side: 0 };
    setup.config.humans[1] = { ...setup.config.humans[1]!, kind: ControllerKind.HUMAN, side: 1 };
    setup.bindings = [{ human: 0, deviceIds: ['touch'] }, { human: 1, deviceIds: ['pad:1'] }];
    (r.session as unknown as { start(s: MatchSetup): void }).start(setup);
    await tick();
    await tick();
    expect(r.session.loaded).toBe(true);
    r.run(500);
    // Player 2 opens the pause menu; his pad dies; the reconnect flow takes the pause over (-2), he is handed to the
    // CPU, and the flow hands the pause back to its previous owner (player 2) when the card closes.
    r.session.pause(1);
    expect(r.session.resume(1)).toBe(true);
    r.session.pause(-2);
    expect(r.session.setHumanDevice(1, 'cpu')).toBe(true);
    expect(r.session.resume(-2)).toBe(true);
    r.session.pause(1);
    expect(r.session.paused).toBe(true);
    expect(r.session.pausedBy).toBe(-1); // a system pause now
    expect(r.session.resume(0)).toBe(true); // player 1 is not locked out
    r.run(200);
    expect(r.session.getState()!.ctrl[1]!.kind).not.toBe(ControllerKind.HUMAN); // the hand-off reached the sim
    expect(r.onError).not.toHaveBeenCalled();
    // And when the hand-off happens while player 2's own pause is up.
    const r2 = appRig();
    (r2.session as unknown as { start(s: MatchSetup): void }).start(setup);
    await tick();
    await tick();
    r2.session.pause(1);
    expect(r2.session.resume(0)).toBe(false); // the normal rule: only he may lift his pause
    expect(r2.session.setHumanDevice(1, 'cpu')).toBe(true);
    expect(r2.session.pausedBy).toBe(-1);
    expect(r2.session.resume(0)).toBe(true);
  });
});

describe('QF-5 online crowd perspective goes through the audio engine', () => {
  it('the local online side reaches the crowd at match start and is cleared at teardown; an engine without it still loads', async () => {
    const { createAudioEngine } = await import('../../src/audio/engine');
    const { createSettingsStore } = await import('../../src/platform/settingsStore');
    const { createMemoryStorage } = await import('../../src/platform/storage');
    const { asContext, createFakeContext, createFakeWindow, flush } = await import('./aud-01-fakes');
    const { perspectiveTeam } = await import('../../src/audio/crowd');
    type Crowd = import('../../src/audio/crowd').CrowdModule;
    vi.stubGlobal('window', createFakeWindow());
    const ac = createFakeContext();
    const engine = createAudioEngine(createSettingsStore(createMemoryStorage()), { createContext: () => asContext(ac), now: () => 0 });
    await engine.unlock();
    await flush();
    const r = appRig();
    // Swap the rig's audio mock for the real engine (session deps are read at creation: build a new session).
    const session = createSession({
      router: r.router, renderer: r.renderer, hud: r.hud, audio: engine, clubs: CLUBS, getProjector: () => null, onError: r.onError,
      devices: { list: () => [], subscribe: () => () => undefined, lastActive: () => null, createSource: vi.fn() as never },
      diagnostics: { log: vi.fn(), recent: () => [], debug: false, setDebug: vi.fn(), report: () => '' },
      yieldFrame: () => Promise.resolve(),
    });
    const setup = botSetup(5);
    setup.config.humans[0] = { ...setup.config.humans[0]!, kind: ControllerKind.HUMAN, side: 0 };
    setup.config.humans[1] = { ...setup.config.humans[1]!, kind: ControllerKind.HUMAN, side: 1 };
    const provider = { ready: () => true, take() {}, pump() {}, waiting: false, releaseAll() {}, dispose() {}, queueCommand() {} };
    session.start({ ...setup, inputProvider: provider, modeData: { kind: 'online', session: { localHuman: 1 } } });
    await tick();
    await tick();
    expect(session.loaded).toBe(true);
    expect((engine.services!.modules.crowd as Crowd).perspective).toBe(1); // the away player's device backs the away side
    session.quit();
    expect(perspectiveTeam(null)).toBe(0); // cleared
    expect(r.onError).not.toHaveBeenCalled();
    engine.dispose();
    vi.unstubAllGlobals();
    // The plain contract AudioEngine (no setPerspective / warmUp) loads a match all the same.
    const r2 = appRig();
    r2.session.start(botSetup(6));
    await tick();
    await tick();
    expect(r2.session.loaded).toBe(true);
    expect(r2.onError).not.toHaveBeenCalled();
  });
});
