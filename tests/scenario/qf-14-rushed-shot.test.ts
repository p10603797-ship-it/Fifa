/**
 * [QF-14] TAI-08 rushed shots. The shot option was priced as a full-power shot (its xG), but commitShot cuts the power
 * hold to the time before a man ahead can step onto the line (quickShotTicks): with a defender in front 20-40 m out the
 * "shot" became a 1-tick tap, 17-20 m/s and lofted up to 35 degrees, that the keeper gathered or the man blocked
 * (Professional soak configs, 60 matches: 5.3 a match beyond 12 m, 0 goals in 318; 7.3 below 0.3 power, 1 goal).
 * Beyond quickShotDist a shot whose hold the cut would take below shotMinPowerShare of its planned hold is no longer
 * offered; a tap-in close to goal still is.
 */
import { describe, expect, it } from 'vitest';
import { CPU_CONTROLLER_BASE, GOAL_HALF_WIDTH, HALF_LENGTH } from '../../src/contracts/constants';
import { Difficulty, MatchPhase } from '../../src/contracts/enums';
import { createInputFrame } from '../../src/contracts/input';
import { CpuPlan, type SimState } from '../../src/contracts/state';
import { T_CPU, T_PASS } from '../../src/contracts/tuning';
import { CARRIER_DEBUG, cpuCarrier, LOCAL_TUNING as CARRIER, SHOT_OFFERED, SHOT_RUSHED } from '../../src/ai/cpu/carrier';
import { NULL_SINK } from '../../src/sim/core/events';
import { makeScenario, type ScenarioPlayer } from '../harness/scenario';

/** Team 0 attacks +x; everybody parked far away unless placed; `carrier` owns the ball at his feet. */
function scene(carrier: number, at: Record<number, [number, number]>, vel: Record<number, [number, number]> = {}): SimState {
  const players: ScenarioPlayer[] = [];
  for (let i = 0; i < 22; i++) {
    const park: [number, number] = i === 0 ? [-51, 0] : i === 11 ? [51, 0] : i < 11 ? [-40 + i, -30 + i * 2] : [-30 + i, 30 - (i - 11) * 2];
    const [x, z] = at[i] ?? park;
    const v = vel[i] ?? [0, 0];
    players.push({ slot: i, x, z, vx: v[0], vz: v[1], fx: i < 11 ? 1 : -1, fz: 0, homeX: x, homeZ: z });
  }
  const c = players[carrier]!;
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: 0, seed: 5, config: { difficulty: Difficulty.PROFESSIONAL }, players,
    ball: { x: c.x! + 0.5, y: 0.11, z: c.z!, owner: carrier, ownerT: 200, lastTouch: carrier, lastTouchTeam: 0 },
  });
  s.ctrl[CPU_CONTROLLER_BASE]!.slot = carrier;
  s.players[carrier]!.ctrl = CPU_CONTROLLER_BASE;
  return s;
}

/** Run cpuCarrier for up to n decisions' worth of ticks; the shot verdicts seen and the SHOOT plan if committed. */
function decide(s: SimState, n = 40): { shot: boolean; hold: number; why: Set<number> } {
  const why = new Set<number>();
  for (let i = 0; i < n; i++) {
    s.tick++;
    cpuCarrier(s, 0, createInputFrame(), NULL_SINK);
    why.add(CARRIER_DEBUG.shotWhy);
    const b = s.teams[0]!.cpu;
    if (b.plan === CpuPlan.SHOOT) return { shot: true, hold: b.holdTicks, why };
  }
  return { shot: false, hold: 0, why };
}

/** Shots, not carries, for these checks (as qf-2-cpu-shooting does). */
function shotsOnly<T>(fn: () => T): T {
  const lt = CARRIER as unknown as Record<string, number>;
  const keep = lt.driveShotShare!, keepLoss = lt.dribbleLossMax!;
  lt.driveShotShare = 0; lt.dribbleLossMax = 1;
  try { return fn(); } finally { lt.driveShotShare = keep; lt.dribbleLossMax = keepLoss; }
}

describe('QF-14 TAI-08: no rushed shot from range', () => {
  it('the gate is on and reads T_CPU', () => {
    expect(CARRIER.shotMinPowerShare).toBe(T_CPU.carrierShotMinPowerShare);
    expect(CARRIER.shotMinPowerShare).toBeGreaterThan(0.2);
    expect(CARRIER.shotMinPowerShare).toBeLessThan(1);
  });

  it('glitch: long shot struck as a tap — a defender stepping onto the line 20-34 m out turns the shot down (SHOT_RUSHED), the free shot is taken at full hold', () => {
    let rushed = 0;
    for (const d of [20, 26, 34]) {
      for (const z of [0, -6]) {
        const cx = HALF_LENGTH - d;
        // A defender 1.6 m ahead, just off the line to goal, stepping across it.
        const free = shotsOnly(() => decide(scene(9, { 9: [cx, z] })));
        expect(free.shot, `free d ${d} z ${z}`).toBe(true);
        const f = Math.min(1, Math.max(0, (d - CARRIER.shotNearDist) / (CARRIER.shotFarDist - CARRIER.shotNearDist)));
        const planned = Math.round((CARRIER.shotPowerNear + (CARRIER.shotPowerFar - CARRIER.shotPowerNear) * f) * T_PASS.powerFillTicks);
        expect(free.hold, `free d ${d} z ${z}`).toBeGreaterThanOrEqual(planned - 3);
        const pressed = shotsOnly(() => decide(scene(9, { 9: [cx, z], 14: [cx + 1.6, z + 0.9] }, { 14: [-1, -2] })));
        expect(pressed.shot, `pressed d ${d} z ${z}`).toBe(false);
        if (pressed.why.has(SHOT_RUSHED)) rushed++;
      }
    }
    // The rushed-shot rule is what turns them down (a man right on the line far out can also shut the lane outright).
    expect(rushed).toBeGreaterThanOrEqual(4);
  });

  it('a tap-in close to goal is still a shot with the man in front (inside quickShotDist)', () => {
    const d = CARRIER.quickShotDist - 2;
    const cx = HALF_LENGTH - d;
    const r = shotsOnly(() => decide(scene(9, { 9: [cx, 0.5], 14: [cx + 1.6, 1.3] }, { 14: [-1, -2] })));
    expect(r.shot).toBe(true);
    expect(r.why.has(SHOT_OFFERED)).toBe(true);
    expect(r.hold).toBeLessThan(Math.round(CARRIER.shotPowerNear * T_PASS.powerFillTicks));
  });

  it('a man well off the line (no cut below the share) does not stop a long shot', () => {
    const d = 24;
    const cx = HALF_LENGTH - d;
    // 6 m to the side, walking: he cannot reach the line before a full-power hold.
    const r = shotsOnly(() => decide(scene(9, { 9: [cx, 0], 14: [cx + 3, -GOAL_HALF_WIDTH - 6] }, { 14: [0, 1] })));
    expect(r.shot).toBe(true);
  });
});
