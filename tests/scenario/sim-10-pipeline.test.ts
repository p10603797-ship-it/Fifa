/**
 * [SIM-10] Through balls in the full pipeline (real kick error, SIM-08 KICK handler, SIM-01/02 ball, SIM-04/07 runner):
 * a runner who keeps sprinting straight on (P2 holds the stick and sprint; P1 holds the passer, both with auto switching
 * off so nobody is switched) collects the through ball in stride: he is the first to touch it, keeps possession, never
 * slows down before the touch, and (ghost run: he cannot touch it) the ball passes within 1 m of him at a playable
 * height. Plus the THROUGH button through SIM-15, and determinism.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, AutoSwitch, ControllerKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { NULL_SINK } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { startThrough } from '../../src/sim/kicks/through';
import { T_TOUCH } from '../../src/contracts/tuning';
import { maxSpeed } from '../../src/sim/players/locomotion';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';
import { giveBall, KICKER, MATE_A, place, req, skill } from '../unit/sim-09-helpers';

/** IN_PLAY, offside off, no CPU brains; P1 on the passer at (0, -5) with the ball, P2 on the runner; the rest far away. */
function open(seed = 3): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, seed, config: { offside: 0 },
    humans: [{ side: 0, slot: KICKER, autoSwitch: AutoSwitch.OFF }, { side: 0, slot: MATE_A, autoSwitch: AutoSwitch.OFF }],
  });
  for (let t = 0; t < 2; t++) { const c = s.ctrl[2 + t]!; c.kind = ControllerKind.NONE; c.slot = -1; s.teams[t]!.cpu.active = 0; }
  for (let i = 0; i < 22; i++) {
    if (i === 0 || i === 11 || i === KICKER || i === MATE_A) continue;
    place(s, i, (i < 11 ? -30 : -40) + (i % 3), -25 + (i % 11) * 5);
  }
  place(s, 11, 52, 0);
  s.teams[0]!.dir = 1; s.teams[1]!.dir = -1;
  place(s, KICKER, 0, -5);
  s.players[KICKER]!.ctrl = 0;
  skill(s, KICKER, 85);
  giveBall(s, KICKER);
  place(s, MATE_A, 2, 6);
  s.players[MATE_A]!.ctrl = 1;
  return s;
}

/** P2 runs straight along (ux, uz) with sprint held. */
function run(ux: number, uz: number) {
  return (_t: number, _s: SimState, out: InputFrame[]): void => {
    const f = out[1]!;
    f.mx = Math.round(127 * ux); f.mz = Math.round(127 * uz); f.buttons = Btn.SPRINT;
  };
}

interface Reception {
  kicked: boolean;
  /** First player to touch the ball after the kick (-1 none) and the tick after the kick. */
  first: number;
  tick: number;
  owner: number;
  /** Slowest speed of the runner from the kick to his first touch, and his speed at the kick. */
  minSpeed: number;
  atKick: number;
  /** Ghost run (he cannot touch it): closest approach of the ball (at trap height or lower) to him, m. */
  closest: number;
}

/** Kick with startThrough once he is at full speed, then run to his first touch (or, as a ghost, past him). */
function receive(kind: KickKind, power: number, ux: number, uz: number, ghost: boolean, seed = 3): Reception {
  const s = open(seed);
  const inputs = run(ux, uz);
  runTicks(s, 75, inputs); // up to full speed
  expect(startThrough(s, KICKER, kind, req({ power, dirX: ux, dirZ: uz }), NULL_SINK)).toBe(1);
  const r: Reception = { kicked: false, first: -1, tick: -1, owner: -1, minSpeed: Infinity, atKick: 0, closest: Infinity };
  let kickTick = -1;
  const ghostInputs = (t: number, st: SimState, out: InputFrame[]): void => {
    inputs(t, st, out);
    if (ghost && kickTick >= 0) st.players[MATE_A]!.noTouchT = 999;
  };
  runTicks(s, 360, ghostInputs, {
    until: (st, tev) => {
      for (const e of tev) {
        if (e.type !== EventType.KICK) continue;
        if (e.a === KICKER && kickTick < 0) {
          kickTick = st.tick; r.kicked = true;
          r.atKick = Math.hypot(st.players[MATE_A]!.vx, st.players[MATE_A]!.vz);
          continue;
        }
        if (kickTick >= 0 && r.first < 0) { r.first = e.a; r.tick = st.tick - kickTick; }
      }
      if (kickTick < 0) return false;
      const p = st.players[MATE_A]!;
      const b = st.ball;
      if (b.y <= T_TOUCH.trapHeight) r.closest = Math.min(r.closest, Math.hypot(b.x - p.x, b.z - p.z));
      if (ghost) return st.tick - kickTick > 300;
      if (r.first < 0 && b.owner < 0) r.minSpeed = Math.min(r.minSpeed, Math.hypot(p.vx, p.vz));
      if (b.owner >= 0 && r.owner < 0) { r.owner = b.owner; if (r.first < 0) { r.first = b.owner; r.tick = st.tick - kickTick; } }
      return r.first >= 0 && r.owner >= 0;
    },
  });
  return r;
}

describe('SIM-10 through balls in the pipeline', () => {
  for (const kind of [KickKind.THROUGH_GROUND, KickKind.THROUGH_LOBBED, KickKind.THROUGH_DINKED]) {
    for (const [name, ux, uz] of [['straight', 1, 0], ['diagonal', 0.9, 0.436]] as const) {
      it(`${KickKind[kind]} (${name} run): collected in stride, within 1 m of his line, never slowing`, () => {
        for (const power of [0.3, 0.8]) {
          const r = receive(kind, power, ux, uz, false);
          expect(r.kicked).toBe(true);
          expect(r.first, `power ${power}: first touch`).toBe(MATE_A);
          expect(r.owner, `power ${power}: possession`).toBe(MATE_A);
          expect(r.atKick, 'sprinting when the pass is made').toBeGreaterThan(0.85 * maxSpeed(open(), MATE_A, true));
          expect(r.minSpeed, `power ${power}: never slowing`).toBeGreaterThanOrEqual(r.atKick - 0.05);
          // Had he let it run, it would have passed within 1 m of him at a playable height.
          const g = receive(kind, power, ux, uz, true);
          expect(g.closest, `power ${power}: closest approach`).toBeLessThan(1);
        }
      });
    }
  }

  it('the THROUGH button (SIM-15) plays a THROUGH_GROUND to the runner', () => {
    const s = open();
    let pressed = 0;
    const ev = runTicks(s, 160, (t, st, out) => {
      run(1, 0)(t, st, out);
      if (t < 75 || st.ball.lastKickBy === KICKER) return;
      if (pressed === 0 && !(st.players[KICKER]!.act === ActionKind.NONE && st.ball.owner === KICKER)) return;
      if (pressed++ < 3) { out[0]!.buttons = Btn.THROUGH; out[0]!.mx = 127; out[0]!.mz = 40; }
    }, { until: (st) => st.ball.lastKickBy === KICKER });
    const k = findEvents(ev, EventType.KICK, (e) => e.a === KICKER);
    expect(k.map((e) => e.b)).toEqual([KickKind.THROUGH_GROUND]);
    expect(s.ball.passTarget).toBe(MATE_A);
    expect(s.ball.passX).toBeGreaterThan(s.players[MATE_A]!.x);
  });

  it('is deterministic (same seed and inputs -> same state hash)', () => {
    const go = (): number => {
      const s = open(7);
      runTicks(s, 75, run(1, 0));
      startThrough(s, KICKER, KickKind.THROUGH_LOBBED, req({ power: 0.6, dirX: 1 }), NULL_SINK);
      runTicks(s, 150, run(1, 0), { check: 'core' });
      return hashState(s);
    };
    expect(go()).toBe(go());
  });
});
