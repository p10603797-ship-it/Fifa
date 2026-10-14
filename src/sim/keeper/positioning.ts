/**
 * [GKP-01] Keeper positioning: on the arc between ball and goal centre, with depth adjusted for distance and
 * angle (T_GK.depthFar/depthNear); sets the keeper's movement intent (ARRIVE) when free and not acting.
 * Works for both teams, every attack direction. Keeper never carries the ball over his own line.
 *
 * Geometry (goal frame: u = metres into the field from the keeper's own goal line, z unchanged):
 *  - The ball (predicted a few ticks ahead from the ball's, or its carrier's, velocity) is looked at from an
 *    anchor point on the goal line. The anchor is where the bisector of the ball's shooting angle (ball to both
 *    posts) meets the line, which is the goal centre for a central ball. At tight angles (ball wider than the post
 *    and its bearing from the near post beyond tightAngleStartDeg) the anchor slides to the near post.
 *  - The keeper stands on the anchor-to-ball line at a depth that grows with the ball's distance from the goal
 *    centre (T_GK.depthNear at depthNearDist .. T_GK.depthFar at depthFarDist) and shrinks at tight angles,
 *    never closer than ballGap to the ball along that line. At tight angles the step-out direction turns toward
 *    straight out of the goal, so he stands just off the line at the near post rather than wide of it.
 *  - Clamped inside the goal area, never closer than minLineDist to the goal line (never behind it), and inside a
 *    cone around the posts so he covers the near post instead of wandering wide of it.
 *  - gkPositioning adds accuracy: a poor keeper under-shifts toward the angle, stands too deep for close balls and
 *    too high for far ones, and reads the ball late (negative look-ahead = lag). All deterministic and smooth.
 * Movement: ARRIVE at the spot (via ai/steer arrive) facing the ball (lookAt), so he shuffles sideways instead of
 * turning his back; a few metres out of position he hurries (wantSprint) still facing the ball; only when far out
 * of position (farther than runEnter, e.g. caught high after a rush) or behind his own goal line does he turn and
 * run. Hysteresis on both.
 * Runs only while the keeper is free (no action), not human-controlled and the ball is neither in his hands nor at
 * his feet. Allocation-free and O(1) per call.
 */
import { DT, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS } from '../../contracts/constants';
import { ActionKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { MoveMode, type SimState } from '../../contracts/state';
import { T_BALL, T_GK, T_PLAYER } from '../../contracts/tuning';
import { arrive } from '../../ai/steer';
import { clamp, clamp01, datan2, lerp, PI, smoothstep, unlerp } from '../core/dmath';
import { isHumanSlot } from '../core/query';

// TUNING-CR: candidates for T_GK in contracts/tuning.ts.
export const LOCAL_TUNING = {
  /** Ball distance from the goal centre (m) at which the depth is T_GK.depthNear / T_GK.depthFar. */
  depthNearDist: 5,
  depthFarDist: 28,
  /** Ball bearing from the near post (degrees off straight out) where the near-post shift starts / is full. */
  tightAngleStartDeg: 55,
  tightAngleFullDeg: 80,
  /** Depth multiplier at a fully tight angle (unitless). */
  tightDepthMul: 0.45,
  /** Near-post anchor: this far inside the inside of the post at a fully tight angle (m). */
  nearPostInset: 0.45,
  /** The spot is never closer than this to the keeper's own goal line (m). */
  minLineDist: 0.3,
  /** Lateral limit |z| <= GOAL_HALF_WIDTH - coneInset + u * coneSlope (m, m per m of depth). */
  coneInset: 0.3,
  coneSlope: 0.8,
  /** Distance kept between the spot and the ball along the anchor-to-ball line (m). */
  ballGap: 1.0,
  /** A ball at or behind the goal line is treated as this far in front of it for the geometry (m). */
  minBallU: 0.5,
  /** Ball look-ahead at gkPositioning 99 / 1 (ticks; negative = reads the ball late). */
  leadTicksBest: 10,
  leadTicksWorst: -6,
  /** Cap on the look-ahead displacement of the ball (m). */
  leadMaxDist: 4,
  /** gkPositioning 1: fraction of the lateral (angle) shift not taken, and relative depth error (unitless). */
  shiftErrWorst: 0.35,
  depthErrWorst: 0.25,
  /** Shuffle speed cap = topSpeed * T_PLAYER.jogFraction * lerp(speedMulWorst, 1, accuracy). */
  speedMulWorst: 0.8,
  /** Hurry (sprint, still facing the ball) when the spot is farther than hurryEnter; calm again below hurryExit (m). */
  hurryEnter: 3,
  hurryExit: 1.5,
  /** Turn and run (stop facing the ball) when farther than runEnter, e.g. caught high; back to facing below runExit (m). */
  runEnter: 10,
  runExit: 6,
} as const;

const L = LOCAL_TUNING;
const DEG = PI / 180;
const TIGHT_START = L.tightAngleStartDeg * DEG;
const TIGHT_FULL = L.tightAngleFullDeg * DEG;

/** Keeper spot output (pitch coordinates). */
export interface KeeperSpot { x: number; z: number }

/** Scratch for keeperPositioning (rebuilt every call; not state). */
const spot: KeeperSpot = { x: 0, z: 0 };

/** Positioning accuracy 0..1 from the gkPositioning attribute (1 -> 0, 99 -> 1). Pure. */
export function keeperPositioningAccuracy(gkPositioning: number): number {
  return clamp01((gkPositioning - 1) / 98);
}

/**
 * Pure spot geometry for a keeper defending the goal at x = -dir * HALF_LENGTH against a ball at (bx, bz), with
 * positioning accuracy acc (0..1). No look-ahead (idealKeeperSpot adds it). Writes pitch coordinates into out.
 */
export function keeperSpotForBall(dir: number, bx: number, bz: number, acc: number, out: KeeperSpot): void {
  const d = dir < 0 ? -1 : 1;
  const err = 1 - clamp01(acc);
  const g = GOAL_HALF_WIDTH;
  let bu = d * bx + HALF_LENGTH;
  if (!(bu >= L.minBallU)) bu = L.minBallU; // also catches NaN
  if (!(bz === bz)) bz = 0;
  // Anchor on the goal line: bisector of the shooting angle (angle bisector theorem on the post-to-post segment).
  const dzP = bz + g, dzQ = bz - g;
  const dP = Math.sqrt(bu * bu + dzP * dzP);
  const dQ = Math.sqrt(bu * bu + dzQ * dzQ);
  const bis = -g + (2 * g * dP) / (dP + dQ);
  // Tight angle (bearing of the ball from the near post, 0 = straight out, <= 0 inside the posts' width): slide the
  // anchor to the near post.
  const absZ = bz < 0 ? -bz : bz;
  const tight = absZ > g ? smoothstep(TIGHT_START, TIGHT_FULL, datan2(absZ - g, bu)) : 0;
  const nearPost = bz > 0 ? g - L.nearPostInset : bz < 0 ? L.nearPostInset - g : 0;
  const az = lerp(bis, nearPost, tight) * (1 - err * L.shiftErrWorst);
  // Depth: grows with distance from the goal centre, shrinks at tight angles; accuracy error deep/high.
  const dc = Math.sqrt(bu * bu + bz * bz);
  const far01 = unlerp(L.depthNearDist, L.depthFarDist, dc);
  let depth = lerp(T_GK.depthNear, T_GK.depthFar, far01) * lerp(1, L.tightDepthMul, tight);
  depth *= 1 + err * L.depthErrWorst * (2 * far01 - 1);
  // Along the anchor-to-ball line (turning to straight out of the goal at tight angles, so he steps off the line
  // at the near post instead of sliding wide of it), never past (ball - ballGap).
  const lz = bz - az;
  const da = Math.sqrt(bu * bu + lz * lz);
  const maxDepth = da - L.ballGap;
  if (depth > maxDepth) depth = maxDepth;
  if (depth < 0) depth = 0;
  const du = (1 - tight) * (bu / da) + tight;
  const dz = (1 - tight) * (lz / da);
  const dn = Math.sqrt(du * du + dz * dz);
  let u = (depth * du) / dn;
  let z = az + (depth * dz) / dn;
  // Inside the goal area, in front of the line, inside the post cone.
  u = clamp(u, L.minLineDist, GOAL_AREA_DEPTH);
  let zMax = g - L.coneInset + u * L.coneSlope;
  if (zMax > GOAL_AREA_HALF_WIDTH) zMax = GOAL_AREA_HALF_WIDTH;
  z = clamp(z, -zMax, zMax);
  if (!(u === u) || !(z === z)) { u = L.minLineDist; z = 0; }
  out.x = d * (u - HALF_LENGTH);
  out.z = z;
}

/**
 * Ideal keeper position for the current ball position (pure). Uses the team's keeper (keeperSlot) for the
 * gkPositioning accuracy (1 when there is no keeper) and looks ahead along the ball's velocity (the carrier's
 * velocity while the ball is owned) by a few ticks, capped at leadMaxDist.
 */
export function idealKeeperSpot(s: SimState, team: number, out: { x: number; z: number }): void {
  const t = s.teams[team]!;
  const k = t.keeperSlot;
  const acc = k >= 0 && k < NUM_SLOTS ? keeperPositioningAccuracy(s.attrs[k]!.gkPositioning) : 1;
  const b = s.ball;
  let vx = b.vx, vz = b.vz;
  if (b.owner >= 0 && b.owner < NUM_SLOTS) {
    const o = s.players[b.owner]!;
    vx = o.vx; vz = o.vz;
  }
  const lead = lerp(L.leadTicksWorst, L.leadTicksBest, acc) * DT;
  let ox = vx * lead, oz = vz * lead;
  const od = Math.sqrt(ox * ox + oz * oz);
  if (od > L.leadMaxDist) { const f = L.leadMaxDist / od; ox *= f; oz *= f; }
  if (!(od === od)) { ox = 0; oz = 0; }
  keeperSpotForBall(t.dir, b.x + ox, b.z + oz, acc, out);
}

/**
 * Keeper movement intent for the team's keeper: ARRIVE at idealKeeperSpot facing the ball. No-op unless the keeper
 * is active, free (no action), not human-controlled and the ball is not in his hands or at his feet.
 */
export function keeperPositioning(s: SimState, team: number, ev: EventSink): void {
  const k = s.teams[team]!.keeperSlot;
  if (k < 0 || k >= NUM_SLOTS) return;
  const p = s.players[k]!;
  if (p.active !== 1 || p.act !== ActionKind.NONE) return;
  if (isHumanSlot(s, k)) return;
  const b = s.ball;
  if (b.heldBy === k || b.owner === k) return;
  if (receivePass(s, k)) return;

  idealKeeperSpot(s, team, spot);
  // Line guard: a keeper on or behind the safe line aims far enough out that arrival stops him in front of it.
  const d = s.teams[team]!.dir < 0 ? -1 : 1;
  const pu = d * p.x + HALF_LENGTH;
  const guardU = L.minLineDist + T_PLAYER.arriveStop;
  if (pu < L.minLineDist && d * spot.x + HALF_LENGTH < guardU) spot.x = d * (guardU - HALF_LENGTH);

  // Pace with hysteresis (the previous intent is the memory): shuffle facing the ball; hurry (sprint) facing it
  // when a few metres out of position; turn and run only when far out of position, or while behind his own goal
  // line (e.g. beside or behind the net), so locomotion can take him round the goal frame back into play.
  const dx = spot.x - p.x, dz = spot.z - p.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const wasHurry = p.wantSprint === 1;
  const run = pu < 0 || (wasHurry && p.lookAt === 0 ? dist > L.runExit : dist > L.runEnter);
  const hurry = run || (wasHurry ? dist > L.hurryExit : dist > L.hurryEnter);
  const a = s.attrs[k]!;
  const speed = hurry
    ? a.topSpeed
    : a.topSpeed * T_PLAYER.jogFraction * lerp(L.speedMulWorst, 1, keeperPositioningAccuracy(a.gkPositioning));

  // Steering through ai/steer arrive() (TAI-07). Its contract sets moveMode ARRIVE; STOP is a sentinel so that, while
  // arrive() is still a stub (or declines), the intent is written directly. arrive() sees the previous target intact.
  p.moveMode = MoveMode.STOP;
  arrive(s, k, spot.x, spot.z, speed);
  if ((p.moveMode as MoveMode) !== MoveMode.ARRIVE) { // (cast: arrive() may have written it)
    p.moveMode = MoveMode.ARRIVE;
    p.tgtX = spot.x;
    p.tgtZ = spot.z;
    p.tgtSpeed = speed;
  }
  p.wantSprint = hurry ? 1 : 0;
  p.lookAt = run ? 0 : 1;
  p.lookX = b.x;
  p.lookZ = b.z;
}

/** Back-pass reception: look-ahead step and horizon along the ball's roll, s; reach slack, m [INT-A]. */
const RECEIVE_STEP_S = 0.1;
const RECEIVE_HORIZON_S = 3;
const RECEIVE_REACH = 0.6;

/**
 * [INT-A] A teammate's pass to the keeper (ball.passTarget === k, untouched since our kick, loose on the ground): he
 * steps onto its path at the first point he can reach (top speed) instead of holding his positioning arc, so a back
 * pass rolling across the goal mouth is collected (soak: it rolled past a keeper standing on his line until the
 * 8 s ball-untouched watchdog fired). Returns true when it wrote his intent.
 */
function receivePass(s: SimState, k: number): boolean {
  const b = s.ball;
  const p = s.players[k]!;
  if (b.owner >= 0 || b.heldBy >= 0 || b.passTarget !== k || b.lastTouchTeam !== p.team || b.lastTouch === k) return false;
  if (b.y > T_PLAYER.bodyRadius * 3) return false;
  const v = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
  const top = s.attrs[k]!.topSpeed;
  let tx = b.x, tz = b.z;
  if (v >= 0.3) {
    const ux = b.vx / v, uz = b.vz / v;
    const a = T_BALL.rollDecel + T_BALL.rollDamping * v;
    const n = Math.floor(RECEIVE_HORIZON_S / RECEIVE_STEP_S);
    for (let i = 1; i <= n; i++) {
      const t = i * RECEIVE_STEP_S;
      const d = t > v / a ? (v * v) / (2 * a) : v * t - 0.5 * a * t * t;
      tx = b.x + ux * d;
      tz = b.z + uz * d;
      const dx = tx - p.x, dz = tz - p.z;
      if (Math.sqrt(dx * dx + dz * dz) <= top * t + RECEIVE_REACH) break;
    }
  }
  p.moveMode = MoveMode.ARRIVE;
  p.tgtX = tx;
  p.tgtZ = tz;
  p.tgtSpeed = top;
  p.wantSprint = 1;
  p.lookAt = 1;
  p.lookX = b.x;
  p.lookZ = b.z;
  return true;
}
