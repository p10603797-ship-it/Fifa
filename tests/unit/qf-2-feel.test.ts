/**
 * [QF-2] FIX-14 game feel against the BRIEF §6 reference values, and the DAT-05 attribute findings acted on
 * (docs/ATTRIBUTE_AUDIT.md "weak effects"):
 *  - shotPower moved the launch speed only ~4% from 40 to 90 (kicks/shot.ts shotPowerMulMin 0.92 -> 0.8);
 *  - composure relieved little of the pressure error (composureRelief 0.5 -> 0.8);
 *  - a full-power goal kick carries 45-60 m (§6 "goal kick carries 45-60 m").
 * Pass speeds (9-22 m/s) and hard shots (25-36 m/s) are pinned by sim-08-pass / sim-11-shot-solver.
 */
import '../../src/sim/actions/dispatch'; // load the action registry first (import-cycle order)
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { AssistLevel, KickKind } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { createKickLaunch, type KickLaunch } from '../../src/contracts/systems';
import { cloneState } from '../../src/sim/core/clone';
import { NULL_SINK } from '../../src/sim/core/events';
import { rngSeed } from '../../src/sim/core/rng';
import { LOCAL_TUNING as SHOT_LT, solveShot, startShot } from '../../src/sim/kicks/shot';
import { fly, KICKER, launched, place, quiet, req, solveLobKick } from './sim-09-helpers';

const GX = HALF_LENGTH;

/** KICKER at (x, z) facing the +x goal centre with the ball at his feet, the away keeper on his line. */
function shotScene(x: number, z: number, a: { shotPower?: number; composure?: number }): SimState {
  const s = quiet(3, x, z, GX - x, -z);
  place(s, 11, GX - 0.5, 0, -1, 0);
  Object.assign(s.attrs[KICKER]!, {
    finishing: 70, longShots: 70, shotPower: 70, curve: 70, composure: 70, ballControl: 70, weakFoot: 5, ...a,
  });
  return s;
}

/** Shots of the base scene over n rng seeds through the real solver. */
function shots(base: SimState, power: number, n: number): KickLaunch[] {
  const out: KickLaunch[] = [];
  const p = base.players[KICKER]!;
  for (let k = 0; k < n; k++) {
    const s = cloneState(base);
    expect(startShot(s, KICKER, KickKind.SHOT_NORMAL, req({ power, dirX: p.fx, dirZ: p.fz }), NULL_SINK)).toBe(1);
    rngSeed(s.rng, 1000 + k * 7919);
    const l = createKickLaunch();
    expect(solveShot(s, KICKER, l)).toBe(1);
    out.push(l);
  }
  return out;
}

const speedOf = (l: KickLaunch): number => Math.hypot(l.vx, l.vy, l.vz);
const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;

/** Mean |z| miss at the goal line from the solver's aim point, flown with the sim's ball physics. */
function placement(base: SimState, n: number): number {
  const miss: number[] = [];
  for (const l of shots(base, 0.7, n)) {
    const b = launched(base, l);
    fly(b, 300, () => {
      if (b.x < GX) return b.vx <= 0;
      miss.push(Math.abs(b.z - l.tz));
      return true;
    });
  }
  expect(miss.length).toBeGreaterThan(n * 0.8);
  return mean(miss);
}

describe('QF-2 DAT-05 findings: shotPower and composure move play visibly', () => {
  it('shotPower 40 -> 90 lifts the launch speed of an 80% shot by 8%+, inside the 25-36 m/s hard-shot band at full power', () => {
    expect(SHOT_LT.shotPowerMulMin).toBeLessThanOrEqual(0.82);
    const v = (sp: number, pw: number): number => mean(shots(shotScene(GX - 20, 0, { shotPower: sp }), pw, 12).map(speedOf));
    const lo = v(40, 0.8), hi = v(90, 0.8);
    expect(hi / lo, `80% power: ${lo.toFixed(1)} -> ${hi.toFixed(1)} m/s`).toBeGreaterThanOrEqual(1.08);
    // Full power: a 90 striker stays under the 36 m/s top of the band; a 40 one still strikes a hard shot.
    expect(v(90, 1)).toBeLessThanOrEqual(36);
    expect(v(40, 1)).toBeGreaterThanOrEqual(25);
  });

  it('composure 40 -> 90 cuts the placement error of a pressed 14 m shot by 20%+', () => {
    expect(SHOT_LT.composureRelief).toBeGreaterThanOrEqual(0.75);
    const err = (c: number): number => {
      const s = shotScene(GX - 14, 2, { composure: c });
      place(s, 15, GX - 13.2, 2.6, -1, 0); // a defender pressing at 1 m
      return placement(s, 120);
    };
    const lo = err(40), hi = err(90);
    expect(hi, `placement error ${lo.toFixed(2)} -> ${hi.toFixed(2)} m`).toBeLessThanOrEqual(lo * 0.8);
  });
});

describe('QF-2 FIX-14 §6 reference feel', () => {
  it('a full-power goal kick into space carries 45-60 m before its first bounce', () => {
    // Manual / Semi with nobody near: the power-implied distance (Assisted would pick the teammates parked nearby).
    for (const assist of [AssistLevel.MANUAL, AssistLevel.SEMI]) {
      const s = quiet(1, -GX + 5.5, 0, 1, 0);
      const l = solveLobKick(s, KickKind.GOAL_KICK, { power: 1, dirX: 1, dirZ: 0, assist })!;
      expect(l).not.toBeNull();
      expect(l.target).toBe(-1); // nobody near the landing point: into space over the power-implied distance
      const b = launched(s, l);
      const x0 = b.x, z0 = b.z;
      let carry = -1;
      fly(b, 600, () => {
        if (b.bounces > 0) { carry = Math.hypot(b.x - x0, b.z - z0); return true; } // first bounce this tick
        return false;
      });
      expect(carry, `assist ${assist}`).toBeGreaterThanOrEqual(45);
      expect(carry, `assist ${assist}`).toBeLessThanOrEqual(60);
    }
  });
});
