/**
 * [GKP-02] Test helpers for the keeper save tests: shot set-up with exact aim (iterated against the real ball physics),
 * a keeper-focused mini pipeline (save decision -> actions -> locomotion -> ball -> keeper contacts) and outcome
 * classification with per-tick instrumentation. Used by tests/unit/gkp-02-*.test.ts and tests/scenario/gkp-02-*.
 */
import { BALL_RADIUS, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { createBallState, type BallState, type SimState } from '../../src/contracts/state';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { ballStepTick, ballTick } from '../../src/sim/ball/contact';
import { createEventBuffer, type EventBufferImpl } from '../../src/sim/core/events';
import { keeperContacts, keeperSaveDecision } from '../../src/sim/keeper/saves';
import { LOCAL_TUNING, standAxisTop, STAND_AXIS_LOW } from '../../src/sim/keeper/saveKinematics';
import { keeperMaxReach } from '../../src/sim/keeper/saves';
import { locomotionTick } from '../../src/sim/players/locomotion';
import { makeScenario } from '../harness/scenario';

/** Team 0 defends the goal at x = -52.5 (dir +1); its keeper is slot 0. Depth u = x + 52.5. */
export const KEEPER = 0;
export const SHOOTER = 20;
export const xAt = (u: number): number => u - HALF_LENGTH;
export const depth = (x: number): number => x + HALF_LENGTH;

export interface KeeperOpts {
  /** All five gk attributes (default 75). */
  gk?: number;
  diving?: number;
  handling?: number;
  reflexes?: number;
  /** Keeper height cm (default from data). */
  height?: number;
  /** Keeper depth from his line and z. */
  u?: number;
  z?: number;
  seed?: number;
}

/** IN_PLAY state with every other player parked far up the pitch and keeper 0 placed as asked. */
export function keeperScenario(o: KeeperOpts = {}): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: o.seed ?? 7 });
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (i === KEEPER || i === 11) continue;
    const p = s.players[i]!;
    p.x = 15 + (i % 6) * 5;
    p.z = -25 + i * 2.3;
    p.vx = 0; p.vz = 0;
  }
  s.players[11]!.x = 50; s.players[11]!.z = 0;
  const a = s.attrs[KEEPER]!;
  const g = o.gk ?? 75;
  a.gkDiving = o.diving ?? g;
  a.gkHandling = o.handling ?? g;
  a.gkReflexes = o.reflexes ?? g;
  a.gkPositioning = g;
  if (o.height !== undefined) a.height = o.height;
  const k = s.players[KEEPER]!;
  k.x = xAt(o.u ?? 2);
  k.z = o.z ?? 0;
  k.vx = 0; k.vz = 0; k.fx = 1; k.fz = 0;
  return s;
}

const AIM = createBallState();

/** Simulate a copy of b until its centre crosses the goal-line plane x = -52.5; writes the crossing z/y/ticks. */
export function lineCrossing(b: Readonly<BallState>, out: { z: number; y: number; t: number }, maxTicks = 240): boolean {
  Object.assign(AIM, b);
  AIM.owner = -1; AIM.heldBy = -1;
  for (let t = 1; t <= maxTicks; t++) {
    const x0 = AIM.x, y0 = AIM.y, z0 = AIM.z;
    ballStepTick(AIM, null);
    if (AIM.x <= -HALF_LENGTH) {
      const f = (x0 + HALF_LENGTH) / (x0 - AIM.x);
      out.z = z0 + (AIM.z - z0) * f;
      out.y = y0 + (AIM.y - y0) * f;
      out.t = t;
      return true;
    }
  }
  return false;
}

export interface ShotSpec {
  /** Ball start depth u (m from the goal line), z and height (default ground). */
  u: number;
  z: number;
  y?: number;
  /** Aim: z and ball-centre height where the ball crosses the goal line. ty <= 0.12 with start y <= 0.12 = ground shot. */
  tz: number;
  ty?: number;
  speed: number;
  shooter?: number;
  kind?: KickKind;
}

/**
 * Put a struck shot in flight at team 0's goal from SHOOTER (team 1): ball position and velocity iterated against
 * the real ball physics so it crosses the goal line at (tz, ty). Returns the ticks until it reaches the line.
 */
export function shoot(s: SimState, sh: ShotSpec): number {
  const b = s.ball;
  const y0 = sh.y ?? BALL_RADIUS;
  const ty = sh.ty ?? BALL_RADIUS;
  const ground = y0 <= 0.12 && ty <= 0.12;
  const bx = xAt(sh.u);
  b.x = bx; b.y = ground ? BALL_RADIUS : y0; b.z = sh.z;
  b.px = b.x; b.py = b.y; b.pz = b.z;
  b.sx = 0; b.sy = 0; b.sz = 0;
  b.owner = -1; b.heldBy = -1; b.inNet = 0; b.bounces = 0;
  b.grounded = ground ? 1 : 0;
  let aimZ = sh.tz;
  let vy = 0;
  const out = { z: 0, y: 0, t: 0 };
  for (let it = 0; it < 12; it++) {
    const dx = -HALF_LENGTH - bx, dz = aimZ - sh.z;
    const dl = Math.sqrt(dx * dx + dz * dz);
    if (!ground && it === 0) {
      const tt = dl / sh.speed;
      vy = (ty - y0 + 0.5 * 9.81 * tt * tt) / tt;
    }
    const vh = Math.sqrt(Math.max(1, sh.speed * sh.speed - vy * vy));
    b.vx = (dx / dl) * vh; b.vz = (dz / dl) * vh; b.vy = ground ? 0 : vy;
    if (!lineCrossing(b, out)) break;
    const ez = sh.tz - out.z, ey = ty - out.y;
    if (Math.abs(ez) < 0.005 && (ground || Math.abs(ey) < 0.005)) break;
    aimZ += ez;
    if (!ground) vy += ey / (out.t / 60);
  }
  const sl = sh.shooter ?? SHOOTER;
  const p = s.players[sl]!;
  p.x = bx + 1.2; p.z = sh.z; p.vx = 0; p.vz = 0;
  const kind = sh.kind ?? KickKind.SHOT_NORMAL;
  b.lastTouch = sl; b.lastTouchTeam = p.team; b.lastTouchTick = s.tick; b.touchedTick = s.tick;
  b.lastKickBy = sl; b.lastKickTeam = p.team; b.lastKickKind = kind; b.lastKickTick = s.tick;
  b.passTarget = -1;
  const shot = kind >= KickKind.SHOT_NORMAL && kind <= KickKind.SHOT_LOW_DRIVEN;
  b.shotBy = shot ? sl : -1;
  b.shotTick = s.tick;
  b.shotOnTarget = shot && Math.abs(sh.tz) < GOAL_HALF_WIDTH && ty < GOAL_HEIGHT ? 1 : 0;
  return out.t;
}

/** One tick of the keeper-focused pipeline (the real stages minus AI, other contacts and rules). */
export function miniTick(s: SimState, ev: EventBufferImpl): void {
  s.tick++;
  ev.begin(s.tick);
  s.ball.cross = 0;
  keeperSaveDecision(s, 0, ev);
  keeperSaveDecision(s, 1, ev);
  actionsTick(s, ev);
  locomotionTick(s, ev);
  ballTick(s, ev);
  keeperContacts(s, ev);
}

export type Outcome = 'save' | 'goal' | 'wide' | 'none';

export interface RunResult {
  outcome: Outcome;
  /** First SAVE event of keeper 0 (if any) and every event. */
  save: SimEvent | null;
  events: SimEvent[];
  ticks: number;
  /** Keeper position at the start of his (last) dive, if he dived. */
  dived: boolean;
  diveStartX: number;
  diveStartZ: number;
  /** Tick count (from the shot) of the keeper's first reacted save action (GK_CATCH tracking/standing, GK_DIVE). */
  firstActTick: number;
  /** Tick count of his planted pre-reaction stance (GK_CATCH actA 2), -1 none. */
  plantedTick: number;
  /** Every dive started while the ball (at the start of that tick) was still in front of the keeper's plane. */
  divesBeforePassing: boolean;
  /** The keeper was in GK_CATCH at some tick, and the action he was in on the tick before the contact. */
  sawCatch: boolean;
  actBeforeContact: ActionKind;
  caught: boolean;
}

/** Run until the keeper plays the ball, the ball crosses the goal line, or maxTicks. */
export function runShot(s: SimState, maxTicks = 150, tickFn: (s: SimState, ev: EventBufferImpl) => void = miniTick): RunResult {
  const ev = createEventBuffer();
  const r: RunResult = {
    outcome: 'none', save: null, events: [], ticks: 0, dived: false, diveStartX: 0, diveStartZ: 0, firstActTick: -1, plantedTick: -1,
    divesBeforePassing: true, sawCatch: false, actBeforeContact: ActionKind.NONE, caught: false,
  };
  const k = s.players[KEEPER]!;
  let prevAct: ActionKind = k.act;
  for (let i = 0; i < maxTicks; i++) {
    const bu0 = depth(s.ball.x);
    tickFn(s, ev);
    r.ticks = i + 1;
    if (k.act === ActionKind.GK_DIVE && k.actT === 1) {
      r.dived = true; r.diveStartX = k.actX; r.diveStartZ = k.actZ;
      if (bu0 < depth(k.actX) - LOCAL_TUNING.planeBackReach) r.divesBeforePassing = false;
    }
    if (k.act === ActionKind.GK_CATCH) r.sawCatch = true;
    // First reacted save action: a dive, or GK_CATCH other than the planted pre-reaction stance (actA 2).
    if (r.firstActTick < 0 && ((k.act === ActionKind.GK_CATCH && k.actA !== 2) || k.act === ActionKind.GK_DIVE)) r.firstActTick = i + 1;
    if (r.plantedTick < 0 && k.act === ActionKind.GK_CATCH && k.actA === 2) r.plantedTick = i + 1;
    for (let e = 0; e < ev.count; e++) {
      const c = { ...ev.get(e) };
      r.events.push(c);
      if (c.type === EventType.SAVE && c.a === KEEPER && !r.save) r.save = c;
    }
    const b = s.ball;
    if (b.heldBy === KEEPER) r.caught = true;
    if (b.lastTouch === KEEPER) { r.outcome = 'save'; r.actBeforeContact = prevAct; return r; }
    prevAct = k.act;
    if (depth(b.x) < -BALL_RADIUS) {
      r.outcome = Math.abs(b.z) < GOAL_HALF_WIDTH && b.y < GOAL_HEIGHT ? 'goal' : 'wide';
      return r;
    }
  }
  return r;
}

/**
 * Physical-reach check of a keeper touch: a dive touch lies within keeperMaxReach (horizontal) of the dive start; a
 * standing / body touch lies within the arms (standArm + ball radius) of the keeper's body axis. Returns the excess
 * distance (<= 0 when physically reachable).
 */
export function reachExcess(s: SimState, r: RunResult): number {
  if (!r.save) return 0;
  const a = s.attrs[KEEPER]!;
  const k = s.players[KEEPER]!;
  if (r.dived) {
    const dx = r.save.x - r.diveStartX, dz = r.save.z - r.diveStartZ;
    return Math.sqrt(dx * dx + dz * dz) - keeperMaxReach(a);
  }
  const top = standAxisTop(a);
  const dy = r.save.y > top ? r.save.y - top : r.save.y < STAND_AXIS_LOW ? STAND_AXIS_LOW - r.save.y : 0;
  const dx = r.save.x - k.x, dz = r.save.z - k.z;
  return Math.sqrt(dx * dx + dz * dz + dy * dy) - (LOCAL_TUNING.standArm + BALL_RADIUS);
}

/** Deterministic LCG for test batches (tests may not depend on Math.random). */
export function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

/** A scripted on-target shot from the batch distribution (distance 11-33 m skewed short, 60% aimed near a post). */
export interface BatchShot extends ShotSpec { dist: number }
export function batchShot(rnd: () => number): BatchShot {
  const dist = 11 + rnd() * rnd() * 22;
  const ang = (rnd() - 0.5) * 1.1;
  const u = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
  const nearPost = rnd() < 0.6;
  const side = rnd() < 0.5 ? -1 : 1;
  const tz = nearPost ? side * (2.4 + rnd() * 1.1) : (rnd() - 0.5) * 4.8;
  const hr = rnd();
  const ty = hr < 0.5 ? 0.11 + rnd() * 0.5 : hr < 0.8 ? 0.6 + rnd() * 1.0 : 1.6 + rnd() * 0.7;
  const speed = 20 + rnd() * 12;
  return { dist, u, z, tz, ty, speed };
}
