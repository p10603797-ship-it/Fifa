/**
 * [SIM-09] Lobs and crosses in the full pipeline: SIM-15 button routing -> startLob (crossing-zone conversions) ->
 * SIM-08 KICK handler -> solveLob / solveCross -> SIM-01/02 ball; a lob over a defender completed to the receiver; a
 * cross landing on its zone; determinism.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, AutoSwitch, ControllerKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { hashState } from '../../src/sim/core/hash';
import { crossTarget } from '../../src/sim/kicks/lob';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';
import { giveBall, KICKER, MATE_A, OPP_A, place, skill } from './sim-09-helpers';

/** IN_PLAY, offside off, no CPU brains; P1 on the kicker at (kx, kz) with the ball; everybody else far away. */
function live(kx: number, kz: number, fx: number, fz: number, seed = 3): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, config: { offside: 0 }, humans: [{ side: 0, slot: KICKER, autoSwitch: AutoSwitch.OFF }] });
  for (let t = 0; t < 2; t++) { const c = s.ctrl[2 + t]!; c.kind = ControllerKind.NONE; c.slot = -1; s.teams[t]!.cpu.active = 0; }
  for (let i = 0; i < 22; i++) {
    if (i === 0 || i === 11 || i === KICKER) continue;
    place(s, i, (i < 11 ? -30 : -40) + (i % 3), -25 + (i % 11) * 5);
  }
  place(s, 11, 52, 0);
  place(s, 0, -52, 0);
  s.teams[0]!.dir = 1; s.teams[1]!.dir = -1;
  const l = Math.hypot(fx, fz);
  place(s, KICKER, kx, kz, fx / l, fz / l);
  s.players[KICKER]!.ctrl = 0;
  skill(s, KICKER, 80);
  giveBall(s, KICKER);
  return s;
}

/**
 * Press `buttons` (stick (mx, mz)) once the kicker is free with the ball: `holds` lists [press ticks, gap ticks] pairs
 * (a double tap is two pairs). Stops pressing once he has struck the ball.
 */
function presses(buttons: number, mx: number, mz: number, holds: [number, number][]) {
  let n = 0;
  let started = false;
  const plan: number[] = [];
  for (const [on, off] of holds) { for (let i = 0; i < on; i++) plan.push(1); for (let i = 0; i < off; i++) plan.push(0); }
  return (_t: number, st: SimState, out: InputFrame[]): void => {
    if (st.ball.lastKickBy === KICKER && st.ball.owner !== KICKER) return;
    const f = out[0]!;
    f.mx = mx; f.mz = mz;
    if (!started && !(st.players[KICKER]!.act === ActionKind.NONE && st.ball.owner === KICKER)) return;
    started = true;
    if (n < plan.length && plan[n++] === 1) f.buttons = buttons;
  };
}

function kicksBy(ev: SimEvent[], slot: number): number[] {
  return findEvents(ev, EventType.KICK, (e) => e.a === slot).map((e) => e.b);
}

describe('x', () => { it('trace', () => {
  const s = live(0, 0, 1, 0);
  place(s, MATE_A, 26, 4);
  place(s, OPP_A, 12, 2);
  let k = -1;
  const ev = runTicks(s, 300, presses(Btn.LOB, 125, 20, [[12, 0]]), {
    until: (st, tev) => {
      for (const e of tev) if (e.type === EventType.KICK || e.type === EventType.PASS_COMPLETE || e.type === EventType.BOUNCE || e.type === EventType.INTERCEPT || e.type === EventType.AERIAL) console.log('ev', st.tick, e.type, e.a, e.b, e.x.toFixed(1), e.z.toFixed(1));
      if (st.ball.lastKickBy === KICKER && k < 0) { k = st.tick; console.log('kick', st.ball.passTarget, st.ball.passX.toFixed(1), st.ball.passZ.toFixed(1)); }
      if (k > 0 && (st.tick - k) % 10 === 0) { const q = st.players[MATE_A]!; console.log('t', st.tick - k, 'q', q.x.toFixed(1), q.z.toFixed(1), 'job', q.job, 'ctrl', q.ctrl, 'act', q.act, 'b', st.ball.x.toFixed(1), st.ball.y.toFixed(1), st.ball.z.toFixed(1), 'own', st.ball.owner, 'p1', st.ctrl[0]!.slot); }
      return false;
    },
  });
  void ev;
}); });
