/**
 * [QF-3] End-to-end touch rig for Node: the REAL touch source (src/input/touch/index.ts createTouchInput: pointer
 * manager, stick, attack and defence clusters with the swap controller, set-piece swipe, pitch gestures, PAUSE, mapper,
 * overlay) on a fake DOM (qf-3-fakedom.ts), feeding the real sim `step`. Pointer events are synthetic PointerEvents
 * dispatched on the overlay's touch layer at the rig clock, so multi-touch matrices, interruptions (blur, hidden page,
 * resize, rotation, touches leaving the screen) and set pieces run headless and deterministic.
 *
 * Screen: 1180 x 820 CSS px, no safe-area insets. Camera: top-down, 10 px per metre, centred on CAM (centreOn moves it
 * like a set-piece camera); a point's height moves it up the screen (a body is tappable above its feet).
 */
import { createInputFrame, type CameraProjector, type InputFrame, type InputSampleContext } from '../../src/contracts/input';
import { createDefaultSettings, type Settings, type TouchSettings } from '../../src/contracts/settings';
import type { SimState } from '../../src/contracts/state';
import type { ClusterSlot, TouchIntentState } from '../../src/contracts/touch';
import type { SimEvent } from '../../src/contracts/events';
import type { PlatformInfo, SettingsStore } from '../../src/contracts/app';
import { createTouchInput, type TouchInputSource } from '../../src/input/touch/index';
import { createEventBuffer } from '../../src/sim/core/events';
import { step } from '../../src/sim/step';
import { fakePage, type EvDoc, type EvEl, type FakeWindow } from './qf-3-fakedom';

export const W = 1180;
export const H = 820;
export const TICK_MS = 1000 / 60;
const K = 10;
/** Camera look point (pitch metres at the screen centre); centreOn() moves it (a set-piece camera). */
const CAM = { x: 0, z: 0 };
const CX = W / 2, CY = H / 2;

export const PROJ: CameraProjector = {
  screenToPitch(sx, sy, out) { out.x = (sx - CX) / K + CAM.x; out.z = (sy - CY) / K + CAM.z; return true; },
  pitchToScreen(x, y, z, out) { out.x = CX + (x - CAM.x) * K; out.y = CY + (z - CAM.z) * K - y * K; return true; },
  stickRotation: () => 0,
};

/** Point the camera at a pitch point (it then sits at the screen centre). */
export function centreOn(x: number, z: number): void {
  CAM.x = x;
  CAM.z = z;
}

/** Screen point of a pitch point on the ground. */
export const scr = (x: number, z: number): { x: number; y: number } => ({ x: CX + (x - CAM.x) * K, y: CY + (z - CAM.z) * K });

export interface TouchRig {
  readonly src: TouchInputSource;
  readonly st: TouchIntentState;
  readonly win: FakeWindow;
  readonly doc: EvDoc;
  /** The overlay's touch layer (the element the pointer manager listens on). */
  readonly el: EvEl;
  readonly settings: TouchSettings;
  /** Sim state the rig steps (replaceable). */
  s: SimState;
  /** Rig clock (ms). */
  t: number;
  /** Frames sent to the sim, one per tick (copies), and every sim event (copies). */
  readonly frames: InputFrame[];
  readonly events: SimEvent[];
  pauses: number;
  /** Centre of a cluster slot. */
  slot(slot: ClusterSlot): { x: number; y: number };
  pause(): { x: number; y: number };
  down(id: number, x: number, y: number, type?: string): void;
  move(id: number, x: number, y: number, type?: string): void;
  up(id: number, x: number, y: number, type?: string): void;
  cancel(id: number): void;
  /** Touch source releaseAll (pause, possession swap): the session calls it. */
  releaseAll(): void;
  /** Change touch settings and notify subscribers (the source relayouts). */
  updateSettings(mut: (t: TouchSettings) => void): void;
  /** Advance the clock to the next tick, poll a frame, sample, step the sim (unless stepSim is false). */
  tick(n?: number): InputFrame;
  /** Move a finger in `steps` moves over `ms`, ticking whenever a tick boundary passes. */
  drag(id: number, x0: number, y0: number, x1: number, y1: number, ms: number, steps?: number): void;
  /** Advance the clock, ticking whenever a tick boundary passes. */
  wait(ms: number): void;
}

export interface TouchRigOptions {
  human?: number;
  side?: number;
  settings?: Partial<TouchSettings>;
  /** Step the sim with the sampled frame (default true). */
  stepSim?: boolean;
}

export function createTouchRig(s: SimState, o: TouchRigOptions = {}): TouchRig {
  centreOn(0, 0);
  const { win, doc, root } = fakePage(W, H);
  const settingsObj: Settings = createDefaultSettings();
  Object.assign(settingsObj.controls.touch, o.settings ?? {});
  const subs: ((s: Readonly<Settings>) => void)[] = [];
  const store = {
    get: () => settingsObj,
    subscribe(fn: (s: Readonly<Settings>) => void) { subs.push(fn); return () => { subs.splice(subs.indexOf(fn), 1); }; },
    update(mut: (s: Settings) => void) { mut(settingsObj); for (const f of subs.slice()) f(settingsObj); },
  } as unknown as SettingsStore;
  const platform = { safeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }), isTouch: true } as unknown as PlatformInfo;
  const r = { t: 1000, pauses: 0, s } as TouchRig & { t: number; pauses: number; s: SimState };
  const src = createTouchInput({
    root: root as unknown as HTMLElement,
    getProjector: () => PROJ,
    getState: () => r.s,
    settings: store,
    platform,
    onPause: () => { r.pauses++; },
    now: () => r.t,
  });
  const el = src.overlay.el as unknown as EvEl;
  const ev = createEventBuffer();
  const frames: InputFrame[] = [];
  const events: SimEvent[] = [];
  const out = [createInputFrame(), createInputFrame()];
  const human = o.human ?? 0;
  const ctx: InputSampleContext & { tick: number; state: SimState } = { tick: 0, human, side: o.side ?? 0, state: s, projector: PROJ };
  let nextTickAt = r.t + TICK_MS;
  const ptr = (id: number, x: number, y: number, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    pointerId: id, pointerType: type, clientX: x, clientY: y, button: 0, buttons: 1, ...extra,
  });

  Object.assign(r, {
    src, st: src.state, win, doc, el, settings: settingsObj.controls.touch, frames, events,
    slot: (sl: ClusterSlot) => ({ x: src.layout.slots[sl]!.cx, y: src.layout.slots[sl]!.cy }),
    pause: () => ({ x: src.layout.pause.cx, y: src.layout.pause.cy }),
    down(id: number, x: number, y: number, type = 'touch') { el.dispatch('pointerdown', ptr(id, x, y, type)); },
    move(id: number, x: number, y: number, type = 'touch') { el.dispatch('pointermove', ptr(id, x, y, type)); },
    up(id: number, x: number, y: number, type = 'touch') { el.dispatch('pointerup', ptr(id, x, y, type, { buttons: 0 })); },
    cancel(id: number) { el.dispatch('pointercancel', ptr(id, 0, 0, 'touch', { buttons: 0 })); },
    releaseAll() { src.releaseAll(); },
    updateSettings(mut: (t: TouchSettings) => void) { store.update((x) => mut(x.controls.touch)); },
    wait(ms: number) {
      const end = r.t + ms;
      while (nextTickAt <= end) {
        r.t = nextTickAt;
        r.tick();
      }
      r.t = end;
    },
    tick(n = 1): InputFrame {
      let f = out[human]!;
      for (let i = 0; i < n; i++) {
        if (r.t < nextTickAt) r.t = nextTickAt;
        nextTickAt = r.t + TICK_MS;
        ctx.state = r.s;
        ctx.tick = r.s.tick + 1;
        src.pollFrame!(r.t);
        const fr = out[human]!;
        src.sample(fr, ctx);
        frames.push({ ...fr });
        if (o.stepSim !== false) {
          const other = out[1 - human]!;
          other.buttons = 0;
          step(r.s, out, ev);
          for (let k = 0; k < ev.count; k++) {
            const e = ev.get(k);
            events.push({ type: e.type, tick: e.tick, a: e.a, b: e.b, c: e.c, d: e.d, x: e.x, y: e.y, z: e.z });
          }
        }
        f = fr;
      }
      return f;
    },
    drag(id: number, x0: number, y0: number, x1: number, y1: number, ms: number, steps = 8) {
      for (let i = 1; i <= steps; i++) {
        r.wait(ms / steps);
        const k = i / steps;
        r.move(id, x0 + (x1 - x0) * k, y0 + (y1 - y0) * k);
      }
    },
  });
  return r;
}
