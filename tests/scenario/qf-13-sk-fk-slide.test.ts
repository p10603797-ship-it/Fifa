/**
 * [QF-13 skeptic] RUL-05 free-kick placement beside the fouled player: the ball went LT.downClear beside the spot where
 * he lay at the award, but a man knocked down at a run slides on (LOCKED on SIM-04's lockedFriction: up to 2 m from
 * 5 m/s), so he slid onto or past the ball during the set-up (a scan of free kicks in 12 CPU matches: the ball within
 * 0.95 m of a lying player at 8 of 56 with a man down, 0.04 m once; the QF-10 test 'the fouled player lying on the foul
 * spot is not under the free-kick ball' failed once the tick-700 state of its seed gave the victim a run). The
 * placement now keeps the ball clear of the whole slide.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, ControllerKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer, NULL_SINK } from '../../src/sim/core/events';
import { knockDown } from '../../src/sim/defend/tackle';
import { initMatch } from '../../src/sim/init';
import { LOCAL_TUNING as FK_LT } from '../../src/sim/rules/freekick';
import { awardRestart } from '../../src/sim/rules/restart';
import { step } from '../../src/sim/step';

/** A CPU v CPU match (3-minute halves) stepped until in play past tick 700. */
function inPlay(seed: number): { s: SimState; step1: () => void } {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.halfMinutes = 3 as never;
  cfg.humans = cfg.humans.map((h) => ({ ...h, kind: ControllerKind.NONE, side: -1 }));
  const s = initMatch(cfg) as SimState;
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const step1 = (): void => { step(s, frames, ev); };
  while (s.tick < 700 || s.match.phase !== MatchPhase.IN_PLAY) step1();
  return { s, step1 };
}

describe('QF-13 skeptic: the fouled player does not slide onto the free-kick ball', () => {
  it('a victim knocked down at a run in any direction never lies within downClear of the placed ball (sweep)', () => {
    let cases = 0, worst = 1e9, worstAt = '';
    const base = inPlay(5);
    for (const [u, z] of [[-30, 5], [0, -12], [25, 20]] as const) {
      for (let k = 0; k < 8; k++) {
        const s = cloneState(base.s);
        const ev = createEventBuffer();
        const frames = [createInputFrame(), createInputFrame()];
        const run = (): void => { step(s, frames, ev); };
        const vic = 7;
        const p = s.players[vic]!;
        const a = (k * Math.PI) / 4;
        p.x = s.teams[0]!.dir * u; p.z = z;
        p.vx = 5 * Math.cos(a); p.vz = 5 * Math.sin(a); // a sprint into the foul
        knockDown(s, vic, ActionKind.FALLEN, NULL_SINK);
        awardRestart(s, RestartKind.FREE_KICK, 0, p.x, p.z, NULL_SINK);
        let closest = 1e9;
        for (let t = 0; t < 300 && s.match.restart.taken === 0; t++) {
          run();
          if (p.act === ActionKind.FALLEN || p.act === ActionKind.GET_UP) closest = Math.min(closest, Math.hypot(p.x - s.ball.x, p.z - s.ball.z));
        }
        cases++;
        if (closest < worst) { worst = closest; worstAt = `u ${u} z ${z} dir ${k * 45} deg`; }
      }
    }
    expect(cases).toBe(24);
    // was 0.0-0.4 m (sliding toward the side the ball went: he lay on it)
    expect(worst, worstAt).toBeGreaterThanOrEqual(FK_LT.downClear - 0.05);
  });

  it('the QF-10 case (seed 3: the victim running at the award) keeps the ball beside him', () => {
    for (const u of [-30, 0, 25]) {
      const { s, step1 } = inPlay(3);
      const vic = 7;
      const p = s.players[vic]!;
      p.x = s.teams[0]!.dir * u; p.z = 5;
      p.vx = -2.8; p.vz = 0.6; // his run at tick 700 on the tree where that test failed (0.68 m)
      knockDown(s, vic, ActionKind.FALLEN, NULL_SINK);
      awardRestart(s, RestartKind.FREE_KICK, 0, p.x, p.z, NULL_SINK);
      let closest = 1e9;
      for (let k = 0; k < 300 && s.match.restart.taken === 0; k++) {
        step1();
        if (p.act === ActionKind.FALLEN || p.act === ActionKind.GET_UP) closest = Math.min(closest, Math.hypot(p.x - s.ball.x, p.z - s.ball.z));
      }
      expect(closest).toBeGreaterThanOrEqual(FK_LT.downClear - 0.05);
    }
  });

  it('the set-up walkers go round a man lying by the ball: the taker no longer shoves him along the ground', () => {
    // SIM-05: the anchored taker (never pushed in a set-up) walking to the ball through the lying victim handed him
    // the closing speed (3-4 m/s) and his LOCKED slide carried him 1-2 m, onto the ball placed beside him (a scan of
    // set-ups: 13 shoves of a man down in 16 CPU matches, up to 2.06 m, 6 by the taker).
    let worst = 0, cases = 0, met = 0;
    const base = inPlay(5);
    for (const [u, z] of [[-30, 5], [0, -12], [25, 20]] as const) {
      for (const side of [-1, 1]) {
        const s = cloneState(base.s);
        const ev = createEventBuffer();
        const frames = [createInputFrame(), createInputFrame()];
        const vic = 7;
        const p = s.players[vic]!;
        p.x = s.teams[0]!.dir * u; p.z = z; p.vx = 0; p.vz = 0;
        knockDown(s, vic, ActionKind.FALLEN, NULL_SINK);
        awardRestart(s, RestartKind.FREE_KICK, 0, p.x, p.z, NULL_SINK);
        const r = s.match.restart;
        const t = s.players[r.taker]!;
        // The taker 6 m out on the far side of the victim (the line ball -> victim, bent a little either way): his
        // walk to the ball passes over the lying man.
        const bx = s.ball.x, bz = s.ball.z;
        let dx = p.x - bx, dz = p.z - bz;
        const d = Math.hypot(dx, dz);
        dx /= d; dz /= d;
        t.x = bx + dx * 6 - dz * 0.2 * side; t.z = bz + dz * 6 + dx * 0.2 * side; t.vx = 0; t.vz = 0;
        const x0 = p.x, z0 = p.z;
        let moved = 0, touched = false;
        for (let k = 0; k < 300 && r.taken === 0; k++) {
          step(s, frames, ev);
          if (p.act !== ActionKind.FALLEN && p.act !== ActionKind.GET_UP) break;
          moved = Math.max(moved, Math.hypot(p.x - x0, p.z - z0));
          if (Math.hypot(t.x - p.x, t.z - p.z) < 0.8) touched = true;
        }
        cases++;
        if (touched) met++;
        worst = Math.max(worst, moved);
      }
    }
    expect(cases).toBe(6);
    expect(met).toBeGreaterThan(2); // the taker does come up against him
    expect(worst).toBeLessThan(0.05); // was: shoved along the ground
  });
});
