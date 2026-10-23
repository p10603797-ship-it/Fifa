/**
 * [GKP-06] Keeper at set pieces: positioning against free kicks (wall-aware), penalties (on the line, dive
 * choice for AI keepers; user dive input arrives via RUL-06 penalty input), corners (claim zone), goal kicks.
 *
 * keeperSetPiece(s, team, ev) runs for both keepers every tick of a restart phase and of the shoot-out (keeper/index
 * keeperTick, team AI stage 3 of the tick pipeline, i.e. BEFORE the actions stage in which kicks strike).
 *
 * POSITIONS (keeperSetPieceSpot, pure; the keeper walks there with ai/steer arrive(), facing the ball, sprinting when
 * a few metres off it, turning to run only when far; only while he is free (no action) and not human-controlled):
 *  - Taker (goal kick: RUL-03 makes him the taker; a free kick in his own area): before the restart is ready he walks
 *    to RUL-11's taker spot behind the ball; from ready on RUL-11 / RUL-03 own him (SET_PIECE). He is walked there
 *    even when a human controls him (nobody else moves a taker during the setup).
 *  - Corner against: on his line toward the far post (cornerDepth off the line, cornerFarZ toward the far post),
 *    square to the ball and free of any action, so GKP-03 can claim the cross the tick it is struck.
 *  - Free kick against, within fkMaxDist of his goal, with a wall (RUL-05: restart.wallCount, wallX/wallZ = wall
 *    centre; the members' mean when the planned centre is unusable): the wall's shadow on the goal line is cast from
 *    the ball past both wall edges (half width wallHalfPerMember per member + wallEdge). His goal-line point is the
 *    weighted centre of the mouth, open points weighing 1 and shadowed ones fkShadowWeight (a ball can still be curled
 *    round or dipped over the wall into them): on the side the wall does not cover, nearer the centre the more the
 *    wall covers, continuous as the wall moves. He stands on the line from that point to the ball at a depth that
 *    grows with the distance (fkDepthNear at fkNearDist .. fkDepthFar at fkFarDist from the goal centre). A poor
 *    gkPositioning under-shifts (fkShiftErrWorst). Without a wall: GKP-01's open-play spot for the ball. Either way the spot is made
 *    legal for RUL-11: >= 9.15 m + legalMargin from the ball, or on his goal line between the posts when the ball is
 *    nearer than 9.15 m to that line (the only legal place then), so RUL-11 never has to push him.
 *  - Penalty against: on his line centre (penLineDepth off the line; RUL-11 keeps him within 1 m of it). A human
 *    keeper is walked there only before ready; from ready on RUL-06 moves him along the line.
 *  - Shoot-out: RUL-07 places both keepers at each kick; the defending keeper (AI) is held on his line centre (the
 *    penalty spot above, which is where RUL-07 puts him), the kicking team's keeper waits where RUL-07 put him
 *    (beside the goal), standing still facing the ball. The kick's sub-state is read from the restart record RUL-07
 *    keeps (ready / taken), so this module needs nothing from rules/shootout.ts.
 *  - Everything else (kick-offs: in goal; throw-ins; goal kicks he does not take; restarts at the other end):
 *    GKP-01 keeperPositioning (the ball is still, so that is his normal spot).
 *
 * PENALTY AND SHOOT-OUT DIVES:
 *  - The defending keeper commits at the kick's contact tick. Kicks strike in the actions stage (stage 4), after this
 *    module (stage 3), so the contact tick is recognised from the kicker's action as the SHOT / KICK handler will see
 *    it (contract: contact once actT >= actContact, not charging, not done; the dispatcher increments actT first):
 *    kicker.act SHOT/KICK, actDone 0, actCharging 0, actContact >= 0, actT + 1 >= actContact. The dive is started
 *    in that same tick (before the strike), so at the end of the tick ball.lastKickTick === s.tick and the keeper is
 *    in GK_DIVE. A kick that already struck earlier in the tick (ball.lastKickBy = kicker, lastKickTick = s.tick)
 *    dives at once too. A kick struck after stage 3 of the previous tick (RUL-07's safety-net applyKick in the rules
 *    stage: FLIGHT; or any strike outside step(): restart already taken) is answered on the next tick
 *    (lastKickTick = s.tick - 1). (RUL-11's forced penalty in play returns to IN_PLAY in the same tick: GKP-02.)
 *  - Human keeper (isHumanSlot): the choice RUL-06 / RUL-07 stored: restart.side = dive side in pitch z (-1 toward
 *    -z, +1 toward +z, 0 = none / stay in the middle), restart.aimPower = height class 0 low / 1 mid / 2 high.
 *  - AI keeper (CPU brain or team AI): aiDiveChoice, a deterministic random draw keyed on the kick (core/rng sfc32
 *    seeded from config.seed, the contact tick, kicker and keeper; s.rng is not consumed, so the choice is the same
 *    whenever it is evaluated for that kick): stay in the middle with aiMiddleChance, else the kicker's natural side
 *    (by foot: right-footers favour their left, as TAI-13's CPU kickers do) with a chance that falls with his
 *    composure (aiNaturalWorst .. aiNaturalBest) and moves by aiHistoryWeight toward the side of his previous
 *    penalty (history: needs a state field, see the report's CR; 0 = unknown until then); height low / mid / high
 *    by aiLowChance / aiMidChance / rest.
 *  - Side 0: no dive, he stands his ground (GKP-02 reacts to the shot like any other). Otherwise GKP-02
 *    startKeeperDive toward penaltyDiveTarget: along his line toward the side (diveForward off it), as far as his
 *    reach (keeperMaxReach) but not past the post by more than diveBeyondPost, hand height by class. The save is
 *    decided only by GKP-02's physical contacts (dive capsule vs the ball's path). In the shoot-out (where keeperTick
 *    does not run the open-play pipeline) the defending keeper gets GKP-02 keeperSaveDecision during FLIGHT, exactly as
 *    after a penalty in play (IN_PLAY from the contact tick on).
 *
 * Exports beyond the stub: LOCAL_TUNING (= T_GK_SETPIECE), SpotKind, keeperSetPieceSpot, freeKickKeeperSpot, cornerKeeperSpot,
 * penaltyKeeperSpot, wallShadow / WallShadow, kickContactThisTick, penaltyContactTick, DiveChoice / createDiveChoice,
 * aiDiveChoiceFrom (pure), aiDiveChoice, humanDiveChoice, penaltyDiveTarget, commitPenaltyDive.
 * Determinism: no Math trig / random, no Map/Set, slot-indexed; allocation-free (module scratch only, the kick-keyed
 * RNG scratch is reseeded before every use). Cost: O(1) per keeper per tick (O(5) for a wall).
 */
import { GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS, RESTART_DISTANCE } from '../../contracts/constants';
import { ActionKind, Foot, MatchPhase, RestartKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { MoveMode, type RngState, type SimState } from '../../contracts/state';
import { T_PLAYER, T_GK_SETPIECE } from '../../contracts/tuning';
import { arrive } from '../../ai/steer';
import { clamp, clamp01, lerp, unlerp } from '../core/dmath';
import { isHumanSlot } from '../core/query';
import { rngFloat, rngSeed } from '../core/rng';
import { isRestartPhase, PHASE_KIND } from '../rules/restartCommon';
import { restartTakerSpot } from '../rules/restart';
import { keeperPositioning, keeperPositioningAccuracy, keeperSpotForBall } from './positioning';
import { keeperMaxReach, keeperSaveDecision, startKeeperDive } from './saves';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_GK_SETPIECE. */
export const LOCAL_TUNING = T_GK_SETPIECE;

const LT = T_GK_SETPIECE;

/** keeperSetPieceSpot results. */
export const SpotKind = {
  /** No set-piece spot: GKP-01 open-play positioning (kick-off, throw-in, goal kick he does not take, far end). */
  OPEN: 0,
  /** A set-piece spot (corner / free kick / penalty / shoot-out). */
  SET: 1,
  /** He takes the restart: RUL-11's taker spot behind the ball (until the restart is ready). */
  TAKER: 2,
  /** Shoot-out, the kicking team's keeper: he stays where RUL-07 put him (out untouched). */
  HOLD: 3,
} as const;

/** AI / human dive choice: side in pitch z (-1, 0 = stay in the middle, +1), height class 0 low / 1 mid / 2 high. */
export interface DiveChoice { side: number; height: number }

export function createDiveChoice(): DiveChoice {
  return { side: 0, height: 1 };
}

/** Wall shadow on the goal line (z interval lo..hi), from wallShadow. */
export interface WallShadow { lo: number; hi: number }

// ---------------------------------------------------------------- module scratch (rewritten before every use)

const SPOT = { x: 0, z: 0 };
const TMP = { x: 0, z: 0 };
const WALL = { x: 0, z: 0 };
const SHADOW: WallShadow = { lo: 0, hi: 0 };
const TGT = { x: 0, y: 0, z: 0 };
const CHOICE = createDiveChoice();
/** Kick-keyed RNG (reseeded from the kick before every use; holds nothing between uses). */
const KEY_RNG: RngState = { a: 0, b: 0, c: 0, d: 0 };

// ---------------------------------------------------------------- small helpers

function validSlot(slot: number): boolean {
  return slot >= 0 && slot < NUM_SLOTS;
}

function dirOf(s: SimState, team: number): number {
  return s.teams[team]!.dir >= 0 ? 1 : -1;
}

/** Steer keeper k to (x, z) facing the ball: shuffle near the spot, sprint (still facing) a few metres off, run when far. */
function steerTo(s: SimState, k: number, x: number, z: number): void {
  const p = s.players[k]!;
  const a = s.attrs[k]!;
  const b = s.ball;
  const dx = x - p.x, dz = z - p.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const hurry = p.wantSprint === 1 ? dist > LT.hurryExit : dist > LT.hurryEnter;
  const top = a.topSpeed > 0 ? a.topSpeed : T_PLAYER.topSpeedMin;
  const speed = hurry ? top : top * T_PLAYER.jogFraction * LT.shuffleFrac;
  // ai/steer arrive() (TAI-07) sets ARRIVE; STOP is the sentinel for "it declined" (then the intent is written here).
  p.moveMode = MoveMode.STOP;
  arrive(s, k, x, z, speed);
  if ((p.moveMode as MoveMode) !== MoveMode.ARRIVE) {
    p.moveMode = MoveMode.ARRIVE;
    p.tgtX = x;
    p.tgtZ = z;
    p.tgtSpeed = speed;
  }
  p.wantSprint = hurry ? 1 : 0;
  p.lookAt = dist > LT.faceDist ? 0 : 1;
  p.lookX = b.x;
  p.lookZ = b.z;
}

// ---------------------------------------------------------------- spots

/** Penalty keeper's spot for `team` (his line centre), pitch coordinates into out. */
export function penaltyKeeperSpot(s: SimState, team: number, out: { x: number; z: number }): void {
  const d = dirOf(s, team);
  out.x = d * (LT.penLineDepth - HALF_LENGTH);
  out.z = 0;
}

/** Corner against `team`: on his line toward the far post (from the corner's side, restart.z / restart.side). */
export function cornerKeeperSpot(s: SimState, team: number, out: { x: number; z: number }): void {
  const r = s.match.restart;
  const d = dirOf(s, team);
  const sz = r.z > 0 ? 1 : r.z < 0 ? -1 : r.side >= 0 ? 1 : -1;
  out.x = d * (LT.cornerDepth - HALF_LENGTH);
  out.z = -sz * LT.cornerFarZ;
}

/** Wall size of the current free kick: restart.wallCount clamped to the record (0..wall.length). */
function wallMembers(s: SimState): number {
  const r = s.match.restart;
  const n = r.wallCount;
  if (!(n > 0)) return 0;
  return n < r.wall.length ? Math.floor(n) : r.wall.length;
}

/** Wall centre of the current free kick into WALL; false when there is no usable wall. */
function wallCentre(s: SimState): boolean {
  const r = s.match.restart;
  const n = wallMembers(s);
  if (n === 0) return false;
  const dx = r.wallX - r.x, dz = r.wallZ - r.z;
  const d2 = dx * dx + dz * dz;
  if (d2 >= LT.wallMinDist * LT.wallMinDist && d2 <= LT.wallMaxDist * LT.wallMaxDist) {
    WALL.x = r.wallX;
    WALL.z = r.wallZ;
    return true;
  }
  let sx = 0, sz = 0, m = 0;
  for (let i = 0; i < r.wall.length && i < n; i++) {
    const slot = r.wall[i]!;
    if (!validSlot(slot)) continue;
    const q = s.players[slot]!;
    if (q.active !== 1) continue;
    sx += q.x;
    sz += q.z;
    m++;
  }
  if (m === 0) return false;
  WALL.x = sx / m;
  WALL.z = sz / m;
  return true;
}

/**
 * Shadow of the current free kick's wall on the goal line of the team with attack direction `dir` (the keeper's
 * team), as a z interval into out. Goal frame: u = metres into the field from that goal line. Returns 0 when there is
 * no wall or it does not stand between the ball and the goal.
 */
export function wallShadow(s: SimState, dir: number, out: WallShadow): number {
  if (!wallCentre(s)) return 0;
  const r = s.match.restart;
  const d = dir >= 0 ? 1 : -1;
  const ub = d * r.x + HALF_LENGTH, zb = r.z;
  const uw = d * WALL.x + HALF_LENGTH, zw = WALL.z;
  const du = uw - ub, dz = zw - zb;
  const dl = Math.sqrt(du * du + dz * dz);
  if (!(dl > 1e-6) || !(ub > 1e-6)) return 0;
  // Perpendicular to the ball -> wall line, in the (u, z) plane.
  const pu = -dz / dl, pz = du / dl;
  const hw = wallMembers(s) * LT.wallHalfPerMember + LT.wallEdge;
  let lo = 1e9, hi = -1e9;
  for (let e = -1; e <= 1; e += 2) {
    const ue = uw + e * hw * pu;
    const ze = zw + e * hw * pz;
    if (!(ue < ub - 1e-6)) return 0; // the wall edge is not between the ball and the goal line
    const t = ub / (ub - ue);
    const zl = zb + t * (ze - zb);
    if (zl < lo) lo = zl;
    if (zl > hi) hi = zl;
  }
  if (!(lo === lo) || !(hi === hi)) return 0;
  out.lo = lo;
  out.hi = hi;
  return 1;
}

/**
 * Keeper spot against the current free kick (defended by `team`), into out (pitch coordinates). Returns 1, or 0 when
 * the free kick is further than fkMaxDist from his goal centre (then GKP-01 positioning applies).
 */
export function freeKickKeeperSpot(s: SimState, team: number, out: { x: number; z: number }): number {
  const r = s.match.restart;
  const d = dirOf(s, team);
  const ub = d * r.x + HALF_LENGTH, zb = r.z;
  const dc = Math.sqrt(ub * ub + zb * zb);
  if (!(dc <= LT.fkMaxDist)) return 0;
  const k = s.teams[team]!.keeperSlot;
  const acc = validSlot(k) ? keeperPositioningAccuracy(s.attrs[k]!.gkPositioning) : 1;
  const g = GOAL_HALF_WIDTH;
  let su: number, sz: number;
  let anchorZ: number;
  if (wallShadow(s, d, SHADOW) === 1) {
    // Weighted centre of the mouth: open points weigh 1, points in the wall's shadow fkShadowWeight (a ball can still
    // be curled round or dipped over the wall into them). Continuous in the shadow, inside the mouth.
    const lo = clamp(SHADOW.lo, -g, g), hi = clamp(SHADOW.hi, -g, g);
    const cut = 1 - LT.fkShadowWeight;
    const w = 2 * g - cut * (hi - lo);
    anchorZ = w > 1e-6 ? (-cut * 0.5 * (hi * hi - lo * lo)) / w : 0;
    anchorZ *= 1 - (1 - acc) * LT.fkShiftErrWorst;
    const depth = lerp(LT.fkDepthNear, LT.fkDepthFar, unlerp(LT.fkNearDist, LT.fkFarDist, dc));
    const lz = zb - anchorZ;
    const la = Math.sqrt(ub * ub + lz * lz);
    su = la > 1e-6 ? (depth * ub) / la : depth;
    sz = la > 1e-6 ? anchorZ + (depth * lz) / la : anchorZ;
  } else {
    keeperSpotForBall(d, r.x, r.z, acc, TMP);
    su = d * TMP.x + HALF_LENGTH;
    sz = TMP.z;
    anchorZ = sz;
  }
  if (su < LT.minLineDist) su = LT.minLineDist;
  const zl = g + LT.fkPostExtra;
  sz = clamp(sz, -zl, zl);
  // Legal for RUL-11: outside the 9.15 m circle, or on the goal line between the posts when the ball is nearer than
  // 9.15 m to that line.
  const R = RESTART_DISTANCE + LT.legalMargin;
  const bu = su - ub, bz = sz - zb;
  const bd = Math.sqrt(bu * bu + bz * bz);
  if (bd < R) {
    if (ub < RESTART_DISTANCE) {
      const zi = g - LT.lineInsidePost;
      su = LT.lineDepth;
      sz = clamp(anchorZ, -zi, zi);
    } else {
      let ux = bu, uz = bz;
      if (!(bd > 1e-6)) { ux = -1; uz = 0; } else { ux /= bd; uz /= bd; }
      su = ub + ux * R;
      sz = zb + uz * R;
      if (su < LT.minLineDist) {
        su = LT.minLineDist;
        const h = ub - su;
        const side = bz > 0 ? 1 : bz < 0 ? -1 : zb > 0 ? -1 : 1;
        sz = zb + side * Math.sqrt(R * R > h * h ? R * R - h * h : 0);
      }
    }
  }
  out.x = d * (su - HALF_LENGTH);
  out.z = sz;
  return 1;
}

/**
 * Where team's keeper should stand for the current restart / shoot-out kick (pure), into out. SpotKind.SET: a
 * set-piece spot; TAKER: he takes the restart (RUL-11's taker spot; he walks there until the restart is ready);
 * HOLD: the shoot-out's waiting keeper stays where he is; OPEN: none (GKP-01 open-play positioning; out untouched for
 * HOLD / OPEN).
 */
export function keeperSetPieceSpot(s: SimState, team: number, out: { x: number; z: number }): number {
  if (team !== 0 && team !== 1) return SpotKind.OPEN;
  const k = s.teams[team]!.keeperSlot;
  if (!validSlot(k)) return SpotKind.OPEN;
  const m = s.match;
  if (m.phase === MatchPhase.SHOOT_OUT) {
    const so = m.shootout;
    if (so.active !== 1 || k === so.kicker) return SpotKind.OPEN;
    if (k !== so.keeper) return SpotKind.HOLD;
    penaltyKeeperSpot(s, team, out);
    return SpotKind.SET;
  }
  if (!isRestartPhase(m.phase)) return SpotKind.OPEN;
  const r = m.restart;
  if (r.kind !== PHASE_KIND[m.phase]) return SpotKind.OPEN;
  if (k === r.taker) {
    restartTakerSpot(s, out);
    return SpotKind.TAKER;
  }
  if (r.team === team) return SpotKind.OPEN;
  switch (r.kind) {
    case RestartKind.PENALTY:
      penaltyKeeperSpot(s, team, out);
      return SpotKind.SET;
    case RestartKind.CORNER:
      cornerKeeperSpot(s, team, out);
      return SpotKind.SET;
    case RestartKind.FREE_KICK:
      return freeKickKeeperSpot(s, team, out) === 1 ? SpotKind.SET : SpotKind.OPEN;
    default:
      return SpotKind.OPEN;
  }
}

// ---------------------------------------------------------------- dives

/**
 * True when `slot`'s kick (SHOT / KICK action) will make contact in this tick's actions stage, as seen before it
 * (the dispatcher increments actT, then the handler strikes once actT >= actContact while not charging and not done).
 */
export function kickContactThisTick(s: SimState, slot: number): boolean {
  if (!validSlot(slot)) return false;
  const p = s.players[slot]!;
  if (p.active !== 1 || (p.act !== ActionKind.SHOT && p.act !== ActionKind.KICK)) return false;
  return p.actDone === 0 && p.actCharging === 0 && p.actContact >= 0 && p.actT + 1 >= p.actContact;
}

/**
 * Contact tick of `kicker`'s kick as seen from the keeper stage of this tick: s.tick when it struck earlier in this
 * tick or (anticipate) strikes in this tick's actions stage; s.tick - 1 when (late) it struck after the keeper stage
 * of the previous tick; -1 otherwise.
 */
export function penaltyContactTick(s: SimState, kicker: number, anticipate: boolean, late: boolean): number {
  if (!validSlot(kicker)) return -1;
  const b = s.ball;
  if (b.lastKickBy === kicker && b.lastKickTick === s.tick) return s.tick;
  if (anticipate && kickContactThisTick(s, kicker)) return s.tick;
  if (late && b.lastKickBy === kicker && b.lastKickTick === s.tick - 1) return s.tick - 1;
  return -1;
}

/**
 * Pure AI dive choice from two uniforms u1, u2 in [0, 1): the kicker's natural side `natural` (+-1, pitch z), the side
 * of his previous penalty `hist` (+-1 pitch z, 0 unknown) and his composure attribute (1..99). Into out.
 */
export function aiDiveChoiceFrom(
  u1: number, u2: number, natural: number, hist: number, composure: number, out: DiveChoice,
): void {
  const nat = natural < 0 ? -1 : 1;
  if (u1 < LT.aiMiddleChance) {
    out.side = 0;
  } else {
    let pNat = lerp(LT.aiNaturalWorst, LT.aiNaturalBest, clamp01((composure - 1) / 98));
    if (hist > 0 || hist < 0) pNat += (hist > 0 ? 1 : -1) === nat ? LT.aiHistoryWeight : -LT.aiHistoryWeight;
    pNat = clamp(pNat, 0.05, 0.95);
    const v = (u1 - LT.aiMiddleChance) / (1 - LT.aiMiddleChance);
    out.side = v < pNat ? nat : -nat;
  }
  out.height = u2 < LT.aiLowChance ? 0 : u2 < LT.aiLowChance + LT.aiMidChance ? 1 : 2;
}

/** uint32 key of a kick (match seed, contact tick, kicker, keeper): integer mixing only (Math.imul is exact). */
function kickKey(seed: number, tick: number, kicker: number, keeper: number): number {
  let h = (seed ^ 0x6a09e667) >>> 0;
  h = Math.imul(h ^ (tick >>> 0), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13) ^ ((kicker + 1) << 8) ^ ((keeper + 1) << 20), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * AI keeper's dive for `kicker`'s penalty struck at `contactTick` (deterministic, keyed on the kick: the same answer
 * every time it is asked for that kick; s.rng untouched). Into out.
 */
export function aiDiveChoice(s: SimState, kicker: number, keeper: number, contactTick: number, out: DiveChoice): void {
  rngSeed(KEY_RNG, kickKey(s.config.seed >>> 0, contactTick, kicker, keeper));
  const u1 = rngFloat(KEY_RNG);
  const u2 = rngFloat(KEY_RNG);
  // The kicker attacks the keeper's goal at x = end * HALF_LENGTH; facing it his right is end * z, so a right-footer's
  // natural (left) side is -end.
  const end = validSlot(keeper) ? -dirOf(s, s.players[keeper]!.team) : 1;
  const a = validSlot(kicker) ? s.attrs[kicker]! : null;
  const natural = a !== null && a.foot === Foot.LEFT ? end : -end;
  // History: no per-player penalty record in state yet (CR: match.penSide); 0 = unknown.
  aiDiveChoiceFrom(u1, u2, natural, 0, a !== null ? a.composure : 50, out);
}

/** Human keeper's dive from the restart record (RUL-06 / RUL-07: side = restart.side, height = restart.aimPower). */
export function humanDiveChoice(s: SimState, out: DiveChoice): void {
  const r = s.match.restart;
  out.side = r.side > 0 ? 1 : r.side < 0 ? -1 : 0;
  const h = r.aimPower;
  out.height = h >= 1.5 ? 2 : h >= 0.5 ? 1 : 0;
}

/**
 * Dive target for keeper k diving to `side` (+-1, pitch z) at height class `height`: along his line toward that side
 * (diveForward in front of him), as far as his reach but not past the post by more than diveBeyondPost; hand height
 * by class. Into out.
 */
export function penaltyDiveTarget(
  s: SimState, k: number, side: number, height: number, out: { x: number; y: number; z: number },
): void {
  const p = s.players[k]!;
  const d = dirOf(s, p.team);
  const sd = side < 0 ? -1 : 1;
  const lim = GOAL_HALF_WIDTH + LT.diveBeyondPost;
  let tz = clamp(p.z + sd * keeperMaxReach(s.attrs[k]!), -lim, lim);
  if (sd * (tz - p.z) < LT.minDiveLateral) tz = p.z + sd * LT.minDiveLateral;
  out.x = p.x + d * LT.diveForward;
  out.z = tz;
  out.y = height <= 0 ? LT.diveLowY : height === 1 ? LT.diveMidY : LT.diveHighY;
}

/**
 * Keeper k's dive for `kicker`'s penalty at `contactTick`: the human's stored choice or the AI choice; side 0 stays.
 * No-op while he is already diving. Returns 1 if a dive was started.
 */
export function commitPenaltyDive(s: SimState, k: number, kicker: number, contactTick: number): number {
  if (!validSlot(k)) return 0;
  const p = s.players[k]!;
  if (p.active !== 1 || p.act === ActionKind.GK_DIVE) return 0;
  if (isHumanSlot(s, k)) humanDiveChoice(s, CHOICE);
  else aiDiveChoice(s, kicker, k, contactTick, CHOICE);
  if (CHOICE.side === 0) return 0;
  penaltyDiveTarget(s, k, CHOICE.side, CHOICE.height, TGT);
  return startKeeperDive(s, k, TGT.x, TGT.y, TGT.z);
}

// ---------------------------------------------------------------- per-kind keeper logic

/** The defending keeper at a penalty in play (RUL-06). */
function penaltyKeeper(s: SimState, team: number, k: number): void {
  const r = s.match.restart;
  const ct = penaltyContactTick(s, r.taker, r.taken === 0, r.taken === 1);
  if (ct >= 0) commitPenaltyDive(s, k, r.taker, ct);
  const p = s.players[k]!;
  if (p.act !== ActionKind.NONE || r.taken === 1) return;
  if (r.ready === 1 && isHumanSlot(s, k)) return; // RUL-06 moves him along the line
  penaltyKeeperSpot(s, team, SPOT);
  steerTo(s, k, SPOT.x, SPOT.z);
}

/** Both keepers during the shoot-out (RUL-07). */
/** Stand still where he is, facing the ball. */
function holdStill(s: SimState, k: number): void {
  const p = s.players[k]!;
  p.moveMode = MoveMode.STOP;
  p.ix = 0;
  p.iz = 0;
  p.wantSprint = 0;
  p.lookAt = 1;
  p.lookX = s.ball.x;
  p.lookZ = s.ball.z;
}

/**
 * Both keepers during the shoot-out (RUL-07). The kick's sub-state comes from the restart record RUL-07 keeps:
 * ready 0 / taken 0 = SETUP, ready 1 / taken 0 = AIM, ready 1 / taken 1 = FLIGHT (ball live), ready 0 / taken 1 =
 * RESULT.
 */
function shootoutKeeper(s: SimState, team: number, k: number, ev: EventSink): void {
  const so = s.match.shootout;
  if (so.active !== 1) return;
  const r = s.match.restart;
  const p = s.players[k]!;
  if (k === so.keeper) {
    if (r.ready === 1) {
      const ct = penaltyContactTick(s, so.kicker, r.taken === 0, r.taken === 1);
      if (ct >= 0) commitPenaltyDive(s, k, so.kicker, ct);
      if (r.taken === 1) { // FLIGHT: the ball is live; GKP-02 saves, as after a penalty in play
        keeperSaveDecision(s, team, ev);
        return;
      }
    } else if (r.taken === 1) {
      return; // RESULT
    }
    if (p.act !== ActionKind.NONE || isHumanSlot(s, k)) return; // RUL-07 moves a human keeper along the line
    penaltyKeeperSpot(s, team, SPOT); // RUL-07 puts him there at each kick; AI keepers are held there
    steerTo(s, k, SPOT.x, SPOT.z);
    return;
  }
  // The kicking team's keeper waits where RUL-07 put him (beside the goal), facing the ball.
  if (k === so.kicker || p.act !== ActionKind.NONE || isHumanSlot(s, k)) return;
  holdStill(s, k);
}

export function keeperSetPiece(s: SimState, team: number, ev: EventSink): void {
  if (team !== 0 && team !== 1) return;
  const k = s.teams[team]!.keeperSlot;
  if (!validSlot(k)) return;
  const p = s.players[k]!;
  if (p.active !== 1) return;
  const m = s.match;
  if (m.phase === MatchPhase.SHOOT_OUT) {
    shootoutKeeper(s, team, k, ev);
    return;
  }
  if (!isRestartPhase(m.phase)) return;
  const r = m.restart;
  if (r.kind === RestartKind.PENALTY && r.kind === PHASE_KIND[m.phase] && r.team !== team) {
    penaltyKeeper(s, team, k);
    return;
  }
  if (p.act !== ActionKind.NONE) return;
  const b = s.ball;
  if (b.heldBy === k || b.owner === k) return;
  const kind = keeperSetPieceSpot(s, team, SPOT);
  if (kind === SpotKind.TAKER) {
    // Walked to the ball during the setup, even when a human controls him (nobody else moves him then); from ready on
    // RUL-11 / the kind module own the taker.
    if (r.ready === 0) steerTo(s, k, SPOT.x, SPOT.z);
    return;
  }
  if (isHumanSlot(s, k)) return;
  if (kind === SpotKind.SET) steerTo(s, k, SPOT.x, SPOT.z);
  else keeperPositioning(s, team, ev);
}
