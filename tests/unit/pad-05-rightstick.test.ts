/**
 * PAD-05 — right-stick recogniser (src/input/pad/rightStick.ts). Synthetic stick paths, sampled per animation frame
 * (60 / 120 Hz) and read once per 60 Hz tick through applyTo(), exactly like the pad mapper does:
 *  - every skill pattern in several facings (incl. facing -x) and a rotated camera, with and without noise;
 *  - flick vs hold vs roll discrimination, sequence timeouts, one skill per stroke;
 *  - no false positives from normal right-stick use (aiming, small deflections, slow sweeps, threshold noise);
 *  - RS_FLICK / RS_HOLD bits, flick direction in ax/az, latch hygiene, reset (releaseAll) and the context gate;
 *  - drag-back from L1 + R1 + left stick flicked back.
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase, SkillMove } from '../../src/contracts/enums';
import { AXIS_SCALE, Btn, createInputFrame, type CameraProjector, type InputFrame, type InputSampleContext } from '../../src/contracts/input';
import { createMatchConfig, createSimState, type SimState } from '../../src/contracts/state';
import { T_INPUT, T_PAD } from '../../src/contracts/tuning';
import {
  createRightStick, relativeAngle, RIGHT_STICK_TUNING, RsSector, sectorOf, type RightStickTracker,
} from '../../src/input/pad/rightStick';

const TICK_MS = 1000 / 60;
const DEG = Math.PI / 180;

/** A keyframe of a stick path: time ms, angle relative to facing (deg, + = right), magnitude 0..1. */
type Key = [t: number, deg: number, mag: number];

interface Sample { t: number; buttons: number; skill: SkillMove; ax: number; az: number }

interface DriveOpts {
  /** Facing (pitch space). Default +x. */
  facing?: [number, number];
  /** Animation frame rate. Default 120. */
  hz?: number;
  /** Camera stick rotation (radians). Default 0. */
  rot?: number;
  /** Angle noise (deg) and magnitude noise amplitudes, seeded. */
  noiseDeg?: number;
  noiseMag?: number;
  seed?: number;
  /** Btn bits held for the whole path (SPRINT, MOD_L, MOD_R). */
  buttons?: number;
  /** Left-stick path (same key format, relative to facing). */
  left?: Key[];
  /** Start time (ms). */
  t0?: number;
  /** Extra time after the last key (ms). Default 200. */
  tail?: number;
}

function lerpKeys(keys: Key[], t: number): [number, number] {
  if (keys.length === 0) return [0, 0];
  if (t <= keys[0]![0]) return [keys[0]![1], keys[0]![2]];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!, b = keys[i]!;
    if (t <= b[0]) {
      const u = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    }
  }
  const l = keys[keys.length - 1]!;
  return [l[1], l[2]];
}

/** Facing-relative (deg, mag) -> screen-space stick (x right, y down) for facing f and camera rotation rot. */
function toScreen(deg: number, mag: number, f: [number, number], rot: number): [number, number] {
  const fl = Math.hypot(f[0], f[1]);
  const fx = f[0] / fl, fz = f[1] / fl;
  const th = deg * DEG;
  const px = mag * (Math.cos(th) * fx + Math.sin(th) * -fz);
  const pz = mag * (Math.cos(th) * fz + Math.sin(th) * fx);
  const c = Math.cos(rot), s = Math.sin(rot);
  return [c * px + s * pz, -s * px + c * pz];
}

function lcg(seed: number): () => number {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

/** Drive a tracker along a path; one applyTo() sample per 60 Hz tick. Returns the non-empty samples. */
function drive(rs: RightStickTracker, keys: Key[], o: DriveOpts = {}): Sample[] {
  const facing = o.facing ?? [1, 0];
  const hz = o.hz ?? 120;
  const rot = o.rot ?? 0;
  const t0 = o.t0 ?? 1000;
  const rnd = lcg(o.seed ?? 1);
  const nd = o.noiseDeg ?? 0, nm = o.noiseMag ?? 0;
  rs.setFacing(facing[0], facing[1]);
  rs.setStickRotation(rot);
  const end = Math.max(keys.length ? keys[keys.length - 1]![0] : 0, o.left?.length ? o.left[o.left.length - 1]![0] : 0) + (o.tail ?? 200);
  const frameMs = 1000 / hz;
  const out: Sample[] = [];
  let nextTick = TICK_MS;
  const f = createInputFrame();
  for (let t = 0; t <= end + 1e-9; t += frameMs) {
    const [deg, mag] = lerpKeys(keys, t);
    const dn = nd ? (rnd() * 2 - 1) * nd : 0;
    const mn = nm ? (rnd() * 2 - 1) * nm : 0;
    const m = Math.max(0, Math.min(1, mag > 0 ? mag + mn : 0));
    const [sx, sy] = toScreen(deg + dn, m, facing, rot);
    let lx = 0, ly = 0;
    if (o.left) {
      const [ld, lm] = lerpKeys(o.left, t);
      [lx, ly] = toScreen(ld, lm, facing, rot);
    }
    rs.setLeft(lx, ly, o.buttons ?? 0);
    rs.update(sx, sy, t0 + t);
    while (t + 1e-9 >= nextTick) {
      nextTick += TICK_MS;
      f.buttons = 0; f.skill = SkillMove.NONE; f.ax = 0; f.az = 0;
      rs.applyTo(f);
      if (f.buttons !== 0 || f.skill !== SkillMove.NONE) out.push({ t, buttons: f.buttons, skill: f.skill, ax: f.ax, az: f.az });
    }
  }
  return out;
}

const skills = (s: Sample[]): SkillMove[] => s.filter((x) => x.skill !== SkillMove.NONE).map((x) => x.skill);
const flicks = (s: Sample[]): Sample[] => s.filter((x) => (x.buttons & Btn.RS_FLICK) !== 0);

function dirOf(x: Sample): [number, number] {
  const m = Math.hypot(x.ax, x.az);
  return [x.ax / m, x.az / m];
}

/** Pitch-space unit vector of a facing-relative angle. */
function relDir(f: [number, number], deg: number): [number, number] {
  const fl = Math.hypot(f[0], f[1]);
  const fx = f[0] / fl, fz = f[1] / fl;
  const th = deg * DEG;
  return [Math.cos(th) * fx - Math.sin(th) * fz, Math.cos(th) * fz + Math.sin(th) * fx];
}

function expectDir(x: Sample, want: [number, number], tol = 0.02): void {
  const [dx, dz] = dirOf(x);
  expect(Math.abs(dx - want[0])).toBeLessThan(tol);
  expect(Math.abs(dz - want[1])).toBeLessThan(tol);
  expect(x.ax * x.ax + x.az * x.az).toBeLessThanOrEqual(AXIS_SCALE * AXIS_SCALE);
  expect(Math.hypot(x.ax, x.az)).toBeGreaterThan(AXIS_SCALE - 2);
}

// ------------------------------------------------------------------ patterns

const P = {
  feintRight: [[0, 90, 0], [30, 90, 1], [90, 90, 1], [120, 90, 0]] as Key[],
  feintLeft: [[0, -90, 0], [30, -90, 1], [90, -90, 1], [120, -90, 0]] as Key[],
  rollRight: [[0, 90, 0], [30, 90, 1], [500, 90, 1], [530, 90, 0]] as Key[],
  rollLeft: [[0, -90, 0], [30, -90, 1], [500, -90, 1], [530, -90, 0]] as Key[],
  stepOverRight: [[0, 0, 0], [30, 0, 1], [150, 90, 1], [250, 90, 1], [280, 90, 0]] as Key[],
  stepOverLeft: [[0, 0, 0], [30, 0, 1], [150, -90, 1], [250, -90, 1], [280, -90, 0]] as Key[],
  heelFlick: [[0, 0, 0], [30, 0, 1], [70, 0, 1], [100, 0, 0], [130, 180, 0], [160, 180, 1], [200, 180, 1], [230, 180, 0]] as Key[],
  rouletteRight: [[0, 180, 0], [30, 180, 1], [230, 0, 1], [260, 0, 0]] as Key[],
  rouletteLeft: [[0, -180, 0], [30, -180, 1], [230, 0, 1], [260, 0, 0]] as Key[],
};

interface Case { name: string; keys: Key[]; skill: SkillMove; dirDeg: number }
const CASES: Case[] = [
  { name: 'flick right -> body feint right', keys: P.feintRight, skill: SkillMove.BODY_FEINT, dirDeg: 90 },
  { name: 'flick left -> body feint left', keys: P.feintLeft, skill: SkillMove.BODY_FEINT, dirDeg: -90 },
  { name: 'hold right -> ball roll right', keys: P.rollRight, skill: SkillMove.BALL_ROLL, dirDeg: 90 },
  { name: 'hold left -> ball roll left', keys: P.rollLeft, skill: SkillMove.BALL_ROLL, dirDeg: -90 },
  { name: 'roll forward -> right -> step-over right', keys: P.stepOverRight, skill: SkillMove.STEP_OVER, dirDeg: 90 },
  { name: 'roll forward -> left -> step-over left', keys: P.stepOverLeft, skill: SkillMove.STEP_OVER, dirDeg: -90 },
  { name: 'flick forward then back -> heel flick (forward)', keys: P.heelFlick, skill: SkillMove.HEEL_FLICK, dirDeg: 0 },
  { name: 'roll back -> right -> forward -> roulette (right)', keys: P.rouletteRight, skill: SkillMove.ROULETTE, dirDeg: 90 },
  { name: 'roll back -> left -> forward -> roulette (left)', keys: P.rouletteLeft, skill: SkillMove.ROULETTE, dirDeg: -90 },
];
const FACINGS: [string, [number, number]][] = [
  ['+x', [1, 0]], ['-x', [-1, 0]], ['+z', [0, 1]], ['-z', [0, -1]], ['diagonal', [0.6, -0.8]],
];

describe('PAD-05 right-stick skill patterns, relative to facing', () => {
  for (const c of CASES) {
    for (const [fname, facing] of FACINGS) {
      for (const hz of [60, 120]) {
        it(`${c.name} (facing ${fname}, ${hz} Hz)`, () => {
          const rs = createRightStick();
          const out = drive(rs, c.keys, { facing, hz });
          const sk = out.filter((x) => x.skill !== SkillMove.NONE);
          expect(sk.map((x) => x.skill)).toEqual([c.skill]);
          expectDir(sk[0]!, relDir(facing, c.dirDeg));
          expect(rs.skillDirX).toBeCloseTo(relDir(facing, c.dirDeg)[0], 9);
          expect(rs.skillDirZ).toBeCloseTo(relDir(facing, c.dirDeg)[1], 9);
          // The skill sample never carries RS_FLICK (ax/az has one meaning per sample).
          expect(sk[0]!.buttons & Btn.RS_FLICK).toBe(0);
        });
      }
    }
  }

  it('facing -x mirrors the stick: the same physical flick is a feint to the other side', () => {
    // Stick pushed toward +z (screen down). Facing +x: +z is the player's right. Facing -x: it is his left.
    const a = createRightStick();
    const outA = drive(a, P.feintRight, { facing: [1, 0] });
    const b = createRightStick();
    const outB = drive(b, P.feintLeft, { facing: [-1, 0] });
    const sa = outA.find((x) => x.skill !== SkillMove.NONE)!;
    const sb = outB.find((x) => x.skill !== SkillMove.NONE)!;
    expect(sa.az).toBe(AXIS_SCALE);
    expect(sb.az).toBe(AXIS_SCALE);
    expect(flicks(outA)[0]!.az).toBe(AXIS_SCALE);
    expect(flicks(outB)[0]!.az).toBe(AXIS_SCALE);
  });

  it('works under a rotated camera (stick rotated into pitch space before judging)', () => {
    for (const c of CASES) {
      for (const rot of [0.7, -2.1, Math.PI]) {
        const rs = createRightStick();
        const facing: [number, number] = [-1, 0];
        const out = drive(rs, c.keys, { facing, rot });
        const sk = out.filter((x) => x.skill !== SkillMove.NONE);
        expect(sk.map((x) => x.skill), `${c.name} rot ${rot}`).toEqual([c.skill]);
        expectDir(sk[0]!, relDir(facing, c.dirDeg));
      }
    }
  });

  it('is robust to stick noise (angle +-7 deg, magnitude +-0.06) across seeds', () => {
    for (const c of CASES) {
      for (let seed = 1; seed <= 25; seed++) {
        const rs = createRightStick();
        const facing = FACINGS[seed % FACINGS.length]![1];
        const out = drive(rs, c.keys, { facing, noiseDeg: 7, noiseMag: 0.06, seed, hz: seed % 2 ? 60 : 120 });
        expect(skills(out), `${c.name} seed ${seed}`).toEqual([c.skill]);
      }
    }
  });

  it('a roll may start from a forward diagonal (step-over from 30 deg left of forward)', () => {
    const rs = createRightStick();
    const out = drive(rs, [[0, -30, 0], [30, -30, 1], [150, 90, 1], [200, 90, 1], [230, 90, 0]]);
    expect(skills(out)).toEqual([SkillMove.STEP_OVER]);
  });

  it('heel flick through the centre in one frame (forward then straight back, no centred sample)', () => {
    const rs = createRightStick();
    // 60 Hz frames: the stick jumps from forward (out) to back (out) between two samples.
    const out = drive(rs, [[0, 0, 0], [20, 0, 1], [80, 0, 1], [81, 180, 1], [150, 180, 1], [170, 180, 0]], { hz: 60 });
    expect(skills(out)).toEqual([SkillMove.HEEL_FLICK]);
    expect(flicks(out)).toHaveLength(2);
  });
});

describe('PAD-05 flick vs hold vs roll discrimination', () => {
  const sideFor = (outMs: number): Key[] => [[0, 90, 0], [10, 90, 1], [10 + outMs, 90, 1], [20 + outMs, 90, 0]];

  it('side stroke shorter than rsHoldMs is a body feint, longer is a ball roll (both at 60 and 120 Hz)', () => {
    for (const hz of [60, 120]) {
      expect(skills(drive(createRightStick(), sideFor(T_PAD.rsHoldMs - 50), { hz }))).toEqual([SkillMove.BODY_FEINT]);
      expect(skills(drive(createRightStick(), sideFor(T_PAD.rsHoldMs + 50), { hz }))).toEqual([SkillMove.BALL_ROLL]);
    }
  });

  it('ball roll fires at the hold threshold while still held (not on release)', () => {
    const rs = createRightStick();
    const out = drive(rs, sideFor(1000));
    const s = out.find((x) => x.skill === SkillMove.BALL_ROLL)!;
    expect(s.t).toBeLessThan(10 + 20 + T_PAD.rsHoldMs + 2 * TICK_MS);
  });

  it('body feint is reported on release, a ball-roll hold reports RS_HOLD, a feint never does', () => {
    const feint = drive(createRightStick(), sideFor(80));
    expect(feint.some((x) => (x.buttons & Btn.RS_HOLD) !== 0)).toBe(false);
    const roll = drive(createRightStick(), sideFor(600));
    expect(roll.filter((x) => (x.buttons & Btn.RS_HOLD) !== 0).length).toBeGreaterThan(20);
  });

  it('a step-over held at the side afterwards is still one step-over (one skill per stroke)', () => {
    const out = drive(createRightStick(), [[0, 0, 0], [30, 0, 1], [150, 90, 1], [1200, 90, 1], [1230, 90, 0]]);
    expect(skills(out)).toEqual([SkillMove.STEP_OVER]);
  });

  it('a roulette continued round to the other side is still one roulette', () => {
    const out = drive(createRightStick(), [[0, 180, 0], [30, 180, 1], [230, 0, 1], [330, -90, 1], [360, -90, 0]]);
    expect(skills(out)).toEqual([SkillMove.ROULETTE]);
  });

  it('a side flick after a forward flick is a body feint, not a heel flick', () => {
    const out = drive(createRightStick(), [[0, 0, 0], [30, 0, 1], [70, 0, 1], [100, 0, 0], [130, 90, 0], [160, 90, 1], [200, 90, 1], [230, 90, 0]]);
    expect(skills(out)).toEqual([SkillMove.BODY_FEINT]);
  });

  it('two separate side flicks give two body feints, each with its own RS_FLICK', () => {
    const out = drive(createRightStick(), [...P.feintRight, [300, -90, 0], [330, -90, 1], [390, -90, 1], [420, -90, 0]]);
    expect(skills(out)).toEqual([SkillMove.BODY_FEINT, SkillMove.BODY_FEINT]);
    const s = out.filter((x) => x.skill !== SkillMove.NONE);
    expect(Math.sign(s[0]!.az)).toBe(1);
    expect(Math.sign(s[1]!.az)).toBe(-1);
    expect(flicks(out)).toHaveLength(2);
  });
});

describe('PAD-05 sequence timeouts', () => {
  it('step-over rolled slower than rsSequenceMs is nothing (and no ball roll afterwards)', () => {
    const out = drive(createRightStick(), [[0, 0, 0], [30, 0, 1], [30 + T_PAD.rsSequenceMs * 2, 90, 1], [1500, 90, 1], [1530, 90, 0]]);
    expect(skills(out)).toEqual([]);
  });

  it('roulette rolled slower than rsSequenceMs is nothing', () => {
    const out = drive(createRightStick(), [[0, 180, 0], [30, 180, 1], [30 + T_PAD.rsSequenceMs * 1.6, 0, 1], [700, 0, 0]]);
    expect(skills(out)).toEqual([]);
  });

  it('back flick later than rsSequenceMs after the forward flick is no heel flick', () => {
    const late = T_PAD.rsSequenceMs + 80;
    const out = drive(createRightStick(), [[0, 0, 0], [30, 0, 1], [70, 0, 1], [100, 0, 0], [late, 180, 0], [late + 30, 180, 1], [late + 70, 180, 1], [late + 100, 180, 0]]);
    expect(skills(out)).toEqual([]);
    expect(flicks(out)).toHaveLength(2);
  });

  it('a forward HOLD then back flick is no heel flick (the first part must be a flick)', () => {
    const out = drive(createRightStick(), [[0, 0, 0], [10, 0, 1], [10 + T_PAD.rsHoldMs + 40, 0, 1], [T_PAD.rsHoldMs + 60, 0, 0], [T_PAD.rsHoldMs + 70, 180, 0], [T_PAD.rsHoldMs + 90, 180, 1], [T_PAD.rsHoldMs + 130, 180, 0]]);
    expect(skills(out)).toEqual([]);
  });

  it('roll back -> side then released is nothing (incomplete roulette)', () => {
    const out = drive(createRightStick(), [[0, 180, 0], [30, 180, 1], [130, 90, 1], [160, 90, 0]]);
    expect(skills(out)).toEqual([]);
  });
});

describe('PAD-05 no false positives from normal right-stick use', () => {
  it('small deflections below the flick threshold do nothing (2 s of random aiming)', () => {
    const rnd = lcg(5);
    const keys: Key[] = [];
    for (let t = 0; t <= 2000; t += 40) keys.push([t, rnd() * 720 - 360, rnd() * (T_INPUT.flickThreshold - 0.05)]);
    const out = drive(createRightStick(), keys);
    expect(out).toEqual([]);
  });

  it('single radial flicks and holds forward / back / diagonals produce RS_FLICK but no skill', () => {
    for (const deg of [0, 180, -180, 30, -30, 150, -150, 40, -40]) {
      for (const outMs of [60, 400]) {
        const rs = createRightStick();
        const out = drive(rs, [[0, deg, 0], [20, deg, 1], [20 + outMs, deg, 1], [40 + outMs, deg, 0]], { noiseDeg: 4, seed: deg + outMs });
        expect(skills(out), `deg ${deg} out ${outMs}`).toEqual([]);
        expect(flicks(out)).toHaveLength(1);
      }
    }
  });

  it('a diagonal flick whose crossing and settle angles straddle the 45-degree boundary is no step-over', () => {
    // Crosses the threshold at ~38 deg (forward) and settles at ~65 deg (right sector): a 27 deg drift, not a roll.
    const out = drive(createRightStick(), [[0, 30, 0], [20, 38, 0.75], [60, 65, 1], [120, 65, 1], [140, 65, 0]]);
    expect(skills(out)).not.toContain(SkillMove.STEP_OVER);
  });

  it('sweeps around the rim (aiming a reticle / curl) produce no skill', () => {
    // From forward or back: sweeps slower than a roll (forward -> side takes longer than rsSequenceMs). From a side:
    // a sweep is no hold (it leaves sideMaxDriftDeg before rsHoldMs).
    for (const [start, ms] of [[0, 2400], [0, 3000], [180, 3000], [-180, 1500], [90, 1200], [-90, 1200], [90, 900], [-90, 1800]] as [number, number][]) {
      for (const dir of [1, -1]) {
        const out = drive(createRightStick(), [[0, start, 0], [40, start, 1], [40 + ms, start + dir * 360, 1], [80 + ms, start + dir * 360, 0]]);
        expect(skills(out), `start ${start} ${ms} ms dir ${dir}`).toEqual([]);
        expect(flicks(out)).toHaveLength(1);
      }
    }
  });

  it('a side flick that sweeps instead of going out and back is no body feint', () => {
    const out = drive(createRightStick(), [[0, 70, 0], [20, 70, 1], [120, 130, 1], [140, 130, 0]]);
    expect(skills(out)).toEqual([]);
  });

  it('a stick resting near the flick threshold with noise gives one flick, no repeats (magnitude hysteresis)', () => {
    const out = drive(createRightStick(), [[0, 0, 0], [30, 0, T_INPUT.flickThreshold], [2000, 0, T_INPUT.flickThreshold], [2030, 0, 0]], { noiseMag: 0.05, seed: 3 });
    expect(flicks(out).length).toBeLessThanOrEqual(1);
    expect(skills(out)).toEqual([]);
  });

  it('jitter across a sector boundary never flip-flops into a roll (angular hysteresis)', () => {
    // Held 30 deg right of forward with +-12 deg jitter: always forward, no step-over, no ball roll.
    const a = drive(createRightStick(), [[0, 30, 0], [30, 30, 1], [1500, 30, 1], [1530, 30, 0]], { noiseDeg: 12, seed: 9 });
    expect(skills(a)).toEqual([]);
    // Held 120 deg (side sector near the back boundary) with jitter: exactly one ball roll, no extra skills.
    const b = drive(createRightStick(), [[0, 120, 0], [30, 120, 1], [1500, 120, 1], [1530, 120, 0]], { noiseDeg: 12, seed: 9 });
    expect(skills(b)).toEqual([SkillMove.BALL_ROLL]);
  });

  it('the sector function keeps its sector inside the hysteresis band and picks the nearest outside it', () => {
    const h = RIGHT_STICK_TUNING.sectorHysteresisDeg;
    expect(sectorOf(0, RsSector.NONE)).toBe(RsSector.FORWARD);
    expect(sectorOf(50 * DEG, RsSector.NONE)).toBe(RsSector.RIGHT);
    expect(sectorOf(-50 * DEG, RsSector.NONE)).toBe(RsSector.LEFT);
    expect(sectorOf(179 * DEG, RsSector.NONE)).toBe(RsSector.BACK);
    expect(sectorOf(-179 * DEG, RsSector.NONE)).toBe(RsSector.BACK);
    expect(sectorOf((45 + h - 1) * DEG, RsSector.FORWARD)).toBe(RsSector.FORWARD);
    expect(sectorOf((45 + h + 1) * DEG, RsSector.FORWARD)).toBe(RsSector.RIGHT);
    expect(sectorOf((135 + h - 1) * DEG * -1, RsSector.LEFT)).toBe(RsSector.LEFT);
    expect(sectorOf(-(135 + h + 1) * DEG, RsSector.BACK)).toBe(RsSector.BACK);
    expect(sectorOf(-(135 - h - 1) * DEG, RsSector.BACK)).toBe(RsSector.LEFT);
    // Facing +x: +z is right; facing -x: +z is left.
    expect(relativeAngle(0, 1, 1, 0)).toBeCloseTo(Math.PI / 2, 12);
    expect(relativeAngle(0, 1, -1, 0)).toBeCloseTo(-Math.PI / 2, 12);
  });
});

describe('PAD-05 RS_FLICK / RS_HOLD bits and the flick direction', () => {
  it('RS_FLICK is one edge per stroke with the flick direction in ax/az; RS_HOLD while held past rsHoldMs', () => {
    const rs = createRightStick();
    const out = drive(rs, [[0, 0, 0], [30, 0, 1], [600, 0, 1], [630, 0, 0]], { facing: [0, 1] });
    const fl = flicks(out);
    expect(fl).toHaveLength(1);
    expectDir(fl[0]!, [0, 1]);
    const holds = out.filter((x) => (x.buttons & Btn.RS_HOLD) !== 0);
    expect(holds.length).toBeGreaterThan(20);
    expect(holds[0]!.t).toBeGreaterThanOrEqual(21 + T_PAD.rsHoldMs - TICK_MS);
    expect(out[out.length - 1]!.t).toBeLessThan(640);
  });

  it('a flick out and back between two ticks still reports RS_FLICK with its direction (stick already centred)', () => {
    const rs = createRightStick();
    rs.setFacing(1, 0);
    rs.update(0, 0, 0);
    rs.update(0, 0.9, 4); // screen down = pitch +z
    rs.update(0, 0, 12);
    const f = createInputFrame();
    rs.applyTo(f);
    expect(f.buttons & Btn.RS_FLICK).toBe(Btn.RS_FLICK);
    expect([f.ax, f.az]).toEqual([0, AXIS_SCALE]);
    expect(f.skill).toBe(SkillMove.NONE); // the body feint waits one sample
    const g = createInputFrame();
    rs.applyTo(g);
    expect(g.buttons & Btn.RS_FLICK).toBe(0);
    expect(g.skill).toBe(SkillMove.BODY_FEINT);
    expect([g.ax, g.az]).toEqual([0, AXIS_SCALE]);
  });

  it('two flicks before consecutive samples are reported as two edges with a gap sample between them', () => {
    const rs = createRightStick();
    rs.update(0.9, 0, 0);
    rs.update(0, 0, 5);
    let f = createInputFrame();
    rs.applyTo(f);
    expect(f.buttons & Btn.RS_FLICK).toBe(Btn.RS_FLICK);
    rs.update(-0.9, 0, 20);
    rs.update(0, 0, 25);
    f = createInputFrame();
    rs.applyTo(f);
    expect(f.buttons & Btn.RS_FLICK).toBe(0);
    f = createInputFrame();
    rs.applyTo(f);
    expect(f.buttons & Btn.RS_FLICK).toBe(Btn.RS_FLICK);
    expect(f.ax).toBe(-AXIS_SCALE);
  });

  it('a latched flick or skill is dropped when not sampled within latchMaxMs (sampling stopped)', () => {
    const rs = createRightStick();
    rs.update(0, 0.9, 0);
    rs.update(0, 0, 50);
    rs.update(0, 0, 50 + RIGHT_STICK_TUNING.latchMaxMs + 20);
    expect(rs.consume()).toBe(0);
    expect(rs.consumeSkill()).toBe(SkillMove.NONE);
  });

  it('consume() keeps the Wave 0 contract: flick once, hold while held, nothing after release', () => {
    const rs = createRightStick();
    rs.update(0.9, 0, 0);
    expect(rs.consume() & Btn.RS_FLICK).toBe(Btn.RS_FLICK);
    expect(rs.consume() & Btn.RS_FLICK).toBe(0);
    rs.update(0.9, 0, 400);
    expect(rs.consume() & Btn.RS_HOLD).toBe(Btn.RS_HOLD);
    rs.update(0, 0, 420);
    expect(rs.consume()).toBe(0);
  });

  it('applyTo leaves ax/az alone on samples without a flick or skill and never overwrites a skill already set', () => {
    const rs = createRightStick();
    const f = createInputFrame();
    f.ax = 50; f.az = -20;
    rs.update(0.5, 0, 0);
    rs.applyTo(f);
    expect([f.ax, f.az, f.buttons]).toEqual([50, -20, 0]);
    rs.update(0, 0.9, 10);
    rs.update(0, 0, 20);
    rs.applyTo(createInputFrame());
    const g = createInputFrame();
    g.skill = SkillMove.KNOCK_ON;
    rs.applyTo(g);
    expect(g.skill).toBe(SkillMove.KNOCK_ON);
  });

  it('non-finite stick values and clocks running backwards are harmless', () => {
    const rs = createRightStick();
    rs.update(Number.NaN, Number.POSITIVE_INFINITY, 100);
    rs.update(0.9, Number.NaN, Number.NaN);
    rs.update(0.9, 0, 50); // earlier than 100: clamped
    rs.setFacing(Number.NaN, 0);
    rs.setStickRotation(Number.NaN);
    const f = createInputFrame();
    rs.applyTo(f);
    expect(Number.isFinite(f.ax) && Number.isFinite(f.az)).toBe(true);
    expect(f.buttons & Btn.RS_FLICK).toBe(Btn.RS_FLICK);
  });
});

describe('PAD-05 reset (releaseAll) and the knock-on gate', () => {
  it('glitch "Input: stuck stick" — after reset a held right stick gives no stale flick, hold or skill until released', () => {
    const rs = createRightStick();
    rs.update(0, 0.9, 0);
    rs.update(0, 0.9, 100);
    rs.reset();
    const f = createInputFrame();
    for (let t = 110; t < 800; t += 10) {
      rs.update(0, 0.9, t);
      f.buttons = 0;
      rs.applyTo(f);
      expect(f.buttons).toBe(0);
      expect(f.skill).toBe(SkillMove.NONE);
    }
    rs.update(0, 0, 810);
    rs.update(0, 0.9, 820);
    f.buttons = 0;
    rs.applyTo(f);
    expect(f.buttons & Btn.RS_FLICK).toBe(Btn.RS_FLICK);
  });

  it('reset drops a latched flick, a latched skill and a pending heel flick', () => {
    const rs = createRightStick();
    rs.update(0.9, 0, 0); // forward flick (pending heel)
    rs.update(0, 0, 40);
    rs.update(0, 0.9, 60);
    rs.update(0, 0, 100); // body feint latched
    rs.reset();
    expect(rs.consume()).toBe(0);
    expect(rs.consumeSkill()).toBe(SkillMove.NONE);
    rs.update(0, 0, 110);
    rs.update(-0.9, 0, 130); // back flick right after: no heel flick, the pending one was dropped
    rs.update(0, 0, 160);
    rs.consume();
    expect(rs.consumeSkill()).toBe(SkillMove.NONE);
  });

  it('R2 (SPRINT) + flick is a knock-on: RS_FLICK with the direction, no right-stick skill', () => {
    for (const c of CASES) {
      const out = drive(createRightStick(), c.keys, { buttons: Btn.SPRINT });
      expect(skills(out), c.name).toEqual([]);
      expect(flicks(out).length).toBeGreaterThanOrEqual(1);
    }
    const out = drive(createRightStick(), P.feintRight, { buttons: Btn.SPRINT, facing: [-1, 0] });
    expectDir(flicks(out)[0]!, [0, -1]);
  });
});

describe('PAD-05 drag-back (L1 + R1 + left stick flicked back)', () => {
  const back: Key[] = [[0, 180, 0], [30, 180, 1], [120, 180, 1], [150, 180, 0]];
  const both = Btn.MOD_L | Btn.MOD_R;

  for (const [fname, facing] of FACINGS) {
    it(`drag-back toward the player's back (facing ${fname})`, () => {
      const out = drive(createRightStick(), [], { facing, left: back, buttons: both });
      const s = out.filter((x) => x.skill !== SkillMove.NONE);
      expect(s.map((x) => x.skill)).toEqual([SkillMove.DRAG_BACK]);
      expectDir(s[0]!, relDir(facing, 180));
    });
  }

  it('back-diagonal flicks within dragBackHalfDeg count, wider ones do not', () => {
    const h = RIGHT_STICK_TUNING.dragBackHalfDeg;
    const k = (deg: number): Key[] => [[0, deg, 0], [30, deg, 1], [120, deg, 1], [150, deg, 0]];
    expect(skills(drive(createRightStick(), [], { left: k(180 - h + 5), buttons: both }))).toEqual([SkillMove.DRAG_BACK]);
    expect(skills(drive(createRightStick(), [], { left: k(-(180 - h + 5)), buttons: both }))).toEqual([SkillMove.DRAG_BACK]);
    expect(skills(drive(createRightStick(), [], { left: k(180 - h - 10), buttons: both }))).toEqual([]);
  });

  it('needs both L1 and R1; forward / side left-stick flicks with both held do nothing', () => {
    expect(skills(drive(createRightStick(), [], { left: back, buttons: Btn.MOD_L }))).toEqual([]);
    expect(skills(drive(createRightStick(), [], { left: back, buttons: Btn.MOD_R }))).toEqual([]);
    expect(skills(drive(createRightStick(), [], { left: back }))).toEqual([]);
    for (const deg of [0, 90, -90, 45]) {
      expect(skills(drive(createRightStick(), [], { left: [[0, deg, 0], [30, deg, 1], [120, deg, 1], [150, deg, 0]], buttons: both }))).toEqual([]);
    }
  });

  it('a left stick already held back when L1 + R1 go down is not a flick', () => {
    const rs = createRightStick();
    rs.setFacing(1, 0);
    let t = 0;
    for (; t < 100; t += 8) { rs.setLeft(-0.9, 0, 0); rs.update(0, 0, t); }
    for (; t < 300; t += 8) { rs.setLeft(-0.9, 0, both); rs.update(0, 0, t); }
    rs.consume();
    expect(rs.consumeSkill()).toBe(SkillMove.NONE);
    rs.setLeft(0, 0, both); rs.update(0, 0, t + 8);
    rs.setLeft(-0.9, 0, both); rs.update(0, 0, t + 16);
    expect(rs.consumeSkill()).toBe(SkillMove.DRAG_BACK);
  });

  it('running forward then snapping the left stick straight back (no centred sample) is a drag-back', () => {
    const rs = createRightStick();
    rs.setFacing(1, 0);
    rs.setLeft(0.95, 0, both); rs.update(0, 0, 0);
    rs.setLeft(0.95, 0, both); rs.update(0, 0, 16);
    rs.setLeft(-0.95, 0.05, both); rs.update(0, 0, 33);
    expect(rs.consumeSkill()).toBe(SkillMove.DRAG_BACK);
    expect(rs.skillDirX).toBeCloseTo(-1, 9);
  });

  it('a slow rotation of the left stick round to the back is not a flick', () => {
    const out = drive(createRightStick(), [], { left: [[0, 0, 0], [30, 0, 1], [1500, 180, 1], [1530, 180, 0]], buttons: both });
    expect(skills(out)).toEqual([]);
  });
});

// ------------------------------------------------------------------ context gate (setContext)

function ctxFor(s: SimState, opts: { human?: number; side?: number; rot?: number } = {}): InputSampleContext {
  const projector: CameraProjector | null = opts.rot === undefined ? null : {
    screenToPitch: () => false, pitchToScreen: () => false, stickRotation: () => opts.rot!,
  };
  return { tick: s.tick, human: opts.human ?? 0, side: opts.side ?? 0, state: s, projector };
}

/** A bare state: P1 on side 0 controls slot 9 who has the ball, IN_PLAY. */
function attackState(): SimState {
  const s = createSimState(createMatchConfig(), [[], []]);
  s.match.phase = MatchPhase.IN_PLAY;
  for (let i = 0; i < 22; i++) { s.players[i]!.team = i < 11 ? 0 : 1; s.players[i]!.active = 1; }
  s.teams[0]!.dir = 1; s.teams[1]!.dir = -1;
  s.ctrl[0]!.side = 0; s.ctrl[0]!.slot = 9;
  s.players[9]!.ctrl = 0;
  s.ball.owner = 9; s.ball.heldBy = -1;
  return s;
}

/** Drive one pattern with setContext(ctx) before every 60 Hz sample (the mapper's call order). */
function driveCtx(s: SimState, keys: Key[], ctx: InputSampleContext, buttons = 0, left?: Key[]): Sample[] {
  const rs = createRightStick();
  const out: Sample[] = [];
  const f = createInputFrame();
  const rot = ctx.projector ? ctx.projector.stickRotation() : 0;
  const p = s.ctrl[ctx.human]!.slot >= 0 ? s.players[s.ctrl[ctx.human]!.slot]! : null;
  const facing: [number, number] = p ? [p.fx, p.fz] : [s.teams[ctx.side]!.dir, 0];
  rs.setContext(ctx);
  const end = Math.max(keys.length ? keys[keys.length - 1]![0] : 0, left?.length ? left[left.length - 1]![0] : 0) + 200;
  let next = TICK_MS;
  for (let t = 0; t <= end; t += 1000 / 120) {
    const [deg, mag] = lerpKeys(keys, t);
    const [sx, sy] = toScreen(deg, mag, facing, rot);
    let lx = 0, ly = 0;
    if (left) { const [ld, lm] = lerpKeys(left, t); [lx, ly] = toScreen(ld, lm, facing, rot); }
    rs.updatePad({ rx: sx, ry: sy, lx, ly }, buttons, 1000 + t);
    while (t + 1e-9 >= next) {
      next += TICK_MS;
      f.buttons = 0; f.skill = SkillMove.NONE; f.ax = 0; f.az = 0;
      rs.setContext(ctx);
      rs.applyTo(f);
      if (f.buttons !== 0 || f.skill !== SkillMove.NONE) out.push({ t, buttons: f.buttons, skill: f.skill, ax: f.ax, az: f.az });
    }
  }
  return out;
}

describe('PAD-05 context from the sim state (setContext)', () => {
  it('reads the controlled player facing from ctrl[human].slot (step-over judged against facing -z)', () => {
    const s = attackState();
    s.players[9]!.fx = 0; s.players[9]!.fz = -1;
    const out = driveCtx(s, P.stepOverRight, ctxFor(s));
    const sk = out.filter((x) => x.skill !== SkillMove.NONE);
    expect(sk.map((x) => x.skill)).toEqual([SkillMove.STEP_OVER]);
    expectDir(sk[0]!, [1, 0]); // facing -z: the player's right is +x
  });

  it('uses the camera stick rotation from ctx.projector', () => {
    const s = attackState();
    s.players[9]!.fx = -1; s.players[9]!.fz = 0;
    const out = driveCtx(s, P.rouletteLeft, ctxFor(s, { rot: 1.1 }));
    const sk = out.filter((x) => x.skill !== SkillMove.NONE);
    expect(sk.map((x) => x.skill)).toEqual([SkillMove.ROULETTE]);
    expectDir(sk[0]!, [0, 1]); // facing -x: left is +z
  });

  it('defence (opponent owns the ball): no skills, RS_FLICK with direction for the directional switch', () => {
    const s = attackState();
    s.ball.owner = 15;
    for (const c of CASES) {
      const out = driveCtx(s, c.keys, ctxFor(s));
      expect(skills(out), c.name).toEqual([]);
      expect(flicks(out).length).toBeGreaterThanOrEqual(1);
    }
    const out = driveCtx(s, P.feintLeft, ctxFor(s));
    expectDir(flicks(out)[0]!, [0, -1]);
    // Drag-back is gated too.
    expect(skills(driveCtx(s, [], ctxFor(s), Btn.MOD_L | Btn.MOD_R, [[0, 180, 0], [30, 180, 1], [100, 180, 1], [130, 180, 0]]))).toEqual([]);
  });

  it('set pieces and other phases (free-kick curl, corner reticle, penalty dive): no skills', () => {
    for (const phase of [MatchPhase.FREE_KICK, MatchPhase.CORNER, MatchPhase.PENALTY, MatchPhase.SHOOT_OUT, MatchPhase.KICK_OFF, MatchPhase.GOAL]) {
      const s = attackState();
      s.match.phase = phase;
      for (const c of CASES) expect(skills(driveCtx(s, c.keys, ctxFor(s))), `${phase} ${c.name}`).toEqual([]);
    }
  });

  it('loose ball and our keeper holding it: skills allowed when loose, not for the keeper in hands', () => {
    const s = attackState();
    s.ball.owner = -1;
    expect(skills(driveCtx(s, P.feintRight, ctxFor(s)))).toEqual([SkillMove.BODY_FEINT]);
    s.ball.heldBy = 9;
    expect(skills(driveCtx(s, P.feintRight, ctxFor(s)))).toEqual([]);
    s.ball.heldBy = 0; // our own keeper (another player) holds it: still our ball
    expect(skills(driveCtx(s, P.feintRight, ctxFor(s)))).toEqual([SkillMove.BODY_FEINT]);
  });

  it('drag-back through setContext/updatePad when attacking', () => {
    const s = attackState();
    s.players[9]!.fx = -1; s.players[9]!.fz = 0;
    const out = driveCtx(s, [], ctxFor(s), Btn.MOD_L | Btn.MOD_R, [[0, 180, 0], [30, 180, 1], [100, 180, 1], [130, 180, 0]]);
    const sk = out.filter((x) => x.skill !== SkillMove.NONE);
    expect(sk.map((x) => x.skill)).toEqual([SkillMove.DRAG_BACK]);
    expectDir(sk[0]!, [1, 0]);
  });

  it('no controlled player: facing falls back to the team direction and skills are off', () => {
    const s = attackState();
    s.ctrl[1]!.side = 1; s.ctrl[1]!.slot = -1;
    const ctx = ctxFor(s, { human: 1, side: 1 });
    const out = driveCtx(s, P.feintRight, ctx);
    expect(skills(out)).toEqual([]);
    expect(flicks(out)).toHaveLength(1);
    // Facing -x (away team): "right" of the fallback facing is -z.
    expectDir(flicks(out)[0]!, [0, -1]);
  });

  it('a sample frame stays in range: |ax, az| <= 127 radial on every reported sample', () => {
    const s = attackState();
    s.players[9]!.fx = 0.6; s.players[9]!.fz = 0.8;
    for (const c of CASES) {
      for (const x of driveCtx(s, c.keys, ctxFor(s, { rot: 0.3 }))) {
        expect(x.ax * x.ax + x.az * x.az).toBeLessThanOrEqual(AXIS_SCALE * AXIS_SCALE);
        expect(Number.isInteger(x.ax) && Number.isInteger(x.az)).toBe(true);
      }
    }
  });
});

describe('PAD-05 mock Gamepad objects through the real pad manager', () => {
  it('step-over from a mocked standard pad (axes 2/3) polled per frame', async () => {
    const { createPadManager } = await import('../../src/input/pad/manager');
    const { mapPadButtons } = await import('../../src/input/pad/mapper');
    const axes = [0, 0, 0, 0];
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = { id: 'Mock (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', axes, buttons, timestamp: 0, vibrationActuator: null } as unknown as Gamepad;
    const mgr = createPadManager(() => [pad]);
    const rs = createRightStick();
    rs.setFacing(1, 0);
    const got: InputFrame[] = [];
    let next = TICK_MS;
    for (let t = 0; t <= 450; t += 1000 / 120) {
      const [deg, mag] = lerpKeys(P.stepOverRight, t);
      const [sx, sy] = toScreen(deg, mag, [1, 0], 0);
      axes[2] = sx; axes[3] = sy;
      mgr.poll(t + 1);
      const slot = mgr.find('pad:1')!;
      rs.updatePad(slot, mapPadButtons(slot), t + 1);
      while (t + 1e-9 >= next) {
        next += TICK_MS;
        const f = createInputFrame();
        rs.applyTo(f);
        got.push(f);
      }
    }
    expect(got.filter((f) => f.skill !== SkillMove.NONE).map((f) => f.skill)).toEqual([SkillMove.STEP_OVER]);
    expect(got.filter((f) => (f.buttons & Btn.RS_FLICK) !== 0)).toHaveLength(1);
  });
});
