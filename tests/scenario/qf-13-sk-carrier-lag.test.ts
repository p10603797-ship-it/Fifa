/**
 * [QF-13 skeptic] TAI-08 dribble leash (carrier.ts runDribble), found by a scan of CPU carriers whose ball is out of
 * SIM-06's touch reach and not getting closer (soak seed 411, Legend v Legend, 8 short matches):
 *  - After a heavy touch ahead the carrier re-decided to dribble 30-40 degrees off the ball's line: turning meant no
 *    sprint and a jog stick, so he slowed to his jog while the ball rolled on faster, 2-2.8 m ahead, until it passed the
 *    lose radius and possession was released: 76 such losses in 8 matches (9.5 a match at Legend, 0.9 at Professional).
 *    When the leash let go at the edge of his reach he turned along the plan, slowed (his reach shrinks with his speed)
 *    and the ball ran out of reach again.
 *  - A first touch that popped the ball up: the leash judged the bouncing ball in reach (horizontally) and let go, so
 *    the carrier ran off along the plan and orbited his ball by the touchline for 84 ticks (SIM-06 touches only a ball at
 *    most T_DRIBBLE.controlHeight high).
 * Now the leash holds a ball above control height (aimed at where it comes down) and until the ball is
 * T_CPU.carrierLeashInner inside his reach, and in a turn he sprints while the ball, rolling on until it slows to his
 * dribbling pace, would get further than the lose radius - carrierLeashLoseMargin. Fixtures: the WIP tree's states
 * just before each episode (seed 411 #0 t 24660, #1 t 17440).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { T_DRIBBLE } from '../../src/contracts/tuning';
import { deserializeState } from '../../src/sim/core/serialize';
import { runTicks } from '../harness/scenario';

const load = (name: string): SimState => deserializeState(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** Runs until the carrier's next touch: ticks to it (-1 none), whether he kept possession until then, widest gap. */
function untilTouch(s: SimState, slot: number, n: number): { touch: number; kept: boolean; maxD: number } {
  const t0 = s.tick, lt0 = s.ball.lastTouchTick;
  let touch = -1, kept = true, maxD = 0;
  runTicks(s, n, undefined, {
    until: (st) => {
      if (st.match.phase !== MatchPhase.IN_PLAY) return true;
      const b = st.ball, p = st.players[slot]!;
      if (b.lastTouchTick !== lt0 && b.lastTouch === slot) { touch = st.tick - t0; return true; }
      if (b.owner !== slot) kept = false;
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      if (d > maxD) maxD = d;
      return false;
    },
  });
  return { touch, kept, maxD };
}

describe('QF-13 skeptic: the CPU carrier stays with his own ball', () => {
  it('the CPU carrier no longer jogs behind his own ball until it is lost: in a turn he sprints while a heavy touch would get away (seed 411 #0)', () => {
    const s = load('qf-13-sk-carrier-lag.state.json');
    const C = 21;
    expect(s.ball.owner).toBe(C);
    expect(s.teams[1]!.cpu.level).toBe(5);
    const r = untilTouch(s, C, 150);
    expect(r.kept).toBe(true); // was: released at +46 (2.87 m away), the ball loose
    expect(r.maxD).toBeLessThan(T_DRIBBLE.loseRadius - 0.2);
    expect(r.touch).toBeGreaterThan(0); // he gets to it (sprinting only while it would get away, then at his pace)
  });

  it('glitch: players orbit a target — the CPU carrier no longer orbits his bouncing ball after a first touch, he touches it when it is low (seed 411 #1)', () => {
    const s = load('qf-13-sk-carrier-bounce.state.json');
    const C = 8;
    expect(s.ball.owner).toBe(C);
    expect(s.ball.y).toBeGreaterThan(T_DRIBBLE.controlHeight);
    const r = untilTouch(s, C, 150);
    expect(r.kept).toBe(true);
    expect(r.touch).toBeGreaterThan(0);
    expect(r.touch).toBeLessThan(30); // was +84, orbiting 1.2-1.6 m from it
    expect(r.maxD).toBeLessThan(1.2); // was 1.58
  });
});
