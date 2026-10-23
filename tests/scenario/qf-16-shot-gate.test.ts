/**
 * [QF-16] TAI-08 rushed-shot gate by level. QF-14's gate (T_CPU.carrierShotMinPowerShare: beyond quickShotDist no shot
 * whose power hold the quick-shot cut would take below that share) is right for Professional and up, but at Beginner it
 * removed most shots: a Beginner side's 100-tick reaction delay lets the defence close in, so the cut nearly always
 * applied and Beginner v Beginner took 4.6 shots a match (10.5 before QF-14). The gate is now scaled per level
 * (T_LEVEL.shotRushedGateMul): the low levels still shoot, badly; Professional and up are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { CPU_CONTROLLER_BASE, HALF_LENGTH } from '../../src/contracts/constants';
import { Difficulty, MatchPhase } from '../../src/contracts/enums';
import { createInputFrame } from '../../src/contracts/input';
import { type SimState } from '../../src/contracts/state';
import { T_LEVEL } from '../../src/contracts/tuning';
import { CARRIER_DEBUG, cpuCarrier, LOCAL_TUNING as CARRIER, SHOT_OFFERED, SHOT_RUSHED } from '../../src/ai/cpu/carrier';
import { NULL_SINK } from '../../src/sim/core/events';
import { makeScenario, type ScenarioPlayer } from '../harness/scenario';

/** Team 0 (attacking +x, CPU at `level`) has the ball at slot 9's feet; slot 14 steps across his shot line. */
function scene(level: Difficulty, d: number, z: number): SimState {
  const cx = HALF_LENGTH - d;
  const at: Record<number, [number, number]> = { 9: [cx, z], 14: [cx + 1.6, z + 0.9] };
  const players: ScenarioPlayer[] = [];
  for (let i = 0; i < 22; i++) {
    const park: [number, number] = i === 0 ? [-51, 0] : i === 11 ? [51, 0] : i < 11 ? [-40 + i, -30 + i * 2] : [-30 + i, 30 - (i - 11) * 2];
    const [x, pz] = at[i] ?? park;
    players.push({ slot: i, x, z: pz, vx: i === 14 ? -1 : 0, vz: i === 14 ? -2 : 0, fx: i < 11 ? 1 : -1, fz: 0, homeX: x, homeZ: pz });
  }
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: 0, seed: 5, config: { difficulty: level }, players,
    ball: { x: cx + 0.5, y: 0.11, z, owner: 9, ownerT: 200, lastTouch: 9, lastTouchTeam: 0 },
  });
  s.teams[0]!.cpu.level = level;
  s.teams[1]!.cpu.level = level;
  s.ctrl[CPU_CONTROLLER_BASE]!.slot = 9;
  s.players[9]!.ctrl = CPU_CONTROLLER_BASE;
  return s;
}

/** The shot verdicts cpuCarrier reaches over n ticks (no reaction delay: the carrier is already on the ball). */
function verdicts(s: SimState, n = 30): Set<number> {
  const why = new Set<number>();
  const b = s.teams[0]!.cpu;
  b.seenOwner = 9; b.reactT = 0;
  for (let i = 0; i < n; i++) {
    s.tick++;
    CARRIER_DEBUG.shotWhy = -1;
    cpuCarrier(s, 0, createInputFrame(), NULL_SINK);
    if (CARRIER_DEBUG.shotWhy >= 0) why.add(CARRIER_DEBUG.shotWhy);
  }
  return why;
}

describe('QF-16 TAI-08: the rushed-shot gate by level', () => {
  it('reads the table: off at Beginner, rising to full strength at Professional and above', () => {
    const g = T_LEVEL.shotRushedGateMul;
    expect(g.length).toBe(6);
    for (let lv = Difficulty.PROFESSIONAL; lv <= Difficulty.LEGEND; lv++) expect(g[lv]).toBe(1);
    for (let lv = 1; lv < g.length; lv++) expect(g[lv]!).toBeGreaterThanOrEqual(g[lv - 1]!);
    expect(g[Difficulty.BEGINNER]!).toBeLessThan(0.5);
  });

  it('glitch: low levels never shoot — a pressed 20-26 m shot is turned down as rushed at Professional, offered at Beginner', () => {
    const rows: string[] = [];
    for (const d of [20, 26]) {
      for (const z of [0, -6]) {
        const pro = verdicts(scene(Difficulty.PROFESSIONAL, d, z));
        const beg = verdicts(scene(Difficulty.BEGINNER, d, z));
        rows.push(`d ${d} z ${z}: pro ${[...pro].join(',')} beginner ${[...beg].join(',')}`);
        expect(pro.has(SHOT_RUSHED), rows.at(-1)).toBe(true);
        expect(pro.has(SHOT_OFFERED), rows.at(-1)).toBe(false);
        // Before: the same rushed verdict at Beginner (the gate did not look at the level).
        expect(beg.has(SHOT_RUSHED), rows.at(-1)).toBe(false);
        expect(beg.has(SHOT_OFFERED), rows.at(-1)).toBe(true);
      }
    }
    expect(CARRIER.shotMinPowerShare).toBeGreaterThan(0);
  });
});
