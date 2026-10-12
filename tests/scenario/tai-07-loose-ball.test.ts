/**
 * TAI-07 scenarios through the real step pipeline: the loose-ball chaser invariant every tick, chasers actually
 * reaching the ball, human chasers, and determinism (including two simulations interleaved in one process, which
 * exercises the shared per-tick prediction cache). Glitch regression: "Players: two teammates chase or nobody does".
 */
import '../../src/sim/actions/dispatch'; // load the action registry before the keeper modules (import-cycle order)
import { describe, expect, it } from 'vitest';
import { PLAYERS_PER_TEAM, teamFirstSlot } from '../../src/contracts/constants';
import { AiJob, MatchPhase } from '../../src/contracts/enums';
import { createInputFrame, type InputFrame } from '../../src/contracts/input';
import { AXIS_SCALE } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { rngFloat, rngSeed } from '../../src/sim/core/rng';
import { createInvariantChecker } from '../../src/sim/debug/invariants';
import { step } from '../../src/sim/step';
import { makeScenario, runTicks, type ScenarioOptions } from '../harness/scenario';

function chaseJobs(s: SimState, team: number): number[] {
  const out: number[] = [];
  for (let i = teamFirstSlot(team); i < teamFirstSlot(team) + PLAYERS_PER_TEAM; i++) {
    if (s.players[i]!.active === 1 && s.players[i]!.job === AiJob.CHASE_LOOSE) out.push(i);
  }
  return out;
}

function randomLoose(seed: number): ScenarioOptions {
  const r = { a: 0, b: 0, c: 0, d: 0 };
  rngSeed(r, seed * 2654435761);
  const f = (lo: number, hi: number): number => lo + (hi - lo) * rngFloat(r);
  const air = rngFloat(r) < 0.35;
  return {
    seed, phase: MatchPhase.IN_PLAY,
    ball: {
      x: f(-40, 40), z: f(-28, 28), y: air ? f(0.4, 3) : 0.11, vx: f(-22, 22), vz: f(-12, 12), vy: air ? f(2, 12) : 0,
      grounded: air ? 0 : 1, owner: -1, heldBy: -1,
    },
  };
}

describe('TAI-07 glitch: Players: two teammates chase or nobody does (full pipeline)', () => {
  it('every tick of loose play: exactly one valid chaser per team, CHASE_LOOSE only on him', () => {
    let looseTicks = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const s = makeScenario(randomLoose(seed));
      const checker = createInvariantChecker(['chaser']);
      const events = createEventBuffer();
      const frames: InputFrame[] = [createInputFrame(), createInputFrame()];
      let loose = 0;
      for (let k = 0; k < 600; k++) {
        const phaseSeenByAi = s.match.phase; // the AI runs before the rules change the phase within a tick
        step(s, frames, events);
        const fails = checker.check(s, events);
        expect(fails, `seed ${seed} tick ${s.tick}`).toEqual([]);
        const isLoose = s.match.phase === MatchPhase.IN_PLAY && s.ball.owner === -1;
        loose = isLoose ? loose + 1 : 0;
        for (let t = 0; t < 2; t++) {
          const c = s.teams[t]!.chaser;
          const jobs = chaseJobs(s, t);
          expect(jobs.length, `seed ${seed} tick ${s.tick} team ${t} CHASE_LOOSE ${jobs}`).toBeLessThanOrEqual(1);
          if (jobs.length === 1) expect(jobs[0]).toBe(c);
          if (loose > 1) {
            expect(c).toBeGreaterThanOrEqual(teamFirstSlot(t));
            expect(s.players[c]!.active).toBe(1);
          }
          if (phaseSeenByAi !== MatchPhase.IN_PLAY) expect(c, `seed ${seed} tick ${s.tick}`).toBe(-1);
        }
        if (isLoose) looseTicks++;
      }
    }
    expect(looseTicks).toBeGreaterThan(1000); // the scenarios really exercised loose play
  });

  it('the chaser actually gets to a rolling ball', () => {
    // A human on team 0 controls a far-away player (so no CPU brain drives team 0's chaser).
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY, ball: { x: 0, z: 10, vx: 7, vz: -1, owner: -1 }, humans: [{ side: 0, slot: 2 }],
    });
    // Clear the area: everyone else far away, one team-0 AI player 12 m behind the ball.
    for (let i = 1; i < 22; i++) {
      if (i === 11) continue;
      const p = s.players[i]!;
      p.x = i < 11 ? -45 : 45; p.z = -30 + 3 * (i % 11); p.homeX = p.x; p.homeZ = p.z;
    }
    const me = 6;
    Object.assign(s.players[me]!, { x: -12, z: 12, homeX: -12, homeZ: 12 });
    let minD = 99;
    runTicks(s, 360, undefined, {
      until: (st) => {
        const p = st.players[me]!;
        minD = Math.min(minD, Math.hypot(p.x - st.ball.x, p.z - st.ball.z));
        return st.ball.owner >= 0;
      },
    });
    expect(minD).toBeLessThan(1.0);
  });

  it('a human dribbling at a loose ball is his team\'s chaser; the AI teammate beside him does not also chase', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, ball: { x: 5, z: 0, vx: 0, owner: -1 }, humans: [{ side: 0, slot: 9 }] });
    Object.assign(s.players[9]!, { x: 1, z: 0, vx: 5, vz: 0, fx: 1, fz: 0 }); // already running at the ball
    Object.assign(s.players[10]!, { x: 3.6, z: 2.5 }); // AI teammate, a bit closer
    let human = 0, ticks = 0;
    runTicks(s, 90, (_tick, st, out) => {
      // Push the stick toward the ball.
      const p = st.players[9]!;
      const dx = st.ball.x - p.x, dz = st.ball.z - p.z, l = Math.hypot(dx, dz) || 1;
      out[0]!.mx = Math.round((dx / l) * AXIS_SCALE);
      out[0]!.mz = Math.round((dz / l) * AXIS_SCALE);
    }, {
      until: (st) => {
        if (st.ball.owner !== -1 || st.match.phase !== MatchPhase.IN_PLAY) return true;
        ticks++;
        if (st.teams[0]!.chaser === 9) human++;
        expect(chaseJobs(st, 0)).toEqual(st.teams[0]!.chaser === 9 ? [] : [st.teams[0]!.chaser]);
        return false;
      },
    });
    expect(ticks).toBeGreaterThan(5);
    expect(human).toBe(ticks);
  });
});

describe('TAI-07 determinism', () => {
  function hashes(opts: ScenarioOptions, n: number): number[] {
    const s = makeScenario(opts);
    const ev = createEventBuffer();
    const f = [createInputFrame(), createInputFrame()];
    const out: number[] = [];
    for (let i = 0; i < n; i++) { step(s, f, ev); out.push(hashState(s)); }
    return out;
  }

  it('same seed and inputs give the same hash every tick, also when another simulation is interleaved', () => {
    const a = randomLoose(3), b = randomLoose(7);
    const ref = hashes(a, 300);
    expect(hashes(a, 300)).toEqual(ref);
    // Interleave two simulations tick by tick (shared module scratch must not leak between them).
    const sa = makeScenario(a), sb = makeScenario(b);
    const ea = createEventBuffer(), eb = createEventBuffer();
    const f = [createInputFrame(), createInputFrame()];
    const got: number[] = [];
    for (let i = 0; i < 300; i++) {
      step(sa, f, ea);
      got.push(hashState(sa));
      step(sb, f, eb);
    }
    expect(got).toEqual(ref);
    expect(hashes(b, 300)[299]).toBe(hashState(sb));
  });
});
