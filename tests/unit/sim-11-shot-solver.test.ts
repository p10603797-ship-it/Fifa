/**
 * [SIM-11] Shot solver, aim and error model: speed bands per kind, aim relative to the goal (Assisted / Semi /
 * Manual, keeper bias, inset from the posts), error factors (finishing vs long shots, power knee, balance, pressure,
 * weak foot, ball height, stamina), finesse curl inside the far post, chips over an advanced keeper, low driven
 * height, free-kick curl / dip / wall, penalties, determinism.
 */
import { describe, expect, it } from 'vitest';
import { AssistLevel, Foot, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { createKickLaunch, ReqFlag } from '../../src/contracts/systems';
import { T_SHOT } from '../../src/contracts/tuning';
import { NULL_SINK } from '../../src/sim/core/events';
import { rngGauss, rngSeed } from '../../src/sim/core/rng';
import {
  isShotKind, LOCAL_TUNING as LT, shotAimPoint, shotErrorSigma, shotSpeedFor, shotWindup, solveShot, startShot,
} from '../../src/sim/kicks/shot';
import {
  crossAt, DEF, dirTo, flightToGoal, GH, GHW, GX, inMouth, KEEPER, launched, peakBefore, place, shootScene, SHOOTER,
  shotReq, skill, solveKind, speedOf,
} from './sim-11-helpers';

const ASSIST_Z = GHW - T_SHOT.assistInset;
const AIM = { x: 0, y: 0, z: 0 };

function aimZ(s: ReturnType<typeof shootScene>, dirX: number, dirZ: number, assist: AssistLevel, power = 0.6): number {
  shotAimPoint(s, SHOOTER, dirX, dirZ, power, assist, AIM);
  return AIM.z;
}

/** Fraction of `n` seeded shots (fresh scene from setup) whose launch is on target. */
function onTargetRate(setup: () => ReturnType<typeof shootScene>, kind: KickKind, n: number, power = 0.7): number {
  let on = 0;
  for (let i = 0; i < n; i++) {
    const s = setup();
    const l = solveKind(s, kind, { power, dirX: 1, dirZ: 0 }, 5000 + i * 7);
    if (l && l.onTarget === 1) on++;
  }
  return on / n;
}

// ---------------------------------------------------------------- speed bands

describe('SIM-11 shot speed bands', () => {
  it('hard shots (power >= 0.8) leave the foot at 25-36 m/s for every open-play kind but finesse / chip', () => {
    for (const k of [KickKind.SHOT_NORMAL, KickKind.SHOT_POWER, KickKind.SHOT_LOW_DRIVEN]) {
      for (const pw of [0.8, 0.9, 1]) {
        const s = shootScene(34, 3);
        const l = solveKind(s, k, { power: pw })!;
        expect(l, `${KickKind[k]} ${pw}`).not.toBeNull();
        const v = speedOf(l);
        expect(v, `${KickKind[k]} ${pw}`).toBeGreaterThanOrEqual(25);
        expect(v, `${KickKind[k]} ${pw}`).toBeLessThanOrEqual(36);
      }
    }
  });

  it('speed rises with power and with the shotPower attribute', () => {
    const s = shootScene();
    let prev = 0;
    for (const pw of [0, 0.25, 0.5, 0.75, 1]) {
      const v = shotSpeedFor(s, SHOOTER, KickKind.SHOT_NORMAL, pw, 0);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
    expect(shotSpeedFor(s, SHOOTER, KickKind.SHOT_NORMAL, 0, 0)).toBeGreaterThanOrEqual(T_SHOT.speedMin * LT.shotPowerMulMin - 1e-9);
    s.attrs[SHOOTER]!.shotPower = 99;
    const strong = shotSpeedFor(s, SHOOTER, KickKind.SHOT_NORMAL, 1, 0);
    s.attrs[SHOOTER]!.shotPower = 30;
    const weak = shotSpeedFor(s, SHOOTER, KickKind.SHOT_NORMAL, 1, 0);
    expect(strong).toBeCloseTo(T_SHOT.speedMax, 6);
    expect(weak).toBeLessThan(strong);
  });

  it('power shot is the fastest kind, finesse slower than a normal shot, chip slowest', () => {
    const s = shootScene();
    s.attrs[SHOOTER]!.shotPower = 99;
    const v = (k: KickKind): number => shotSpeedFor(s, SHOOTER, k, 1, 0);
    expect(v(KickKind.SHOT_POWER)).toBeCloseTo(T_SHOT.powerShotMax, 6);
    expect(v(KickKind.SHOT_POWER)).toBeGreaterThan(v(KickKind.SHOT_NORMAL));
    expect(v(KickKind.SHOT_POWER)).toBeGreaterThan(v(KickKind.SHOT_LOW_DRIVEN));
    expect(v(KickKind.SHOT_FINESSE)).toBeLessThan(v(KickKind.SHOT_NORMAL));
    expect(v(KickKind.SHOT_CHIP)).toBeLessThan(v(KickKind.SHOT_FINESSE));
  });

  it('wind-up: the power shot winds up longer than every other kind', () => {
    expect(shotWindup(KickKind.SHOT_POWER)).toBe(T_SHOT.powerShotWindup);
    expect(T_SHOT.powerShotWindup).toBeGreaterThan(T_SHOT.windup);
    for (const k of [KickKind.SHOT_NORMAL, KickKind.SHOT_FINESSE, KickKind.SHOT_CHIP, KickKind.SHOT_LOW_DRIVEN, KickKind.PENALTY]) {
      expect(shotWindup(k)).toBe(T_SHOT.windup);
    }
    expect(isShotKind(KickKind.FREE_KICK_SHOT)).toBe(true);
    expect(isShotKind(KickKind.GROUND_PASS)).toBe(false);
    expect(isShotKind(KickKind.VOLLEY_SHOT)).toBe(false); // SIM-12
  });
});

// ---------------------------------------------------------------- aim

describe('SIM-11 aim relative to the goal', () => {
  it('stick toward the far post aims at the far post, toward the near post at the near post (Assisted, inset)', () => {
    const s = shootScene(38, -10); // left of the goal as he attacks +x: far post = +z
    const fp = dirTo(s, GX, GHW), np = dirTo(s, GX, -GHW);
    expect(aimZ(s, fp.x, fp.z, AssistLevel.ASSISTED)).toBeCloseTo(ASSIST_Z, 6);
    expect(aimZ(s, np.x, np.z, AssistLevel.ASSISTED)).toBeCloseTo(-ASSIST_Z, 6);
    expect(AIM.x).toBe(GX);
    // Anything past a post (up to the capture margin and beyond) still aims at that post when Assisted.
    const wideFar = dirTo(s, GX, GHW + 6), upField = { x: 1, z: 0 };
    expect(aimZ(s, wideFar.x, wideFar.z, AssistLevel.ASSISTED)).toBeCloseTo(ASSIST_Z, 6);
    expect(aimZ(s, upField.x, upField.z, AssistLevel.ASSISTED)).toBeCloseTo(-ASSIST_Z, 6);
    // Manual: exactly where the stick points on the goal line.
    expect(aimZ(s, fp.x, fp.z, AssistLevel.MANUAL)).toBeCloseTo(GHW, 6);
  });

  it('Assisted keeps the aim inside the posts; Manual follows the stick wide; Semi lies between', () => {
    const s = shootScene(36, 0, 1, false);
    const wide = { x: 0.85, z: 0.53 }; // ray meets the line ~10 m wide
    const a = aimZ(s, wide.x, wide.z, AssistLevel.ASSISTED);
    const m = aimZ(s, wide.x, wide.z, AssistLevel.MANUAL);
    const sm = aimZ(s, wide.x, wide.z, AssistLevel.SEMI);
    expect(Math.abs(a)).toBeLessThanOrEqual(ASSIST_Z + 1e-9);
    expect(m).toBeGreaterThan(GHW + 3);
    expect(sm).toBeGreaterThan(a);
    expect(sm).toBeLessThan(m);
    // Manual = the stick ray on the goal line.
    const ray = 0 + wide.z * (GX - s.ball.x) / wide.x;
    expect(m).toBeCloseTo(ray, 6);
  });

  it('assisted aim moves away from the keeper (out of his cover), at most keeperShiftMax', () => {
    const s = shootScene(36, 0);
    place(s, KEEPER, GX - 1, 1.5, -1, 0);
    const zL = aimZ(s, 1, 0.05, AssistLevel.ASSISTED); // stick slightly toward his side
    place(s, KEEPER, GX - 1, -1.5, -1, 0);
    const zR = aimZ(s, 1, -0.05, AssistLevel.ASSISTED);
    // Stick toward the keeper's side: the aim slides off him toward the open side / post.
    place(s, KEEPER, GX - 1, 0, -1, 0);
    const zC = aimZ(s, 1, 0, AssistLevel.ASSISTED);
    expect(Math.abs(zC)).toBeGreaterThan(0.5);
    expect(Math.abs(zC)).toBeLessThanOrEqual(LT.keeperShiftMax + 1e-9);
    const s2 = shootScene(36, 0, 1, false);
    expect(aimZ(s2, 1, 0, AssistLevel.ASSISTED)).toBeCloseTo(0, 6); // no keeper: straight
    expect(Number.isFinite(zL) && Number.isFinite(zR)).toBe(true);
    expect(Math.abs(zL - 1.5)).toBeGreaterThan(0.9);
    expect(Math.abs(zR + 1.5)).toBeGreaterThan(0.9);
  });

  it('idle stick and facing: Assisted picks the side with more room beside the keeper', () => {
    const s = shootScene(36, 0);
    s.players[SHOOTER]!.fx = 0; s.players[SHOOTER]!.fz = 0; // no facing either: goal centre, idle
    place(s, KEEPER, GX - 1, 1.2, -1, 0);
    expect(aimZ(s, 0, 0, AssistLevel.ASSISTED)).toBeCloseTo(-ASSIST_Z, 6);
    place(s, KEEPER, GX - 1, -1.2, -1, 0);
    expect(aimZ(s, 0, 0, AssistLevel.ASSISTED)).toBeCloseTo(ASSIST_Z, 6);
  });

  it('power shot gets the least assistance (closer to the manual aim)', () => {
    const s = shootScene(36, 0, 1, false);
    const st = startShot(s, SHOOTER, KickKind.SHOT_POWER, shotReq({ charging: 1 }), NULL_SINK);
    expect(st).toBe(1);
    const wide = { x: 0.85, z: 0.53 };
    const p = aimZ(s, wide.x, wide.z, AssistLevel.ASSISTED);
    const s2 = shootScene(36, 0, 1, false);
    const n = aimZ(s2, wide.x, wide.z, AssistLevel.ASSISTED);
    const m = aimZ(s2, wide.x, wide.z, AssistLevel.MANUAL);
    expect(p).toBeGreaterThan(n + 1);
    expect(p).toBeLessThan(m);
  });

  it('an explicit target point (gesture / set piece) aims there; shotAimPoint is pure', () => {
    const s = shootScene(36, 0, 1, false);
    const l = solveKind(s, KickKind.SHOT_NORMAL, { hasTarget: 1, targetX: GX, targetZ: -2.2, power: 0.5 })!;
    expect(l.tx).toBe(GX);
    expect(l.tz).toBeCloseTo(-2.2, 6);
    const before = JSON.stringify({ b: s.ball, p: s.players, r: s.rng });
    for (let i = 0; i < 5; i++) aimZ(s, 0.7, 0.3, i % 3);
    expect(JSON.stringify({ b: s.ball, p: s.players, r: s.rng })).toBe(before);
  });

  it('team attacking -x aims at the -x goal', () => {
    const s = shootScene(36, 0, 1, false);
    s.teams[0]!.dir = -1;
    const p = s.players[SHOOTER]!;
    p.x = -36; p.fx = -1; p.fz = 0;
    s.ball.x = -36.5; s.ball.px = -36.5;
    shotAimPoint(s, SHOOTER, -1, 0, 0.5, AssistLevel.ASSISTED, AIM);
    expect(AIM.x).toBe(-GX);
  });
});

// ---------------------------------------------------------------- error model

describe('SIM-11 error model', () => {
  it('on-target rate rises with finishing (inside the box)', () => {
    const rate = (fin: number): number => onTargetRate(() => {
      const s = shootScene(37, 5);
      skill(s, SHOOTER, fin);
      return s;
    }, KickKind.SHOT_NORMAL, 120);
    const lo = rate(25), mid = rate(60), hi = rate(95);
    expect(mid).toBeGreaterThan(lo);
    expect(hi).toBeGreaterThan(mid);
    expect(hi).toBeGreaterThan(0.85);
    expect(lo).toBeLessThan(0.8);
  });

  it('finishing governs shots inside the box, longShots shots from distance', () => {
    const s = shootScene(37, 0);
    const a = s.attrs[SHOOTER]!;
    a.finishing = 95; a.longShots = 30;
    const nearGood = shotErrorSigma(s, SHOOTER, KickKind.SHOT_NORMAL, 0.6, 1, 0, 14);
    const farBad = shotErrorSigma(s, SHOOTER, KickKind.SHOT_NORMAL, 0.6, 1, 0, 28);
    a.finishing = 30; a.longShots = 95;
    const nearBad = shotErrorSigma(s, SHOOTER, KickKind.SHOT_NORMAL, 0.6, 1, 0, 14);
    const farGood = shotErrorSigma(s, SHOOTER, KickKind.SHOT_NORMAL, 0.6, 1, 0, 28);
    expect(nearGood).toBeLessThan(nearBad);
    expect(farGood).toBeLessThan(farBad);
  });

  it('power above the knee, balance, facing, pressure, weak foot, ball height and low stamina all grow the error', () => {
    const base = (): ReturnType<typeof shootScene> => shootScene(37, 0, 1, false);
    const sig = (s: ReturnType<typeof shootScene>, power = 0.6, dx = 1, dz = 0): number =>
      shotErrorSigma(s, SHOOTER, KickKind.SHOT_NORMAL, power, dx, dz, 15);
    const s0 = base();
    const ref = sig(s0);
    expect(sig(s0, T_SHOT.errorPowerKnee)).toBeCloseTo(sig(s0, 0.3), 9); // flat below the knee
    expect(sig(s0, 1)).toBeGreaterThan(ref * 1.5);
    // Balance: running across / away from the shot direction.
    const sb = base();
    sb.players[SHOOTER]!.vz = 6;
    const sb2 = base();
    sb2.players[SHOOTER]!.vx = 6;
    expect(sig(sb)).toBeGreaterThan(sig(sb2));
    // Facing away from the shot.
    const sf = base();
    sf.players[SHOOTER]!.fx = 0; sf.players[SHOOTER]!.fz = 1;
    expect(sig(sf)).toBeGreaterThan(ref);
    // Pressure: a defender tight on him.
    const sp = base();
    place(sp, DEF, 37.6, 0.6, -1, 0);
    expect(sig(sp)).toBeGreaterThan(ref);
    // Weak foot: a right-footer with the ball on his left (weakFoot 1 vs 5).
    const sw = base();
    const b = sw.ball;
    b.x = 37.1; b.z = -0.45; // left of his facing (+x): right is +z
    sw.attrs[SHOOTER]!.weakFoot = 5;
    const wf5 = sig(sw);
    sw.attrs[SHOOTER]!.weakFoot = 1;
    const wf1 = sig(sw);
    expect(wf1).toBeGreaterThan(wf5 * 1.3);
    sw.attrs[SHOOTER]!.foot = Foot.LEFT; // now his strong foot
    expect(sig(sw)).toBeCloseTo(wf5, 9);
    // Ball height at contact.
    const sh = base();
    sh.ball.y = 0.7;
    expect(sig(sh)).toBeGreaterThan(ref);
    // Low stamina.
    const ss = base();
    ss.players[SHOOTER]!.stamina = 0.05;
    expect(sig(ss)).toBeGreaterThan(ref);
  });

  it('sigma stays inside T_SHOT.errorMin..errorMax at the extremes', () => {
    const s = shootScene(37, 0);
    skill(s, SHOOTER, 99);
    expect(shotErrorSigma(s, SHOOTER, KickKind.SHOT_FINESSE, 0.3, 1, 0, 10)).toBeGreaterThanOrEqual(T_SHOT.errorMin);
    skill(s, SHOOTER, 1, 1);
    s.players[SHOOTER]!.vz = 9; s.players[SHOOTER]!.stamina = 0; s.ball.y = 0.8;
    place(s, DEF, 37.5, 0.5, -1, 0);
    const worst = shotErrorSigma(s, SHOOTER, KickKind.SHOT_POWER, 1, -1, 0, 40);
    expect(worst).toBeLessThanOrEqual(T_SHOT.errorMax);
    expect(worst).toBe(T_SHOT.errorMax);
  });

  it('finesse is more accurate than a normal shot, a power shot less', () => {
    const s = shootScene(37, 0, 1, false);
    const n = shotErrorSigma(s, SHOOTER, KickKind.SHOT_NORMAL, 0.6, 1, 0, 15);
    expect(shotErrorSigma(s, SHOOTER, KickKind.SHOT_FINESSE, 0.6, 1, 0, 15)).toBeLessThan(n);
    expect(shotErrorSigma(s, SHOOTER, KickKind.SHOT_POWER, 0.6, 1, 0, 15)).toBeGreaterThan(n);
  });
});

// ---------------------------------------------------------------- shot types

describe('SIM-11 shot types', () => {
  it('finesse curls inside the far post (right-footer from the left, left-footer from the right)', () => {
    for (const side of [-1, 1]) {
      const s = shootScene(38, side * 9, 3, false);
      skill(s, SHOOTER, 99, 5, side < 0 ? Foot.RIGHT : Foot.LEFT);
      const fp = dirTo(s, GX, -side * GHW);
      const l = solveKind(s, KickKind.SHOT_FINESSE, { power: 0.6, dirX: fp.x, dirZ: fp.z }, 11)!;
      const farZ = -side * ASSIST_Z;
      expect(l.tz).toBeCloseTo(farZ, 6);
      // Curl back toward the goal centre: positive sy curls LEFT of travel (toward -z when kicking toward +x).
      expect(Math.sign(l.sy)).toBe(side < 0 ? 1 : -1);
      expect(Math.abs(l.sy)).toBeGreaterThan(T_SHOT.finesseSpin * 0.9);
      const c = flightToGoal(s, l)!;
      expect(c).not.toBeNull();
      expect(inMouth(c)).toBe(true);
      expect(Math.abs(c.z)).toBeLessThan(GHW);
      expect(c.z * -side).toBeGreaterThan(1); // far half of the goal
      // It starts outside the line it ends on: the launch heading meets the goal line wider than the crossing.
      const headZ = s.ball.z + l.vz * (GX - s.ball.x) / l.vx;
      expect(headZ * -side).toBeGreaterThan(c.z * -side + 0.5);
      expect(l.onTarget).toBe(1);
    }
  });

  it('chips clear an advanced keeper and drop under the bar', () => {
    for (const pw of [0.3, 0.6, 0.9]) {
      const s = shootScene(GX - 20, 2, 4);
      skill(s, SHOOTER, 90);
      place(s, KEEPER, GX - 7, 1, -1, 0);
      const l = solveKind(s, KickKind.SHOT_CHIP, { power: pw }, 21)!;
      expect(l.sz).toBeGreaterThan(0); // backspin about the horizontal axis (travel +x)
      const b = launched(s, l);
      const atKeeper = crossAt(b, GX - 7)!;
      expect(atKeeper.y, `power ${pw}`).toBeGreaterThan(2.8);
      const c = crossAt(b, GX);
      expect(c, `power ${pw}`).not.toBeNull();
      expect(c!.y).toBeLessThan(GH + 0.4);
    }
    // A mid-power Assisted chip goes in.
    const s = shootScene(GX - 20, 2, 4);
    skill(s, SHOOTER, 90);
    place(s, KEEPER, GX - 7, 1, -1, 0);
    const l = solveKind(s, KickKind.SHOT_CHIP, { power: 0.5 }, 21)!;
    expect(inMouth(flightToGoal(s, l))).toBe(true);
  });

  it('low driven stays under 1 m all the way to the goal line', () => {
    for (const x of [GX - 12, GX - 20, GX - 30]) {
      for (const pw of [0, 0.5, 1]) {
        for (let seed = 1; seed <= 4; seed++) {
          const s = shootScene(x, -3, seed, false);
          skill(s, SHOOTER, 50);
          const l = solveKind(s, KickKind.SHOT_LOW_DRIVEN, { power: pw }, seed * 13)!;
          expect(peakBefore(launched(s, l), GX), `x ${x} pw ${pw} seed ${seed}`).toBeLessThan(1);
        }
      }
    }
  });

  it('SHOT_NORMAL with ReqFlag.LOW plays a low driven shot', () => {
    const s = shootScene(36, 0, 1, false);
    const l = solveKind(s, KickKind.SHOT_NORMAL, { power: 0.8, flags: ReqFlag.LOW })!;
    expect(l.kind).toBe(KickKind.SHOT_LOW_DRIVEN);
    expect(flightToGoal(s, l)!.peak).toBeLessThan(1);
  });

  it('normal shots carry a slight natural curl without a request curl; a request curl bends them its way', () => {
    // [FEEL-1] Was "fly straight": the user found every shot the same; a normal shot now curls a little off the instep
    // (T_FEEL.normalNaturalSpin, a fraction of the finesse spin).
    const s = shootScene(36, 0, 1, false);
    const nat = solveKind(s, KickKind.SHOT_NORMAL, { power: 0.6 })!.sy;
    expect(nat).not.toBe(0);
    const sf = shootScene(36, 0, 1, false);
    expect(Math.abs(nat)).toBeLessThan(0.5 * Math.abs(solveKind(sf, KickKind.SHOT_FINESSE, { power: 0.6 })!.sy));
    const s2 = shootScene(36, 0, 1, false);
    expect(solveKind(s2, KickKind.SHOT_NORMAL, { power: 0.6, curve: 1 })!.sy).toBeLessThan(0); // curls right (+z)
  });

  it('free-kick shot: curl from actCurve, dip from restart.side, more dip to clear an assisted wall', () => {
    const fk = (curve: number, side: number, wall: number, assist = AssistLevel.ASSISTED): ReturnType<typeof createKickLaunch> & { s: ReturnType<typeof shootScene> } => {
      const s = shootScene(GX - 24, 4, 2);
      skill(s, SHOOTER, 85);
      s.match.phase = MatchPhase.FREE_KICK;
      const r = s.match.restart;
      r.kind = RestartKind.FREE_KICK; r.taker = SHOOTER; r.taken = 0; r.side = side;
      r.wallCount = wall; r.wallX = s.ball.x + 9.15 * 0.95; r.wallZ = s.ball.z - 9.15 * 0.2;
      const l = solveKind(s, KickKind.FREE_KICK_SHOT, { power: 0.6, curve, assist, dirX: 0.98, dirZ: -0.2 }, 9)!;
      return Object.assign(l, { s });
    };
    const left = fk(-0.8, 0, 0), right = fk(0.8, 0, 0), straight = fk(0, 0, 0);
    expect(right.sy).toBeLessThan(0); // + curve = bends right of travel (+z when kicking toward +x)
    expect(left.sy).toBeGreaterThan(0);
    expect(straight.sy).toBe(0);
    // Dip: topspin about the horizontal axis (sz < 0 when travelling +x); side +1 dips more than side -1.
    const dips = fk(0, 1, 0), floats = fk(0, -1, 0);
    expect(dips.sz).toBeLessThan(floats.sz);
    expect(dips.sz).toBeLessThan(0);
    // Wall: an Assisted free kick clears 2.35 m at the wall when it can.
    const w = fk(0.5, 0, 4);
    const b = launched(w.s, w);
    const atWall = crossAt(b, w.s.match.restart.wallX)!;
    expect(atWall.y).toBeGreaterThan(LT.fkWallClearY - 0.15);
    expect(w.sz).toBeLessThanOrEqual(fk(0.5, 0, 0).sz);
  });

  it('penalties from the spot are struck hard and mostly on target by a good taker', () => {
    let on = 0;
    const n = 60;
    for (let i = 0; i < n; i++) {
      const s = shootScene(GX - 11, 0, 1 + i);
      skill(s, SHOOTER, 85);
      s.match.phase = MatchPhase.PENALTY;
      const r = s.match.restart;
      r.kind = RestartKind.PENALTY; r.taker = SHOOTER; r.taken = 0;
      const l = solveKind(s, KickKind.PENALTY, { hasTarget: 1, targetX: GX, targetZ: i % 2 === 0 ? 2.6 : -2.6, power: 0.7 }, 900 + i)!;
      expect(speedOf(l)).toBeGreaterThan(20);
      on += l.onTarget;
    }
    expect(on / n).toBeGreaterThan(0.8);
  });
});

// ---------------------------------------------------------------- determinism

describe('SIM-11 solver determinism', () => {
  it('same state and seed give the same launch; the solver draws exactly two gaussians and changes nothing else', () => {
    const run = (): ReturnType<typeof createKickLaunch> => solveKind(shootScene(35, 7, 9), KickKind.SHOT_FINESSE, { power: 0.75, dirX: 0.9, dirZ: -0.4 }, 77)!;
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
    const s = shootScene(35, 7, 9);
    expect(startShot(s, SHOOTER, KickKind.SHOT_NORMAL, shotReq(), NULL_SINK)).toBe(1);
    rngSeed(s.rng, 123);
    const before = JSON.stringify({ b: s.ball, p: s.players, m: s.match, t: s.teams });
    const out = createKickLaunch();
    expect(solveShot(s, SHOOTER, out)).toBe(1);
    expect(JSON.stringify({ b: s.ball, p: s.players, m: s.match, t: s.teams })).toBe(before);
    const s2 = shootScene(35, 7, 9);
    rngSeed(s2.rng, 123);
    rngGauss(s2.rng); rngGauss(s2.rng);
    expect(JSON.stringify(s.rng)).toBe(JSON.stringify(s2.rng));
  });

  it('launch values are finite and capped for garbage requests', () => {
    const s = shootScene(36, 0);
    const l = solveKind(s, KickKind.SHOT_POWER, { power: NaN, dirX: Infinity, dirZ: NaN, curve: NaN, targetX: NaN, hasTarget: 1 })!;
    expect(l).not.toBeNull();
    for (const v of [l.vx, l.vy, l.vz, l.sx, l.sy, l.sz, l.tx, l.tz]) expect(Number.isFinite(v)).toBe(true);
    expect(solveShot(s, -1, createKickLaunch())).toBe(0);
    expect(startShot(s, 99, KickKind.SHOT_NORMAL, shotReq(), NULL_SINK)).toBe(0);
  });
});

describe('SIM-11 contact cost', () => {
  it('a shot solve (all kinds, error + trajectory iterations) averages well under a millisecond', () => {
    const kinds = [KickKind.SHOT_NORMAL, KickKind.SHOT_FINESSE, KickKind.SHOT_CHIP, KickKind.SHOT_POWER, KickKind.SHOT_LOW_DRIVEN];
    const s = shootScene(33, 6);
    const out = createKickLaunch();
    const p = s.players[SHOOTER]!;
    for (let k = 0; k < kinds.length; k++) {
      expect(startShot(s, SHOOTER, kinds[k]!, shotReq({ power: 0.3 + 0.15 * k, dirX: 0.9, dirZ: -0.3 }), NULL_SINK)).toBe(1);
      p.act = 0; // free him again for the next start (the solver only reads the action fields)
    }
    const n = 400;
    let warm = 0;
    for (let i = 0; i < 50; i++) warm += solveShot(s, SHOOTER, out);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      p.actKick = kinds[i % kinds.length]!;
      p.actPower = (i % 10) / 10;
      solveShot(s, SHOOTER, out);
    }
    const avg = (performance.now() - t0) / n;
    expect(warm).toBe(50);
    expect(avg).toBeLessThan(1);
  });
});
