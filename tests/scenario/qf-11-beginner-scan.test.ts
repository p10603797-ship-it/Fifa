/**
 * [QF-11] Whole bot matches at Beginner (the longest reaction delay, T_LEVEL.reactionTicks 80 ticks): while a CPU's
 * controlled player keeps his run during the delay (TAI-08 carrier emitCarry, TAI-11 defender momentum) he never runs
 * off the pitch. Before the fix 13 such runs went 1.5 m past a line in 6 short matches (a defender's or carrier's run
 * held straight over the touchline). Real pipeline (tools/headless runMatch), 2-minute halves, every tick scanned.
 */
import { describe, expect, it } from 'vitest';
import { CPU_CONTROLLER_BASE, HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { Difficulty, MatchPhase } from '../../src/contracts/enums';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';

describe('QF-11 Beginner reaction delay keeps players on the pitch', () => {
  const offRuns: string[] = [];
  let reacting = 0;
  for (let m = 0; m < 4; m++) {
    const config = soakConfig(m, 99, { halfMinutes: 2, difficulty: Difficulty.BEGINNER });
    runMatch({
      config, checker: 'none', fastCutscenes: true,
      onTick: (s) => {
        if (s.match.phase !== MatchPhase.IN_PLAY) return;
        for (let t = 0; t < 2; t++) {
          const brain = s.teams[t]!.cpu;
          if (brain.active !== 1 || brain.reactT <= 0) continue;
          for (let i = t * 11; i < t * 11 + 11; i++) {
            const p = s.players[i]!;
            if (p.active !== 1 || p.ctrl < CPU_CONTROLLER_BASE) continue;
            // Our own pass in flight to him: SIM-15's receiver collect steers him (TAI-11 branch 1, no delay), and an
            // overhit pass may be followed to where it comes down beyond the line (not the reaction delay).
            const b = s.ball;
            if (b.owner < 0 && b.passTarget === i && b.lastTouchTeam === t) continue;
            reacting++;
            const out = Math.max(Math.abs(p.x) - HALF_LENGTH, Math.abs(p.z) - HALF_WIDTH);
            if (out > 1 && offRuns.length < 10) offRuns.push(`m${m} t${s.tick} slot ${i}: ${out.toFixed(2)} m off, reactT ${brain.reactT}`);
          }
        }
      },
    });
  }

  it('the scan saw controlled players in their reaction delay (control)', () => {
    expect(reacting).toBeGreaterThan(1000);
  });

  it('a CPU player keeping his run in the reaction delay is never more than 1 m past a touchline or goal line', () => {
    expect(offRuns).toEqual([]);
  });
});
