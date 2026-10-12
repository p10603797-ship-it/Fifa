/**
 * SIM-02 ball contact: posts and crossbar as rigid cylinders (sphere-vs-capsule, swept time of impact + discrete
 * push-out). "Posts/bar deflect at 36 m/s without tunnelling (sweep many angles/speeds)", POST events.
 */
import { describe, expect, it } from 'vitest';
import { DT, HALF_LENGTH } from '../../src/contracts/constants';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { T_BALL } from '../../src/contracts/tuning';
import type { BallState } from '../../src/contracts/state';
import { ballPhysicsStep, ballStepTick, ballSubsteps } from '../../src/sim/ball/contact';
import { createEventBuffer } from '../../src/sim/core/events';
import {
  FR_R, FR_U, FR_Y, FR_Z, R, allFinite, ball, frameDist, ofType, runBall, segFrameDist, speed,
} from './sim-02-helpers';

const G = T_BALL.gravity;
const ev = createEventBuffer();

interface ShotResult {
  /** Smallest frame-axis distance of any substep segment (swept). */
  minSwept: number;
  /** Smallest frame-axis distance at any substep end. */
  minEnd: number;
  posts: SimEvent[];
  finite: boolean;
  b: BallState;
}

/**
 * Fire a ball from `start` (world) with velocity v and run `ticks` ticks substep by substep (exactly the
 * ballStepTick sequence), checking the frame clearance after every substep.
 */
function shoot(end: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, ticks: number): ShotResult {
  const b = ball({ x, y, z, vx, vy, vz, grounded: y > R ? 0 : 1 });
  let minSwept = Infinity;
  let minEnd = Infinity;
  const posts: SimEvent[] = [];
  let finite = true;
  let dist = Infinity;
  for (let t = 0; t < ticks; t++) {
    ev.begin(t + 1);
    const n = ballSubsteps(b);
    for (let i = 0; i < n; i++) {
      const u0 = end * b.x;
      const y0 = b.y;
      const z0 = b.z;
      ballPhysicsStep(b, DT / n, ev);
      const u1 = end * b.x;
      const d1 = frameDist(u1, b.y, b.z);
      minEnd = Math.min(minEnd, d1);
      // A substep moves <= ~0.09 m: only a segment ending near the frame can come within FR_R of it.
      if (d1 < FR_R + 0.12) minSwept = Math.min(minSwept, segFrameDist(u0, y0, z0, u1, b.y, b.z, 16));
      dist = d1;
    }
    for (const e of ofType(ev.toArray(), EventType.POST)) posts.push(e);
    if (!allFinite(b)) finite = false;
    if (t > 3 && dist > 2.7) break; // gone past or bounced away
  }
  return { minSwept, minEnd, posts, finite, b };
}

describe('SIM-02 posts and crossbar', () => {
  it('posts deflect at up to 40 m/s without tunnelling (sweep of angles, speeds, offsets, both ends)', () => {
    let runs = 0;
    let hits = 0;
    for (const end of [-1, 1]) {
      for (const side of [-1, 1]) {
        for (const sp of [8, 15, 25, 36, 40]) {
          for (let deg = -60; deg <= 60; deg += 10) {
            const th = (deg * Math.PI) / 180;
            const du = Math.cos(th);
            const dz = Math.sin(th);
            for (let off = -0.25; off <= 0.2501; off += 0.025) {
              // Aim at the post axis (+ lateral offset) at mid height; start 2.5 m back along the line.
              const au = FR_U;
              const az = side * FR_Z + off;
              const d = 2.5;
              const T = d / sp;
              const y = 1.0;
              const res = shoot(end, end * (au - du * d), y, az - dz * d, end * du * sp, (G * T) / 2, dz * sp, 30);
              runs++;
              expect(res.finite).toBe(true);
              expect(res.minEnd).toBeGreaterThanOrEqual(FR_R - 1e-9);
              expect(res.minSwept).toBeGreaterThan(FR_R - 3e-3);
              const perp = Math.abs(off * Math.cos(th));
              if (perp < 0.8 * FR_R) {
                hits++;
                expect(res.posts.length).toBeGreaterThanOrEqual(1);
                const p = res.posts[0]!;
                expect(p.a).toBe(end);
                expect(p.b).toBe(0);
                expect(p.c).toBeGreaterThan(1);
              }
              if (perp > FR_R + 0.03) expect(res.posts).toHaveLength(0);
            }
          }
        }
      }
    }
    expect(runs).toBeGreaterThan(4000);
    expect(hits).toBeGreaterThan(1000);
  });

  it('the crossbar deflects at up to 40 m/s without tunnelling (sweep of heights, elevations, both ends)', () => {
    let hits = 0;
    for (const end of [-1, 1]) {
      for (const sp of [10, 20, 30, 36, 40]) {
        for (let deg = -40; deg <= 40; deg += 8) {
          const el = (deg * Math.PI) / 180;
          for (const az of [-3, -1.2, 0, 2.1]) {
            for (let off = -0.25; off <= 0.2501; off += 0.025) {
              const d = 2.5;
              const du = Math.cos(el);
              const dy = Math.sin(el);
              const ay = FR_Y + off;
              const T = d / sp;
              // Compensate gravity so the ball arrives at the aim point roughly on the straight line.
              const res = shoot(end, end * (FR_U - du * d), ay - dy * d - (G * T * T) / 2 + (G * T * T) / 2, az,
                end * du * sp, dy * sp + (G * T) / 2, 0, 30);
              expect(res.finite).toBe(true);
              expect(res.minEnd).toBeGreaterThanOrEqual(FR_R - 1e-9);
              expect(res.minSwept).toBeGreaterThan(FR_R - 3e-3);
              const perp = Math.abs(off * Math.cos(el));
              if (perp < 0.8 * FR_R) {
                hits++;
                expect(res.posts.length).toBeGreaterThanOrEqual(1);
                expect(res.posts[0]!.a).toBe(end);
                expect(res.posts[0]!.b).toBe(1);
              }
            }
          }
        }
      }
    }
    expect(hits).toBeGreaterThan(500);
  });

  it('the top corners (post meets bar) deflect without tunnelling', () => {
    for (const end of [-1, 1]) {
      for (const side of [-1, 1]) {
        for (let k = 0; k < 60; k++) {
          const th = ((k * 7) % 120 - 60) * (Math.PI / 180);
          const el = ((k * 13) % 60 - 30) * (Math.PI / 180);
          const sp = 12 + ((k * 5) % 29);
          const du = Math.cos(el) * Math.cos(th);
          const dz = Math.cos(el) * Math.sin(th);
          const dy = Math.sin(el);
          const d = 2.5;
          const T = d / sp;
          const res = shoot(end, end * (FR_U - du * d), FR_Y - dy * d, side * FR_Z - dz * d,
            end * du * sp, dy * sp + (G * T) / 2, dz * sp, 30);
          expect(res.finite).toBe(true);
          expect(res.minEnd).toBeGreaterThanOrEqual(FR_R - 1e-9);
          expect(res.minSwept).toBeGreaterThan(FR_R - 3e-3);
          expect(res.posts.length).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('head-on post hit reflects with postRestitution and emits POST(a = end, b = 0, c = impact speed)', () => {
    for (const end of [-1, 1]) {
      const b = ball({ x: end * (HALF_LENGTH - 3), y: R, z: FR_Z, vx: end * 20 });
      const { events } = runBall(b, 20);
      const posts = ofType(events, EventType.POST);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.a).toBe(end);
      expect(posts[0]!.b).toBe(0);
      // Rolling 3 m at ~20 m/s loses ~1.2 m/s before the post.
      expect(posts[0]!.c).toBeGreaterThan(18);
      expect(posts[0]!.c).toBeLessThan(20);
      expect(Math.sign(b.vx)).toBe(-end);
      // Right after impact the ball moves back at about postRestitution * impact.
      const b2 = ball({ x: end * (FR_U - FR_R - 0.05), y: R, z: FR_Z, vx: end * 20 });
      ballStepTick(b2, null);
      expect(Math.abs(b2.vx)).toBeGreaterThan(20 * T_BALL.postRestitution * 0.95);
      expect(Math.abs(b2.vx)).toBeLessThan(20 * T_BALL.postRestitution * 1.01);
      expect(b2.vy).toBe(0); // a rolling ball stays on the grass
    }
  });

  it('a shot grazing the inside of the post goes in, one grazing the outside goes wide', () => {
    // Inside: centre passes just inside the clearance on the goal side -> deflected inward, crosses the line.
    const inside = ball({ x: 40, y: 1, z: FR_Z - FR_R + 0.02, vx: 30, vy: 2 });
    runBall(inside, 60);
    expect(inside.inNet).toBe(1);
    const wide = ball({ x: 40, y: 1, z: FR_Z + FR_R - 0.02, vx: 30, vy: 2 });
    runBall(wide, 60);
    expect(wide.inNet).toBe(0);
    expect(wide.z).toBeGreaterThan(FR_Z);
  });

  it('a ball dropping onto the bar from above bounces off and never balances on it', () => {
    for (const dz of [-1, 0, 2]) {
      const b = ball({ x: FR_U, y: FR_Y + 2, z: dz });
      const { events } = runBall(b, 600);
      const posts = ofType(events, EventType.POST);
      expect(posts.length).toBeGreaterThanOrEqual(1);
      expect(posts[0]!.b).toBe(1);
      expect(b.y).toBe(R); // ended on the grass, not on the bar
      expect(frameDist(b.x, b.y, b.z)).toBeGreaterThan(FR_R);
      expect(speed(b)).toBe(0);
    }
  });
});
