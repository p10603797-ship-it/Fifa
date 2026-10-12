/**
 * [SIM-04] Locomotion: 360-degree analogue movement with acceleration, deceleration and a turn rate that
 * tightens at low speed; sprint (heavier touches, wider turns); jockey/strafe movement facing a look target;
 * shielding speed; stamina drain and recovery and its effect on speed/accel (section 6 "Players").
 * Top speed 7.0-9.6 m/s from pace attributes; jog ~60%. Consumes the movement intent written by the
 * resolver / AI (moveMode, ix/iz, tgtX/tgtZ/tgtSpeed, wantSprint, lookAt) and writes x, z, vx, vz, fx, fz,
 * sprinting, jockeying, stamina. Players never pass the advertising boards (BOARD_X / BOARD_Z).
 * WAVE 0 BASELINE: simple velocity approach, no turn rates or stamina. SIM-04 replaces it.
 */
import { BOARD_X, BOARD_Z, DT, NUM_SLOTS } from '../../contracts/constants';
import type { EventSink } from '../../contracts/events';
import { T_PLAYER } from '../../contracts/tuning';
import { MoveMode, type PlayerAttrs, type PlayerState, type SimState } from '../../contracts/state';

/** Top sprint speed m/s from attributes (sprintSpeed mostly, acceleration a little). */
export function topSpeedFor(a: Readonly<PlayerAttrs>): number {
  const t = Math.max(0, Math.min(1, (a.sprintSpeed - 1) / 98));
  return T_PLAYER.topSpeedMin + (T_PLAYER.topSpeedMax - T_PLAYER.topSpeedMin) * t;
}
/** Acceleration m/s^2 from attributes. */
export function accelFor(a: Readonly<PlayerAttrs>): number {
  const t = Math.max(0, Math.min(1, (a.acceleration - 1) / 98));
  return T_PLAYER.accelMin + (T_PLAYER.accelMax - T_PLAYER.accelMin) * t;
}
/** Multiplier (<= 1) on speed/accel/accuracy from current stamina. */
export function staminaFactor(p: Readonly<PlayerState>): number {
  return 1;
}
/** Current max speed for a slot given sprint state and stamina (m/s). */
export function maxSpeed(s: SimState, slot: number, sprint: boolean): number {
  const top = s.attrs[slot]!.topSpeed;
  return sprint ? top : top * T_PLAYER.jogFraction;
}
/**
 * Estimated ticks for `slot` to reach (x, z) from its current position and velocity at full sprint,
 * including turning and acceleration. Used by loose-ball chasing, receivers, keepers and AI. Pure.
 */
export function ticksToReach(s: SimState, slot: number, x: number, z: number): number {
  const p = s.players[slot]!;
  const dx = x - p.x, dz = z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  return Math.ceil((d / Math.max(1, s.attrs[slot]!.topSpeed)) * 60);
}

export function locomotionTick(s: SimState, ev: EventSink): void {
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    let dvx = 0, dvz = 0;
    if (p.moveMode === MoveMode.DIRECT) {
      const sp = maxSpeed(s, i, p.wantSprint === 1);
      dvx = p.ix * sp; dvz = p.iz * sp;
    } else if (p.moveMode === MoveMode.ARRIVE) {
      const dx = p.tgtX - p.x, dz = p.tgtZ - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > T_PLAYER.arriveStop) {
        const sp = Math.min(p.tgtSpeed, p.tgtSpeed * (d / T_PLAYER.arriveRadius));
        dvx = (dx / d) * sp; dvz = (dz / d) * sp;
      }
    }
    const a = s.attrs[i]!.accel * DT;
    const ddx = dvx - p.vx, ddz = dvz - p.vz;
    const dd = Math.sqrt(ddx * ddx + ddz * ddz);
    if (dd <= a) { p.vx = dvx; p.vz = dvz; } else { p.vx += (ddx / dd) * a; p.vz += (ddz / dd) * a; }
    p.x += p.vx * DT; p.z += p.vz * DT;
    if (p.x > BOARD_X) p.x = BOARD_X; else if (p.x < -BOARD_X) p.x = -BOARD_X;
    if (p.z > BOARD_Z) p.z = BOARD_Z; else if (p.z < -BOARD_Z) p.z = -BOARD_Z;
    const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
    if (p.lookAt === 1) {
      const lx = p.lookX - p.x, lz = p.lookZ - p.z;
      const ll = Math.sqrt(lx * lx + lz * lz);
      if (ll > 0.01) { p.fx = lx / ll; p.fz = lz / ll; }
    } else if (sp > 0.3) { p.fx = p.vx / sp; p.fz = p.vz / sp; }
    p.sprinting = p.wantSprint === 1 && sp > 0.5 ? 1 : 0;
  }
}
