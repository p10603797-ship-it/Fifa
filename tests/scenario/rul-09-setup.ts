/**
 * RUL-09 test helpers: a quiet IN_PLAY scene (everyone parked near his own goal line, ball loose at the centre),
 * placement helpers, challenge records, and a direct foulsTick stepper that collects events.
 */
import { NUM_SLOTS, PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { ChallengeKind, CrossKind, MatchPhase } from '../../src/contracts/enums';
import type { EventType, SimEvent } from '../../src/contracts/events';
import type { ChallengeRecord, SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { foulsTick } from '../../src/sim/rules/fouls';
import { makeScenario, type ScenarioHuman } from '../harness/scenario';

export const EVB = createEventBuffer(128);

export interface FoulSceneOpts {
  fouls?: number;
  seed?: number;
  humans?: number | ScenarioHuman[];
  /** Second-half directions (team 0 attacks -x). */
  swap?: boolean;
}

/** Attack-frame x of a team (u = dir * x; the goal it attacks is at u = +52.5). */
export function xOf(s: SimState, team: number, u: number): number {
  return s.teams[team]!.dir * u;
}

export function put(s: SimState, slot: number, x: number, z: number): void {
  const p = s.players[slot]!;
  p.x = x; p.z = z; p.vx = 0; p.vz = 0;
}

/** Put a player at attack-frame (u, z) of his own team. */
export function putU(s: SimState, slot: number, u: number, z: number): void {
  put(s, slot, xOf(s, s.players[slot]!.team, u), z);
}

export function foulScene(o: FoulSceneOpts = {}): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: o.seed ?? 7, config: { fouls: o.fouls ?? 1 }, humans: o.humans ?? 0 });
  if (o.swap) { s.teams[0]!.dir = -1; s.teams[1]!.dir = 1; }
  s.tick = 100;
  for (let slot = 0; slot < NUM_SLOTS; slot++) {
    const i = slot % PLAYERS_PER_TEAM;
    const p = s.players[slot]!;
    if (i === 0) putU(s, slot, -51, 0);
    else putU(s, slot, -44 + (i % 3) * 3, -30 + i * 5.5);
    p.fx = s.teams[p.team]!.dir; p.fz = 0;
  }
  const b = s.ball;
  b.x = 0; b.y = 0.11; b.z = 0; b.px = 0; b.py = 0.11; b.pz = 0; b.vx = 0; b.vy = 0; b.vz = 0;
  b.owner = -1; b.heldBy = -1; b.lastTouch = -1; b.lastTouchTeam = -1; b.lastTouchTick = -1;
  b.lastKickBy = -1; b.lastKickTeam = -1; b.lastKickTick = -1; b.shotBy = -1; b.passTarget = -1;
  return s;
}

/** Give the ball to slot (at his feet), as a touch this tick. */
export function give(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const b = s.ball;
  b.x = p.x + 0.4 * s.teams[p.team]!.dir; b.z = p.z; b.y = 0.11; b.px = b.x; b.pz = b.z;
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.owner = slot; b.heldBy = -1; b.lastTouch = slot; b.lastTouchTeam = p.team; b.lastTouchTick = s.tick;
  p.lastTouchTick = s.tick;
}

/** Loose ball at (x, z), last touched by `slot` (-1 none) at the current tick. */
export function loose(s: SimState, x: number, z: number, slot: number): void {
  const b = s.ball;
  b.x = x; b.z = z; b.y = 0.11; b.px = x; b.pz = z; b.vx = 0; b.vy = 0; b.vz = 0;
  b.owner = -1; b.heldBy = -1;
  b.lastTouch = slot; b.lastTouchTeam = slot >= 0 ? s.players[slot]!.team : -1; b.lastTouchTick = slot >= 0 ? s.tick : -1;
  if (slot >= 0) s.players[slot]!.lastTouchTick = s.tick;
}

export interface ChallengeOpts {
  tackler: number;
  victim: number;
  kind?: ChallengeKind;
  ballFirst?: number;
  fromBehind?: number;
  closingSpeed?: number;
  /** Record index (default the first free one). */
  i?: number;
}

/** Write an active challenge record (x/z = the victim's position, tick = the next tick). */
export function challenge(s: SimState, o: ChallengeOpts): ChallengeRecord {
  const recs = s.match.challenges;
  let i = o.i ?? -1;
  if (i < 0) for (let k = 0; k < recs.length; k++) if (recs[k]!.active === 0) { i = k; break; }
  const r = recs[i]!;
  const v = s.players[o.victim]!;
  r.active = 1; r.tackler = o.tackler; r.victim = o.victim; r.kind = o.kind ?? ChallengeKind.STAND;
  r.ballFirst = o.ballFirst ?? 0; r.fromBehind = o.fromBehind ?? 0; r.closingSpeed = o.closingSpeed ?? 3;
  r.x = v.x; r.z = v.z; r.tick = s.tick + 1;
  return r;
}

function copy(e: Readonly<SimEvent>): SimEvent {
  return { type: e.type, tick: e.tick, a: e.a, b: e.b, c: e.c, d: e.d, x: e.x, y: e.y, z: e.z };
}

/**
 * One tick of foulsTick alone: tick++, ball.cross cleared (as step() does), `before` runs (set up this tick's ball
 * state / crossing / buttons), then foulsTick. Returns this tick's events.
 */
export function tickFouls(s: SimState, before?: (s: SimState) => void): SimEvent[] {
  s.tick++;
  s.ball.cross = CrossKind.NONE;
  if (before) before(s);
  EVB.begin(s.tick);
  foulsTick(s, EVB);
  const out: SimEvent[] = [];
  for (let i = 0; i < EVB.count; i++) out.push(copy(EVB.get(i)));
  return out;
}

/** Run n ticks of foulsTick, collecting every event. */
export function runFouls(s: SimState, n: number, before?: (s: SimState, k: number) => void): SimEvent[] {
  const all: SimEvent[] = [];
  for (let k = 0; k < n; k++) all.push(...tickFouls(s, before ? (st) => before(st, k) : undefined));
  return all;
}

export function ofType(evs: readonly SimEvent[], type: EventType): SimEvent[] {
  return evs.filter((e) => e.type === type);
}
