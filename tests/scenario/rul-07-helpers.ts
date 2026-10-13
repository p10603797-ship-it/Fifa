/**
 * RUL-07 test helpers: a shoot-out started the real way (Shoot-out mode: PRE_MATCH -> RUL-01 -> shootoutStart),
 * stepping to a sub-state, and scripted kicks (a launch through core/kick applyKick by the shoot-out kicker, the way a
 * SIM-11 shot would strike) with a known outcome.
 */
import { BALL_RADIUS, HALF_LENGTH } from '../../src/contracts/constants';
import { KickKind, MatchPhase, ModeId } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { createKickLaunch } from '../../src/contracts/systems';
import { T_BALL } from '../../src/contracts/tuning';
import { applyKick } from '../../src/sim/core/kick';
import { NULL_SINK } from '../../src/sim/core/events';
import { ShootoutSub, shootoutEnd } from '../../src/sim/rules/shootout';
import { makeScenario, runTicks, runUntil, type ScenarioHuman, type ScenarioInputs } from '../harness/scenario';

export type Outcome = 'goal' | 'wide' | 'over' | 'soft';

/** Shoot-out mode started through RUL-01 (PRE_MATCH -> SHOOT_OUT). */
export function shootoutScenario(seed: number, humans: number | ScenarioHuman[] = 0): SimState {
  const s = makeScenario({ seed, humans, config: { mode: ModeId.SHOOT_OUT, startPhase: MatchPhase.SHOOT_OUT } });
  const { reached } = runUntil(s, (st) => st.match.phase === MatchPhase.SHOOT_OUT, 400);
  if (!reached) throw new Error('shoot-out did not start');
  return s;
}

/** Step until the shoot-out is in `sub` (optionally for `team`), collecting events. */
export function untilSub(s: SimState, sub: number, max = 3000, inputs?: ScenarioInputs, team = -1): SimEvent[] {
  const so = s.match.shootout;
  if (so.sub === sub && (team < 0 || so.team === team)) return [];
  const { events, reached } = runUntil(s, (st) => (st.match.shootout.sub === sub && (team < 0 || st.match.shootout.team === team)) ||
    st.match.phase === MatchPhase.POST_MATCH, max, inputs, 'core');
  if (!reached) throw new Error(`sub-state ${sub} not reached (sub ${so.sub}, tick ${s.tick})`);
  return events;
}

/** Strike the current kick now (from the spot) with a known outcome; side = +-1 picks the half of the goal. */
export function strike(s: SimState, outcome: Outcome, side = 1): void {
  const so = s.match.shootout;
  const end = shootoutEnd(s);
  const b = s.ball;
  let tx = end * (HALF_LENGTH + 0.5);
  let ty = 1.2;
  let tz = side * 2.5;
  let v = 24;
  if (outcome === 'goal' && so.keeper >= 0) s.players[so.keeper]!.z = -side * 2.9; // keeper well away from the shot
  if (outcome === 'wide') tz = side * 6.5;
  if (outcome === 'over') { ty = 4.5; tz = side * 1.0; }
  if (outcome === 'soft') { v = 3.5; ty = BALL_RADIUS; tz = side * 0.8; tx = end * HALF_LENGTH; }
  const dx = tx - b.x, dz = tz - b.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const tf = d / v;
  const l = createKickLaunch();
  l.vx = (dx / d) * v;
  l.vz = (dz / d) * v;
  l.vy = outcome === 'soft' ? 0 : (ty - b.y) / tf + 0.5 * T_BALL.gravity * tf;
  l.kind = KickKind.PENALTY;
  l.target = -1;
  l.tx = tx;
  l.tz = tz;
  l.onTarget = outcome === 'goal' ? 1 : 0;
  applyKick(s, so.kicker, l, 0.8, NULL_SINK);
}

/** Play the next kick (of `team` if given; other kicks on the way are struck as goals) with `outcome`; returns its
 *  SHOOTOUT_KICK event and every event since the call. */
export function playKick(s: SimState, outcome: Outcome, side = 1): { kick: SimEvent; events: SimEvent[] } {
  const events = untilSub(s, ShootoutSub.AIM);
  if (s.match.phase !== MatchPhase.SHOOT_OUT) throw new Error('the shoot-out is over');
  strike(s, outcome, side);
  const so = s.match.shootout;
  const team = so.team;
  const taken = so.taken[team]!;
  const r = runUntil(s, (st) => st.match.shootout.taken[team]! > taken, 1200, undefined, 'core');
  if (!r.reached) throw new Error(`kick not decided (sub ${so.sub}, tick ${s.tick})`);
  events.push(...r.events);
  const kicks = events.filter((e) => e.type === EventType.SHOOTOUT_KICK);
  return { kick: kicks[kicks.length - 1]!, events };
}

/** Play kicks with these outcomes in order (alternating teams as the shoot-out does). */
export function playKicks(s: SimState, outcomes: readonly Outcome[]): SimEvent[] {
  const all: SimEvent[] = [];
  for (const o of outcomes) all.push(...playKick(s, o).events);
  return all;
}

/** Run until POST_MATCH (or max ticks). */
export function untilPostMatch(s: SimState, max = 2000, inputs?: ScenarioInputs): SimEvent[] {
  const { events } = runUntil(s, (st) => st.match.phase === MatchPhase.POST_MATCH, max, inputs, 'core');
  return events;
}

export { runTicks };
