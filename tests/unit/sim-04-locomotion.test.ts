/**
 * SIM-04 locomotion and stamina: speeds, acceleration, turning, arrival (orbit / jitter regression), jockey and
 * shield movement, stamina, boards and goal frames (walk-through regression), ticksToReach accuracy, determinism,
 * robustness and the per-tick budget. Players are driven by writing their movement intent and calling
 * locomotionTick directly (the stage under test), on a state built by initMatch.
 */
import { describe, expect, it } from 'vitest';
import {
  BOARD_X, BOARD_Z, GOAL_DEPTH, GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS, POST_RADIUS,
} from '../../src/contracts/constants';
import { ActionKind } from '../../src/contracts/enums';
import { createMatchConfig, MoveMode, type PlayerAttrs, type PlayerState, type SimState } from '../../src/contracts/state';
import { T_PLAYER } from '../../src/contracts/tuning';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import {
  accelFor, confinePlayer, LOCAL_TUNING, locomotionTick, maxSpeed, staminaFactor, ticksToReach, ticksToReachAtSpeed,
  topSpeedFor, turnRateFor,
} from '../../src/sim/players/locomotion';
import { CLUBS } from '../../src/data/clubs';

const ev = createEventBuffer();
const BASE = initMatch(createMatchConfig());
const DT = 1 / 60;
const R = T_PLAYER.bodyRadius;
const STOP = T_PLAYER.arriveStop;

interface Solo { s: SimState; p: PlayerState; a: PlayerAttrs }

/** A state with only `slot` active, standing at the origin facing +x, with attribute overrides. */
function solo(opts: { attrs?: Partial<PlayerAttrs>; p?: Partial<PlayerState>; slot?: number } = {}): Solo {
  const s = cloneState(BASE);
  for (let i = 0; i < NUM_SLOTS; i++) s.players[i]!.active = 0;
  const slot = opts.slot ?? 5;
  const p = s.players[slot]!;
  const a = s.attrs[slot]!;
  Object.assign(a, { acceleration: 50, sprintSpeed: 50, agility: 50, stamina: 50 }, opts.attrs ?? {});
  a.topSpeed = topSpeedFor(a);
  a.accel = accelFor(a);
  Object.assign(p, {
    active: 1, x: 0, z: 0, vx: 0, vz: 0, fx: 1, fz: 0, moveMode: MoveMode.STOP, ix: 0, iz: 0, tgtX: 0, tgtZ: 0,
    tgtSpeed: 0, wantSprint: 0, lookAt: 0, lookX: 0, lookZ: 0, stamina: 1, act: ActionKind.NONE,
  }, opts.p ?? {});
  return { s, p, a };
}
function run(s: SimState, n: number, each?: (i: number) => void): void {
  for (let i = 0; i < n; i++) { if (each) each(i); locomotionTick(s, ev); }
}
const speed = (p: PlayerState): number => Math.hypot(p.vx, p.vz);
const jogOf = (a: PlayerAttrs): number => a.topSpeed * T_PLAYER.jogFraction;
function direct(p: PlayerState, ix: number, iz: number, sprint = 0): void {
  p.moveMode = MoveMode.DIRECT; p.ix = ix; p.iz = iz; p.wantSprint = sprint;
}
function arrive(p: PlayerState, x: number, z: number, cap: number): void {
  p.moveMode = MoveMode.ARRIVE; p.tgtX = x; p.tgtZ = z; p.tgtSpeed = cap;
}
/** Deterministic test RNG (LCG). */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}
/** Strictly inside a goal box (either end) for a player centre, using the module's geometry. */
function insideGoalBox(p: PlayerState): boolean {
  const ax = Math.abs(p.x);
  const front = p.isKeeper === 1 ? HALF_LENGTH : HALF_LENGTH - R;
  const back = HALF_LENGTH + GOAL_DEPTH + R;
  const side = GOAL_HALF_WIDTH + POST_RADIUS + R;
  return ax > front + 1e-9 && ax < back - 1e-9 && Math.abs(p.z) < side - 1e-9;
}

// ================================================================ speeds and acceleration

describe('SIM-04 top speed, jog and acceleration', () => {
  it('top speeds span 7.0-9.6 m/s by attribute (and every squad player is inside the range)', () => {
    expect(topSpeedFor({ ...BASE.attrs[5]!, sprintSpeed: 1, acceleration: 1 })).toBeCloseTo(7.0, 9);
    expect(topSpeedFor({ ...BASE.attrs[5]!, sprintSpeed: 99, acceleration: 99 })).toBeCloseTo(9.6, 9);
    let prev = 0;
    for (let v = 1; v <= 99; v++) {
      const t = topSpeedFor({ ...BASE.attrs[5]!, sprintSpeed: v, acceleration: 50 });
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
    for (const club of CLUBS) for (const pl of club.squad) {
      const t = topSpeedFor(pl as unknown as PlayerAttrs);
      expect(t).toBeGreaterThanOrEqual(7.0);
      expect(t).toBeLessThanOrEqual(9.6);
    }
    expect(accelFor({ ...BASE.attrs[5]!, acceleration: 1 })).toBeCloseTo(T_PLAYER.accelMin, 9);
    expect(accelFor({ ...BASE.attrs[5]!, acceleration: 99 })).toBeCloseTo(T_PLAYER.accelMax, 9);
  });

  it('a full sprint reaches the attribute top speed (slow 7.0 and fast 9.6 players)', () => {
    for (const v of [1, 99]) {
      const { s, p, a } = solo({ attrs: { sprintSpeed: v, acceleration: v } });
      direct(p, 1, 0, 1);
      run(s, 360);
      expect(speed(p)).toBeCloseTo(a.topSpeed, 6);
      expect(a.topSpeed).toBeCloseTo(v === 1 ? 7.0 : 9.6, 6);
      expect(p.sprinting).toBe(1);
    }
  });

  it('jog is 60% of top speed at full stick; partial stick jogs proportionally; sprint needs only a firm stick', () => {
    const { s, p, a } = solo();
    direct(p, 0, 1, 0);
    run(s, 240);
    expect(speed(p)).toBeCloseTo(0.6 * a.topSpeed, 6);
    expect(p.sprinting).toBe(0);
    p.z = -30;
    direct(p, 0, 0.5, 0);
    run(s, 240);
    expect(speed(p)).toBeCloseTo(0.3 * a.topSpeed, 6);
    p.z = -30;
    direct(p, 0, LOCAL_TUNING.sprintStickFull, 1);
    run(s, 360);
    expect(speed(p)).toBeCloseTo(a.topSpeed, 6);
  });

  it('0 -> top speed takes a believable 1.0-3.0 s, quicker with a higher acceleration attribute', () => {
    const times: number[] = [];
    for (const acc of [1, 50, 99]) {
      const { s, p, a } = solo({ attrs: { acceleration: acc, sprintSpeed: 70 } });
      direct(p, 1, 0, 1);
      let t = 0;
      while (speed(p) < 0.95 * a.topSpeed && t < 600) { locomotionTick(s, ev); t++; }
      times.push(t / 60);
    }
    for (const t of times) { expect(t).toBeGreaterThanOrEqual(1.0); expect(t).toBeLessThanOrEqual(3.0); }
    expect(times[0]!).toBeGreaterThan(times[1]!);
    expect(times[1]!).toBeGreaterThan(times[2]!);
  });

  it('STOP brakes at T_PLAYER.decel and keeps the facing', () => {
    const { s, p, a } = solo();
    direct(p, 1, 0, 1);
    run(s, 360);
    const v0 = speed(p);
    p.moveMode = MoveMode.STOP;
    let t = 0;
    while (speed(p) > 0 && t < 200) { locomotionTick(s, ev); t++; }
    expect(t).toBe(Math.ceil(v0 / (T_PLAYER.decel * DT) - 1e-9));
    expect(p.fx).toBeCloseTo(1, 9);
    expect(speed(p)).toBe(0);
    expect(a.topSpeed).toBeGreaterThan(0);
  });

  it('LOCKED applies friction only: direction and facing untouched, no flags', () => {
    const { s, p } = solo({ p: { vx: 6, vz: 6, fx: 0, fz: 1, moveMode: MoveMode.LOCKED, wantSprint: 1, lookAt: 1, lookX: -5, lookZ: 0 } });
    const v0 = speed(p);
    run(s, 10);
    expect(speed(p)).toBeCloseTo(v0 - LOCAL_TUNING.lockedFriction * 10 * DT, 9);
    expect(p.vx).toBeCloseTo(p.vz, 12);
    expect(p.fx).toBe(0);
    expect(p.fz).toBe(1);
    expect(p.sprinting + p.jockeying + p.shielding).toBe(0);
  });
});

// ================================================================ turning

describe('SIM-04 turning', () => {
  it('turn rate tightens at low speed, grows with agility, and is lower when sprinting', () => {
    const a = solo().a;
    expect(turnRateFor(a, 0, false)).toBeCloseTo(T_PLAYER.turnRateSlow * (1 + T_PLAYER.agilityTurnScale * (2 * 49 / 98 - 1)), 9);
    expect(turnRateFor(a, a.topSpeed, false)).toBeLessThan(turnRateFor(a, 0.5 * a.topSpeed, false));
    expect(turnRateFor(a, 0.5 * a.topSpeed, false)).toBeLessThan(turnRateFor(a, 0, false));
    expect(turnRateFor(a, 5, true)).toBeCloseTo(turnRateFor(a, 5, false) * T_PLAYER.sprintTurnMul, 12);
    const agile = solo({ attrs: { agility: 99 } }).a;
    const stiff = solo({ attrs: { agility: 1 } }).a;
    expect(turnRateFor(agile, 5, false)).toBeGreaterThan(turnRateFor(stiff, 5, false));
  });

  it('turn radius is larger when sprinting (90-degree cut at jog vs at sprint)', () => {
    const forward: number[] = [];
    for (const sprint of [0, 1]) {
      const { s, p } = solo();
      direct(p, 1, 0, sprint);
      run(s, 360);
      const x0 = p.x;
      direct(p, 0, 1, sprint);
      let t = 0;
      while (Math.atan2(p.vz, p.vx) < Math.PI / 2 - 0.02 && t < 300) { locomotionTick(s, ev); t++; }
      expect(t).toBeLessThan(60);
      forward.push(p.x - x0); // distance carried along the old direction while turning ~ turn radius
    }
    expect(forward[1]!).toBeGreaterThan(2 * forward[0]!);
    expect(forward[0]!).toBeLessThan(1.0);
    expect(forward[1]!).toBeLessThan(3.0);
  });

  it('the facing turns toward the movement direction at the turn rate, not instantly', () => {
    const { s, p, a } = solo();
    direct(p, 1, 0, 0);
    run(s, 240);
    const sp = speed(p);
    direct(p, 0, 1, 0);
    run(s, 1);
    const turned = Math.atan2(p.fz, p.fx);
    expect(turned).toBeGreaterThan(0);
    expect(turned).toBeLessThanOrEqual(turnRateFor(a, sp, false) * LOCAL_TUNING.facingTurnMul * DT + 1e-9);
    run(s, 40);
    expect(p.fz).toBeGreaterThan(Math.cos(0.02));
  });

  it('a standing player turns his body as he sets off and never sets off backwards at speed', () => {
    const { s, p } = solo();
    direct(p, -1, 0, 1);
    run(s, 1);
    expect(p.vx).toBeLessThanOrEqual(0);
    expect(speed(p)).toBeLessThan(0.15);
    let maxBack = 0;
    run(s, 30, () => { if (p.fx > 0) maxBack = Math.max(maxBack, -p.vx); });
    expect(maxBack).toBeLessThan(1.0); // speed while still facing the old way stays low
    expect(p.fx).toBeLessThan(-0.99);
  });

  it('sprint reversal: a hard U-turn, no orbit (bounded sideways drift, turned within 1 s)', () => {
    const { s, p } = solo();
    direct(p, 1, 0, 1);
    run(s, 360);
    direct(p, -1, 0, 1);
    let t = 0;
    let maxZ = 0;
    while (p.vx >= 0 && t < 200) { locomotionTick(s, ev); t++; maxZ = Math.max(maxZ, Math.abs(p.z)); }
    expect(t / 60).toBeLessThan(1.0);
    run(s, 120, () => { maxZ = Math.max(maxZ, Math.abs(p.z)); });
    expect(maxZ).toBeLessThan(3);
    expect(p.vx).toBeLessThan(0);
    expect(Math.abs(p.vz)).toBeLessThan(0.05);
  });
});

// ================================================================ arrival: "Players: orbit or jitter around a target"

describe('SIM-04 arrival (regression: Players: orbit or jitter around a target)', () => {
  const cases: [number, number, number, number, number][] = [
    // tgtX, tgtZ, vx0, vz0, tgtSpeed
    [10, 0, 0, 0, 9], [3, 4, 0, 0, 5], [5, 0, 0, 8, 9], [2, 0, -8, 0, 9], [1, 0, 0, 0, 3], [0.3, 0.1, 0, 0, 5],
    [20, 5, 7, 0, 4], [-6, -6, 5, 5, 8], [0, 2, 6, 0, 2], [0, -8, 7, 0, 9], [15, -2, 0, -6, 9], [-1, 0, 8, 0, 9],
  ];
  for (const [tx, tz, vx0, vz0, cap] of cases) {
    it(`Players: orbit or jitter around a target - static target (${tx}, ${tz}) from v=(${vx0}, ${vz0}) cap ${cap}`, () => {
      const { s, p } = solo({ p: { vx: vx0, vz: vz0, fx: vx0 || vz0 ? vx0 / Math.hypot(vx0, vz0) : 1, fz: vx0 || vz0 ? vz0 / Math.hypot(vx0, vz0) : 0 } });
      arrive(p, tx, tz, cap);
      let firstIn = -1;
      let leftAfter = 0;
      let swept = 0;
      let prevAng = Math.atan2(p.z - tz, p.x - tx);
      let settled = -1;
      let lastX = 0;
      let lastZ = 0;
      let movedAfterSettle = 0;
      for (let i = 1; i <= 600; i++) {
        locomotionTick(s, ev);
        const d = Math.hypot(p.x - tx, p.z - tz);
        const ang = Math.atan2(p.z - tz, p.x - tx);
        let da = ang - prevAng;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        if (d > 0.05) swept += da;
        prevAng = ang;
        if (firstIn < 0 && d <= STOP) firstIn = i;
        if (firstIn > 0 && d > STOP) leftAfter++;
        if (settled > 0 && (p.x !== lastX || p.z !== lastZ)) movedAfterSettle++;
        if (settled < 0 && speed(p) === 0 && d <= STOP) settled = i;
        lastX = p.x; lastZ = p.z;
      }
      expect(firstIn).toBeGreaterThan(0);
      expect(leftAfter).toBe(0); // no overshoot / oscillation once on the spot
      expect(Math.abs(swept)).toBeLessThan(Math.PI); // never circles the target
      expect(settled).toBeGreaterThan(0);
      expect(settled - firstIn).toBeLessThan(90); // stops within 1.5 s of reaching the spot
      expect(movedAfterSettle).toBe(0); // and then stands perfectly still
      expect(p.sprinting).toBe(0);
    });
  }

  for (const u of [0.1, 0.3, 0.5, 1, 2]) {
    it(`Players: orbit or jitter around a target - slowly moving target at ${u} m/s is followed smoothly and stopped at`, () => {
      const { s, p, a } = solo();
      let tx = 2;
      let tz = 0;
      arrive(p, tx, tz, jogOf(a));
      let starts = 0;
      let reversals = 0;
      let maxD = 0;
      let stopped = false;
      let pvx = 0;
      let pvz = 0;
      for (let i = 1; i <= 600; i++) {
        tx += u * DT;
        tz = 0.5 * Math.sin(i / 120);
        p.tgtX = tx; p.tgtZ = tz;
        locomotionTick(s, ev);
        const sp = speed(p);
        if (i > 120) {
          if (stopped && sp > 0) starts++;
          if (pvx * p.vx + pvz * p.vz < 0) reversals++;
          maxD = Math.max(maxD, Math.hypot(p.x - tx, p.z - tz));
        }
        stopped = sp === 0;
        pvx = p.vx; pvz = p.vz;
      }
      expect(starts).toBe(0); // no stop-go
      expect(reversals).toBe(0); // no back-and-forth
      expect(maxD).toBeLessThan(1.0);
      // The target stops: the player stops on it within 3 s and stays still.
      let still = -1;
      for (let i = 1; i <= 300; i++) {
        const x0 = p.x, z0 = p.z;
        locomotionTick(s, ev);
        const d = Math.hypot(p.x - tx, p.z - tz);
        if (still < 0 && speed(p) === 0 && d <= STOP) still = i;
        if (still > 0) { expect(p.x).toBe(x0); expect(p.z).toBe(z0); }
      }
      expect(still).toBeGreaterThan(0);
      expect(still).toBeLessThan(180);
    });
  }

  it('Players: orbit or jitter around a target - a target wobbling by a few centimetres causes no micro-steps', () => {
    const { s, p, a } = solo();
    const rnd = lcg(7);
    arrive(p, 6, 2, jogOf(a));
    let moving = 0;
    for (let i = 1; i <= 900; i++) {
      p.tgtX = 6 + (rnd() - 0.5) * 0.06;
      p.tgtZ = 2 + (rnd() - 0.5) * 0.06;
      locomotionTick(s, ev);
      if (i > 300 && speed(p) > 0) moving++;
    }
    expect(moving).toBe(0);
    expect(Math.hypot(p.x - 6, p.z - 2)).toBeLessThanOrEqual(STOP);
  });

  it('a standing player whose new target is within arriveStop does not step', () => {
    const { s, p } = solo();
    arrive(p, 0.2, 0.1, 5);
    run(s, 120);
    expect(p.x).toBe(0);
    expect(p.z).toBe(0);
  });

  it('ARRIVE respects tgtSpeed, can exceed jog without wantSprint, and sets the sprinting flag above jog', () => {
    const { s, p, a } = solo();
    arrive(p, 60, 0, 3);
    run(s, 180);
    expect(speed(p)).toBeCloseTo(3, 9);
    expect(p.sprinting).toBe(0);
    arrive(p, 60, 0, 99);
    run(s, 180);
    expect(speed(p)).toBeCloseTo(a.topSpeed, 6);
    expect(p.sprinting).toBe(1);
  });
});

// ================================================================ jockey, strafe, shield

describe('SIM-04 jockey / strafe / shield', () => {
  it('lookAt: faces the look point and moves sideways/backward at jockeySpeedFraction of jog, forward faster', () => {
    const { s, p, a } = solo();
    p.lookAt = 1; p.lookX = 1e5; p.lookZ = 0; // far away: the look direction stays +x
    const jog = jogOf(a);
    for (const [ix, iz, frac] of [[0, 1, T_PLAYER.jockeySpeedFraction], [-1, 0, T_PLAYER.jockeySpeedFraction],
      [0, -1, T_PLAYER.jockeySpeedFraction], [1, 0, LOCAL_TUNING.jockeyForwardFraction]] as const) {
      direct(p, ix, iz, 0);
      run(s, 120);
      expect(speed(p)).toBeCloseTo(jog * frac, 6);
      const lx = p.lookX - p.x, lz = p.lookZ - p.z, ll = Math.hypot(lx, lz);
      expect(p.fx * lx / ll + p.fz * lz / ll).toBeGreaterThan(0.999);
      expect(p.jockeying).toBe(1);
      expect(p.sprinting).toBe(0);
    }
    // Sprint jockey: faster sideways shuffle (fraction of top speed), still jockeying.
    direct(p, 0, 1, 1);
    run(s, 120);
    expect(speed(p)).toBeCloseTo(a.topSpeed * T_PLAYER.jockeySpeedFraction, 6);
    expect(p.jockeying).toBe(1);
    expect(p.sprinting).toBe(0);
  });

  it('lookAt turns the body faster (jockeyTurnMul) and keeps facing a moving look target', () => {
    const plain = solo();
    direct(plain.p, 0, -1, 0);
    run(plain.s, 1);
    const plainStep = Math.abs(Math.atan2(plain.p.fz, plain.p.fx));
    const jk = solo({ p: { lookAt: 1, lookX: 0, lookZ: -10 } });
    run(jk.s, 1);
    const jkStep = Math.abs(Math.atan2(jk.p.fz, jk.p.fx));
    expect(jkStep / plainStep).toBeCloseTo(T_PLAYER.jockeyTurnMul, 6);
    // A carrier circling the defender: the defender keeps facing him.
    let worst = 1;
    run(jk.s, 300, (i) => {
      jk.p.lookX = 5 * Math.cos(i / 40); jk.p.lookZ = 5 * Math.sin(i / 40);
      if (i > 30) {
        const lx = jk.p.lookX - jk.p.x, lz = jk.p.lookZ - jk.p.z, ll = Math.hypot(lx, lz);
        worst = Math.min(worst, (jk.p.fx * lx + jk.p.fz * lz) / ll);
      }
    });
    expect(worst).toBeGreaterThan(0.99);
  });

  it('SHIELD action: speed capped at shieldSpeedFraction of jog, shielding flag set, never sprinting', () => {
    const { s, p, a } = solo({ p: { act: ActionKind.SHIELD } });
    direct(p, 0, 1, 1);
    run(s, 120);
    expect(speed(p)).toBeCloseTo(jogOf(a) * T_PLAYER.shieldSpeedFraction, 6);
    expect(p.shielding).toBe(1);
    expect(p.sprinting).toBe(0);
    expect(p.jockeying).toBe(0);
    p.act = ActionKind.NONE;
    run(s, 1);
    expect(p.shielding).toBe(0);
  });

  it('AI ARRIVE with lookAt far from its target turns and runs, then faces play again when close (no flip-flop)', () => {
    const { s, p, a } = solo();
    arrive(p, -30, 0, a.topSpeed);
    p.lookAt = 1; p.lookX = 20; p.lookZ = 0;
    let toggles = 0;
    let last = -1;
    let maxSp = 0;
    run(s, 900, () => {
      if (p.jockeying !== last) { if (last >= 0) toggles++; last = p.jockeying; }
      maxSp = Math.max(maxSp, speed(p));
    });
    expect(maxSp).toBeGreaterThan(0.9 * a.topSpeed);
    expect(toggles).toBeLessThanOrEqual(2);
    expect(p.jockeying).toBe(1);
    expect(p.fx).toBeGreaterThan(0.999); // facing the look point again
    expect(Math.hypot(p.x + 30, p.z)).toBeLessThanOrEqual(STOP);
  });

  it('a keeper with lookAt always shuffles facing the ball (never turns his back)', () => {
    const { s, p, a } = solo({ slot: 0, p: { x: -40, z: 0 } });
    expect(p.isKeeper).toBe(1);
    arrive(p, -40, 15, a.topSpeed);
    p.lookAt = 1; p.lookX = 0; p.lookZ = 0;
    let minDot = 1;
    run(s, 600, (i) => {
      if (i > 20) minDot = Math.min(minDot, (p.fx * (0 - p.x) + p.fz * (0 - p.z)) / Math.hypot(p.x, p.z));
      if (i > 0) expect(p.jockeying).toBe(1);
    });
    expect(minDot).toBeGreaterThan(0.99);
    expect(Math.hypot(p.x + 40, p.z - 15)).toBeLessThanOrEqual(STOP);
  });
});

// ================================================================ stamina

describe('SIM-04 stamina', () => {
  it('staminaFactor is 1 above the low threshold and falls linearly to the floor', () => {
    const p = solo().p;
    for (const st of [1, 0.8, T_PLAYER.staminaLowThreshold]) { p.stamina = st; expect(staminaFactor(p)).toBe(1); }
    p.stamina = 0;
    expect(staminaFactor(p)).toBeCloseTo(T_PLAYER.staminaFloorMul, 12);
    p.stamina = T_PLAYER.staminaLowThreshold / 2;
    expect(staminaFactor(p)).toBeCloseTo((1 + T_PLAYER.staminaFloorMul) / 2, 12);
    let prev = 0;
    for (let st = 0; st <= 1.0001; st += 0.01) {
      p.stamina = st;
      const f = staminaFactor(p);
      expect(f).toBeGreaterThanOrEqual(prev);
      expect(f).toBeLessThanOrEqual(1);
      prev = f;
    }
  });

  it('drains while sprinting, slowly while jogging, recovers at rest (attribute 50 = the tuning rates)', () => {
    const spr = solo({ p: { x: -50, z: 20 } }); // 10 s of sprinting fits before the boards
    direct(spr.p, 1, 0, 1);
    run(spr.s, 600);
    const drainSprint = 1 - spr.p.stamina;
    expect(drainSprint).toBeGreaterThan(T_PLAYER.staminaDrainSprint * 10 * 0.95);
    expect(drainSprint).toBeLessThanOrEqual(T_PLAYER.staminaDrainSprint * 10 * 1.0001);
    const jogger = solo({ p: { x: -50, z: 20 } });
    direct(jogger.p, 1, 0, 0);
    run(jogger.s, 600);
    const drainJog = 1 - jogger.p.stamina;
    expect(drainJog).toBeGreaterThan(T_PLAYER.staminaDrainJog * 10 * 0.85);
    expect(drainJog).toBeLessThanOrEqual(T_PLAYER.staminaDrainJog * 10 * 1.0001);
    const rest = solo({ p: { stamina: 0.5 } });
    run(rest.s, 600);
    expect(rest.p.stamina - 0.5).toBeCloseTo(T_PLAYER.staminaRecover * 10, 9);
    const walker = solo({ p: { stamina: 0.5 } });
    direct(walker.p, 0.3, 0, 0);
    run(walker.s, 600);
    expect(walker.p.stamina).toBeGreaterThan(0.5); // walking is resting
  });

  it('the stamina attribute scales drain and recovery', () => {
    const drain = (st: number): number => { const t = solo({ attrs: { stamina: st }, p: { x: -50, z: 20 } }); direct(t.p, 1, 0, 1); run(t.s, 600); return 1 - t.p.stamina; };
    expect(drain(99)).toBeLessThan(drain(50));
    expect(drain(50)).toBeLessThan(drain(1));
    const rec = (st: number): number => { const t = solo({ attrs: { stamina: st }, p: { stamina: 0.3 } }); run(t.s, 600); return t.p.stamina; };
    expect(rec(99)).toBeGreaterThan(rec(1));
  });

  it('low stamina cuts top speed and acceleration; maxSpeed reflects it', () => {
    const fresh = solo();
    const tired = solo({ p: { stamina: 0 } });
    expect(maxSpeed(tired.s, 5, true)).toBeCloseTo(fresh.a.topSpeed * T_PLAYER.staminaFloorMul, 9);
    expect(maxSpeed(fresh.s, 5, false)).toBeCloseTo(fresh.a.topSpeed * T_PLAYER.jogFraction, 9);
    direct(fresh.p, 1, 0, 1);
    direct(tired.p, 1, 0, 1);
    run(fresh.s, 30);
    run(tired.s, 30);
    expect(speed(tired.p)).toBeCloseTo(speed(fresh.p) * T_PLAYER.staminaFloorMul, 6); // accel cut too
    run(fresh.s, 330);
    run(tired.s, 330);
    expect(speed(fresh.p)).toBeCloseTo(fresh.a.topSpeed, 6);
    expect(speed(tired.p)).toBeCloseTo(fresh.a.topSpeed * T_PLAYER.staminaFloorMul, 6);
    expect(tired.p.stamina).toBe(0);
  });

  it('stamina stays inside [0, 1]', () => {
    const t = solo({ p: { stamina: 0.001 } });
    direct(t.p, 1, 0, 1);
    run(t.s, 120);
    expect(t.p.stamina).toBe(0);
    const r = solo({ p: { stamina: 0.9999 } });
    run(r.s, 120);
    expect(r.p.stamina).toBe(1);
  });
});

// ================================================================ boards and goal frames

describe('SIM-04 boards and goal frames (regression: Players: walk through the goal frame or net)', () => {
  it('Players: walk through the goal frame or net - running into the goal mouth stops at the frame', () => {
    for (const end of [1, -1]) {
      const { s, p } = solo({ p: { x: end * 45, z: 1 } });
      direct(p, end, 0, 1);
      run(s, 240, () => expect(insideGoalBox(p)).toBe(false));
      run(s, 1);
      expect(p.x).toBeCloseTo(end * (HALF_LENGTH - R), 9);
      expect(p.vx).toBe(0);
      expect(insideGoalBox(p)).toBe(false);
    }
  });

  it('Players: walk through the goal frame or net - side netting and the back of the net block from outside', () => {
    const side = solo({ p: { x: 53.5, z: 10 } });
    direct(side.p, 0, -1, 1);
    run(side.s, 180, () => expect(insideGoalBox(side.p)).toBe(false));
    expect(side.p.z).toBeCloseTo(GOAL_HALF_WIDTH + POST_RADIUS + R, 9);
    const back = solo({ p: { x: -57, z: -1 } });
    direct(back.p, 1, 0, 1);
    run(back.s, 180, () => expect(insideGoalBox(back.p)).toBe(false));
    expect(back.p.x).toBeCloseTo(-(HALF_LENGTH + GOAL_DEPTH + R), 9);
  });

  it('Players: walk through the goal frame or net - random runs round both goals never enter a goal box', () => {
    const rnd = lcg(42);
    for (let n = 0; n < 300; n++) {
      const end = n % 2 === 0 ? 1 : -1;
      const ang = rnd() * Math.PI * 2;
      const rad = 4 + rnd() * 5;
      const { s, p } = solo({ p: { x: end * (HALF_LENGTH + 1) + Math.cos(ang) * rad, z: Math.sin(ang) * rad } });
      const dir = rnd() * Math.PI * 2;
      // Aim roughly at the goal half the time.
      const tx = end * (HALF_LENGTH + 1) - p.x, tz = -p.z, tl = Math.hypot(tx, tz);
      if (rnd() < 0.5) direct(p, tx / tl, tz / tl, rnd() < 0.5 ? 1 : 0); else direct(p, Math.cos(dir), Math.sin(dir), rnd() < 0.5 ? 1 : 0);
      for (let i = 0; i < 150; i++) {
        if (i % 30 === 29) { const d2 = rnd() * Math.PI * 2; p.ix = Math.cos(d2); p.iz = Math.sin(d2); }
        locomotionTick(s, ev);
        if (insideGoalBox(p)) throw new Error(`case ${n}: inside a goal box at (${p.x}, ${p.z}) tick ${i}`);
      }
    }
  });

  it('Players: walk through the goal frame or net - the keeper may stand on his line but never behind it', () => {
    const { s, p } = solo({ slot: 0, p: { x: -50, z: 0.5 } });
    direct(p, -1, 0, 1);
    run(s, 180, () => expect(p.x).toBeGreaterThanOrEqual(-HALF_LENGTH));
    expect(p.x).toBe(-HALF_LENGTH);
    // Along the line from post to post he can move freely.
    direct(p, 0, 1, 0);
    run(s, 60);
    expect(p.x).toBe(-HALF_LENGTH);
    expect(p.z).toBeGreaterThan(2);
  });

  it('Players: walk through the goal frame or net - an ARRIVE target in the net stops at the mouth', () => {
    const { s, p, a } = solo({ p: { x: 40, z: 1 } });
    arrive(p, 54, 1, a.topSpeed);
    run(s, 600, () => expect(insideGoalBox(p)).toBe(false));
    expect(speed(p)).toBe(0);
    expect(p.x).toBeGreaterThan(HALF_LENGTH - R - STOP);
    expect(p.x).toBeLessThanOrEqual(HALF_LENGTH - R);
  });

  it('Players: walk through the goal frame or net - ARRIVE from behind the goal detours round the net', () => {
    for (const [x0, z0, tx, tz] of [[56, 0, 48, 0], [55.5, 2, 50, -2], [-56, -1, -46, 3], [53, 0.5, 30, 0]]) {
      const { s, p, a } = solo({ p: { x: x0!, z: z0! } });
      arrive(p, tx!, tz!, a.topSpeed);
      let t = 0;
      while (Math.hypot(p.x - tx!, p.z - tz!) > STOP && t < 600) {
        locomotionTick(s, ev);
        t++;
        expect(insideGoalBox(p)).toBe(false);
      }
      expect(t).toBeLessThan(480);
    }
  });

  it('players never pass the advertising boards (all four sides)', () => {
    for (const [x0, z0, ix, iz] of [[50, 20, 1, 0], [-50, 20, -1, 0], [0, 35, 0, 1], [0, -35, 0, -1], [55, 37, 0.7, 0.7]]) {
      const { s, p } = solo({ p: { x: x0!, z: z0! } });
      direct(p, ix!, iz!, 1);
      run(s, 300, () => {
        expect(Math.abs(p.x)).toBeLessThanOrEqual(BOARD_X - R);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(BOARD_Z - R);
      });
      if (ix !== 0) expect(Math.abs(p.x)).toBe(BOARD_X - R);
      if (iz !== 0) expect(Math.abs(p.z)).toBe(BOARD_Z - R);
    }
  });

  it('confinePlayer pushes a player who was shoved into the net back out', () => {
    const { s, p } = solo({ p: { x: 53.2, z: 0.5, vx: 2, vz: 0 } });
    confinePlayer(s, 5, 53.2, 0.5);
    expect(p.x).toBeCloseTo(HALF_LENGTH - R, 12);
    expect(p.vx).toBe(0);
    expect(insideGoalBox(p)).toBe(false);
    p.x = -53.0; p.z = 3.5; p.vz = -1;
    confinePlayer(s, 5, -53.0, 4.5); // came in through the +z side netting
    expect(p.z).toBeCloseTo(GOAL_HALF_WIDTH + POST_RADIUS + R, 12);
    expect(p.vz).toBe(0);
  });
});

// ================================================================ ticksToReach

describe('SIM-04 ticksToReach', () => {
  /** Simulated ticks to come within reachRadius, re-aiming the stick every tick (sprint or jog). */
  function simulate(s: SimState, slot: number, tx: number, tz: number, sprint: number): number {
    const p = s.players[slot]!;
    p.moveMode = MoveMode.DIRECT;
    p.wantSprint = sprint;
    let t = 0;
    for (; t < 3000; t++) {
      const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
      if (d <= LOCAL_TUNING.reachRadius) break;
      p.ix = dx / d; p.iz = dz / d;
      locomotionTick(s, ev);
    }
    return t;
  }
  function randomCase(rnd: () => number): { s: SimState; slot: number; tx: number; tz: number } {
    const slot = 1 + Math.floor(rnd() * 10);
    const { s, p, a } = solo({ slot, attrs: { acceleration: 1 + rnd() * 98, sprintSpeed: 1 + rnd() * 98, agility: 1 + rnd() * 98 } });
    const moving = rnd() < 0.6;
    const hd = rnd() * Math.PI * 2;
    const sp = moving ? 0.5 + rnd() * (a.topSpeed - 0.5) : 0;
    p.vx = Math.cos(hd) * sp; p.vz = Math.sin(hd) * sp;
    const fd = moving ? hd : rnd() * Math.PI * 2;
    p.fx = Math.cos(fd); p.fz = Math.sin(fd);
    p.stamina = rnd() < 0.3 ? rnd() * 0.45 : 1;
    const dist = 3 + rnd() * 27, td = rnd() * Math.PI * 2; // reachable: inside the boards, clear of the goals
    return { s, slot, tx: Math.cos(td) * dist, tz: Math.sin(td) * dist };
  }

  it('is within 15% of the simulated sprint time (random positions, velocities, facings, attributes, stamina)', () => {
    const rnd = lcg(2024);
    let worst = 0;
    for (let n = 0; n < 400; n++) {
      const c = randomCase(rnd);
      const est = ticksToReach(c.s, c.slot, c.tx, c.tz);
      const sim = simulate(c.s, c.slot, c.tx, c.tz, 1);
      worst = Math.max(worst, Math.abs(est - sim) / sim);
    }
    expect(worst).toBeLessThan(0.15);
  });

  it('ticksToReachAtSpeed (jog cap) is within 15% of the simulated jog time', () => {
    const rnd = lcg(99);
    let worst = 0;
    for (let n = 0; n < 300; n++) {
      const c = randomCase(rnd);
      const est = ticksToReachAtSpeed(c.s, c.slot, c.tx, c.tz, maxSpeed(c.s, c.slot, false));
      const sim = simulate(c.s, c.slot, c.tx, c.tz, 0);
      worst = Math.max(worst, Math.abs(est - sim) / sim);
    }
    expect(worst).toBeLessThan(0.15);
  });

  it('is monotonic in distance along any direction', () => {
    const rnd = lcg(5);
    for (let n = 0; n < 60; n++) {
      const c = randomCase(rnd);
      const dir = rnd() * Math.PI * 2;
      const p = c.s.players[c.slot]!;
      let prev = -1;
      for (let d = 0; d <= 50; d += 0.1) {
        const t = ticksToReach(c.s, c.slot, p.x + Math.cos(dir) * d, p.z + Math.sin(dir) * d);
        expect(t).toBeGreaterThanOrEqual(prev);
        prev = t;
      }
    }
  });

  it('is 0 within reach, adds a locked action, and ranks fast/fresh players ahead of slow/tired ones', () => {
    const { s, p } = solo();
    expect(ticksToReach(s, 5, 0.1, 0.1)).toBe(0);
    const base = ticksToReach(s, 5, 20, 0);
    p.moveMode = MoveMode.LOCKED; p.act = ActionKind.SLIDE_TACKLE; p.actT = 10; p.actDur = 40;
    expect(ticksToReach(s, 5, 20, 0)).toBe(base + 30);
    const fast = solo({ attrs: { sprintSpeed: 95, acceleration: 95 } });
    const slow = solo({ attrs: { sprintSpeed: 20, acceleration: 20 } });
    expect(ticksToReach(fast.s, 5, 25, 5)).toBeLessThan(ticksToReach(slow.s, 5, 25, 5));
    const tired = solo({ p: { stamina: 0.05 } });
    expect(ticksToReach(tired.s, 5, 25, 5)).toBeGreaterThan(base);
    // Moving away from the point costs more than moving toward it.
    const toward = solo({ p: { vx: 6 } });
    const away = solo({ p: { vx: -6, fx: -1 } });
    expect(ticksToReach(away.s, 5, 20, 0)).toBeGreaterThan(ticksToReach(toward.s, 5, 20, 0));
  });
});

// ================================================================ determinism, robustness, budget

describe('SIM-04 determinism, robustness and budget', () => {
  /** All 22 players active, spread out, with a mix of intents that change over time. */
  function busy(): SimState {
    const s = cloneState(BASE);
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p = s.players[i]!;
      p.active = 1;
      p.x = -45 + (i % 11) * 9; p.z = -25 + Math.floor(i / 11) * 50 * 0.5 + (i % 3) * 7;
      p.stamina = 0.3 + (i % 7) * 0.1;
    }
    return s;
  }
  function drive(s: SimState, tick: number): void {
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p = s.players[i]!;
      const k = (i + Math.floor(tick / 50)) % 5;
      p.lookAt = k === 3 ? 1 : 0; p.lookX = 0; p.lookZ = 0;
      if (k === 0 || k === 3) { p.moveMode = MoveMode.DIRECT; p.ix = Math.cos(tick / 30 + i); p.iz = Math.sin(tick / 30 + i); p.wantSprint = i & 1; }
      else if (k === 1 || k === 4) { p.moveMode = MoveMode.ARRIVE; p.tgtX = 20 * Math.cos(i + tick / 200); p.tgtZ = 15 * Math.sin(i * 2 + tick / 150); p.tgtSpeed = 4 + (i % 5); }
      else p.moveMode = MoveMode.STOP;
    }
  }

  it('is deterministic: identical runs give bit-identical player states', () => {
    const a = busy();
    const b = busy();
    for (let t = 0; t < 900; t++) { drive(a, t); drive(b, t); locomotionTick(a, ev); locomotionTick(b, ev); }
    expect(JSON.stringify(a.players)).toBe(JSON.stringify(b.players));
  });

  it('keeps every value finite and inside the boards with hostile intents (NaN, Infinity, huge sticks)', () => {
    const s = busy();
    const rnd = lcg(31337);
    const bad = [NaN, Infinity, -Infinity, 1e300, -1e300, 0];
    for (let t = 0; t < 600; t++) {
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i]!;
        const pick = (): number => (rnd() < 0.3 ? bad[Math.floor(rnd() * bad.length)]! : (rnd() - 0.5) * 200);
        p.moveMode = Math.floor(rnd() * 4) as MoveMode;
        p.ix = pick(); p.iz = pick(); p.tgtX = pick(); p.tgtZ = pick(); p.tgtSpeed = pick();
        p.wantSprint = rnd() < 0.5 ? 1 : 0; p.lookAt = rnd() < 0.3 ? 1 : 0; p.lookX = pick(); p.lookZ = pick();
      }
      locomotionTick(s, ev);
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i]!;
        for (const v of [p.x, p.z, p.vx, p.vz, p.fx, p.fz, p.stamina]) expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(BOARD_X);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(BOARD_Z);
        expect(Math.hypot(p.fx, p.fz)).toBeCloseTo(1, 9);
        expect(insideGoalBox(p)).toBe(false);
      }
    }
  });

  it('repairs a degenerate facing and ignores inactive players', () => {
    const { s, p } = solo({ p: { fx: 0, fz: 0 } });
    s.players[6]!.x = 3; s.players[6]!.vx = 5; // inactive
    run(s, 1);
    expect(Math.hypot(p.fx, p.fz)).toBeCloseTo(1, 12);
    expect(s.players[6]!.x).toBe(3);
  });

  it('runs 22 players in < 0.15 ms per tick', () => {
    const s = busy();
    for (let t = 0; t < 600; t++) { drive(s, t); locomotionTick(s, ev); }
    let best = Infinity;
    for (let b = 0; b < 7; b++) {
      const t0 = performance.now();
      for (let t = 0; t < 2000; t++) { if ((t & 63) === 0) drive(s, t); locomotionTick(s, ev); }
      best = Math.min(best, (performance.now() - t0) / 2000);
    }
    console.log(`locomotionTick (22 players): ${(best * 1000).toFixed(1)} us`);
    expect(best).toBeLessThan(0.15);
  });
});
