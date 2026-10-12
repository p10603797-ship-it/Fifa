/**
 * [AUD-01] Audio engine (Wave 0 version by FND-04): unlock, buses, volumes, pause ducking, interruption recovery.
 *
 * - unlock() must run inside a user gesture: it creates the AudioContext synchronously (no await before the
 *   constructor), plays a one-sample silent buffer (old iOS unlock) and resumes the context. Before unlock nothing
 *   is created, so no autoplay warning is ever logged.
 * - Buses: master -> destination; crowd, effects, menus -> master. Volumes follow settings.audio live.
 * - setPaused(true) mutes the crowd and effects buses (menu sounds stay) and tells the modules.
 * - suspend()/resume() for backgrounding. Whenever sound is wanted and the context is not running, the next
 *   pointer/key gesture resumes it: iOS refuses resume() outside a user gesture (the promise may resolve with the
 *   context still 'suspended', or never settle while 'interrupted' after a call or Siri), and no statechange
 *   follows. The gesture listeners are armed before resume() is even tried and removed once the context runs.
 * - A module that throws (onEvents, update, lifecycle hooks) is isolated: the other modules and the game go on.
 * - Without Web Audio (Node tests, very old browsers) every call is a no-op.
 */
import type { AudioEngine, SettingsStore } from '../contracts/app';
import type { EventBuffer } from '../contracts/events';
import type { AudioSettings } from '../contracts/settings';
import type { ReadonlySimState } from '../contracts/state';
import { createCrowd } from './crowd';
import { createEventMap } from './eventMap';
import { createSfx } from './sfx';
import type { AudioCtx, AudioModule, UiAudioModule } from './types';
import { createUi } from './ui';
import { createWhistles } from './whistles';

/** Bus volume ramp time constant, s. */
const RAMP = 0.03;

export interface AudioEngineImpl extends AudioEngine {
  /** The AudioContext once unlocked (diagnostics, tests). */
  readonly context: AudioContext | null;
  readonly paused: boolean;
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

export function createAudioEngine(settings: SettingsStore, opts: AudioEngineOptions = {}): AudioEngineImpl {
  const makeContext = opts.createContext ?? defaultContext;
  let ac: AudioContext | null = null;
  let actx: AudioCtx | null = null;
  let modules: AudioModule[] = [];
  let ui: UiAudioModule | null = null;
  let unlocked = false;
  let paused = false;
  /** False after suspend() until resume(): the app wants silence (hidden page). */
  let wanted = true;
  let gestureArmed = false;
  let unsubscribe: (() => void) | null = null;
  /** Per-module failure counts (index = position in `modules`); preallocated in build(). */
  let failures: number[] = [];

  function setBus(node: GainNode | undefined, value: number): void {
    if (!node || !ac) return;
    const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    try {
      node.gain.setTargetAtTime(v, ac.currentTime, RAMP);
    } catch {
      node.gain.value = v;
    }
  }

  function applyVolumes(v: AudioSettings): void {
    if (!actx) return;
    setBus(actx.master, v.master);
    setBus(actx.crowd, paused ? 0 : v.crowd);
    setBus(actx.effects, paused ? 0 : v.effects);
    setBus(actx.menus, v.menus);
  }

  const onGesture = (): void => {
    disarmGesture();
    if (ac && wanted) void requestResume(ac);
  };

  /**
   * Resume `ctx` if sound is wanted and it is not running. The gesture fallback is armed first and stays armed
   * until the context reports 'running' (statechange or the settled promise), so a resume that resolves without
   * running, rejects, or never settles still comes back on the player's next tap or key press.
   */
  function requestResume(ctx: AudioContext): Promise<void> {
    if (ctx.state === 'running') {
      unlocked = true;
      disarmGesture();
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
        if (ctx.state === 'running') {
          unlocked = true;
          disarmGesture();
        } else if (wanted && ac === ctx) {
          armGesture();
        }
      },
      () => {
        if (wanted && ac === ctx) armGesture();
      },
    );
  }

  function armGesture(): void {
    if (gestureArmed || typeof window === 'undefined') return;
    gestureArmed = true;
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
  }

  function disarmGesture(): void {
    if (!gestureArmed || typeof window === 'undefined') return;
    gestureArmed = false;
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
  }

  function build(ctx: AudioContext): void {
    const master = ctx.createGain();
    const crowd = ctx.createGain();
    const effects = ctx.createGain();
    const menus = ctx.createGain();
    master.connect(ctx.destination);
    crowd.connect(master);
    effects.connect(master);
    menus.connect(master);
    actx = { ctx, master, crowd, effects, menus, settings };
    ui = createUi(actx);
    modules = [createCrowd(actx), createSfx(actx), createWhistles(actx), createEventMap(actx), ui];
    failures = modules.map(() => 0);
    applyVolumes(settings.get().audio);
    unsubscribe = settings.subscribe((s) => applyVolumes(s.audio));
    ctx.addEventListener?.('statechange', () => {
      if (ctx.state === 'running') {
        unlocked = true;
        disarmGesture();
      } else if (wanted && ctx.state !== 'closed') {
        // iOS reports 'interrupted' (non-standard) after calls/Siri; any non-running state while wanted needs a gesture.
        armGesture();
      }
    });
  }

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
    unlock() {
      wanted = true;
      if (!ac) {
        ac = makeContext();
        if (!ac) return Promise.resolve();
        build(ac);
      }
      const ctx = ac;
      try {
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
      } catch {
        /* optional */
      }
      return requestResume(ctx);
    },
    setVolumes(v) {
      applyVolumes(v);
    },
    // Per tick / per frame: plain loops with a try per module (no closure allocation).
    onEvents(events: EventBuffer, state: ReadonlySimState) {
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
      for (let i = 0; i < modules.length; i++) {
        const m = modules[i]!;
        if (!m.update) continue;
        try {
          m.update(state, dtSec);
        } catch (err) {
          moduleFailed(i, err, 'update');
        }
      }
    },
    playUi(kind) {
      if (ui && ac && ac.state === 'running') {
        try {
          ui.play(kind);
        } catch {
          /* ignore */
        }
      }
    },
    matchStart(state) {
      each((m) => m.matchStart?.(state), 'matchStart');
    },
    matchEnd() {
      each((m) => m.matchEnd?.(), 'matchEnd');
    },
    setPaused(p) {
      if (paused === p) return;
      paused = p;
      applyVolumes(settings.get().audio);
      each((m) => m.setPaused?.(p), 'setPaused');
    },
    suspend() {
      wanted = false;
      disarmGesture();
      if (ac && ac.state === 'running') void ac.suspend().catch(() => undefined);
    },
    resume() {
      wanted = true;
      if (!ac || ac.state === 'closed') return;
      if (ac.state === 'running') {
        disarmGesture();
        return;
      }
      // Never ran (a gesture-less unlock, e.g. a pad confirm): only a real gesture can start it.
      if (!unlocked) {
        armGesture();
        return;
      }
      void requestResume(ac);
    },
    dispose() {
      disarmGesture();
      unsubscribe?.();
      each((m) => m.dispose(), 'dispose');
      modules = [];
      failures = [];
      ui = null;
      if (ac) void ac.close().catch(() => undefined);
      ac = null;
      actx = null;
      unlocked = false;
    },
  };
}
