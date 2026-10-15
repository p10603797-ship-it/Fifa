/**
 * [QF-11] QA-19 keeper reaction by level (T_LEVEL.keeperReactTicks, retuned to 30 / 21 / 10 / 0 / -3 / -8): a Beginner
 * keeper reacts half a second late and a Legend keeper earlier than his reflexes alone. Neither end of the table may
 * bring back the BRIEF §14 keeper glitches the QF-2 Professional scan guards: no dive that starts with the ball already
 * behind his plane (a late reaction must give up, not dive at a ball that has passed), no dive stuck past its fixed
 * duration. Whole bot matches through the real pipeline (tools/headless runMatch), short halves, every tick scanned.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { ActionKind, Difficulty, MatchPhase } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { T_LEVEL } from '../../src/contracts/tuning';
import { LOCAL_TUNING as KIN } from '../../src/sim/keeper/saveKinematics';
import { keeperReactionTicks } from '../../src/sim/keeper/saves';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';

/** Distance of x from team t's own goal line (>= 0 in front of it). */
function depthOf(s: SimState, team: number, x: number): number {
  return HALF_LENGTH + s.teams[team]!.dir * x;
}

interface Scan { dives: number; lateDives: string[]; stuck: string[]; ticks: number; react: number[] }

/** Run `n` bot matches at `level` (both sides, 2-minute halves) and scan every tick for late and stuck dives. */
function scanLevel(level: Difficulty, n: number, seed: number): Scan {
  const out: Scan = { dives: 0, lateDives: [], stuck: [], ticks: 0, react: [] };
  for (let m = 0; m < n; m++) {
    const config = soakConfig(m, seed, { halfMinutes: 2, difficulty: level });
    const prevAct = [ActionKind.NONE, ActionKind.NONE];
    const diveStart = [-1, -1];
    const diveDur = [0, 0];
    runMatch({
      config, checker: 'core', fastCutscenes: true,
      onTick: (s) => {
        out.ticks++;
        for (let t = 0; t < 2; t++) {
          const ks = s.teams[t]!.keeperSlot;
          if (ks < 0) continue;
          const k = s.players[ks]!;
          if (out.react.length < 2 * n) out.react.push(keeperReactionTicks(s, ks));
          if (k.act === ActionKind.GK_DIVE && prevAct[t] !== ActionKind.GK_DIVE) {
            out.dives++;
            diveStart[t] = s.tick;
            diveDur[t] = k.actDur;
            const bd = depthOf(s, t, s.ball.px), kd = depthOf(s, t, k.x);
            if (bd < kd - KIN.planeBackReach - 0.3 && s.match.phase === MatchPhase.IN_PLAY) {
              out.lateDives.push(`m${m} t${s.tick} team ${t}: dive with the ball ${(kd - bd).toFixed(2)} m behind him`);
            }
          }
          if (k.act === ActionKind.GK_DIVE && diveStart[t]! >= 0 && s.tick - diveStart[t]! > diveDur[t]! + 1) {
            out.stuck.push(`m${m} t${s.tick} team ${t}: still diving ${s.tick - diveStart[t]!} ticks (dur ${diveDur[t]})`);
            diveStart[t] = -1;
          }
          if (k.act !== ActionKind.GK_DIVE) diveStart[t] = -1;
          prevAct[t] = k.act;
        }
      },
    });
  }
  return out;
}

describe('QF-11 keeper reaction by level keeps the keeper glitches away', () => {
  const beginner = scanLevel(Difficulty.BEGINNER, 4, 0x11b);
  const legend = scanLevel(Difficulty.LEGEND, 4, 0x11e);

  it('the level part is really applied: a Beginner keeper reacts later than a Legend one (>= 0 ticks always)', () => {
    expect(T_LEVEL.keeperReactTicks[Difficulty.BEGINNER]!).toBeGreaterThan(T_LEVEL.keeperReactTicks[Difficulty.LEGEND]!);
    const minB = Math.min(...beginner.react), maxL = Math.max(...legend.react);
    expect(Math.min(...legend.react)).toBeGreaterThanOrEqual(0);
    expect(minB).toBeGreaterThan(maxL);
  });

  it('both scans saw real keeper work (dives)', () => {
    expect(beginner.dives).toBeGreaterThan(0);
    expect(legend.dives).toBeGreaterThan(0);
  });

  it('glitch: Keeper dives after the ball has passed — a slow Beginner keeper never starts a dive at a ball behind him', () => {
    expect(beginner.lateDives).toEqual([]);
  });

  it('glitch: Keeper dives after the ball has passed — nor does a sharp Legend keeper', () => {
    expect(legend.lateDives).toEqual([]);
  });

  it('glitch: Keeper stays stuck in a dive — every dive ends within its fixed duration at both ends of the ladder', () => {
    expect(beginner.stuck).toEqual([]);
    expect(legend.stuck).toEqual([]);
  });
});
