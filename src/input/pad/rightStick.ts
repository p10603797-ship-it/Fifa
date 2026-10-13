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

export function createRightStick(): RightStickTracker {
  const flickMag = T_INPUT.flickThreshold;
  const releaseMag = T_INPUT.flickThreshold * LOCAL_TUNING.releaseFrac;
  const holdMs = T_PAD.rsHoldMs;
  const seqMs = T_PAD.rsSequenceMs;
  const latchMs = LOCAL_TUNING.latchMaxMs;

  // Context.
  let facX = 1, facZ = 0;
  let rotCos = 1, rotSin = 0;
  let skillsOn = true;
  let heldBits = 0;
  let leftX = 0, leftY = 0;
  let lastNow = 0;

  // Right-stick stroke.
  let armed = true;
  let out = false;
  let outSince = 0;
  let lastOutMs = 0;
  let holding = false;
  let refX = 1, refZ = 0;
  let sector: number = RsSector.NONE;
  let first: number = RsSector.NONE;
  let second: number = RsSector.NONE;
  let transitions = 0;
  let roll = 0;
  let prevTheta = 0;
  let prevUx = 0, prevUz = 0;
  let spent = false;
  let strokeSprint = false;

  // Heel flick: a forward flick waiting for the back flick.
  let heelPending = false;
  let heelStart = 0;
  let heelX = 1, heelZ = 0;

  // Left stick (drag-back).
  let lArmed = true;
  let lOut = false;
  let lUx = 0, lUz = 0;

  // Latches.
  let flickLatched = false;
  let flickX = 0, flickZ = 0;
  let flickAt = 0;
  let flickReportedLast = false;
  let skill: SkillMove = SkillMove.NONE;
  let skillX = 0, skillZ = 0;
  let skillAt = 0;
  let lastSkillX = 0, lastSkillZ = 0;

  function emit(kind: SkillMove, dx: number, dz: number, now: number, fromRightStick: boolean): void {
    if (!skillsOn) return;
    if (fromRightStick && (strokeSprint || (heldBits & Btn.SPRINT) !== 0)) return;
    skill = kind;
    skillX = dx;
    skillZ = dz;
    skillAt = now;
    lastSkillX = dx;
    lastSkillZ = dz;
  }

  /** Side unit vector of the stroke's reference facing (RIGHT = facing rotated toward +z when facing +x). */
  function emitSide(kind: SkillMove, side: number, now: number): void {
    if (side === RsSector.RIGHT) emit(kind, -refZ, refX, now, true);
    else emit(kind, refZ, -refX, now, true);
  }

  function startStroke(ux: number, uz: number, now: number): void {
    out = true;
    outSince = now;
    lastOutMs = now;
    holding = holdMs <= 0;
    flickLatched = true;
    flickX = ux;
    flickZ = uz;
    flickAt = now;
    const heel = heelPending && now - heelStart <= seqMs;
    heelPending = false;
    if (heel) { refX = heelX; refZ = heelZ; } else { refX = facX; refZ = facZ; }
    const th = relativeAngle(ux, uz, refX, refZ);
    sector = sectorOf(th, RsSector.NONE);
    first = sector;
    second = RsSector.NONE;
    transitions = 0;
    roll = 0;
    prevTheta = th;
    prevUx = ux;
    prevUz = uz;
    spent = false;
    strokeSprint = (heldBits & Btn.SPRINT) !== 0;
    if (heel && sector === RsSector.BACK) {
      emit(SkillMove.HEEL_FLICK, refX, refZ, now, true);
      spent = true;
    }
    evaluate(now);
  }

  function endStroke(): void {
    const flick = lastOutMs - outSince < holdMs;
    if (!spent && transitions === 0 && flick) {
      if (isSide(first)) emitSide(SkillMove.BODY_FEINT, first, lastOutMs);
      else if (first === RsSector.FORWARD) {
        heelPending = true;
        heelStart = outSince;
        heelX = refX;
        heelZ = refZ;
      }
    }
    out = false;
    holding = false;
    sector = RsSector.NONE;
    spent = true;
  }

  function continueStroke(ux: number, uz: number, now: number): void {
    prevUx = ux;
    prevUz = uz;
    lastOutMs = now;
    const th = relativeAngle(ux, uz, refX, refZ);
    roll += wrapPi(th - prevTheta);
    prevTheta = th;
    const ns = sectorOf(th, sector);
    if (ns !== sector) {
      transitions++;
      if (transitions === 1) second = ns;
      sector = ns;
    }
    holding = now - outSince >= holdMs;
    evaluate(now);
  }

  /** Pattern state machine for the current stroke (called on every out sample). */
  function evaluate(now: number): void {
    if (spent) return;
    const dt = now - outSince;
    if (first === RsSector.FORWARD) {
      if (transitions === 0) return;
      if (transitions === 1 && isSide(sector) && dt <= seqMs) {
        if (sector === RsSector.RIGHT ? roll >= STEP_OVER_MIN : roll <= -STEP_OVER_MIN) {
          emitSide(SkillMove.STEP_OVER, sector, now);
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
          emitSide(SkillMove.ROULETTE, second, now);
          spent = true;
        }
        return;
      }
      spent = true;
    } else if (isSide(first)) {
      if (transitions > 0 || Math.abs(roll) > SIDE_DRIFT) { spent = true; return; }
      if (holding) {
        emitSide(SkillMove.BALL_ROLL, first, now);
        spent = true;
      }
    }
  }

  function rightStep(px: number, pz: number, now: number): void {
    let m = Math.sqrt(px * px + pz * pz);
    if (!Number.isFinite(m)) m = 0;
    if (!armed) {
      if (m < releaseMag) armed = true;
      return;
    }
    if (out) {
      if (m < releaseMag) { endStroke(); return; }
      const ux = px / m, uz = pz / m;
      if (ux * prevUx + uz * prevUz < THROUGH_COS) {
        endStroke();
        startStroke(ux, uz, now);
        return;
      }
      continueStroke(ux, uz, now);
    } else if (m >= flickMag) {
      startStroke(px / m, pz / m, now);
    }
  }

  function leftStep(px: number, pz: number, now: number): void {
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
      fresh = ux * lUx + uz * lUz < THROUGH_COS;
      lUx = ux;
      lUz = uz;
    } else if (m >= flickMag) {
      lOut = true;
      fresh = true;
      lUx = px / m;
      lUz = pz / m;
    }
    if (!fresh || (heldBits & BOTH_MODS) !== BOTH_MODS) return;
    const th = relativeAngle(lUx, lUz, facX, facZ);
    if (PI - Math.abs(th) <= DRAG_BACK_HALF) emit(SkillMove.DRAG_BACK, -facX, -facZ, now, false);
  }

  function writeDir(f: InputFrame, x: number, z: number): void {
    quantStick(x, z, qTmp);
    f.ax = qTmp.qx;
    f.az = qTmp.qy;
  }

  const api: RightStickTracker = {
    get skillDirX() { return lastSkillX; },
    get skillDirZ() { return lastSkillZ; },
    get sector() { return sector; },

    update(rx, ry, nowMs) {
      let now = Number.isFinite(nowMs) ? nowMs : lastNow;
      if (now < lastNow) now = lastNow;
      lastNow = now;
      const sx = Number.isFinite(rx) ? rx : 0, sy = Number.isFinite(ry) ? ry : 0;
      rightStep(rotCos * sx - rotSin * sy, rotSin * sx + rotCos * sy, now);
      const lx = leftX, ly = leftY;
      leftStep(rotCos * lx - rotSin * ly, rotSin * lx + rotCos * ly, now);
    },

    consume() {
      let bits = 0;
      if (flickLatched) {
        if (lastNow - flickAt > latchMs) flickLatched = false;
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
      leftX = 0;
      leftY = 0;
    },

    setLeft(lx, ly, buttons) {
      leftX = Number.isFinite(lx) ? lx : 0;
      leftY = Number.isFinite(ly) ? ly : 0;
      heldBits = buttons | 0;
    },

    updatePad(s, buttons, nowMs) {
      api.setLeft(s.lx, s.ly, buttons);
      api.update(s.rx, s.ry, nowMs);
    },

    setFacing(fx, fz) {
      const m = Math.sqrt(fx * fx + fz * fz);
      if (!(m > 1e-6) || !Number.isFinite(m)) return;
      facX = fx / m;
      facZ = fz / m;
    },

    setStickRotation(rot) {
      const r = Number.isFinite(rot) ? rot : 0;
      rotCos = r === 0 ? 1 : Math.cos(r);
      rotSin = r === 0 ? 0 : Math.sin(r);
    },

    setSkillsEnabled(on) {
      skillsOn = on;
    },

    setContext(ctx) {
      api.setStickRotation(ctx.projector ? ctx.projector.stickRotation() : 0);
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
      api.setFacing(fx, fz);
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
      if (k === SkillMove.NONE || lastNow - skillAt > latchMs) return SkillMove.NONE;
      return k;
    },

    applyTo(f) {
      const bits = api.consume();
      f.buttons |= bits;
      if ((bits & Btn.RS_FLICK) !== 0) {
        writeDir(f, flickX, flickZ);
        return;
      }
      if (skill === SkillMove.NONE) return;
      const k = api.consumeSkill();
      if (k !== SkillMove.NONE && f.skill === SkillMove.NONE) {
        f.skill = k;
        writeDir(f, skillX, skillZ);
      }
    },
  };
  return api;
}
