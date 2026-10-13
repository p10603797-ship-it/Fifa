/**
 * [SIM-03] Goal and out-of-play detection on real ball paths: SIM-02's ballTick (posts, bar, net, side netting,
 * roof, substeps) feeding the real detectCrossing, and the full step() pipeline (rules award the goal / restart).
 *
 * Core property, over thousands of shots at and around the goal frame at every speed up to 40 m/s:
 *   a GOAL is recorded  <=>  the ball ends up in the net (SIM-02 inNet), exactly once, never through the side
 *   netting or the roof, never twice.
 * Glitch-list regressions: "goal not given when the ball crosses and bounces out", "goal counted twice",
 * "goal given through the side netting", "ball resting on the goal line".
 */
import '../../src/sim/actions/dispatch'; // load the action registry before the keeper modules (import-cycle order)
import { describe, expect, it } from 'vitest';
import {
  BALL_RADIUS, DT, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, NUM_SLOTS,
} from '../../src/contracts/constants';
import { CrossKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createBallState, type BallState, type SimState } from '../../src/contracts/state';
import { ballTick } from '../../src/sim/ball/contact';
import { createEventBuffer } from '../../src/sim/core/events';
import { BALL_OUT_X } from '../../src/sim/pitch/geometry';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';

const R = BALL_RADIUS;
const G = 9.81;

const BASE = makeScenario({ phase: MatchPhase.IN_PLAY });
const FRESH = createBallState();
const EV = createEventBuffer();

function withBall(over: Partial<BallState>): SimState {
  const s = BASE;
  Object.assign(s.ball, FRESH, over);
  s.ball.px = s.ball.x; s.ball.py = s.ball.y; s.ball.pz = s.ball.z;
  s.ball.grounded = s.ball.y <= R + 1e-9 && s.ball.vy === 0 ? 1 : 0;
  return s;
}

interface Run {
  /** First crossing recorded (NONE if none) and its tick; every crossing recorded. */
  first: CrossKind; firstTick: number; firstEnd: number; crossings: number;
  /** First tick the ball was in a net (-1 never) and which. */
  netTick: number; netEnd: number;
  /** inNet at the end of the first-crossing tick. */
  inNetAtCross: number;
  maxU: number; finalU: number;
}

/** Tick the ball alone (ballTick = SIM-02 + SIM-03), resetting ball.cross every tick like step(). */
function run(s: SimState, ticks: number, end: number, onTick?: (b: BallState) => void): Run {
  const r: Run = { first: CrossKind.NONE, firstTick: -1, firstEnd: 0, crossings: 0, netTick: -1, netEnd: 0, inNetAtCross: 0, maxU: -1e9, finalU: 0 };
  const b = s.ball;
  for (let i = 1; i <= ticks; i++) {
    s.tick++;
    EV.begin(s.tick);
    b.cross = CrossKind.NONE;
    ballTick(s, EV);
    if (b.cross !== CrossKind.NONE) {
      r.crossings++;
      if (r.first === CrossKind.NONE) { r.first = b.cross; r.firstTick = i; r.firstEnd = b.crossEnd; r.inNetAtCross = b.inNet; }
    }
    if (b.inNet !== 0 && r.netTick < 0) { r.netTick = i; r.netEnd = b.inNet; }
    if (onTick) onTick(b);
    const u = end * b.x;
    if (u > r.maxU) r.maxU = u;
    r.finalU = u;
  }
  return r;
}

/** A shot from o toward target t (on the goal-line plane) at speed v, lifted to offset gravity over the flight. */
function shot(o: [number, number, number], t: [number, number, number], v: number, curl = 0): Partial<BallState> {
  const dx = t[0] - o[0];
  const dy = t[1] - o[1];
  const dz = t[2] - o[2];
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const tof = d / v;
  return {
    x: o[0], y: o[1], z: o[2], vx: (dx / d) * v, vy: (dy / d) * v + 0.5 * G * tof, vz: (dz / d) * v, sy: curl,
    owner: -1, heldBy: -1, inNet: 0,
  };
}

function checkConsistent(r: Run, end: number, tag: string, fails: string[]): void {
  if (r.first === CrossKind.GOAL && (r.firstEnd !== end || r.inNetAtCross !== end)) fails.push(`${tag}: GOAL but inNet ${r.inNetAtCross}`);
  if (r.netTick >= 0 && !(r.first === CrossKind.GOAL && r.firstTick <= r.netTick)) {
    fails.push(`${tag}: in the net at tick ${r.netTick} but first crossing ${r.first} at ${r.firstTick}`);
  }
  if (r.first === CrossKind.GOAL && r.crossings !== 1) fails.push(`${tag}: ${r.crossings} crossings after a GOAL`);
}

describe('SIM-03 + SIM-02: goal given <=> ball in the net, on real ball paths', () => {
  const speeds = [8, 15, 25, 36, 40];
  for (const end of [1, -1]) {
    it(`shots at the goal frame (end ${end}): every speed, every point of the mouth and around it`, () => {
      const fails: string[] = [];
      let goals = 0;
      let outs = 0;
      let none = 0;
      const origins: [number, number, number][] = [
        [end * (HALF_LENGTH - 11), R, 0], [end * (HALF_LENGTH - 18), R, -9], [end * (HALF_LENGTH - 6), 0.6, 5],
        [end * (HALF_LENGTH - 25), R, 14],
      ];
      for (const o of origins) {
        for (const v of speeds) {
          for (let tz = -5; tz <= 5.001; tz += 0.25) {
            for (let ty = R; ty <= 3.3; ty += 0.2) {
              const s = withBall(shot(o, [end * HALF_LENGTH, ty, tz], v, (tz * 3) % 5));
              const r = run(s, 150, end);
              checkConsistent(r, end, `o ${o} v ${v} z ${tz.toFixed(2)} y ${ty.toFixed(2)}`, fails);
              if (r.first === CrossKind.GOAL) goals++;
              else if (r.first === CrossKind.GOAL_LINE) outs++;
              else none++;
            }
          }
        }
      }
      expect(fails.slice(0, 10)).toEqual([]);
      // The sweep covers goals, misses over / wide, and rebounds off the frame.
      expect(goals).toBeGreaterThan(1000);
      expect(outs).toBeGreaterThan(500);
      expect(none).toBeGreaterThan(20);
    });
  }

  it('regression "goal given through the side netting": tight-angle shots into the outside of the side netting are never goals', () => {
    const fails: string[] = [];
    let outs = 0;
    let deflected = 0;
    for (const end of [1, -1]) {
      for (const side of [1, -1]) {
        // Deflected by the side netting from outside: moving toward the goal (side * vz < 0) one tick, away the next,
        // while beside the net box.
        const w = { prevVz: 0, hit: false };
        const watch = (b: BallState): void => {
          const u = end * b.x;
          const az = side * b.z;
          if (u > HALF_LENGTH && u < HALF_LENGTH + 2 && az > GOAL_HALF_WIDTH && az < GOAL_HALF_WIDTH + 0.3 && w.prevVz < 0 && side * b.vz > 0) w.hit = true;
          w.prevVz = side * b.vz;
        };
        for (const ox of [44, 48, 51, 52.3]) {
          for (const oz of [8, 14, 22]) {
            for (const v of [6, 15, 25, 36, 40]) {
              // Aim behind the line just outside the far edge of the post, along the side netting.
              for (const aimU of [52.8, 53.4, 54.2]) {
                for (const aimZ of [3.85, 4.1, 4.6]) {
                  for (const ty of [0.3, 1.2, 2.2]) {
                    const s = withBall(shot([end * ox, R, side * oz], [end * aimU, ty, side * aimZ], v));
                    w.prevVz = 0;
                    w.hit = false;
                    const r = run(s, 120, end, watch);
                    if (w.hit) deflected++;
                    const tag = `end ${end} side ${side} o (${ox}, ${oz}) v ${v} aim (${aimU}, ${ty}, ${aimZ})`;
                    checkConsistent(r, end, tag, fails);
                    if (r.first === CrossKind.GOAL) fails.push(`${tag}: GOAL through the side netting`);
                    if (r.netTick >= 0) fails.push(`${tag}: ended up in the net`);
                    if (r.first === CrossKind.GOAL_LINE) outs++;
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(fails.slice(0, 10)).toEqual([]);
    expect(outs).toBeGreaterThan(500);
    // Many of these really hit the outside of the side netting (and bounce off it).
    expect(deflected).toBeGreaterThan(100);
  });

  it('a ball dropping onto the roof of the net is out, never a goal', () => {
    for (const end of [1, -1]) {
      for (const vx of [0.5, 2, 5]) {
        for (const z of [-3, 0, 2.5]) {
          const s = withBall({ x: end * 52.1, y: 3.6, z, vx: end * vx, vy: 0, vz: 0 });
          const r = run(s, 240, end);
          expect(r.netTick, `vx ${vx} z ${z}`).toBe(-1);
          expect(r.first, `vx ${vx} z ${z}`).not.toBe(CrossKind.GOAL);
        }
      }
    }
  });

  it('grazing the post inside at speed is a goal (ball surface passes the inner face of the post)', () => {
    for (const end of [1, -1]) {
      for (const side of [1, -1]) {
        for (const v of [10, 25, 40]) {
          const z = side * (GOAL_HALF_WIDTH - R - 0.002);
          const s = withBall({ x: end * 45, y: 0.4, z, vx: end * v, vy: 0.5 * G * (7.5 / v), vz: 0 });
          const r = run(s, 90, end);
          expect([r.first, r.crossings, r.netEnd], `end ${end} side ${side} v ${v}`).toEqual([CrossKind.GOAL, 1, end]);
        }
      }
    }
  });

  it('regression "goal not given when the ball crosses and bounces out": bar-down and back-spin bounces still count', () => {
    let goals = 0;
    for (const end of [1, -1]) {
      // Shots at the underside of the bar (dropping in or bouncing out) and back-spun balls bouncing on the line.
      for (let ty = 2.1; ty <= 2.6; ty += 0.02) {
        for (const v of [15, 25, 36]) {
          const fails: string[] = [];
          const s = withBall(shot([end * (HALF_LENGTH - 11), R, 0.5], [end * HALF_LENGTH, ty, 0.5], v));
          const r = run(s, 150, end);
          checkConsistent(r, end, `bar ty ${ty.toFixed(2)} v ${v}`, fails);
          expect(fails).toEqual([]);
          if (r.first === CrossKind.GOAL) goals++;
        }
      }
      for (const sz of [-60, -30, 0]) {
        for (const vx of [3, 6, 9]) {
          const fails: string[] = [];
          const s = withBall({ x: end * 51.4, y: 1.6, z: -1, vx: end * vx, vy: 1, vz: 0, sz: end * sz });
          const r = run(s, 150, end);
          checkConsistent(r, end, `spin ${sz} vx ${vx}`, fails);
          expect(fails).toEqual([]);
          if (r.first === CrossKind.GOAL) goals++;
        }
      }
    }
    expect(goals).toBeGreaterThan(10);
  });

  it('regression "goal counted twice": a ball in the net never records another crossing (10 s in the net)', () => {
    for (const end of [1, -1]) {
      for (const v of [5, 20, 40]) {
        const s = withBall(shot([end * 45, R, 0], [end * HALF_LENGTH, 1, 0], v));
        const r = run(s, 600, end);
        expect([r.first, r.crossings, r.netEnd], `end ${end} v ${v}`).toEqual([CrossKind.GOAL, 1, end]);
      }
    }
  });

  it('regression "goal counted twice": a ball in the net knocked back against the front wall (held at exactly u = BALL_OUT_X) and back in', () => {
    for (const end of [1, -1]) {
      const s = withBall(shot([end * 45, R, 0.5], [end * HALF_LENGTH, 0.8, 0.5], 25));
      const first = run(s, 60, end);
      expect([first.first, first.netEnd]).toEqual([CrossKind.GOAL, end]);
      let minU = 1e9;
      for (let k = 0; k < 20; k++) {
        // Thrown back toward the field (as off the back netting): the in-net front wall stops it at u = BALL_OUT_X
        // mid-tick and the next substep starts there, moving back in.
        s.ball.vx = -end * (4 + k);
        s.ball.vy = 1;
        const r = run(s, 30, end, (b) => { minU = Math.min(minU, end * b.x); });
        expect([r.first, r.crossings, s.ball.inNet], `knock ${k}`).toEqual([CrossKind.NONE, 0, end]);
      }
      expect(minU).toBeLessThan(BALL_OUT_X + 0.1);
    }
  });

  it('regression "ball resting on the goal line": a ball on the line (even partly over it) is never out', () => {
    for (const end of [1, -1]) {
      for (const u of [HALF_LENGTH - R, HALF_LENGTH, HALF_LENGTH + 0.05, BALL_OUT_X]) {
        for (const z of [0, 3, -10]) {
          const s = withBall({ x: end * u, y: R, z, vx: 0, vy: 0, vz: 0 });
          const r = run(s, 600, end);
          expect([r.first, r.netTick], `u ${u} z ${z}`).toEqual([CrossKind.NONE, -1]);
        }
      }
    }
  });

  it('slow balls rolling onto the line: a crossing exactly when the whole ball ends up over it', () => {
    let over = 0;
    let short = 0;
    for (const end of [1, -1]) {
      for (const z of [0, 2, -12]) {
        for (let v = 0.2; v <= 3; v += 0.1) {
          const s = withBall({ x: end * 52.0, y: R, z, vx: end * v, vy: 0, vz: 0 });
          const r = run(s, 600, end);
          const expected = r.maxU > BALL_OUT_X ? (Math.abs(z) < GOAL_HALF_WIDTH ? CrossKind.GOAL : CrossKind.GOAL_LINE) : CrossKind.NONE;
          expect(r.first, `z ${z} v ${v.toFixed(1)} maxU ${r.maxU}`).toBe(expected);
          if (expected === CrossKind.NONE) short++;
          else over++;
        }
      }
    }
    expect(over).toBeGreaterThan(10);
    expect(short).toBeGreaterThan(10);
  });

  it('a ball bouncing on the line (partly over, never wholly) stays in play', () => {
    for (const end of [1, -1]) {
      for (const z of [0, 2, -12]) {
        // (Above the bar inside the mouth, 3 m would land on the roof of the net: covered by the roof test.)
        for (const h of Math.abs(z) < GOAL_HALF_WIDTH ? [0.5, 1.5, 2.2] : [0.5, 1.5, 3]) {
          // Dropped onto the line itself with no forward speed: bounces in place, centre 5 cm over the line.
          const s = withBall({ x: end * (HALF_LENGTH + 0.05), y: h, z, vx: 0, vy: 0, vz: 0 });
          const r = run(s, 300, end);
          expect([r.first, r.netTick], `z ${z} h ${h}`).toEqual([CrossKind.NONE, -1]);
        }
      }
    }
  });

  it('crossing detection is deterministic: the same shots give bit-identical crossings', () => {
    const sig = (): number[] => {
      const out: number[] = [];
      for (let k = 0; k < 60; k++) {
        const s = withBall(shot([45, R, -6 + k * 0.2], [HALF_LENGTH, 0.2 + (k % 13) * 0.2, -4 + k * 0.13], 20 + (k % 5) * 4, k % 7));
        const b = s.ball;
        for (let i = 0; i < 90; i++) {
          s.tick++; EV.begin(s.tick); b.cross = CrossKind.NONE;
          ballTick(s, EV);
          if (b.cross !== CrossKind.NONE) out.push(k, i, b.cross, b.crossX, b.crossZ, b.crossEnd);
        }
      }
      return out;
    };
    const a = sig();
    expect(sig()).toEqual(a);
    expect(a.length).toBeGreaterThan(60);
  });
});

describe('SIM-03 through the full step() pipeline', () => {
  /** Everyone far from the ball (own half of the defending team stays empty), ball free. */
  function farPlayers(): { slot: number; x: number; z: number; vx: number; vz: number }[] {
    const ps: { slot: number; x: number; z: number; vx: number; vz: number }[] = [];
    for (let i = 0; i < NUM_SLOTS; i++) ps.push({ slot: i, x: -45 + (i % 11) * 3, z: i < 11 ? -25 : 25, vx: 0, vz: 0 });
    return ps;
  }

  it('a 36 m/s shot into the goal scores exactly one goal (no second goal while the ball sits in the net)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, players: farPlayers(), ball: shot([42, R, 1], [HALF_LENGTH, 0.8, 1.5], 36) });
    s.ball.grounded = 0;
    s.ball.lastTouch = 9; s.ball.lastTouchTeam = 0; s.ball.lastTouchTick = s.tick;
    const goalsBefore = s.teams[0]!.goals + s.teams[1]!.goals;
    const ev = runTicks(s, 240);
    const goals = findEvents(ev, EventType.GOAL);
    expect(goals).toHaveLength(1);
    expect(s.teams[0]!.goals + s.teams[1]!.goals).toBe(goalsBefore + 1);
    expect(findEvents(ev, EventType.RESTART_AWARDED, (e) => e.a === RestartKind.GOAL_KICK || e.a === RestartKind.CORNER)).toHaveLength(0);
  });

  it('a shot into the outside of the side netting gives a goal kick or corner, never a goal', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, players: farPlayers(), ball: shot([49, R, 14], [53.6, 0.9, 4.1], 25) });
    s.ball.grounded = 0;
    s.ball.lastTouch = 9; s.ball.lastTouchTeam = 0; s.ball.lastTouchTick = s.tick;
    const ev = runTicks(s, 120);
    expect(findEvents(ev, EventType.GOAL)).toHaveLength(0);
    const out = findEvents(ev, EventType.RESTART_AWARDED);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect([RestartKind.GOAL_KICK, RestartKind.CORNER]).toContain(out[0]!.a);
    expect(s.ball.inNet).toBe(0);
  });

  it('a ball out over the touchline gives a throw-in at the crossing point', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, players: farPlayers(), ball: { x: 10, y: R, z: 30, vx: 2, vy: 0, vz: 12 } });
    s.ball.lastTouch = 4; s.ball.lastTouchTeam = 0; s.ball.lastTouchTick = s.tick;
    const ev = runTicks(s, 60, undefined, { until: (st) => st.match.phase !== MatchPhase.IN_PLAY });
    const out = findEvents(ev, EventType.RESTART_AWARDED);
    expect(out).toHaveLength(1);
    expect(out[0]!.a).toBe(RestartKind.THROW_IN);
    expect(out[0]!.b).toBe(1);
    // Crossed z = 34.11 about (34.11 - 30) / 12 s later, x moving at ~2 m/s.
    expect(Math.abs(out[0]!.x - (10 + 2 * (4.11 / 12)))).toBeLessThan(0.15);
    expect(DT).toBeGreaterThan(0);
  });

  it('GOAL_HEIGHT and GOAL_HALF_WIDTH bound the mouth used by the pipeline (sanity)', () => {
    expect(GOAL_HEIGHT).toBe(2.44);
    expect(GOAL_HALF_WIDTH).toBeCloseTo(3.66, 12);
  });
});
