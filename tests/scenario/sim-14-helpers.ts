/**
 * [SIM-14] Scenario helpers for the tackle / interception / clearance tests: an IN_PLAY scene with two human-controlled
 * players (P1 = home slot 9, P2 = away slot 20, auto switch off, idle sticks), both CPU brains off and everyone else
 * parked far away, so only the players under test move.
 */
import '../../src/sim/actions/dispatch'; // load the action registry first (import-cycle order)
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, AutoSwitch, ControllerKind, MatchPhase } from '../../src/contracts/enums';
import type { SimEvent } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { rngSeed } from '../../src/sim/core/rng';
import { step } from '../../src/sim/step';
import { createInputFrame } from '../../src/contracts/input';
import { makeScenario } from '../harness/scenario';

export const P1 = 9; // home (team 0, attacks +x)
export const P2 = 20; // away (team 1, attacks -x)

/** Bare IN_PLAY scene: P1 / P2 human (idle), CPU brains off, the rest parked on the far sidelines. */
export function scene(seed = 1): SimState {
  const s = makeScenario({
    seed, phase: MatchPhase.IN_PLAY,
    humans: [{ side: 0, slot: P1, autoSwitch: AutoSwitch.OFF }, { side: 1, slot: P2, autoSwitch: AutoSwitch.OFF }],
  });
  for (const c of [2, 3]) {
    const ctl = s.ctrl[c]!;
    if (ctl.slot >= 0 && s.players[ctl.slot]!.ctrl === c) s.players[ctl.slot]!.ctrl = -1;
    ctl.kind = ControllerKind.NONE; ctl.side = -1; ctl.slot = -1;
  }
  s.teams[0]!.cpu.active = 0;
  s.teams[1]!.cpu.active = 0;
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (i === P1 || i === P2) continue;
    const p = s.players[i]!;
    const team = i < 11 ? 0 : 1, k = i % 11;
    if (k === 0) { p.x = team === 0 ? -50 : 50; p.z = 0; } else { p.x = -40 + k * 8; p.z = team === 0 ? -32 : 32; }
    p.vx = 0; p.vz = 0;
  }
  place(s, P1, -30, 20, 1, 0);
  place(s, P2, 30, 20, -1, 0);
  loose(s, 0, -20, 0, 0);
  return s;
}

/** Put a player at (x, z) facing (fx, fz), standing (or with velocity v along the facing). */
export function place(s: SimState, slot: number, x: number, z: number, fx: number, fz: number, v = 0): void {
  const p = s.players[slot]!;
  const l = Math.hypot(fx, fz) || 1;
  p.x = x; p.z = z; p.fx = fx / l; p.fz = fz / l; p.vx = p.fx * v; p.vz = p.fz * v;
  p.act = ActionKind.NONE; p.stunT = 0; p.noTouchT = 0;
}

/** Ball loose at (x, z) on the ground with velocity (vx, vz). */
export function loose(s: SimState, x: number, z: number, vx: number, vz: number): void {
  Object.assign(s.ball, {
    x, z, y: 0.11, px: x - vx / 60, pz: z - vz / 60, py: 0.11, vx, vy: 0, vz, grounded: 1, owner: -1, heldBy: -1,
    sx: 0, sy: 0, sz: 0, inNet: 0,
  });
}

/** Ball owned by `slot`, at (x, z) at rest. */
export function owned(s: SimState, slot: number, x: number, z: number): void {
  loose(s, x, z, 0, 0);
  const p = s.players[slot]!;
  Object.assign(s.ball, { owner: slot, lastTouch: slot, lastTouchTeam: p.team, lastTouchTick: s.tick, touchedTick: -1 });
}

/** A pass by `slot` in flight: ball at (x, z), velocity (vx, vz), untouched since the kick. */
export function pass(s: SimState, slot: number, kind: number, x: number, z: number, vx: number, vz: number): void {
  loose(s, x, z, vx, vz);
  const p = s.players[slot]!;
  Object.assign(s.ball, {
    lastTouch: slot, lastTouchTeam: p.team, lastTouchTick: s.tick, lastKickBy: slot, lastKickTeam: p.team,
    lastKickKind: kind, lastKickTick: s.tick, passTarget: -1, touchedTick: s.tick,
  });
}

const FRAMES = [createInputFrame(), createInputFrame()];
const EVB = createEventBuffer();

/** Step n ticks with idle humans; returns copies of every event. `each` runs after every tick (stop = return true). */
export function stepN(s: SimState, n: number, each?: (s: SimState, ev: SimEvent[]) => boolean | void): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    step(s, FRAMES, EVB);
    const tickEv: SimEvent[] = [];
    for (let k = 0; k < EVB.count; k++) {
      const e = EVB.get(k);
      const c = { type: e.type, tick: e.tick, a: e.a, b: e.b, c: e.c, d: e.d, x: e.x, y: e.y, z: e.z };
      all.push(c);
      tickEv.push(c);
    }
    if (each && each(s, tickEv) === true) break;
  }
  return all;
}

/** Clone a prepared scene with a different RNG stream (Monte Carlo trials). */
export function trial(base: SimState, k: number): SimState {
  const s = cloneState(base);
  rngSeed(s.rng, 1000 + k * 7919);
  return s;
}
