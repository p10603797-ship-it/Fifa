/**
 * [TAI-09] CPU pass, cross and through-ball evaluation: for each teammate, completion chance (lanes vs
 * opponents' reach using SIM-04 ticksToReach and SIM-01 prediction), progress, danger created; through-ball
 * lead points (SIM-10), cross targets (SIM-09). Allocation-free; results in a caller-provided array.
 */
import type { KickKind } from '../../contracts/enums';
import type { SimState } from '../../contracts/state';

export interface PassOption {
  target: number;
  kind: KickKind;
  x: number;
  z: number;
  /** 0..1 */
  completion: number;
  /** metres gained toward goal */
  progress: number;
  /** 0..1 */
  danger: number;
  score: number;
}

export function createPassOptions(n: number): PassOption[] {
  return Array.from({ length: n }, () => ({ target: -1, kind: 0, x: 0, z: 0, completion: 0, progress: 0, danger: 0, score: 0 }));
}

/** Fill out[] with options for the carrier; returns the number written. */
export function scorePassOptions(s: SimState, slot: number, out: PassOption[]): number { return 0; }
/** Completion probability of a ground/aerial ball from (x0,z0) to (x1,z1) at speed for the passing team. Pure. */
export function laneSafety(s: SimState, team: number, x0: number, z0: number, x1: number, z1: number, speed: number, lofted: number): number { return 0; }
