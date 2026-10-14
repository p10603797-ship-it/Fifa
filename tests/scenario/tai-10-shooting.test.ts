/**
 * [TAI-10] CPU shooting, dribbling and skill choices: estimateXg (distance, angle, blockers, pressure, keeper,
 * attributes), bestDribble (space, progress, pitch edges) and chooseSkill (star gating, defender in front, space
 * beside / behind). Scenario states come from initMatch (tests/harness/scenario.ts) with explicit positions; the
 * functions only read the state.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, HALF_WIDTH, PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { ActionKind, Foot, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_SKILL } from '../../src/contracts/tuning';
import { bestDribble, chooseSkill, DRIBBLE_DIRS, estimateXg, LOCAL_TUNING, SKILL_CHOICE } from '../../src/ai/cpu/shooting';
import { hashState } from '../../src/sim/core/hash';
import { makeScenario } from '../harness/scenario';

// ---------------------------------------------------------------- scenes

const SHOOTER = 9;
const KEEPER = 11;

/** Empty pitch: only `keep` slots active (keepers too unless dropped), everyone still, average attributes for the
 *  shooter (finishing / longShots / composure 70, weak foot 3, right footed) facing the attacked goal. */
function empty(keep: number[] = [SHOOTER, KEEPER]): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY });
  s.teams[0]!.dir = 1; s.teams[1]!.dir = -1;
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    p.active = keep.includes(i) ? 1 : 0;
    p.vx = 0; p.vz = 0; p.fx = i < PLAYERS_PER_TEAM ? 1 : -1; p.fz = 0;
    p.act = ActionKind.NONE; p.moveMode = MoveMode.STOP; p.stunT = 0; p.stamina = 1;
    p.x = i < PLAYERS_PER_TEAM ? -20 : 20; p.z = 0;
  }
  for (const slot of [SHOOTER, 20]) {
    const a = s.attrs[slot]!;
    a.finishing = 70; a.longShots = 70; a.composure = 70; a.weakFoot = 3; a.foot = Foot.RIGHT; a.skillMoves = 3;
    a.topSpeed = 8.6;
  }
  return s;
}

/** Shooter (team 0, attacking +x) at (x, z) with the opposing keeper at GKP-01's normal depth on the goal-centre line. */
function shot(x: number, z: number, keeper = true): SimState {
  const s = empty(keeper ? [SHOOTER, KEEPER] : [SHOOTER]);
  const p = s.players[SHOOTER]!;
  p.x = x; p.z = z;
  if (keeper) normalKeeper(s, x, z);
  return s;
}

function normalKeeper(s: SimState, x: number, z: number, depthAdd = 0): void {
  const gx = HALF_LENGTH;
  const dx = x - gx, dz = z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const far = Math.min(1, Math.max(0, (d - LOCAL_TUNING.depthNearDist) / (LOCAL_TUNING.depthFarDist - LOCAL_TUNING.depthNearDist)));
  const depth = 1.2 + 3.3 * far + depthAdd;
  const k = s.players[KEEPER]!;
  k.active = 1; k.x = gx + (dx / d) * depth; k.z = (dz / d) * depth;
}

function place(s: SimState, slot: number, x: number, z: number, vx = 0, vz = 0): void {
  const p = s.players[slot]!;
  p.active = 1; p.x = x; p.z = z; p.vx = vx; p.vz = vz;
}

/** A point `ahead` m from (x, z) toward the attacked goal centre (team 0), shifted `side` m to the right of that line. */
function onLine(x: number, z: number, ahead: number, side = 0): [number, number] {
  const dx = HALF_LENGTH - x, dz = -z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const ux = dx / d, uz = dz / d;
  return [x + ux * ahead - uz * side, z + uz * ahead + ux * side];
}

const xg = (s: SimState, slot = SHOOTER): number => estimateXg(s, slot, s.players[slot]!.x, s.players[slot]!.z);

/** Give the ball to `slot` at his feet. */
function own(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const b = s.ball;
  b.owner = slot; b.heldBy = -1; b.x = p.x + 0.4 * p.fx; b.z = p.z + 0.4 * p.fz; b.y = 0.11; b.px = b.x; b.pz = b.z;
  b.vx = 0; b.vz = 0; b.vy = 0;
}

// ---------------------------------------------------------------- estimateXg

describe('TAI-10 estimateXg: distance and angle', () => {
  it('falls monotonically with distance on the central line (6 .. 44 m)', () => {
    let prev = 2;
    for (let d = 6; d <= 44; d += 1) {
      const s = shot(HALF_LENGTH - d, 0);
      const v = xg(s);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(prev);
      prev = v;
    }
  });

  it('falls monotonically as the angle tightens at a fixed distance (14 m, 0 .. 80 degrees)', () => {
    let prev = 2;
    for (let deg = 0; deg <= 80; deg += 5) {
      const a = (deg * Math.PI) / 180;
      const x = HALF_LENGTH - 14 * Math.cos(a), z = 14 * Math.sin(a);
      const v = xg(shot(x, z));
      expect(v).toBeLessThan(prev);
      prev = v;
    }
  });

  it('is symmetric left / right (two-footed shooter) and for the team attacking -x', () => {
    for (const [x, z] of [[40, 5], [30, -9], [45, 12]] as const) {
      const two = (zz: number): number => { const s = shot(x, zz); s.attrs[SHOOTER]!.weakFoot = 5; return xg(s); };
      const a = xg(shot(x, z));
      const b = two(-z);
      expect(two(z)).toBeCloseTo(b, 9);
      // Mirror: the away striker (slot 20) attacking -x from (-x, -z) against keeper 0.
      const s = empty([20, 0]);
      place(s, 20, -x, -z);
      s.players[20]!.fx = -1;
      Object.assign(s.attrs[0]!, { gkReflexes: s.attrs[KEEPER]!.gkReflexes, gkDiving: s.attrs[KEEPER]!.gkDiving });
      const gx = -HALF_LENGTH, dx = -x - gx, dz = -z, d = Math.sqrt(dx * dx + dz * dz);
      const far = Math.min(1, Math.max(0, (d - 5) / 23));
      const depth = 1.2 + 3.3 * far;
      place(s, 0, gx + (dx / d) * depth, (dz / d) * depth);
      expect(xg(s, 20)).toBeCloseTo(a, 9);
    }
  });

  it('is 0 on or behind the goal line, beyond maxDist, for invalid or inactive slots and non-finite spots', () => {
    const s = shot(40, 0);
    expect(estimateXg(s, SHOOTER, HALF_LENGTH, 0)).toBe(0);
    expect(estimateXg(s, SHOOTER, HALF_LENGTH + 1, 2)).toBe(0);
    expect(estimateXg(s, SHOOTER, HALF_LENGTH - LOCAL_TUNING.maxDist - 1, 0)).toBe(0);
    expect(estimateXg(s, -1, 40, 0)).toBe(0);
    expect(estimateXg(s, 22, 40, 0)).toBe(0);
    expect(estimateXg(s, 2.5, 40, 0)).toBe(0);
    expect(estimateXg(s, SHOOTER, Number.NaN, 0)).toBe(0);
    expect(estimateXg(s, SHOOTER, 40, Number.POSITIVE_INFINITY)).toBe(0);
    s.players[SHOOTER]!.active = 0;
    expect(estimateXg(s, SHOOTER, 40, 0)).toBe(0);
  });
});

describe('TAI-10 estimateXg: calibration bands', () => {
  it('typical box shots (11 .. 16.5 m, a defender pressing or partly in the way) are 0.08 .. 0.35', () => {
    for (const d of [11, 12.5, 14, 16]) {
      for (const deg of [0, 15, 25]) {
        const a = (deg * Math.PI) / 180;
        const x = HALF_LENGTH - d * Math.cos(a), z = d * Math.sin(a);
        // Pressing defender 2 m away, beside the shooter.
        const s1 = shot(x, z);
        const [px, pz] = onLine(x, z, 0.5, 2);
        place(s1, 13, px, pz);
        const v1 = xg(s1);
        expect(v1, `pressed d=${d} deg=${deg}`).toBeGreaterThanOrEqual(0.08);
        expect(v1, `pressed d=${d} deg=${deg}`).toBeLessThanOrEqual(0.35);
        // Defender in the lane half covering it, 6 m out.
        const s2 = shot(x, z);
        const [bx, bz] = onLine(x, z, 6, 1.4);
        place(s2, 13, bx, bz);
        const v2 = xg(s2);
        expect(v2, `half blocked d=${d} deg=${deg}`).toBeGreaterThanOrEqual(0.08);
        expect(v2, `half blocked d=${d} deg=${deg}`).toBeLessThanOrEqual(0.35);
      }
    }
  });

  it('long shots (24 .. 30 m, keeper set) are 0.02 .. 0.05', () => {
    for (const d of [24, 26, 28, 30]) {
      for (const z of [0, 4, -6]) {
        const x = HALF_LENGTH - Math.sqrt(d * d - z * z);
        const s = shot(x, z);
        const v = xg(s);
        expect(v, `clean d=${d} z=${z}`).toBeGreaterThanOrEqual(0.02);
        expect(v, `clean d=${d} z=${z}`).toBeLessThanOrEqual(0.05);
        // Closed down from 3 m.
        const [px, pz] = onLine(x, z, 1, 3);
        place(s, 13, px, pz);
        const w = xg(s);
        expect(w).toBeLessThan(v);
        expect(w, `pressed d=${d} z=${z}`).toBeGreaterThanOrEqual(0.015);
      }
    }
  });

  it('one-on-ones (8 .. 11 m, nobody between, keeper set or rushing out) are 0.35 .. 0.6', () => {
    for (const d of [8, 9, 10, 11]) {
      for (const z of [0, 2.5]) {
        const x = HALF_LENGTH - Math.sqrt(d * d - z * z);
        const v = xg(shot(x, z));
        expect(v, `set d=${d} z=${z}`).toBeGreaterThanOrEqual(0.35);
        expect(v, `set d=${d} z=${z}`).toBeLessThanOrEqual(0.6);
      }
    }
    // Through on goal from 12 .. 14 m with the keeper rushing out to 5 .. 7 m.
    for (const [d, out] of [[12, 6], [13, 7], [14, 7]] as const) {
      const s = shot(HALF_LENGTH - d, 0);
      place(s, KEEPER, HALF_LENGTH - out, 0);
      const v = xg(s);
      expect(v, `rush d=${d} out=${out}`).toBeGreaterThanOrEqual(0.35);
      expect(v, `rush d=${d} out=${out}`).toBeLessThanOrEqual(0.6);
    }
  });

  it('stays inside 0 .. xgCap and finite over a grid of spots with a crowd', () => {
    const s = shot(30, 0);
    for (let i = 0; i < PLAYERS_PER_TEAM; i++) place(s, PLAYERS_PER_TEAM + i, 30 + ((i * 7) % 20), ((i * 11) % 30) - 15, (i % 3) - 1, (i % 2) - 0.5);
    for (let x = -50; x <= 52; x += 3.7) {
      for (let z = -33; z <= 33; z += 4.1) {
        const v = estimateXg(s, SHOOTER, x, z);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(LOCAL_TUNING.xgCap);
      }
    }
  });
});

describe('TAI-10 estimateXg: blockers, pressure, keeper, attributes', () => {
  it('a defender in the shooting lane lowers it, more blockers lower it more, one outside the lane does not', () => {
    const base = xg(shot(38, 3));
    const s1 = shot(38, 3);
    const [bx, bz] = onLine(38, 3, 4);
    place(s1, 13, bx, bz);
    const one = xg(s1);
    expect(one).toBeLessThan(base * 0.5);
    const [cx, cz] = onLine(38, 3, 9, 0.8);
    place(s1, 14, cx, cz);
    const two = xg(s1);
    expect(two).toBeLessThan(one);
    // Well wide of the lane and of the shooter (no block, no pressure).
    const s2 = shot(38, 3);
    const [ox, oz] = onLine(38, 3, 6, 6);
    place(s2, 13, ox, oz);
    expect(xg(s2)).toBeCloseTo(base, 9);
    // Behind the shooter: no block either.
    const s3 = shot(38, 3);
    place(s3, 13, 30, 3);
    expect(xg(s3)).toBeCloseTo(base, 9);
  });

  it('a blocker right in front of the ball smothers the shot (floor), never below 0', () => {
    const s = shot(40, 0);
    place(s, 13, 41, 0);
    const v = xg(s);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.06);
  });

  it('pressure lowers it, a closing opponent counts by where he will be, composure softens it', () => {
    const base = xg(shot(39, 2));
    const near = shot(39, 2); place(near, 13, 39, 3.2);
    const far = shot(39, 2); place(far, 13, 39, 5.5);
    expect(xg(near)).toBeLessThan(xg(far));
    expect(xg(far)).toBeLessThan(base + 1e-12);
    const still = shot(39, 2); place(still, 13, 39, 8);
    const closing = shot(39, 2); place(closing, 13, 39, 8, 0, -12);
    expect(xg(still)).toBeCloseTo(base, 9);
    expect(xg(closing)).toBeLessThan(xg(still));
    const calm = shot(39, 2); place(calm, 13, 39, 3.2); calm.attrs[SHOOTER]!.composure = 99;
    const nervy = shot(39, 2); place(nervy, 13, 39, 3.2); nervy.attrs[SHOOTER]!.composure = 20;
    expect(xg(calm)).toBeGreaterThan(xg(nervy));
  });

  it('a keeper out of position raises it: shifted to one post, off his line, down, or absent', () => {
    const set = xg(shot(40, 0));
    const shifted = shot(40, 0); place(shifted, KEEPER, 51, 3.2);
    expect(xg(shifted)).toBeGreaterThan(set + 0.05);
    const shiftedLess = shot(40, 0); place(shiftedLess, KEEPER, 51, 1.6);
    expect(xg(shiftedLess)).toBeGreaterThan(set - 1e-12);
    expect(xg(shiftedLess)).toBeLessThan(xg(shifted));
    // Off his line with room to chip: long range keeper 12 m out.
    const lr = xg(shot(25, 0));
    const lrOff = shot(25, 0); place(lrOff, KEEPER, HALF_LENGTH - 12, 0);
    expect(xg(lrOff)).toBeGreaterThan(lr * 3);
    // Down after a dive.
    const down = shot(40, 0); down.players[KEEPER]!.act = ActionKind.FALLEN;
    expect(xg(down)).toBeGreaterThan(set + 0.2);
    // Rounded (level with / behind the shooter) and absent.
    const rounded = shot(46, 0); place(rounded, KEEPER, 41, 3);
    const absent = shot(46, 0, false);
    expect(xg(rounded)).toBeGreaterThan(0.8);
    expect(xg(absent)).toBeCloseTo(xg(rounded), 9);
  });

  it('a better keeper (reflexes / diving) is only harder to beat when he is out of position', () => {
    const good = shot(40, 0); place(good, KEEPER, 51, 2.8);
    const bad = shot(40, 0); place(bad, KEEPER, 51, 2.8);
    good.attrs[KEEPER]!.gkReflexes = 99; good.attrs[KEEPER]!.gkDiving = 99;
    bad.attrs[KEEPER]!.gkReflexes = 20; bad.attrs[KEEPER]!.gkDiving = 20;
    expect(xg(good)).toBeLessThan(xg(bad));
  });

  it('attributes matter mildly: finishing in the box, long shots from range, the weaker foot', () => {
    const box = (fin: number): number => { const s = shot(40, 2); s.attrs[SHOOTER]!.finishing = fin; return xg(s); };
    expect(box(99)).toBeGreaterThan(box(70));
    expect(box(70)).toBeGreaterThan(box(40));
    expect(box(99) / box(40)).toBeLessThan(2.2);
    expect(box(99) / box(40)).toBeGreaterThan(1.2);
    // Long shots use longShots, not finishing.
    const lr = (ls: number, fin: number): number => {
      const s = shot(24, 0); s.attrs[SHOOTER]!.longShots = ls; s.attrs[SHOOTER]!.finishing = fin; return xg(s);
    };
    expect(lr(95, 50)).toBeGreaterThan(lr(50, 95));
    // Weaker foot (SIM-07's rule): a right-footer turning sharply to his right (facing -z, goal on his right) strikes
    // with his left.
    const wf = (stars: number, foot: Foot): number => {
      const s = shot(40, 6); const p = s.players[SHOOTER]!; p.fx = 0; p.fz = -1;
      s.attrs[SHOOTER]!.weakFoot = stars; s.attrs[SHOOTER]!.foot = foot; return xg(s);
    };
    expect(wf(1, Foot.RIGHT)).toBeLessThan(wf(5, Foot.RIGHT));
    expect(wf(1, Foot.RIGHT) / wf(5, Foot.RIGHT)).toBeGreaterThan(1 - LOCAL_TUNING.weakMax - 1e-9);
    // A left-footer turning to his right uses his strong foot.
    expect(wf(1, Foot.LEFT)).toBeCloseTo(wf(5, Foot.LEFT), 12);
  });

  it('is pure and deterministic (state unchanged, same value twice)', () => {
    const s = shot(36, -5);
    for (let i = 0; i < PLAYERS_PER_TEAM; i++) place(s, PLAYERS_PER_TEAM + i, 30 + i * 2, (i % 5) * 3 - 6, 1, -1);
    const h = hashState(s);
    const a = xg(s);
    const b = xg(s);
    expect(b).toBe(a);
    expect(hashState(s)).toBe(h);
  });
});

// ---------------------------------------------------------------- bestDribble

const DIR = { x: 0, z: 0 };
const dribble = (s: SimState, slot = SHOOTER): number => bestDribble(s, slot, DIR);
const angleDeg = (x: number, z: number): number => (Math.atan2(z, x) * 180) / Math.PI;

describe('TAI-10 bestDribble', () => {
  it('runs straight at goal into an empty pitch with a high score and a unit direction', () => {
    const s = shot(0, 0);
    const sc = dribble(s);
    expect(sc).toBeGreaterThan(0.85);
    expect(sc).toBeLessThanOrEqual(1);
    expect(Math.hypot(DIR.x, DIR.z)).toBeCloseTo(1, 9);
    expect(DIR.x).toBeCloseTo(1, 6);
  });

  it(`samples ${DRIBBLE_DIRS} directions (8..12) relative to the goal direction`, () => {
    expect(DRIBBLE_DIRS).toBeGreaterThanOrEqual(8);
    expect(DRIBBLE_DIRS).toBeLessThanOrEqual(12);
    const s = shot(0, 20);
    dribble(s);
    // Empty pitch: straight at the goal centre.
    const gx = HALF_LENGTH, gz = -20, gl = Math.hypot(gx, gz);
    expect(DIR.x).toBeCloseTo(gx / gl, 6);
    expect(DIR.z).toBeCloseTo(gz / gl, 6);
  });

  it('turns away from a defender straight ahead (to the side away from his offset) and scores less', () => {
    const open = dribble(shot(0, 0));
    const s = shot(0, 0);
    place(s, 13, 3, 0.4);
    const sc = dribble(s);
    expect(sc).toBeLessThan(open);
    expect(Math.abs(angleDeg(DIR.x, DIR.z))).toBeGreaterThanOrEqual(29);
    // Defender a little to the +z side: go to the -z side.
    expect(DIR.z).toBeLessThan(0);
    // The chosen run keeps clear of him: closest approach along the first 5 m is > 2 m.
    for (let r = 0; r <= 5; r += 0.5) expect(Math.hypot(r * DIR.x - 3, r * DIR.z - 0.4)).toBeGreaterThan(2);
  });

  it('runs into the gap between two defenders rather than at either', () => {
    const s = shot(0, 0);
    place(s, 13, 5, 4.5);
    place(s, 14, 5, -4.5);
    place(s, 15, 3, 3);
    dribble(s);
    // Not toward the +z cluster.
    expect(DIR.z).toBeLessThan(0.3);
    expect(DIR.x).toBeGreaterThan(0);
  });

  it('a defender closing fast is judged by where he will be', () => {
    const still = shot(0, 0); place(still, 13, 8, 12);
    const coming = shot(0, 0); place(coming, 13, 8, 12, 0, -9);
    const sa = dribble(still);
    const a = angleDeg(DIR.x, DIR.z);
    const sb = dribble(coming);
    expect(a).toBeCloseTo(0, 6);
    expect(DIR.z).toBeLessThan(-0.4);
    expect(sb).toBeLessThanOrEqual(sa);
  });

  it('never runs over a touchline or goal line (carrier on the touchline, in a corner, at the goal line)', () => {
    const cases: [number, number, number, number][] = [[0, HALF_WIDTH - 0.5, 1, 0], [0, -HALF_WIDTH + 0.8, 1, 0],
      [HALF_LENGTH - 1, HALF_WIDTH - 1, 1, 0], [HALF_LENGTH - 0.8, 12, 0, 1], [-HALF_LENGTH + 2, -HALF_WIDTH + 2, -1, -1]];
    for (const [x, z, fx, fz] of cases) {
      const s = shot(x, z);
      const p = s.players[SHOOTER]!; p.fx = fx; p.fz = fz;
      // A defender on the infield side pushes him toward the line.
      place(s, 13, x - 2 * Math.sign(x || 1), z - 2.5 * Math.sign(z || 1));
      const sc = dribble(s);
      expect(sc).toBeGreaterThan(0);
      const ex = x + DIR.x * 3, ez = z + DIR.z * 3;
      expect(Math.abs(ez), `z at (${x},${z})`).toBeLessThanOrEqual(HALF_WIDTH);
      expect(Math.abs(ex), `x at (${x},${z})`).toBeLessThanOrEqual(HALF_LENGTH);
      // Moving away from (or along) the near touchline.
      if (Math.abs(z) > HALF_WIDTH - 2.5) expect(DIR.z * Math.sign(z)).toBeLessThanOrEqual(1e-9);
    }
  });

  it('surrounded scores far lower than open pitch', () => {
    const s = shot(0, 0);
    let k = 13;
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      place(s, k++, 2.2 * Math.cos(a), 2.2 * Math.sin(a));
    }
    expect(dribble(s)).toBeLessThan(0.45);
  });

  it('moving fast one way prefers not to turn round when both ways are open', () => {
    const s = shot(0, 0);
    s.players[SHOOTER]!.vx = 0; s.players[SHOOTER]!.vz = 7;
    place(s, 13, 3, 0);
    dribble(s);
    expect(DIR.z).toBeGreaterThan(0);
  });

  it('works for the team attacking -x and refuses invalid slots', () => {
    const s = empty([20, 0]);
    place(s, 20, 0, 0);
    place(s, 0, -HALF_LENGTH + 1, 0);
    expect(dribble(s, 20)).toBeGreaterThan(0.85);
    expect(DIR.x).toBeCloseTo(-1, 6);
    DIR.x = 5; DIR.z = 5;
    expect(bestDribble(s, -1, DIR)).toBe(0);
    expect(DIR.x).toBe(0); expect(DIR.z).toBe(0);
    s.players[20]!.active = 0;
    expect(bestDribble(s, 20, DIR)).toBe(0);
  });

  it('is pure and deterministic', () => {
    const s = shot(10, 5);
    for (let i = 1; i < PLAYERS_PER_TEAM; i++) place(s, PLAYERS_PER_TEAM + i, 10 + ((i * 5) % 17) - 6, ((i * 7) % 19) - 9, (i % 3) - 1, 1 - (i % 2) * 2);
    const h = hashState(s);
    const a = dribble(s), ax = DIR.x, az = DIR.z;
    const b = dribble(s);
    expect(b).toBe(a); expect(DIR.x).toBe(ax); expect(DIR.z).toBe(az);
    expect(hashState(s)).toBe(h);
  });
});

// ---------------------------------------------------------------- chooseSkill

/** Carrier (slot 9) at (0, 0) facing +x with the ball, stars as given; defender slot 13 at (d, lat) moving (vx, vz). */
function duel(stars: number, d: number, lat = 0, vx = 0, vz = 0): SimState {
  const s = empty([SHOOTER, KEEPER]);
  place(s, KEEPER, HALF_LENGTH - 1, 0);
  place(s, SHOOTER, 0, 0);
  s.attrs[SHOOTER]!.skillMoves = stars;
  own(s, SHOOTER);
  place(s, 13, d, lat, vx, vz);
  s.attrs[13]!.topSpeed = 8.2; s.attrs[13]!.accel = 6;
  return s;
}

const SIDE_MOVES = [SkillMove.BALL_ROLL, SkillMove.STEP_OVER, SkillMove.BODY_FEINT, SkillMove.ROULETTE];

describe('TAI-10 chooseSkill', () => {
  it('nothing without a defender close in front (none, beside, behind, too far)', () => {
    const s = duel(5, 3);
    s.players[13]!.active = 0;
    expect(chooseSkill(s, SHOOTER)).toBe(SkillMove.NONE);
    expect(chooseSkill(duel(5, 0, 3), SHOOTER)).toBe(SkillMove.NONE);
    expect(chooseSkill(duel(5, -3, 0), SHOOTER)).toBe(SkillMove.NONE);
    expect(chooseSkill(duel(5, 9, 0), SHOOTER)).toBe(SkillMove.NONE);
  });

  it('a defender at 3 m with space beside him but none behind: step-over (2+ stars) or body feint (1 star)', () => {
    for (const stars of [1, 2, 3, 4, 5]) {
      const s = duel(stars, 3);
      place(s, 14, 7.5, 0); // covering behind him
      const m = chooseSkill(s, SHOOTER);
      expect(m, `stars ${stars}`).toBe(stars >= 2 ? SkillMove.STEP_OVER : SkillMove.BODY_FEINT);
      expect(SKILL_CHOICE.move).toBe(m);
      expect(Math.abs(SKILL_CHOICE.side)).toBe(1);
    }
  });

  it('a lunging defender at 1.8 m: roulette (3+ stars), ball roll (2), body feint (1)', () => {
    const expected = [SkillMove.BODY_FEINT, SkillMove.BALL_ROLL, SkillMove.ROULETTE, SkillMove.ROULETTE, SkillMove.ROULETTE];
    for (let stars = 1; stars <= 5; stars++) {
      const s = duel(stars, 1.8, 0, -4, 0);
      place(s, 14, 6, 0);
      expect(chooseSkill(s, SHOOTER), `stars ${stars}`).toBe(expected[stars - 1]);
    }
  });

  it('space behind a defender at 4 m and the pace to use it on the run: knock-on (any stars)', () => {
    const mk = (stars: number): SimState => {
      const s = duel(stars, 4);
      s.players[SHOOTER]!.vx = 5;
      place(s, 15, 4, 4); place(s, 16, 4, -4); // sides closed
      return s;
    };
    for (const stars of [1, 3, 5]) {
      expect(chooseSkill(mk(stars), SHOOTER), `stars ${stars}`).toBe(SkillMove.KNOCK_ON);
      expect(SKILL_CHOICE.side).toBe(0);
      expect(SKILL_CHOICE.dirX).toBeCloseTo(1, 9);
    }
    // A defender quicker than the carrier, the carrier standing, the defender running away, no space behind: no knock-on.
    const quick = mk(1); quick.attrs[13]!.topSpeed = 9.5; quick.attrs[SHOOTER]!.topSpeed = 7.5;
    expect(chooseSkill(quick, SHOOTER)).not.toBe(SkillMove.KNOCK_ON);
    const standing = mk(1); standing.players[SHOOTER]!.vx = 0;
    expect(chooseSkill(standing, SHOOTER)).not.toBe(SkillMove.KNOCK_ON);
    const away = mk(1); away.players[13]!.vx = 6;
    expect(chooseSkill(away, SHOOTER)).not.toBe(SkillMove.KNOCK_ON);
    const covered = mk(1); place(covered, 17, 9, 1);
    expect(chooseSkill(covered, SHOOTER)).not.toBe(SkillMove.KNOCK_ON);
  });

  it('a defender square at 2.5 m with space behind him: heel flick with 3+ stars', () => {
    const s = duel(3, 2.5);
    place(s, 15, 3, 3.5); place(s, 16, 3, -3.5); // sides closed
    expect(chooseSkill(s, SHOOTER)).toBe(SkillMove.HEEL_FLICK);
    s.attrs[SHOOTER]!.skillMoves = 2;
    expect(chooseSkill(s, SHOOTER)).not.toBe(SkillMove.HEEL_FLICK);
  });

  it('trapped (front and sides closed) by a lunging defender: drag-back with 2+ stars into space behind, else none', () => {
    const mk = (stars: number): SimState => {
      const s = duel(stars, 1.6, 0, -3, 0);
      place(s, 14, 4, 2.5); place(s, 15, 4, -2.5); place(s, 16, 1.5, 3.2); place(s, 17, 1.5, -3.2); place(s, 18, 5, 0);
      return s;
    };
    expect(chooseSkill(mk(2), SHOOTER)).toBe(SkillMove.DRAG_BACK);
    expect(SKILL_CHOICE.dirX).toBeCloseTo(-1, 9);
    expect(chooseSkill(mk(1), SHOOTER)).toBe(SkillMove.NONE);
    // No space behind either: nothing.
    const s = mk(5);
    place(s, 19, -3.5, 0);
    expect(chooseSkill(s, SHOOTER)).toBe(SkillMove.NONE);
  });

  it('no space anywhere: no skill', () => {
    const s = duel(5, 3);
    place(s, 14, 7.5, 0); place(s, 15, 3.5, 3); place(s, 16, 3.5, -3); place(s, 17, 1, 3.5); place(s, 18, 1, -3.5);
    expect(chooseSkill(s, SHOOTER)).toBe(SkillMove.NONE);
  });

  it('picks the side with the space and suggests an exit toward it', () => {
    const s = duel(2, 3);
    place(s, 14, 7.5, 0);
    place(s, 15, 4, 4.5); // the right side (+z is right of facing +x) is crowded
    expect(chooseSkill(s, SHOOTER)).toBe(SkillMove.STEP_OVER);
    expect(SKILL_CHOICE.side).toBe(-1);
    expect(SKILL_CHOICE.dirZ).toBeLessThan(0);
    expect(Math.hypot(SKILL_CHOICE.dirX, SKILL_CHOICE.dirZ)).toBeCloseTo(1, 9);
  });

  it('never exits over the touchline: on the touchline the outside probe is ignored', () => {
    const s = duel(2, 3);
    const p = s.players[SHOOTER]!;
    p.z = HALF_WIDTH - 1.2; own(s, SHOOTER);
    place(s, 13, 3, HALF_WIDTH - 1.2);
    place(s, 14, 7.5, HALF_WIDTH - 1.2);
    const m = chooseSkill(s, SHOOTER);
    expect(m).not.toBe(SkillMove.NONE);
    expect(SKILL_CHOICE.side).toBe(-1); // away from the line (+z touchline is on his right)
  });

  it('only the ball owner at his feet, never a keeper, never with 0 stars', () => {
    const s = duel(5, 3);
    place(s, 14, 7.5, 0);
    s.ball.owner = -1;
    expect(chooseSkill(s, SHOOTER)).toBe(SkillMove.NONE);
    own(s, SHOOTER); s.ball.y = 1.2;
    expect(chooseSkill(s, SHOOTER)).toBe(SkillMove.NONE);
    own(s, SHOOTER); s.attrs[SHOOTER]!.skillMoves = 0;
    expect(chooseSkill(s, SHOOTER)).toBe(SkillMove.NONE);
    const k = empty([0, 13]);
    place(k, 0, -40, 0); own(k, 0); place(k, 13, -37, 0); k.attrs[0]!.skillMoves = 5;
    expect(chooseSkill(k, 0)).toBe(SkillMove.NONE);
    expect(chooseSkill(k, -3)).toBe(SkillMove.NONE);
  });

  it('every choice over many situations respects the star gate and is a beat-the-man move (no fake shot, no stops)', () => {
    let chosen = 0;
    const seen = new Set<number>();
    for (let stars = 1; stars <= 5; stars++) {
      for (let i = 0; i < 160; i++) {
        const d = 0.8 + (i % 12) * 0.45, lat = ((i * 7) % 9) * 0.3 - 1.2, vx = -((i * 3) % 7), vz = ((i % 5) - 2) * 0.8;
        const s = duel(stars, d, lat, vx, vz);
        s.players[SHOOTER]!.vx = (i % 6) * 1.2;
        if (i % 3 === 0) place(s, 14, d + 4, lat);
        if (i % 4 === 1) place(s, 15, d * 0.8, 3);
        if (i % 5 === 2) place(s, 16, d * 0.8, -3);
        if (i % 7 === 3) place(s, 17, -3, 0.5);
        const m = chooseSkill(s, SHOOTER);
        if (m === SkillMove.NONE) continue;
        chosen++;
        seen.add(m);
        expect(stars).toBeGreaterThanOrEqual(T_SKILL.minStars[m]!);
        expect([...SIDE_MOVES, SkillMove.KNOCK_ON, SkillMove.HEEL_FLICK, SkillMove.DRAG_BACK]).toContain(m);
      }
    }
    expect(chosen).toBeGreaterThan(100);
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });

  it('works for the team attacking -x, and is pure and deterministic', () => {
    const s = empty([20, 0]);
    place(s, 0, -HALF_LENGTH + 1, 0);
    place(s, 20, 0, 0); s.players[20]!.fx = -1; s.attrs[20]!.skillMoves = 2;
    own(s, 20);
    place(s, 3, -3, 0); place(s, 4, -7.5, 0);
    const h = hashState(s);
    expect(chooseSkill(s, 20)).toBe(SkillMove.STEP_OVER);
    expect(chooseSkill(s, 20)).toBe(SkillMove.STEP_OVER);
    expect(hashState(s)).toBe(h);
  });
});
