/**
 * [QF-2 skeptic] QF-4 CR (src/ai/setpieces.ts, TAI-13): CPU corners were crossed into a box with 1-2 attackers
 * (mean 1.57 at the kick over 40 Professional bot matches, soak seed 77, 2-minute halves). The CPU crosses about 2 s
 * after the set-up (RUL-04 / RUL-05 take their own Default at cpuRestartDelay + 60), the box runners came from 30-45 m
 * and dropped to a jog for their last 15 m, and the cross waited for them only up to cpuRestartDelay + 45.
 * Fix: box runners keep running at farFrac until they are within arriveTol of their spot, the cross waits up to
 * cpuRestartDelay + 58 (just before the fallback), and box spots weigh the distance more (cornerRunWd). Mean 2.14 over
 * the same 40 matches; 3.1 once QF-1 lets the CPU wait longer (CR in the QF-2 report: corner / free-kick cpuGraceTicks
 * 60 -> 150, then maxArrivalWait 148), which the QF-4 CR test (qf-4-cr-corner-box) pins.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, NUM_SLOTS } from '../../src/contracts/constants';
import { AiJob, Difficulty, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { T_RULES } from '../../src/contracts/tuning';
import { LOCAL_TUNING as SP } from '../../src/ai/setpieces';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';

const inBox = (x: number, z: number, dir: number): boolean => x * dir > HALF_LENGTH - 16.5 && Math.abs(z) < 20.16;

describe('QF-2 CPU corners: box runners', () => {
  const slow: string[] = [];
  const kicks: { t: number; n: number }[] = [];
  let runnerTicks = 0;
  for (let m = 0; m < 8; m++) {
    const config = soakConfig(m, 77, { halfMinutes: 2, difficulty: Difficulty.PROFESSIONAL });
    let prev = -1;
    let lastT = 0;
    runMatch({
      config, checker: 'none', fastCutscenes: true,
      onTick: (s, ev) => {
        const was = prev;
        prev = s.match.phase;
        const r = s.match.restart;
        if (s.match.phase === MatchPhase.CORNER) {
          lastT = r.t;
          if (r.ready !== 1) return;
          const dir = s.teams[r.team]!.dir;
          for (let k = r.team * 11; k < r.team * 11 + 11; k++) {
            const p = s.players[k]!;
            if (p.active !== 1 || p.job !== AiJob.SET_PIECE || !inBox(p.tgtX, p.tgtZ, dir) || p.ctrl >= 0) continue;
            const d = Math.hypot(p.tgtX - p.x, p.tgtZ - p.z);
            if (d <= SP.arriveTol + 0.5) continue;
            runnerTicks++;
            const top = s.attrs[k]!.topSpeed;
            if (p.tgtSpeed < top * SP.farFrac - 1e-6 && slow.length < 5) slow.push(`m${m} t${s.tick} slot ${k} ${d.toFixed(1)} m out at ${p.tgtSpeed.toFixed(1)} m/s`);
          }
          return;
        }
        if (was !== MatchPhase.CORNER) return;
        for (let i = 0; i < ev.count; i++) {
          const e = ev.get(i);
          if (e.type !== EventType.KICK) continue;
          const team = s.players[e.a]!.team;
          const dir = s.teams[team]!.dir;
          let n = 0;
          for (let k = 0; k < NUM_SLOTS; k++) {
            const p = s.players[k]!;
            if (p.active !== 1 || p.team !== team || k === e.a || p.isKeeper === 1) continue;
            if (inBox(p.x, p.z, dir)) n++;
          }
          kicks.push({ t: lastT, n });
        }
      },
    });
  }

  it('box runners run (farFrac of top speed) all the way to their corner spot, never a jog for the last 15 m', () => {
    expect(runnerTicks).toBeGreaterThan(200);
    expect(slow).toEqual([]);
  });

  it('a CPU corner cross waits for three box runners up to just before the RUL-04 fallback (cpuRestartDelay + 58)', () => {
    expect(kicks.length).toBeGreaterThanOrEqual(4);
    for (const k of kicks) {
      const age = k.t - T_RULES.restartSetupTicks;
      // Taken early only with three runners in the box; otherwise at the end of the wait (a few input ticks later).
      if (k.n < SP.minBoxArrivals) expect(age, JSON.stringify(kicks)).toBeGreaterThanOrEqual(T_RULES.cpuRestartDelay + SP.maxArrivalWait);
    }
    expect(SP.maxArrivalWait).toBeGreaterThanOrEqual(55);
    expect(SP.maxArrivalWait).toBeLessThan(60); // RUL-04 / RUL-05 take their Default at cpuRestartDelay + 60
  });
});
