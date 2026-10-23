/**
 * [GFX-16] Replay buffer and playback (section 8: "Goal replays: two angles from a ring buffer of the last 8 s of
 * render state. Skippable."; section 5: celebration + replay <= 12 s, skippable; section 13 warm-up: the first replay
 * must not hitch).
 *
 * RECORDING: every rendered frame during play (KICK_OFF, IN_PLAY, the restart phases, GOAL, SHOOT_OUT) stores each sim
 * tick it has not stored yet (frame.prev and frame.curr, the two states the frame interpolates) in a preallocated ring
 * of REPLAY_CAPACITY compact snapshots: per player position, velocity, facing and the animation mapper's inputs
 * (PLAYER_FIELDS: action and its timing, kick / skill kind, sprint / jockey / shield flags...), per ball position,
 * velocity, spin and possession facts (BALL_FIELDS). Snapshots are keyed by sim tick, so the ring holds REPLAY_SECONDS
 * of match time at 60 or 120 Hz and paused frames add nothing. A tick older than the newest one (new match, rematch)
 * clears the ring. Memory: REPLAY_CAPACITY x (22 x 33 + 20) floats (~1.5 MB), allocated once (ring.bytes).
 *
 * PLAYBACK: start(seconds) plans the replay inside `seconds` of wall-clock time (planReplay): the first angle
 * (ReplayAngle.SIDE, side close-up) shows the build-up and the finish, slowed to LOCAL_TUNING.slowRate over the final
 * second before the goal, and the second angle (ReplayAngle.BEHIND_GOAL, low behind the goal) shows the finish again.
 * Only the newest contiguous recording is used (a cut-scene between two stretches of play is a cut in the ring).
 * While playing, update(f) SUBSTITUTES THE FRAME: f.prev / f.curr become two preallocated shadow states holding the
 * recorded ticks around the playback time (static facts such as teams, attributes and the live REPLAY phase are copied
 * once from the live state, so on-pitch aids stay hidden), f.alpha their blend and f.interp the interpolated positions.
 * Every later module (cameras, players, ball, nets, effects) then draws the replay unchanged. The cinematic camera
 * (GFX-15) and the effects read replayPlaybackOf(ctx) for the angle, cuts and slow-motion rate.
 * The sim keeps running its REPLAY phase: the renderer starts playback itself on PHASE_CHANGE -> REPLAY (budget = the
 * REPLAY phase length, never past the 12 s goal-sequence cap) and stops on PHASE_CHANGE out of REPLAY (the sim's skip
 * or timeout). GameRenderer.startReplay(seconds) (re)starts playback at any time; stopReplay() skips at once. Playback
 * time follows FrameInfo.dtMs and stands still while paused. No allocation per frame.
 */

import { GOAL_HALF_WIDTH, NUM_SLOTS, TICK_HZ } from '../contracts/constants';
import type { PlayerData } from '../contracts/data';
import { MatchPhase } from '../contracts/enums';
import { EventType, type EventBuffer } from '../contracts/events';
import {
  createSimState, type BallState, type MatchConfig, type PlayerState, type ReadonlySimState, type SimState,
} from '../contracts/state';
import { T_RULES } from '../contracts/tuning';
import { createInterpState, type InterpState, type RenderContext, type RenderFrame, type RenderModule } from './types';

/** Seconds of render history kept for replays. */
export const REPLAY_SECONDS = 8;

export const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: GFX-16 replay presentation)
  /** Slow motion: playback rate (content s per real s) over the final slowWindow seconds before the goal. */
  slowRate: 0.6,
  /** Slow-motion window before the goal, s. */
  slowWindow: 1.0,
  /** Content kept after the goal (ball in the net), s. */
  tail: 0.6,
  /** Second angle: content shown before the goal, s. */
  secondLead: 1.2,
  /** The first angle needs at least this much content before the goal (s), or the replay keeps one angle. */
  firstMinLead: 1.5,
  /** Consecutive recorded ticks further apart than this (ticks) are a cut in the recording (cut-scene between). */
  gapTicks: 6,
  /** Longest replay budget accepted by start(), s (section 5: celebration + replay <= 12 s). */
  maxBudget: 12,
  /** Longest real frame time a playback step advances, s (tab switches, hitches). */
  maxStep: 0.1,
  /** setMatch warm-up: short goal sequences (frames of play, then frames of playback) run off screen while loading. */
  warmUpCycles: 8,
  warmUpFrames: 90,
  /** setMatch warm-up iterations of the event-time paths (live sync, planning, start / stop). */
  warmUpIterations: 600,
} as const;

const LT = LOCAL_TUNING;

/** Snapshots in the ring: REPLAY_SECONDS of sim ticks plus a margin. */
export const REPLAY_CAPACITY = Math.max(512, REPLAY_SECONDS * TICK_HZ + 32);

type PlayerKey = keyof PlayerState;
type BallKey = keyof BallState;

/**
 * Player fields stored per snapshot: kinematics first (P_X..P_FZ, interpolated on playback), then the facts the
 * animation mapper (GFX-12) and the player model read from frame.curr.
 */
export const PLAYER_FIELDS: readonly PlayerKey[] = [
  'x', 'z', 'vx', 'vz', 'fx', 'fz',
  'act', 'actT', 'actDur', 'actContact', 'actDone', 'actKick', 'actSkill', 'actPower', 'actCharging', 'actX', 'actZ',
  'actDirX', 'actDirZ', 'actSlot', 'actCurve', 'actA', 'actB', 'sprinting', 'jockeying', 'shielding', 'stunT', 'active',
  'ctrl', 'lookAt', 'lookX', 'lookZ', 'moveMode',
];
export const P_X = 0, P_Z = 1, P_VX = 2, P_VZ = 3, P_FX = 4, P_FZ = 5;

/** Ball fields stored per snapshot: position first (B_X..B_Z, interpolated on playback). */
export const BALL_FIELDS: readonly BallKey[] = [
  'x', 'y', 'z', 'vx', 'vy', 'vz', 'sx', 'sy', 'sz', 'grounded', 'bounces', 'owner', 'heldBy', 'lastTouch',
  'lastTouchTeam', 'lastKickBy', 'lastKickKind', 'passTarget', 'shotBy', 'inNet',
];
export const B_X = 0, B_Y = 1, B_Z = 2, B_VX = 3, B_VY = 4, B_VZ = 5, B_INNET = BALL_FIELDS.indexOf('inNet');

const PF = PLAYER_FIELDS.length;
const BF = BALL_FIELDS.length;
/** Floats per snapshot. */
export const SNAPSHOT_FLOATS = NUM_SLOTS * PF + BF;

/** Phases recorded for replays (play, restarts and the goal itself; not cut-scenes or breaks). */
export function recordsPhase(phase: number): boolean {
  return phase === MatchPhase.KICK_OFF || phase === MatchPhase.IN_PLAY || phase === MatchPhase.THROW_IN
    || phase === MatchPhase.GOAL_KICK || phase === MatchPhase.CORNER || phase === MatchPhase.FREE_KICK
    || phase === MatchPhase.PENALTY || phase === MatchPhase.GOAL || phase === MatchPhase.SHOOT_OUT;
}

// ============================================================ ring buffer

export interface ReplayRing {
  readonly capacity: number;
  /** Snapshots stored (<= capacity). */
  readonly count: number;
  /** Bytes held by the ring's typed arrays (fixed at creation). */
  readonly bytes: number;
  clear(): void;
  /**
   * Store state `s` unless its tick is already stored. A tick older than the newest stored one (new match, rewind)
   * clears the ring first. When full, the oldest snapshot is overwritten. Returns true when stored.
   */
  record(s: ReadonlySimState): boolean;
  /** Sim tick of snapshot k (0 = oldest .. count - 1 = newest). */
  tickAt(k: number): number;
  /** Largest k whose tick <= t; -1 when t is older than every snapshot (or the ring is empty). */
  floorIndex(t: number): number;
  /** Oldest k such that snapshots k..count-1 have no gap wider than gapTicks (0 when empty). */
  contiguousFrom(gapTicks: number): number;
  /** Write snapshot k into a state: every PLAYER_FIELDS / BALL_FIELDS value and the tick. */
  readInto(k: number, out: SimState): void;
  /** Interpolate snapshots k0 -> k1 by a (0..1) into out: positions, velocities, facing (re-normalised), ball. */
  interpInto(k0: number, k1: number, a: number, out: InterpState): void;
  /**
   * Allocation-free call forms for per-frame code (a double crossing a call boundary can box): write the argument into
   * arg[0] and call floorIndexArg() (time) or interpIntoArg(k0, k1, out) (blend). tickInto(k) writes tickAt(k) to arg[1].
   */
  readonly arg: Float64Array;
  floorIndexArg(): number;
  interpIntoArg(k0: number, k1: number, out: InterpState): void;
  tickInto(k: number): void;
  /** One recorded player value: field = index into PLAYER_FIELDS. */
  playerField(k: number, slot: number, field: number): number;
  /** One recorded ball value: field = index into BALL_FIELDS. */
  ballField(k: number, field: number): number;
}

export function createReplayRing(capacity: number = REPLAY_CAPACITY): ReplayRing {
  const cap = Math.max(2, capacity | 0);
  const data = new Float32Array(cap * SNAPSHOT_FLOATS);
  const ticks = new Float64Array(cap);
  const arg = new Float64Array(2);
  // Small integers only (Smis never allocate).
  let start = 0;
  let count = 0;

  const slot = (k: number): number => (start + k) % cap;

  /** Largest k whose tick <= arg[0]; -1 when older than every snapshot. */
  function floorIndexArg(): number {
    const t = arg[0]!;
    if (count === 0 || !(t >= ticks[start]!)) return -1;
    let lo = 0, hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ticks[(start + mid) % cap]! <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Interpolate k0 -> k1 by arg[0] into out. Explicit field code: no keyed access, no boxing. */
  function interpIntoArg(k0: number, k1: number, out: InterpState): void {
    const a = arg[0]!;
    const t = a < 0 ? 0 : a > 1 ? 1 : a;
    const o0 = slot(k0) * SNAPSHOT_FLOATS, o1 = slot(k1) * SNAPSHOT_FLOATS;
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p0 = o0 + i * PF, p1 = o1 + i * PF;
      out.x[i] = data[p0 + P_X]! + (data[p1 + P_X]! - data[p0 + P_X]!) * t;
      out.z[i] = data[p0 + P_Z]! + (data[p1 + P_Z]! - data[p0 + P_Z]!) * t;
      out.vx[i] = data[p0 + P_VX]! + (data[p1 + P_VX]! - data[p0 + P_VX]!) * t;
      out.vz[i] = data[p0 + P_VZ]! + (data[p1 + P_VZ]! - data[p0 + P_VZ]!) * t;
      let fx = data[p0 + P_FX]! + (data[p1 + P_FX]! - data[p0 + P_FX]!) * t;
      let fz = data[p0 + P_FZ]! + (data[p1 + P_FZ]! - data[p0 + P_FZ]!) * t;
      const l = Math.sqrt(fx * fx + fz * fz);
      if (l > 1e-4) { fx /= l; fz /= l; } else { fx = data[p1 + P_FX]!; fz = data[p1 + P_FZ]!; }
      out.fx[i] = fx;
      out.fz[i] = fz;
    }
    const b0 = o0 + NUM_SLOTS * PF, b1 = o1 + NUM_SLOTS * PF;
    out.ballX = data[b0 + B_X]! + (data[b1 + B_X]! - data[b0 + B_X]!) * t;
    out.ballY = data[b0 + B_Y]! + (data[b1 + B_Y]! - data[b0 + B_Y]!) * t;
    out.ballZ = data[b0 + B_Z]! + (data[b1 + B_Z]! - data[b0 + B_Z]!) * t;
  }

  return {
    capacity: cap,
    get count() { return count; },
    bytes: data.byteLength + ticks.byteLength,
    arg,
    clear() { start = 0; count = 0; },
    record(s: ReadonlySimState): boolean {
      const t = s.tick;
      if (!(t - t === 0)) return false;
      if (count > 0) {
        const last = ticks[(start + count - 1) % cap]!;
        if (t === last) return false;
        if (t < last) { start = 0; count = 0; }
      }
      let w: number;
      if (count < cap) { w = (start + count) % cap; count++; }
      else { w = start; start = (start + 1) % cap; }
      ticks[w] = t;
      let o = w * SNAPSHOT_FLOATS;
      // Explicit fields in PLAYER_FIELDS / BALL_FIELDS order (keyed access would box doubles).
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i]!;
        data[o + 0] = p.x; data[o + 1] = p.z; data[o + 2] = p.vx; data[o + 3] = p.vz; data[o + 4] = p.fx;
        data[o + 5] = p.fz; data[o + 6] = p.act; data[o + 7] = p.actT; data[o + 8] = p.actDur;
        data[o + 9] = p.actContact; data[o + 10] = p.actDone; data[o + 11] = p.actKick; data[o + 12] = p.actSkill;
        data[o + 13] = p.actPower; data[o + 14] = p.actCharging; data[o + 15] = p.actX; data[o + 16] = p.actZ;
        data[o + 17] = p.actDirX; data[o + 18] = p.actDirZ; data[o + 19] = p.actSlot; data[o + 20] = p.actCurve;
        data[o + 21] = p.actA; data[o + 22] = p.actB; data[o + 23] = p.sprinting; data[o + 24] = p.jockeying;
        data[o + 25] = p.shielding; data[o + 26] = p.stunT; data[o + 27] = p.active; data[o + 28] = p.ctrl;
        data[o + 29] = p.lookAt; data[o + 30] = p.lookX; data[o + 31] = p.lookZ; data[o + 32] = p.moveMode;
        o += PF;
      }
      const b = s.ball;
      data[o + 0] = b.x; data[o + 1] = b.y; data[o + 2] = b.z; data[o + 3] = b.vx; data[o + 4] = b.vy;
      data[o + 5] = b.vz; data[o + 6] = b.sx; data[o + 7] = b.sy; data[o + 8] = b.sz; data[o + 9] = b.grounded;
      data[o + 10] = b.bounces; data[o + 11] = b.owner; data[o + 12] = b.heldBy; data[o + 13] = b.lastTouch;
      data[o + 14] = b.lastTouchTeam; data[o + 15] = b.lastKickBy; data[o + 16] = b.lastKickKind;
      data[o + 17] = b.passTarget; data[o + 18] = b.shotBy; data[o + 19] = b.inNet;
      return true;
    },
    tickAt(k: number): number { return ticks[slot(k)]!; },
    tickInto(k: number): void { arg[1] = ticks[slot(k)]!; },
    floorIndex(t: number): number {
      arg[0] = t;
      return floorIndexArg();
    },
    floorIndexArg,
    contiguousFrom(gapTicks: number): number {
      let k = count - 1;
      while (k > 0 && ticks[slot(k)]! - ticks[slot(k - 1)]! <= gapTicks) k--;
      return k < 0 ? 0 : k;
    },
    readInto(k: number, out: SimState): void {
      const w = slot(k);
      out.tick = ticks[w]!;
      let o = w * SNAPSHOT_FLOATS;
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = out.players[i]!;
        p.x = data[o + 0]!; p.z = data[o + 1]!; p.vx = data[o + 2]!; p.vz = data[o + 3]!; p.fx = data[o + 4]!;
        p.fz = data[o + 5]!; p.act = data[o + 6]!; p.actT = data[o + 7]!; p.actDur = data[o + 8]!;
        p.actContact = data[o + 9]!; p.actDone = data[o + 10]!; p.actKick = data[o + 11]!;
        p.actSkill = data[o + 12]!; p.actPower = data[o + 13]!; p.actCharging = data[o + 14]!;
        p.actX = data[o + 15]!; p.actZ = data[o + 16]!; p.actDirX = data[o + 17]!; p.actDirZ = data[o + 18]!;
        p.actSlot = data[o + 19]!; p.actCurve = data[o + 20]!; p.actA = data[o + 21]!; p.actB = data[o + 22]!;
        p.sprinting = data[o + 23]!; p.jockeying = data[o + 24]!; p.shielding = data[o + 25]!;
        p.stunT = data[o + 26]!; p.active = data[o + 27]!; p.ctrl = data[o + 28]!; p.lookAt = data[o + 29]!;
        p.lookX = data[o + 30]!; p.lookZ = data[o + 31]!; p.moveMode = data[o + 32]!;
        o += PF;
      }
      const b = out.ball;
      b.x = data[o + 0]!; b.y = data[o + 1]!; b.z = data[o + 2]!; b.vx = data[o + 3]!; b.vy = data[o + 4]!;
      b.vz = data[o + 5]!; b.sx = data[o + 6]!; b.sy = data[o + 7]!; b.sz = data[o + 8]!;
      b.grounded = data[o + 9]!; b.bounces = data[o + 10]!; b.owner = data[o + 11]!; b.heldBy = data[o + 12]!;
      b.lastTouch = data[o + 13]!; b.lastTouchTeam = data[o + 14]!; b.lastKickBy = data[o + 15]!;
      b.lastKickKind = data[o + 16]!; b.passTarget = data[o + 17]!; b.shotBy = data[o + 18]!;
      b.inNet = data[o + 19]!;
    },
    interpInto(k0: number, k1: number, a: number, out: InterpState): void {
      arg[0] = a;
      interpIntoArg(k0, k1, out);
    },
    interpIntoArg,
    playerField(k: number, s: number, field: number): number {
      return data[slot(k) * SNAPSHOT_FLOATS + s * PF + field]!;
    },
    ballField(k: number, field: number): number {
      return data[slot(k) * SNAPSHOT_FLOATS + NUM_SLOTS * PF + field]!;
    },
  };
}

// ============================================================ replay plan

/** Replay camera angle of a segment (GFX-15 places the camera). */
export enum ReplayAngle {
  /** Side close-up tracking the ball from the near touchline side. */
  SIDE = 0,
  /** Low camera behind the goal the ball went in at. */
  BEHIND_GOAL = 1,
}

/** One angle of a replay: content from..to (sim ticks) shown in `wall` real seconds. */
export interface ReplaySegment {
  from: number;
  to: number;
  angle: ReplayAngle;
  wall: number;
}

export interface ReplayPlan {
  /** Segments in use (0..2). */
  count: number;
  readonly seg: readonly [ReplaySegment, ReplaySegment];
  /** Tick of the goal (the newest tick when the window holds no goal). */
  goal: number;
  /** Slow motion over content ticks [slowFrom, slowTo) at slowRate. */
  slowFrom: number;
  slowTo: number;
  slowRate: number;
  /** Total real seconds of the plan. */
  wall: number;
}

// Classes (own hidden classes): literals with common keys share maps whose fields may hold objects elsewhere, and a
// double stored into such a field is boxed.
class Segment implements ReplaySegment {
  from = 0.5;
  to = 0.5;
  angle: ReplayAngle = ReplayAngle.SIDE;
  wall = 0.5;
}

class Plan implements ReplayPlan {
  count = 0;
  readonly seg: readonly [ReplaySegment, ReplaySegment] = [new Segment(), new Segment()];
  goal = 0.5;
  slowFrom = 0.5;
  slowTo = 0.5;
  slowRate = 0.5;
  wall = 0.5;
}

export function createReplayPlan(): ReplayPlan {
  return new Plan();
}

/** Playback rate (content per real time) at content tick c. */
export function replayRateAt(plan: Readonly<ReplayPlan>, c: number): number {
  return c >= plan.slowFrom && c < plan.slowTo ? plan.slowRate : 1;
}

/** Real seconds needed to show content ticks from..to under the plan's slow motion. Pure. */
export function replayWall(plan: Readonly<ReplayPlan>, from: number, to: number): number {
  if (!(to > from)) return 0;
  const lo = from > plan.slowFrom ? from : plan.slowFrom;
  const hi = to < plan.slowTo ? to : plan.slowTo;
  const slow = hi > lo ? hi - lo : 0;
  const rate = plan.slowRate > 0 ? plan.slowRate : 1;
  return (to - from + slow * (1 / rate - 1)) / TICK_HZ;
}

/** Earliest content tick `from` (>= minFrom) whose content from..to fits in `wall` real seconds. Pure. */
export function replayStartFor(plan: Readonly<ReplayPlan>, to: number, wall: number, minFrom: number): number {
  const rate = plan.slowRate > 0 ? plan.slowRate : 1;
  let t = to;
  let w = wall * TICK_HZ; // real time in ticks
  if (t > plan.slowTo) {
    const d = Math.min(t - plan.slowTo, w);
    t -= d; w -= d;
  }
  if (w > 0 && t > plan.slowFrom) {
    const span = t - plan.slowFrom;
    const cost = span / rate;
    if (w >= cost) { t = plan.slowFrom; w -= cost; } else { t -= w * rate; w = 0; }
  }
  if (w > 0) t -= w;
  return t > minFrom ? t : minFrom;
}

/**
 * Plan a goal replay inside `budget` real seconds from recorded content ticks oldest..end with the goal at `goal`
 * (outside the window = no goal: the newest tick). Two angles when the budget allows the second angle plus at least
 * LOCAL_TUNING.firstMinLead s of build-up in the first; otherwise one (side) angle. Content ends LOCAL_TUNING.tail s
 * after the goal; the final slowWindow s before the goal play at slowRate. Pure; writes `out`.
 */
export function planReplay(budget: number, oldest: number, end: number, goal: number, out: ReplayPlan): ReplayPlan {
  out.count = 0;
  out.wall = 0;
  if (!(budget > 0) || !(end > oldest) || !(oldest - oldest === 0) || !(end - end === 0)) return out;
  const g = goal >= oldest && goal <= end ? goal : end;
  const segEnd = Math.min(end, g + LT.tail * TICK_HZ);
  out.goal = g;
  out.slowTo = g;
  out.slowFrom = Math.max(oldest, g - LT.slowWindow * TICK_HZ);
  out.slowRate = LT.slowRate;
  const a = out.seg[0], b = out.seg[1];
  const fromB = Math.max(oldest, g - LT.secondLead * TICK_HZ);
  const wallB = replayWall(out, fromB, segEnd);
  const fromAMin = g - LT.firstMinLead * TICK_HZ;
  const two = fromAMin >= oldest && budget >= replayWall(out, fromAMin, segEnd) + wallB;
  a.to = segEnd;
  a.angle = ReplayAngle.SIDE;
  a.from = replayStartFor(out, segEnd, two ? budget - wallB : budget, oldest);
  a.wall = replayWall(out, a.from, a.to);
  if (!(a.to > a.from)) return out;
  out.count = 1;
  out.wall = a.wall;
  if (two) {
    b.from = fromB;
    b.to = segEnd;
    b.angle = ReplayAngle.BEHIND_GOAL;
    b.wall = wallB;
    out.count = 2;
    out.wall += wallB;
  }
  return out;
}

// ============================================================ playback link (read by GFX-15 cameras and effects)

/** Playback facts shared with the cinematic camera (GFX-15) and the effects. One per RenderContext. */
export interface ReplayPlayback {
  playing: boolean;
  /** Angle of the current segment. */
  angle: ReplayAngle;
  /** Current segment index. */
  segment: number;
  /** Increments at every playback start, angle change and stop: cameras cut, effects reset on a change. */
  cuts: number;
  /** Goal end (+1 / -1) of the replayed goal (the end nearest the ball when the window holds no goal). */
  goalEnd: number;
  /** Ball z where the replayed goal crossed the line (m, inside the posts). */
  goalZ: number;
  /** Current playback rate (content seconds per real second; < 1 in slow motion). */
  rate: number;
  /** Real seconds played and planned. */
  elapsed: number;
  duration: number;
}

class Playback implements ReplayPlayback {
  playing = false;
  angle: ReplayAngle = ReplayAngle.SIDE;
  segment = 0;
  cuts = 0;
  goalEnd = 1;
  goalZ = 0.5;
  rate = 1.5;
  elapsed = 0.5;
  duration = 0.5;
  constructor() { this.goalZ = 0; this.rate = 1; this.elapsed = 0; this.duration = 0; }
}

const LINKS = new WeakMap<RenderContext, ReplayPlayback>();

/** The replay playback facts of a renderer context (created on first use; never allocates afterwards). */
export function replayPlaybackOf(ctx: RenderContext): ReplayPlayback {
  let l = LINKS.get(ctx);
  if (!l) {
    l = new Playback();
    LINKS.set(ctx, l);
  }
  return l;
}

// ============================================================ module

export interface ReplayModule extends RenderModule {
  /** True while playing back. */
  readonly playing: boolean;
  /**
   * (Re)start playing back the newest recorded play inside `seconds` of real time (planReplay: two angles and slow
   * motion when they fit, at most REPLAY_SECONDS of history). False when nothing usable is recorded.
   */
  start(seconds: number): boolean;
  /** Skip: end playback now (the live frame is drawn again from the next frame). */
  stop(): void;
  /** The ring (tests, diagnostics). */
  readonly ring: ReplayRing;
  /** The current plan (valid while playing). */
  readonly plan: Readonly<ReplayPlan>;
}

/** Copy plain data (numbers, nested objects, arrays) from src into the same-shaped dst; config / squads by reference. */
function copyPlain(dst: Record<string, unknown>, src: Readonly<Record<string, unknown>>): void {
  for (const k in src) {
    const v = src[k];
    if (v !== null && typeof v === 'object') {
      if (k === 'config' || k === 'squads') { dst[k] = v; continue; }
      const d = dst[k];
      if (d === null || typeof d !== 'object') continue;
      if (Array.isArray(v)) copyArray(d as unknown[], v as readonly unknown[]);
      else copyPlain(d as Record<string, unknown>, v as Readonly<Record<string, unknown>>);
    } else if (typeof v === 'number') dst[k] = v;
  }
}

function copyArray(d: unknown[], s: readonly unknown[]): void {
  const n = Math.min(d.length, s.length);
  for (let i = 0; i < n; i++) {
    const v = s[i];
    if (v !== null && typeof v === 'object') {
      const di = d[i];
      if (di === null || typeof di !== 'object') continue;
      if (Array.isArray(v)) copyArray(di as unknown[], v as readonly unknown[]);
      else copyPlain(di as Record<string, unknown>, v as Readonly<Record<string, unknown>>);
    } else if (typeof v === 'number') d[i] = v;
  }
}

/**
 * Copy the live facts a replayed frame keeps from the live state (explicit fields: no keyed access, no allocation):
 * match phase and goal (the live REPLAY phase hides the on-pitch aids), teams (direction, kit, keeper, score),
 * player identity, the attributes the model reads, controller slots. The recorded fields overwrite the rest per frame.
 */
function syncLive(d: SimState, s: ReadonlySimState): void {
  const dm = d.match, sm = s.match;
  dm.phase = sm.phase; dm.prevPhase = sm.prevPhase; dm.phaseT = sm.phaseT; dm.period = sm.period;
  dm.clockRunning = sm.clockRunning; dm.kickoffTeam = sm.kickoffTeam; dm.goalTeam = sm.goalTeam;
  dm.goalScorer = sm.goalScorer; dm.goalAssist = sm.goalAssist; dm.goalOwn = sm.goalOwn; dm.goalTick = sm.goalTick;
  const dr = dm.restart, sr = sm.restart;
  dr.kind = sr.kind; dr.team = sr.team; dr.x = sr.x; dr.z = sr.z; dr.taker = sr.taker; dr.ready = sr.ready; dr.taken = sr.taken;
  for (let t = 0; t < 2; t++) {
    const dt = d.teams[t]!, st = s.teams[t]!;
    dt.dir = st.dir; dt.clubIdx = st.clubIdx; dt.kit = st.kit; dt.goals = st.goals; dt.onPitch = st.onPitch;
    dt.keeperSlot = st.keeperSlot; dt.formation = st.formation;
  }
  for (let i = 0; i < NUM_SLOTS; i++) {
    const dp = d.players[i]!, sp = s.players[i]!;
    dp.team = sp.team; dp.slot = sp.slot; dp.rosterIdx = sp.rosterIdx; dp.formIdx = sp.formIdx; dp.role = sp.role;
    dp.isKeeper = sp.isKeeper; dp.yellow = sp.yellow;
    const da = d.attrs[i]!, sa = s.attrs[i]!;
    da.shirt = sa.shirt; da.height = sa.height; da.foot = sa.foot; da.skillMoves = sa.skillMoves;
    da.topSpeed = sa.topSpeed;
  }
  for (let c = 0; c < d.ctrl.length && c < s.ctrl.length; c++) {
    const dc = d.ctrl[c]!, sc = s.ctrl[c]!;
    dc.kind = sc.kind; dc.side = sc.side; dc.slot = sc.slot; dc.receiver = -1; dc.nextSwitch = -1; dc.powerBtn = 0; dc.power = 0;
  }
  d.config = s.config as unknown as MatchConfig;
  d.squads = s.squads as unknown as PlayerData[][];
}

// Playback numbers (doubles live in a Float64Array: no boxing per frame).
const N_C = 0, N_ELAPSED = 1;

export function createReplay(ctx: RenderContext): ReplayModule {
  const ring = createReplayRing();
  const plan = createReplayPlan();
  const link = replayPlaybackOf(ctx);
  const N = new Float64Array(2);
  /** Shadow states the substituted frame points at (k0 and k1 around the playback time). Built per match. */
  let shadowA: SimState | null = null;
  let shadowB: SimState | null = null;
  let playing = false;
  /** Started for the sim's REPLAY phase: ends when the phase does. */
  let bound = false;
  let synced = false;
  let segIdx = 0;
  let lastGoalTick = -1;
  let livePhase: number = MatchPhase.PRE_MATCH;

  /** Shadow states for a match (allocated here, never per frame) holding a full copy of the state. */
  function buildShadows(state: ReadonlySimState): void {
    const cfg = state.config as unknown as MatchConfig;
    const squads = state.squads as unknown as PlayerData[][];
    if (!shadowA || shadowA.config !== cfg || shadowA.squads !== squads) {
      shadowA = createSimState(cfg, squads);
      shadowB = createSimState(cfg, squads);
    }
    copyPlain(shadowA as unknown as Record<string, unknown>, state as unknown as Record<string, unknown>);
    copyPlain(shadowB as unknown as Record<string, unknown>, state as unknown as Record<string, unknown>);
  }

  function stop(): void {
    if (!playing) return;
    playing = false;
    bound = false;
    link.playing = false;
    link.rate = 1;
    link.cuts++;
  }

  function start(seconds: number): boolean {
    if (ring.count < 2) return false;
    const end = ring.tickAt(ring.count - 1);
    const oldest = ring.tickAt(ring.contiguousFrom(LT.gapTicks));
    const budget = Math.min(LT.maxBudget, seconds - seconds === 0 ? seconds : 0);
    planReplay(budget, oldest, end, lastGoalTick, plan);
    if (plan.count === 0) {
      stop();
      return false;
    }
    playing = true;
    bound = livePhase === MatchPhase.REPLAY;
    synced = false;
    segIdx = 0;
    N[N_C] = plan.seg[0].from;
    N[N_ELAPSED] = 0;
    // Goal end and crossing point from the recording.
    const kg = Math.max(0, ring.floorIndex(plan.goal));
    const kEnd = Math.max(0, ring.floorIndex(plan.seg[0].to));
    const inNet = ring.ballField(kEnd, B_INNET);
    const bx = ring.ballField(kg, B_X);
    link.goalEnd = inNet < 0 ? -1 : inNet > 0 ? 1 : bx < 0 ? -1 : 1;
    const gz = ring.ballField(kg, B_Z);
    link.goalZ = Math.max(-GOAL_HALF_WIDTH, Math.min(GOAL_HALF_WIDTH, gz - gz === 0 ? gz : 0));
    link.playing = true;
    link.segment = 0;
    link.angle = plan.seg[0].angle;
    link.rate = replayRateAt(plan, plan.seg[0].from);
    link.elapsed = 0;
    link.duration = plan.wall;
    link.cuts++;
    return true;
  }

  /** Start for the sim's REPLAY phase: budget = the phase length, never past the goal-sequence cap. */
  function startForPhase(state: ReadonlySimState): void {
    const cfgSec = state.config.replaySeconds;
    let budget = Math.min(cfgSec > 0 ? cfgSec : 0, T_RULES.replayTicks / TICK_HZ);
    const gt = state.match.goalTick;
    if (gt >= 0 && state.tick >= gt) budget = Math.min(budget, (T_RULES.goalSequenceMaxTicks - (state.tick - gt)) / TICK_HZ);
    if (gt >= 0) lastGoalTick = gt;
    livePhase = MatchPhase.REPLAY;
    if (budget > 0) start(budget);
  }

  function recordFrame(f: RenderFrame): void {
    const prev = f.prev, curr = f.curr;
    if (prev !== curr && recordsPhase(prev.match.phase) && prev.tick < curr.tick) {
      const n = ring.count;
      if (n === 0 || prev.tick > ring.tickAt(n - 1)) ring.record(prev);
    }
    if (recordsPhase(curr.match.phase)) ring.record(curr);
  }

  /** Advance the playback clock by one frame. */
  function advance(f: RenderFrame): void {
    const ms = f.frame.dtMs;
    const dt = f.frame.paused || !(ms > 0) ? 0 : Math.min(LT.maxStep, ms / 1000);
    let c = N[N_C]!;
    c += dt * TICK_HZ * (c >= plan.slowFrom && c < plan.slowTo ? plan.slowRate : 1);
    N[N_ELAPSED] = N[N_ELAPSED]! + dt;
    const seg = plan.seg[segIdx]!;
    if (c >= seg.to) {
      if (segIdx + 1 < plan.count) {
        segIdx++;
        const next = plan.seg[segIdx]!;
        c = next.from;
        link.segment = segIdx;
        link.angle = next.angle;
        link.cuts++;
      } else c = seg.to;
    }
    N[N_C] = c;
    link.rate = c >= plan.slowFrom && c < plan.slowTo ? plan.slowRate : 1;
    link.elapsed = N[N_ELAPSED]!;
  }

  /** Point the frame at the recorded state around the playback time. */
  function substitute(f: RenderFrame): void {
    const arg = ring.arg;
    const c = N[N_C]!;
    arg[0] = c;
    let k0 = ring.floorIndexArg();
    if (k0 < 0) k0 = 0;
    const k1 = k0 + 1 < ring.count ? k0 + 1 : k0;
    ring.tickInto(k0);
    const t0 = arg[1]!;
    ring.tickInto(k1);
    const t1 = arg[1]!;
    const a = t1 > t0 ? Math.max(0, Math.min(1, (c - t0) / (t1 - t0))) : 1;
    const sa = shadowA!, sb = shadowB!;
    ring.readInto(k0, sa);
    ring.readInto(k1, sb);
    arg[0] = a;
    ring.interpIntoArg(k0, k1, f.interp);
    f.prev = sa;
    f.curr = sb;
    f.alpha = a;
  }

  /**
   * Warm-up (setMatch, off screen, a few ms while loading): drive the real entry points (update in recording and in
   * playback, start, stop) on a private copy of the state for LOCAL_TUNING.warmUpCycles short goal sequences, so the
   * JIT has optimised the whole path before the first real replay (no hitch, no allocation); then clear everything.
   */
  function warmPaths(state: ReadonlySimState): void {
    const ws = createSimState(state.config as unknown as MatchConfig, state.squads as unknown as PlayerData[][]);
    copyPlain(ws as unknown as Record<string, unknown>, state as unknown as Record<string, unknown>);
    const frame: RenderFrame = {
      prev: ws, curr: ws, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp: createInterpState(),
    };
    const it = frame.interp;
    ws.tick = 0;
    for (let c = 0; c < LT.warmUpCycles; c++) {
      for (let i = 0; i < LT.warmUpFrames; i++) {
        ws.tick++;
        ws.match.phase = MatchPhase.IN_PLAY;
        const x = -30 + i * 0.25 + c * 0.5;
        ws.ball.x = x; ws.ball.y = 0.11 + (i % 30) * 0.03; ws.ball.z = 2.5;
        for (let p = 0; p < NUM_SLOTS; p++) {
          const pl = ws.players[p]!;
          pl.x = x - 10 + p * 0.75; pl.z = (p % 7) * 2.5 - 7.5; pl.vx = 3.5; pl.actT = i;
          it.x[p] = pl.x; it.z[p] = pl.z; it.vx[p] = 3.5; it.vz[p] = 0.5; it.fx[p] = 1; it.fz[p] = 0;
        }
        it.ballX = x; it.ballY = ws.ball.y; it.ballZ = 2.5;
        frame.prev = ws; frame.curr = ws; frame.alpha = 1;
        module.update(frame);
      }
      ws.match.goalTick = ws.tick - 10;
      ws.match.phase = MatchPhase.REPLAY;
      livePhase = MatchPhase.REPLAY;
      lastGoalTick = ws.match.goalTick;
      start(1 + (c % 3) * 0.5);
      for (let i = 0; i < LT.warmUpFrames; i++) {
        ws.tick++;
        frame.prev = ws; frame.curr = ws; frame.alpha = 1;
        module.update(frame);
      }
      stop();
    }
    // The event-time paths (live sync, planning, start / stop) run once per replay: exercise them directly as well.
    ring.clear();
    livePhase = MatchPhase.IN_PLAY;
    for (let i = 0; i < LT.warmUpIterations; i++) {
      syncLive(shadowA!, ws);
      syncLive(shadowB!, ws);
      ws.tick = i;
      ring.record(ws);
      if (i >= 8 && (i & 3) === 0) {
        lastGoalTick = i - 3;
        if (start(1 + (i % 5) * 0.5)) {
          for (let k = 0; k < 4; k++) { advance(frame); substitute(frame); }
          stop();
        }
      }
    }
    ring.clear();
    plan.count = 0;
    segIdx = 0;
    synced = false;
  }

  const module: ReplayModule = {
    get playing() { return playing; },
    get ring() { return ring; },
    get plan() { return plan; },
    start,
    stop,
    setMatch(state: ReadonlySimState) {
      stop();
      ring.clear();
      buildShadows(state);
      warmPaths(state);
      buildShadows(state);
      lastGoalTick = -1;
      livePhase = state.match.phase;
    },
    update(f: RenderFrame) {
      const live = f.curr;
      livePhase = live.match.phase;
      const gt = live.match.goalTick;
      if (gt >= 0) lastGoalTick = gt;
      if (!playing) {
        recordFrame(f);
        return;
      }
      // Safety net: a phase-bound replay never outlives the sim's REPLAY phase (event missed).
      if (bound && livePhase !== MatchPhase.REPLAY) {
        stop();
        return;
      }
      if (!shadowA) buildShadows(live);
      if (!synced) {
        syncLive(shadowA!, live);
        syncLive(shadowB!, live);
        synced = true;
      }
      advance(f);
      substitute(f);
      // A replay started outside the REPLAY phase ends with its plan.
      if (!bound && segIdx === plan.count - 1 && N[N_C]! >= plan.seg[segIdx]!.to) stop();
    },
    onEvents(events: EventBuffer, state: ReadonlySimState) {
      livePhase = state.match.phase;
      for (let i = 0; i < events.count; i++) {
        const ev = events.get(i);
        if (ev.type === EventType.GOAL) {
          const gt = state.match.goalTick;
          lastGoalTick = gt >= 0 ? gt : state.tick;
        } else if (ev.type === EventType.PHASE_CHANGE) {
          if (ev.b === MatchPhase.REPLAY) startForPhase(state);
          else if (ev.a === MatchPhase.REPLAY && playing && bound) stop();
        }
      }
      // Events of one tick can enter and leave REPLAY (replays off): end in the state's phase.
      if (playing && bound && state.match.phase !== MatchPhase.REPLAY) stop();
    },
    clearMatch() {
      stop();
      ring.clear();
      lastGoalTick = -1;
      plan.count = 0;
    },
    dispose() {
      stop();
      ring.clear();
      LINKS.delete(ctx);
    },
  };
  return module;
}
