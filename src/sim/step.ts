/**
 * The deterministic fixed-step simulation (ARCHITECTURE rule 1). Lead-owned.
 * step(state, humanFrames, events) advances exactly one 1/60 s tick. Same seed + same input stream =>
 * bit-identical state hash in every engine. No Math.random, clocks, DOM or Three.js anywhere below here.
 */
import { MatchPhase } from '../contracts/enums';
import type { EventBuffer } from '../contracts/events';
import type { InputFrame } from '../contracts/input';
import type { SimState } from '../contracts/state';
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
  if (m.phase === MatchPhase.IN_PLAY && s.ball.touchedTick !== s.tick) s.ball.idleT++;
}
