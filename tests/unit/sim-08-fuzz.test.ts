/**
 * [SIM-08] Robustness sweep: random (but reproducible) layouts, velocities, attributes, requests and assistance
 * levels for every pass kind. The starter and the solver must never produce a non-finite or out-of-range launch, a
 * pass target that is not an active teammate, or a reception point off the pitch.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { AssistLevel, KickKind } from '../../src/contracts/enums';
import { createKickLaunch, ReqFlag } from '../../src/contracts/systems';
import { T_BALL, T_PASS } from '../../src/contracts/tuning';
import { NULL_SINK } from '../../src/sim/core/events';
import { rngSeed } from '../../src/sim/core/rng';
import { LOCAL_TUNING as LT, selectReceiver, solveGroundPass, startPass } from '../../src/sim/kicks/pass';
import { giveBall, PASSER, place, quiet, req, skill } from './sim-08-helpers';

/** Small reproducible LCG for the test's own randomness (not the sim's rng). */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

const KINDS = [KickKind.GROUND_PASS, KickKind.DRIVEN_PASS, KickKind.DINKED_PASS, KickKind.KICK_OFF] as const;
const ASSISTS = [AssistLevel.ASSISTED, AssistLevel.SEMI, AssistLevel.MANUAL] as const;
const EPS = 1e-6;

describe('SIM-08 robustness sweep', () => {
  it('random layouts and requests always give a finite, in-range launch with a valid target', () => {
    const rnd = lcg(12345);
    const u = (a: number, b: number): number => a + (b - a) * rnd();
    let solved = 0;
    let withTarget = 0;
    for (let n = 0; n < 1500; n++) {
      const s = quiet(1 + n);
      // Everybody somewhere on (or just off) the pitch, some running, some sent off.
      for (let i = 0; i < NUM_SLOTS; i++) {
        const fa = u(-3.2, 3.2);
        place(s, i, u(-HALF_LENGTH - 1, HALF_LENGTH + 1), u(-HALF_WIDTH - 1, HALF_WIDTH + 1), Math.cos(fa), Math.sin(fa));
        const p = s.players[i]!;
        if (rnd() < 0.5) { p.vx = u(-9, 9); p.vz = u(-9, 9); }
        p.sprinting = rnd() < 0.3 ? 1 : 0;
        p.stamina = u(0, 1);
        if (i !== PASSER && rnd() < 0.05) p.active = 0;
        skill(s, i, Math.floor(u(1, 99)), 1 + Math.floor(u(0, 5)), rnd() < 0.5 ? 0 : 1);
      }
      giveBall(s, PASSER);
      const kind = KINDS[Math.floor(u(0, KINDS.length))]!;
      const assist = ASSISTS[Math.floor(u(0, ASSISTS.length))]!;
      const da = u(-3.2, 3.2);
      const idle = rnd() < 0.15;
      const hasTarget = rnd() < 0.15 ? 1 : 0;
      const o = {
        power: rnd() < 0.1 ? (rnd() < 0.5 ? 0 : 1) : u(0, 1),
        dirX: idle ? 0 : Math.cos(da),
        dirZ: idle ? 0 : Math.sin(da),
        targetSlot: rnd() < 0.2 ? Math.floor(u(-2, NUM_SLOTS + 2)) : -1,
        hasTarget,
        targetX: u(-70, 70),
        targetZ: u(-45, 45),
        assist,
        flags: rnd() < 0.2 ? ReqFlag.PASS_AND_GO : 0,
      };
      expect(startPass(s, PASSER, kind, req(o), NULL_SINK)).toBe(1);
      rngSeed(s.rng, 1000 + n);
      const l = createKickLaunch();
      expect(solveGroundPass(s, PASSER, l)).toBe(1);
      solved++;
      for (const v of [l.vx, l.vy, l.vz, l.sx, l.sy, l.sz, l.tx, l.tz]) expect(Number.isFinite(v)).toBe(true);
      expect(l.kind).toBe(kind);
      const vh = Math.sqrt(l.vx * l.vx + l.vz * l.vz);
      const sp = Math.sqrt(vh * vh + l.vy * l.vy);
      expect(sp).toBeLessThanOrEqual(T_BALL.maxSpeed + EPS);
      if (kind === KickKind.DINKED_PASS) {
        expect(l.vy).toBeGreaterThan(0);
        // [QF-10] One of the dinked launch angles (T_PASS.dinkedAngle + LT.dinkAngleOffsets; Manual: the base one).
        const ang = Math.atan2(l.vy, vh);
        expect(Math.min(...LT.dinkAngleOffsets.map((o) => Math.abs(ang - T_PASS.dinkedAngle - o)))).toBeLessThan(1e-3);
        const lo = Math.min(LT.dinkSpeedMin, LT.dinkPowerSpeedMin);
        const hi = Math.max(LT.dinkSpeedMax, LT.dinkPowerSpeedMax);
        expect(sp).toBeGreaterThanOrEqual(lo - EPS);
        expect(sp).toBeLessThanOrEqual(hi + EPS);
      } else {
        expect(l.vy).toBe(0);
        const mul = kind === KickKind.DRIVEN_PASS ? T_PASS.drivenMul : 1;
        expect(vh).toBeGreaterThanOrEqual(T_PASS.groundMin * mul - EPS);
        expect(vh).toBeLessThanOrEqual(Math.min(T_PASS.groundMax * mul, T_BALL.maxSpeed) + EPS);
      }
      expect(Math.abs(l.tx)).toBeLessThanOrEqual(HALF_LENGTH);
      expect(Math.abs(l.tz)).toBeLessThanOrEqual(HALF_WIDTH);
      if (l.target !== -1) {
        withTarget++;
        expect(l.target).not.toBe(PASSER);
        const q = s.players[l.target]!;
        expect(q.active).toBe(1);
        expect(q.team).toBe(s.players[PASSER]!.team);
      }
      // selectReceiver on the same layout: a teammate or -1, Manual always -1.
      const r = selectReceiver(s, PASSER, o.dirX, o.dirZ, o.power, assist, kind === KickKind.DINKED_PASS ? 1 : 0);
      if (assist === AssistLevel.MANUAL) expect(r).toBe(-1);
      if (r !== -1) {
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(PLAYERS_PER_TEAM);
        expect(r).not.toBe(PASSER);
        expect(s.players[r]!.active).toBe(1);
      }
    }
    expect(solved).toBe(1500);
    expect(withTarget).toBeGreaterThan(300);
  });
});
