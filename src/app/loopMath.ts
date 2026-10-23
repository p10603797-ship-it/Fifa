/**
 * Pure fixed-step timing for the app loop (ARCHITECTURE rule 5). [FND-04]
 *
 * Each animation frame adds the real time since the previous frame, clamped to MAX_FRAME_MS, to an accumulator
 * and runs whole ticks of TICK_MS (0..MAX_TICKS_PER_FRAME). Rendering interpolates by alpha = acc / TICK_MS.
 *  - Same game speed at 60 Hz, 120 Hz or any refresh rate: ticks follow real time, not frames.
 *  - Backlog beyond MAX_TICKS_PER_FRAME is dropped (the game slows down instead of spiralling or fast-forwarding).
 *  - After a reset (resume from pause, page shown again) the first frame contributes no time: nothing that
 *    happened while stopped is ever replayed.
 *  - Frame intervals within SNAP_TOLERANCE_MS of a multiple of half a tick are snapped to it, which removes the
 *    0/2-tick alternation that rAF timestamp jitter causes at exactly 60 Hz.
 * Allocation-free: all state lives in the LoopTiming object.
 */
import { MAX_FRAME_MS, MAX_TICKS_PER_FRAME, TICK_HZ } from '../contracts/constants';

export const TICK_MS = 1000 / TICK_HZ;
/** Snap frame intervals this close to k * TICK_MS / 2. */
export const SNAP_TOLERANCE_MS = 0.25;
const EPS = 1e-6;

export interface LoopTiming {
  /** Unconsumed real time, ms. */
  acc: number;
  /** Timestamp of the previous frame, ms. */
  lastMs: number;
  /** False until the first frame after creation or reset. */
  started: boolean;
  /** Real elapsed time of the latest frame after clamping and snapping, ms. */
  dtMs: number;
  /** Raw (unclamped) interval of the latest frame, ms (frame-time graphs). */
  rawDtMs: number;
}

export function createLoopTiming(): LoopTiming {
  return { acc: 0, lastMs: 0, started: false, dtMs: 0, rawDtMs: 0 };
}

/** Forget the accumulated time; the next frame adds nothing. Use on resume / visibility return. */
export function resetLoopTiming(t: LoopTiming): void {
  t.acc = 0;
  t.started = false;
  t.dtMs = 0;
  t.rawDtMs = 0;
}

/** Snap an interval to the nearest multiple of half a tick when within tolerance. Pure. */
export function snapFrameMs(dt: number): number {
  const half = TICK_MS / 2;
  const k = Math.round(dt / half);
  if (k >= 1 && k <= 2 * MAX_TICKS_PER_FRAME) {
    const snapped = k * half;
    if (Math.abs(dt - snapped) <= SNAP_TOLERANCE_MS) return snapped;
  }
  return dt;
}

/**
 * Start a frame at `nowMs`: adds the clamped, snapped real time to the accumulator and returns the number of
 * ticks due (0..MAX_TICKS_PER_FRAME). The caller runs up to that many ticks and then calls endFrame().
 */
export function beginFrame(t: LoopTiming, nowMs: number): number {
  let dt = t.started ? nowMs - t.lastMs : 0;
  t.lastMs = nowMs;
  t.started = true;
  if (!(dt > 0)) dt = 0; // negative, NaN (clock jumps)
  t.rawDtMs = dt;
  // [QF-7R] `+`: an imported binding is an untyped value to V8; assigned as is, it would make `dt` a tagged variable and
  // box every interval computed into it (two heap numbers per frame). As a number, `dt` stays an unboxed double.
  if (dt > MAX_FRAME_MS) dt = +MAX_FRAME_MS;
  dt = snapFrameMs(dt);
  t.dtMs = dt;
  t.acc += dt;
  let due = 0;
  while (due < MAX_TICKS_PER_FRAME && t.acc - due * TICK_MS >= TICK_MS - EPS) due++;
  return due;
}

/**
 * Finish a frame after `ran` ticks. When the sim was held (`stalled`, e.g. lockstep waiting for a remote input)
 * the remaining time is kept but capped at one frame's worth of ticks, so the sim catches up a little once
 * inputs arrive without ever building an unbounded backlog. Otherwise any backlog beyond whole ticks is dropped.
 */
export function endFrame(t: LoopTiming, ran: number, stalled: boolean): void {
  t.acc -= ran * TICK_MS;
  if (t.acc < 0) t.acc = 0;
  if (stalled) {
    const cap = MAX_TICKS_PER_FRAME * TICK_MS;
    if (t.acc > cap) t.acc = cap;
  } else if (t.acc >= TICK_MS - EPS) {
    t.acc -= Math.floor((t.acc + EPS) / TICK_MS) * TICK_MS;
    if (t.acc < 0) t.acc = 0;
  }
}

/** Interpolation factor between the previous and current sim state, 0..1. */
export function alphaOf(t: LoopTiming): number {
  const a = t.acc / TICK_MS;
  return a < 0 ? 0 : a > 1 ? 1 : a;
}
