/**
 * Off-ball job blackboard. Lead-owned.
 * Each tick resetJobs() gives every AI-driven outfield player (p.ctrl === -1, not the keeper, active) the
 * HOLD_SHAPE job at his home position; modules then call assignJob(), which only overrides a job of lower or
 * equal priority (AiJob enum order). TAI-07 executeJobs() turns the final job into a movement intent.
 */
import { AiJob } from '../contracts/enums';
import type { SimState } from '../contracts/state';
import { NUM_SLOTS } from '../contracts/constants';
import { teamEnd, teamStart } from '../sim/core/query';

const LOCAL_TUNING = { // TUNING-CR (INT-A): HOLD_SHAPE speed by distance from home
  /** Speed cap as a fraction of top speed near home (a jog, T_PLAYER.jogFraction) and far from it. */
  holdJogFraction: 0.6,
  holdFarFraction: 0.92,
  /** Distance from home below which he jogs / beyond which he runs at holdFarFraction, m. */
  holdNearDist: 4,
  holdFarDist: 12,
} as const;

/** Previous tick's job per slot (derived scratch, rebuilt every tick; not state). */
const prevJob = new Int32Array(NUM_SLOTS);

/** True if slot is driven by team AI jobs (active outfield player without a controller). */
export function isJobDriven(s: SimState, slot: number): boolean {
  const p = s.players[slot]!;
  return p.active === 1 && p.ctrl === -1 && p.isKeeper === 0;
}

export function resetJobs(s: SimState, team: number): void {
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    const p = s.players[i]!;
    prevJob[i] = p.job;
    if (!isJobDriven(s, i)) { p.job = AiJob.NONE; continue; }
    p.job = AiJob.HOLD_SHAPE;
    p.jobSlot = -1;
    p.tgtX = p.homeX;
    p.tgtZ = p.homeZ;
    p.tgtSpeed = holdShapeSpeed(s.attrs[i]!.topSpeed, p.homeX - p.x, p.homeZ - p.z);
  }
}

/**
 * HOLD_SHAPE speed cap (m/s): a jog near the home spot, rising to LOCAL_TUNING.holdFarFraction of top speed when far
 * from it, so a team that wins the ball pushes up (and one that loses it drops back) in time instead of jogging
 * 20 m behind its shape [INT-A].
 */
export function holdShapeSpeed(top: number, dx: number, dz: number): number {
  const d = Math.sqrt(dx * dx + dz * dz);
  const k = d <= LOCAL_TUNING.holdNearDist ? 0
    : d >= LOCAL_TUNING.holdFarDist ? 1 : (d - LOCAL_TUNING.holdNearDist) / (LOCAL_TUNING.holdFarDist - LOCAL_TUNING.holdNearDist);
  return top * (LOCAL_TUNING.holdJogFraction + (LOCAL_TUNING.holdFarFraction - LOCAL_TUNING.holdJogFraction) * k);
}

/**
 * Give slot a job with a target point, speed cap (m/s) and optional target slot. Returns true if applied
 * (job priority >= current). Ignored for players not driven by jobs.
 */
export function assignJob(s: SimState, slot: number, job: AiJob, x: number, z: number, speed: number, targetSlot: number): boolean {
  if (!isJobDriven(s, slot)) return false;
  const p = s.players[slot]!;
  if (job < p.job) return false;
  p.job = job;
  p.tgtX = x;
  p.tgtZ = z;
  p.tgtSpeed = speed;
  p.jobSlot = targetSlot;
  return true;
}

/** Update jobT (ticks the player has held the same job). Called by executeJobs. */
export function finalizeJobT(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  p.jobT = prevJob[slot] === p.job ? p.jobT + 1 : 0;
}
