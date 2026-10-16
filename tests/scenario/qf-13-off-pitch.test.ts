/**
 * [QF-13] Players run off the pitch in play (scan: 30 short bot matches, soak seed 33, every level: 6 episodes over
 * 1 m beyond a line):
 *  - TAI-08 dribble turn: with a fixed leash margin the CPU carrier turned away 0.2 m short of his ball rolling away
 *    into the corner and back after it, again and again: 5 s without a touch, the ball resting on the goal line, the
 *    carrier 1.3 m beyond it (seed 33 #17, t 13230). He now runs to the ball until it comes into his reach (judged
 *    T_CPU.carrierLeashLeadTicks ahead, latched) and turns it.
 *  - TAI-11 loose-ball chase at full stick ran on over the touchline (seed 33 #16, t 4690: 2.34 m off for 36 ticks):
 *    within his braking distance of a line the stick's component toward it is let go.
 *  - TAI-07 ball jobs (team-AI chasers) aimed at interception points and overshoots up to the boards, 6 m beyond the
 *    line: in play they stay within the pitch + T_TOUCH.meetPitchMargin.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { AiJob, ControllerKind, MatchPhase } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { T_TOUCH } from '../../src/contracts/tuning';
import { deserializeState } from '../../src/sim/core/serialize';
import { makeScenario, runTicks } from '../harness/scenario';

const off = (x: number, z: number): number => Math.max(Math.abs(x) - HALF_LENGTH, Math.abs(z) - HALF_WIDTH, 0);
const load = (name: string): SimState => deserializeState(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('QF-13: players stay on the pitch while the ball is in play', () => {
  it('glitch: ball resting on the goal line, carrier orbiting it — the CPU carrier turns his ball out of the corner (seed 33 #17)', () => {
    const s = load('qf-13-corner-dribble.state.json');
    const C = 8;
    expect(s.ball.owner).toBe(C);
    const first = s.tick;
    let worst = 0, firstTouch = -1, lastTouch = s.ball.lastTouchTick, longestGap = 0;
    runTicks(s, 230, undefined, {
      until: (st) => {
        if (st.match.phase !== MatchPhase.IN_PLAY) return true;
        const p = st.players[C]!;
        const o = off(p.x, p.z);
        if (o > worst) worst = o;
        if (st.ball.lastTouchTick !== lastTouch) {
          if (st.ball.lastTouch === C && firstTouch < 0) firstTouch = st.tick;
          lastTouch = st.ball.lastTouchTick;
        }
        if (st.ball.owner === C && st.tick - st.ball.lastTouchTick > longestGap) longestGap = st.tick - st.ball.lastTouchTick;
        return false;
      },
    });
    expect(worst).toBeLessThanOrEqual(0.5); // was 1.3 m
    expect(firstTouch).toBeGreaterThan(0); // he gets to it (was: no touch for 300 ticks, then a kick out of play)
    expect(firstTouch - first).toBeLessThan(150);
  });

  it('a CPU-controlled chaser sprinting after a high ball to the touchline stops at the line (seed 33 #16)', () => {
    const s = load('qf-13-chase-touchline.state.json');
    const D = 12;
    expect(s.players[D]!.ctrl).toBeGreaterThanOrEqual(2);
    let worst = 0;
    runTicks(s, 150, undefined, {
      until: (st) => {
        if (st.match.phase !== MatchPhase.IN_PLAY) return true;
        const p = st.players[D]!;
        const o = off(p.x, p.z);
        if (o > worst) worst = o;
        return false;
      },
    });
    expect(worst).toBeLessThanOrEqual(0.6); // was 2.34 m
  });

  it('team-AI chasers of a ball rolling out over the touchline keep their targets and feet within the margin', () => {
    let worstTarget = 0, worstPos = 0, chased = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, humans: 0 });
      for (const c of s.ctrl) { if (c.slot >= 0) s.players[c.slot]!.ctrl = -1; c.kind = ControllerKind.NONE; c.slot = -1; c.side = -1; }
      s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
      for (let i = 0; i < 22; i++) {
        const p = s.players[i]!;
        p.x = i < 11 ? -45 : 45; p.z = -28 + (i % 11) * 5.5; p.vx = 0; p.vz = 0;
      }
      // Team 0's player 7 nearest a ball rolling quickly toward the +z touchline from 10 m in.
      const p = s.players[7]!;
      p.x = 0 + seed; p.z = 20; p.vx = 0; p.vz = 4;
      const b = s.ball;
      b.owner = -1; b.heldBy = -1; b.x = 1 + seed; b.y = 0.11; b.z = 24; b.vx = 0.5 + seed * 0.3; b.vy = 0; b.vz = 9; b.grounded = 1;
      b.px = b.x; b.py = b.y; b.pz = b.z; b.lastTouch = 14; b.lastTouchTeam = 1; b.lastTouchTick = s.tick; b.passTarget = -1;
      runTicks(s, 120, undefined, {
        until: (st) => {
          if (st.match.phase !== MatchPhase.IN_PLAY) return true;
          for (let i = 0; i < 22; i++) {
            const q = st.players[i]!;
            if (q.job === AiJob.CHASE_LOOSE) {
              chased++;
              const t = off(q.tgtX, q.tgtZ);
              if (t > worstTarget) worstTarget = t;
            }
            const o = off(q.x, q.z);
            if (o > worstPos) worstPos = o;
          }
          return false;
        },
      });
    }
    expect(chased).toBeGreaterThan(0);
    expect(worstTarget).toBeLessThanOrEqual(T_TOUCH.meetPitchMargin + 1e-9);
    expect(worstPos).toBeLessThanOrEqual(T_TOUCH.meetPitchMargin + 0.4);
  });
});
