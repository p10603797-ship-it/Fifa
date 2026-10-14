/**
 * The deterministic fixed-step simulation (ARCHITECTURE rule 1). Lead-owned.
 * step(state, humanFrames, events) advances exactly one 1/60 s tick. Same seed + same input stream =>
 * bit-identical state hash in every engine. No Math.random, clocks, DOM or Three.js anywhere below here.
 */
import { NUM_SLOTS } from '../contracts/constants';
import { MatchPhase } from '../contracts/enums';
import type { EventBuffer } from '../contracts/events';
import type { InputFrame } from '../contracts/input';
import type { SimState } from '../contracts/state';
import { T_DRIBBLE, T_RULES } from '../contracts/tuning';
import { cpuThink } from '../ai/cpu';
import { teamAiTick } from '../ai';
import { resolveControllers } from './control/resolve';
import { actionsTick } from './actions/dispatch';
import { locomotionTick } from './players/locomotion';
import { bodyContactTick } from './players/bodies';
import { ballTick } from './ball/contact';
import { contactsTick } from './contacts';
import { rulesTick } from './rules/machine';
import { practiceRulesTick } from './rules/practice';
import { watchdogTick } from './rules/watchdog';

/** Squared T_RULES.ballLieSpeed, (m/s)^2. */
const LIE2 = T_RULES.ballLieSpeed * T_RULES.ballLieSpeed;

/**
 * Advance one tick. `humanFrames` has one InputFrame per human controller (MAX_HUMANS); entries for
 * controllers that are not humans are ignored, except that in a match with no HUMAN controller at all a Btn.SKIP
 * edge (or Command.SKIP) in humanFrames[0] skips the current cut-scene (headless soak fast-forward; RUL-01 reads it
 * via s.ctrl[0].buttons). Calls events.begin() itself.
 */
export function step(s: SimState, humanFrames: readonly InputFrame[], events: EventBuffer): void {
  s.tick++;
  events.begin(s.tick);
  const m = s.match;
  m.phaseT++;
  s.ball.cross = 0;
  cpuThink(s, events); // ai/cpu: CPU brains write their InputFrames
  resolveControllers(s, humanFrames, events); // SIM-15/16: frames -> intents, actions, switching
  teamAiTick(s, events); // ai: jobs/targets for every uncontrolled player, keepers
  actionsTick(s, events); // action state machines (kicks happen at contact ticks)
  locomotionTick(s, events); // SIM-04
  bodyContactTick(s, events); // SIM-05
  ballTick(s, events); // SIM-01/02/03 (+ line crossing)
  contactsTick(s, events); // keepers, aerials, tackles, interceptions, first touch, dribble
  rulesTick(s, events); // RUL-01..10
  practiceRulesTick(s, events); // QF-1 (from MOD-04): set-piece practice re-awards its restart; no-op outside practice
  watchdogTick(s, events); // RUL-11
  // [QF-1] ball.idleT counts the ticks the ball has LAIN untouched in play (BRIEF §5 "the ball lies unreachable or
  // untouched for 8 s"): horizontal speed below T_RULES.ballLieSpeed, or held in a keeper's hands. A long ball still rolling
  // or bouncing away with the chasers after it is not lying: counted from its first touch it fired the watchdog the
  // moment it stopped, a step ahead of the arriving chasers (fuzz seed 303 #33). [QF-1 skeptic] Nor is a ball a field
  // player owns: a standing owner leaves a still ball at his feet untouched (SIM-06), so it aged while he kept it, and
  // when he was knocked down 8+ s later the released ball fired BALL_UNTOUCHED on that very tick.
  const b = s.ball;
  if (b.owner >= 0 && b.heldBy < 0) b.idleT = 0;
  else if (m.phase === MatchPhase.IN_PLAY && b.touchedTick !== s.tick &&
    (b.heldBy >= 0 || b.vx * b.vx + b.vz * b.vz < LIE2)) b.idleT++;
  if (b.passTarget >= 0 && b.idleT >= T_RULES.passDeadTicks && b.owner < 0 && b.heldBy < 0) endDeadPass(s);
}

/** Squared T_DRIBBLE.controlRadius + T_RULES.passDeadReach, m^2. */
const DEAD_REACH2 = (T_DRIBBLE.controlRadius + T_RULES.passDeadReach) * (T_DRIBBLE.controlRadius + T_RULES.passDeadReach);

/**
 * [QF-1] A pass that died short of its receiver (the ball has lain T_RULES.passDeadTicks) while he is not closing in
 * on it is over: ball.passTarget clears. Its "our pass in flight" claims (SIM-16 forced ownership of the receiver,
 * which also blocks the manual switch; TAI-07's receiver chase claim, which bypasses arrival times) otherwise held
 * forever: a weak pass stopped 17 m from a receiver steered elsewhere, a teammate 4 m from it never went and the user
 * could not switch to him (fuzz seed 919 #14: BALL_UNTOUCHED). A receiver walking onto it (idle-stick meet run, AI
 * RECEIVE) keeps the pass until he takes it.
 */
function endDeadPass(s: SimState): void {
  const b = s.ball;
  const r = b.passTarget;
  if (r < NUM_SLOTS && (r | 0) === r) {
    const p = s.players[r]!;
    if (p.active === 1) {
      const dx = b.x - p.x, dz = b.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= DEAD_REACH2) return;
      const toward = p.vx * dx + p.vz * dz; // |v| cos * d
      if (toward > 0 && toward * toward >= LIE2 * d2) return;
    }
  }
  b.passTarget = -1;
}
