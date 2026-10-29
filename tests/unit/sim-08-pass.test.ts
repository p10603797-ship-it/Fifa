/**
 * [SIM-08] Passing: receiver selection (direction, power, openness, assistance), pass speeds against the reference
 * feel (9-22 m/s ground, driven faster, Manual = power only), leading moving receivers, the dinked pass (clears a
 * defender's legs, model vs the real ball physics), the error model (pressure, weak foot, facing, sprint, power,
 * stamina, attributes), startPass validation and solver determinism.
 */
import { describe, expect, it } from 'vitest';
import { AssistLevel, Foot, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { createBallState, type BallState } from '../../src/contracts/state';
import { createKickLaunch, ReqFlag } from '../../src/contracts/systems';
import { T_DRIBBLE, T_PASS, T_PLAYER } from '../../src/contracts/tuning';
import { ballStepTick } from '../../src/sim/ball/contact';
import { copyBallState } from '../../src/sim/ball/flight';
import { NULL_SINK } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { rngGauss, rngSeed } from '../../src/sim/core/rng';
import {
  ballInReach, isPassKind, kickError, kickErrorAim, LOCAL_TUNING as LT, passAccuracy, selectReceiver, solveGroundPass,
  startPass,
} from '../../src/sim/kicks/pass';
import {
  fly, giveBall, hspeed, launched, MATE_A, MATE_B, MATE_C, OPP_A, OPP_B, PASSER, place, quiet, req, skill, solve,
} from './sim-08-helpers';

const A = AssistLevel.ASSISTED;
const SEMI = AssistLevel.SEMI;
const MAN = AssistLevel.MANUAL;

function angleOf(x: number, z: number): number { return Math.atan2(z, x); }

// ---------------------------------------------------------------- receiver selection

describe('SIM-08 selectReceiver', () => {
  it('follows the stick direction (idle stick = facing)', () => {
    const s = quiet();
    place(s, MATE_A, 15, 0);
    place(s, MATE_B, 0, 15);
    expect(selectReceiver(s, PASSER, 1, 0, 0.3, A, 0)).toBe(MATE_A);
    expect(selectReceiver(s, PASSER, 0, 1, 0.3, A, 0)).toBe(MATE_B);
    expect(selectReceiver(s, PASSER, 0, 0, 0.3, A, 0)).toBe(MATE_A);
    s.players[PASSER]!.fx = 0; s.players[PASSER]!.fz = 1;
    expect(selectReceiver(s, PASSER, 0, 0, 0.3, A, 0)).toBe(MATE_B);
    // Nobody in the cone: -1 (a pass into space; the parked players are far behind on the left). [FEEL-1] stick (0.5, -1)
    // instead of (0, -1): the wider Assisted cone (58 degrees) reaches a parked player 57.7 degrees off (0, -1).
    expect(selectReceiver(s, PASSER, 0.5, -1, 0.3, A, 0)).toBe(-1);
  });

  it('power picks the near or the far receiver on the same line', () => {
    const s = quiet();
    place(s, MATE_A, 10, 1.5);
    place(s, MATE_B, 30, -1.5);
    expect(selectReceiver(s, PASSER, 1, 0, 0.05, A, 0)).toBe(MATE_A);
    expect(selectReceiver(s, PASSER, 1, 0, 0.25, A, 0)).toBe(MATE_A);
    expect(selectReceiver(s, PASSER, 1, 0, 0.8, A, 0)).toBe(MATE_B);
    expect(selectReceiver(s, PASSER, 1, 0, 1, A, 0)).toBe(MATE_B);
  });

  it('openness: a tightly marked receiver loses to an open one', () => {
    const s = quiet();
    place(s, MATE_A, 15, 3);
    place(s, MATE_B, 15, -3);
    place(s, OPP_A, 15.8, 3.4);
    expect(selectReceiver(s, PASSER, 1, 0, 0.3, A, 0)).toBe(MATE_B);
    place(s, OPP_A, 15.8, -3.4);
    expect(selectReceiver(s, PASSER, 1, 0, 0.3, A, 0)).toBe(MATE_A);
  });

  it('openness: an opponent in the lane blocks a ground pass but much less a lofted one', () => {
    const s = quiet();
    place(s, MATE_A, 20, 0);
    // [FEEL-1] MATE_B 15 degrees off the stick (was 28: the stick now weighs more, T_PASS_KICK.alignWeight 0.8).
    place(s, MATE_B, 17, -4.6);
    place(s, OPP_A, 9, 0.2); // standing in the lane to MATE_A
    expect(selectReceiver(s, PASSER, 1, 0, 0.5, A, 0)).toBe(MATE_B);
    expect(selectReceiver(s, PASSER, 1, 0, 0.5, A, 1)).toBe(MATE_A);
    place(s, OPP_A, -30, 30);
    expect(selectReceiver(s, PASSER, 1, 0, 0.5, A, 0)).toBe(MATE_A);
  });

  it('assistance: Semi narrows the cone, Manual never selects', () => {
    const s = quiet();
    const ang = 0.7; // 40 degrees off the stick
    place(s, MATE_A, 15 * Math.cos(ang), 15 * Math.sin(ang));
    expect(T_PASS.coneHalfAngle * LT.semiConeMul).toBeLessThan(ang);
    expect(T_PASS.coneHalfAngle * LT.assistedConeMul).toBeGreaterThan(ang);
    expect(selectReceiver(s, PASSER, 1, 0, 0.4, A, 0)).toBe(MATE_A);
    expect(selectReceiver(s, PASSER, 1, 0, 0.4, SEMI, 0)).toBe(-1);
    expect(selectReceiver(s, PASSER, 1, 0, 0.4, MAN, 0)).toBe(-1);
    // Semi still selects straight down the stick.
    expect(selectReceiver(s, PASSER, Math.cos(ang), Math.sin(ang), 0.4, SEMI, 0)).toBe(MATE_A);
  });

  it('never selects the passer, opponents, sent-off players, teammates too close or beyond maxRange', () => {
    const s = quiet();
    place(s, PASSER, -40, 0);
    giveBall(s, PASSER);
    place(s, OPP_A, -28, 0);
    place(s, MATE_A, -39, 0.2); // too close
    place(s, MATE_B, -40 + T_PASS.maxRange + 3, 0); // too far
    place(s, MATE_C, -22, 1);
    s.players[MATE_C]!.active = 0;
    expect(selectReceiver(s, PASSER, 1, 0, 1, A, 0)).toBe(-1);
    s.players[MATE_C]!.active = 1;
    expect(selectReceiver(s, PASSER, 1, 0, 1, A, 0)).toBe(MATE_C);
    expect(selectReceiver(s, -1, 1, 0, 1, A, 0)).toBe(-1);
    expect(selectReceiver(s, 99, 1, 0, 1, A, 0)).toBe(-1);
  });

  it('leads along a receiver run when choosing (a runner into the cone is chosen)', () => {
    const s = quiet();
    place(s, MATE_A, 12, -9);
    s.players[MATE_A]!.vz = 8; // running across into the stick line
    place(s, MATE_B, 6, -12);
    expect(selectReceiver(s, PASSER, 1, -0.1, 0.4, SEMI, 0)).toBe(MATE_A);
  });

  it('is pure: no state change, no rng draw; NaN inputs are safe', () => {
    const s = quiet();
    place(s, MATE_A, 15, 2);
    place(s, OPP_A, 14, 4);
    const h = hashState(s);
    selectReceiver(s, PASSER, 1, 0, 0.5, A, 0);
    selectReceiver(s, PASSER, NaN, Infinity, NaN, A, 1);
    expect(hashState(s)).toBe(h);
    expect(selectReceiver(s, PASSER, NaN, NaN, NaN, A, 0)).toBe(MATE_A);
  });
});

// ---------------------------------------------------------------- speeds and directions

describe('SIM-08 pass speeds', () => {
  it('ground passes keep to the reference 9-22 m/s; driven are faster and flat; ground passes do not lift', () => {
    for (const D of [2, 5, 10, 20, 30, 45, 58]) {
      for (const power of [0, 0.25, 0.5, 0.75, 1]) {
        for (const assist of [A, SEMI, MAN]) {
          const s = quiet();
          place(s, MATE_A, D + 0.5, 0);
          const g = solve(s, KickKind.GROUND_PASS, { power, targetSlot: MATE_A, assist })!;
          const s2 = quiet();
          place(s2, MATE_A, D + 0.5, 0);
          const d = solve(s2, KickKind.DRIVEN_PASS, { power, targetSlot: MATE_A, assist })!;
          expect(hspeed(g)).toBeGreaterThanOrEqual(T_PASS.groundMin - 1e-9);
          expect(hspeed(g)).toBeLessThanOrEqual(T_PASS.groundMax + 1e-9);
          expect(hspeed(d)).toBeGreaterThan(hspeed(g));
          expect(hspeed(d)).toBeLessThanOrEqual(T_PASS.groundMax * T_PASS.drivenMul + 1e-9);
          expect(g.vy).toBe(0);
          expect(d.vy).toBe(0);
          expect(g.kind).toBe(KickKind.GROUND_PASS);
          expect(d.kind).toBe(KickKind.DRIVEN_PASS);
        }
      }
    }
  });

  it('assisted pace: the ball reaches a standing receiver at about the planned arrival speed', () => {
    for (const D of [12, 20, 30, 40]) {
      for (const power of [0.2, 0.6, 1]) {
        const s = quiet();
        skill(s, PASSER, 99);
        place(s, MATE_A, D, 0);
        const l = solve(s, KickKind.GROUND_PASS, { power, targetSlot: MATE_A })!;
        const plan = LT.arriveMin + (LT.arriveMax - LT.arriveMin) * Math.max(power, LT.minPower);
        let at = -1;
        fly(launched(s, l), 600, (_i, b) => {
          if (b.x >= D) { at = Math.hypot(b.vx, b.vz); return true; }
          return false;
        });
        expect(at).toBeGreaterThan(plan - 0.6);
        expect(at).toBeLessThan(plan + 0.6);
      }
    }
  });

  it('Manual: power alone sets the speed and the stick alone the direction', () => {
    for (const power of [0, 0.3, 0.7, 1]) {
      const speeds: number[] = [];
      for (const D of [10, 40]) {
        const s = quiet();
        skill(s, PASSER, 99);
        place(s, MATE_A, D, 8); // well off the stick line
        const l = solve(s, KickKind.GROUND_PASS, { power, dirX: 1, dirZ: 0, assist: MAN })!;
        speeds.push(hspeed(l));
        expect(Math.abs(angleOf(l.vx, l.vz))).toBeLessThan(0.09); // stick +x, small execution error only
      }
      const want = T_PASS.groundMin + (T_PASS.groundMax - T_PASS.groundMin) * Math.max(power, LT.minPower);
      expect(speeds[0]).toBeCloseTo(want, 9);
      expect(speeds[1]).toBeCloseTo(want, 9);
    }
  });

  it('Manual still names the teammate in the ball\'s line as the pass target', () => {
    const s = quiet();
    place(s, MATE_A, 18, 1);
    const l = solve(s, KickKind.GROUND_PASS, { power: 0.5, dirX: 1, dirZ: 0, assist: MAN })!;
    expect(l.target).toBe(MATE_A);
    expect(l.tx).toBeCloseTo(18 + 0.5 - 0.5, 0);
    const s2 = quiet();
    place(s2, MATE_A, 18, 6); // outside the lane
    expect(solve(s2, KickKind.GROUND_PASS, { power: 0.5, dirX: 1, dirZ: 0, assist: MAN })!.target).toBe(-1);
  });

  it('Semi blends power into the assisted pace', () => {
    const v = (assist: AssistLevel, power: number): number => {
      const s = quiet();
      place(s, MATE_A, 15, 0);
      return hspeed(solve(s, KickKind.GROUND_PASS, { power, targetSlot: MATE_A, assist })!);
    };
    for (const power of [0.1, 0.9]) {
      const a = v(A, power), m = v(MAN, power), sm = v(SEMI, power);
      expect(Math.abs(sm - (a + (m - a) * LT.semiPowerBlend))).toBeLessThan(1e-9);
    }
  });

  it('no receiver in the cone: along the stick over the power-implied distance, no pass target', () => {
    const s = quiet();
    skill(s, PASSER, 99);
    const l = solve(s, KickKind.GROUND_PASS, { power: 0.5, dirX: 0, dirZ: 1 })!;
    expect(l.target).toBe(-1);
    expect(Math.abs(angleOf(l.vx, l.vz) - Math.PI / 2)).toBeLessThan(0.09);
    const dPow = LT.groundDistMin + (LT.groundDistMax - LT.groundDistMin) * 0.5;
    expect(Math.hypot(l.tx - s.ball.x, l.tz - s.ball.z)).toBeCloseTo(dPow, 6);
    // It rolls past the power-implied distance at about the assisted arrival speed.
    let at = -1;
    fly(launched(s, l), 600, (_i, b) => {
      if (Math.hypot(b.x - s.ball.x, b.z - s.ball.z) >= dPow) { at = Math.hypot(b.vx, b.vz); return true; }
      return false;
    });
    expect(at).toBeGreaterThan(LT.arriveMin);
  });

  it('an explicit target point (gesture) without a slot is passed to', () => {
    const s = quiet();
    skill(s, PASSER, 99);
    const l = solve(s, KickKind.GROUND_PASS, { power: 0.3, hasTarget: 1, targetX: 10, targetZ: 10, dirX: 0.7, dirZ: 0.7 })!;
    expect(l.tx).toBeCloseTo(10, 9);
    expect(l.tz).toBeCloseTo(10, 9);
    expect(Math.abs(angleOf(l.vx, l.vz) - angleOf(10 - s.ball.x, 10 - s.ball.z))).toBeLessThan(0.09);
  });

  it('KICK_OFF is a ground pass to the requested teammate', () => {
    const s = quiet();
    place(s, MATE_A, 3, -6);
    const l = solve(s, KickKind.KICK_OFF, { power: 0.25, targetSlot: MATE_A, flags: ReqFlag.SET_PIECE })!;
    expect(l.kind).toBe(KickKind.KICK_OFF);
    expect(l.target).toBe(MATE_A);
    expect(l.vy).toBe(0);
    expect(hspeed(l)).toBeGreaterThanOrEqual(T_PASS.groundMin);
  });
});

// ---------------------------------------------------------------- leading

/** Closest approach between the launched ball and a receiver moving at constant velocity; and of the plan point. */
function leadCheck(seed: number, rx: number, rz: number, vx: number, vz: number, kind: KickKind, power: number): {
  ball: number; plan: number; target: number;
} {
  const s = quiet(seed);
  skill(s, PASSER, 99);
  place(s, MATE_A, rx, rz);
  s.players[MATE_A]!.vx = vx; s.players[MATE_A]!.vz = vz;
  const l = solve(s, kind, { power, targetSlot: MATE_A }, seed)!;
  let ball = 1e9, tPlan = -1, best = 1e9;
  const b = launched(s, l);
  fly(b, 400, (i, bb) => {
    const t = i / 60;
    const qx = rx + vx * t, qz = rz + vz * t;
    const d = Math.hypot(bb.x - qx, bb.z - qz);
    if (d < ball && bb.y < 2.0) ball = d;
    const dp = Math.hypot(bb.x - l.tx, bb.z - l.tz);
    if (dp < best) { best = dp; tPlan = t; }
    return false;
  });
  const plan = Math.hypot(l.tx - (rx + vx * tPlan), l.tz - (rz + vz * tPlan));
  return { ball, plan, target: l.target };
}

describe('SIM-08 leading a moving receiver', () => {
  const runs: [number, number, number, number][] = [
    // [QF-2] Runs that stay leadLineMargin inside the lines over the longest lead (a run into the line margin stops
    // there: see 'a run toward the touchline is led only to leadLineMargin inside it').
    [20, 8, 6, 0], [15, -10, 0, 5], [25, 0, -4, 3], [12, 6, 7, -2], [26, -5, 5, 5], [18, 12, 0, -6],
  ];
  it('lead passes to moving receivers arrive within 1.5 m (plan exact, ball with error in 95% of seeds)', () => {
    for (const kind of [KickKind.GROUND_PASS, KickKind.DRIVEN_PASS, KickKind.DINKED_PASS]) {
      let ok = 0, n = 0;
      for (const [rx, rz, vx, vz] of runs) {
        for (let seed = 1; seed <= 8; seed++) {
          const r = leadCheck(seed, rx, rz, vx, vz, kind, 0.5);
          expect(r.target).toBe(MATE_A);
          expect(r.plan, `${KickKind[kind]} run ${rx},${rz},${vx},${vz} seed ${seed}`).toBeLessThan(1.5);
          n++;
          if (r.ball < 1.5) ok++;
        }
      }
      expect(ok / n).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('a standing receiver is not led', () => {
    const s = quiet();
    place(s, MATE_A, 20, 5);
    const l = solve(s, KickKind.GROUND_PASS, { power: 0.5, targetSlot: MATE_A })!;
    expect(l.tx).toBeCloseTo(20, 9);
    expect(l.tz).toBeCloseTo(5, 9);
  });

  it('a run toward the touchline is led only to leadLineMargin inside it (no pass rolling out for a throw-in)', () => {
    for (const kind of [KickKind.GROUND_PASS, KickKind.DRIVEN_PASS]) {
      const s = quiet();
      place(s, MATE_A, 20, 27);
      s.players[MATE_A]!.vx = 2; s.players[MATE_A]!.vz = 5; // a wide man drifting out toward the line
      const l = solve(s, kind, { power: 0.5, targetSlot: MATE_A })!;
      expect(l.tz).toBeLessThanOrEqual(34 - LT.leadLineMargin + 1e-9);
      expect(l.tz).toBeGreaterThan(27 - 1e-9);
      // ... and the same toward the goal line.
      const g = quiet();
      place(g, MATE_A, 44, 5);
      g.players[MATE_A]!.vx = 6;
      const lg = solve(g, kind, { power: 0.5, targetSlot: MATE_A })!;
      expect(lg.tx).toBeLessThanOrEqual(52.5 - LT.leadLineMargin + 1e-9);
    }
  });

  it('lead targets stay on the pitch', () => {
    const s = quiet();
    place(s, MATE_A, 20, 30);
    s.players[MATE_A]!.vz = 8; // running at the touchline
    const l = solve(s, KickKind.GROUND_PASS, { power: 0.5, targetSlot: MATE_A })!;
    expect(l.tz).toBeLessThanOrEqual(34 - LT.pitchMargin + 1e-9);
  });
});

// ---------------------------------------------------------------- dinked

describe('SIM-08 dinked pass', () => {
  it('dinked passes clear a defender\'s legs (ground passes do not) and still reach the receiver', () => {
    for (const D of [12, 18, 25, 35]) {
      for (const power of [0.1, 0.5, 1]) {
        const s = quiet();
        skill(s, PASSER, 99);
        place(s, MATE_A, D, 0);
        place(s, OPP_A, 3.5, 0); // defender in the lane, 3 m from the ball
        const l = solve(s, KickKind.DINKED_PASS, { power, targetSlot: MATE_A })!;
        expect(l.vy).toBeGreaterThan(0);
        // [QF-10] One of the dinked launch angles (T_PASS.dinkedAngle + LT.dinkAngleOffsets, chosen clear of a bounce).
        const ang = Math.atan2(l.vy, hspeed(l));
        expect(Math.min(...LT.dinkAngleOffsets.map((o) => Math.abs(ang - T_PASS.dinkedAngle - o)))).toBeLessThan(1e-9);
        let hAtDef = -1, closest = 1e9, vAt = -1;
        fly(launched(s, l), 400, (_i, b) => {
          if (hAtDef < 0 && b.x >= 3.5) hAtDef = b.y;
          const d = Math.hypot(b.x - D, b.z);
          if (d < closest) { closest = d; vAt = Math.hypot(b.vx, b.vz); }
          return false;
        });
        expect(hAtDef).toBeGreaterThan(T_DRIBBLE.controlHeight);
        expect(closest).toBeLessThan(1.5);
        expect(vAt).toBeGreaterThan(LT.dinkArriveMin - 1.2);
        expect(vAt).toBeLessThan(LT.dinkArriveMax + 1.2);
        const s2 = quiet();
        place(s2, MATE_A, D, 0);
        const g = solve(s2, KickKind.GROUND_PASS, { power, targetSlot: MATE_A })!;
        let gh = -1;
        fly(launched(s2, g), 60, (_i, b) => { if (gh < 0 && b.x >= 3.5) gh = b.y; return gh >= 0; });
        expect(gh).toBeLessThan(0.2);
      }
    }
  });

  it('the dinked model matches the real ball physics (arrival speed within 0.6 m/s of the plan)', () => {
    for (const D of [8, 15, 22, 30, 40]) {
      for (const power of [0, 0.5, 1]) {
        const s = quiet();
        skill(s, PASSER, 99);
        place(s, MATE_A, D, 0);
        const l = solve(s, KickKind.DINKED_PASS, { power, targetSlot: MATE_A })!;
        const plan = LT.dinkArriveMin + (LT.dinkArriveMax - LT.dinkArriveMin) * Math.max(power, LT.minPower);
        // Re-aim exactly along +x (no execution error) and fly with the sim's physics.
        const b: BallState = createBallState();
        copyBallState(b, s.ball);
        b.vx = hspeed(l); b.vz = 0; b.vy = l.vy; b.owner = -1; b.grounded = 0;
        let at = -1;
        for (let i = 0; i < 600 && at < 0; i++) {
          ballStepTick(b, null);
          if (b.x >= D) at = Math.hypot(b.vx, b.vz);
        }
        expect(at).toBeGreaterThan(plan - 0.6);
        expect(at).toBeLessThan(plan + 0.6);
      }
    }
  });

  it('Manual dinked: power alone sets the launch speed', () => {
    const s = quiet();
    place(s, MATE_A, 20, 0);
    const l = solve(s, KickKind.DINKED_PASS, { power: 0.5, assist: MAN })!;
    const v = Math.hypot(hspeed(l), l.vy);
    expect(v).toBeCloseTo(LT.dinkPowerSpeedMin + (LT.dinkPowerSpeedMax - LT.dinkPowerSpeedMin) * 0.5, 9);
  });
});

// ---------------------------------------------------------------- error

/** |kickErrorAim| for a configured state with a fixed rng seed. */
function errOf(setup: (s: ReturnType<typeof quiet>) => void, seed: number, power = 0.5, acc = 0.7, ax = 1, az = 0): number {
  const s = quiet();
  skill(s, PASSER, 70);
  setup(s);
  rngSeed(s.rng, seed);
  return Math.abs(kickErrorAim(s, PASSER, power, acc, ax, az));
}

describe('SIM-08 kick error', () => {
  const none = (): void => { /* baseline */ };
  const cases: [string, (s: ReturnType<typeof quiet>) => void, number?, number?, number?, number?][] = [
    ['pressure (opponent 1 m away)', (s) => place(s, OPP_A, 1.0, 0.3)],
    ['weak foot (weakFoot 1, right-footer passing sharply right)', (s) => skill(s, PASSER, 70, 1, Foot.RIGHT), 0.5, 0.7, 0.2, 0.98],
    ['body facing away from the target', (s) => { s.players[PASSER]!.fx = -1; s.players[PASSER]!.fz = 0; }],
    ['full sprint', (s) => {
      const p = s.players[PASSER]!; p.sprinting = 1; p.vx = s.attrs[PASSER]!.topSpeed; }],
    ['extreme power', none, 1.0],
    ['low stamina', (s) => { s.players[PASSER]!.stamina = 0.05; }],
    ['poor passing accuracy', none, 0.5, 0.2],
  ];
  for (const [name, setup, power, acc, ax, az] of cases) {
    it(`error grows with ${name}`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const base = errOf(none, seed, 0.5, 0.7, ax ?? 1, az ?? 0);
        const worse = errOf(setup, seed, power ?? 0.5, acc ?? 0.7, ax ?? 1, az ?? 0);
        if (base === 0) continue;
        expect(worse).toBeGreaterThan(base * 1.15);
      }
    });
  }

  it('weak foot: the preferred foot (or weakFoot 5) costs nothing; the ball\'s side picks the foot', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const base = errOf(() => { /* weakFoot 5 */ }, seed, 0.5, 0.7, 0.2, 0.98);
      // Right-footer passing to his left: inside of the right foot.
      expect(errOf((s) => skill(s, PASSER, 70, 1, Foot.RIGHT), seed, 0.5, 0.7, 0.2, -0.98)).toBeCloseTo(
        errOf(() => { /* */ }, seed, 0.5, 0.7, 0.2, -0.98), 12);
      // weakFoot 5 = both feet equal.
      expect(errOf((s) => skill(s, PASSER, 70, 5, Foot.RIGHT), seed, 0.5, 0.7, 0.2, 0.98)).toBeCloseTo(base, 12);
      // Ball on his left side: left foot = weak for a right-footer even passing straight.
      const left = errOf((s) => { skill(s, PASSER, 70, 1, Foot.RIGHT); s.ball.z = -0.4; s.ball.x = 0.3; }, seed, 0.5, 0.7, 1, 0);
      const right = errOf((s) => { skill(s, PASSER, 70, 1, Foot.RIGHT); s.ball.z = 0.4; s.ball.x = 0.3; }, seed, 0.5, 0.7, 1, 0);
      if (right > 0) expect(left).toBeGreaterThan(right * 1.15);
      // A left-footer mirrors it.
      const lfLeft = errOf((s) => { skill(s, PASSER, 70, 1, Foot.LEFT); s.ball.z = -0.4; s.ball.x = 0.3; }, seed, 0.5, 0.7, 1, 0);
      expect(lfLeft).toBeCloseTo(right, 12);
    }
  });

  it('error is capped, finite, and uses exactly four rng draws', () => {
    const s = quiet();
    skill(s, PASSER, 1, 1);
    place(s, OPP_A, 0.5, 0);
    const p = s.players[PASSER]!;
    p.fx = -1; p.fz = 0; p.sprinting = 1; p.vx = 9.6; p.stamina = 0;
    for (let seed = 1; seed <= 50; seed++) {
      rngSeed(s.rng, seed);
      const e = kickErrorAim(s, PASSER, 1, 0, 0.2, 0.98);
      expect(Number.isFinite(e)).toBe(true);
      expect(Math.abs(e)).toBeLessThanOrEqual(T_PASS.errorMax * LT.errorCapMul * 2 * Math.sqrt(3) + 1e-12);
      const r2 = { ...s.rng };
      rngSeed(r2, seed);
      rngGauss(r2);
      expect(s.rng).toEqual(r2);
    }
    rngSeed(s.rng, 3);
    expect(Number.isFinite(kickErrorAim(s, PASSER, NaN, NaN, NaN, NaN))).toBe(true);
    expect(kickErrorAim(s, -1, 0.5, 0.5, 1, 0)).toBe(0);
  });

  it('kickError aims along the action direction (facing when unset)', () => {
    const s = quiet();
    startPass(s, PASSER, KickKind.GROUND_PASS, req({ dirX: 0, dirZ: 1 }), NULL_SINK);
    rngSeed(s.rng, 5);
    const a = kickError(s, PASSER, 0.5, 0.6);
    rngSeed(s.rng, 5);
    expect(kickErrorAim(s, PASSER, 0.5, 0.6, 0, 1)).toBe(a);
    s.players[PASSER]!.actDirX = 0; s.players[PASSER]!.actDirZ = 0;
    rngSeed(s.rng, 5);
    const b = kickError(s, PASSER, 0.5, 0.6);
    rngSeed(s.rng, 5);
    expect(kickErrorAim(s, PASSER, 0.5, 0.6, 1, 0)).toBe(b);
  });

  it('pass accuracy blends shortPassing into longPassing with range', () => {
    const s = quiet();
    s.attrs[PASSER]!.shortPassing = 90;
    s.attrs[PASSER]!.longPassing = 40;
    expect(passAccuracy(s, PASSER, 5)).toBeCloseTo(89 / 98, 9);
    expect(passAccuracy(s, PASSER, 50)).toBeCloseTo(39 / 98, 9);
    const mid = passAccuracy(s, PASSER, (LT.shortRange + LT.longRange) / 2);
    expect(mid).toBeCloseTo(64 / 98, 9);
  });

  it('pressure makes real passes miss their receiver by more (solver, many seeds)', () => {
    const miss = (pressed: boolean): number => {
      let sum = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const s = quiet(seed);
        place(s, MATE_A, 25, 0);
        if (pressed) place(s, OPP_A, -0.8, 0.6);
        const l = solve(s, KickKind.GROUND_PASS, { power: 0.5, targetSlot: MATE_A }, seed)!;
        sum += Math.abs(angleOf(l.vx, l.vz) - angleOf(25 - s.ball.x, -s.ball.z));
      }
      return sum / 40;
    };
    expect(miss(true)).toBeGreaterThan(miss(false) * 1.4);
  });
});

// ---------------------------------------------------------------- startPass

describe('SIM-08 startPass', () => {
  it('stores the request in the action fields (contact at the wind-up)', () => {
    const s = quiet();
    place(s, MATE_A, 10, 3);
    const ok = startPass(s, PASSER, KickKind.DRIVEN_PASS, req({
      power: 0.4, charging: 1, dirX: 3, dirZ: 4, targetSlot: MATE_A, assist: SEMI, flags: ReqFlag.PASS_AND_GO | ReqFlag.DRIVEN,
      hasTarget: 1, targetX: 200, targetZ: -5, }), NULL_SINK);
    expect(ok).toBe(1);
    const p = s.players[PASSER]!;
    expect(p.act).toBe(1); // ActionKind.KICK
    expect(p.actKick).toBe(KickKind.DRIVEN_PASS);
    expect(p.actContact).toBe(T_PASS.windup);
    expect(p.actDur).toBe(T_PASS.windup + T_PASS.contact + T_PASS.recovery);
    expect(p.actT).toBe(0);
    expect(p.actDone).toBe(0);
    expect(p.actPower).toBe(0.4);
    expect(p.actCharging).toBe(1);
    expect(p.actDirX).toBeCloseTo(0.6, 12);
    expect(p.actDirZ).toBeCloseTo(0.8, 12);
    expect(p.actSlot).toBe(MATE_A);
    expect(p.actA).toBe(ReqFlag.PASS_AND_GO | ReqFlag.DRIVEN);
    expect(p.actB).toBe(SEMI + 4);
    expect(p.actX).toBeLessThan(52.5); // clamped onto the pitch
    expect(p.actZ).toBe(-5);
  });

  it('needs a free player and the ball: his, at his feet, or arriving in time', () => {
    const k = KickKind.GROUND_PASS;
    // Owner.
    expect(startPass(quiet(), PASSER, k, req(), NULL_SINK)).toBe(1);
    // Busy / stunned / inactive / bad slot / not a pass kind.
    let s = quiet(); s.players[PASSER]!.act = 6; expect(startPass(s, PASSER, k, req(), NULL_SINK)).toBe(0);
    s = quiet(); s.players[PASSER]!.stunT = 5; expect(startPass(s, PASSER, k, req(), NULL_SINK)).toBe(0);
    s = quiet(); s.players[PASSER]!.active = 0; expect(startPass(s, PASSER, k, req(), NULL_SINK)).toBe(0);
    s = quiet(); expect(startPass(s, -1, k, req(), NULL_SINK)).toBe(0);
    s = quiet(); expect(startPass(s, PASSER, KickKind.LOB_PASS, req(), NULL_SINK)).toBe(0);
    expect(isPassKind(KickKind.KICK_OFF)).toBe(true);
    // Somebody else's ball / in a keeper's hands.
    s = quiet(); place(s, OPP_A, 0.8, 0); s.ball.owner = OPP_A; expect(startPass(s, PASSER, k, req(), NULL_SINK)).toBe(0);
    s = quiet(); s.ball.owner = 11; s.ball.heldBy = 11; expect(startPass(s, PASSER, k, req(), NULL_SINK)).toBe(0);
    // Loose at his feet.
    s = quiet(); s.ball.owner = -1; expect(startPass(s, PASSER, k, req(), NULL_SINK)).toBe(1);
    // Loose and far, at rest.
    s = quiet(); s.ball.owner = -1; s.ball.x = 6; expect(startPass(s, PASSER, k, req(), NULL_SINK)).toBe(0);
    // Loose and arriving: 4 m away at 12 m/s toward him (first time).
    s = quiet(); s.ball.owner = -1; s.ball.x = 4; s.ball.vx = -12; expect(startPass(s, PASSER, k, req(), NULL_SINK)).toBe(1);
    // Arriving too late, or passing wide, or too high.
    s = quiet(); s.ball.owner = -1; s.ball.x = 20; s.ball.vx = -6; expect(startPass(s, PASSER, k, req(), NULL_SINK)).toBe(0);
    s = quiet(); s.ball.owner = -1; s.ball.x = 4; s.ball.z = 3; s.ball.vx = -12; expect(startPass(s, PASSER, k, req(), NULL_SINK)).toBe(0);
    s = quiet(); s.ball.owner = -1; s.ball.x = 0.4; s.ball.y = 1.6; expect(startPass(s, PASSER, k, req(), NULL_SINK)).toBe(0);
    expect(ballInReach(s, PASSER)).toBe(false);
  });

  it('respects the phase: dead ball phases refuse, a restart only for its taker', () => {
    let s = quiet();
    s.match.phase = MatchPhase.GOAL;
    expect(startPass(s, PASSER, KickKind.GROUND_PASS, req(), NULL_SINK)).toBe(0);
    s = quiet();
    s.match.phase = MatchPhase.KICK_OFF;
    s.match.restart.kind = RestartKind.KICK_OFF; s.match.restart.taken = 0; s.match.restart.taker = MATE_A;
    s.ball.owner = -1;
    expect(startPass(s, PASSER, KickKind.KICK_OFF, req(), NULL_SINK)).toBe(0);
    s.match.restart.taker = PASSER;
    expect(startPass(s, PASSER, KickKind.KICK_OFF, req(), NULL_SINK)).toBe(1);
  });

  it('sanitises the request (NaN, opponent target, bad assist)', () => {
    const s = quiet();
    const r = req({ power: NaN, dirX: NaN, dirZ: Infinity, targetSlot: OPP_B, assist: 7 as AssistLevel });
    r.curve = NaN; r.flags = NaN;
    expect(startPass(s, PASSER, KickKind.GROUND_PASS, r, NULL_SINK)).toBe(1);
    const p = s.players[PASSER]!;
    expect(p.actPower).toBe(0);
    expect(p.actDirX).toBe(0);
    expect(p.actDirZ).toBe(0);
    expect(p.actSlot).toBe(-1);
    expect(p.actB).toBe(A);
    expect(p.actCurve).toBe(0);
    expect(p.actA).toBe(0);
    const l = createKickLaunch();
    expect(solveGroundPass(s, PASSER, l)).toBe(1);
    for (const v of [l.vx, l.vy, l.vz, l.tx, l.tz]) expect(Number.isFinite(v)).toBe(true);
  });
});

// ---------------------------------------------------------------- determinism

describe('SIM-08 solver determinism', () => {
  it('same state and seed give the identical launch; the solver changes only the rng', () => {
    const run = (): number[] => {
      const s = quiet(4);
      place(s, MATE_A, 18, 5); s.players[MATE_A]!.vx = 4;
      place(s, MATE_B, 22, -8);
      place(s, OPP_A, 9, 2);
      startPass(s, PASSER, KickKind.DINKED_PASS, req({ power: 0.6, dirX: 1, dirZ: 0.2 }), NULL_SINK);
      rngSeed(s.rng, 99);
      const rng0 = { ...s.rng };
      const before = JSON.stringify({ ...s, rng: 0, config: 0, squads: 0 });
      const l = createKickLaunch();
      solveGroundPass(s, PASSER, l);
      expect(JSON.stringify({ ...s, rng: 0, config: 0, squads: 0 })).toBe(before);
      expect(s.rng).not.toEqual(rng0);
      return [l.vx, l.vy, l.vz, l.sx, l.sy, l.sz, l.kind, l.target, l.tx, l.tz, l.onTarget];
    };
    expect(run()).toEqual(run());
  });

  it('a different seed gives a different (but close) launch', () => {
    const a = solve(quiet(), KickKind.GROUND_PASS, { power: 0.5 }, 1)!;
    const b = solve(quiet(), KickKind.GROUND_PASS, { power: 0.5 }, 2)!;
    expect(a.vx === b.vx && a.vz === b.vz).toBe(false);
    expect(Math.abs(angleOf(a.vx, a.vz) - angleOf(b.vx, b.vz))).toBeLessThan(0.3);
  });

  it('solver refuses an invalid slot and fills every launch field otherwise', () => {
    const l = createKickLaunch();
    l.target = 5; l.onTarget = 1;
    expect(solveGroundPass(quiet(), -3, l)).toBe(0);
    const s = quiet();
    giveBall(s, PASSER);
    startPass(s, PASSER, KickKind.GROUND_PASS, req({ power: 0.5 }), NULL_SINK);
    expect(solveGroundPass(s, PASSER, l)).toBe(1);
    expect(l.onTarget).toBe(0);
    expect(l.sx).toBe(0); expect(l.sy).toBe(0); expect(l.sz).toBe(0);
    void T_PLAYER;
  });
});
