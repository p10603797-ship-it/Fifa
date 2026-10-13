/**
 * [GKP-03] Test helpers for the keeper come-out tests: scenes built in the defending keeper's goal frame (u = metres
 * in front of his goal line, z across; velocities vu = d(u)/dt, vz), for either team and either half, with every other
 * player parked far up the pitch. Used by tests/scenario/gkp-03-*.test.ts and tests/unit/gkp-03-*.test.ts only.
 */
import { BALL_RADIUS, HALF_LENGTH, NUM_SLOTS, PLAYERS_PER_TEAM, teamFirstSlot } from '../../src/contracts/constants';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createEventBuffer, type EventBufferImpl } from '../../src/sim/core/events';
import { idealKeeperSpot } from '../../src/sim/keeper/positioning';
import { makeScenario, type ScenarioHuman } from '../harness/scenario';

export interface SceneOpts {
  /** Defending team (the keeper's team). Default 0. */
  team?: number;
  /** Second half: the teams' attack directions are swapped. */
  swap?: boolean;
  seed?: number;
  humans?: ScenarioHuman[];
  /** Keeper position in the goal frame (default u 1.5, z 0). */
  ku?: number;
  kz?: number;
}

/** A scene in the defending keeper's goal frame. */
export interface Scene {
  s: SimState;
  team: number;
  opp: number;
  dir: number;
  keeper: number;
  /** n-th outfield player of the defending team (1..10) / of the attacking team (1..10). */
  mate(n: number): number;
  att(n: number): number;
  x(u: number): number;
  u(x: number): number;
  vx(vu: number): number;
  place(slot: number, u: number, z: number, vu?: number, vz?: number): void;
  loose(u: number, z: number, vu: number, vz: number, o?: LooseOpts): void;
  owned(slot: number, du?: number, dz?: number, vu?: number, vz?: number): void;
}

export interface LooseOpts {
  y?: number;
  vy?: number;
  /** Last kicker (default: an attacker). */
  by?: number;
  kind?: KickKind;
  target?: number;
}

export function scene(o: SceneOpts = {}): Scene {
  const team = o.team ?? 0;
  const opp = team === 0 ? 1 : 0;
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: o.seed ?? 7, humans: o.humans ?? [] });
  if (o.swap) { s.teams[0]!.dir = -1; s.teams[1]!.dir = 1; }
  const dir = s.teams[team]!.dir;
  const keeper = s.teams[team]!.keeperSlot;
  const x = (u: number): number => dir * (u - HALF_LENGTH);
  const u = (px: number): number => dir * px + HALF_LENGTH;
  const vx = (vu: number): number => dir * vu;
  const place = (slot: number, pu: number, pz: number, vu = 0, vz = 0): void => {
    const p = s.players[slot]!;
    p.x = x(pu); p.z = pz; p.vx = vx(vu); p.vz = vz;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > 0.1) { p.fx = p.vx / sp; p.fz = p.vz / sp; } else { p.fx = -dir; p.fz = 0; }
    p.homeX = p.x; p.homeZ = p.z;
  };
  // Park everyone far up the pitch (the other half), spread across.
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.isKeeper === 1) continue;
    const mine = p.team === team;
    place(i, (mine ? 62 : 70) + (i % 4) * 4, -24 + (i % 11) * 4.8);
  }
  const ok = s.teams[opp]!.keeperSlot;
  place(ok, 104, 0);
  s.players[ok]!.fx = dir; s.players[ok]!.fz = 0;
  place(keeper, o.ku ?? 1.5, o.kz ?? 0);
  const kp = s.players[keeper]!;
  kp.fx = dir; kp.fz = 0;
  const mate = (n: number): number => teamFirstSlot(team) + n;
  const att = (n: number): number => teamFirstSlot(opp) + n;
  const loose = (bu: number, bz: number, vu: number, vz: number, lo: LooseOpts = {}): void => {
    const b = s.ball;
    b.x = x(bu); b.z = bz; b.y = lo.y ?? BALL_RADIUS;
    b.px = b.x; b.py = b.y; b.pz = b.z;
    b.vx = vx(vu); b.vz = vz; b.vy = lo.vy ?? 0;
    b.sx = 0; b.sy = 0; b.sz = 0;
    b.grounded = b.y <= BALL_RADIUS + 0.01 && b.vy === 0 ? 1 : 0;
    b.owner = -1; b.heldBy = -1; b.inNet = 0;
    const by = lo.by ?? att(9);
    b.lastKickBy = by; b.lastKickTeam = s.players[by]!.team; b.lastKickKind = lo.kind ?? KickKind.THROUGH_GROUND;
    b.lastKickTick = s.tick; b.lastTouch = by; b.lastTouchTeam = b.lastKickTeam; b.lastTouchTick = s.tick;
    b.passTarget = lo.target ?? -1; b.shotBy = -1;
    s.players[by]!.lastTouchTick = s.tick;
  };
  const owned = (slot: number, du = -0.7, dz = 0, vu = 0, vz = 0): void => {
    const p = s.players[slot]!;
    const b = s.ball;
    b.x = p.x + vx(du); b.z = p.z + dz; b.y = BALL_RADIUS;
    b.px = b.x; b.py = b.y; b.pz = b.z;
    b.vx = vx(vu); b.vz = vz; b.vy = 0; b.grounded = 1;
    b.owner = slot; b.ownerT = 1; b.heldBy = -1; b.inNet = 0;
    b.lastTouch = slot; b.lastTouchTeam = p.team; b.lastTouchTick = s.tick; b.passTarget = -1; b.shotBy = -1;
    b.lastKickBy = slot; b.lastKickTeam = p.team; b.lastKickKind = KickKind.THROUGH_GROUND; b.lastKickTick = s.tick;
    p.lastTouchTick = s.tick;
  };
  return { s, team, opp, dir, keeper, mate, att, x, u, vx, place, loose, owned };
}

/** All four (team, swap) combinations: both ends, both halves. */
export const ENDS: { team: number; swap: boolean; name: string }[] = [
  { team: 0, swap: false, name: 'home keeper, first half' },
  { team: 1, swap: false, name: 'away keeper, first half' },
  { team: 0, swap: true, name: 'home keeper, second half' },
  { team: 1, swap: true, name: 'away keeper, second half' },
];

/** Inputs: controller ctrl steers its player toward target(s) at full stick (sprint optional), plus buttons. */
export function drive(
  ctrl: number, target: (s: SimState) => { x: number; z: number } | null, sprint = true,
  buttons: (tick: number, s: SimState) => number = () => 0,
): (tick: number, s: SimState, out: InputFrame[]) => void {
  return (tick, s, out) => {
    const f = out[ctrl]!;
    f.buttons |= buttons(tick, s);
    const slot = s.ctrl[ctrl]!.slot;
    const t = target(s);
    if (slot < 0 || !t) return;
    const p = s.players[slot]!;
    const dx = t.x - p.x, dz = t.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return;
    f.mx = Math.round((127 * dx) / d);
    f.mz = Math.round((127 * dz) / d);
    if (sprint) f.buttons |= Btn.SPRINT;
  };
}

export function eventsOf(ev: readonly SimEvent[], type: EventType): SimEvent[] {
  return ev.filter((e) => e.type === type);
}

export function evBuf(s: SimState): EventBufferImpl {
  const e = createEventBuffer();
  e.begin(s.tick);
  return e;
}

/** Distance of the keeper from GKP-01's ideal spot for the current ball. */
export function offSpot(s: SimState, team: number): number {
  const spot = { x: 0, z: 0 };
  idealKeeperSpot(s, team, spot);
  const k = s.players[s.teams[team]!.keeperSlot]!;
  return Math.hypot(k.x - spot.x, k.z - spot.z);
}

export function isRushing(s: SimState, slot: number): boolean {
  return s.players[slot]!.act === ActionKind.GK_RUSH;
}

/** Slots of the active outfield players of a team. */
export function outfield(s: SimState, team: number): number[] {
  const r: number[] = [];
  for (let i = teamFirstSlot(team); i < teamFirstSlot(team) + PLAYERS_PER_TEAM; i++) {
    const p = s.players[i]!;
    if (p.active === 1 && p.isKeeper === 0) r.push(i);
  }
  return r;
}
