/**
 * [AUD-01] Audio engine (Wave 0 version by FND-04): unlock, buses, volumes, pause ducking, interruption recovery.
 *
 * - unlock() must run inside a user gesture: it creates the AudioContext synchronously (no await before the
 *   constructor), plays a one-sample silent buffer (old iOS unlock) and resumes the context. Before unlock nothing
 *   is created, so no autoplay warning is ever logged.
 * - Buses: master -> destination; crowd, effects, menus -> master. Volumes follow settings.audio live.
 * - setPaused(true) mutes the crowd and effects buses (menu sounds stay) and tells the modules.
 * - suspend()/resume() for backgrounding. If iOS interrupts the context (phone call, Siri) or a resume is refused,
 *   the next pointer/key gesture resumes it.
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
    if (ac && wanted && ac.state !== 'running' && ac.state !== 'closed') void ac.resume().catch(() => armGesture());
  };

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
    applyVolumes(settings.get().audio);
    unsubscribe = settings.subscribe((s) => applyVolumes(s.audio));
    ctx.addEventListener?.('statechange', () => {
      if (ctx.state === 'running') unlocked = true;
      // iOS reports 'interrupted' (non-standard) after calls/Siri; any non-running state while wanted needs a gesture.
      if (wanted && ctx.state !== 'running' && ctx.state !== 'closed') armGesture();
    });
  }

  function each(fn: (m: AudioModule) => void): void {
    for (let i = 0; i < modules.length; i++) {
      try {
        fn(modules[i]!);
      } catch {
        /* a broken module must not break the game */
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
      if (ctx.state === 'running') {
        unlocked = true;
        return Promise.resolve();
      }
      return ctx.resume().then(
        () => {
          unlocked = unlocked || ctx.state === 'running';
        },
        () => {
          armGesture();
        },
      );
    },
    setVolumes(v) {
      applyVolumes(v);
    },
    onEvents(events: EventBuffer, state: ReadonlySimState) {
      for (let i = 0; i < modules.length; i++) {
        const m = modules[i]!;
        if (m.onEvents) m.onEvents(events, state);
      }
    },
    update(state, dtSec) {
      for (let i = 0; i < modules.length; i++) {
        const m = modules[i]!;
        if (m.update) m.update(state, dtSec);
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
      each((m) => m.matchStart?.(state));
    },
    matchEnd() {
      each((m) => m.matchEnd?.());
    },
    setPaused(p) {
      if (paused === p) return;
      paused = p;
      applyVolumes(settings.get().audio);
      each((m) => m.setPaused?.(p));
    },
    suspend() {
      wanted = false;
      disarmGesture();
      if (ac && ac.state === 'running') void ac.suspend().catch(() => undefined);
    },
    resume() {
      wanted = true;
      if (!ac || !unlocked || ac.state === 'closed') return;
      if (ac.state !== 'running') void ac.resume().catch(() => armGesture());
    },
    dispose() {
      disarmGesture();
      unsubscribe?.();
      each((m) => m.dispose());
      modules = [];
      ui = null;
      if (ac) void ac.close().catch(() => undefined);
      ac = null;
      actx = null;
      unlocked = false;
    },
  };
}
