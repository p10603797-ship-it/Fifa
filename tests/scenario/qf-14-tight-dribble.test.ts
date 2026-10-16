/**
 * [QF-14] TAI-08 dribble risk in the attacking half. The carrier priced a dribble's loss chance there at
 * dribbleLossMax x pressure only (about 13%), whatever room the carry had: into a defender holding his ground in front
 * (TAI-11 patience, qf-14-escort) the CPU still drove at him with the drive credit (driveShotShare of the shot at the
 * carry's end), and lost it, instead of the open pass. In the attacking half the loss now also grows with the lack of
 * room, x (1 + dribbleTightAttackMul x (1 - TAI-10 dribble score)), as it did in our own half
 * (dribbleTightLossMul), the same at every level.
 */
import { describe, expect, it } from 'vitest';
import { CPU_CONTROLLER_BASE } from '../../src/contracts/constants';
import { Difficulty, MatchPhase } from '../../src/contracts/enums';
import { createInputFrame } from '../../src/contracts/input';
import { CpuPlan, type SimState } from '../../src/contracts/state';
import { T_CPU } from '../../src/contracts/tuning';
import { CARRIER_DRIBBLE, cpuCarrier, LOCAL_TUNING as CARRIER } from '../../src/ai/cpu/carrier';
import { NULL_SINK } from '../../src/sim/core/events';
import { makeScenario, type ScenarioPlayer } from '../harness/scenario';

/** Team 0 attacks +x; everybody parked far away unless placed; `carrier` owns the ball at his feet. */
function scene(at: Record<number, [number, number]>, seed: number): SimState {
  const players: ScenarioPlayer[] = [];
  for (let i = 0; i < 22; i++) {
    const park: [number, number] = i === 0 ? [-51, 0] : i === 11 ? [51, 0] : i < 11 ? [-40 + i, -30 + i * 2] : [-30 + i, 30 - (i - 11) * 2];
    const [x, z] = at[i] ?? park;
    players.push({ slot: i, x, z, vx: 0, vz: 0, fx: i < 11 ? 1 : -1, fz: 0, homeX: x, homeZ: z });
  }
  const c = players[9]!;
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: 0, seed, config: { difficulty: Difficulty.LEGEND }, players,
    ball: { x: c.x! + 0.5, y: 0.11, z: c.z!, owner: 9, ownerT: 200, lastTouch: 9, lastTouchTeam: 0 },
  });
  s.ctrl[CPU_CONTROLLER_BASE]!.slot = 9;
  s.players[9]!.ctrl = CPU_CONTROLLER_BASE;
  return s;
}

/** The first plan the carrier commits to (a few decisions). */
function firstPlan(s: SimState): CpuPlan {
  for (let i = 0; i < 40; i++) {
    s.tick++;
    cpuCarrier(s, 0, createInputFrame(), NULL_SINK);
    const p = s.teams[0]!.cpu.plan;
    if (p !== CpuPlan.NONE && p !== CpuPlan.HOLD) return p;
  }
  return s.teams[0]!.cpu.plan;
}

describe('QF-14 TAI-08: no drive into a defender holding his ground', () => {
  it('reads T_CPU and is on', () => {
    expect(CARRIER.dribbleTightAttackMul).toBe(T_CPU.carrierDribbleTightAttackMul);
    expect(CARRIER.dribbleTightAttackMul).toBeGreaterThan(0);
  });

  it('in the attacking half a carry with no room risks more than one into space under the same pressure', () => {
    // The same man 1.3 m ahead (the same pressure); boxed: five more round him at 1.8-2.2 m (TAI-10 finds little room).
    const open = scene({ 9: [22.5, 0], 14: [23.8, 0.3] }, 3);
    const boxed = scene({ 9: [22.5, 0], 14: [23.8, 0.3], 15: [23.5, 2.0], 16: [23.5, -2.0], 17: [21.0, 1.8], 18: [21.0, -1.8], 19: [20.3, 0] }, 3);
    firstPlan(open);
    const keepOpen = CARRIER_DRIBBLE[0]!, scOpen = CARRIER_DRIBBLE[1]!;
    firstPlan(boxed);
    const keepBoxed = CARRIER_DRIBBLE[0]!, scBoxed = CARRIER_DRIBBLE[1]!;
    expect(scBoxed).toBeLessThan(scOpen - 0.15);
    // Before: the attacking half's loss ignored the room (keepBoxed === keepOpen at equal pressure).
    expect(keepBoxed).toBeLessThan(keepOpen - 0.001);
    // ... by the documented factor (1 + dribbleTightAttackMul x (1 - score)) on the loss.
    const lossOpen = 1 - keepOpen, lossBoxed = 1 - keepBoxed;
    const w = CARRIER.dribbleTightAttackMul;
    const ratio = (1 + w * (1 - scBoxed)) / (1 + w * (1 - scOpen));
    expect(lossBoxed / lossOpen).toBeCloseTo(ratio, 1);
  });
});
