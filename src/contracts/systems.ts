/**
 * Interfaces between sim/ai modules. Lead-owned, frozen after Wave 0.
 *
 * The tick pipeline lives in src/sim/step.ts (lead). Every subsystem exposes plain functions with the
 * signatures below; the concrete file and owner of each function is listed in docs/OWNERSHIP.md and in
 * the header comment of each stub file.
 */

import type { AssistLevel, KickKind } from './enums';
import type { EventSink } from './events';
import type { InputFrame } from './input';
import type { SimState } from './state';

/** A whole-sim pipeline stage. */
export type SimSystem = (s: SimState, ev: EventSink) => void;
/** A per-team stage (ai). */
export type TeamSystem = (s: SimState, team: number, ev: EventSink) => void;

/**
 * An action state handler (one per ActionKind, registered in src/sim/actions/registry.ts).
 * The dispatcher increments p.actT before calling update(). When p.actT >= p.actDur (and the action
 * is not charging) the dispatcher calls end(s, slot, 0) and resets p.act to NONE.
 */
export interface ActionHandler {
  /** Per-tick update. Execute contact once when p.actT >= p.actContact && !p.actCharging && !p.actDone. */
  update(s: SimState, slot: number, ev: EventSink): void;
  /** Cleanup. interrupted = 1 when cut short (tackled, foul, phase change). Must leave the player free to move. */
  end(s: SimState, slot: number, interrupted: number): void;
}

/** Request flags for action starts. */
export const ReqFlag = {
  /** Strike the ball first time (no trap). */
  FIRST_TIME: 1 << 0,
  /** Pass and go: passer makes a forward run afterwards. */
  PASS_AND_GO: 1 << 1,
  /** Driven variant (R1 / swipe right). */
  DRIVEN: 1 << 2,
  /** Lofted / dinked variant (double-tap). */
  LOFTED: 1 << 3,
  /** Low driven shot (second tap during power-up). */
  LOW: 1 << 4,
  /** Request came from a gesture with an explicit target. */
  GESTURE: 1 << 5,
  /** Request issued by the CPU brain. */
  CPU: 1 << 6,
  /** Set-piece kick (free kick / corner / goal kick / penalty / kick-off / throw-in). */
  SET_PIECE: 1 << 7,
} as const;

/** Parameters for starting an action. Preallocated and reused; never retain a reference. */
export interface ActionRequest {
  /** 0..1 initial power (for explicit-power inputs); ignored while charging. */
  power: number;
  /** 1 = initiating button still held; the resolver raises p.actPower until release. */
  charging: number;
  /** Aim direction, pitch space (unit vector, or 0,0 for "facing"). */
  dirX: number;
  dirZ: number;
  /** Explicit target player (gesture / receiver lock), -1 = auto. */
  targetSlot: number;
  /** Explicit target point (gesture), valid when hasTarget = 1. */
  hasTarget: number;
  targetX: number;
  targetZ: number;
  /** -1..1 curl. */
  curve: number;
  assist: AssistLevel;
  /** ReqFlag bits. */
  flags: number;
}

export function createActionRequest(): ActionRequest {
  return { power: 0, charging: 0, dirX: 0, dirZ: 0, targetSlot: -1, hasTarget: 0, targetX: 0, targetZ: 0, curve: 0, assist: 0, flags: 0 };
}

export function clearActionRequest(r: ActionRequest): void {
  r.power = 0; r.charging = 0; r.dirX = 0; r.dirZ = 0; r.targetSlot = -1; r.hasTarget = 0; r.targetX = 0; r.targetZ = 0;
  r.curve = 0; r.assist = 0; r.flags = 0;
}

/** Ball launch computed by a kick solver at contact. */
export interface KickLaunch {
  vx: number; vy: number; vz: number;
  sx: number; sy: number; sz: number;
  kind: KickKind;
  /** Intended receiver slot or -1. */
  target: number;
  /** Intended reception / aim point. */
  tx: number; tz: number;
  /** 1 if a shot is on target as struck (for stats / keeper). */
  onTarget: number;
}

export function createKickLaunch(): KickLaunch {
  return { vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, kind: 0, target: -1, tx: 0, tz: 0, onTarget: 0 };
}

/**
 * Computes the launch for a kick of p.actKick from the player's action params (p.actPower, p.actDir*,
 * p.actSlot, p.actX/Z, p.actCurve, p.actA/B). Returns 1 on success, 0 if the kick cannot be made.
 * Must not modify state except reading the RNG (s.rng) for error.
 */
export type KickSolver = (s: SimState, slot: number, out: KickLaunch) => number;

/** Starts an action for a player. Returns 1 if started, 0 if refused (busy, out of reach, gated by skill stars...). */
export type ActionStarter = (s: SimState, slot: number, req: ActionRequest, ev: EventSink) => number;

/** Starts a kick-type action (KICK, SHOT, HEADER, VOLLEY, clearance, keeper release) of the given KickKind. 1 = started. */
export type KickStarter = (s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink) => number;

/**
 * Set-piece input routing: while a restart phase is active, the resolver hands each controller's frame
 * (already edge-tracked in s.ctrl[ctrlIdx]) to the restart-kind module. Taking team aims and kicks;
 * defending team moves the wall / keeper.
 */
export type SetPieceInputFn = (s: SimState, ctrlIdx: number, f: InputFrame, ev: EventSink) => void;

/** Predicted ball path (SIM-01 predictBall). Positions per tick, preallocated. */
export interface BallPrediction {
  /** Number of valid samples. */
  count: number;
  /** Sample i is the ball state after (i + 1) ticks. Length MAX_PREDICT_TICKS. */
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  /** First tick index where the ball centre is at or below the given height threshold after descending (landing), -1 none. */
  landIndex: number;
}

export const MAX_PREDICT_TICKS = 180;

export function createBallPrediction(): BallPrediction {
  return {
    count: 0, x: new Float64Array(MAX_PREDICT_TICKS), y: new Float64Array(MAX_PREDICT_TICKS), z: new Float64Array(MAX_PREDICT_TICKS),
    landIndex: -1,
  };
}

/** Per-difficulty AI parameter set returned by levelParams() [TAI-12]. */
export interface LevelParams {
  reactionTicks: number;
  decisionNoise: number;
  lookAheadTicks: number;
  executionError: number;
  pressIntensity: number;
  tackleTimingTicks: number;
  shotThresholdXg: number;
}

/** Weights by team style used by CPU option scoring [TAI-12]. */
export interface StyleWeights {
  /** Preference for short safe passes vs progress. */
  safety: number;
  progress: number;
  /** Through balls and runs in behind. */
  directness: number;
  /** Crosses / wide play. */
  width: number;
  /** Dribbling and skills. */
  dribble: number;
  /** Long shots. */
  longShot: number;
  /** Pressing height and intensity. */
  press: number;
  /** Counter-attack urgency after winning the ball. */
  counter: number;
}
