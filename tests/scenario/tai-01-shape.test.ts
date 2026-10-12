/**
 * TAI-01 scenario tests: team shapes through the real tick pipeline (sim/step.ts -> ai/index.ts teamAiTick ->
 * updateShape), with whatever the other modules currently implement around it.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { AiJob, FormationId, MatchPhase, TeamPhase } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { T_AI } from '../../src/contracts/tuning';
import { resetJobs } from '../../src/ai/jobs';
import { homePositionAt, updateShape } from '../../src/ai/shape';
import { NULL_SINK } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { makeScenario, runTicks } from '../harness/scenario';

function inPlay(form: FormationId, seed = 7): SimState {
  return makeScenario({
    seed, phase: MatchPhase.IN_PLAY, config: { homeFormation: form, awayFormation: form },
    ball: { x: -25, y: 0.11, z: 6, vx: 9, vz: 2.5 },
  });
}

/** Keep the ball moving on a fixed path (independent of other modules) so every recompute changes the homes. */
function driveBall(tick: number, s: SimState): void {
  s.ball.x = -40 + ((tick * 0.45) % 80);
  s.ball.z = -25 + ((tick * 0.3) % 50);
  s.ball.px = s.ball.x; s.ball.pz = s.ball.z;
  s.ball.vx = 0; s.ball.vz = 0; s.ball.y = 0.11; s.ball.vy = 0;
  s.ball.owner = -1;
}

describe('TAI-01 shape through the real pipeline', () => {
  it.each([FormationId.F442, FormationId.F433, FormationId.F4231, FormationId.F352, FormationId.F532, FormationId.F41212])(
    'formation %i: homes refresh on the staggered schedule, players carry them, invariants hold', (form) => {
      const s = inPlay(form);
      const I = T_AI.shapeInterval;
      const last = [JSON.stringify(s.teams[0]!.homeX), JSON.stringify(s.teams[1]!.homeX)];
      const changes: number[][] = [[], []];
      runTicks(s, 240, (tick, st) => driveBall(tick, st), {
        check: 'core',
        until: (st) => {
          for (const team of [0, 1]) {
            const t = st.teams[team]!;
            const now = JSON.stringify(t.homeX);
            if (now !== last[team]) changes[team]!.push(st.tick);
            last[team] = now;
            for (let f = 0; f < 11; f++) {
              expect(Number.isFinite(t.homeX[f]!) && Number.isFinite(t.homeZ[f]!)).toBe(true);
              expect(Math.abs(t.homeX[f]!)).toBeLessThanOrEqual(HALF_LENGTH);
              expect(Math.abs(t.homeZ[f]!)).toBeLessThanOrEqual(HALF_WIDTH);
            }
          }
          for (const p of st.players) {
            if (p.active !== 1) continue;
            expect(p.homeX).toBe(st.teams[p.team]!.homeX[p.formIdx]);
            expect(p.homeZ).toBe(st.teams[p.team]!.homeZ[p.formIdx]);
          }
          return false;
        },
      });
      for (const team of [0, 1]) {
        const grid = changes[team]!.filter((t) => t > 1);
        expect(grid.length).toBeGreaterThan(30);
        for (const t of grid) expect(t % I).toBe(team === 0 ? 0 : I >> 1);
      }
    });

  it('HOLD_SHAPE jobs (ai/jobs.ts resetJobs) target the home this module wrote', () => {
    const s = inPlay(FormationId.F4231);
    s.tick++;
    for (const team of [0, 1]) {
      updateShape(s, team, NULL_SINK);
      resetJobs(s, team);
      for (let i = team * 11; i < team * 11 + 11; i++) {
        const p = s.players[i]!;
        if (p.job !== AiJob.HOLD_SHAPE) continue;
        expect(p.tgtX).toBe(p.homeX);
        expect(p.tgtZ).toBe(p.homeZ);
        expect(p.homeX).toBe(s.teams[team]!.homeX[p.formIdx]);
      }
    }
  });

  it('a red card mid-match: within one shape interval a team-mate covers the vacated centre-back spot', () => {
    const s = inPlay(FormationId.F442, 11);
    runTicks(s, 60, (tick, st) => driveBall(tick, st));
    const p = s.players[2]!; // home centre-back
    p.active = 0; p.x = 0; p.z = HALF_WIDTH + 5; p.vx = 0; p.vz = 0;
    s.teams[0]!.onPitch = 10;
    runTicks(s, T_AI.shapeInterval, (tick, st) => driveBall(tick, st));
    const t = s.teams[0]!;
    const cover = s.players.filter((q) => q.team === 0 && q.active === 1 && q.formIdx !== 2 && q.homeX === t.homeX[2] && q.homeZ === t.homeZ[2]);
    expect(cover).toHaveLength(1);
    // Nobody else shares a home with anyone (no stacking after the reshape).
    const homes = s.players.filter((q) => q.team === 0 && q.active === 1).map((q) => `${q.homeX},${q.homeZ}`);
    expect(new Set(homes).size).toBe(homes.length);
  });

  it('updateShape in the pipeline equals homePositionAt on the state of the update tick', () => {
    const s = inPlay(FormationId.F352, 3);
    s.teams[0]!.phase = TeamPhase.ATTACK;
    runTicks(s, 5, (tick, st) => driveBall(tick, st)); // tick 6 is team 0's next update
    driveBall(6, s); // what the inputs callback does before tick 6
    s.teams[0]!.shapeT = 0; // force a recompute on this exact state
    const o = { x: 0, z: 0 };
    const expected: number[] = [];
    for (let f = 0; f < 11; f++) { homePositionAt(s, 0, f, s.ball.x, s.ball.z, o); expected.push(o.x, o.z); }
    s.tick++;
    updateShape(s, 0, NULL_SINK);
    const got: number[] = [];
    for (let f = 0; f < 11; f++) got.push(s.teams[0]!.homeX[f]!, s.teams[0]!.homeZ[f]!);
    expect(got).toEqual(expected);
  });

  it('deterministic: two identical runs give identical state hashes every tick', () => {
    const run = (): number[] => {
      const s = inPlay(FormationId.F41212, 99);
      s.teams[0]!.extraStriker = 1;
      s.teams[1]!.getInBox = 1;
      const hashes: number[] = [];
      runTicks(s, 300, undefined, { until: (st) => { hashes.push(hashState(st)); return false; } });
      return hashes;
    };
    const a = run();
    expect(a).toHaveLength(300);
    expect(run()).toEqual(a);
  });
});
