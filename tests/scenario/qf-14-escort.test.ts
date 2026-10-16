/**
 * [QF-14] TAI-11 patience. The CPU's controlled defender only tackled a carrier whose ball was exposed (a skill or
 * first-touch window, the ball more than exposeDist from his feet, a turn) or on a rash lunge (decision noise, none at
 * Legend, none in the box from Professional up), and his guard point was led by the carrier's velocity, so he backed
 * off at the carrier's speed. A carrier jogging with close control (the ball 0.45-0.55 m ahead) was never exposed: in a
 * Professional soak match (seed 1 #0) two defenders escorted one carrier from the halfway line into the six-yard box for
 * 27 s without a tackle and he scored (0.6 such escorts a match, 1.35 once the rushed long shots were gone). Once the
 * carrier has had the ball T_LEVEL.patienceTicks the defender holds his ground (T_LEVEL.patienceStandoff in front of
 * where the carrier is, no velocity lead, and no step back toward his goal once goal-side): the dribbler is held up, has
 * to turn (an exposure the careful tackle takes) or pass.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, Difficulty, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_LEVEL } from '../../src/contracts/tuning';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';
import { makeScenario, runTicks } from '../harness/scenario';

const C = 9; // human carrier, team 0 (attacks +x)
const D = 15; // the defender in front of him, team 1 (CPU)

function scene(seed: number, level: Difficulty, cx: number, cz: number, gap: number): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: C }], seed, config: { difficulty: level } });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    const k = i % 11;
    if (k === 0) { p.x = i < 11 ? -51 : 51; p.z = 0; } else { p.x = -45; p.z = -30 + k * 5.5 + (i < 11 ? 0 : 2); }
    p.vx = 0; p.vz = 0; p.fx = i < 11 ? 1 : -1; p.fz = 0; p.homeX = p.x; p.homeZ = p.z;
    p.act = ActionKind.NONE; p.moveMode = MoveMode.STOP;
  }
  const q = s.players[C]!;
  q.x = cx; q.z = cz; q.vx = 4; q.fx = 1;
  const d = s.players[D]!;
  d.x = cx + gap; d.z = cz + 0.3; d.fx = -1;
  const b = s.ball;
  b.x = cx + 0.45; b.z = cz; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = 4; b.vz = 0; b.vy = 0; b.grounded = 1;
  b.owner = C; b.ownerT = 0; b.heldBy = -1; b.lastTouch = C; b.lastTouchTeam = 0;
  s.teams[1]!.cpu.level = level;
  return s;
}

/** The human jogs straight at the goal with the ball (stick +x, no sprint) until he loses it or n ticks. */
function jog(s: SimState, n: number): { events: SimEvent[]; lostAt: number; maxX: number } {
  let lostAt = -1, maxX = -1e9;
  const events = runTicks(s, n, (_t, st, out) => { out[0]!.mx = 100; out[0]!.mz = 0; void st; }, {
    until: (st) => {
      const x = st.players[C]!.x;
      if (x > maxX) maxX = x;
      if (st.ball.owner !== C && lostAt < 0) lostAt = st.tick;
      return lostAt >= 0 || st.match.phase !== MatchPhase.IN_PLAY;
    },
  });
  return { events, lostAt, maxX };
}

describe('QF-14 TAI-11: patience with a close-control dribbler', () => {
  it('reads the tables and is on at every level', () => {
    for (let lv = 0; lv < T_LEVEL.patienceTicks.length; lv++) expect(T_LEVEL.patienceTicks[lv]).toBeGreaterThan(0);
    for (let lv = 0; lv < T_LEVEL.patienceStandoff.length; lv++) expect(T_LEVEL.patienceStandoff[lv]).toBeLessThanOrEqual(1.5);
    expect(T_LEVEL.patienceStandoff[Difficulty.LEGEND]).toBeLessThanOrEqual(0.9);
  });

  it('glitch: defender jockeys a dribbler for ever — a Legend CPU defender holds up a jogging close-control carrier in midfield and wins the ball', () => {
    let won = 0, fouls = 0;
    const reach: number[] = [];
    for (let seed = 1; seed <= 6; seed++) {
      const s = scene(seed, Difficulty.LEGEND, -10, 0, 3.2);
      const r = jog(s, 420);
      won += r.events.filter((e) => e.type === EventType.TACKLE && e.b === C && e.c === 1 && s.players[e.a]!.team === 1).length;
      fouls += r.events.filter((e) => e.type === EventType.FOUL && s.players[e.a]!.team === 1 && e.c !== 0).length;
      reach.push(r.maxX);
    }
    reach.sort((a, b) => a - b);
    // Backing off at his speed, the defender let him jog 24 m upfield in 7 s every time (maxX 14, no ball won).
    expect(reach[3]!, reach.join(', ')).toBeLessThan(8);
    expect(won).toBeGreaterThanOrEqual(2);
    expect(fouls).toBeLessThanOrEqual(1);
  });

  it('glitch: defender jockeys a dribbler for ever — no escort of 8 s or more in 16 Professional soak matches', () => {
    // An escort: one carrier keeps the ball 8 s+ with an opponent within 2.5 m for 80% of it and no tackle on him.
    // Before: two of these 16 matches had one of 10-14 s ending in the box (#4, #14: a controlled defender pinned
    // beside the dribbler ran with him from 19 m out on the wing into the box), even with the hold-ground patience.
    const long: string[] = [];
    for (let m = 0; m < 16; m++) {
      const config = soakConfig(m, 1, { halfMinutes: 4, difficulty: Difficulty.PROFESSIONAL });
      let own = -1, start = 0, close = 0, tackled = 0, minGoal = 1e9;
      runMatch({
        config, checker: 'none', fastCutscenes: true,
        onTick: (st, ev) => {
          for (let i = 0; i < ev.count; i++) { const e = ev.get(i); if (e.type === EventType.TACKLE && e.b === own) tackled++; }
          const b = st.ball;
          const o = b.owner >= 0 && b.heldBy < 0 ? b.owner : -1;
          if (o !== own) {
            const dur = st.tick - start;
            if (own >= 0 && dur >= 480 && close >= 0.8 * dur && tackled === 0) long.push(`#${m} t${start} ${(dur / 60).toFixed(1)} s, ${minGoal.toFixed(1)} m from goal`);
            own = o; start = st.tick; close = 0; tackled = 0; minGoal = 1e9;
          }
          if (own < 0) return;
          const p = st.players[own]!;
          let nd = 1e9;
          for (let j = 0; j < 22; j++) {
            const q = st.players[j]!;
            if (q.team === p.team || q.active !== 1 || q.isKeeper === 1) continue;
            const d = Math.hypot(q.x - p.x, q.z - p.z);
            if (d < nd) nd = d;
          }
          if (nd < 2.5) close++;
          const g = Math.hypot(st.teams[p.team]!.dir * HALF_LENGTH - p.x, p.z);
          if (g < minGoal) minGoal = g;
        },
      });
    }
    expect(long).toEqual([]);
  }, 300000);
});
