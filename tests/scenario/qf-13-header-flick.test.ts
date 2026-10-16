/**
 * [QF-13] Contested AI header passes (SIM-12 aiChoose HEADER_PASS, not a clearance) are no longer flicked straight up
 * the pitch over the goal line (QF-11 CR: 2.0 goal kicks a match, the largest single cause). With nobody in the forward
 * cone the header goes back across the box (toward the spot T_AERIAL.aiFlickSpotDepth out, a teammate that way first),
 * every AI header pass lands at least T_AERIAL.aiFlickLineMargin inside the attacked goal line and a flick to no one is
 * shortened until its predicted roll stops short of the lines. The clearance branch is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { ActionKind, KickKind, RestartKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createBallState, type SimState } from '../../src/contracts/state';
import { createKickLaunch, type KickLaunch } from '../../src/contracts/systems';
import { T_AERIAL } from '../../src/contracts/tuning';
import { ballStepTick } from '../../src/sim/ball/contact';
import { copyBallState } from '../../src/sim/ball/flight';
import { cloneState, diffState } from '../../src/sim/core/clone';
import { AERIAL_TUNING, solveHeader } from '../../src/sim/kicks/aerial';
import { runTicks } from '../harness/scenario';
import { launchCross, place, quietScene } from './sim-12-helpers';

const ATT = 9;
const DEF = 13;
const F_AI = 2;
const F_CLEAR = 1;
const LT = AERIAL_TUNING;

/** Put slot into a HEADER at its contact with the ball at (x, y, z) arriving with (vx, vy, vz). */
function atContact(s: SimState, slot: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, flags: number): void {
  const p = s.players[slot]!;
  p.x = x - 0.1; p.z = z;
  p.act = ActionKind.HEADER; p.actKick = KickKind.HEADER_PASS; p.actPower = LT.aiPassPower; p.actT = 10; p.actContact = 10;
  p.actDur = 30; p.actDone = 0; p.actDirX = 0; p.actDirZ = 0; p.actSlot = -1; p.actA = flags; p.actCurve = y;
  p.actX = x; p.actZ = z;
  const b = s.ball;
  b.x = x; b.y = y; b.z = z; b.vx = vx; b.vy = vy; b.vz = vz; b.owner = -1; b.heldBy = -1; b.grounded = 0;
}

interface Flight { landX: number; landZ: number; maxX: number; maxAbsZ: number }

/** Fly the launched ball alone (sim physics, no players) until it stops: first landing and furthest excursion. */
function fly(s: SimState, out: KickLaunch): Flight {
  const b = createBallState();
  copyBallState(b, s.ball);
  b.vx = out.vx; b.vy = out.vy; b.vz = out.vz; b.sx = out.sx; b.sy = out.sy; b.sz = out.sz;
  b.grounded = 0; b.owner = -1; b.heldBy = -1; b.inNet = 0; b.bounces = 0;
  const f: Flight = { landX: NaN, landZ: NaN, maxX: b.x, maxAbsZ: Math.abs(b.z) };
  for (let k = 0; k < 600; k++) {
    ballStepTick(b, null);
    if (Number.isNaN(f.landX) && b.y < BALL_RADIUS + 0.05) { f.landX = b.x; f.landZ = b.z; }
    if (b.x > f.maxX) f.maxX = b.x;
    if (Math.abs(b.z) > f.maxAbsZ) f.maxAbsZ = Math.abs(b.z);
    if (Math.hypot(b.vx, b.vz) < 0.05 && b.y < BALL_RADIUS + 0.01) break;
  }
  return f;
}

describe('QF-13: contested AI header passes stay in play', () => {
  it('glitch: header flicked over the goal line — an AI flick with nobody ahead never rolls over the goal line (attacking half grid x 6 seeds)', () => {
    const out = createKickLaunch();
    let n = 0, crossed = 0, out2 = 0, landedLate = 0, backAcross = 0;
    const worst: string[] = [];
    for (let seed = 1; seed <= 6; seed++) {
      for (let toAttack = 6; toAttack <= 50; toAttack += 4) {
        for (let z = -30; z <= 30; z += 6) {
          const s = quietScene({ seed: seed * 101 + toAttack * 7 + z });
          const x = HALF_LENGTH - toAttack;
          atContact(s, ATT, x, 2.1, z, -6, -3, z > 0 ? -2 : 2, F_AI);
          expect(solveHeader(s, ATT, out)).toBe(1);
          expect(out.kind).toBe(KickKind.HEADER_PASS);
          expect(out.target).toBe(-1); // teammates are all parked in the own half
          const f = fly(s, out);
          n++;
          if (f.maxX > HALF_LENGTH) { crossed++; if (worst.length < 5) worst.push(`(${x}, ${z}) seed ${seed} maxX ${f.maxX.toFixed(2)}`); }
          if (f.maxAbsZ > HALF_WIDTH) out2++;
          if (f.landX > HALF_LENGTH - T_AERIAL.aiFlickLineMargin + 0.3) landedLate++;
          // Back across the box: toward the centre line (or at least not further out) and never more than the spot ahead.
          if (Math.abs(f.landZ) <= Math.abs(z) + 1.5) backAcross++; // (+ the header's aim error)
          else if (worst.length < 12) worst.push(`wider: (${x}, ${z}) seed ${seed} land (${f.landX.toFixed(1)}, ${f.landZ.toFixed(1)})`);
        }
      }
    }
    expect(n).toBeGreaterThan(500);
    expect(worst).toEqual([]);
    expect(crossed).toBe(0);
    expect(out2).toBe(0);
    expect(landedLate).toBe(0);
    expect(backAcross).toBe(n);
  });

  it('an AI header pass to a teammate standing on the goal line lands at least aiFlickLineMargin inside it', () => {
    const out = createKickLaunch();
    for (let seed = 1; seed <= 12; seed++) {
      const s = quietScene({ seed });
      place(s, 10, 52, -20);
      atContact(s, ATT, 40, 2.0, -14, -6, -3, 3, F_AI);
      solveHeader(s, ATT, out);
      expect(out.target).toBe(10);
      const f = fly(s, out);
      expect(f.landX).toBeLessThanOrEqual(HALF_LENGTH - T_AERIAL.aiFlickLineMargin + 0.6);
    }
  });

  it('a teammate ahead in the cone is still the target (best-placed receiver first)', () => {
    const out = createKickLaunch();
    const s = quietScene({ seed: 3 });
    place(s, 10, 38, 4);
    atContact(s, ATT, 24, 2.0, 0, -6, -3, 0, F_AI);
    solveHeader(s, ATT, out);
    expect(out.target).toBe(10);
    const f = fly(s, out);
    expect(f.landX).toBeGreaterThan(28);
    expect(f.landX).toBeLessThan(38);
  });

  it('with nobody ahead, a teammate back across the box is found', () => {
    const out = createKickLaunch();
    const s = quietScene({ seed: 5 });
    place(s, 10, 40, -2); // near the spot area, behind the header (wide, near the byline)
    atContact(s, ATT, 48, 2.0, -22, -6, -3, 3, F_AI);
    solveHeader(s, ATT, out);
    expect(out.target).toBe(10);
    expect(out.vx).toBeLessThan(0); // back across, not on toward the line
  });

  it('the AI clearance branch is unchanged: high and long away from the own goal', () => {
    const out = createKickLaunch();
    const c = quietScene({ seed: 5 });
    place(c, DEF, 45, 1);
    atContact(c, DEF, 44.9, 2.0, 1, 10, -4, 6, F_CLEAR | F_AI);
    c.players[DEF]!.actPower = LT.aiClearPower;
    c.players[DEF]!.actDirX = -1 / Math.sqrt(1.36); c.players[DEF]!.actDirZ = 0.6 / Math.sqrt(1.36);
    solveHeader(c, DEF, out);
    expect(out.target).toBe(-1);
    expect(out.vx).toBeLessThan(0);
    const v = Math.hypot(out.vx, out.vy, out.vz);
    expect(v).toBeGreaterThanOrEqual(LT.headerClearMin - 1e-9);
    expect(v).toBeLessThanOrEqual(LT.headerClearMax + 1e-9);
  });

  it('the flick solver changes nothing but the RNG (its roll prediction uses scratch only)', () => {
    const out = createKickLaunch();
    const s = quietScene({ seed: 9 });
    atContact(s, ATT, 32, 2.1, 0, -6, -3, 0, F_AI);
    const before = cloneState(s);
    solveHeader(s, ATT, out);
    s.rng.a = before.rng.a; s.rng.b = before.rng.b; s.rng.c = before.rng.c; s.rng.d = before.rng.d;
    expect(diffState(before, s)).toBeNull();
    expect(Number.isFinite(out.vx + out.vy + out.vz)).toBe(true);
  });

  it('real pipeline: a contested cross headed on 22 m out, wide of the posts, with no teammate ahead does not go out for a goal kick', () => {
    let goalKicks = 0, headers = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const s = quietScene({ seed, keeperAway: true });
      place(s, ATT, 30.5, -14, { heading: 95 });
      place(s, DEF, 32.5, -13, { heading: 20 }); // contesting (inside contestRadius), not winning it
      place(s, 11, 5, 30); // the keeper far upfield (no one to sweep up a ball rolling out)
      launchCross(s, 7, 12, 20, 31, -14, 0.6, -1);
      let prev = s.match.restart.kind as number;
      runTicks(s, 360, undefined, {
        until: (st, evs) => {
          for (const e of evs) if (e.type === EventType.KICK && e.b === KickKind.HEADER_PASS && e.a === ATT) headers++;
          const rk = st.match.restart.kind;
          if (rk !== prev && rk === RestartKind.GOAL_KICK) goalKicks++;
          prev = rk;
          return false;
        },
      });
    }
    expect(headers).toBeGreaterThan(0);
    expect(goalKicks).toBe(0);
  });
});
