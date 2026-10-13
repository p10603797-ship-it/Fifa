/**
 * [SIM-13] Scenario helpers for the skill-move tests: a dribbler (slot 9, home, human P1) on the ball in open play
 * with everybody else far away, optionally one opponent (slot 15, human P2 with an idle stick, so he stands where he
 * is put) near the action; plus an event recorder and small geometry probes.
 */
import { NUM_SLOTS } from '../../src/contracts/constants';
import { AutoSwitch, MatchPhase } from '../../src/contracts/enums';
import type { EventSink, EventType } from '../../src/contracts/events';
import type { InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { makeScenario, type ScenarioHuman, type ScenarioPlayer } from '../harness/scenario';

export const SKILLER = 9;
/** An away player (opponent of SKILLER). */
export const OPP = 15;
/** A home teammate of SKILLER. */
export const MATE = 7;

export interface SkillSceneOpts {
  /** Skiller position / velocity / facing (default at the centre spot, facing +x, standing). */
  x?: number; z?: number; vx?: number; vz?: number; fx?: number; fz?: number;
  /** Ball offset from the skiller (default 0.4 m ahead along the facing); ball velocity defaults to his. */
  bx?: number; bz?: number;
  /** Skill stars of the skiller (default 5). */
  stars?: number;
  /** Put OPP here (relative to the skiller), controlled by human P2 with an idle stick. */
  opp?: { x: number; z: number };
  /** Put MATE here (relative to the skiller). */
  mate?: { x: number; z: number };
  seed?: number;
}

/** Everybody but the skiller (and the optional opponent / teammate) far away from the action, standing still. */
export function skillScene(o: SkillSceneOpts = {}): SimState {
  const x = o.x ?? 0, z = o.z ?? 0;
  const fx = o.fx ?? 1, fz = o.fz ?? 0;
  const vx = o.vx ?? 0, vz = o.vz ?? 0;
  const players: ScenarioPlayer[] = [];
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (i === SKILLER) continue;
    const home = i < 11;
    players.push({ slot: i, x: x + (home ? -35 : 35), z: -25 + (i % 11) * 5, vx: 0, vz: 0 });
  }
  players.push({ slot: SKILLER, x, z, vx, vz, fx, fz });
  if (o.opp) players.push({ slot: OPP, x: x + o.opp.x, z: z + o.opp.z, vx: 0, vz: 0, fx: -1, fz: 0 });
  if (o.mate) players.push({ slot: MATE, x: x + o.mate.x, z: z + o.mate.z, vx: 0, vz: 0, fx: 1, fz: 0 });
  const humans: ScenarioHuman[] = [{ side: 0, slot: SKILLER, autoSwitch: AutoSwitch.OFF }];
  if (o.opp) humans.push({ side: 1, slot: OPP, autoSwitch: AutoSwitch.OFF });
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY,
    seed: o.seed ?? 7,
    humans,
    players,
    ball: {
      x: x + (o.bx ?? 0.4 * fx), z: z + (o.bz ?? 0.4 * fz), y: 0.11, vx, vz, vy: 0,
      owner: SKILLER, lastTouch: SKILLER, lastTouchTeam: 0,
    },
  });
  s.attrs[SKILLER]!.skillMoves = o.stars ?? 5;
  return s;
}

/** Ball position relative to slot: along (ux, uz), across it (positive = to the right of u) and the distance. */
export function ballRel(s: SimState, slot: number, ux: number, uz: number): { along: number; side: number; dist: number } {
  const p = s.players[slot]!;
  const dx = s.ball.x - p.x, dz = s.ball.z - p.z;
  return { along: dx * ux + dz * uz, side: dz * ux - dx * uz, dist: Math.sqrt(dx * dx + dz * dz) };
}

/** P1 holds the stick along (ux, uz) (full deflection), optionally with extra buttons. */
export function stick(ux: number, uz: number, buttons = 0): (tick: number, s: SimState, out: InputFrame[]) => void {
  return (_t, _s, out) => {
    out[0]!.mx = Math.round(ux * 127);
    out[0]!.mz = Math.round(uz * 127);
    out[0]!.buttons = buttons;
  };
}

export interface Recorder extends EventSink {
  events: number[][];
}

/** An EventSink that records [type, a, b] of every event. */
export function recorder(): Recorder {
  const r: Recorder = {
    events: [],
    emit(type: EventType, a = 0, b = 0) { r.events.push([type, a, b]); },
  };
  return r;
}

/** Signed angle (rad) from (ax, az) to (bx, bz). */
export function angleBetween(ax: number, az: number, bx: number, bz: number): number {
  return Math.atan2(ax * bz - az * bx, ax * bx + az * bz);
}
