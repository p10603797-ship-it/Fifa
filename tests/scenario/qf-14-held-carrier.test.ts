/**
 * [QF-14 skeptic] TAI-11 patience, nearby inputs of the still-carrier challenge (qf-14-still-carrier):
 *  - A carrier walking the ball into the defender. The CPU's controlled defender tackles an exposed ball (more than
 *    exposeDist from the carrier's feet, a turn, a skill or first-touch window), a rash lunge (decision noise: none at
 *    Legend) or, since the resume, a carrier standing still (slower than defendStillSpeed, untouched for
 *    defendStillTouchTicks + tackle timing). A human walking at the goal with the stick part-way (1-2 m/s, the ball
 *    0.5 m ahead, touched every ~10 ticks) is none of these: the patient Legend defender's guard point (0.9 m in front
 *    of him) moved with him, so he was pushed back 23 m in 25 s with the ball at his feet, never challenged (8 of 8
 *    seeds kept the ball for 10 s, gaining 6-11 m). Now a carrier who has had the ball T_CPU.defendHeldTicks, slower
 *    than T_CPU.defendHeldSpeed, between touches, with the ball presented to the defender (within his reach on his
 *    side of the carrier's body, now and at contact: SIM-14 ball-first) is challenged too.
 *  - Box care. In our own area the careful tackles of World Class / Legend want the ball clear of the carrier's body
 *    (T_LEVEL.boxBodyClear, QF-13 skeptic: their penalties); the still challenge did not ask, and a human standing on
 *    the ball in the box was given a penalty in 2 of 12 scenes at each of the two levels.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, Difficulty, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { type InputFrame } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_CPU } from '../../src/contracts/tuning';
import { makeScenario, runTicks } from '../harness/scenario';

const C = 9; // human carrier, team 0 (attacks +x)
const D = 15; // CPU defender, team 1

function scene(seed: number, level: Difficulty, x: number, z: number, gap: number): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: C }], seed, config: { difficulty: level } });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    const k = i % 11;
    if (k === 0) { p.x = i < 11 ? -51 : 51; p.z = 0; } else { p.x = -45; p.z = -30 + k * 5.5 + (i < 11 ? 0 : 2); }
    p.vx = 0; p.vz = 0; p.fx = i < 11 ? 1 : -1; p.fz = 0; p.homeX = p.x; p.homeZ = p.z;
    p.act = ActionKind.NONE; p.moveMode = MoveMode.STOP;
  }
  const q = s.players[C]!;
  q.x = x; q.z = z; q.fx = 1; q.fz = 0;
  q.lastTouchTick = s.tick;
  const d = s.players[D]!;
  d.x = x + gap; d.z = z + 0.3; d.fx = -1;
  const b = s.ball;
  b.x = x + 0.45; b.z = z; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = 0; b.vz = 0; b.vy = 0; b.grounded = 1;
  b.owner = C; b.ownerT = 0; b.heldBy = -1; b.lastTouch = C; b.lastTouchTeam = 0;
  s.teams[1]!.cpu.level = level;
  return s;
}

interface Run { events: SimEvent[]; kept: boolean; gained: number; ticks: number }

function run(s: SimState, n: number, stick: (t: number, f: InputFrame) => void): Run {
  const x0 = s.players[C]!.x, t0 = s.tick;
  const events = runTicks(s, n, (t, _st, out) => stick(t, out[0]!), {
    until: (st) => st.ball.owner !== C || st.match.phase !== MatchPhase.IN_PLAY,
  });
  return {
    events, kept: s.ball.owner === C && s.match.phase === MatchPhase.IN_PLAY, gained: s.players[C]!.x - x0, ticks: s.tick - t0,
  };
}

const fouls = (r: Run, s: SimState): SimEvent[] =>
  r.events.filter((e) => e.type === EventType.FOUL && s.players[e.a]!.team === 1);

describe('QF-14 skeptic TAI-11: a carrier walking the ball into a patient defender is challenged', () => {
  it('reads T_CPU', () => {
    expect(T_CPU.defendHeldSpeed).toBeGreaterThan(T_CPU.defendStillSpeed);
    expect(T_CPU.defendHeldSpeed).toBeLessThan(4);
    expect(T_CPU.defendHeldTicks).toBeGreaterThan(0);
    expect(T_CPU.defendHeldTicks).toBeLessThanOrEqual(240);
  });

  it('glitch: defender jockeys a dribbler for ever — a Legend / World Class defender challenges a carrier walking the ball into him', () => {
    const kept: string[] = [];
    let won = 0, foul = 0;
    for (const level of [Difficulty.WORLD_CLASS, Difficulty.LEGEND]) {
      for (const mag of [35, 50]) {
        for (let seed = 1; seed <= 4; seed++) {
          const s = scene(seed, level, 10 - seed, 5 - seed, 3);
          const r = run(s, 600, (_t, f) => { f.mx = mag; });
          // Before: at Legend he walked on with the ball for the whole 10 s in every case (6-11 m gained). The challenge
          // waits until he has had the ball T_CPU.defendHeldTicks (3 s).
          if (r.kept || r.ticks > 360 || r.gained > 9) {
            kept.push(`level ${level} stick ${mag} seed ${seed}: kept ${r.kept} after ${r.ticks} ticks, ${r.gained.toFixed(1)} m`);
          }
          won += r.events.filter((e) => e.type === EventType.TACKLE && e.b === C && e.c === 1).length;
          foul += fouls(r, s).length;
        }
      }
    }
    expect(kept).toEqual([]);
    // A fair contest (SIM-14 front tackle at a ball at his feet, the carrier within body contact): about as many fouls
    // as balls won (12 / 12 here; a Professional match has ~13 fouls from ~35 tackles), never a foul-fest.
    expect(won).toBeGreaterThanOrEqual(8);
    expect(foul).toBeLessThanOrEqual(won + 4);
  });

  it('a carrier strafing side to side in front of a Legend defender is not hacked down (ball-first now and at contact)', () => {
    let foul = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const s = scene(seed, Difficulty.LEGEND, 10 - seed, 5 - seed, 3);
      const r = run(s, 600, (t, f) => { f.mz = Math.floor(t / 60) % 2 ? 50 : -50; });
      foul += fouls(r, s).length;
    }
    // A ball-first test at contact alone (a dribbled ball being pulled back to his feet predicted linearly) gave 17.
    expect(foul).toBeLessThanOrEqual(2);
  });

  it('box care: a carrier standing on the ball in the World Class / Legend area is not given a penalty', () => {
    const pens: string[] = [];
    for (const level of [Difficulty.WORLD_CLASS, Difficulty.LEGEND]) {
      for (let seed = 1; seed <= 12; seed++) {
        const s = scene(seed, level, 41, 3, 2);
        s.players[D]!.z = 3 + 0.3 * (seed % 2 ? 1 : -1);
        const r = run(s, 600, () => {});
        for (const e of fouls(r, s)) if (e.d === 1) pens.push(`level ${level} seed ${seed}`);
      }
    }
    // Before: 2 of 12 at each level (the still challenge into a carrier stood within body contact).
    expect(pens).toEqual([]);
  });
});
