/**
 * GKP-01: keeper positioning geometry (keeperSpotForBall / idealKeeperSpot) and the keeperPositioning intent and
 * gates. Pipeline movement tests live in tests/scenario/gkp-01-keeper-movement.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, GOAL_HALF_WIDTH, HALF_LENGTH, WORLD_MAX_X, WORLD_MAX_Z, WORLD_MIN_X, WORLD_MIN_Z,
} from '../../src/contracts/constants';
import { ActionKind, ControllerKind } from '../../src/contracts/enums';
import { createMatchConfig, MoveMode, type SimState } from '../../src/contracts/state';
import { T_GK, T_PLAYER } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import {
  idealKeeperSpot, keeperPositioning, keeperPositioningAccuracy, keeperSpotForBall, type KeeperSpot,
} from '../../src/sim/keeper/positioning';

const MIN_LINE = 0.3;
const NEAR_POST_INSET = 0.45;
const EPS = 1e-9;

/** Metres into the field from the goal line defended by a team attacking `dir`. */
const uOf = (dir: number, x: number): number => dir * x + HALF_LENGTH;
/** Pitch x of a point u metres in front of the goal defended by a team attacking `dir`. */
const xOf = (dir: number, u: number): number => dir * (u - HALF_LENGTH);

function spotFor(dir: number, bu: number, bz: number, acc = 1): KeeperSpot & { u: number } {
  const o = { x: 0, z: 0 };
  keeperSpotForBall(dir, xOf(dir, bu), bz, acc, o);
  return { x: o.x, z: o.z, u: uOf(dir, o.x) };
}

/** Bot v bot match state, IN_PLAY-agnostic (keeperPositioning does not check the phase). */
function setup(): SimState {
  const cfg = createMatchConfig();
  cfg.humans = [
    { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 },
    { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 },
  ];
  const s = initMatch(cfg);
  s.ball.x = -30; s.ball.z = 6; s.ball.vx = 0; s.ball.vz = 0;
  return s;
}

/** Angle between vectors (ax, az) and (bx, bz), radians. */
function angleBetween(ax: number, az: number, bx: number, bz: number): number {
  const c = (ax * bx + az * bz) / (Math.sqrt(ax * ax + az * az) * Math.sqrt(bx * bx + bz * bz));
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

describe('GKP-01 spot geometry: central balls', () => {
  it('central far ball: on the goal-centre line at T_GK.depthFar', () => {
    for (const dir of [1, -1]) {
      for (const bu of [28, 40, HALF_LENGTH, 80, 100]) {
        const sp = spotFor(dir, bu, 0);
        expect(Math.abs(sp.z)).toBeLessThan(EPS);
        expect(sp.u).toBeCloseTo(T_GK.depthFar, 9);
      }
    }
  });

  it('central close ball: depth comes down to T_GK.depthNear', () => {
    for (const dir of [1, -1]) {
      expect(spotFor(dir, 5, 0).u).toBeCloseTo(T_GK.depthNear, 9);
      expect(spotFor(dir, 3, 0).u).toBeLessThanOrEqual(T_GK.depthNear + EPS);
    }
  });

  it('depth grows monotonically with ball distance (depthNear close -> depthFar far)', () => {
    let prev = -1;
    for (let bu = 1; bu <= 60; bu += 0.25) {
      const sp = spotFor(1, bu, 0);
      expect(sp.u).toBeGreaterThanOrEqual(prev - EPS);
      expect(sp.u).toBeGreaterThanOrEqual(MIN_LINE - EPS);
      expect(sp.u).toBeLessThanOrEqual(T_GK.depthFar + EPS);
      prev = sp.u;
    }
    expect(spotFor(1, 11, 0).u).toBeGreaterThan(spotFor(1, 6, 0).u + 0.3);
    expect(spotFor(1, 25, 0).u).toBeGreaterThan(spotFor(1, 11, 0).u + 1);
  });

  it('never stands past the ball: keeps a gap along the line for a ball close in', () => {
    for (const bu of [1.2, 1.6, 2, 2.4]) {
      const sp = spotFor(1, bu, 0);
      expect(sp.u).toBeLessThanOrEqual(Math.max(MIN_LINE, bu - 1) + EPS);
    }
  });
});

describe('GKP-01 spot geometry: angles', () => {
  it('reacts to the shooting angle: stands on the bisector of the ball-to-posts angle', () => {
    for (const dir of [1, -1]) {
      for (const [bu, bz] of [[16.5, 10], [11, 5], [25, -15], [20, 18], [30, 25], [8, -6], [12, 0.5], [40, 30]] as const) {
        const sp = spotFor(dir, bu, bz);
        const ku = sp.u - bu, kz = sp.z - bz;
        const aLeft = angleBetween(ku, kz, -bu, -GOAL_HALF_WIDTH - bz);
        const aRight = angleBetween(ku, kz, -bu, GOAL_HALF_WIDTH - bz);
        expect(Math.abs(aLeft - aRight)).toBeLessThan(1e-6);
        // ... between the posts' rays, i.e. in front of the goal mouth.
        expect(Math.abs(sp.z)).toBeLessThan(GOAL_HALF_WIDTH + sp.u);
      }
    }
  });

  it('wide ball: shifts toward the ball side, more the wider the ball', () => {
    for (const side of [1, -1]) {
      let prev = 0;
      // Strictly following the ball until the tight-angle zone (bearing from the near post > 55 deg at w ~ 19 m)...
      for (let w = 0; w <= 19; w += 0.25) {
        const lateral = side * spotFor(1, 11, side * w).z;
        expect(lateral).toBeGreaterThanOrEqual(prev - EPS);
        prev = lateral;
      }
      // [QF-14] T_GK.depthFar 4.5 -> 3: a keeper nearer his line needs less lateral shift to cover (was > 3).
      expect(prev).toBeGreaterThan(2.5);
      // ... then holding the near-post side.
      for (let w = 19; w <= 34; w += 0.25) expect(side * spotFor(1, 11, side * w).z).toBeGreaterThan(2.5);
    }
  });

  it('tight angle: covers the near post just off the line (both sides, both ends)', () => {
    for (const dir of [1, -1]) {
      for (const side of [1, -1]) {
        for (const bu of [0.5, 1, 2, 3]) {
          for (const w of [12, 16, 20, 25, 34]) {
            const sp = spotFor(dir, bu, side * w);
            const nearPost = side * GOAL_HALF_WIDTH;
            // Inside the post and within a short step of it (body radius + reach), never wide of it.
            expect(side * sp.z).toBeLessThan(GOAL_HALF_WIDTH);
            expect(Math.abs(nearPost - sp.z)).toBeLessThanOrEqual(0.75);
            expect(sp.u).toBeGreaterThanOrEqual(MIN_LINE - EPS);
            expect(sp.u).toBeLessThanOrEqual(T_GK.depthFar * 0.5);
          }
        }
      }
    }
  });

  it('depth shrinks at tight angles compared with a central ball at the same distance', () => {
    for (const dist of [12, 18, 25]) {
      const central = spotFor(1, dist, 0);
      const tight = spotFor(1, 1, Math.sqrt(dist * dist - 1));
      expect(tight.u).toBeLessThan(central.u - 0.4);
    }
  });

  it('near-post shift grows as the angle tightens along the byline and settles at the near post', () => {
    for (const bu of [0.5, 2, 3]) {
      const zAt = (w: number): number => spotFor(1, bu, w).z;
      expect(zAt(4)).toBeLessThan(zAt(15));
      for (let w = 4; w <= 34; w += 0.25) expect(zAt(w)).toBeLessThan(GOAL_HALF_WIDTH);
      for (let w = 20; w <= 34; w += 0.25) expect(zAt(w)).toBeCloseTo(GOAL_HALF_WIDTH - NEAR_POST_INSET, 2);
    }
  });

  it('ball inside the goal mouth close in: the keeper is level with the ball, not shifted to a post', () => {
    for (const bz of [-2, -1, 0, 1, 2]) {
      const sp = spotFor(1, 0.5, bz);
      expect(Math.abs(sp.z - bz)).toBeLessThan(0.1);
      expect(sp.u).toBeCloseTo(MIN_LINE, 9);
    }
  });
});

describe('GKP-01 spot geometry: bounds, symmetry, continuity', () => {
  it('glitch: Keeper carries it over his own line — the spot is never behind (or within 0.3 m of) the goal line', () => {
    const o = { x: 0, z: 0 };
    let n = 0;
    for (const dir of [1, -1]) {
      for (const acc of [0, 0.5, 1]) {
        for (let x = WORLD_MIN_X; x <= WORLD_MAX_X; x += 0.5) {
          for (let z = WORLD_MIN_Z; z <= WORLD_MAX_Z; z += 0.5) {
            keeperSpotForBall(dir, x, z, acc, o);
            const u = uOf(dir, o.x);
            if (!(Number.isFinite(o.x) && Number.isFinite(o.z) && u >= MIN_LINE - EPS && u <= GOAL_AREA_DEPTH + EPS
              && Math.abs(o.z) <= GOAL_AREA_HALF_WIDTH + EPS)) {
              throw new Error(`bad spot (${o.x}, ${o.z}) for ball (${x}, ${z}) dir ${dir} acc ${acc}`);
            }
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(100000);
  });

  it('ball behind the goal line or in the net still gives a spot in front of the line', () => {
    for (const dir of [1, -1]) {
      for (const [bu, bz] of [[-0.5, 0], [-1.8, 2], [-5, 10], [-9, -30], [0, 0], [0, 3.66]] as const) {
        const sp = spotFor(dir, bu, bz);
        expect(sp.u).toBeGreaterThanOrEqual(MIN_LINE - EPS);
        expect(Math.abs(sp.z)).toBeLessThan(GOAL_HALF_WIDTH);
      }
    }
  });

  it('non-finite ball input falls back to a safe spot on the goal centre', () => {
    const o = { x: 0, z: 0 };
    keeperSpotForBall(1, Number.NaN, Number.NaN, 1, o);
    expect(Number.isFinite(o.x) && Number.isFinite(o.z)).toBe(true);
    expect(uOf(1, o.x)).toBeGreaterThanOrEqual(MIN_LINE - EPS);
    keeperSpotForBall(-1, 10, Number.POSITIVE_INFINITY, Number.NaN, o);
    expect(Number.isFinite(o.x) && Number.isFinite(o.z)).toBe(true);
    expect(uOf(-1, o.x)).toBeGreaterThanOrEqual(MIN_LINE - EPS);
  });

  it('is mirror-symmetric across z and between the two ends', () => {
    const a = { x: 0, z: 0 }, b = { x: 0, z: 0 }, c = { x: 0, z: 0 };
    for (let x = -60; x <= 60; x += 3.7) {
      for (let z = -40; z <= 40; z += 2.9) {
        for (const acc of [0, 0.4, 1]) {
          keeperSpotForBall(1, x, z, acc, a);
          keeperSpotForBall(1, x, -z, acc, b);
          keeperSpotForBall(-1, -x, z, acc, c);
          expect(b.x).toBeCloseTo(a.x, 9);
          expect(b.z).toBeCloseTo(-a.z, 9);
          expect(c.x).toBeCloseTo(-a.x, 9);
          expect(c.z).toBeCloseTo(a.z, 9);
        }
      }
    }
  });

  it('moves continuously with the ball (no jumps that would make him jitter)', () => {
    const o = { x: 0, z: 0 };
    const paths: [number, number, number, number][] = [
      [0.1, -34, 0.1, 34], [12, -34, 12, 34], [25, -30, 25, 30], [0.5, 1, 40, 1], [0.6, -8, 0.6, 8], [2, 20, 30, -20],
    ];
    for (const dir of [1, -1]) {
      for (const acc of [0, 1]) {
        for (const [u0, z0, u1, z1] of paths) {
          const n = 6000;
          const len = Math.hypot(u1 - u0, z1 - z0);
          keeperSpotForBall(dir, xOf(dir, u0), z0, acc, o);
          let px = o.x, pz = o.z;
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            keeperSpotForBall(dir, xOf(dir, u0 + (u1 - u0) * t), z0 + (z1 - z0) * t, acc, o);
            const jump = Math.hypot(o.x - px, o.z - pz);
            // Bounded gradient: the spot moves at most ~2.5 m per metre of ball movement.
            expect(jump).toBeLessThanOrEqual((len / n) * 2.5 + 1e-9);
            px = o.x; pz = o.z;
          }
        }
      }
    }
  });
});

describe('GKP-01 positioning attribute', () => {
  it('accuracy maps gkPositioning 1..99 to 0..1 (clamped)', () => {
    expect(keeperPositioningAccuracy(1)).toBe(0);
    expect(keeperPositioningAccuracy(99)).toBe(1);
    expect(keeperPositioningAccuracy(50)).toBeCloseTo(0.5, 9);
    expect(keeperPositioningAccuracy(-20)).toBe(0);
    expect(keeperPositioningAccuracy(140)).toBe(1);
  });

  it('a poor keeper gets a small, deterministic offset', () => {
    for (const [bu, bz] of [[16.5, 12], [11, -8], [20, 18], [2, 20], [30, -25], [6, 3]] as const) {
      const good = spotFor(1, bu, bz, 1);
      const poor = spotFor(1, bu, bz, 0);
      const poor2 = spotFor(1, bu, bz, 0);
      expect(poor.x).toBe(poor2.x);
      expect(poor.z).toBe(poor2.z);
      const off = Math.hypot(poor.x - good.x, poor.z - good.z);
      expect(off).toBeGreaterThan(0.05);
      expect(off).toBeLessThan(1.5);
    }
  });

  it('a poor keeper under-shifts the angle: his line from the ball leans toward the far post', () => {
    // Angle between the ball-to-keeper ray and the ray to each post: equal for a perfect keeper (bisector);
    // a poor keeper leaves more room at the near post.
    for (const [bu, bz] of [[16.5, 9], [12, -6], [20, 15], [25, 22], [9, 4]] as const) {
      const side = Math.sign(bz);
      const gap = (acc: number): number => {
        const sp = spotFor(1, bu, bz, acc);
        const near = angleBetween(sp.u - bu, sp.z - bz, -bu, side * GOAL_HALF_WIDTH - bz);
        const far = angleBetween(sp.u - bu, sp.z - bz, -bu, -side * GOAL_HALF_WIDTH - bz);
        return near - far;
      };
      expect(Math.abs(gap(1))).toBeLessThan(1e-6);
      expect(gap(0)).toBeGreaterThan(0.003);
    }
    for (const [bu, bz] of [[2, 20], [0.5, -12], [1, 30]] as const) {
      expect(Math.abs(spotFor(1, bu, bz, 0).z)).toBeLessThan(Math.abs(spotFor(1, bu, bz, 1).z) - 0.5);
    }
  });

  it('a poor keeper stands too deep for a close ball and too high for a far one', () => {
    expect(spotFor(1, 7, 0, 0).u).toBeLessThan(spotFor(1, 7, 0, 1).u - 0.1);
    expect(spotFor(1, 50, 0, 0).u).toBeGreaterThan(spotFor(1, 50, 0, 1).u + 0.5);
  });
});

describe('GKP-01 idealKeeperSpot', () => {
  it('matches the geometry for the team keeper, both teams and both attack directions', () => {
    for (const swapped of [false, true]) {
      const s = setup();
      if (swapped) { s.teams[0]!.dir = -1; s.teams[1]!.dir = 1; }
      for (const team of [0, 1]) {
        const k = s.teams[team]!.keeperSlot;
        const dir = s.teams[team]!.dir;
        s.ball.x = xOf(dir, 18); s.ball.z = -9;
        const o = { x: 0, z: 0 }, ref = { x: 0, z: 0 };
        idealKeeperSpot(s, team, o);
        keeperSpotForBall(dir, s.ball.x, s.ball.z, keeperPositioningAccuracy(s.attrs[k]!.gkPositioning), ref);
        expect(o).toEqual(ref);
        expect(uOf(dir, o.x)).toBeGreaterThan(MIN_LINE);
        expect(Math.abs(o.x)).toBeGreaterThan(HALF_LENGTH - GOAL_AREA_DEPTH - EPS);
        expect(Math.sign(o.x)).toBe(-dir);
      }
    }
  });

  it('steps across ahead of a moving ball (good keeper) and reads it late (poor keeper)', () => {
    const s = setup();
    const k = s.teams[0]!.keeperSlot;
    s.ball.x = xOf(1, 18); s.ball.z = 0; s.ball.vz = 6;
    const still = { x: 0, z: 0 }, moving = { x: 0, z: 0 };
    for (const [pos, sign] of [[99, 1], [1, -1]] as const) {
      s.attrs[k]!.gkPositioning = pos;
      s.ball.vz = 0; idealKeeperSpot(s, 0, still);
      s.ball.vz = 6; idealKeeperSpot(s, 0, moving);
      // [QF-14] depthFar 4.5 -> 3: the anticipation shift scales with his depth (was > 0.1).
      expect(sign * (moving.z - still.z)).toBeGreaterThan(0.06);
    }
  });

  it("uses the carrier's velocity while the ball is owned", () => {
    const s = setup();
    const carrier = 15;
    s.ball.x = xOf(1, 20); s.ball.z = 4; s.ball.vx = 0; s.ball.vz = 0; s.ball.owner = carrier;
    s.players[carrier]!.vx = 0; s.players[carrier]!.vz = 0;
    const still = { x: 0, z: 0 }, moving = { x: 0, z: 0 };
    idealKeeperSpot(s, 0, still);
    s.players[carrier]!.vz = 6;
    idealKeeperSpot(s, 0, moving);
    expect(moving.z).not.toBe(still.z);
    // Same as an unowned ball rolling at the carrier's velocity.
    s.ball.owner = -1; s.ball.vz = 6;
    const loose = { x: 0, z: 0 };
    idealKeeperSpot(s, 0, loose);
    expect(loose).toEqual(moving);
  });

  it('caps the look-ahead for very fast balls', () => {
    const s = setup();
    const k = s.teams[0]!.keeperSlot;
    s.attrs[k]!.gkPositioning = 99;
    s.ball.x = xOf(1, 20); s.ball.z = 0; s.ball.vx = 0; s.ball.vz = 300;
    const o = { x: 0, z: 0 }, ref = { x: 0, z: 0 };
    idealKeeperSpot(s, 0, o);
    keeperSpotForBall(1, s.ball.x, 4, 1, ref);
    expect(o.x).toBeCloseTo(ref.x, 9);
    expect(o.z).toBeCloseTo(ref.z, 9);
  });
});

describe('GKP-01 keeperPositioning intent and gates', () => {
  const ev = createEventBuffer();

  it('sets ARRIVE at the ideal spot, facing the ball, shuffling (no sprint) when close', () => {
    for (const team of [0, 1]) {
      const s = setup();
      const k = s.teams[team]!.keeperSlot;
      const dir = s.teams[team]!.dir;
      const p = s.players[k]!;
      s.ball.x = xOf(dir, 16); s.ball.z = 7;
      const o = { x: 0, z: 0 };
      idealKeeperSpot(s, team, o);
      p.x = o.x + 0.5 * dir; p.z = o.z - 1;
      keeperPositioning(s, team, ev);
      expect(p.moveMode).toBe(MoveMode.ARRIVE);
      expect(p.tgtX).toBe(o.x);
      expect(p.tgtZ).toBe(o.z);
      expect(p.tgtSpeed).toBeGreaterThan(0);
      expect(p.tgtSpeed).toBeLessThanOrEqual(s.attrs[k]!.topSpeed * T_PLAYER.jogFraction + EPS);
      expect(p.wantSprint).toBe(0);
      expect(p.lookAt).toBe(1);
      expect(p.lookX).toBe(s.ball.x);
      expect(p.lookZ).toBe(s.ball.z);
    }
  });

  it('paces the move with hysteresis: shuffle, hurry facing the ball, turn and run only when far out', () => {
    const s = setup();
    const p = s.players[0]!;
    const top = s.attrs[0]!.topSpeed;
    s.ball.x = 0; s.ball.z = 0;
    const o = { x: 0, z: 0 };
    idealKeeperSpot(s, 0, o);
    const at = (d: number): [number, number, boolean] => {
      p.x = o.x + d; p.z = o.z;
      keeperPositioning(s, 0, ev);
      return [p.wantSprint, p.lookAt, p.tgtSpeed === top];
    };
    p.wantSprint = 0; p.lookAt = 1;
    expect(at(2)).toEqual([0, 1, false]); // calm shuffle
    expect(at(4)).toEqual([1, 1, true]); // hurry, still facing the ball
    expect(at(2)).toEqual([1, 1, true]); // hysteresis: keeps hurrying above hurryExit
    expect(at(1)).toEqual([0, 1, false]); // calm again
    expect(at(12)).toEqual([1, 0, true]); // far out of position: turn and run
    expect(at(8)).toEqual([1, 0, true]); // hysteresis: keeps running above runExit
    expect(at(5)).toEqual([1, 1, true]); // close enough: faces the ball again, still hurrying
    expect(at(8)).toEqual([1, 1, true]); // below runEnter: keeps facing the ball
    p.wantSprint = 0; p.lookAt = 0; // e.g. left over from an action: no run memory without wantSprint
    expect(at(8)).toEqual([1, 1, true]);
  });

  it('glitch: Keeper carries it over his own line — a keeper on or behind the line aims to stop in front of it', () => {
    for (const team of [0, 1]) {
      const s = setup();
      const k = s.teams[team]!.keeperSlot;
      const dir = s.teams[team]!.dir;
      const p = s.players[k]!;
      s.ball.x = xOf(dir, 0.5); s.ball.z = 0.3; // spot at the minimum distance from the line
      p.x = xOf(dir, -1); p.z = 0;
      keeperPositioning(s, team, ev);
      expect(uOf(dir, p.tgtX)).toBeCloseTo(MIN_LINE + T_PLAYER.arriveStop, 9);
      p.x = xOf(dir, 0.6); // in front of the safe line: plain spot
      keeperPositioning(s, team, ev);
      expect(uOf(dir, p.tgtX)).toBeCloseTo(MIN_LINE, 9);
    }
  });

  it('does nothing for a human-controlled keeper', () => {
    const s = setup();
    s.ctrl[0]!.kind = ControllerKind.HUMAN; s.ctrl[0]!.side = 0; s.ctrl[0]!.slot = 0; s.players[0]!.ctrl = 0;
    const p = s.players[0]!;
    p.moveMode = MoveMode.DIRECT; p.ix = 0.5; p.tgtX = 123; p.lookAt = 0;
    keeperPositioning(s, 0, ev);
    expect([p.moveMode, p.ix, p.tgtX, p.lookAt]).toEqual([MoveMode.DIRECT, 0.5, 123, 0]);
  });

  it('does nothing while the keeper is in an action, holds the ball, has it at his feet, or is inactive', () => {
    const cases: ((s: SimState) => void)[] = [
      (s) => { s.players[0]!.act = ActionKind.GK_DIVE; },
      (s) => { s.players[0]!.act = ActionKind.GK_RUSH; },
      (s) => { s.ball.heldBy = 0; s.ball.owner = 0; },
      (s) => { s.ball.owner = 0; },
      (s) => { s.players[0]!.active = 0; },
      (s) => { s.teams[0]!.keeperSlot = -1; },
    ];
    for (const apply of cases) {
      const s = setup();
      const p = s.players[0]!;
      p.moveMode = MoveMode.STOP; p.tgtX = 99; p.tgtZ = 99; p.tgtSpeed = 0; p.lookAt = 0; p.wantSprint = 0;
      apply(s);
      keeperPositioning(s, 0, ev);
      expect([p.moveMode, p.tgtX, p.tgtZ, p.tgtSpeed, p.lookAt, p.wantSprint]).toEqual([MoveMode.STOP, 99, 99, 0, 0, 0]);
    }
  });

  it('drives a CPU-brain-selected keeper without the ball (keepers are AI unless a human has them)', () => {
    const s = setup();
    s.ctrl[2]!.slot = 0; s.players[0]!.ctrl = 2;
    keeperPositioning(s, 0, ev);
    expect(s.players[0]!.moveMode).toBe(MoveMode.ARRIVE);
  });

  it('is cheap: well under the per-tick budget', () => {
    const s = setup();
    for (let i = 0; i < 20000; i++) { s.ball.z = (i % 60) - 30; keeperPositioning(s, i & 1, ev); }
    const n = 200000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { s.ball.z = (i % 60) - 30; s.ball.x = (i % 100) - 50; keeperPositioning(s, i & 1, ev); }
    const usPerCall = ((performance.now() - t0) * 1000) / n;
    expect(usPerCall).toBeLessThan(5);
  });
});
