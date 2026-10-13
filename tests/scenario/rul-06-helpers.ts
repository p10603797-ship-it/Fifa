/**
 * RUL-06 test helpers: a penalty awarded the real way (RUL-11 awardRestart from IN_PLAY, as RUL-09 does for a foul in
 * the area), stepping to ready, and a scripted strike by the taker through core/kick applyKick (the way a SIM-11 shot
 * strikes at its contact tick) toward a chosen point.
 */
import {
  BALL_RADIUS, HALF_LENGTH, NUM_SLOTS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PENALTY_SPOT_DIST,
} from '../../src/contracts/constants';
import { KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import type { SimEvent } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { createKickLaunch } from '../../src/contracts/systems';
import { T_BALL } from '../../src/contracts/tuning';
import { applyKick } from '../../src/sim/core/kick';
import { createEventBuffer } from '../../src/sim/core/events';
import { awardRestart } from '../../src/sim/rules/restart';
import {
  makeScenario, runTicks, runUntil, type ScenarioHuman, type ScenarioInputs, type ScenarioOptions,
} from '../harness/scenario';

export interface PenaltyOptions {
  seed?: number;
  /** Team awarded the penalty. */
  team?: number;
  /** Attack direction of the awarded team (+1 / -1); the other team gets the opposite. */
  dir?: number;
  humans?: number | ScenarioHuman[];
  /** Ticks of open play before the award (players spread out by the AI). */
  warmup?: number;
  players?: ScenarioOptions['players'];
  match?: ScenarioOptions['match'];
  config?: ScenarioOptions['config'];
  /** Called on the state right before the award (attribute / position overrides). */
  before?: (s: SimState) => void;
}

/** A match in IN_PLAY with a PENALTY awarded to `team` (RUL-11 awardRestart, foul spot inside the area). */
export function penaltyScenario(o: PenaltyOptions = {}): { s: SimState; awardEvents: SimEvent[] } {
  const team = o.team ?? 0;
  const dir = o.dir ?? (team === 0 ? 1 : -1);
  const s = makeScenario({
    seed: o.seed ?? 11, phase: MatchPhase.IN_PLAY, humans: o.humans ?? 0, players: o.players, match: o.match,
    config: o.config, teams: team === 0 ? [{ dir }, { dir: -dir }] : [{ dir: -dir }, { dir }],
  });
  if (o.warmup) runTicks(s, o.warmup);
  if (o.before) o.before(s);
  const buf = createEventBuffer();
  buf.begin(s.tick);
  awardRestart(s, RestartKind.PENALTY, team, dir * (HALF_LENGTH - 6), 4, buf);
  const awardEvents: SimEvent[] = [];
  for (let i = 0; i < buf.count; i++) awardEvents.push({ ...buf.get(i) });
  return { s, awardEvents };
}

/** Step until restart.ready (the setup delay, camera cut). */
export function untilReady(s: SimState, inputs?: ScenarioInputs): SimEvent[] {
  const { events, reached } = runUntil(s, (st) => st.match.restart.ready === 1, 400, inputs, 'core');
  if (!reached) throw new Error(`penalty never ready (phase ${s.match.phase}, t ${s.match.restart.t})`);
  return events;
}

/** Penalty mark x of the end `team` attacks. */
export function spotX(s: SimState, team: number): number {
  return s.teams[team]!.dir * (HALF_LENGTH - PENALTY_SPOT_DIST);
}

/** Strike the penalty now from the spot by the taker toward (tx, ty at the goal line, tz) at speed v (m/s). */
export function strike(s: SimState, tz: number, ty = 1.0, v = 24, txBeyond = 0.5): void {
  const r = s.match.restart;
  const t = r.taker;
  if (t < 0 || t >= NUM_SLOTS) throw new Error('no taker');
  const dir = s.teams[r.team]!.dir;
  const b = s.ball;
  const tx = dir * (HALF_LENGTH + txBeyond);
  const dx = tx - b.x, dz = tz - b.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const tf = d / v;
  const l = createKickLaunch();
  l.vx = (dx / d) * v;
  l.vz = (dz / d) * v;
  l.vy = (ty - BALL_RADIUS) / tf + 0.5 * T_BALL.gravity * tf;
  l.kind = KickKind.PENALTY;
  l.target = -1;
  l.tx = tx;
  l.tz = tz;
  l.onTarget = 1;
  applyKick(s, t, l, 0.8, { emit() { /* scripted */ } });
}

/** Is (x, z) inside the penalty area of the end `team` attacks (lines included)? */
export function inArea(s: SimState, team: number, x: number, z: number): boolean {
  const ex = s.teams[team]!.dir * x;
  return ex >= HALF_LENGTH - PENALTY_AREA_DEPTH && ex <= HALF_LENGTH && z >= -PENALTY_AREA_HALF_WIDTH &&
    z <= PENALTY_AREA_HALF_WIDTH;
}
