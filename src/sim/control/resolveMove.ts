/**
 * [SIM-15] Movement intent of the controlled player (section 10 Movement and dribbling, Defending; section 9 touch
 * rules), written every IN_PLAY tick unless an action has locked movement (MoveMode.LOCKED):
 *  - stick -> MoveMode.DIRECT (ix, iz) (released below T_INPUT.stickIdle), SPRINT -> wantSprint;
 *  - attack with the ball: SHIELD held -> shield (look at the nearest opponent; SIM-05 runs the SHIELD action),
 *    MOD_L held -> strafe dribble (face the attacked goal; touch "double-tap and hold the stick" maps to MOD_L),
 *    MOD_R held -> controlled sprint (sprint at LT.controlledSprintScale of the stick);
 *  - attack, intended receiver of our pass with the stick released -> moves to meet the ball (ctrl.receiver);
 *  - [QF-1] the team's loose-ball chaser with the stick released for T_IDLE_CHASE.stickIdleTicks while the ball has lain
 *    T_IDLE_CHASE.ballLieTicks -> walks (jog) to the ball;
 *  - defence: PASS held -> contain (shadow the carrier LT.containDist goal-side), SHIELD held -> jockey (face the
 *    carrier; + SPRINT = sprint jockey), SPRINT held with the stick released near the carrier (or a gesture press)
 *    -> press him, stick moving near the carrier without sprint while goal-side -> automatic jockey.
 * Writes only intent fields (moveMode, ix, iz, tgtX/Z, tgtSpeed, wantSprint, lookAt, lookX/Z) and ctrl.receiver.
 * Speeds written to tgtSpeed are caps from attrs (top / jog); SIM-04 applies stamina.
 * Hot path: every value is computed into locals and written once at the end, no doubles cross a call boundary (V8
 * boxes those), so the stage allocates nothing.
 */
import { BOARD_X, BOARD_Z, HALF_LENGTH } from '../../contracts/constants';
import { ActionKind } from '../../contracts/enums';
import { Btn } from '../../contracts/input';
import { MoveMode, type ControllerState, type PlayerState, type SimState } from '../../contracts/state';
import { T_IDLE_CHASE, T_PLAYER, T_TOUCH } from '../../contracts/tuning';
import { canManualSwitch } from './switching';
import { Ctx, LT, MEET, SeqFlag, ballEta, clampMeetTarget, meetPoint, oppCarrier, validSlot } from './resolveShared';

const TGT_MAX_X = BOARD_X - 1;
const TGT_MAX_Z = BOARD_Z - 1;

/** Nearest active opponent of p within LT.shieldLookDist, or -1. */
function nearestOpponent(s: SimState, p: Readonly<PlayerState>): number {
  const first = p.team === 0 ? 11 : 0;
  let best = -1;
  let bestD = LT.shieldLookDist * LT.shieldLookDist;
  for (let i = first; i < first + 11; i++) {
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Movement intent for controller c's player p in context cls (IN_PLAY). */
export function moveTick(s: SimState, c: number, ctl: ControllerState, p: PlayerState, cls: number): void {
  ctl.receiver = -1;
  if (p.act !== ActionKind.NONE && p.moveMode === MoveMode.LOCKED) return;
  const slot = p.slot;
  const btn = ctl.buttons;
  const sprint = (btn & Btn.SPRINT) !== 0;
  const idle = ctl.stickIdleT > 0;
  let ix = idle ? 0 : ctl.mx;
  let iz = idle ? 0 : ctl.mz;
  let want = sprint ? 1 : 0;
  let arrive = false;
  let tx = 0, tz = 0, tsp = 0;
  let look = false;
  let lx = 0, lz = 0;
  const b = s.ball;
  const top = s.attrs[slot]!.topSpeed;
  const jog = top * T_PLAYER.jogFraction;
  if (cls === Ctx.KEEPER) {
    want = 0;
  } else if (idle && ctl.stickIdleT >= T_IDLE_CHASE.stickIdleTicks && b.owner < 0 && b.heldBy < 0 &&
    b.idleT >= T_IDLE_CHASE.ballLieTicks && b.y <= T_IDLE_CHASE.maxBallHeight && s.teams[p.team]!.chaser === slot &&
    !(b.passTarget === slot && b.lastTouchTeam === p.team)) {
    // [QF-1 skeptic] His team's loose-ball chaser, the ball lying still, the stick left alone: walk to the ball (the
    // receiver of our pass keeps his meet run below).
    arrive = true;
    tx = b.x; tz = b.z; tsp = jog;
  } else if (idle && b.owner < 0 && b.heldBy < 0 && (p.act === ActionKind.KICK || p.act === ActionKind.SHOT) &&
    p.actDone === 0 && !(b.passTarget === slot && b.lastTouchTeam === p.team) && ballEta(s, slot) >= 0) {
    // [QF-9 skeptic] A first-time kick (a clearance, a shot or pass of a loose ball) wound up for a ball still on its
    // way, the stick left alone: meet the ball's path as the idle receiver of our pass does (below). He used to coast on
    // his last run (DIRECT, no intent) off the ball's line while it came, and the kick whiffed (a defender running
    // diagonally onto a 14-20 m/s ball, SHOOT pressed to clear: the ball passed 0.96 m from his kicking spot).
    meetPoint(s, slot, 0);
    arrive = true;
    tx = MEET.x; tz = MEET.z; tsp = MEET.speed;
    look = true; lx = b.x; lz = b.z; // facing the ball, so it comes to the kicking spot in front of him
  } else if (cls === Ctx.ATTACK) {
    if (b.owner === slot && b.heldBy < 0) {
      if ((btn & Btn.SHIELD) !== 0) {
        want = 0;
        const o = nearestOpponent(s, p);
        if (o >= 0) { look = true; lx = s.players[o]!.x; lz = s.players[o]!.z; }
      } else if ((btn & Btn.MOD_L) !== 0 && !canManualSwitch(s, c)) {
        want = 0;
        look = true;
        lx = s.teams[p.team]!.dir * HALF_LENGTH;
        lz = 0;
      } else if ((btn & Btn.MOD_R) !== 0 && !sprint) {
        ix *= LT.controlledSprintScale;
        iz *= LT.controlledSprintScale;
        want = ix !== 0 || iz !== 0 ? 1 : 0;
      }
    } else if (idle && b.owner < 0 && b.heldBy < 0 && b.passTarget === slot && b.lastTouchTeam === p.team) {
      // Intended receiver of our pass: meet the ball until the user steers him.
      meetPoint(s, slot, sprint ? 1 : 0);
      arrive = true;
      tx = MEET.x; tz = MEET.z; tsp = MEET.speed;
      // [INT-A trailing] A ball rolling away from him: aim past the meeting point along its path (no arrival braking
      // short of it) and run at least at the ball's pace (sprinting when that is above jog speed).
      const bv = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
      const ahead = (b.x - p.x) * b.vx + (b.z - p.z) * b.vz;
      if (bv > T_TOUCH.meetOvershootMinSpeed && ahead > 0) {
        let o = bv * T_TOUCH.meetOvershootSec;
        if (o < T_TOUCH.meetOvershootMin) o = T_TOUCH.meetOvershootMin;
        if (o > T_TOUCH.meetOvershootMax) o = T_TOUCH.meetOvershootMax;
        tx += (b.vx / bv) * o;
        tz += (b.vz / bv) * o;
        if (ahead / bv > T_TOUCH.meetCatchDist) { tsp = top; want = 1; }
        // [QF-13] ... but not over the line after a ball rolling out.
        MEET.x = tx; MEET.z = tz;
        clampMeetTarget();
        tx = MEET.x; tz = MEET.z;
      }
      ctl.receiver = slot;
    }
  } else {
    const carrier = oppCarrier(s, p.team);
    if (validSlot(carrier)) {
      const q = s.players[carrier]!;
      const ownGoalX = -s.teams[p.team]!.dir * HALF_LENGTH;
      let gx = ownGoalX - q.x, gz = -q.z;
      const gl = Math.sqrt(gx * gx + gz * gz);
      if (gl > 1e-6) { gx /= gl; gz /= gl; } else { gx = 0; gz = 0; }
      const dx = p.x - q.x, dz = p.z - q.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const gpress = (ctl.seqA & SeqFlag.GPRESS) !== 0 && s.tick <= ctl.seqB;
      if ((btn & Btn.PASS) !== 0) {
        // Contain: shadow the carrier goal-side at containDist, facing him, at least at his pace.
        const qs = Math.sqrt(q.vx * q.vx + q.vz * q.vz) * 1.05;
        let sp = sprint ? top : qs > jog ? qs : jog;
        if (sp > top) sp = top;
        arrive = true;
        tx = q.x + gx * LT.containDist; tz = q.z + gz * LT.containDist; tsp = sp;
        want = sp > jog ? 1 : 0;
        look = true; lx = q.x; lz = q.z;
      } else if (idle && (gpress || (sprint && dist < LT.sprintPressDist))) {
        arrive = true;
        tx = q.x + gx * LT.pressDist; tz = q.z + gz * LT.pressDist; tsp = top;
        want = 1;
      } else if ((btn & Btn.SHIELD) !== 0) {
        look = true; lx = q.x; lz = q.z; // jockey; with SPRINT = sprint jockey
      } else if (!idle && !sprint && dist < LT.autoJockeyDist && dx * gx + dz * gz > 0) {
        look = true; lx = q.x; lz = q.z;
      }
    }
  }
  p.wantSprint = want;
  if (arrive) {
    p.moveMode = MoveMode.ARRIVE;
    p.tgtX = tx < -TGT_MAX_X ? -TGT_MAX_X : tx > TGT_MAX_X ? TGT_MAX_X : tx;
    p.tgtZ = tz < -TGT_MAX_Z ? -TGT_MAX_Z : tz > TGT_MAX_Z ? TGT_MAX_Z : tz;
    p.tgtSpeed = tsp;
  } else {
    p.moveMode = MoveMode.DIRECT;
  }
  p.ix = ix;
  p.iz = iz;
  if (look) {
    p.lookAt = 1;
    p.lookX = lx;
    p.lookZ = lz;
  } else {
    p.lookAt = 0;
  }
}
