/**
 * [PAD-05] Right-stick skill moves and directional switching (BRIEF section 10 "Movement and dribbling", "Defending").
 *
 * A recogniser over per-animation-frame stick samples. The sticks arrive dead-zoned in SCREEN space (PadSlot
 * convention: x right, y down) and are rotated into PITCH space with the camera's stick rotation (setContext /
 * setStickRotation; 0 for the broadcast camera, where screen and pitch axes coincide). Patterns are judged relative to
 * the controlled player's facing (players[ctrl[human].slot].fx/fz, read by setContext), frozen when a stroke starts.
 *
 * Output for the next InputFrame (applyTo):
 *  - Btn.RS_FLICK  edge: the right stick left the centre past T_INPUT.flickThreshold (a new stroke). On that sample
 *                  ax/az carry the flick direction (pitch-space unit vector x 127), even if the stick is already back
 *                  in the centre. The sim uses it for the directional switch in defence and, with SPRINT held, for the
 *                  knock-on. Two flicks are never reported on consecutive samples, so each one is a press edge.
 *  - Btn.RS_HOLD   held: the current stroke has stayed out for T_PAD.rsHoldMs.
 *  - skill         SkillMove edge; on that sample ax/az carry the move's direction (pitch space x 127): the side for a
 *                  body feint, ball roll, step-over and roulette (the side rolled through), forward for a heel flick,
 *                  back for a drag-back. A skill is never reported on the same sample as RS_FLICK (it waits one
 *                  sample), so ax/az always has one meaning.
 *
 * Patterns (a stroke = stick from the centre out past the flick threshold until it falls back below
 * releaseFrac x threshold; consecutive samples more than throughCentreDeg apart count as passing the centre):
 *  - BODY_FEINT   flick left or right: a stroke that starts in a side sector, stays there (within sideMaxDriftDeg of
 *                 its start: radial, not a sweep) and is released before rsHoldMs. Reported on release.
 *  - BALL_ROLL    hold left or right: the same stroke still out after rsHoldMs. Reported at the threshold.
 *  - STEP_OVER    roll from forward to a side: a stroke that starts forward and rolls (>= stepOverMinRollDeg) into a
 *                 side sector within rsSequenceMs of its start. Reported on reaching the side.
 *  - HEEL_FLICK   flick forward then back: a forward stroke released before rsHoldMs, then a stroke starting in the back
 *                 sector within rsSequenceMs of the first one's start (judged against the first stroke's facing).
 *  - ROULETTE     roll from back through a side to forward: back -> side -> forward within rsSequenceMs of the
 *                 stroke start, rolling >= rouletteMinRollDeg in a consistent direction.
 *  - DRAG_BACK    L1 + R1 (MOD_L + MOD_R) held + the LEFT stick flicked backward: the left stick leaves the centre
 *                 (or jumps through it) into the back sector (within dragBackHalfDeg of straight back).
 * Sectors are 90 degrees wide (forward, right, back, left; right = facing rotated toward +z when facing +x) with
 * sectorHysteresisDeg of hysteresis. One skill per stroke; a stroke that changes sector outside a pattern is spent.
 * With SPRINT held (knock-on: R2 + flick) the right stick produces no skill, only RS_FLICK.
 *
 * Skills are only produced while the context allows them (setContext): IN_PLAY, the controlled player is active,
 * the ball is not owned or held by the opponents and not in the controlled keeper's hands. In defence and at set
 * pieces the right stick still produces RS_FLICK / RS_HOLD (directional switch, curl, reticle, dives) but no skill.
 *
 * reset() (releaseAll: pause, blur, disconnect, possession swap) clears everything and ignores both sticks until
 * each has been seen back in the centre, so a held stick never produces a stale flick, hold or skill.
 *
 * Integration (PAD-02 mapper):
 *   pollFrame / readFrame(nowMs): rs.updatePad(slot, mapPadButtons(slot), nowMs)   // sticks + held Btn bits
 *   sample(out, ctx):             writeAimAxes(out, ...); rs.setContext(ctx); rs.applyTo(out)
 *   releaseAll():                 rs.reset()
 *
 * Device-side code (not sim): no allocation per frame; Math.atan2 / cos / sin are fine here.
 */

import { MatchPhase, SkillMove } from '../../contracts/enums';
import { Btn, type InputFrame, type InputSampleContext } from '../../contracts/input';
import { T_INPUT } from '../../contracts/tuning';
import { T_PAD } from '../../contracts/tuning';
import { quantStick } from '../axes';

const LOCAL_TUNING = {
  /** A stroke ends when the stick falls below this fraction of T_INPUT.flickThreshold (0..1, release hysteresis). */
  releaseFrac: 0.6,
  /** Angular hysteresis past a 45-degree sector boundary before the sector changes, degrees. */
  sectorHysteresisDeg: 15,
  /** Minimum roll from the stroke start for a step-over (forward -> side), degrees. */
  stepOverMinRollDeg: 45,
  /** Minimum roll from the stroke start for a roulette (back -> side -> forward), degrees. */
  rouletteMinRollDeg: 100,
  /** Consecutive out-of-centre samples further apart than this passed through the centre (new stroke), degrees. */
  throughCentreDeg: 120,
  /** A side flick / hold must stay within this angle of where it started (radial, not a sweep), degrees. */
  sideMaxDriftDeg: 30,
  /** Drag-back: the left-stick flick must be within this angle of straight back, degrees. */
  dragBackHalfDeg: 55,
  /** A latched flick or skill not reported within this time is dropped (sampling stopped, e.g. paused), ms. */
  latchMaxMs: 250,
} as const; // TUNING-CR

/** The LOCAL_TUNING block (read-only; tests and the lead's TUNING-CR review). */
export const RIGHT_STICK_TUNING = LOCAL_TUNING;

/** Stick sectors relative to the player's facing. */
export const RsSector = { NONE: -1, FORWARD: 0, RIGHT: 1, BACK: 2, LEFT: 3 } as const;

const PI = Math.PI;
const DEG = PI / 180;
const QUARTER = PI / 4;
const HYST = LOCAL_TUNING.sectorHysteresisDeg * DEG;
const STEP_OVER_MIN = LOCAL_TUNING.stepOverMinRollDeg * DEG;
const ROULETTE_MIN = LOCAL_TUNING.rouletteMinRollDeg * DEG;
const SIDE_DRIFT = LOCAL_TUNING.sideMaxDriftDeg * DEG;
const THROUGH_COS = Math.cos(LOCAL_TUNING.throughCentreDeg * DEG);
const DRAG_BACK_HALF = LOCAL_TUNING.dragBackHalfDeg * DEG;
const SECTOR_CENTRE: readonly number[] = [0, PI / 2, PI, -PI / 2];
const BOTH_MODS = Btn.MOD_L | Btn.MOD_R;

/** Wrap an angle to (-PI, PI]. */
function wrapPi(a: number): number {
  while (a > PI) a -= 2 * PI;
  while (a <= -PI) a += 2 * PI;
  return a;
}

/**
 * Sector of a facing-relative angle (radians, 0 = forward, +PI/2 = right, -PI/2 = left, +-PI = back) given the
 * current sector `prev` (RsSector.NONE for a fresh stroke): the current sector is kept until the angle is more than
 * sectorHysteresisDeg past its 45-degree boundary. Pure.
 */
export function sectorOf(theta: number, prev: number): number {
  if (prev >= 0 && prev <= 3 && Math.abs(wrapPi(theta - SECTOR_CENTRE[prev]!)) <= QUARTER + HYST) return prev;
  const a = Math.abs(theta);
  if (a <= QUARTER) return RsSector.FORWARD;
  if (a >= 3 * QUARTER) return RsSector.BACK;
  return theta > 0 ? RsSector.RIGHT : RsSector.LEFT;
}

/** Facing-relative angle of a unit pitch vector (ux, uz) for facing (fx, fz): 0 forward, +PI/2 right. Pure. */
export function relativeAngle(ux: number, uz: number, fx: number, fz: number): number {
  const fwd = ux * fx + uz * fz;
  const right = -ux * fz + uz * fx;
  return Math.atan2(right, fwd);
}

function isSide(sector: number): boolean {
  return sector === RsSector.RIGHT || sector === RsSector.LEFT;
}

export interface RightStickTracker {
  /**
   * Feed the dead-zoned right stick for this frame (screen space like PadSlot.rx/ry: x right, y down; rotated into
   * pitch space with the stick rotation from setContext / setStickRotation). Call once per animation frame.
   */
  update(rx: number, ry: number, nowMs: number): void;
  /**
   * Bits for the next sample: RS_FLICK once per flick (latched until reported; never on two consecutive samples),
   * RS_HOLD while held. Clears the flick latch when it reports it. Does not report the skill (see applyTo).
   */
  consume(): number;
  /** Clear all state; both sticks are ignored until seen back in the centre (releaseAll). */
  reset(): void;
  /**
   * Left stick (screen space, dead-zoned) and the Btn bits held this frame (MOD_L, MOD_R, SPRINT are read), used by
   * the next update(): drag-back (MOD_L + MOD_R + left stick flicked back) and the SPRINT knock-on gate.
   */
  setLeft(lx: number, ly: number, buttons: number): void;
  /** setLeft(s.lx, s.ly, buttons) + update(s.rx, s.ry, nowMs) for a pad slot. */
  updatePad(s: Readonly<PadSticks>, buttons: number, nowMs: number): void;
  /** Facing of the controlled player (pitch space; any length; ignored when zero or not finite). */
  setFacing(fx: number, fz: number): void;
  /** Camera stick rotation (radians, CameraProjector.stickRotation()); 0 = broadcast camera. */
  setStickRotation(rot: number): void;
  /** Allow or suppress skill edges (RS_FLICK / RS_HOLD are always produced). */
  setSkillsEnabled(on: boolean): void;
  /** Facing, stick rotation and the skill gate from the sample context (call in sample(), before applyTo). */
  setContext(ctx: InputSampleContext): void;
  /** Skill latched for the next sample (SkillMove.NONE if none or stale); clears it. Direction in skillDirX/Z. */
  consumeSkill(): SkillMove;
  /**
   * Write this sample's right-stick output into a frame: OR the RS bits into out.buttons; on a flick set ax/az to
   * the flick direction; otherwise, when a skill is latched and out.skill is NONE, set out.skill and ax/az to its
   * direction. Clears what it reports. Call after the mapper has written ax/az from the stick.
   */
  applyTo(out: InputFrame): void;
  /** Direction (pitch-space unit vector) of the last skill produced. */
  readonly skillDirX: number;
  readonly skillDirZ: number;
  /** Current right-stick sector relative to the stroke's facing (RsSector), NONE when centred (debug viewer). */
  readonly sector: number;
}

/** The stick fields of a PadSlot (src/input/pad/manager.ts). */
export interface PadSticks {
  lx: number; ly: number;
  rx: number; ry: number;
}

const qTmp = { qx: 0, qy: 0 };

/** [QF-7R] Slots of a tracker's double state (createRightStick: one Float64Array, no boxed closure doubles). */
const FAC_X = 0, FAC_Z = 1, ROT_COS = 2, ROT_SIN = 3, LEFT_X = 4, LEFT_Y = 5, LAST_NOW = 6, OUT_SINCE = 7, LAST_OUT_MS = 8,
  REF_X = 9, REF_Z = 10, ROLL = 11, PREV_THETA = 12, PREV_UX = 13, PREV_UZ = 14, HEEL_START = 15, HEEL_X = 16, HEEL_Z = 17,
  L_UX = 18, L_UZ = 19, FLICK_X = 20, FLICK_Z = 21, FLICK_AT = 22, SKILL_X = 23, SKILL_Z = 24, SKILL_AT = 25,
  LAST_SKILL_X = 26, LAST_SKILL_Z = 27,
  /** Call registers: the update's time (ms), unit stick direction, pitch-space stick, relative angle. */
  NOW = 28, UX = 29, UZ = 30, PX = 31, PZ = 32, TH = 33, RX_IN = 34, RY_IN = 35, N_SIZE = 36;

/** sectorOf(n[TH], prev) for the tracker's registers (no double crosses a call). */
function sectorIn(n: Float64Array, prev: number): number {
  const theta = n[TH]!;
  if (prev >= 0 && prev <= 3) {
    let d = theta - SECTOR_CENTRE[prev]!; // wrapPi
    while (d > PI) d -= 2 * PI;
    while (d <= -PI) d += 2 * PI;
    if (Math.abs(d) <= QUARTER + HYST) return prev;
  }
  const a = Math.abs(theta);
  if (a <= QUARTER) return RsSector.FORWARD;
  if (a >= 3 * QUARTER) return RsSector.BACK;
  return theta > 0 ? RsSector.RIGHT : RsSector.LEFT;
}

export function createRightStick(): RightStickTracker {
  const flickMag = T_INPUT.flickThreshold;
  const releaseMag = T_INPUT.flickThreshold * LOCAL_TUNING.releaseFrac;
  const holdMs = T_PAD.rsHoldMs;
  const seqMs = T_PAD.rsSequenceMs;
  const latchMs = LOCAL_TUNING.latchMaxMs;

  // [QF-7R] Every double of the tracker lives in N (named slots below), not in closure variables: V8 boxes a non-integer
  // double into a new heap number on every store to a closure variable, and the facing (setContext, every sample), the
  // clock (every update) and analogue stick values are always fractional in play (~5 boxes per frame per pad).
  // Doubles also never cross the internal calls (in N: NOW, UX / UZ); integers and booleans stay in variables.
  const N = new Float64Array(N_SIZE);
  N[FAC_X] = 1; N[ROT_COS] = 1; N[REF_X] = 1; N[HEEL_X] = 1;

  // Context.
  let skillsOn = true;
  let heldBits = 0;

  // Right-stick stroke.
  let armed = true;
  let out = false;
  let holding = false;
  let sector: number = RsSector.NONE;
  let first: number = RsSector.NONE;
  let second: number = RsSector.NONE;
  let transitions = 0;
  let spent = false;
  let strokeSprint = false;

  // Heel flick: a forward flick waiting for the back flick.
  let heelPending = false;

  // Left stick (drag-back).
  let lArmed = true;
  let lOut = false;

  // Latches.
  let flickLatched = false;
  let flickReportedLast = false;
  let skill: SkillMove = SkillMove.NONE;

  /** update(): the right stick in N[RX_IN], N[RY_IN] (screen space), the left one in N[LEFT_X], N[LEFT_Y]. */
  function step(nowMs: number): void {
    let now = Number.isFinite(nowMs) ? nowMs : N[LAST_NOW]!;
    if (now < N[LAST_NOW]!) now = N[LAST_NOW]!;
    N[LAST_NOW] = now;
    N[NOW] = now;
    const rx = N[RX_IN]!, ry = N[RY_IN]!;
    const sx = Number.isFinite(rx) ? rx : 0, sy = Number.isFinite(ry) ? ry : 0;
    const c = N[ROT_COS]!, sn = N[ROT_SIN]!;
    N[PX] = c * sx - sn * sy; N[PZ] = sn * sx + c * sy;
    rightStep();
    const lx = N[LEFT_X]!, ly = N[LEFT_Y]!;
    N[PX] = c * lx - sn * ly; N[PZ] = sn * lx + c * ly;
    leftStep();
  }

  /** Skill direction codes for emit (doubles never cross a call: the vector is built from N inside). */
  const DIR_RIGHT = 0, DIR_LEFT = 1, DIR_REF = 2, DIR_BACK = 3;

  /**
   * Latch a skill: direction `dir` (DIR_RIGHT / DIR_LEFT: the side of the stroke's reference facing; DIR_REF: along
   * it; DIR_BACK: straight back from the facing), at N[NOW] or, `atLastOut`, at the stroke's last out sample.
   */
  function emit(kind: SkillMove, dir: number, fromRightStick: boolean, atLastOut: boolean): void {
    if (!skillsOn) return;
    if (fromRightStick && (strokeSprint || (heldBits & Btn.SPRINT) !== 0)) return;
    let dx: number, dz: number;
    if (dir === DIR_RIGHT) { dx = -N[REF_Z]!; dz = N[REF_X]!; } else if (dir === DIR_LEFT) { dx = N[REF_Z]!; dz = -N[REF_X]!; } else if (dir === DIR_REF) { dx = N[REF_X]!; dz = N[REF_Z]!; } else { dx = -N[FAC_X]!; dz = -N[FAC_Z]!; }
    skill = kind;
    N[SKILL_X] = dx;
    N[SKILL_Z] = dz;
    N[SKILL_AT] = atLastOut ? N[LAST_OUT_MS]! : N[NOW]!;
    N[LAST_SKILL_X] = dx;
    N[LAST_SKILL_Z] = dz;
  }

  /** Side of the stroke's reference facing (RIGHT = facing rotated toward +z when facing +x). */
  function emitSide(kind: SkillMove, side: number, atLastOut: boolean): void {
    emit(kind, side === RsSector.RIGHT ? DIR_RIGHT : DIR_LEFT, true, atLastOut);
  }

  /** A new stroke toward the unit direction N[UX], N[UZ] at N[NOW]. */
  function startStroke(): void {
    const ux = N[UX]!, uz = N[UZ]!, now = N[NOW]!;
    out = true;
    N[OUT_SINCE] = now;
    N[LAST_OUT_MS] = now;
    holding = holdMs <= 0;
    flickLatched = true;
    N[FLICK_X] = ux;
    N[FLICK_Z] = uz;
    N[FLICK_AT] = now;
    const heel = heelPending && now - N[HEEL_START]! <= seqMs;
    heelPending = false;
    if (heel) { N[REF_X] = N[HEEL_X]!; N[REF_Z] = N[HEEL_Z]!; } else { N[REF_X] = N[FAC_X]!; N[REF_Z] = N[FAC_Z]!; }
    const rx = N[REF_X]!, rz = N[REF_Z]!;
    const th = Math.atan2(-ux * rz + uz * rx, ux * rx + uz * rz); // relativeAngle(ux, uz, refX, refZ)
    N[TH] = th;
    sector = sectorIn(N, RsSector.NONE);
    first = sector;
    second = RsSector.NONE;
    transitions = 0;
    N[ROLL] = 0;
    N[PREV_THETA] = th;
    N[PREV_UX] = ux;
    N[PREV_UZ] = uz;
    spent = false;
    strokeSprint = (heldBits & Btn.SPRINT) !== 0;
    if (heel && sector === RsSector.BACK) {
      emit(SkillMove.HEEL_FLICK, DIR_REF, true, false);
      spent = true;
    }
    evaluate();
  }

  function endStroke(): void {
    const flick = N[LAST_OUT_MS]! - N[OUT_SINCE]! < holdMs;
    if (!spent && transitions === 0 && flick) {
      if (isSide(first)) emitSide(SkillMove.BODY_FEINT, first, true);
      else if (first === RsSector.FORWARD) {
        heelPending = true;
        N[HEEL_START] = N[OUT_SINCE]!;
        N[HEEL_X] = N[REF_X]!;
        N[HEEL_Z] = N[REF_Z]!;
      }
    }
    out = false;
    holding = false;
    sector = RsSector.NONE;
    spent = true;
  }

  /** The stroke goes on toward N[UX], N[UZ] at N[NOW]. */
  function continueStroke(): void {
    const ux = N[UX]!, uz = N[UZ]!, now = N[NOW]!;
    N[PREV_UX] = ux;
    N[PREV_UZ] = uz;
    N[LAST_OUT_MS] = now;
    const rx = N[REF_X]!, rz = N[REF_Z]!;
    const th = Math.atan2(-ux * rz + uz * rx, ux * rx + uz * rz); // relativeAngle(ux, uz, refX, refZ)
    let d = th - N[PREV_THETA]!; // wrapPi(th - prevTheta)
    while (d > PI) d -= 2 * PI;
    while (d <= -PI) d += 2 * PI;
    N[ROLL] = N[ROLL]! + d;
    N[PREV_THETA] = th;
    N[TH] = th;
    const ns = sectorIn(N, sector);
    if (ns !== sector) {
      transitions++;
      if (transitions === 1) second = ns;
      sector = ns;
    }
    holding = now - N[OUT_SINCE]! >= holdMs;
    evaluate();
  }

  /** Pattern state machine for the current stroke (called on every out sample, at N[NOW]). */
  function evaluate(): void {
    if (spent) return;
    const dt = N[NOW]! - N[OUT_SINCE]!;
    const roll = N[ROLL]!;
    if (first === RsSector.FORWARD) {
      if (transitions === 0) return;
      if (transitions === 1 && isSide(sector) && dt <= seqMs) {
        if (sector === RsSector.RIGHT ? roll >= STEP_OVER_MIN : roll <= -STEP_OVER_MIN) {
          emitSide(SkillMove.STEP_OVER, sector, false);
          spent = true;
        }
        return;
      }
      spent = true;
    } else if (first === RsSector.BACK) {
      if (dt > seqMs) { spent = true; return; }
      if (transitions === 0) return;
      if (transitions === 1 && isSide(sector)) return;
      if (transitions === 2 && sector === RsSector.FORWARD && isSide(second)) {
        // Back -> right -> forward turns the relative angle down from +-PI to 0; back -> left -> forward turns it up.
        if (second === RsSector.RIGHT ? roll <= -ROULETTE_MIN : roll >= ROULETTE_MIN) {
          emitSide(SkillMove.ROULETTE, second, false);
          spent = true;
        }
        return;
      }
      spent = true;
    } else if (isSide(first)) {
      if (transitions > 0 || Math.abs(roll) > SIDE_DRIFT) { spent = true; return; }
      if (holding) {
        emitSide(SkillMove.BALL_ROLL, first, false);
        spent = true;
      }
    }
  }

  /** Right stick in pitch space N[PX], N[PZ] at N[NOW]. */
  function rightStep(): void {
    const px = N[PX]!, pz = N[PZ]!;
    let m = Math.sqrt(px * px + pz * pz);
    if (!Number.isFinite(m)) m = 0;
    if (!armed) {
      if (m < releaseMag) armed = true;
      return;
    }
    if (out) {
      if (m < releaseMag) { endStroke(); return; }
      const ux = px / m, uz = pz / m;
      N[UX] = ux; N[UZ] = uz;
      if (ux * N[PREV_UX]! + uz * N[PREV_UZ]! < THROUGH_COS) {
        endStroke();
        startStroke();
        return;
      }
      continueStroke();
    } else if (m >= flickMag) {
      N[UX] = px / m; N[UZ] = pz / m;
      startStroke();
    }
  }

  /** Left stick in pitch space N[PX], N[PZ] at N[NOW]. */
  function leftStep(): void {
    const px = N[PX]!, pz = N[PZ]!;
    let m = Math.sqrt(px * px + pz * pz);
    if (!Number.isFinite(m)) m = 0;
    if (!lArmed) {
      if (m < releaseMag) lArmed = true;
      return;
    }
    let fresh = false;
    if (lOut) {
      if (m < releaseMag) { lOut = false; return; }
      const ux = px / m, uz = pz / m;
      fresh = ux * N[L_UX]! + uz * N[L_UZ]! < THROUGH_COS;
      N[L_UX] = ux;
      N[L_UZ] = uz;
    } else if (m >= flickMag) {
      lOut = true;
      fresh = true;
      N[L_UX] = px / m;
      N[L_UZ] = pz / m;
    }
    if (!fresh || (heldBits & BOTH_MODS) !== BOTH_MODS) return;
    const ux = N[L_UX]!, uz = N[L_UZ]!, fx = N[FAC_X]!, fz = N[FAC_Z]!;
    const th = Math.atan2(-ux * fz + uz * fx, ux * fx + uz * fz); // relativeAngle(lUx, lUz, facX, facZ)
    if (PI - Math.abs(th) <= DRAG_BACK_HALF) emit(SkillMove.DRAG_BACK, DIR_BACK, false, false);
  }

  function writeDir(f: InputFrame, x: number, z: number): void {
    quantStick(x, z, qTmp);
    f.ax = qTmp.qx;
    f.az = qTmp.qy;
  }

  const api: RightStickTracker = {
    get skillDirX() { return N[LAST_SKILL_X]!; },
    get skillDirZ() { return N[LAST_SKILL_Z]!; },
    get sector() { return sector; },

    update(rx, ry, nowMs) {
      N[RX_IN] = rx; N[RY_IN] = ry;
      step(nowMs);
    },

    consume() {
      let bits = 0;
      if (flickLatched) {
        if (N[LAST_NOW]! - N[FLICK_AT]! > latchMs) flickLatched = false;
        else if (!flickReportedLast) {
          bits |= Btn.RS_FLICK;
          flickLatched = false;
        }
      }
      flickReportedLast = (bits & Btn.RS_FLICK) !== 0;
      if (out && holding) bits |= Btn.RS_HOLD;
      return bits;
    },

    reset() {
      armed = false;
      lArmed = false;
      out = false;
      lOut = false;
      holding = false;
      sector = RsSector.NONE;
      first = RsSector.NONE;
      second = RsSector.NONE;
      transitions = 0;
      spent = true;
      heelPending = false;
      flickLatched = false;
      flickReportedLast = false;
      skill = SkillMove.NONE;
      heldBits = 0;
      N[LEFT_X] = 0;
      N[LEFT_Y] = 0;
    },

    setLeft(lx, ly, buttons) {
      N[LEFT_X] = Number.isFinite(lx) ? lx : 0;
      N[LEFT_Y] = Number.isFinite(ly) ? ly : 0;
      heldBits = buttons | 0;
    },

    updatePad(s, buttons, nowMs) {
      // setLeft(s.lx, s.ly, buttons) + update(s.rx, s.ry, nowMs) without passing the doubles through calls.
      const lx = s.lx, ly = s.ly;
      N[LEFT_X] = Number.isFinite(lx) ? lx : 0;
      N[LEFT_Y] = Number.isFinite(ly) ? ly : 0;
      heldBits = buttons | 0;
      N[RX_IN] = s.rx; N[RY_IN] = s.ry;
      step(nowMs);
    },

    setFacing(fx, fz) {
      const m = Math.sqrt(fx * fx + fz * fz);
      if (!(m > 1e-6) || !Number.isFinite(m)) return;
      N[FAC_X] = fx / m;
      N[FAC_Z] = fz / m;
    },

    setStickRotation(rot) {
      const r = Number.isFinite(rot) ? rot : 0;
      N[ROT_COS] = r === 0 ? 1 : Math.cos(r);
      N[ROT_SIN] = r === 0 ? 0 : Math.sin(r);
    },

    setSkillsEnabled(on) {
      skillsOn = on;
    },

    setContext(ctx) {
      // setStickRotation / setFacing written out (no double crosses a call).
      const rot = ctx.projector ? ctx.projector.stickRotation() : 0;
      const r = Number.isFinite(rot) ? rot : 0;
      N[ROT_COS] = r === 0 ? 1 : Math.cos(r);
      N[ROT_SIN] = r === 0 ? 0 : Math.sin(r);
      const st = ctx.state;
      const ctl = st.ctrl[ctx.human];
      const slot = ctl ? ctl.slot : -1;
      const p = slot >= 0 ? st.players[slot] : undefined;
      let fx = 0, fz = 0;
      if (p) { fx = p.fx; fz = p.fz; }
      if (!(fx * fx + fz * fz > 1e-12) || !Number.isFinite(fx) || !Number.isFinite(fz)) {
        const team = st.teams[ctx.side];
        fx = team && team.dir < 0 ? -1 : 1;
        fz = 0;
      }
      const fm = Math.sqrt(fx * fx + fz * fz);
      if (fm > 1e-6 && Number.isFinite(fm)) { N[FAC_X] = fx / fm; N[FAC_Z] = fz / fm; }
      let on = !!p && p.active === 1 && st.match.phase === MatchPhase.IN_PLAY;
      if (on && p) {
        const b = st.ball;
        const holder = b.heldBy >= 0 ? b.heldBy : b.owner;
        if (b.heldBy === slot) on = false;
        else if (holder >= 0) {
          const h = st.players[holder];
          if (!h || h.team !== p.team) on = false;
        }
      }
      skillsOn = on;
    },

    consumeSkill() {
      const k = skill;
      skill = SkillMove.NONE;
      if (k === SkillMove.NONE || N[LAST_NOW]! - N[SKILL_AT]! > latchMs) return SkillMove.NONE;
      return k;
    },

    applyTo(f) {
      const bits = api.consume();
      f.buttons |= bits;
      if ((bits & Btn.RS_FLICK) !== 0) {
        writeDir(f, N[FLICK_X]!, N[FLICK_Z]!);
        return;
      }
      if (skill === SkillMove.NONE) return;
      const k = api.consumeSkill();
      if (k !== SkillMove.NONE && f.skill === SkillMove.NONE) {
        f.skill = k;
        writeDir(f, N[SKILL_X]!, N[SKILL_Z]!);
      }
    },
  };
  return api;
}
