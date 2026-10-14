/**
 * [AUD-01] Audio engine: unlock, buses, mixing, limiter, voice limiting, buffer pre-rendering, pause ducking and
 * interruption recovery (BRIEF section 3 "Audio", section 8 "Sound", glitch list "Audio").
 *
 * Graph, built on the first unlock() (a user gesture) and never before, so no autoplay warning is ever logged:
 *
 *   crowd bus ---+
 *   effects bus -+--> master (master volume) --> out (lifecycle fade) --> limiter --> destination
 *   menus bus ---+
 *
 * - Volumes follow settings.audio live (and setVolumes for previews); every change is a smoothed ramp
 *   (setTargetAtTime), never a step, so slider drags and pause ducking never click.
 * - `out` is the lifecycle gain: 0 while the context is not running (suspended, iOS 'interrupted') and faded in
 *   over LOCAL_TUNING.resumeFade whenever it starts running again, so resuming mid-loop never clicks.
 * - The limiter (DynamicsCompressor) on the master keeps stacked peaks (goal roar + whistle + kick) from clipping.
 * - Modules (crowd AUD-02, sfx AUD-03, whistles AUD-04, eventMap + ui AUD-05) are created once on unlock with an
 *   AudioCtx that also carries services (services.ts): capped one-shot voice pools per bus and the buffer bank.
 *   The bank renders the modules' buffers in chunks from update() within a small per-frame budget.
 * - setPaused(true): crowd ducked to LOCAL_TUNING.pauseCrowdDuck, effects muted, one-shots stopped; menus stay.
 *   Sim events are only passed on while the context runs and the game is not paused, so nothing queued during a
 *   pause or a background stint plays all at once afterwards ("sounds stacking after a pause").
 * - suspend()/resume() for backgrounding. Whenever sound is wanted and the context is not running, the next user
 *   gesture resumes it: iOS refuses resume() outside a gesture (the promise may resolve with the context still
 *   'suspended', or never settle while 'interrupted' after a call or Siri) and no statechange follows. Listeners
 *   (pointerdown, pointerup, touchend, mousedown, keydown, click: on iPad touch only pointerup/touchend/click count
 *   as activation) stay armed until the context reports 'running'. A context that says 'running' but whose clock
 *   stopped (an iOS zombie after an interruption) is detected in update() and restarted on the next gesture.
 * - A context the OS resumes while the page is hidden is suspended again (no crowd in the background).
 * - A module that throws (factory, onEvents, update, lifecycle hooks) is isolated: the others and the game go on.
 * - Without Web Audio (Node tests, very old browsers) every call is a no-op.
 */
import type { AudioEngine, SettingsStore } from '../contracts/app';
import type { EventBuffer } from '../contracts/events';
import type { AudioSettings } from '../contracts/settings';
import type { ReadonlySimState } from '../contracts/state';
import { createBufferBank } from './bank';
import { createCrowd } from './crowd';
import { createEventMap } from './eventMap';
import type { AudioCtxWithServices, AudioModuleName, AudioServices } from './services';
import { createSfx } from './sfx';
import type { AudioCtx, AudioModule, UiAudioModule } from './types';
import { createUi } from './ui';
import { createVoicePool } from './voices';
import { createWhistles } from './whistles';

const LOCAL_TUNING = {
  /** Bus volume smoothing time constant, s (63% of a change after this, ~99% after 5x). */
  volumeTimeConstant: 0.03,
  /** Crowd bus level while the pause menu is open, fraction of the crowd volume. */
  pauseCrowdDuck: 0.3,
  /** Output fade-in whenever the context starts running (unlock, resume, end of an interruption), s. */
  resumeFade: 0.08,
  /** Fade of one-shots stopped by pause / match start / match end, s. */
  stopFade: 0.06,
  /** Simultaneous one-shot voices per bus. */
  effectsVoices: 16,
  crowdVoices: 6,
  menusVoices: 4,
  /** Largest frame time passed to modules, s (a long frame never jumps smoothing). */
  maxDt: 0.1,
  /** Main-thread time for buffer pre-rendering per frame, ms. */
  bankBudgetMs: 2,
  /** A 'running' context whose clock has not moved for this long (frame time) is treated as interrupted, s. */
  stallSec: 0.75,
  /** Limiter on the master: threshold dBFS, knee dB, ratio, attack s, release s. */
  limiterThreshold: -3,
  limiterKnee: 0,
  limiterRatio: 20,
  limiterAttack: 0.002,
  limiterRelease: 0.15,
} as const; // TUNING-CR

export const AUDIO_ENGINE_TUNING = LOCAL_TUNING;

/** Module order (index = failure report index and AudioEngineInfo.moduleFailures index). */
export const AUDIO_MODULE_NAMES = ['crowd', 'sfx', 'whistles', 'eventMap', 'ui'] as const;

/** Events that may carry user activation; touch pointerdown does not on iOS, so all are armed together. */
const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'keydown', 'click'] as const;

export interface BusLevels {
  master: number;
  crowd: number;
  effects: number;
  menus: number;
}

export interface AudioEngineInfo {
  state: string;
  unlocked: boolean;
  paused: boolean;
  /** False between suspend() and resume() (hidden page). */
  wanted: boolean;
  gestureArmed: boolean;
  /** The context said 'running' but its clock stopped. */
  stalled: boolean;
  /** Output (lifecycle) gain is up. */
  outputUp: boolean;
  voices: { effects: number; crowd: number; menus: number };
  bankPending: number;
  bankFailed: number;
  moduleFailures: number[];
  /** Current gains of the buses and the lifecycle output (0 before unlock). */
  levels: { master: number; crowd: number; effects: number; menus: number; output: number };
}

export interface AudioEngineImpl extends AudioEngine {
  /** The AudioContext once unlocked (diagnostics, tests). */
  readonly context: AudioContext | null;
  readonly paused: boolean;
  /** Voice pools and buffer bank once unlocked (modules get them through their AudioCtx). */
  readonly services: AudioServices | null;
  /** Snapshot for diagnostics and tests (allocates; not for per-frame use). */
  info(): AudioEngineInfo;
  dispose(): void;
}

export interface AudioEngineOptions {
  /** Context factory (tests). Default: window.AudioContext / webkitAudioContext. */
  createContext?: () => AudioContext | null;
  /**
   * A module threw. Reported once per module (the first failure); later failures of that module are counted
   * silently. Default: ignore. Boot logs it to diagnostics (never the recovery screen: sound must not stop play).
   */
  onModuleError?(err: unknown, where: string): void;
  /** Clock for the pre-render budget, ms (tests). Default performance.now. */
  now?: () => number;
}

/** 0..1 for any input (non-numbers and NaN are silent). */
export function clampVolume(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

/** Target bus gains for the given settings and pause state (pure). */
export function busTargets(
  v: Readonly<AudioSettings>,
  paused: boolean,
  out: BusLevels,
  duck: number = LOCAL_TUNING.pauseCrowdDuck,
): BusLevels {
  out.master = clampVolume(v.master);
  out.crowd = clampVolume(v.crowd) * (paused ? clampVolume(duck) : 1);
  out.effects = paused ? 0 : clampVolume(v.effects);
  out.menus = clampVolume(v.menus);
  return out;
}

/**
 * Smoothly move `p` toward `target` from time `now` (exponential approach, time constant `tc`). Previous future
 * automation is cancelled first so changes never pile up. Falls back to a plain value write where automation is
 * missing.
 */
export function rampParam(p: AudioParam, target: number, now: number, tc: number): void {
  try {
    if (typeof p.setTargetAtTime === 'function') {
      if (typeof p.cancelScheduledValues === 'function') p.cancelScheduledValues(now);
      p.setTargetAtTime(target, now, tc);
      return;
    }
  } catch {
    /* fall back */
  }
  p.value = target;
}

/** Set `p` to `v` at `now`, cancelling later automation. */
function setParamNow(p: AudioParam, v: number, now: number): void {
  try {
    if (typeof p.setValueAtTime === 'function') {
      if (typeof p.cancelScheduledValues === 'function') p.cancelScheduledValues(now);
      p.setValueAtTime(v, now);
      return;
    }
  } catch {
    /* fall back */
  }
  p.value = v;
}

/** Linear fade of `p` from `from` to `to` over `dur` starting at `now`. */
function fadeParam(p: AudioParam, from: number, to: number, now: number, dur: number): void {
  try {
    if (typeof p.linearRampToValueAtTime === 'function' && typeof p.setValueAtTime === 'function') {
      if (typeof p.cancelScheduledValues === 'function') p.cancelScheduledValues(now);
      p.setValueAtTime(from, now);
      p.linearRampToValueAtTime(to, now + dur);
      return;
    }
  } catch {
    /* fall back */
  }
  p.value = to;
}

function defaultContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const C = w.AudioContext ?? w.webkitAudioContext;
  if (!C) return null;
  try {
    return new C({ latencyHint: 'interactive' });
  } catch {
    try {
      return new C();
    } catch {
      return null;
    }
  }
}

function makeLimiter(ctx: AudioContext): DynamicsCompressorNode | null {
  if (typeof (ctx as Partial<AudioContext>).createDynamicsCompressor !== 'function') return null;
  try {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = LOCAL_TUNING.limiterThreshold;
    c.knee.value = LOCAL_TUNING.limiterKnee;
    c.ratio.value = LOCAL_TUNING.limiterRatio;
    c.attack.value = LOCAL_TUNING.limiterAttack;
    c.release.value = LOCAL_TUNING.limiterRelease;
    return c;
  } catch {
    return null;
  }
}

/** Old iOS unlock: a one-sample silent buffer started inside the gesture. */
function playSilent(ctx: AudioContext): void {
  try {
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    /* optional */
  }
}

const NOOP_MODULE: AudioModule = {
  dispose() {
    /* placeholder for a module whose factory threw */
  },
};

const noop = (): void => undefined;

export function createAudioEngine(settings: SettingsStore, opts: AudioEngineOptions = {}): AudioEngineImpl {
  const makeContext = opts.createContext ?? defaultContext;
  let ac: AudioContext | null = null;
  let actx: AudioCtxWithServices | null = null;
  let services: AudioServices | null = null;
  let out: GainNode | null = null;
  let limiter: DynamicsCompressorNode | null = null;
  let modules: AudioModule[] = [];
  let ui: UiAudioModule | null = null;
  let unlocked = false;
  let paused = false;
  /** False after suspend() until resume(): the app wants silence (hidden page). */
  let wanted = true;
  let gestureArmed = false;
  let outUp = false;
  let stalled = false;
  let stallSec = 0;
  let lastAudioTime = -1;
  let unsubscribe: (() => void) | null = null;
  /** Per-module failure counts (index = position in `modules`). */
  let failures: number[] = [];
  /** Current volumes (settings, or a setVolumes preview). */
  const vol: AudioSettings = { master: 0, crowd: 0, effects: 0, menus: 0 };
  const levels: BusLevels = { master: 0, crowd: 0, effects: 0, menus: 0 };
  copyVolumes(settings.get().audio);

  function copyVolumes(v: Readonly<AudioSettings>): void {
    vol.master = v.master;
    vol.crowd = v.crowd;
    vol.effects = v.effects;
    vol.menus = v.menus;
  }

  function applyVolumes(): void {
    if (!actx || !ac) return;
    busTargets(vol, paused, levels);
    const t = ac.currentTime;
    const tc = LOCAL_TUNING.volumeTimeConstant;
    rampParam(actx.master.gain, levels.master, t, tc);
    rampParam(actx.crowd.gain, levels.crowd, t, tc);
    rampParam(actx.effects.gain, levels.effects, t, tc);
    rampParam(actx.menus.gain, levels.menus, t, tc);
  }

  /** The context runs: remember it, drop the gesture fallback, fade the output in (once per run). */
  function markRunning(ctx: AudioContext): void {
    if (ctx !== ac) return;
    if (!wanted) {
      // The OS resumed it while the page is hidden: keep the background silent.
      outputDown();
      try {
        void ctx.suspend().catch(noop);
      } catch {
        /* ignore */
      }
      return;
    }
    unlocked = true;
    stalled = false;
    stallSec = 0;
    lastAudioTime = -1;
    disarmGesture();
    if (!outUp) {
      outUp = true;
      if (out) fadeParam(out.gain, 0, 1, ctx.currentTime, LOCAL_TUNING.resumeFade);
    }
  }

  function outputDown(): void {
    if (!out || !ac) return;
    outUp = false;
    setParamNow(out.gain, 0, ac.currentTime);
  }

  function stopVoices(fade: number): void {
    if (!services) return;
    services.effects.stopAll(fade);
    services.crowd.stopAll(fade);
  }

  /**
   * Resume `ctx` if sound is wanted and it is not running. The gesture fallback is armed first and stays armed
   * until the context reports 'running' (statechange, the settled promise or update()), so a resume that resolves
   * without running, rejects, or never settles still comes back on the player's next tap or key press.
   */
  function requestResume(ctx: AudioContext): Promise<void> {
    if (ctx.state === 'running') {
      markRunning(ctx);
      return Promise.resolve();
    }
    if (ctx.state === 'closed') return Promise.resolve();
    armGesture();
    let p: Promise<void>;
    try {
      p = ctx.resume();
    } catch {
      return Promise.resolve();
    }
    return p.then(
      () => {
        if (ctx !== ac) return;
        if (ctx.state === 'running') markRunning(ctx);
        else if (wanted) armGesture();
      },
      () => {
        if (wanted && ac === ctx) armGesture();
      },
    );
  }

  /**
   * A user gesture while sound is wanted but not running: try to resume inside it. Listeners stay armed until the
   * context runs (one tap fires several of these events; only some carry activation on iOS).
   */
  const onGesture = (): void => {
    const ctx = ac;
    if (!ctx || !wanted || ctx.state === 'closed') {
      disarmGesture();
      return;
    }
    if (stalled && ctx.state === 'running') {
      // Zombie context (says running, clock stopped): restart it inside the gesture.
      stalled = false;
      stallSec = 0;
      lastAudioTime = -1;
      outputDown();
      try {
        void ctx.suspend().catch(noop);
        void ctx.resume().catch(noop);
      } catch {
        /* the next gesture tries again */
      }
      return;
    }
    if (ctx.state === 'running') {
      markRunning(ctx);
      return;
    }
    if (!unlocked) playSilent(ctx);
    void requestResume(ctx);
  };

  function armGesture(): void {
    if (gestureArmed || typeof window === 'undefined') return;
    gestureArmed = true;
    for (let i = 0; i < GESTURE_EVENTS.length; i++) window.addEventListener(GESTURE_EVENTS[i]!, onGesture, true);
  }

  function disarmGesture(): void {
    if (!gestureArmed || typeof window === 'undefined') return;
    gestureArmed = false;
    for (let i = 0; i < GESTURE_EVENTS.length; i++) window.removeEventListener(GESTURE_EVENTS[i]!, onGesture, true);
  }

  const onStateChange = (): void => {
    const ctx = ac;
    if (!ctx) return;
    if (ctx.state === 'running') {
      markRunning(ctx);
    } else {
      outputDown();
      // iOS reports 'interrupted' (non-standard) after calls/Siri; any non-running state while wanted needs a gesture.
      if (wanted && ctx.state !== 'closed') armGesture();
    }
  };

  /** A module threw: count it and report its first failure only (no flooding at 60 calls per second). */
  function moduleFailed(i: number, err: unknown, where: string): void {
    const n = failures[i] ?? 0;
    failures[i] = n + 1;
    if (n === 0 && opts.onModuleError) {
      try {
        opts.onModuleError(err, `audio module ${i} ${where}`);
      } catch {
        /* reporting must not throw into the loop */
      }
    }
  }

  function create<M extends AudioModule>(i: number, factory: (c: AudioCtx) => M, c: AudioCtx): M | null {
    try {
      return factory(c);
    } catch (err) {
      moduleFailed(i, err, 'create');
      return null;
    }
  }

  function build(ctx: AudioContext): void {
    // Bus order is relied on by tests: master, crowd, effects, menus are the first four gains.
    const master = ctx.createGain();
    const crowd = ctx.createGain();
    const effects = ctx.createGain();
    const menus = ctx.createGain();
    let o: GainNode | null;
    try {
      o = ctx.createGain();
      o.gain.value = 0;
    } catch {
      o = null;
    }
    out = o;
    outUp = false;
    limiter = makeLimiter(ctx);
    const tail: AudioNode = limiter ?? ctx.destination;
    if (limiter) limiter.connect(ctx.destination);
    if (o) {
      o.connect(tail);
      master.connect(o);
    } else {
      master.connect(tail);
    }
    crowd.connect(master);
    effects.connect(master);
    menus.connect(master);
    const registry: Record<AudioModuleName, AudioModule | null> = { crowd: null, sfx: null, whistles: null, eventMap: null, ui: null };
    services = {
      modules: registry,
      effects: createVoicePool(ctx, effects, LOCAL_TUNING.effectsVoices),
      crowd: createVoicePool(ctx, crowd, LOCAL_TUNING.crowdVoices),
      menus: createVoicePool(ctx, menus, LOCAL_TUNING.menusVoices),
      bank: createBufferBank(ctx, {
        now: opts.now,
        onError: (err, id) => moduleFailed(AUDIO_MODULE_NAMES.length, err, `bank ${id}`),
      }),
    };
    actx = { ctx, master, crowd, effects, menus, settings, services };
    // One failure slot per module plus one for the bank.
    failures = [0, 0, 0, 0, 0, 0];
    const c: AudioCtx = actx;
    // Created (and so pre-rendered) in the order sounds are first needed: menus right after the tap, the match later.
    ui = create(4, createUi, c);
    const sfx = create(1, createSfx, c);
    const whistles = create(2, createWhistles, c);
    const eventMap = create(3, createEventMap, c);
    const crowdMod = create(0, createCrowd, c);
    modules = [crowdMod ?? NOOP_MODULE, sfx ?? NOOP_MODULE, whistles ?? NOOP_MODULE, eventMap ?? NOOP_MODULE, ui ?? NOOP_MODULE];
    registry.crowd = crowdMod;
    registry.sfx = sfx;
    registry.whistles = whistles;
    registry.eventMap = eventMap;
    registry.ui = ui;
    copyVolumes(settings.get().audio);
    applyVolumes();
    unsubscribe = settings.subscribe((s) => {
      copyVolumes(s.audio);
      applyVolumes();
    });
    ctx.addEventListener?.('statechange', onStateChange);
  }

  /** Lifecycle hooks (not per frame): one closure per call is fine here. */
  function each(fn: (m: AudioModule) => void, where: string): void {
    for (let i = 0; i < modules.length; i++) {
      try {
        fn(modules[i]!);
      } catch (err) {
        moduleFailed(i, err, where);
      }
    }
  }

  /** Watch for a 'running' context whose clock stopped (iOS after an interruption): needs a gesture restart. */
  function watchClock(ctx: AudioContext, dt: number): void {
    const t = ctx.currentTime;
    if (lastAudioTime < 0 || t > lastAudioTime) {
      lastAudioTime = t;
      stallSec = 0;
      return;
    }
    stallSec += dt;
    if (!stalled && stallSec >= LOCAL_TUNING.stallSec) {
      stalled = true;
      armGesture();
    }
  }

  return {
    get unlocked() {
      return unlocked;
    },
    get context() {
      return ac;
    },
    get paused() {
      return paused;
    },
    get services() {
      return services;
    },
    unlock() {
      wanted = true;
      if (!ac) {
        const ctx = makeContext();
        if (!ctx) return Promise.resolve();
        ac = ctx;
        try {
          build(ctx);
        } catch (err) {
          moduleFailed(AUDIO_MODULE_NAMES.length, err, 'build');
        }
      }
      const ctx = ac;
      if (!unlocked) playSilent(ctx);
      return requestResume(ctx);
    },
    setVolumes(v) {
      copyVolumes(v);
      applyVolumes();
    },
    // Per tick / per frame: plain loops with a try per module (no closure allocation).
    onEvents(events: EventBuffer, state: ReadonlySimState) {
      // Only while sound can be heard: events held back by a frozen clock would all play at once on resume.
      if (!ac || paused || !wanted || ac.state !== 'running') return;
      for (let i = 0; i < modules.length; i++) {
        const m = modules[i]!;
        if (!m.onEvents) continue;
        try {
          m.onEvents(events, state);
        } catch (err) {
          moduleFailed(i, err, 'onEvents');
        }
      }
    },
    update(state, dtSec) {
      const ctx = ac;
      if (!ctx) return;
      const dt = Number.isFinite(dtSec) && dtSec > 0 ? (dtSec > LOCAL_TUNING.maxDt ? LOCAL_TUNING.maxDt : dtSec) : 0;
      if (services && services.bank.pending > 0) services.bank.pump(LOCAL_TUNING.bankBudgetMs);
      if (ctx.state !== 'running') {
        stallSec = 0;
        lastAudioTime = -1;
        return;
      }
      if (!wanted) return;
      if (!outUp) markRunning(ctx); // a missed statechange must never leave the output silent
      watchClock(ctx, dt);
      for (let i = 0; i < modules.length; i++) {
        const m = modules[i]!;
        if (!m.update) continue;
        try {
          m.update(state, dt);
        } catch (err) {
          moduleFailed(i, err, 'update');
        }
      }
    },
    playUi(kind) {
      if (ui && ac && wanted && ac.state === 'running') {
        try {
          ui.play(kind);
        } catch (err) {
          moduleFailed(4, err, 'play');
        }
      }
    },
    matchStart(state) {
      stopVoices(LOCAL_TUNING.stopFade);
      each((m) => m.matchStart?.(state), 'matchStart');
    },
    matchEnd() {
      stopVoices(LOCAL_TUNING.stopFade);
      each((m) => m.matchEnd?.(), 'matchEnd');
    },
    setPaused(p) {
      if (paused === p) return;
      paused = p;
      applyVolumes();
      if (p) stopVoices(LOCAL_TUNING.stopFade);
      each((m) => m.setPaused?.(p), 'setPaused');
    },
    suspend() {
      wanted = false;
      disarmGesture();
      stalled = false;
      stallSec = 0;
      if (ac && ac.state === 'running') {
        stopVoices(0.005);
        outputDown();
        void ac.suspend().catch(noop);
      } else {
        outputDown();
      }
    },
    resume() {
      wanted = true;
      if (!ac || ac.state === 'closed') return;
      if (ac.state === 'running') {
        markRunning(ac);
        return;
      }
      // Never ran (a gesture-less unlock, e.g. a pad confirm): only a real gesture can start it.
      if (!unlocked) {
        armGesture();
        return;
      }
      void requestResume(ac);
    },
    info() {
      return {
        state: ac ? ac.state : 'none',
        unlocked,
        paused,
        wanted,
        gestureArmed,
        stalled,
        outputUp: outUp,
        voices: {
          effects: services ? services.effects.active() : 0,
          crowd: services ? services.crowd.active() : 0,
          menus: services ? services.menus.active() : 0,
        },
        bankPending: services ? services.bank.pending : 0,
        bankFailed: services ? services.bank.failed : 0,
        moduleFailures: failures.slice(),
        levels: {
          master: actx ? actx.master.gain.value : 0,
          crowd: actx ? actx.crowd.gain.value : 0,
          effects: actx ? actx.effects.gain.value : 0,
          menus: actx ? actx.menus.gain.value : 0,
          output: out ? out.gain.value : 0,
        },
      };
    },
    dispose() {
      disarmGesture();
      unsubscribe?.();
      unsubscribe = null;
      each((m) => m.dispose(), 'dispose');
      modules = [];
      ui = null;
      if (services) {
        services.effects.dispose();
        services.crowd.dispose();
        services.menus.dispose();
        services.bank.dispose();
      }
      services = null;
      if (ac) {
        try {
          ac.removeEventListener?.('statechange', onStateChange);
        } catch {
          /* ignore */
        }
        void ac.close().catch(noop);
      }
      ac = null;
      actx = null;
      out = null;
      limiter = null;
      outUp = false;
      unlocked = false;
      stalled = false;
    },
  };
}
