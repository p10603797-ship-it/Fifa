/**
 * Sim events (ARCHITECTURE rule 4): each tick emits events; audio, HUD, effects, camera, stats,
 * rumble and the net/replay layers consume them and never change sim state.
 *
 * Events are flat numeric records written into a preallocated buffer (no allocation per tick).
 * Lead-owned, frozen after Wave 0. Append new types at the end.
 */

export enum EventType {
  /** a = slot, b = KickKind, c = power 0..1, x/y/z = ball position. */
  KICK = 0,
  /** c = impact speed m/s. */
  BOUNCE = 1,
  /** a = end (-1/+1), b = 0 post / 1 crossbar, c = impact speed. */
  POST = 2,
  /** a = end (-1/+1), c = ball speed. Ball entered the net volume. */
  NET = 3,
  /** a = WhistleKind. */
  WHISTLE = 4,
  /** a = offender slot, b = victim slot, c = ChallengeOutcome, d = 1 if in the penalty area. */
  FOUL = 5,
  /** a = slot, b = CardKind. */
  CARD = 6,
  /** a = offside slot, x/z = restart spot. */
  OFFSIDE = 7,
  /** a = keeper slot, b = SaveKind, c = shot speed. */
  SAVE = 8,
  /** a = scoring team, b = scorer slot, c = assist slot (-1), d = 1 own goal. */
  GOAL = 9,
  /** a = team, b = out slot, c = in roster index. */
  SUBSTITUTION = 10,
  /** a = from MatchPhase, b = to MatchPhase. */
  PHASE_CHANGE = 11,
  /** a = tackler, b = victim, c = 1 won the ball / 0 missed, d = ChallengeKind. */
  TACKLE = 12,
  /** a = slot that intercepted, b = passer slot. */
  INTERCEPT = 13,
  /** a = shooter slot, b = 1 on target, c = expected-goal estimate 0..1. Emitted at contact. */
  SHOT = 14,
  /** a = RestartKind, b = team awarded, x/z = spot. Ball went out / restart awarded. */
  RESTART_AWARDED = 15,
  /** a = 1 started / 0 ended (played on) / 2 brought back, b = fouled team. */
  ADVANTAGE = 16,
  /** a = team that forfeits. */
  FORFEIT = 17,
  /** a = new possessing team (-1 loose). */
  POSSESSION = 18,
  /** a = WatchdogReason. */
  WATCHDOG = 19,
  /** a = Period ended. */
  PERIOD_END = 20,
  /** a = shooter slot, c = miss distance m. Shot missed narrowly (crowd). */
  NEAR_MISS = 21,
  /** a = slot, b = SkillMove. */
  SKILL = 22,
  /** a = slot, b = 1 header / 0 volley. */
  AERIAL = 23,
  /** a = receiving slot, b = passer slot. Pass completed to a teammate. */
  PASS_COMPLETE = 24,
  /** a = old slot, b = new slot, c = controller index. Human/CPU switched player. */
  SWITCH = 25,
  /** a = slot (keeper), b = 1 pick-up / 0 release. */
  KEEPER_HANDS = 26,
  /** a = team attacking, c = intensity 0..1 (build-up in the final third, for crowd). */
  ATTACK_BUILD = 27,
  /** a = slot, b = 1 body contact shove (for audio). */
  BODY_CONTACT = 28,
  /** a = team, b = Command applied. */
  TACTIC = 29,
  /** a = slot. Wall jumped / charged. */
  WALL = 30,
  /** a = team, b = kick index, c = 1 scored. */
  SHOOTOUT_KICK = 31,
}

export enum WhistleKind {
  SHORT = 0,
  /** Kick-off / restart. */
  START = 1,
  /** Half time / full time (long). */
  LONG = 2,
  /** Final whistle (three blasts). */
  FINAL = 3,
}

export interface SimEvent {
  type: EventType;
  tick: number;
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
  z: number;
}

/** Write side, used inside sim. Implemented by sim/core/events.ts (FND-03). */
export interface EventSink {
  /** Append an event for the current tick. Unused params default to 0. Never allocates. */
  emit(type: EventType, a?: number, b?: number, c?: number, d?: number, x?: number, y?: number, z?: number): void;
}

/** Read side, used by consumers after each tick. */
export interface EventBuffer extends EventSink {
  /** Events emitted during the most recent tick. Valid until the next begin(). */
  readonly count: number;
  get(i: number): Readonly<SimEvent>;
  /** Start a new tick: clears the buffer. */
  begin(tick: number): void;
}

/** Max events per tick (buffer capacity). Overflow drops extra events and counts them. */
export const MAX_EVENTS_PER_TICK = 64;
