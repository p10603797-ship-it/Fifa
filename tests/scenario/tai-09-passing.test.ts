/**
 * [TAI-09] CPU pass, cross and through-ball evaluation: laneSafety (completion of a lane against the opponents'
 * reach) and scorePassOptions (ground / driven / lob / through / cross options with completion, progress, danger,
 * style-weighted score). Scenario states come from initMatch (tests/harness/scenario.ts) with explicit positions;
 * SIM-09 crossTarget and SIM-10 throughLeadPoint are used as they are (tai-09-hooks.test.ts mocks them).
 */
import { describe, expect, it } from 'vitest';
import { CROSS_ZONE_DEPTH, CROSS_ZONE_MIN_Z, HALF_LENGTH, HALF_WIDTH, PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { ActionKind, AiJob, KickKind, MatchPhase, TeamStyle } from '../../src/contracts/enums';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { createPassOptions, laneSafety, LOCAL_TUNING, scorePassOptions, type PassOption } from '../../src/ai/cpu/passing';
import { hashState } from '../../src/sim/core/hash';
import { inPenaltyArea } from '../../src/sim/pitch/geometry';
import { makeScenario } from '../harness/scenario';

// ---------------------------------------------------------------- scenes

/** Home 4-4-2 attacking +x with the ball in midfield; away 4-4-2 with its back line at x = 27..28. [slot, x, z]. */
const HOME: [number, number, number][] = [[0, -45, 0], [1, -8, 24], [2, -15, 8], [3, -15, -8], [4, -8, -24], [5, 12, 25],
  [6, 5, 4], [7, -2, -6], [8, 12, -25], [9, 22, 6], [10, 22, -8]];
const AWAY: [number, number, number][] = [[11, 49, 0], [12, 28, -20], [13, 27, -7], [14, 27, 7], [15, 28, 20], [16, 14, -18],
  [17, 12, -5], [18, 13, 9], [19, 15, 18], [20, -5, -6], [21, -4, 8]];

/** Realistic mid-game scene; `carrier` owns the ball at his feet. */
function scene(carrier = 6): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY });
  for (const [i, x, z] of [...HOME, ...AWAY]) {
    const p = s.players[i]!;
    p.x = x; p.z = z; p.vx = 0; p.vz = 0; p.fx = i < PLAYERS_PER_TEAM ? 1 : -1; p.fz = 0;
    p.act = 0; p.moveMode = MoveMode.STOP; p.stunT = 0; p.job = AiJob.HOLD_SHAPE;
  }
  s.teams[0]!.dir = 1; s.teams[1]!.dir = -1;
  s.teams[0]!.style = TeamStyle.POSSESSION; s.teams[1]!.style = TeamStyle.POSSESSION;
  own(s, carrier);
  return s;
}

/** Give the ball to `slot` (at his feet, 0.4 m ahead along his attack). */
function own(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const dir = s.teams[p.team]!.dir;
  const b = s.ball;
  b.owner = slot; b.x = p.x + 0.4 * dir; b.z = p.z; b.y = 0.11; b.px = b.x; b.pz = b.z; b.vx = 0; b.vz = 0; b.vy = 0;
  b.lastTouch = slot; b.lastTouchTeam = p.team;
}

/** An empty pitch: only the keepers and `keep` slots stay active (pure-function tests only read `active`). Offside
 *  is off: with two defenders on the pitch the offside line would be the outfield one. */
function sparse(s: SimState, keep: number[]): void {
  s.config = { ...s.config, offside: 0 };
  for (let i = 0; i < 22; i++) {
    if (i === 0 || i === 11 || keep.includes(i)) continue;
    s.players[i]!.active = 0;
  }
}

function place(s: SimState, slot: number, x: number, z: number, vx = 0, vz = 0): void {
  const p = s.players[slot]!;
  p.active = 1; p.x = x; p.z = z; p.vx = vx; p.vz = vz;
}

function scan(s: SimState, slot: number, cap = 48): PassOption[] {
  const out = createPassOptions(cap);
  const n = scorePassOptions(s, slot, out);
  return out.slice(0, n).map((o) => ({ ...o }));
}

const of = (opts: PassOption[], target: number, kinds?: KickKind[]): PassOption[] =>
  opts.filter((o) => o.target === target && (!kinds || kinds.includes(o.kind)));
const best = (opts: PassOption[]): PassOption | undefined => opts.reduce<PassOption | undefined>((b, o) => (!b || o.score > b.score ? o : b), undefined);
const GROUNDISH = [KickKind.GROUND_PASS, KickKind.DRIVEN_PASS];
const THROUGH = [KickKind.THROUGH_GROUND, KickKind.THROUGH_LOBBED, KickKind.THROUGH_DINKED];

/** Every option is well formed (finite, in range, a teammate, sorted). */
function expectValid(s: SimState, slot: number, opts: PassOption[]): void {
  const team = s.players[slot]!.team;
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i]!;
    expect(o.target).not.toBe(slot);
    expect(s.players[o.target]!.team).toBe(team);
    expect(s.players[o.target]!.active).toBe(1);
    for (const v of [o.x, o.z, o.completion, o.progress, o.danger, o.score]) expect(Number.isFinite(v)).toBe(true);
    expect(o.completion).toBeGreaterThanOrEqual(0);
    expect(o.completion).toBeLessThanOrEqual(1);
    expect(o.danger).toBeGreaterThanOrEqual(0);
    expect(o.danger).toBeLessThanOrEqual(1);
    expect(Math.abs(o.x)).toBeLessThanOrEqual(HALF_LENGTH);
    expect(Math.abs(o.z)).toBeLessThanOrEqual(HALF_WIDTH);
    expect([KickKind.GROUND_PASS, KickKind.DRIVEN_PASS, KickKind.LOB_PASS, KickKind.THROUGH_GROUND, KickKind.THROUGH_LOBBED,
      KickKind.CROSS]).toContain(o.kind);
    if (i > 0) expect(o.score).toBeLessThanOrEqual(opts[i - 1]!.score);
  }
}

// ---------------------------------------------------------------- laneSafety

describe('TAI-09 laneSafety', () => {
  function lane(): SimState {
    const s = scene();
    sparse(s, [6]);
    return s;
  }

  it('an open lane is safe', () => {
    const s = lane();
    expect(laneSafety(s, 0, 0, 0, 20, 0, 14, 0)).toBeGreaterThan(0.95);
    expect(laneSafety(s, 0, 0, 0, 20, 0, 16, 1)).toBeGreaterThan(0.95);
  });

  it('an opponent standing in the lane blocks it', () => {
    const s = lane();
    place(s, 17, 10, 0.3);
    expect(laneSafety(s, 0, 0, 0, 20, 0, 14, 0)).toBeLessThan(0.1);
  });

  it('an opponent far from the lane or behind the passer does not block it', () => {
    const s = lane();
    place(s, 17, 10, 14);
    expect(laneSafety(s, 0, 0, 0, 20, 0, 14, 0)).toBeGreaterThan(0.9);
    place(s, 17, -1.5, 0);
    expect(laneSafety(s, 0, 0, 0, 20, 0, 14, 0)).toBeGreaterThan(0.9);
  });

  it('safety falls as an opponent gets closer to the lane', () => {
    const s = lane();
    let prev = -1;
    for (const off of [1, 2.5, 4, 6, 9, 13]) {
      place(s, 17, 11, off);
      const v = laneSafety(s, 0, 0, 0, 22, 0, 17, 0);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(prev).toBeGreaterThan(0.9);
  });

  it('a faster ball beats an opponent near the lane', () => {
    const s = lane();
    place(s, 17, 12, 4);
    const slow = laneSafety(s, 0, 0, 0, 24, 0, 11, 0);
    const fast = laneSafety(s, 0, 0, 0, 24, 0, 24, 0);
    expect(fast).toBeGreaterThan(slow + 0.2);
  });

  it('a lofted ball clears an opponent in the middle of the lane', () => {
    const s = lane();
    place(s, 17, 8, 0);
    expect(laneSafety(s, 0, 0, 0, 25, 0, 14, 0)).toBeLessThan(0.1);
    expect(laneSafety(s, 0, 0, 0, 25, 0, 17, 1)).toBeGreaterThan(0.8);
  });

  it('a lofted ball onto a contested landing spot is an aerial duel', () => {
    const s = lane();
    place(s, 17, 25, 1.2);
    const v = laneSafety(s, 0, 0, 0, 25, 0, 17, 1);
    expect(v).toBeGreaterThan(0.2);
    expect(v).toBeLessThan(0.75);
  });

  it('the keeper reaches further in his own box', () => {
    const s = lane();
    // The away keeper (slot 11) near the lane end inside his area vs an outfield player at the same spot.
    place(s, 11, 44, 4.2);
    const keeper = laneSafety(s, 0, 25, 0, 46, 0, 18, 0);
    s.players[11]!.active = 0;
    place(s, 17, 44, 4.2);
    const field = laneSafety(s, 0, 25, 0, 46, 0, 18, 0);
    expect(keeper).toBeLessThan(field);
  });

  it('a ground ball too slow to get there is unsafe', () => {
    const s = lane();
    expect(laneSafety(s, 0, 0, 0, 30, 0, 5, 0)).toBeLessThan(0.3);
    expect(laneSafety(s, 0, 0, 0, 30, 0, 18, 0)).toBeGreaterThan(0.9);
  });

  it('a stunned or locked opponent reacts later', () => {
    const s = lane();
    place(s, 17, 11, 3);
    const fresh = laneSafety(s, 0, 0, 0, 22, 0, 14, 0);
    s.players[17]!.stunT = 60;
    const stunned = laneSafety(s, 0, 0, 0, 22, 0, 14, 0);
    expect(stunned).toBeGreaterThan(fresh);
    s.players[17]!.stunT = 0;
    const p = s.players[17]!;
    p.act = 10; p.actT = 2; p.actDur = 60; p.moveMode = MoveMode.LOCKED;
    expect(laneSafety(s, 0, 0, 0, 22, 0, 14, 0)).toBeGreaterThan(fresh);
  });

  it('an opponent running toward the lane is more dangerous than one running away', () => {
    const s = lane();
    place(s, 17, 11, 5, 0, -6);
    const toward = laneSafety(s, 0, 0, 0, 22, 0, 13, 0);
    place(s, 17, 11, 5, 0, 6);
    const away = laneSafety(s, 0, 0, 0, 22, 0, 13, 0);
    expect(toward).toBeLessThan(away);
  });

  it('judges the lane for the team asked (the team attacking -x too)', () => {
    const s = lane();
    place(s, 2, -10, 0.3); // a home player in an away lane
    expect(laneSafety(s, 1, 0, 0, -20, 0, 14, 0)).toBeLessThan(0.1);
    expect(laneSafety(s, 0, 0, 0, -20, 0, 14, 0)).toBeGreaterThan(0.9);
  });

  it('bad input gives 0, a zero-length lane 1; results always finite in 0..1', () => {
    const s = scene();
    expect(laneSafety(s, 2, 0, 0, 20, 0, 14, 0)).toBe(0);
    expect(laneSafety(s, -1, 0, 0, 20, 0, 14, 0)).toBe(0);
    expect(laneSafety(s, 0, NaN, 0, 20, 0, 14, 0)).toBe(0);
    expect(laneSafety(s, 0, 0, 0, 20, Infinity, 14, 0)).toBe(0);
    expect(laneSafety(s, 0, 0, 0, 20, 0, 0, 0)).toBe(0);
    expect(laneSafety(s, 0, 0, 0, 20, 0, -3, 1)).toBe(0);
    expect(laneSafety(s, 0, 0, 0, 20, 0, NaN, 0)).toBe(0);
    expect(laneSafety(s, 0, 3, 3, 3, 3, 14, 0)).toBe(1);
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
    for (let k = 0; k < 400; k++) {
      const x0 = (rnd() * 2 - 1) * HALF_LENGTH, z0 = (rnd() * 2 - 1) * HALF_WIDTH;
      const x1 = (rnd() * 2 - 1) * HALF_LENGTH, z1 = (rnd() * 2 - 1) * HALF_WIDTH;
      const v = laneSafety(s, k & 1, x0, z0, x1, z1, 1 + rnd() * 35, (k >> 1) & 1);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is pure and deterministic', () => {
    const s = scene();
    const h = hashState(s);
    const a = laneSafety(s, 0, 5, 4, 22, -8, 14, 0);
    const b = laneSafety(s, 0, 5, 4, 30, 10, 18, 1);
    expect(laneSafety(s, 0, 5, 4, 22, -8, 14, 0)).toBe(a);
    expect(laneSafety(s, 0, 5, 4, 30, 10, 18, 1)).toBe(b);
    expect(hashState(s)).toBe(h);
  });
});

// ---------------------------------------------------------------- scorePassOptions

describe('TAI-09 scorePassOptions', () => {
  it('blocked lanes score low', () => {
    const s = scene();
    sparse(s, [6, 9, 10]);
    place(s, 6, 5, 0); own(s, 6);
    place(s, 9, 22, 8);
    place(s, 10, 22, -8);
    place(s, 17, 13.5, -3.6); // in the lane to 10
    const opts = scan(s, 6);
    expectValid(s, 6, opts);
    const to9 = of(opts, 9, GROUNDISH)[0]!;
    const to10 = of(opts, 10, GROUNDISH)[0]!;
    expect(to9.completion).toBeGreaterThan(0.8);
    expect(to10.completion).toBeLessThan(0.3);
    expect(to10.score).toBeLessThan(to9.score);
    expect(best(of(opts, 10))!.score).toBeLessThan(best(of(opts, 9))!.score);
  });

  it('open forward passes score high', () => {
    const s = scene();
    sparse(s, [6, 9, 7, 2]);
    place(s, 6, 5, 0); own(s, 6);
    place(s, 9, 22, 4); // forward
    place(s, 7, 5, 15); // sideways
    place(s, 2, -12, 2); // back
    const opts = scan(s, 6);
    expectValid(s, 6, opts);
    const fwd = best(of(opts, 9))!, side = best(of(opts, 7))!, back = best(of(opts, 2))!;
    for (const o of [fwd, side, back]) expect(o.completion).toBeGreaterThan(0.75);
    expect(opts[0]!.target).toBe(9);
    expect(fwd.score).toBeGreaterThan(side.score);
    expect(side.score).toBeGreaterThan(back.score);
    expect(fwd.progress).toBeGreaterThan(15);
    expect(back.progress).toBeLessThan(-15);
  });

  it('a lob goes over a blocked lane (and only then)', () => {
    const s = scene();
    sparse(s, [6, 9]);
    place(s, 6, 0, 0); own(s, 6);
    place(s, 9, 26, 0);
    expect(of(scan(s, 6), 9, [KickKind.LOB_PASS])).toHaveLength(0);
    place(s, 17, 13, 0.2);
    const opts = scan(s, 6);
    const ground = of(opts, 9, GROUNDISH)[0]!;
    const lob = of(opts, 9, [KickKind.LOB_PASS])[0]!;
    expect(lob).toBeDefined();
    expect(ground.completion).toBeLessThan(0.2);
    // [INT-A] margin 0.3 -> 0.15: aerial reception was recalibrated (aerialMin/Max 0.72/0.95 -> 0.4/0.6) against
    // soak outcomes where lobs reached the receiver about 13% of the time.
    expect(lob.completion).toBeGreaterThan(ground.completion + 0.15);
  });

  it('[QF-11] an open lob over a blocked lane is rated near what lobs complete since QF-9 (not the old 13% era)', () => {
    // QF-9's lofted receiver meets the ball where it comes down: chosen CPU lobs completed 76% against a raw lane
    // estimate of 72% (56 Professional matches), so aerialMin / aerialMax are 0.85 / 1.0 (were 0.4 / 0.6 when lobs
    // reached the receiver about 13% of the time).
    const s = scene();
    sparse(s, [6, 9]);
    place(s, 6, 0, 0); own(s, 6);
    place(s, 9, 26, 0);
    place(s, 17, 13, 0.2);
    const lob = of(scan(s, 6), 9, [KickKind.LOB_PASS])[0]!;
    expect(lob).toBeDefined();
    expect(lob.completion).toBeGreaterThan(0.45); // 0.50 here; ~0.26 with the old 0.4 / 0.6 aerial factor
  });

  it('a driven pass replaces a ground pass a slow ball would lose', () => {
    const s = scene();
    sparse(s, [6, 9]);
    place(s, 6, 0, 0); own(s, 6);
    place(s, 9, 26, 0);
    place(s, 17, 15, 5); // can reach a slow ball, not a driven one
    const g = of(scan(s, 6), 9, GROUNDISH);
    expect(g).toHaveLength(1);
    expect(g[0]!.kind).toBe(KickKind.DRIVEN_PASS);
    expect(g[0]!.completion).toBeGreaterThan(0.6);
  });

  describe('through balls only to runners', () => {
    function runnerScene(vx: number, vz = 0, job = AiJob.HOLD_SHAPE): SimState {
      const s = scene();
      place(s, 6, 10, 0); own(s, 6);
      place(s, 9, 20, 6, vx, vz);
      s.players[9]!.job = job;
      return s;
    }

    it('a forward runner gets a through ball led into space ahead of him', () => {
      const s = runnerScene(7);
      const opts = scan(s, 6);
      expectValid(s, 6, opts);
      const th = of(opts, 9, THROUGH);
      expect(th.length).toBeGreaterThan(0);
      for (const o of th) {
        expect(o.x - s.players[9]!.x).toBeGreaterThanOrEqual(LOCAL_TUNING.throughMinLead);
        expect(o.progress).toBeGreaterThan(0);
      }
    });

    it('a standing player, a player running back or sideways, and the keeper get none', () => {
      for (const s of [runnerScene(0), runnerScene(-7), runnerScene(1, 7), runnerScene(2)]) {
        expect(of(scan(s, 6), 9, THROUGH)).toHaveLength(0);
      }
      const s = runnerScene(0);
      s.players[0]!.vx = 8; // a keeper sprinting forward is still no runner
      expect(of(scan(s, 6), 0, THROUGH)).toHaveLength(0);
    });

    it('a teammate on a run job moving forward is a runner', () => {
      const s = runnerScene(1.5, 0, AiJob.RUN_IN_BEHIND);
      expect(of(scan(s, 6), 9, THROUGH).length).toBeGreaterThan(0);
      const s2 = runnerScene(-1, 0, AiJob.RUN_IN_BEHIND);
      expect(of(scan(s2, 6), 9, THROUGH)).toHaveLength(0);
    });

    it('every through ball in busy scenes targets a runner', () => {
      for (let k = 0; k < 12; k++) {
        const s = scene();
        for (let i = 1; i < PLAYERS_PER_TEAM; i++) {
          const p = s.players[i]!;
          p.vx = ((i * 7 + k * 3) % 11) - 5; p.vz = ((i * 5 + k) % 7) - 3;
        }
        const opts = scan(s, 6);
        expectValid(s, 6, opts);
        for (const o of opts.filter((q) => THROUGH.includes(q.kind))) {
          const q = s.players[o.target]!;
          const fwd = q.vx;
          const sp = Math.hypot(q.vx, q.vz);
          expect(q.isKeeper).toBe(0);
          expect(fwd >= LOCAL_TUNING.runnerMinFwd && fwd >= LOCAL_TUNING.runnerFwdCos * sp).toBe(true);
        }
      }
    });

    it('a runner who cannot get to the ball in time makes it a poor through ball', () => {
      const s = runnerScene(7);
      const quick = best(of(scan(s, 6), 9, [KickKind.THROUGH_GROUND]));
      expect(quick).toBeDefined();
      // Same run, but he is locked in a stumble for a second: the ball gets there first.
      const p = s.players[9]!;
      p.act = ActionKind.STUMBLE; p.actT = 0; p.actDur = 60; p.moveMode = MoveMode.LOCKED;
      const late = best(of(scan(s, 6), 9, [KickKind.THROUGH_GROUND]));
      if (late) expect(late.completion).toBeLessThan(quick!.completion * 0.5);
    });
  });

  describe('crosses only in the crossing zone', () => {
    function boxScene(cx: number, cz: number): SimState {
      const s = scene(5);
      place(s, 5, cx, cz); own(s, 5);
      place(s, 9, 41, 2, 2, 0);
      place(s, 10, 39, -5, 2, 0);
      place(s, 13, 45, -3); place(s, 14, 45, 4); place(s, 15, cx - 1, cz - 4);
      return s;
    }
    const crossesOf = (opts: PassOption[]): PassOption[] => opts.filter((o) => o.kind === KickKind.CROSS);

    it('a wide carrier in the zone gets crosses to attackers in the box', () => {
      const s = boxScene(38, 26);
      const opts = scan(s, 5);
      expectValid(s, 5, opts);
      const cr = crossesOf(opts);
      expect(cr.length).toBeGreaterThanOrEqual(2);
      for (const o of cr) {
        expect(inPenaltyArea(o.x, o.z, 1)).toBe(true);
        expect([9, 10]).toContain(o.target);
        expect(o.danger).toBeGreaterThan(0);
      }
      // Near post, penalty spot and far post are different targets.
      const xs = cr.map((o) => `${o.x.toFixed(1)},${o.z.toFixed(1)}`);
      expect(new Set(xs).size).toBe(cr.length);
    });

    it('no crosses outside the zone (too central, not deep enough) or without an attacker', () => {
      expect(crossesOf(scan(boxScene(38, CROSS_ZONE_MIN_Z - 2), 5))).toHaveLength(0);
      expect(crossesOf(scan(boxScene(HALF_LENGTH - CROSS_ZONE_DEPTH - 3, 26), 5))).toHaveLength(0);
      const s = boxScene(38, 26);
      place(s, 9, 10, 2); place(s, 10, 12, -5);
      expect(crossesOf(scan(s, 5))).toHaveLength(0);
    });

    it('no lob passes from the zone (a lob there becomes a cross)', () => {
      const s = boxScene(38, 26);
      expect(scan(s, 5).filter((o) => o.kind === KickKind.LOB_PASS)).toHaveLength(0);
    });

    it('an offside attacker is not a cross target', () => {
      const s = boxScene(38, 26);
      place(s, 13, 30, -3); place(s, 14, 30, 4); place(s, 15, 30, 15); place(s, 12, 30, -15);
      // 9 and 10 are now beyond the second-last defender (x = 30) and the ball (x = 38.4).
      expect(crossesOf(scan(s, 5))).toHaveLength(0);
      s.config = { ...s.config, offside: 0 };
      expect(crossesOf(scan(s, 5)).length).toBeGreaterThan(0);
    });

    it('works for the team attacking -x (mirrored)', () => {
      const s = scene();
      s.teams[0]!.dir = -1; s.teams[1]!.dir = 1;
      for (let i = 0; i < 22; i++) { const p = s.players[i]!; p.x = -p.x; p.z = -p.z; }
      place(s, 5, -38, -26); own(s, 5);
      place(s, 9, -41, -2, -2, 0);
      place(s, 10, -39, 5, -2, 0);
      place(s, 13, -45, 3); place(s, 14, -45, -4); place(s, 11, -49, 0);
      const opts = scan(s, 5);
      expectValid(s, 5, opts);
      const cr = crossesOf(opts);
      expect(cr.length).toBeGreaterThan(0);
      for (const o of cr) {
        expect(inPenaltyArea(o.x, o.z, -1)).toBe(true);
        expect(o.progress).toBeGreaterThan(0);
      }
    });
  });

  it('offside receivers are not options (unless offside is off)', () => {
    const s = scene();
    place(s, 9, 35, 6); // beyond the away back line (27..28)
    expect(of(scan(s, 6), 9)).toHaveLength(0);
    s.config = { ...s.config, offside: 0 };
    expect(of(scan(s, 6), 9).length).toBeGreaterThan(0);
  });

  it('the keeper is only a short ground option', () => {
    const s = scene(2);
    place(s, 2, -32, 10); own(s, 2);
    const opts = scan(s, 2);
    const gk = of(opts, 0);
    expect(gk.length).toBe(1);
    expect(GROUNDISH).toContain(gk[0]!.kind);
    expect(gk[0]!.danger).toBe(0);
    const s2 = scene(6);
    expect(of(scan(s2, 6), 0)).toHaveLength(0); // 50 m away
  });

  it('danger rewards the box and getting behind the defensive line', () => {
    const s = scene();
    sparse(s, [6, 9, 10, 13, 14]);
    place(s, 6, 20, 0); own(s, 6);
    place(s, 9, 40, 2);
    place(s, 10, 25, -12);
    place(s, 13, 44, -6); place(s, 14, 44, 8);
    const opts = scan(s, 6);
    const box = best(of(opts, 9, GROUNDISH))!, wide = best(of(opts, 10, GROUNDISH))!;
    expect(box.danger).toBeGreaterThan(wide.danger);
    // Same spot in front of the defenders vs behind them.
    const s2 = scene();
    sparse(s2, [6, 9, 13, 14]);
    place(s2, 6, 10, 0); own(s2, 6);
    place(s2, 9, 30, 2);
    place(s2, 13, 33, -10); place(s2, 14, 33, 12);
    const front = best(of(scan(s2, 6), 9, GROUNDISH))!;
    place(s2, 13, 27, -10); place(s2, 14, 27, 12);
    const behind = best(of(scan(s2, 6), 9, GROUNDISH))!;
    expect(behind.danger).toBeGreaterThan(front.danger);
  });

  it('team style weights the score (direct favours progress over safety)', () => {
    const s = scene();
    sparse(s, [6, 9, 2]);
    place(s, 6, 5, 0); own(s, 6);
    place(s, 9, 26, 5);
    place(s, 2, -8, 3);
    place(s, 17, 16, 8); // makes the forward pass a risk
    const gap = (style: TeamStyle): number => {
      s.teams[0]!.style = style;
      const opts = scan(s, 6);
      return best(of(opts, 9))!.score - best(of(opts, 2))!.score;
    };
    expect(gap(TeamStyle.DIRECT)).toBeGreaterThan(gap(TeamStyle.POSSESSION));
  });

  it('keeps the best options when out[] is small, sorted best first', () => {
    const s = scene();
    s.players[9]!.vx = 7;
    const all = scan(s, 6);
    expect(all.length).toBeGreaterThan(5);
    const top = scan(s, 6, 3);
    expect(top).toHaveLength(3);
    expect(top.map((o) => o.score)).toEqual(all.slice(0, 3).map((o) => o.score));
    expect(top.map((o) => [o.target, o.kind])).toEqual(all.slice(0, 3).map((o) => [o.target, o.kind]));
  });

  it('is deterministic and pure', () => {
    const a = scene(), b = scene();
    a.players[9]!.vx = 7; b.players[9]!.vx = 7;
    const h = hashState(a);
    const oa = scan(a, 6), ob = scan(b, 6), oa2 = scan(a, 6);
    expect(oa).toEqual(ob);
    expect(oa2).toEqual(oa);
    expect(hashState(a)).toBe(h);
    expect(a.rng).toEqual(b.rng);
  });

  it('an invalid or inactive carrier gives no options', () => {
    const s = scene();
    const out = createPassOptions(8);
    expect(scorePassOptions(s, -1, out)).toBe(0);
    expect(scorePassOptions(s, 22, out)).toBe(0);
    expect(scorePassOptions(s, 3.5, out)).toBe(0);
    expect(scorePassOptions(s, NaN, out)).toBe(0);
    expect(scorePassOptions(s, 6, [])).toBe(0);
    s.players[6]!.active = 0;
    expect(scorePassOptions(s, 6, out)).toBe(0);
  });

  it('a carrier without the ball scans from his feet; the away team scans toward -x', () => {
    const s = scene(20);
    const opts = scan(s, 20);
    expectValid(s, 20, opts);
    expect(opts.length).toBeGreaterThan(0);
    const fwd = opts.filter((o) => o.x < s.players[20]!.x - 5);
    for (const o of fwd) expect(o.progress).toBeGreaterThan(0);
    s.ball.owner = -1; s.ball.x = 30; s.ball.z = 30;
    const loose = scan(s, 20);
    expect(loose.length).toBeGreaterThan(0);
    for (const o of loose) expect(Math.abs(o.progress - (s.players[20]!.x - o.x))).toBeLessThan(1e-9);
  });

  it('fuzz: random scenes give well-formed options', () => {
    let seed = 99;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
    for (let k = 0; k < 120; k++) {
      const s = scene();
      for (let i = 0; i < 22; i++) {
        const p = s.players[i]!;
        p.x = (rnd() * 2 - 1) * (HALF_LENGTH - 1); p.z = (rnd() * 2 - 1) * (HALF_WIDTH - 1);
        p.vx = (rnd() * 2 - 1) * 8; p.vz = (rnd() * 2 - 1) * 8;
        p.job = rnd() < 0.2 ? AiJob.RUN_IN_BEHIND : AiJob.HOLD_SHAPE;
        if (rnd() < 0.05) p.stunT = 30;
      }
      const carrier = 1 + Math.floor(rnd() * 10) + (k & 1 ? PLAYERS_PER_TEAM : 0);
      own(s, carrier);
      if (k % 7 === 0) s.teams[0]!.style = k % 5;
      const opts = scan(s, carrier, k % 3 === 0 ? 6 : 48);
      expectValid(s, carrier, opts);
    }
  });
});
