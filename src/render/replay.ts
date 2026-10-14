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

export const LOCAL_TUNING = { // TUNING-CR (GFX-16 replay)
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
  /** One recorded player value: field = index into PLAYER_FIELDS. */
  playerField(k: number, slot: number, field: number): number;
  /** One recorded ball value: field = index into BALL_FIELDS. */
  ballField(k: number, field: number): number;
}

export function createReplayRing(capacity: number = REPLAY_CAPACITY): ReplayRing {
  const cap = Math.max(2, capacity | 0);
  const data = new Float32Array(cap * SNAPSHOT_FLOATS);
  const ticks = new Float64Array(cap);
  // Small integers only (Smis never allocate).
  let start = 0;
  let count = 0;

  const slot = (k: number): number => (start + k) % cap;

  function floorIndex(t: number): number {
    if (count === 0 || !(t >= ticks[start]!)) return -1;
    let lo = 0, hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ticks[(start + mid) % cap]! <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  return {
    capacity: cap,
    get count() { return count; },
    bytes: data.byteLength + ticks.byteLength,
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
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i] as unknown as Readonly<Record<string, number>>;
        for (let f = 0; f < PF; f++) data[o + f] = p[PLAYER_FIELDS[f]!]!;
        o += PF;
      }
      const b = s.ball as unknown as Readonly<Record<string, number>>;
      for (let f = 0; f < BF; f++) data[o + f] = b[BALL_FIELDS[f]!]!;
      return true;
    },
    tickAt(k: number): number { return ticks[slot(k)]!; },
    floorIndex,
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
        const p = out.players[i] as unknown as Record<string, number>;
        for (let f = 0; f < PF; f++) p[PLAYER_FIELDS[f]!] = data[o + f]!;
        o += PF;
      }
      const b = out.ball as unknown as Record<string, number>;
      for (let f = 0; f < BF; f++) b[BALL_FIELDS[f]!] = data[o + f]!;
    },
    interpInto(k0: number, k1: number, a: number, out: InterpState): void {
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
    },
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

export function createReplayPlan(): ReplayPlan {
  const seg = (): ReplaySegment => ({ from: 0, to: 0, angle: ReplayAngle.SIDE, wall: 0 });
  return { count: 0, seg: [seg(), seg()], goal: 0, slowFrom: 0, slowTo: 0, slowRate: 1, wall: 0 };
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

const LINKS = new WeakMap<RenderContext, ReplayPlayback>();

/** The replay playback facts of a renderer context (created on first use; never allocates afterwards). */
export function replayPlaybackOf(ctx: RenderContext): ReplayPlayback {
  let l = LINKS.get(ctx);
  if (!l) {
    l = { playing: false, angle: ReplayAngle.SIDE, segment: 0, cuts: 0, goalEnd: 1, goalZ: 0, rate: 1, elapsed: 0, duration: 0 };
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

  function buildShadows(state: ReadonlySimState): void {
    const cfg = state.config as unknown as MatchConfig;
    const squads = state.squads as unknown as PlayerData[][];
    if (!shadowA || shadowA.config !== cfg || shadowA.squads !== squads) {
      shadowA = createSimState(cfg, squads);
      shadowB = createSimState(cfg, squads);
    }
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
    const rate = replayRateAt(plan, c);
    c += dt * TICK_HZ * rate;
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
    link.rate = replayRateAt(plan, c);
    link.elapsed = N[N_ELAPSED]!;
  }

  /** Point the frame at the recorded state around the playback time. */
  function substitute(f: RenderFrame): void {
    const c = N[N_C]!;
    let k0 = ring.floorIndex(c);
    if (k0 < 0) k0 = 0;
    const k1 = k0 + 1 < ring.count ? k0 + 1 : k0;
    const t0 = ring.tickAt(k0), t1 = ring.tickAt(k1);
    const a = t1 > t0 ? Math.max(0, Math.min(1, (c - t0) / (t1 - t0))) : 1;
    const sa = shadowA!, sb = shadowB!;
    ring.readInto(k0, sa);
    ring.readInto(k1, sb);
    ring.interpInto(k0, k1, a, f.interp);
    f.prev = sa;
    f.curr = sb;
    f.alpha = a;
  }

  /** Exercise recording and playback once (setMatch) so the first real replay never hitches. */
  function warmPaths(state: ReadonlySimState): void {
    const sa = shadowA!;
    copyPlain(sa as unknown as Record<string, unknown>, state as unknown as Record<string, unknown>);
    copyPlain(shadowB as unknown as Record<string, unknown>, state as unknown as Record<string, unknown>);
    const frame: RenderFrame = {
      prev: sa, curr: sa, alpha: 1, frame: { nowMs: 0, dtMs: 16, frame: 0, ticks: 1, paused: false }, interp: createInterpState(),
    };
    for (let i = 0; i < 3; i++) { sa.tick = i; ring.record(sa); }
    planReplay(1, 0, 2, 1, plan);
    N[N_C] = 0.5;
    substitute(frame);
    ring.clear();
    plan.count = 0;
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
      lastGoalTick = -1;
      livePhase = state.match.phase;
      buildShadows(state);
      warmPaths(state);
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
        copyPlain(shadowA as unknown as Record<string, unknown>, live as unknown as Record<string, unknown>);
        copyPlain(shadowB as unknown as Record<string, unknown>, live as unknown as Record<string, unknown>);
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
