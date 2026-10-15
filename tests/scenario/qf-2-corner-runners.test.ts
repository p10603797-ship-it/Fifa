/**
 * [QF-2 skeptic] QF-4 CR (src/ai/setpieces.ts, TAI-13): CPU corners were crossed into a box with 1-2 attackers
 * (mean 1.57 at the kick over 40 Professional bot matches, soak seed 77, 2-minute halves). The CPU crosses about 2 s
 * after the set-up (RUL-04 / RUL-05 took their own Default at cpuRestartDelay + 60), the box runners came from 30-45 m
 * and dropped to a jog for their last 15 m, and the cross waited for them only up to cpuRestartDelay + 45.
 * Fix: box runners keep running at farFrac until they are within arriveTol of their spot, the cross waits up to
 * cpuRestartDelay + maxArrivalWait (just before the fallback), and box spots weigh the distance more (cornerRunWd).
 * [QF-11] RUL-04 / RUL-05 cpuGraceTicks 140 (QF-10) and TAI-13 maxArrivalWait 120. Corners fell to ~0.4 a match once
 * defenders stopped "receiving" shots (QF-9), so 8 short matches no longer hold enough corners: each case now plays a
 * real Professional bot match (soak seed 77) to a seeded point of open play and awards a corner there to the side in
 * possession (8 corners, both ends, both teams), then records the take. Awarded from anywhere in open play (runners
 * often 40 m away), most of these crosses go at the end of the wait; real corners come from attacks near the box (the
 * QF-4 CR test qf-4-cr-corner-box pins at least 3 attackers in the box at real CPU corner kicks).
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, HALF_WIDTH, NUM_SLOTS } from '../../src/contracts/constants';
import { AiJob, Difficulty, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { T_RULES } from '../../src/contracts/tuning';
import { LOCAL_TUNING as SP } from '../../src/ai/setpieces';
import { NULL_SINK } from '../../src/sim/core/events';
import { possessingTeam } from '../../src/sim/core/query';
import { awardRestart } from '../../src/sim/rules/restart';
import { LOCAL_TUNING as CORNER_LT } from '../../src/sim/rules/corner';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';
import { runTicks } from '../harness/scenario';

const inBox = (x: number, z: number, dir: number): boolean => x * dir > HALF_LENGTH - 16.5 && Math.abs(z) < 20.16;

describe('QF-2 CPU corners: box runners', () => {
  const slow: string[] = [];
  const kicks: { t: number; n: number }[] = [];
  let runnerTicks = 0;
  for (let m = 0; m < 8; m++) {
    const config = soakConfig(m, 77, { halfMinutes: 2, difficulty: Difficulty.PROFESSIONAL });
    const s = runMatch({ config, checker: 'none', fastCutscenes: true, maxTicks: 1500 + 173 * m }).state;
    runTicks(s, 1200, undefined, { until: (st) => st.match.phase === MatchPhase.IN_PLAY && possessingTeam(st) >= 0 });
    if (s.match.phase !== MatchPhase.IN_PLAY) continue;
    const team = possessingTeam(s);
    if (team < 0) continue;
    const dir = s.teams[team]!.dir;
    awardRestart(s, RestartKind.CORNER, team, dir * HALF_LENGTH, (m & 2) === 0 ? HALF_WIDTH : -HALF_WIDTH, NULL_SINK);
    let lastT = 0;
    runTicks(s, 900, undefined, {
      until: (st, ev) => {
        const r = st.match.restart;
        if (st.match.phase === MatchPhase.CORNER) {
          lastT = r.t;
          if (r.ready !== 1) return false;
          for (let k = team * 11; k < team * 11 + 11; k++) {
            const p = st.players[k]!;
            if (p.active !== 1 || p.job !== AiJob.SET_PIECE || !inBox(p.tgtX, p.tgtZ, dir) || p.ctrl >= 0) continue;
            const d = Math.hypot(p.tgtX - p.x, p.tgtZ - p.z);
            if (d <= SP.arriveTol + 0.5) continue;
            runnerTicks++;
            const top = st.attrs[k]!.topSpeed;
            if (p.tgtSpeed < top * SP.farFrac - 1e-6 && slow.length < 5) slow.push(`m${m} t${st.tick} slot ${k} ${d.toFixed(1)} m out at ${p.tgtSpeed.toFixed(1)} m/s`);
          }
          return false;
        }
        for (const e of ev) {
          if (e.type !== EventType.KICK) continue;
          let n = 0;
          for (let k = 0; k < NUM_SLOTS; k++) {
            const p = st.players[k]!;
            if (p.active !== 1 || p.team !== team || k === e.a || p.isKeeper === 1) continue;
            if (inBox(p.x, p.z, dir)) n++;
          }
          kicks.push({ t: lastT, n });
          return true;
        }
        return true; // the phase left CORNER without a kick this tick (e.g. a re-award): stop
      },
    });
  }

  it('box runners run (farFrac of top speed) all the way to their corner spot, never a jog for the last 15 m', () => {
    expect(runnerTicks).toBeGreaterThan(200);
    expect(slow).toEqual([]);
  });

  it('a CPU corner cross waits for three box runners up to just before the RUL-04 fallback (cpuRestartDelay + maxArrivalWait)', () => {
    expect(kicks.length).toBeGreaterThanOrEqual(6);
    for (const k of kicks) {
      const age = k.t - T_RULES.restartSetupTicks;
      // Taken early only with three runners in the box; otherwise at the end of the wait (a few input ticks later).
      if (k.n < SP.minBoxArrivals) expect(age, JSON.stringify(kicks)).toBeGreaterThanOrEqual(T_RULES.cpuRestartDelay + SP.maxArrivalWait);
    }
    // The wait (and the aim before the tap) ends before RUL-04's CPU fallback Default.
    expect(SP.maxArrivalWait + Math.max(SP.aimTicks, SP.shotAimTicks)).toBeLessThan(CORNER_LT.cpuGraceTicks);
  });
});
