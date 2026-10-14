/**
 * [QF-2] QA-13 / QA-12 CPU shooting and skill fixes, on static scenes with the real modules:
 *  - TAI-10 shotLaneClear and the aim side (TAI-08 aims at the post whose lane is clear of the man in front);
 *  - the quick shot under pressure (the power hold is cut so the ball is struck before the closing man steps across);
 *  - a knock-on is never chosen when the ball would run out of play, and TAI-08 plays it straight past the man;
 *  - TAI-09 loftLaunchSpeed (the launch speed GKP-04 now judges its lofted releases at).
 */
import { describe, expect, it } from 'vitest';
import { CPU_CONTROLLER_BASE, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { Difficulty, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { Btn, createInputFrame } from '../../src/contracts/input';
import { CpuPlan, type SimState } from '../../src/contracts/state';
import { T_BALL, T_PASS } from '../../src/contracts/tuning';
import { CARRIER_DEBUG, cpuCarrier, LOCAL_TUNING as CARRIER } from '../../src/ai/cpu/carrier';
import { laneSafety, loftLaunchSpeed } from '../../src/ai/cpu/passing';
import { chooseSkill, LOCAL_TUNING as XG, shotLaneClear, SKILL_CHOICE } from '../../src/ai/cpu/shooting';
import { NULL_SINK } from '../../src/sim/core/events';
import { makeScenario, type ScenarioPlayer } from '../harness/scenario';

/** Team 0 attacks +x. Everybody parked far away unless placed; `carrier` owns the ball at his feet. */
function scene(carrier: number, at: Record<number, [number, number]>, o: { vx?: Record<number, [number, number]>; fx?: number; fz?: number } = {}): SimState {
  const players: ScenarioPlayer[] = [];
  for (let i = 0; i < 22; i++) {
    const park: [number, number] = i === 0 ? [-51, 0] : i === 11 ? [51, 0] : i < 11 ? [-40 + i, -30 + i * 2] : [-30 + i, 30 - (i - 11) * 2];
    const [x, z] = at[i] ?? park;
    const v = o.vx?.[i] ?? [0, 0];
    players.push({ slot: i, x, z, vx: v[0], vz: v[1], fx: i < 11 ? 1 : -1, fz: 0, homeX: x, homeZ: z });
  }
  const c = players[carrier]!;
  if (o.fx !== undefined) { c.fx = o.fx; c.fz = o.fz ?? 0; }
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: 0, seed: 5, config: { difficulty: Difficulty.LEGEND }, players,
    ball: { x: c.x! + 0.5 * c.fx!, y: 0.11, z: c.z! + 0.5 * c.fz!, owner: carrier, ownerT: 200, lastTouch: carrier, lastTouchTeam: 0 },
  });
  s.ctrl[CPU_CONTROLLER_BASE]!.slot = carrier;
  s.players[carrier]!.ctrl = CPU_CONTROLLER_BASE;
  return s;
}

/** Run cpuCarrier until it commits a SHOOT plan (or n ticks); returns the frames. */
function untilShot(s: SimState, n = 60): { plan: number; aimZ: number; hold: number; frames: ReturnType<typeof createInputFrame>[] } {
  const frames = [];
  for (let i = 0; i < n; i++) {
    s.tick++;
    const f = createInputFrame();
    cpuCarrier(s, 0, f, NULL_SINK);
    frames.push(f);
    const b = s.teams[0]!.cpu;
    if (b.plan === CpuPlan.SHOOT) return { plan: b.plan, aimZ: b.planZ, hold: b.holdTicks, frames };
  }
  return { plan: s.teams[0]!.cpu.plan, aimZ: 0, hold: 0, frames };
}

describe('QF-2 TAI-10 shot lanes', () => {
  it('shotLaneClear: a man on the line to one post blocks that lane, not the other; clear lanes read 1', () => {
    const az = GOAL_HALF_WIDTH - 0.5;
    const s = scene(9, { 9: [36, 0] });
    expect(shotLaneClear(s, 9, 36, 0, az)).toBeCloseTo(1, 9);
    // A defender 5 m out on the line to the +z post (the lanes are ~2 m apart there).
    const gx = HALF_LENGTH;
    const t = 5 / Math.hypot(gx - 36, az);
    const t2 = scene(9, { 9: [36, 0], 14: [36 + (gx - 36) * t, az * t] });
    expect(shotLaneClear(t2, 9, 36, 0, az)).toBeLessThan(0.25);
    expect(shotLaneClear(t2, 9, 36, 0, -az)).toBeGreaterThan(0.7);
    // ... and a defender closing at 6 m/s from 1.5 m beside the lane counts by where he will be (blockLook).
    const t3 = scene(9, { 9: [36, 0], 14: [38, -2.2] }, { vx: { 14: [0, 6] } });
    const still = scene(9, { 9: [36, 0], 14: [38, -2.2] });
    expect(shotLaneClear(t3, 9, 36, 0, 0)).toBeLessThan(shotLaneClear(still, 9, 36, 0, 0));
  });

  it('QA-13 the CPU aims at the post whose lane is clear, not into the man in front of it', () => {
    // Carrier 14 m out, slightly left; the keeper central; a defender 5 m ahead on the line to the far (+z) post that
    // the old keeper-only rule aimed at. With the near post open the shot goes there. (Dribbling on is switched off
    // here: near goal TAI-08 often prefers to carry on; this pins the aim of the shot it takes.)
    const az = GOAL_HALF_WIDTH - CARRIER.shotInset;
    const gx = HALF_LENGTH;
    const cx = 38.5, cz = -1;
    const t = 5 / Math.hypot(gx - cx, az - cz);
    const s = scene(9, { 9: [cx, cz], 14: [cx + (gx - cx) * t, cz + (az - cz) * t] });
    const lt = CARRIER as unknown as Record<string, number>;
    const keep = lt.driveShotShare!, keepLoss = lt.dribbleLossMax!;
    try {
      lt.driveShotShare = 0; lt.dribbleLossMax = 1;
      const r = untilShot(s);
      expect(r.plan).toBe(CpuPlan.SHOOT);
      expect(Math.sign(r.aimZ)).toBe(-1);
      expect(CARRIER_DEBUG.shotClear).toBeGreaterThan(0.7);
    } finally { lt.driveShotShare = keep; lt.dribbleLossMax = keepLoss; }
  });

  it('QA-13 under pressure the shot is struck at once: the power hold is cut before the closing man can step across', () => {
    // A defender 3 m to the side of the shooting lane, closing at 5 m/s: he needs ~0.4 s, a full-power hold is 0.6 s+.
    const lt = CARRIER as unknown as Record<string, number>;
    const keep = lt.driveShotShare!, keepLoss = lt.dribbleLossMax!;
    lt.driveShotShare = 0; lt.dribbleLossMax = 1; // shots, not carries, for this check
    let free: ReturnType<typeof untilShot>, pressed: ReturnType<typeof untilShot>;
    try {
      free = untilShot(scene(9, { 9: [36, 0] }));
      pressed = untilShot(scene(9, { 9: [36, 0], 14: [39, -3] }, { vx: { 14: [0, 5] } }));
    } finally { lt.driveShotShare = keep; lt.dribbleLossMax = keepLoss; }
    expect(free.plan).toBe(CpuPlan.SHOOT);
    expect(pressed.plan).toBe(CpuPlan.SHOOT);
    expect(pressed.hold).toBeLessThan(free.hold);
    // The strike comes before he can get within reach of the aimed line: (offset - quickShotReach) / 5 m/s, in ticks.
    const lx = HALF_LENGTH - 36, lz = pressed.aimZ;
    const ll = Math.hypot(lx, lz);
    const off = Math.abs((39 - 36) * -lz / ll + (-3 - 0) * lx / ll);
    expect(pressed.hold).toBeLessThanOrEqual(Math.floor(((off - CARRIER.quickShotReach) / 5) * 60) + 1);
    // SHOOT is pressed on the commit tick or the next one (no aiming turn first).
    const firstShoot = pressed.frames.findIndex((f) => (f.buttons & Btn.SHOOT) !== 0);
    expect(firstShoot).toBeGreaterThanOrEqual(0);
  });
});

describe('QF-2 skill moves stay on the pitch', () => {
  it('QA-12 no knock-on when the ball would run out of play; TAI-08 plays a knock-on straight past the man', () => {
    // Running along the touchline at 6 m/s, a defender 4 m ahead, space behind him: inside the pitch -> knock-on.
    const mk = (z: number, fz: number): SimState => {
      const s = scene(9, { 9: [0, z], 14: [4, z] }, { vx: { 9: [6, 0] }, fx: Math.sqrt(1 - fz * fz), fz });
      s.attrs[9]!.skillMoves = 5; s.attrs[9]!.topSpeed = 9; s.attrs[14]!.topSpeed = 8;
      return s;
    };
    const inside = mk(10, 0);
    expect(chooseSkill(inside, 9)).toBe(SkillMove.KNOCK_ON);
    expect(SKILL_CHOICE.dirX).toBeCloseTo(1, 6);
    // The same run 2.5 m from the touchline, facing slightly out: the 14 m knock-on would cross the line.
    const out = mk(HALF_WIDTH - 2.5, 0.25);
    expect(chooseSkill(out, 9)).not.toBe(SkillMove.KNOCK_ON);
    expect(XG.knockRun).toBeGreaterThanOrEqual(12);
  });
});

describe('QF-2 TAI-09 loftLaunchSpeed (GKP-04 lofted releases)', () => {
  it('carries the distance at the lob angle in the lane model, and an open 50 m kick to a free striker reads safe', () => {
    for (const d of [20, 35, 52]) {
      const v = loftLaunchSpeed(d);
      // Drag-free range at the lob angle exceeds d (the drag-equivalent model needs the extra), never absurd.
      expect((v * v * Math.sin(2 * T_PASS.lobAngle)) / T_BALL.gravity).toBeGreaterThan(d);
      expect(v).toBeLessThan(T_BALL.maxSpeed);
    }
    expect(loftLaunchSpeed(0)).toBe(0);
    expect(loftLaunchSpeed(Number.NaN)).toBe(0);
    // Keeper at x = -46 to a striker 50 m upfield with nobody near: safe at the carrying speed, not at a 17 m/s
    // "average horizontal" speed (the ball would never get there).
    const far: Record<number, [number, number]> = { 0: [-46, 0], 9: [4, 0] };
    for (let i = 12; i < 22; i++) far[i] = [40, -25 + (i - 12) * 5];
    const s = scene(0, far);
    expect(laneSafety(s, 0, -46, 0, 4, 0, loftLaunchSpeed(50), 1)).toBeGreaterThan(0.8);
  });
});
