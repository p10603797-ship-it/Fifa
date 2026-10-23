/**
 * App-internal interfaces shared by boot, loop, router and session. [FND-04]
 * Not a frozen contract: other areas use src/contracts/app.ts. Wave 1 code that needs these imports them from here.
 */
import type {
  FrameInfo, Router, Screen, ScreenId, ScreenParams, SessionControl, StatsTracker, TickInputProvider,
} from '../contracts/app';
import type { EventBuffer } from '../contracts/events';
import type { InputFrame } from '../contracts/input';
import type { SimState } from '../contracts/state';

/** Router with the extras the app shell needs. Screens see it as the contract Router. */
export interface AppRouter extends Router {
  /** Clear the history and show `id` as the only entry. */
  resetTo(id: ScreenId, params?: ScreenParams): void;
  /** The mounted screen instance (the loop calls its onFrame). */
  currentScreen(): Screen | null;
  /** History, bottom first (debug / tests). */
  readonly stack: readonly ScreenId[];
  has(id: ScreenId): boolean;
  /**
   * A back request from an input device. A menu BACK within BACK_DEDUPE_MS of a keyboard back is the same physical
   * key press seen twice (keydown + menu input latch) and is ignored; pad B and browser back always count.
   */
  backFromInput(source: 'key' | 'menu' | 'history'): void;
  dispose(): void;
}

/** Everything the loop needs to run ticks for the current match. Created by the session at match start. */
export interface MatchRuntime {
  /** State before the latest tick (interpolation source). */
  prev: SimState;
  /** State after the latest tick. */
  curr: SimState;
  /** Supplies human frames (local devices, lockstep). Owned by the session. */
  readonly provider: TickInputProvider;
  /** Preallocated per-tick human frames, length MAX_HUMANS. */
  readonly frames: InputFrame[];
  readonly events: EventBuffer;
  readonly stats: StatsTracker;
}

/** The session as seen by the loop. */
export interface LoopSession {
  /** Current match runtime once loaded, else null (menus, loading). */
  runtime(): MatchRuntime | null;
  /** True when the sim may advance: loaded, not paused, not finished, page visible. */
  readonly ticking: boolean;
  /** After every tick: phase watching (half-time / full-time screens, POST_MATCH summary). */
  afterTick(rt: MatchRuntime): void;
}

/** Full session API used by the app shell (contract SessionControl + shell hooks). */
export interface AppSession extends SessionControl, LoopSession {
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly finished: boolean;
  /** Final summary once the match reached POST_MATCH. */
  readonly lastSummary: import('../contracts/app').MatchSummary | null;
  /** Page visibility (visibilitychange / pagehide / pageshow). Hidden pauses (-1), suspends audio. */
  setHidden(hidden: boolean): void;
  /** Portrait or too-small window: pauses (-1) while blocked; never auto-resumes. */
  setBlocked(blocked: boolean): void;
  /** Window blur: release every held input. */
  releaseInputs(): void;
  /**
   * Pause button / Options / Escape from a device: pauses when running, resumes when paused by the same human
   * (or the system). Presses within PAUSE_DEBOUNCE_MS of the last pause change are ignored, so one physical press
   * reaching the app through two paths never toggles twice.
   */
  requestPause(human: number): void;
  /** Human bound to a device id in the current setup, or -1. */
  humanForDevice(deviceId: string | null): number;
  /** Best guess of the human acting in the UI: the last active device's human, the only human, or -1. */
  uiHuman(): number;
  dispose(): void;
}

/** Frame statistics exposed on window.__dotkickFrameStats (debug overlay, benchmark). */
export interface FrameStats {
  frame: number;
  /** Smoothed frames per second. */
  fps: number;
  /** Raw interval of the latest frame, ms. */
  frameMs: number;
  /** Sim + render (renderer and HUD) ms of the latest frame. [QF-7R] */
  busyMs: number;
  /** Ticks run in the latest frame and in total. */
  ticks: number;
  totalTicks: number;
  /** Sim ms per tick (step only): latest, exponential average, and average / max since reset(). */
  simMsLast: number;
  simMsEma: number;
  simMsAvg: number;
  simMsMax: number;
  /** Render ms per rendered frame (renderer + HUD): latest, exponential average, and average / max since reset(). */
  renderMsLast: number;
  renderMsEma: number;
  renderMsAvg: number;
  renderMsMax: number;
  /** Ticks and rendered frames counted since reset(). */
  sampleTicks: number;
  sampleFrames: number;
  /** True when the input provider held the sim this frame (lockstep waiting). */
  stalled: boolean;
  /** Ring buffer of the latest raw frame intervals (ms) for the frame-time graph; `head` = next write index. */
  readonly frameTimes: Float32Array;
  head: number;
  /** Start a new measurement window for the averages and maxima. */
  reset(): void;
}

export type { FrameInfo };
