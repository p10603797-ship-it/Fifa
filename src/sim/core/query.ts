/**
 * Shared read-only queries over SimState. Lead-owned (FND-03 tests). Allocation-free.
 */
import { HALF_LENGTH, NUM_SLOTS, PLAYERS_PER_TEAM, teamFirstSlot } from '../../contracts/constants';
import { ControllerKind } from '../../contracts/enums';
import type { SimState } from '../../contracts/state';

export function otherTeam(team: number): number { return team === 0 ? 1 : 0; }
export function teamStart(team: number): number { return teamFirstSlot(team); }
/** One past the last slot of a team. */
export function teamEnd(team: number): number { return teamFirstSlot(team) + PLAYERS_PER_TEAM; }

export function isActive(s: SimState, slot: number): boolean {
  return slot >= 0 && slot < NUM_SLOTS && s.players[slot]!.active === 1;
}

/** Attack direction of a team (+1 toward +x). */
export function teamDir(s: SimState, team: number): number { return s.teams[team]!.dir; }
/** x of the goal line the team attacks. */
export function attackGoalX(s: SimState, team: number): number { return s.teams[team]!.dir * HALF_LENGTH; }
/** x of the goal line the team defends. */
export function defendGoalX(s: SimState, team: number): number { return -s.teams[team]!.dir * HALF_LENGTH; }
/** Distance from x to the goal line the team attacks (>= 0 on the pitch). */
export function distToAttackLine(s: SimState, team: number, x: number): number { return HALF_LENGTH - s.teams[team]!.dir * x; }
/** Progress of x for a team: -1 own goal line .. +1 opposition goal line. */
export function progressX(s: SimState, team: number, x: number): number { return (s.teams[team]!.dir * x) / HALF_LENGTH; }

/** Team in possession (ball owner's team), -1 if loose. */
export function possessingTeam(s: SimState): number {
  const o = s.ball.owner;
  return o >= 0 ? s.players[o]!.team : -1;
}

export function distToBall(s: SimState, slot: number): number {
  const p = s.players[slot]!;
  const dx = s.ball.x - p.x, dz = s.ball.z - p.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Nearest active player of `team` to (x, z); excludes `exclude` (or -1); keepers optional. Returns -1 if none. */
export function nearestOfTeam(s: SimState, team: number, x: number, z: number, exclude: number, includeKeeper: boolean): number {
  let best = -1;
  let bestD = 1e18;
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || i === exclude) continue;
    if (!includeKeeper && p.isKeeper === 1) continue;
    const dx = p.x - x, dz = p.z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Distance from (x, z) to the nearest active player of `team` (1e9 if none). */
export function nearestDistOfTeam(s: SimState, team: number, x: number, z: number): number {
  const i = nearestOfTeam(s, team, x, z, -1, true);
  if (i < 0) return 1e9;
  const p = s.players[i]!;
  const dx = p.x - x, dz = p.z - z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Pressure on a player 0..1 from the nearest opponent (1 at <= 1 m, 0 at >= 6 m). */
export function pressureOn(s: SimState, slot: number): number {
  const p = s.players[slot]!;
  const d = nearestDistOfTeam(s, otherTeam(p.team), p.x, p.z);
  if (d <= 1) return 1;
  if (d >= 6) return 0;
  return 1 - (d - 1) / 5;
}

/** Number of active opponents of `team` within r metres of (x, z). */
export function opponentsWithin(s: SimState, team: number, x: number, z: number, r: number): number {
  const opp = otherTeam(team);
  const end = teamEnd(opp);
  const r2 = r * r;
  let n = 0;
  for (let i = teamStart(opp); i < end; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    const dx = p.x - x, dz = p.z - z;
    if (dx * dx + dz * dz <= r2) n++;
  }
  return n;
}

/** Controller index driving a slot, -1 = team AI. */
export function controllerOf(s: SimState, slot: number): number { return s.players[slot]!.ctrl; }

/** True when a human controller drives this slot. */
export function isHumanSlot(s: SimState, slot: number): boolean {
  const c = s.players[slot]!.ctrl;
  return c >= 0 && s.ctrl[c]!.kind === ControllerKind.HUMAN;
}

/** True when any human plays for this team. */
export function teamHasHuman(s: SimState, team: number): boolean {
  for (let i = 0; i < 2; i++) {
    const c = s.ctrl[i]!;
    if (c.kind === ControllerKind.HUMAN && c.side === team) return true;
  }
  return false;
}

/** x of the second-last defender of `team` measured toward its own goal (offside line), incl. keeper. */
export function secondLastDefenderX(s: SimState, team: number): number {
  const dir = s.teams[team]!.dir;
  // Defending team's own goal is at -dir * HALF_LENGTH; "deepest" means smallest dir * x.
  let first = 1e9;
  let second = 1e9;
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    const d = dir * p.x;
    if (d < first) { second = first; first = d; } else if (d < second) { second = d; }
  }
  if (second >= 1e9) second = first;
  return dir * second;
}
