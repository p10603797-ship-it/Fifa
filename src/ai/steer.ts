/**
 * [TAI-07] Loose-ball assignment and arrival steering. assignChaser: exactly one player per team chases a free
 * ball (ball.owner === -1), chosen by arrival time (SIM-04 ticksToReach / SIM-01 predictBall interception point)
 * and re-evaluated with hysteresis (T_AI.chaserHysteresisTicks, chaserMinTicks) — never two teammates, never
 * nobody (team.chaser, CHASE_LOOSE job). A human-controlled player near the ball counts as his team's chaser.
 * executeJobs: converts every job-driven player's final job target into a movement intent (MoveMode.ARRIVE
 * with tgtSpeed; sprint when far/urgent; face the ball when holding position) without overriding players whose
 * action locks movement (moveMode LOCKED); calls jobs.finalizeJobT. Arrival behaviour must stop players on a
 * spot (no orbiting or jitter), including when the target moves slowly.
 */
import type { EventSink } from '../contracts/events';
import type { SimState } from '../contracts/state';

export function assignChaser(s: SimState, team: number, ev: EventSink): void { /* stub */ }
export function executeJobs(s: SimState, team: number, ev: EventSink): void { /* stub */ }
/** Set slot to arrive at (x, z) with speed cap (m/s), facing the ball when close. */
export function arrive(s: SimState, slot: number, x: number, z: number, speed: number): void { /* stub */ }
