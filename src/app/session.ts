/**
 * Match session (contracts/app.ts SessionControl) plus the hooks the app shell and loop need. [FND-04]
 *
 * start(setup): 'loading' screen -> initMatch -> renderer.setMatch -> await renderer.warmUp() -> hud.setMatch ->
 * audio.matchStart -> 'match'. Input comes from setup.inputProvider or a local provider over the bound devices.
 *
 * Pause rules (brief sections 3 and 11): pause(-1) is a system pause (hidden page, portrait, error) that anyone may
 * resume; a human pause can be resumed only by that human. Hidden page: pause, release inputs, suspend audio; on
 * return audio resumes and the pause menu shows (never auto-resume). Blur releases every held input.
 *
 * resume() on a session that is not paused (running or finished) re-syncs the router to the match state; screens
 * that return to the match (recovery Resume) rely on it.
 *
 * Phases: HALF_TIME shows 'half-time', FULL_TIME shows 'full-time' (interim, Continue sends SKIP), POST_MATCH builds
 * the stats summary, calls setup.onFinish(summary, false) and shows the final 'full-time' screen (Rematch, Change
 * Teams, Quit). If onFinish navigates itself, the session leaves the router where it put it.
 *
 * restart() replays the same setup with a fresh seed; quit() calls onFinish(partialSummary, true) and returns to
 * 'main'. Both release every match resource (input sources, renderer match, HUD, audio) so nothing leaks between
 * matches. A load still in flight when the match is quit or restarted is abandoned via a generation counter.
 *
 * [INT-B] Hooks: deps.onTick(rt) runs first in afterTick (the app's replay recorder); deps.onPause / deps.onMatchEnd
 * (rumble stop) run when a pause starts and when the match ends or is torn down. deps.prepareState runs once on the
 * fresh state right after initMatch (default: the practice layout, modes/practice preparePracticeState).
 * setHumanDevice(human, ids | 'cpu') (D-019, PAD-03 reconnect card): 'cpu' queues Command.HAND_TO_CPU into that
 * human's frame and drops his local sources (his binding stays in the setup, so a rematch gets his devices back); a
 * device list rebinds him for the rest of the match (setup bindings updated, sources of dropped devices disposed, new
 * ones created through devices.createSource; devices kept in the list keep their source). False online, with a
 * custom input provider, outside a loaded match, for a human that is not playing (or was handed to the CPU), or when
 * a named device is bound explicitly to another playing human.
 */
import type {
  AppContext, AudioEngine, DeviceRegistry, Diagnostics, GameRenderer, HudPart, HumanBinding, MatchSetup, MatchSummary, ScreenId,
  ScreenParams, StatsTracker, TickInputProvider,
} from '../contracts/app';
import { MAX_HUMANS } from '../contracts/constants';
import type { Club } from '../contracts/data';
import { Command, ControllerKind, MatchPhase, ModeId } from '../contracts/enums';
import type { EventBuffer } from '../contracts/events';
import { createInputFrame, type CameraProjector, type InputFrame } from '../contracts/input';
import type { MatchConfig, SimState } from '../contracts/state';
import { preparePracticeState } from '../modes/practice';
import { createStatsTracker } from '../modes/stats';
import { cloneState as simCloneState } from '../sim/core/clone';
import { createEventBuffer as simCreateEventBuffer } from '../sim/core/events';
import { initMatch as simInitMatch } from '../sim/init';
import { ANY_DEVICE, createCommandQueue, createLocalInputProvider, type CommandQueue, type LocalInputProvider } from './localInput';
import type { AppRouter, AppSession, MatchRuntime } from './types';

/** Pause/resume requests from devices within this window of the last pause change are ignored. */
export const PAUSE_DEBOUNCE_MS = 250;

/** Screens that belong to a running match; the session only steers the router while one of them is shown. */
const MATCH_SCREENS: readonly ScreenId[] = ['match', 'half-time', 'full-time'];

export interface SessionDeps {
  router: AppRouter;
  renderer: GameRenderer;
  hud: HudPart;
  audio: AudioEngine;
  devices: DeviceRegistry;
  diagnostics: Diagnostics;
  clubs: readonly Club[];
  getProjector(): CameraProjector | null;
  /** Injected for tests; defaults are the real sim / modes implementations. */
  initMatch?: (config: MatchConfig, clubs: readonly Club[]) => SimState;
  cloneState?: (s: SimState) => SimState;
  createStats?: () => StatsTracker;
  createEventBuffer?: () => EventBuffer;
  createLocalProvider?: typeof createLocalInputProvider;
  /** Show or hide the match layer (game canvas). */
  setMatchLayer?(on: boolean): void;
  /** Let the loading screen paint before heavy work. Default: next animation frame (or a macrotask). */
  yieldFrame?(): Promise<void>;
  /** Seed for restart(). Default: Math.random mixed with a counter (app side only, never inside sim). */
  newSeed?(): number;
  now?(): number;
  onError?(err: unknown, where: string): void;
  /** After every tick, before phase watching (the app's replay recorder). Errors are reported once per match. */
  onTick?(rt: MatchRuntime): void;
  /** A pause started (rumble stop). */
  onPause?(byHuman: number): void;
  /** The match ended (POST_MATCH) or was torn down (quit, restart, dispose) after it loaded (rumble stop). */
  onMatchEnd?(): void;
  /** Once on the fresh state right after initMatch. Default: prepareModeState (practice layout). */
  prepareState?(s: SimState): void;
}

/** Mode-specific layout of a fresh match state (practice free play takes the opponent's outfield players off). */
export function prepareModeState(s: SimState): void {
  if (s.config && s.config.mode === ModeId.PRACTICE) preparePracticeState(s);
}

let seedCounter = 0;
/** A fresh uint32 seed for a new match (app side; the sim only ever uses the seed it is given). */
export function newMatchSeed(): number {
  seedCounter = (seedCounter + 1) >>> 0;
  return ((Math.random() * 0x100000000) ^ Math.imul(seedCounter, 0x9e3779b1)) >>> 0;
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      // rAF does not fire while hidden; the timeout keeps loading moving in a background tab.
      let done = false;
      const finish = (): void => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      requestAnimationFrame(() => setTimeout(finish, 0));
      setTimeout(finish, 100);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/** Wrap a provider that has no queueCommand so session commands still reach its frames (local use only). */
function withCommandQueue(inner: TickInputProvider, queue: CommandQueue): TickInputProvider {
  return {
    get waiting() {
      return inner.waiting;
    },
    ready: (tick) => inner.ready(tick),
    take(tick, frames, state) {
      inner.take(tick, frames, state);
      queue.applyTo(frames);
    },
    pump: (nowMs) => inner.pump(nowMs),
    releaseAll: () => inner.releaseAll(),
    dispose: () => inner.dispose(),
  };
}

type CommandSink = { queueCommand(human: number, cmd: Command, arg: number): void };
const hasQueue = (p: TickInputProvider): p is TickInputProvider & CommandSink =>
  typeof (p as Partial<CommandSink>).queueCommand === 'function';
type Rebindable = Pick<LocalInputProvider, 'rebind'>;
const canRebind = (p: TickInputProvider | null): p is TickInputProvider & Rebindable =>
  p !== null && typeof (p as Partial<Rebindable>).rebind === 'function';

/** Copy of `bindings` with `human` bound to `ids` (added when missing), sorted by human. Pure. */
export function withBinding(bindings: readonly HumanBinding[], human: number, ids: readonly string[]): HumanBinding[] {
  const out: HumanBinding[] = [];
  let found = false;
  for (const b of bindings) {
    if (b.human === human) {
      if (!found) out.push({ human, deviceIds: ids.slice() });
      found = true;
    } else {
      out.push({ human: b.human, deviceIds: b.deviceIds.slice() });
    }
  }
  if (!found) out.push({ human, deviceIds: ids.slice() });
  out.sort((a, b) => a.human - b.human);
  return out;
}

/** Valid, de-duplicated device ids (strings, non-empty), or null when the list is not usable. Pure. */
export function cleanDeviceIds(devs: readonly unknown[]): string[] | null {
  if (!Array.isArray(devs)) return null;
  const out: string[] = [];
  for (const d of devs) {
    if (typeof d !== 'string' || d.length === 0) return null;
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** Human bound to `deviceId` in `setup` (explicit binding first, then an ANY_DEVICE binding), or -1. Pure. */
export function humanForDevice(setup: MatchSetup | null, deviceId: string | null): number {
  if (!setup || !deviceId) return -1;
  for (const b of setup.bindings) if (b.deviceIds.includes(deviceId)) return b.human;
  for (const b of setup.bindings) if (b.deviceIds.includes(ANY_DEVICE)) return b.human;
  return -1;
}

/**
 * Best guess of the human acting in the UI (pause menu, half-time Continue): the human bound to the last active
 * device, else the only bound human, else -1. Uses only the contract API, so any screen can call it.
 */
export function uiHumanOf(ctx: Pick<AppContext, 'session' | 'devices'>): number {
  const setup = ctx.session.getSetup();
  let last: string | null;
  try {
    last = ctx.devices.lastActive();
  } catch {
    last = null;
  }
  const h = humanForDevice(setup, last);
  if (h >= 0) return h;
  if (setup && setup.bindings.length === 1) return setup.bindings[0]!.human;
  return -1;
}

export function createSession(deps: SessionDeps): AppSession {
  const { router, renderer, hud, audio, devices, diagnostics, clubs } = deps;
  const initMatch = deps.initMatch ?? simInitMatch;
  const cloneState = deps.cloneState ?? simCloneState;
  const createStats = deps.createStats ?? createStatsTracker;
  const createEvents = deps.createEventBuffer ?? simCreateEventBuffer;
  const createLocal = deps.createLocalProvider ?? createLocalInputProvider;
  const yieldFrame = deps.yieldFrame ?? defaultYield;
  const newSeed = deps.newSeed ?? newMatchSeed;
  const now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const prepareState = deps.prepareState ?? prepareModeState;
  const onError = (err: unknown, where: string): void => {
    if (deps.onError) deps.onError(err, where);
    else diagnostics.log('error', `${where}: ${String(err)}`, err);
  };

  let active = false;
  let loading = false;
  let loaded = false;
  let paused = false;
  let pausedBy = -1;
  let finished = false;
  let hidden = false;
  let blocked = false;
  let finishCalled = false;
  let finalShown = false;
  let lastPauseChange = -Infinity;
  let gen = 0;
  let lastPhase: MatchPhase = MatchPhase.PRE_MATCH;
  let setup: MatchSetup | null = null;
  let lastSetup: MatchSetup | null = null;
  let provider: TickInputProvider | null = null;
  let runtime: MatchRuntime | null = null;
  let lastSummary: MatchSummary | null = null;
  /** Humans handed to the CPU this match (setHumanDevice 'cpu'). */
  const cpuHumans: number[] = [];
  /** deps.onTick failed this match (reported once). */
  let tickHookFailed = false;
  const fallbackQueue = createCommandQueue();

  function setLayer(on: boolean): void {
    try {
      deps.setMatchLayer?.(on);
    } catch (err) {
      onError(err, 'setMatchLayer');
    }
  }

  function safe(fn: () => void, where: string): void {
    try {
      fn();
    } catch (err) {
      onError(err, where);
    }
  }

  /** Call setup.onFinish once. Returns true if it navigated the router itself. */
  function callFinish(s: MatchSetup | null, summary: MatchSummary | null, quit: boolean): boolean {
    if (!s || !s.onFinish) return false;
    const beforeId = router.current;
    const beforeDepth = router.stack.length;
    try {
      s.onFinish(summary, quit);
    } catch (err) {
      onError(err, 'setup.onFinish');
    }
    return router.current !== beforeId || router.stack.length !== beforeDepth;
  }

  /** Point the router at the screen the match state calls for (only while a match screen is shown). */
  function syncScreen(): void {
    if (!active || !loaded || !runtime) return;
    const cur = router.current;
    if (cur === null || !MATCH_SCREENS.includes(cur)) return;
    let want: ScreenId = 'match';
    let params: ScreenParams = {};
    if (finished) {
      want = 'full-time';
      params = { final: true, summary: lastSummary };
    } else if (!paused) {
      const ph = runtime.curr.match.phase;
      if (ph === MatchPhase.HALF_TIME) want = 'half-time';
      else if (ph === MatchPhase.FULL_TIME) {
        want = 'full-time';
        params = { final: false };
      }
    }
    if (cur === want && !(want === 'full-time' && finished && !finalShown)) return;
    if (want === 'full-time' && finished) finalShown = true;
    router.go(want, params);
  }

  function markPauseChange(): void {
    lastPauseChange = now();
  }

  function pause(byHuman: number): void {
    if (!active || finished || paused) return;
    const hooks = setup?.hooks;
    if (hooks?.allowPause) {
      let ok = true;
      try {
        ok = hooks.allowPause(byHuman, true);
      } catch (err) {
        onError(err, 'hooks.allowPause');
      }
      if (!ok) return;
    }
    paused = true;
    pausedBy = byHuman;
    markPauseChange();
    // Synchronously, before anything else can sample: no held stick, sprint or charge survives the pause (PAD-02).
    if (provider) safe(() => provider!.releaseAll(), 'releaseAll');
    safe(() => audio.setPaused(true), 'audio.setPaused');
    if (deps.onPause) safe(() => deps.onPause!(byHuman), 'onPause');
    if (hooks?.onPauseChange) safe(() => hooks.onPauseChange!(true, byHuman), 'hooks.onPauseChange');
    syncScreen();
  }

  function resume(byHuman: number): boolean {
    if (!active) return false;
    if (!paused) {
      // Nothing to resume (running, or finished: finished matches never pause). Still point the router at the
      // screen the match calls for, so a caller that just returned to a match screen (recovery Resume) lands on
      // half-time / the final full-time screen instead of a stale 'match' screen.
      syncScreen();
      return true;
    }
    if (pausedBy !== -1 && byHuman !== pausedBy) return false;
    if (hidden || blocked) return false;
    const hooks = setup?.hooks;
    if (hooks?.allowPause) {
      let ok = true;
      try {
        ok = hooks.allowPause(byHuman, false);
      } catch (err) {
        onError(err, 'hooks.allowPause');
      }
      if (!ok) return false;
    }
    paused = false;
    pausedBy = -1;
    markPauseChange();
    if (provider) safe(() => provider!.releaseAll(), 'releaseAll');
    safe(() => audio.setPaused(false), 'audio.setPaused');
    if (hooks?.onPauseChange) safe(() => hooks.onPauseChange!(false, byHuman), 'hooks.onPauseChange');
    syncScreen();
    return true;
  }

  function teardown(): void {
    gen++;
    const p = provider;
    provider = null;
    if (p) safe(() => p.dispose(), 'provider.dispose');
    if (loaded && !finished) {
      safe(() => audio.matchEnd(), 'audio.matchEnd');
      if (deps.onMatchEnd) safe(() => deps.onMatchEnd!(), 'onMatchEnd');
    }
    safe(() => audio.setPaused(false), 'audio.setPaused');
    if (loaded || loading) {
      safe(() => renderer.clearMatch(), 'renderer.clearMatch');
      safe(() => hud.setVisible(false), 'hud.setVisible');
    }
    setLayer(false);
    fallbackQueue.clear();
    runtime = null;
    if (setup) lastSetup = setup;
    setup = null;
    active = false;
    loading = false;
    loaded = false;
    paused = false;
    pausedBy = -1;
    finished = false;
    finishCalled = false;
    finalShown = false;
    cpuHumans.length = 0;
    tickHookFailed = false;
  }

  async function load(s: MatchSetup, myGen: number): Promise<void> {
    try {
      await yieldFrame();
      if (gen !== myGen) return;
      const curr = initMatch(s.config, clubs);
      prepareState(curr);
      const prev = cloneState(curr);
      const events = createEvents();
      const stats = createStats();
      stats.reset(curr);
      const frames: InputFrame[] = [];
      for (let h = 0; h < MAX_HUMANS; h++) frames.push(createInputFrame());
      let p: TickInputProvider;
      if (s.inputProvider) {
        p = hasQueue(s.inputProvider) ? s.inputProvider : withCommandQueue(s.inputProvider, fallbackQueue);
      } else {
        p = createLocal(s.bindings, devices, () => (runtime ? runtime.curr : null), deps.getProjector, { onError });
      }
      provider = p;
      renderer.setMatch(curr, clubs);
      await renderer.warmUp();
      if (gen !== myGen) return;
      hud.setMatch(curr, clubs);
      hud.setVisible(true);
      audio.matchStart(curr);
      runtime = { prev, curr, provider: p, frames, events, stats };
      lastPhase = curr.match.phase;
      loading = false;
      loaded = true;
      setLayer(true);
      if (hidden || blocked) pause(-1);
      if (router.current === 'loading') router.replace('match');
      else router.go('match');
      syncScreen();
    } catch (err) {
      if (gen !== myGen) return;
      onError(err, 'session.load');
    }
  }

  function finish(rt: MatchRuntime): void {
    finished = true;
    let summary: MatchSummary | null = null;
    try {
      summary = rt.stats.summary(rt.curr);
    } catch (err) {
      onError(err, 'stats.summary');
    }
    lastSummary = summary;
    if (provider) safe(() => provider!.releaseAll(), 'releaseAll');
    safe(() => audio.matchEnd(), 'audio.matchEnd');
    if (deps.onMatchEnd) safe(() => deps.onMatchEnd!(), 'onMatchEnd');
    finishCalled = true;
    const navigated = callFinish(setup, summary, false);
    if (!navigated) syncScreen();
  }

  const session: AppSession = {
    get active() {
      return active;
    },
    get loading() {
      return loading;
    },
    get loaded() {
      return loaded;
    },
    get paused() {
      return paused;
    },
    get pausedBy() {
      return pausedBy;
    },
    get finished() {
      return finished;
    },
    get lastSummary() {
      return lastSummary;
    },
    get ticking() {
      return active && loaded && !paused && !finished && !hidden && !blocked;
    },
    start(s) {
      if (active) teardown();
      gen++;
      const myGen = gen;
      setup = s;
      active = true;
      loading = true;
      loaded = false;
      paused = false;
      pausedBy = -1;
      finished = false;
      finishCalled = false;
      finalShown = false;
      lastSummary = null;
      safe(() => hud.setVisible(false), 'hud.setVisible');
      router.go('loading', { setup: s });
      void load(s, myGen);
    },
    pause,
    resume,
    requestPause(human) {
      if (!active || !loaded || finished) return;
      if (now() - lastPauseChange < PAUSE_DEBOUNCE_MS) return;
      if (!paused) pause(human);
      else resume(human);
    },
    restart() {
      const s = setup ?? lastSetup;
      if (!s) return;
      if (s.inputProvider) {
        diagnostics.log('session', 'restart() is not available for a custom input provider');
        return;
      }
      teardown();
      session.start({ ...s, config: { ...s.config, seed: newSeed() >>> 0 } });
    },
    quit() {
      const s = setup;
      const needFinish = active && !finishCalled;
      let summary: MatchSummary | null = null;
      if (needFinish && runtime) {
        try {
          summary = runtime.stats.summary(runtime.curr);
        } catch (err) {
          onError(err, 'stats.summary');
        }
      }
      if (s?.hooks?.onQuit) safe(() => s.hooks!.onQuit!(), 'hooks.onQuit');
      teardown();
      const navigated = needFinish ? callFinish(s, summary, true) : false;
      if (!navigated) router.resetTo('main');
    },
    queueCommand(human, cmd, arg) {
      if (cmd === Command.NONE) return;
      const p = provider;
      if (p && hasQueue(p)) p.queueCommand(human, cmd, arg);
      else fallbackQueue.push(human, cmd, arg);
    },
    setHumanDevice(human, devs) {
      if (!active || !loaded || finished || !setup || setup.inputProvider || !runtime) return false;
      if (!Number.isInteger(human) || human < 0 || human >= MAX_HUMANS || cpuHumans.includes(human)) return false;
      const ctl = runtime.curr.ctrl ? runtime.curr.ctrl[human] : undefined;
      if (!ctl || ctl.kind !== ControllerKind.HUMAN) return false;
      const p = provider;
      if (devs === 'cpu') {
        // Through the frame (deterministic, in replays); the sim applies it on the next tick, also after a pause.
        session.queueCommand(human, Command.HAND_TO_CPU, human);
        cpuHumans.push(human);
        if (canRebind(p)) safe(() => p.rebind(human, []), 'rebind');
        return true;
      }
      const ids = cleanDeviceIds(devs);
      if (!ids || !canRebind(p)) return false;
      // Two humans never share a device: a device named explicitly by another playing human refuses the rebind.
      for (const b of setup.bindings) {
        if (b.human === human || cpuHumans.includes(b.human)) continue;
        for (const id of ids) if (id !== ANY_DEVICE && b.deviceIds.includes(id)) return false;
      }
      try {
        p.rebind(human, ids);
      } catch (err) {
        onError(err, 'rebind');
        return false;
      }
      setup = { ...setup, bindings: withBinding(setup.bindings, human, ids) };
      return true;
    },
    getState: () => (runtime ? runtime.curr : null),
    getSetup: () => setup,
    runtime: () => runtime,
    afterTick(rt) {
      if (deps.onTick && !tickHookFailed) {
        try {
          deps.onTick(rt);
        } catch (err) {
          tickHookFailed = true; // never let a per-tick hook break play; report once per match
          onError(err, 'session.onTick');
        }
      }
      const ph = rt.curr.match.phase;
      if (ph === lastPhase) return;
      lastPhase = ph;
      if (ph === MatchPhase.POST_MATCH && !finished) finish(rt);
      else syncScreen();
    },
    setHidden(h) {
      if (hidden === h) return;
      hidden = h;
      if (h) {
        if (active && !finished) pause(-1);
        if (provider) safe(() => provider!.releaseAll(), 'releaseAll');
        safe(() => audio.suspend(), 'audio.suspend');
      } else {
        safe(() => audio.resume(), 'audio.resume');
        syncScreen();
      }
    },
    setBlocked(b) {
      if (blocked === b) return;
      blocked = b;
      if (b && active && !finished) pause(-1);
      if (b && provider) safe(() => provider!.releaseAll(), 'releaseAll');
    },
    releaseInputs() {
      if (provider) safe(() => provider!.releaseAll(), 'releaseAll');
    },
    humanForDevice: (deviceId) => humanForDevice(setup, deviceId),
    uiHuman: () => uiHumanOf({ session, devices }),
    dispose() {
      teardown();
    },
  };
  return session;
}
