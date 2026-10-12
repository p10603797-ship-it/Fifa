/**
 * [SIM-03] detectCrossing: table-driven swept crossings of the goal lines and touchlines at every speed (up to
 * 40 m/s), angle and height, fed exactly like SIM-02's ballTick does (per-tick reset of ball.cross, the tick's path
 * split into substeps or a single chord), plus the named edge cases and glitch-list regressions:
 * grazing the post inside, bouncing on the line, curling back, the corner flag, a ball resting on the line,
 * "goal given through the side netting", "goal counted twice", "goal not given when the ball crosses and bounces out".
 */
import { describe, expect, it } from 'vitest';
import {
  BALL_RADIUS, DT, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, HALF_WIDTH, POST_RADIUS,
} from '../../src/contracts/constants';
import { CrossKind } from '../../src/contracts/enums';
import { createBallState, type SimState } from '../../src/contracts/state';
import { T_BALL } from '../../src/contracts/tuning';
import { BALL_OUT_X, BALL_OUT_Z, detectCrossing } from '../../src/sim/pitch/geometry';

const R = BALL_RADIUS;
const GW = GOAL_HALF_WIDTH;
const GH = GOAL_HEIGHT;
const SPEEDS = [0.2, 1, 5, 12, 22, 30, 36, 40];
/** Speeds for the big tables (the slowest paths need hundreds of ticks per case). */
const TABLE_SPEEDS = [0.5, 2, 5, 12, 22, 30, 36, 40];

/** detectCrossing reads and writes only s.ball. */
function mk(): SimState {
  return { ball: createBallState() } as unknown as SimState;
}

type V3 = [number, number, number];

/** A recorded crossing; `a` = start of the substep chord that crossed. */
interface Hit { kind: CrossKind; x: number; z: number; end: number; tick: number; a: V3 }

/**
 * Feed a path the way ballTick does: ball.cross reset at the start of every tick, the tick split into `sub(a, b)`
 * equal substeps (SIM-02 substeps; a, b = the tick's start and end positions), the path sampled at every substep
 * boundary and detectCrossing called on each substep chord in order. Returns every crossing recorded (one per tick
 * at most).
 */
function feed(s: SimState, pos: (t: number) => V3, ticks: number, sub: (a: V3, b: V3) => number): Hit[] {
  const hits: Hit[] = [];
  let a = pos(0);
  for (let k = 1; k <= ticks; k++) {
    const b = pos(k * DT);
    s.ball.cross = CrossKind.NONE;
    const n = sub(a, b);
    let p = a;
    let at = a;
    for (let i = 1; i <= n; i++) {
      const q: V3 = i === n ? b : pos((k - 1 + i / n) * DT);
      if (detectCrossing(s, p[0], p[1], p[2], q[0], q[1], q[2]) !== CrossKind.NONE) at = p;
      p = q;
    }
    const bl = s.ball;
    if (bl.cross !== CrossKind.NONE) hits.push({ kind: bl.cross, x: bl.crossX, z: bl.crossZ, end: bl.crossEnd, tick: k, a: at });
    a = b;
  }
  return hits;
}

/** One chord per tick (worst case: a 40 m/s ball moves 0.67 m per segment). */
const ONE = (): number => 1;
/** SIM-02-like substeps: ceil(chord / maxStep). */
const SIM02 = (a: V3, b: V3): number => {
  const d = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2);
  return Math.max(1, Math.ceil(d / T_BALL.maxStep));
};

/** Straight path through point c along unit direction d at speed v, passing c at time tc. */
function line(c: V3, d: V3, v: number, tc: number): (t: number) => V3 {
  return (t) => [c[0] + d[0] * v * (t - tc), c[1] + d[1] * v * (t - tc), c[2] + d[2] * v * (t - tc)];
}

const deg = (a: number): number => (a * Math.PI) / 180;

/**
 * Oracle for a straight path through c (on the plane u = BALL_OUT_X) along d crossing at goal `end`, given the start
 * A of the substep chord that crossed: GOAL iff the centre is inside the mouth at c and at the entry point - where
 * the path passes the goal line u = HALF_LENGTH, or A itself when A is already past the goal line (a single segment
 * cannot see where the ball was before A; SIM-02's posts, bar and net sheets guarantee such an A came in through
 * the mouth). `ambiguous` = a deciding point lies within 1e-6 m of the mouth boundary.
 */
function oracleGoal(c: V3, d: V3, end: number, a: V3): { goal: boolean; ambiguous: boolean; viaA: boolean } {
  const mC = Math.min(GW - Math.abs(c[2]), GH - c[1]);
  let e: V3;
  const viaA = end * a[0] >= HALF_LENGTH;
  if (viaA) e = a;
  else {
    const back = (BALL_OUT_X - HALF_LENGTH) / (end * d[0]); // distance along d from the goal line to c
    e = [c[0] - d[0] * back, c[1] - d[1] * back, c[2] - d[2] * back];
  }
  const mE = Math.min(GW - Math.abs(e[2]), GH - e[1]);
  return { goal: mC > 0 && mE > 0, ambiguous: Math.abs(mC) < 1e-6 || (mC > 0 && Math.abs(mE) < 1e-6), viaA };
}

describe('SIM-03 detectCrossing: goal lines, table-driven (speeds x angles x heights x substeps)', () => {
  const thetas = [-75, -60, -45, -20, 0, 20, 45, 60, 75];
  const elevs = [-25, -10, 0, 10, 25];
  const zs = [0, 1.8, -1.8, 3.3, -3.3, 3.5, -3.5, 3.62, 3.9, -3.9, 6, -15, 30];
  const ys = [R, 1.2, 2.3, 2.42, 2.5, 4.5];
  const phases = [0.37, 0.93];
  for (const v of TABLE_SPEEDS) {
    it(`${v} m/s: exactly one crossing, right kind, exact crossing point`, () => {
      let goals = 0;
      let outs = 0;
      const fails: string[] = [];
      for (const end of [1, -1]) {
        for (const th of thetas) {
          for (const el of elevs) {
            const d: V3 = [end * Math.cos(deg(el)) * Math.cos(deg(th)), Math.sin(deg(el)), Math.cos(deg(el)) * Math.sin(deg(th))];
            for (const zc of zs) {
              for (const yc of ys) {
                const c: V3 = [end * BALL_OUT_X, yc, zc];
                // Start 0.2..1.6 m before the crossing and in front of the goal line (inside the field), run 0.3 m
                // past it.
                const before = Math.max(Math.min(1.6, 0.2 + v * DT * 3), (R + 0.02) / Math.abs(d[0]));
                const pre = Math.ceil(before / (v * DT));
                const ticks = pre + 1 + Math.ceil(0.3 / (v * DT));
                for (const ph of phases) {
                  const tc = (pre + ph) * DT;
                  for (const sub of [ONE, SIM02]) {
                    const s = mk();
                    const hits = feed(s, line(c, d, v, tc), ticks, sub);
                    const tag = `end ${end} th ${th} el ${el} z ${zc} y ${yc} ph ${ph} ${sub === ONE ? 'one' : 'sub'}`;
                    const h = hits[0];
                    if (hits.length !== 1 || !h) { fails.push(`${tag}: ${hits.length} crossings`); continue; }
                    if (h.end !== end || h.x !== end * BALL_OUT_X || !(Math.abs(h.z - zc) < 1e-9)) {
                      fails.push(`${tag}: crossing point ${h.end} ${h.x} ${h.z}`);
                    }
                    const o = oracleGoal(c, d, end, h.a);
                    if (o.ambiguous) continue; // on the mouth boundary: covered by the dedicated cases below
                    if (h.kind !== (o.goal ? CrossKind.GOAL : CrossKind.GOAL_LINE)) fails.push(`${tag}: kind ${h.kind}`);
                    if (o.goal) goals++;
                    else outs++;
                  }
                }
              }
            }
          }
        }
      }
      expect(fails.slice(0, 10)).toEqual([]);
      expect(goals).toBeGreaterThan(500);
      expect(outs).toBeGreaterThan(500);
    });
  }
});

describe('SIM-03 detectCrossing: touchlines, table-driven', () => {
  const thetas = [-75, -45, -10, 0, 10, 45, 75];
  const xs = [-52.4, -50, -20, 0, 20, 50, 52.4];
  const ys = [R, 1.5, 6];
  for (const v of TABLE_SPEEDS) {
    it(`${v} m/s: exactly one TOUCHLINE crossing at the right point`, () => {
      const fails: string[] = [];
      let n = 0;
      for (const side of [1, -1]) {
        for (const th of thetas) {
          for (const xc of xs) {
            for (const yc of ys) {
              // Direction: outward normal (0, 0, side) rotated by th toward +x.
              const d: V3 = [Math.sin(deg(th)), 0, side * Math.cos(deg(th))];
              const c: V3 = [xc, yc, side * BALL_OUT_Z];
              const before = Math.min(1.6, 0.2 + v * DT * 3);
              // Skip paths that would start beyond a goal-line plane (the ball would already be out).
              if (Math.abs(xc - d[0] * before) > BALL_OUT_X) continue;
              const ticks = Math.ceil((before + 0.3) / (v * DT));
              const tc = (Math.floor(before / (v * DT)) + 0.41) * DT;
              for (const sub of [ONE, SIM02]) {
                const s = mk();
                const hits = feed(s, line(c, d, v, tc), ticks, sub);
                const tag = `side ${side} th ${th} x ${xc} y ${yc}`;
                const h = hits[0];
                n++;
                if (hits.length !== 1 || !h) fails.push(`${tag}: ${hits.length} crossings`);
                else if (h.kind !== CrossKind.TOUCHLINE || h.end !== 0 || h.z !== side * BALL_OUT_Z || !(Math.abs(h.x - xc) < 1e-9)) {
                  fails.push(`${tag}: ${h.kind} ${h.end} ${h.x} ${h.z}`);
                }
              }
            }
          }
        }
      }
      expect(fails.slice(0, 10)).toEqual([]);
      expect(n).toBeGreaterThan(400);
    });
  }
});

describe('SIM-03 detectCrossing: rules of the call', () => {
  it('returns NONE and changes nothing when a crossing is already recorded this tick', () => {
    const s = mk();
    s.ball.cross = CrossKind.TOUCHLINE; s.ball.crossX = 7; s.ball.crossZ = BALL_OUT_Z; s.ball.crossEnd = 0;
    expect(detectCrossing(s, 52, 0.5, 0, 53, 0.5, 0)).toBe(CrossKind.NONE);
    expect([s.ball.cross, s.ball.crossX, s.ball.crossZ, s.ball.crossEnd]).toEqual([CrossKind.TOUCHLINE, 7, BALL_OUT_Z, 0]);
  });

  it('returns the kind and fills cross / crossX / crossZ / crossEnd', () => {
    const s = mk();
    expect(detectCrossing(s, 52.5, 1, 1, 52.7, 1, 1)).toBe(CrossKind.GOAL);
    expect([s.ball.cross, s.ball.crossX, s.ball.crossZ, s.ball.crossEnd]).toEqual([CrossKind.GOAL, BALL_OUT_X, 1, 1]);
    const t = mk();
    expect(detectCrossing(t, -52.5, 0.11, -20, -52.7, 0.11, -20)).toBe(CrossKind.GOAL_LINE);
    expect([t.ball.cross, t.ball.crossX, t.ball.crossZ, t.ball.crossEnd]).toEqual([CrossKind.GOAL_LINE, -BALL_OUT_X, -20, -1]);
    const u = mk();
    expect(detectCrossing(u, 10, 0.11, -34, 10, 0.11, -34.3)).toBe(CrossKind.TOUCHLINE);
    expect([u.ball.cross, u.ball.crossX, u.ball.crossZ, u.ball.crossEnd]).toEqual([CrossKind.TOUCHLINE, 10, -BALL_OUT_Z, 0]);
  });

  it('only the WHOLE ball over the whole line counts (centre beyond the line by more than BALL_RADIUS)', () => {
    const cases: [V3, V3, CrossKind][] = [
      [[52, R, 0], [HALF_LENGTH, R, 0], CrossKind.NONE], // centre on the line
      [[52, R, 0], [HALF_LENGTH + R, R, 0], CrossKind.NONE], // touching the outer edge of the line
      [[52, R, 0], [HALF_LENGTH + R + 1e-9, R, 0], CrossKind.GOAL],
      [[52, R, 10], [HALF_LENGTH + R, R, 10], CrossKind.NONE],
      [[52, R, 10], [HALF_LENGTH + R + 1e-9, R, 10], CrossKind.GOAL_LINE],
      [[0, R, 33], [0, R, HALF_WIDTH], CrossKind.NONE],
      [[0, R, 33], [0, R, HALF_WIDTH + R], CrossKind.NONE],
      [[0, R, 33], [0, R, HALF_WIDTH + R + 1e-9], CrossKind.TOUCHLINE],
      [[0, R, -33], [0, R, -HALF_WIDTH - R - 1e-9], CrossKind.TOUCHLINE],
    ];
    for (const [a, b, k] of cases) {
      const s = mk();
      expect(detectCrossing(s, a[0], a[1], a[2], b[0], b[1], b[2]), `${a} -> ${b}`).toBe(k);
      expect(s.ball.cross).toBe(k);
    }
  });

  it('a segment that starts wholly out (behind a goal line, past a touchline) never crosses again', () => {
    const cases: [V3, V3][] = [
      [[53, R, 10], [54, R, 10]],
      [[53, R, 10], [52, R, 10]], // coming back in
      [[53, 1, 0], [53.5, 1, 0]], // in the goal volume
      [[52.7, 1, 10], [52.7, 1, 40]], // behind the goal line, then over the touchline extension
      [[0, R, 34.5], [0, R, 36]],
      [[0, R, 34.5], [0, R, 30]],
      [[20, R, 35], [60, R, 0]],
    ];
    for (const [a, b] of cases) {
      const s = mk();
      expect(detectCrossing(s, a[0], a[1], a[2], b[0], b[1], b[2]), `${a} -> ${b}`).toBe(CrossKind.NONE);
      expect(s.ball.cross).toBe(CrossKind.NONE);
    }
  });

  it('segments that stay inside the lines (or go back in) are NONE', () => {
    const cases: [V3, V3][] = [
      [[0, R, 0], [0, R, 0]],
      [[52.6, R, 0], [52.0, R, 0]],
      [[-52.6, R, 33.5], [-52.0, 3, 34.1]],
      [[52.61, 2.43, 3.65], [52.61, 2.43, 3.65]],
    ];
    for (const [a, b] of cases) expect(detectCrossing(mk(), a[0], a[1], a[2], b[0], b[1], b[2])).toBe(CrossKind.NONE);
  });

  it('non-finite coordinates are NONE (never a crossing)', () => {
    const bad = [NaN, Infinity, -Infinity];
    for (const v of bad) {
      for (let i = 0; i < 6; i++) {
        const a = [52, 1, 0, 53, 1, 0];
        a[i] = v;
        const s = mk();
        expect(detectCrossing(s, a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!), `${i}=${v}`).toBe(CrossKind.NONE);
        expect(s.ball.cross).toBe(CrossKind.NONE);
      }
    }
  });

  it('a fast ball cannot skip the line: one 40 m/s chord from inside to far beyond is still caught', () => {
    const step = 40 * DT; // 0.667 m
    for (const start of [52.0, 52.3, BALL_OUT_X]) {
      const s = mk();
      expect(detectCrossing(s, start, 1, 2, start + step, 1, 2)).toBe(CrossKind.GOAL);
      const t = mk();
      expect(detectCrossing(t, 0, 1, start - HALF_LENGTH + HALF_WIDTH, 0, 1, start - HALF_LENGTH + HALF_WIDTH + step)).toBe(CrossKind.TOUCHLINE);
    }
  });
});

describe('SIM-03 detectCrossing: goal mouth edges (posts, bar)', () => {
  it('grazing the post inside: a ball touching the inner face of the post is a GOAL', () => {
    for (const end of [1, -1]) {
      for (const side of [1, -1]) {
        const z = side * (GW - R); // ball surface on the inner face of the post
        for (const v of SPEEDS) {
          const s = mk();
          const hits = feed(s, line([end * BALL_OUT_X, 0.5, z], [end, 0, 0], v, 0.5 * DT + Math.floor(0.6 / (v * DT)) * DT),
            Math.ceil(0.9 / (v * DT)), SIM02);
          expect(hits.map((h) => h.kind), `end ${end} side ${side} v ${v}`).toEqual([CrossKind.GOAL]);
        }
        // Centre a hair inside the inner face: still a goal; on or past it: out.
        expect(detectCrossing(mk(), end * 52.4, 1, side * (GW - 1e-9), end * 52.7, 1, side * (GW - 1e-9))).toBe(CrossKind.GOAL);
        expect(detectCrossing(mk(), end * 52.4, 1, side * GW, end * 52.7, 1, side * GW)).toBe(CrossKind.GOAL_LINE);
        // Just outside the post (centre clears the post by a hair): out.
        const zo = side * (GW + 2 * POST_RADIUS + R + 0.001);
        expect(detectCrossing(mk(), end * 52.4, 1, zo, end * 52.7, 1, zo)).toBe(CrossKind.GOAL_LINE);
      }
    }
  });

  it('grazing the post inside at an angle (shot across goal into the far corner)', () => {
    // Ball centre passes the goal line at z = 3.5 travelling at 30 deg across goal toward -z: in.
    const d: V3 = [Math.cos(deg(30)), 0, -Math.sin(deg(30))];
    const c: V3 = [BALL_OUT_X, 0.4, 3.5 - Math.tan(deg(30)) * R];
    const hits = feed(mk(), line(c, d, 30, 0.5 * DT + 2 * DT), 5, SIM02);
    expect(hits.map((h) => h.kind)).toEqual([CrossKind.GOAL]);
  });

  it('under the bar is a goal, on or over the bar line is not', () => {
    expect(detectCrossing(mk(), 52.3, GH - R, 0, 52.9, GH - R, 0)).toBe(CrossKind.GOAL); // touching the underside
    expect(detectCrossing(mk(), 52.3, GH - 1e-9, 0, 52.9, GH - 1e-9, 0)).toBe(CrossKind.GOAL);
    expect(detectCrossing(mk(), 52.3, GH, 0, 52.9, GH, 0)).toBe(CrossKind.GOAL_LINE);
    expect(detectCrossing(mk(), 52.3, GH + 2 * POST_RADIUS + R + 0.001, 0, 52.9, 2.7, 0)).toBe(CrossKind.GOAL_LINE);
  });

  it('the crossing height is interpolated at the plane: a dipping shot that is under the bar when wholly over is in', () => {
    // From 2.6 m at u = 52.0 down to 2.2 m at u = 52.8: at u = HALF_LENGTH 2.35, at BALL_OUT_X 2.295 -> goal.
    expect(detectCrossing(mk(), 52.0, 2.6, 0, 52.8, 2.2, 0)).toBe(CrossKind.GOAL);
    // Rising shot: 2.3 m at u = 52.0, 2.6 m at u = 52.8 -> 2.529 at BALL_OUT_X -> over.
    expect(detectCrossing(mk(), 52.0, 2.3, 0, 52.8, 2.6, 0)).toBe(CrossKind.GOAL_LINE);
  });
});

describe('SIM-03 glitch list: goals', () => {
  it('regression "goal given through the side netting": a ball reaching the goal volume from the side is out', () => {
    for (const end of [1, -1]) {
      for (const side of [1, -1]) {
        // Path crosses the goal line beside the post (|z| = 3.8 at u = 52.5) and runs into the goal volume.
        expect(detectCrossing(mk(), end * 52.3, 1, side * 4.6, end * 52.8, 1, side * 2.6)).toBe(CrossKind.GOAL_LINE);
        // Already partly over the line beside the goal, then sideways into the volume.
        expect(detectCrossing(mk(), end * 52.55, 1, side * 3.85, end * 52.68, 1, side * 3.3)).toBe(CrossKind.GOAL_LINE);
        // A shot from a tight angle into the outside of the side netting, at every speed.
        for (const v of SPEEDS) {
          const d: V3 = [end * Math.cos(deg(70)), 0.05, side * -Math.sin(deg(70))];
          const c: V3 = [end * BALL_OUT_X, 0.6, side * 3.95];
          const hits = feed(mk(), line(c, d, v, 0.5 * DT + Math.floor(0.6 / (v * DT)) * DT), Math.ceil(0.8 / (v * DT)), SIM02);
          expect(hits.length).toBe(1);
          expect(hits[0]!.kind, `v ${v}`).toBe(CrossKind.GOAL_LINE);
        }
      }
    }
  });

  it('a ball dropping into the goal volume through the roof is out (over the bar first)', () => {
    expect(detectCrossing(mk(), 52.0, 3.0, 0, 53.0, 2.0, 0)).toBe(CrossKind.GOAL_LINE);
    expect(detectCrossing(mk(), 52.55, 2.6, 0, 52.67, 2.2, 0)).toBe(CrossKind.GOAL_LINE);
    expect(detectCrossing(mk(), -52.55, 2.6, 1, -52.67, 2.2, 1)).toBe(CrossKind.GOAL_LINE);
  });

  it('regression "goal counted twice": a ball in the net never produces a second GOAL', () => {
    for (const end of [1, -1]) {
      const s = mk();
      expect(detectCrossing(s, end * 52.4, 1, 0, end * 52.7, 1, 0)).toBe(CrossKind.GOAL);
      // SIM-02 marks it in the net; next ticks: held by the in-net front wall at exactly u = BALL_OUT_X and pushed back in.
      s.ball.inNet = end;
      for (let k = 0; k < 120; k++) {
        s.ball.cross = CrossKind.NONE;
        expect(detectCrossing(s, end * BALL_OUT_X, 0.5, 0.1 * (k % 5), end * (BALL_OUT_X + 0.05), 0.5, 0.1 * (k % 5))).toBe(CrossKind.NONE);
        expect(detectCrossing(s, end * 53.5, 0.5, 0, end * 53.8, 0.5, 0)).toBe(CrossKind.NONE);
        expect(s.ball.cross).toBe(CrossKind.NONE);
      }
      // Same tick: a second crossing is never recorded on top of the first.
      const t = mk();
      expect(detectCrossing(t, end * 52.4, 1, 0, end * 52.7, 1, 0)).toBe(CrossKind.GOAL);
      expect(detectCrossing(t, end * 52.4, 1, 0, end * 52.7, 1, 0)).toBe(CrossKind.NONE);
      expect(t.ball.cross).toBe(CrossKind.GOAL);
    }
  });

  it('a ball in one net does not block a crossing at the other end (stale flag safety)', () => {
    const s = mk();
    s.ball.inNet = 1;
    expect(detectCrossing(s, -52.4, 1, 0, -52.7, 1, 0)).toBe(CrossKind.GOAL);
  });

  it('regression "goal not given when the ball crosses and bounces out": the crossing sticks', () => {
    // Bar-down: the ball lands wholly over the line, then spins back out into the field within the same tick
    // and over the next ticks. The GOAL is recorded on the substep that crossed and nothing later overrides it.
    const s = mk();
    const pts: V3[] = [[52.2, 2.2, 0.5], [52.45, 1.2, 0.5], [52.66, R, 0.5], [52.55, 0.9, 0.5], [52.2, 1.4, 0.5]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      detectCrossing(s, a[0], a[1], a[2], b[0], b[1], b[2]);
    }
    expect(s.ball.cross).toBe(CrossKind.GOAL);
    expect(s.ball.crossEnd).toBe(1);
    // The same path spread over ticks (cross reset each tick): exactly one GOAL, on the landing tick.
    const path = (t: number): V3 => {
      const k = Math.min(pts.length - 1, Math.floor(t / DT + 1e-9));
      const f = t / DT - k;
      const a = pts[k]!;
      const b = pts[Math.min(pts.length - 1, k + 1)]!;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    };
    const hits = feed(mk(), path, pts.length - 1, SIM02);
    expect(hits.map((h) => [h.kind, h.tick])).toEqual([[CrossKind.GOAL, 2]]);
  });
});

describe('SIM-03 bouncing on the line, resting on the line, curling back', () => {
  it('a ball bouncing ON the line (partly over, never wholly) stays in play', () => {
    for (const end of [1, -1]) {
      for (const z of [0, 10, -25]) {
        const s = mk();
        // Down onto u = 52.6 (0.1 m over the line: 1 cm short of wholly over), up, and back toward the field.
        const pts: V3[] = [[51.8, 1.5, z], [52.3, 0.6, z], [52.6, R, z], [52.6, 0.5, z], [52.2, 0.9, z]];
        for (let i = 1; i < pts.length; i++) {
          s.ball.cross = CrossKind.NONE;
          const a = pts[i - 1]!;
          const b = pts[i]!;
          expect(detectCrossing(s, end * a[0], a[1], a[2], end * b[0], b[1], b[2])).toBe(CrossKind.NONE);
        }
      }
    }
  });

  it('a ball bouncing wholly over the line is out (goal in the mouth, goal line beside it)', () => {
    expect(detectCrossing(mk(), 52.3, 0.6, 1, 52.62, R, 1)).toBe(CrossKind.GOAL);
    expect(detectCrossing(mk(), 52.3, 0.6, 12, 52.62, R, 12)).toBe(CrossKind.GOAL_LINE);
  });

  it('regression "ball resting on the goal line / touchline": never out', () => {
    const rest: V3[] = [
      [HALF_LENGTH, R, 0], [HALF_LENGTH + R, R, 0], [HALF_LENGTH + R, R, 3.6], [-HALF_LENGTH - R, R, -20],
      [10, R, HALF_WIDTH], [10, R, HALF_WIDTH + R], [-40, R, -HALF_WIDTH - R], [BALL_OUT_X, R, BALL_OUT_Z],
    ];
    for (const p of rest) {
      const s = mk();
      for (let k = 0; k < 600; k++) {
        s.ball.cross = CrossKind.NONE;
        expect(detectCrossing(s, p[0], p[1], p[2], p[0], p[1], p[2])).toBe(CrossKind.NONE);
      }
    }
    // Rolling along a line, partly over it (centre exactly on the out-of-play plane), is not out either.
    const creep: [V3, V3][] = [
      [[BALL_OUT_X, R, -3], [BALL_OUT_X, R, 3]], // along the goal line across the goal mouth
      [[-BALL_OUT_X, R, 20], [-BALL_OUT_X, R, 10]],
      [[-30, R, BALL_OUT_Z], [30, R, BALL_OUT_Z]],
      [[HALF_LENGTH, R, -BALL_OUT_Z], [0, R, -BALL_OUT_Z]],
    ];
    for (const [a, b] of creep) expect(detectCrossing(mk(), a[0], a[1], a[2], b[0], b[1], b[2]), `${a}`).toBe(CrossKind.NONE);
  });

  /** Curling arc: circle of radius r around (cx, cz) from angle a0 to a1, at speed v. */
  function arc(cx: number, cz: number, r: number, a0: number, a1: number, v: number): { pos: (t: number) => V3; ticks: number } {
    const w = (v / r) * Math.sign(a1 - a0);
    const ticks = Math.ceil(Math.abs(a1 - a0) / Math.abs(w) / DT);
    return { pos: (t) => [cx + r * Math.cos(a0 + w * t), 0.4, cz + r * Math.sin(a0 + w * t)], ticks };
  }

  it('curling back: a ball whose arc goes WHOLLY over the touchline is out even though it curls back in', () => {
    for (const v of [8, 20, 30, 40]) {
      for (const over of [0.1101, 0.15, 0.5, 2]) {
        // Arc peaking at z = HALF_WIDTH + over (centre beyond the line by `over`).
        const r = 25;
        const { pos, ticks } = arc(0, HALF_WIDTH + over - r, r, Math.PI / 2 - 0.5, Math.PI / 2 + 0.5, v);
        const hits = feed(mk(), pos, ticks, SIM02);
        expect(hits.map((h) => h.kind), `v ${v} over ${over}`).toEqual([CrossKind.TOUCHLINE]);
      }
    }
  });

  it('curling back: an arc that only gets partly over the line (centre within BALL_RADIUS) stays in play', () => {
    for (const v of [8, 20, 30, 40]) {
      for (const over of [0, 0.05, 0.1, 0.1099]) {
        const r = 25;
        const { pos, ticks } = arc(0, HALF_WIDTH + over - r, r, Math.PI / 2 - 0.5, Math.PI / 2 + 0.5, v);
        expect(feed(mk(), pos, ticks, SIM02), `v ${v} over ${over}`).toEqual([]);
      }
    }
  });

  it('a banana shot that goes wholly out beside the post and curls back into the goal is a goal kick/corner', () => {
    for (const v of [15, 25, 35]) {
      // Arc in the (x, z) plane bulging past the goal line at z ~ 5..6, then curling toward the goal mouth.
      const r = 6;
      const cx = BALL_OUT_X + 0.4 - r;
      const { pos, ticks } = arc(cx, 2.5, r, 0.9, -0.3, v);
      const hits = feed(mk(), pos, ticks, SIM02);
      expect(hits.length, `v ${v}`).toBe(1);
      expect(hits[0]!.kind).toBe(CrossKind.GOAL_LINE);
      expect(Math.abs(hits[0]!.z)).toBeGreaterThan(GW);
    }
  });
});

describe('SIM-03 the corner flag', () => {
  it('a ball going out exactly over the corner (both lines at once) is a goal-line crossing (corner / goal kick)', () => {
    for (const end of [1, -1]) {
      for (const side of [1, -1]) {
        for (const th of [5, 20, 45, 70, 85]) {
          for (const v of SPEEDS) {
            // Through the corner point of the two out-of-play planes, outward in both x and z.
            const d: V3 = [end * Math.cos(deg(th)), 0, side * Math.sin(deg(th))];
            const c: V3 = [end * BALL_OUT_X, R, side * BALL_OUT_Z];
            const before = Math.min(1, 0.2 + v * DT * 3);
            const hits = feed(mk(), line(c, d, v, (Math.floor(before / (v * DT)) + 0.5) * DT), Math.ceil((before + 0.3) / (v * DT)), SIM02);
            const tag = `end ${end} side ${side} th ${th} v ${v}`;
            expect(hits.length, tag).toBe(1);
            expect(hits[0]!.kind, tag).toBe(CrossKind.GOAL_LINE);
            expect(hits[0]!.end, tag).toBe(end);
            expect(Math.abs(hits[0]!.z - side * BALL_OUT_Z), tag).toBeLessThan(1e-9);
          }
        }
        // The exact diagonal chord through the corner.
        expect(detectCrossing(mk(), end * 50, R, side * 31.5, end * 55, R, side * 36.5)).toBe(CrossKind.GOAL_LINE);
      }
    }
  });

  it('a substep ending exactly on the corner point (rounded to either side) is still a goal-line crossing', () => {
    for (const end of [1, -1]) {
      for (const side of [1, -1]) {
        const cx = end * BALL_OUT_X;
        const cz = side * BALL_OUT_Z;
        // Rounded onto the touchline side: only z is beyond its plane.
        const s = mk();
        expect(detectCrossing(s, cx - end * 0.4, R, cz - side * 0.4, cx - end * 1e-12, R, cz + side * 1e-12)).toBe(CrossKind.GOAL_LINE);
        expect([s.ball.crossX, s.ball.crossZ, s.ball.crossEnd]).toEqual([cx, cz, end]);
        // Rounded onto the goal-line side: only x is beyond its plane.
        const t = mk();
        expect(detectCrossing(t, cx - end * 0.4, R, cz - side * 0.4, cx + end * 1e-12, R, cz - side * 1e-12)).toBe(CrossKind.GOAL_LINE);
        expect(t.ball.crossEnd).toBe(end);
      }
    }
  });

  it('a hair before the corner along the touchline is a throw-in; a hair inside along the goal line is out over the goal line', () => {
    const e = 1e-3;
    // 45 degrees through (BALL_OUT_X - e, BALL_OUT_Z): over the touchline while still short of the goal-line plane.
    const s = mk();
    expect(detectCrossing(s, BALL_OUT_X - e - 0.5, R, BALL_OUT_Z - 0.5, BALL_OUT_X - e + 0.2, R, BALL_OUT_Z + 0.2)).toBe(CrossKind.TOUCHLINE);
    expect(Math.abs(s.ball.crossX - (BALL_OUT_X - e))).toBeLessThan(1e-9);
    expect(s.ball.crossEnd).toBe(0);
    // 45 degrees through (BALL_OUT_X, BALL_OUT_Z - e): over the goal-line plane while still inside the touchline plane.
    const t = mk();
    expect(detectCrossing(t, BALL_OUT_X - 0.5, R, BALL_OUT_Z - e - 0.5, BALL_OUT_X + 0.2, R, BALL_OUT_Z - e + 0.2)).toBe(CrossKind.GOAL_LINE);
    expect(t.ball.crossEnd).toBe(1);
    expect(Math.abs(t.ball.crossZ - (BALL_OUT_Z - e))).toBeLessThan(1e-9);
    // Running along the touchline (partly over it) and out over the goal-line plane at the corner: goal line.
    const u = mk();
    expect(detectCrossing(u, 52.0, R, BALL_OUT_Z, 52.9, R, BALL_OUT_Z)).toBe(CrossKind.GOAL_LINE);
    expect(u.ball.crossZ).toBe(BALL_OUT_Z);
    // Running along the goal line exactly on its out-of-play plane and over the touchline plane: that is the corner
    // point itself, so goal line too; a millimetre inside the goal-line plane it is a throw-in.
    const w = mk();
    expect(detectCrossing(w, -BALL_OUT_X, R, -33.0, -BALL_OUT_X, R, -34.5)).toBe(CrossKind.GOAL_LINE);
    expect([w.ball.crossX, w.ball.crossZ, w.ball.crossEnd]).toEqual([-BALL_OUT_X, -BALL_OUT_Z, -1]);
    const w2 = mk();
    expect(detectCrossing(w2, -BALL_OUT_X + e, R, -33.0, -BALL_OUT_X + e, R, -34.5)).toBe(CrossKind.TOUCHLINE);
    expect(w2.ball.crossX).toBe(-BALL_OUT_X + e);
    expect(w2.ball.crossEnd).toBe(0);
  });
});

describe('SIM-03 determinism and symmetry', () => {
  /** Tiny deterministic generator for the property tests (test-only). */
  function lcg(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x / 4294967296;
    };
  }

  function randomSegments(n: number, seed: number): number[][] {
    const r = lcg(seed);
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
      // Bias toward the lines and the goal mouth.
      const nearGoal = r() < 0.6;
      const x0 = nearGoal ? 51.6 + r() * 1.1 : -52.7 + r() * 105.4;
      const z0 = nearGoal ? -5 + r() * 10 : -34.2 + r() * 68.4;
      const y0 = R + r() * 3;
      const len = r() * 0.7;
      const a = r() * 2 * Math.PI;
      const x1 = x0 + Math.cos(a) * len;
      const z1 = z0 + Math.sin(a) * len;
      const y1 = Math.max(R, y0 + (r() - 0.5) * len);
      out.push([x0, y0, z0, x1, y1, z1]);
    }
    return out;
  }

  function judge(seg: number[]): number[] {
    const s = mk();
    const k = detectCrossing(s, seg[0]!, seg[1]!, seg[2]!, seg[3]!, seg[4]!, seg[5]!);
    return [k, s.ball.cross, s.ball.crossX, s.ball.crossZ, s.ball.crossEnd];
  }

  it('same inputs give bit-identical results (repeat runs)', () => {
    const segs = randomSegments(20000, 7);
    const a = segs.map(judge);
    const b = segs.map(judge);
    expect(b).toEqual(a);
    expect(a.some((r) => r[0] === CrossKind.GOAL)).toBe(true);
    expect(a.some((r) => r[0] === CrossKind.GOAL_LINE)).toBe(true);
  });

  it('mirror symmetric: x -> -x swaps the end, z -> -z mirrors crossZ, results otherwise bit-identical', () => {
    for (const seg of randomSegments(20000, 11)) {
      const r = judge(seg);
      const mx = judge([-seg[0]!, seg[1]!, seg[2]!, -seg[3]!, seg[4]!, seg[5]!]);
      const mz = judge([seg[0]!, seg[1]!, -seg[2]!, seg[3]!, seg[4]!, -seg[5]!]);
      expect(mx[0]).toBe(r[0]);
      expect(mz[0]).toBe(r[0]);
      if (r[0] !== CrossKind.NONE) {
        expect(mx[2]).toBe(-r[2]!);
        expect(mx[3]).toBe(r[3]);
        expect(mx[4]).toBe(-r[4]! || 0);
        expect(mz[2]).toBe(r[2]);
        expect(mz[3]).toBe(-r[3]!);
        expect(mz[4]).toBe(r[4]);
      }
    }
  });

  it('properties on random segments: GOAL only through the mouth, never from outside, never if the end stays in', () => {
    for (const seg of randomSegments(40000, 23)) {
      const [x0, y0, z0, x1, y1, z1] = seg as [number, number, number, number, number, number];
      const r = judge(seg);
      const startOut = Math.abs(x0) > BALL_OUT_X || Math.abs(z0) > BALL_OUT_Z;
      const endIn = Math.abs(x1) <= BALL_OUT_X && Math.abs(z1) <= BALL_OUT_Z;
      if (startOut || endIn) expect(r[0]).toBe(CrossKind.NONE);
      if (!startOut && !endIn) expect(r[0]).not.toBe(CrossKind.NONE);
      if (r[0] === CrossKind.GOAL) {
        const end = x1 < 0 ? -1 : 1;
        const u0 = end * x0;
        const u1 = end * x1;
        const t = (BALL_OUT_X - u0) / (u1 - u0);
        expect(Math.abs(z0 + (z1 - z0) * t)).toBeLessThan(GW);
        expect(y0 + (y1 - y0) * t).toBeLessThan(GH);
        const te = Math.max(0, (HALF_LENGTH - u0) / (u1 - u0));
        expect(Math.abs(z0 + (z1 - z0) * te)).toBeLessThan(GW);
        expect(y0 + (y1 - y0) * te).toBeLessThan(GH);
        expect(r[4]).toBe(end);
      }
    }
  });
});
