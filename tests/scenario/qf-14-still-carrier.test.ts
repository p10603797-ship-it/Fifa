/**
 * [QF-14 resume] TAI-11 patience with a carrier standing on the ball. The CPU's controlled defender tackles an exposed
 * ball (a touch away from the feet, a turn, a skill or first-touch window) or on a rash lunge (decision noise). A human
 * who stops with the ball at his feet exposes nothing, and Legend has no decision noise: its defender held his ground
 * 1.2 m in front of him for ever (and World Class nearly so), so standing still was a perfect way to keep the ball.
 * Once the patience is over (T_LEVEL.patienceTicks) and the carrier has not touched the ball for
 * T_CPU.defendStillTouchTicks + the level's tackleTimingTicks, he and the ball standing (defendStillSpeed), not
 * shielding, the defender goal-side with the ball in reach makes the challenge. A shielding carrier is still hard to
 * rob (SIM-05), and bot carriers never stand that long at Professional (match hashes unchanged there).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, Difficulty, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_CPU } from '../../src/contracts/tuning';
import { makeScenario, runTicks } from '../harness/scenario';

const C = 9; // human carrier, team 0
const D = 15; // CPU defender in front of him, team 1

function scene(seed: number, level: Difficulty): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: C }], seed, config: { difficulty: level } });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    const k = i % 11;
    if (k === 0) { p.x = i < 11 ? -51 : 51; p.z = 0; } else { p.x = -45; p.z = -30 + k * 5.5 + (i < 11 ? 0 : 2); }
    p.vx = 0; p.vz = 0; p.fx = i < 11 ? 1 : -1; p.fz = 0; p.homeX = p.x; p.homeZ = p.z;
    p.act = ActionKind.NONE; p.moveMode = MoveMode.STOP;
  }
  const q = s.players[C]!;
  q.x = 10 - seed; q.z = 5 - seed; q.fx = 1;
  q.lastTouchTick = s.tick; // he has just taken the ball (a carrier's last touch is always known in play)
  const d = s.players[D]!;
  d.x = q.x + 3; d.z = q.z + 0.3; d.fx = -1;
  const b = s.ball;
  b.x = q.x + 0.45; b.z = q.z; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = 0; b.vz = 0; b.vy = 0; b.grounded = 1;
  b.owner = C; b.ownerT = 0; b.heldBy = -1; b.lastTouch = C; b.lastTouchTeam = 0;
  s.teams[1]!.cpu.level = level;
  return s;
}

/** The human stands still (shielding when asked) for up to 600 ticks; when he lost the ball, tackles and fouls. */
function stand(seed: number, level: Difficulty, shield: boolean): { lostAt: number; won: number; fouls: number } {
  const s = scene(seed, level);
  const ev = runTicks(s, 600, (_t, _st, out) => { if (shield) out[0]!.buttons |= Btn.SHIELD; }, {
    until: (st) => st.ball.owner !== C || st.match.phase !== MatchPhase.IN_PLAY,
  });
  return {
    lostAt: s.ball.owner === C ? -1 : s.tick,
    won: ev.filter((e) => e.type === EventType.TACKLE && e.b === C && e.c === 1).length,
    fouls: ev.filter((e) => e.type === EventType.FOUL).length,
  };
}

describe('QF-14 TAI-11: a carrier standing on the ball is challenged', () => {
  it('reads T_CPU', () => {
    expect(T_CPU.defendStillTouchTicks).toBeGreaterThan(0);
    expect(T_CPU.defendStillTouchTicks).toBeLessThan(120);
    expect(T_CPU.defendStillSpeed).toBeGreaterThan(0);
  });

  it('glitch: defender jockeys a dribbler for ever — a Legend / World Class defender challenges a carrier standing still with the ball', () => {
    let won = 0, fouls = 0;
    const kept: string[] = [];
    for (const level of [Difficulty.WORLD_CLASS, Difficulty.LEGEND]) {
      for (let seed = 1; seed <= 4; seed++) {
        const r = stand(seed, level, false);
        // Before: the Legend defender stood 1.2 m in front of him for the whole 10 s in every case.
        if (r.lostAt < 0 || r.lostAt > 400) kept.push(`level ${level} seed ${seed}: ${r.lostAt}`);
        won += r.won; fouls += r.fouls;
      }
    }
    expect(kept).toEqual([]);
    expect(won).toBeGreaterThanOrEqual(4);
    expect(fouls).toBeLessThanOrEqual(4);
  });

  it('a shielding carrier is still hard to rob (no challenge into his back)', () => {
    let lost = 0;
    for (let seed = 1; seed <= 4; seed++) if (stand(seed, Difficulty.LEGEND, true).lostAt >= 0) lost++;
    expect(lost).toBeLessThanOrEqual(1);
  });
});
