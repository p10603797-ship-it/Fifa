/**
 * [QF-11 skeptic] Whole bot matches at Beginner (T_LEVEL.reactionTicks 80: the longest CPU reaction delay). While the
 * ball is loose (not our own pass in flight) the team's chaser must be someone who actually goes for it: never, for
 * more than the chaser hysteresis, a CPU-controlled player still keeping his old run elsewhere (TAI-11 branch 2) while an
 * AI-driven teammate would get there sooner. Before the fix 34 such stretches of 20-74 ticks in 4 short matches (the
 * chase left to a player running the other way: nobody went for the ball). Real pipeline, 2-minute halves.
 */
import { describe, expect, it } from 'vitest';
import { CPU_CONTROLLER_BASE, PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { Difficulty, MatchPhase } from '../../src/contracts/enums';
import { T_AI } from '../../src/contracts/tuning';
import { createInterceptEstimate, estimateIntercept } from '../../src/ai/steer';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';

const IE = createInterceptEstimate();
const IE2 = createInterceptEstimate();

describe('QF-11 skeptic: Beginner loose balls always have a chaser who goes for them', () => {
  const stretches: string[] = [];
  let delayedChaserTicks = 0;
  for (let m = 0; m < 4; m++) {
    const config = soakConfig(m, 77, { halfMinutes: 2, difficulty: Difficulty.BEGINNER });
    let prevPhase = -1;
    const run = [0, 0];
    runMatch({
      config, checker: 'none', fastCutscenes: true,
      onTick: (s) => {
        const live = s.match.phase === MatchPhase.IN_PLAY && prevPhase === MatchPhase.IN_PLAY;
        prevPhase = s.match.phase;
        const b = s.ball;
        for (let t = 0; t < 2; t++) {
          let bad = false;
          const brain = s.teams[t]!.cpu;
          const ch = s.teams[t]!.chaser;
          const ownPass = b.passTarget >= 0 && b.lastTouchTeam === t && s.players[b.passTarget]!.team === t;
          if (live && !ownPass && b.owner < 0 && b.heldBy < 0 && brain.reactT > 0 && ch >= t * PLAYERS_PER_TEAM &&
            ch < (t + 1) * PLAYERS_PER_TEAM && s.players[ch]!.ctrl >= CPU_CONTROLLER_BASE) {
            delayedChaserTicks++;
            const p = s.players[ch]!;
            estimateIntercept(s, ch, IE);
            const dx = IE.x - p.x, dz = IE.z - p.z, d = Math.hypot(dx, dz);
            const toward = d > 1e-6 ? (p.vx * dx + p.vz * dz) / d : 0;
            if (d > 2 && toward < 0.5) {
              for (let i = t * PLAYERS_PER_TEAM; i < (t + 1) * PLAYERS_PER_TEAM; i++) {
                const q = s.players[i]!;
                if (i === ch || q.active !== 1 || q.isKeeper === 1 || q.ctrl >= 0) continue;
                estimateIntercept(s, i, IE2);
                if (IE2.ballT + T_AI.chaserHysteresisTicks < IE.ballT + brain.reactT) { bad = true; break; }
              }
            }
          }
          if (bad) run[t]!++;
          else {
            if (run[t]! >= 20 && stretches.length < 10) stretches.push(`m${m} t${s.tick} team ${t}: ${run[t]} ticks`);
            run[t] = 0;
          }
        }
      },
    });
  }

  it('the scan saw CPU-controlled chasers in their reaction delay (control)', () => {
    expect(delayedChaserTicks).toBeGreaterThan(1000);
  });

  it('glitch: two teammates chase or nobody does — never 20+ ticks of the chase left to a CPU player still running elsewhere in his reaction delay while a teammate would get there sooner', () => {
    expect(stretches).toEqual([]);
  });
});
