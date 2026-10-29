/**
 * [SIM-15] Pitch gestures (section 9 "Pitch gestures"), resolved from the gesture fields of the InputFrame
 * (gesture, gx/gz decimetres, gSlot, gdx/gdz, gPower, gCurve, gFlags) for the controlled player:
 *  attack (ball at his feet, or arriving for a first-time kick):
 *   - tap a teammate or just behind him -> ground pass to feet (targetSlot); tap the space in front of a teammate
 *     -> through ball to that point; double-tap -> lob pass / lobbed through ball; in the crossing zone a
 *     double-tap toward a post -> cross to that post; tap on the goal (ON_GOAL) -> chip shot;
 *   - swipe toward goal -> shot (gPower = power), curved swipe -> finesse with curl (gCurve), back-and-forth swipe
 *     -> power shot; swipe in the own half with the ball -> clearance;
 *  keeper holding the ball: tap a teammate -> throw, double-tap -> drop kick to him, swipe -> drop kick that way;
 *  defence: tap the opposing carrier -> press him (+ second defender), swipe in the own half -> slide tackle,
 *   double-tap -> second defender, tap the own keeper (ON_OWN_KEEPER) -> keeper rush, tap a teammate -> switch.
 * Gestures go through the same starters as buttons (ReqFlag.GESTURE) and are buffered like presses.
 */
import { GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS } from '../../contracts/constants';
import { ActionKind, Foot, GestureKind, KickKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { GestureFlag } from '../../contracts/input';
import type { ControllerState, PlayerState, SimState } from '../../contracts/state';
import { ReqFlag } from '../../contracts/systems';
import { T_FEEL, T_PASS } from '../../contracts/tuning';
import { startTackle } from '../defend/tackle';
import { startKeeperRush } from '../keeper/sweeper';
import { inCrossingZone } from '../pitch/geometry';
import { manualSwitch } from './switching';
import { afterStart, prepareFree, startKick } from './resolveActions';
import {
  Ctx, GR, LT, Res, SeqFlag, ballEta, controlContext, inOwnHalf, prepReq, validSlot,
} from './resolveShared';

/** Pending gesture launch (scratch): filled field by field, then launchG reads it (no doubles across calls). */
const GL = { kind: 0 as KickKind, flags: 0, power: 0, dirX: 0, dirZ: 0, target: -1, hasTarget: 0, tx: 0, tz: 0, curve: 0 };

function glReset(kind: KickKind, flags: number): void {
  GL.kind = kind; GL.flags = flags; GL.power = 0; GL.dirX = 0; GL.dirZ = 0; GL.target = -1; GL.hasTarget = 0;
  GL.tx = 0; GL.tz = 0; GL.curve = 0;
}

function launchG(s: SimState, ctl: ControllerState, slot: number, ev: EventSink): number {
  const req = prepReq(ctl, -1, 0, 0, GL.flags | ReqFlag.GESTURE);
  const pw = GL.power;
  req.power = pw < 0 ? 0 : pw > 1 ? 1 : pw;
  req.dirX = GL.dirX;
  req.dirZ = GL.dirZ;
  req.targetSlot = GL.target;
  req.hasTarget = GL.hasTarget;
  req.targetX = GL.tx;
  req.targetZ = GL.tz;
  req.curve = GL.curve;
  if (startKick(s, slot, GL.kind, req, ev) !== 1) return Res.RETRY;
  afterStart(s, ctl, slot, -1, req);
  return Res.STARTED;
}

/** Teammate the tap means: GR.gSlot if it is an active teammate, else the nearest within LT.tapSpaceRadius of the point. */
function tapTeammate(s: SimState, p: Readonly<PlayerState>): number {
  const g = GR.gSlot;
  if (validSlot(g) && g !== p.slot) {
    const q = s.players[g]!;
    if (q.active === 1 && q.team === p.team) return g;
  }
  const gx = GR.gx / 10, gz = GR.gz / 10;
  const first = p.team === 0 ? 0 : 11;
  let best = -1;
  let bestD = LT.tapSpaceRadius * LT.tapSpaceRadius;
  for (let i = first; i < first + 11; i++) {
    if (i === p.slot) continue;
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const dx = q.x - gx, dz = q.z - gz;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** GL.dirX/dirZ toward (GL.tx, GL.tz) from p (facing if on top of it); GL.power from that distance. */
function aimAtTarget(p: Readonly<PlayerState>): void {
  const dx = GL.tx - p.x, dz = GL.tz - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > 1e-6) { GL.dirX = dx / d; GL.dirZ = dz / d; } else { GL.dirX = p.fx; GL.dirZ = p.fz; }
  const v = d / LT.gesturePassFullDist;
  GL.power = v < LT.gesturePassMinPower ? LT.gesturePassMinPower : v > 1 ? 1 : v;
}

/** GL.dirX/dirZ = unit swipe direction; false if none. */
function swipeDir(): boolean {
  const d = Math.sqrt(GR.gdx * GR.gdx + GR.gdz * GR.gdz);
  if (d < 1e-6) return false;
  GL.dirX = GR.gdx / d;
  GL.dirZ = GR.gdz / d;
  return true;
}

/** GL.power from the swipe speed (default when the gesture carries none). */
function swipePower(): void {
  GL.power = GR.gPower > 0 ? GR.gPower / 127 : LT.gestureShotDefaultPower;
}

function isSwipe(k: number): boolean {
  return k === GestureKind.SWIPE || k === GestureKind.CURVED_SWIPE || k === GestureKind.BACK_FORTH_SWIPE;
}

function attackGesture(s: SimState, ctl: ControllerState, slot: number, ev: EventSink): number {
  const b = s.ball;
  const p = s.players[slot]!;
  let ft = 0;
  if (!(b.owner === slot && b.heldBy < 0)) {
    if (b.owner >= 0 || b.heldBy >= 0) return Res.DROP;
    const eta = ballEta(s, slot);
    if (eta < 0 || eta > T_PASS.windup + LT.firstTimeLeadTicks || b.y > LT.firstTimeMaxHeight) return Res.RETRY;
    ft = ReqFlag.FIRST_TIME;
  }
  if (!prepareFree(s, slot)) return Res.RETRY;
  const dir = s.teams[p.team]!.dir;
  const kind = GR.kind;
  if (kind === GestureKind.TAP || kind === GestureKind.DOUBLE_TAP) {
    const dbl = kind === GestureKind.DOUBLE_TAP;
    const zone = dbl && inCrossingZone(p.x, p.z, dir);
    if ((GR.gFlags & GestureFlag.ON_GOAL) !== 0 && !zone) {
      glReset(KickKind.SHOT_CHIP, ft);
      GL.tx = GR.gx / 10; GL.tz = GR.gz / 10; GL.hasTarget = 1;
      aimAtTarget(p);
      swipePower();
      return launchG(s, ctl, slot, ev);
    }
    if (zone) {
      // Cross to the near or far post: the post spot nearest the double-tap, if close enough (or on the goal).
      const gx = GR.gx / 10, gz = GR.gz / 10;
      const sx = dir * (HALF_LENGTH - LT.crossPostDepth);
      const dzA = gz - GOAL_HALF_WIDTH, dzB = gz + GOAL_HALF_WIDTH, dx = gx - sx;
      const near = dzA * dzA <= dzB * dzB;
      const bz = near ? GOAL_HALF_WIDTH : -GOAL_HALF_WIDTH;
      const bd = dx * dx + (near ? dzA * dzA : dzB * dzB);
      if (bd <= LT.crossPostRadius * LT.crossPostRadius || (GR.gFlags & GestureFlag.ON_GOAL) !== 0) {
        glReset(KickKind.CROSS, ft);
        GL.tx = sx; GL.tz = bz; GL.hasTarget = 1;
        aimAtTarget(p);
        return launchG(s, ctl, slot, ev);
      }
    }
    const t = tapTeammate(s, p);
    if (t < 0) return Res.DROP;
    const q = s.players[t]!;
    const ahead = dir * (GR.gx / 10 - q.x);
    if (ahead > LT.tapThroughLead) {
      glReset(dbl ? KickKind.THROUGH_LOBBED : KickKind.THROUGH_GROUND, ft);
      GL.tx = GR.gx / 10; GL.tz = GR.gz / 10; GL.hasTarget = 1; GL.target = t;
    } else {
      glReset(dbl ? KickKind.LOB_PASS : KickKind.GROUND_PASS, ft);
      GL.tx = q.x; GL.tz = q.z; GL.target = t;
    }
    aimAtTarget(p);
    return launchG(s, ctl, slot, ev);
  }
  if (!isSwipe(kind)) return Res.DROP;
  if (inOwnHalf(s, p)) {
    glReset(KickKind.CLEARANCE, ft);
    if (!swipeDir()) return Res.DROP;
    swipePower();
    return launchG(s, ctl, slot, ev);
  }
  let sk = kind === GestureKind.CURVED_SWIPE ? KickKind.SHOT_FINESSE
    : kind === GestureKind.BACK_FORTH_SWIPE ? KickKind.SHOT_POWER : KickKind.SHOT_NORMAL;
  // [FEEL-1] A curved swipe bending against his natural finesse curl (a right-footer's inside foot curls it left) is
  // the outside of the foot: a trivela.
  if (kind === GestureKind.CURVED_SWIPE) {
    const tc = T_FEEL.trivelaGestureCurve;
    if (s.attrs[slot]!.foot === Foot.LEFT ? GR.gCurve <= -tc : GR.gCurve >= tc) sk = KickKind.SHOT_TRIVELA;
  }
  glReset(sk, ft);
  if (!swipeDir()) return Res.DROP;
  const gxg = dir * HALF_LENGTH - p.x, gzg = -p.z;
  const gl = Math.sqrt(gxg * gxg + gzg * gzg);
  if (gl < 1e-6 || (GL.dirX * gxg + GL.dirZ * gzg) / gl < LT.swipeGoalCos) return Res.DROP;
  swipePower();
  if (kind === GestureKind.CURVED_SWIPE) GL.curve = GR.gCurve / 127;
  return launchG(s, ctl, slot, ev);
}

function keeperGesture(s: SimState, ctl: ControllerState, slot: number, ev: EventSink): number {
  const p = s.players[slot]!;
  if (p.stunT > 0 || (p.act !== ActionKind.NONE && p.act !== ActionKind.GK_HOLD)) return Res.RETRY;
  const kind = GR.kind;
  if (kind === GestureKind.TAP || kind === GestureKind.DOUBLE_TAP) {
    const t = tapTeammate(s, p);
    if (t < 0) return Res.DROP;
    const q = s.players[t]!;
    glReset(kind === GestureKind.TAP ? KickKind.GK_THROW : KickKind.GK_DROP_KICK, 0);
    GL.tx = q.x; GL.tz = q.z; GL.target = t;
    aimAtTarget(p);
    return launchG(s, ctl, slot, ev);
  }
  if (!isSwipe(kind)) return Res.DROP;
  glReset(KickKind.GK_DROP_KICK, 0);
  if (!swipeDir()) return Res.DROP;
  swipePower();
  return launchG(s, ctl, slot, ev);
}

function defenceGesture(s: SimState, c: number, ctl: ControllerState, slot: number, ev: EventSink): number {
  const p = s.players[slot]!;
  const b = s.ball;
  const kind = GR.kind;
  if (kind === GestureKind.TAP) {
    const k = s.teams[p.team]!.keeperSlot;
    const g = GR.gSlot;
    if ((GR.gFlags & GestureFlag.ON_OWN_KEEPER) !== 0 || (validSlot(k) && g === k)) {
      if (!validSlot(k) || s.players[k]!.active !== 1) return Res.DROP;
      return startKeeperRush(s, k, ev) === 1 ? Res.STARTED : Res.RETRY;
    }
    if (!validSlot(g) || g >= NUM_SLOTS) return Res.DROP;
    const q = s.players[g]!;
    if (g === b.owner && q.team !== p.team) {
      ctl.seqA |= SeqFlag.GPRESS | SeqFlag.SD_TIMED;
      ctl.seqB = s.tick + LT.gesturePressTicks;
      return Res.STARTED;
    }
    if (q.team === p.team && g !== slot) return manualSwitch(s, c, g, ev) ? Res.STARTED : Res.DROP;
    return Res.DROP;
  }
  if (kind === GestureKind.DOUBLE_TAP) {
    ctl.seqA |= SeqFlag.SD_TIMED;
    ctl.seqB = s.tick + LT.secondDefTapTicks;
    return Res.STARTED;
  }
  if (isSwipe(kind) && inOwnHalf(s, p)) {
    if (!prepareFree(s, slot)) return Res.RETRY;
    return startTackle(s, slot, ActionKind.SLIDE_TACKLE, -1, ev) === 1 ? Res.STARTED : Res.RETRY;
  }
  return Res.DROP;
}

/**
 * Resolve the gesture in the GR scratch record for controller c's player. A retry (buffered gesture) is dropped
 * when the context changed since the gesture.
 */
export function resolveGesture(s: SimState, c: number, ctl: ControllerState, retry: boolean, ev: EventSink): number {
  const slot = ctl.slot;
  if (!validSlot(slot) || s.players[slot]!.active !== 1 || GR.kind === GestureKind.NONE) return Res.DROP;
  const cls = controlContext(s, slot);
  if (retry && cls !== GR.cls) return Res.DROP;
  GR.cls = cls;
  if (cls === Ctx.KEEPER) return keeperGesture(s, ctl, slot, ev);
  if (cls === Ctx.ATTACK) return attackGesture(s, ctl, slot, ev);
  return defenceGesture(s, c, ctl, slot, ev);
}
