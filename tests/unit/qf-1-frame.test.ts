/**
 * [QF-1] QA-03 posts, bar and net at every speed up to the clamp (40 m/s), from every direction: the ball never
 * tunnels through a post, the bar or a net sheet, never ends inside the frame, and SIM-03 only ever reports GOAL for a
 * path that went in through the goal mouth. Randomised (seeded) shots at the frame of both goals, stepped with SIM-02
 * ballTick (sub-stepped physics + swept line crossing) exactly as the pipeline does.
 */
import { describe, expect, it } from 'vitest';
import {
  BALL_RADIUS, GOAL_DEPTH, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, POST_RADIUS,
} from '../../src/contracts/constants';
import { CrossKind, MatchPhase } from '../../src/contracts/enums';
import { createEventBuffer } from '../../src/sim/core/events';
import { ballTick } from '../../src/sim/ball/contact';
import { makeScenario } from '../harness/scenario';

const R = BALL_RADIUS;
const GL = HALF_LENGTH;
const GB = HALF_LENGTH + GOAL_DEPTH;
const GW = GOAL_HALF_WIDTH;
const GH = GOAL_HEIGHT;
const FR_U = GL - POST_RADIUS;
const FR_Z = GW + POST_RADIUS;
const FR_Y = GH + POST_RADIUS;
const FR_R = R + POST_RADIUS;

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

/** Distance from the ball centre (u, y, z) to the frame (two posts + bar as capsules). */
function frameDist(u: number, y: number, z: number): number {
  let best = Infinity;
  for (const side of [-1, 1]) {
    const cy = Math.max(0, Math.min(FR_Y, y));
    best = Math.min(best, Math.hypot(u - FR_U, y - cy, z - side * FR_Z));
  }
  const cz = Math.max(-FR_Z, Math.min(FR_Z, z));
  return Math.min(best, Math.hypot(u - FR_U, y - FR_Y, z - cz));
}

/** Strictly inside the net box (end-relative u). */
function inBox(u: number, y: number, z: number): boolean {
  return u > GL && u < GB && y < GH && Math.abs(z) < GW;
}

describe('QF-1 QA-03 frame and net: no tunnelling, no goal from outside', { timeout: 600_000 }, () => {
  it('3000 random shots at 15-40 m/s at the posts, the bar, the joints, the side netting, the roof and the back of the net', () => {
    const rnd = lcg(4242);
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const ev = createEventBuffer();
    let goals = 0, frameHits = 0, netEntries = 0;
    for (let n = 0; n < 3000; n++) {
      const end = rnd() < 0.5 ? 1 : -1;
      // A target point on or near the frame / net, and a start 3-12 m away in a random direction around it.
      const kind = Math.floor(rnd() * 5);
      let tu: number, ty: number, tz: number;
      if (kind === 0) { tu = FR_U; tz = (rnd() < 0.5 ? -1 : 1) * FR_Z; ty = rnd() * FR_Y; } // a post
      else if (kind === 1) { tu = FR_U; ty = FR_Y; tz = (rnd() * 2 - 1) * FR_Z; } // the bar
      else if (kind === 2) { tu = GL + rnd() * GOAL_DEPTH; tz = (rnd() < 0.5 ? -1 : 1) * GW; ty = rnd() * GH; } // side netting
      else if (kind === 3) { tu = GL + rnd() * GOAL_DEPTH; ty = GH; tz = (rnd() * 2 - 1) * GW; } // roof
      else { tu = GB; ty = rnd() * GH; tz = (rnd() * 2 - 1) * GW; } // back of the net
      const dist = 3 + rnd() * 9;
      const az = rnd() * 2 * Math.PI;
      const el = (rnd() - 0.3) * 0.9;
      let su = tu - Math.cos(az) * Math.cos(el) * dist;
      let sy = ty - Math.sin(el) * dist;
      const sz = tz - Math.sin(az) * Math.cos(el) * dist;
      if (sy < R) sy = R;
      if (sy > 12) sy = 12;
      // Never start inside the net box or the frame.
      if (inBox(su, sy, sz) || frameDist(su, sy, sz) < FR_R + 0.05) { su = GL - 4; }
      const speed = 15 + rnd() * 25;
      const dx = tu - su, dy = ty - sy, dz = tz - sz;
      const dl = Math.hypot(dx, dy, dz);
      const b = s.ball;
      b.x = end * su; b.y = sy; b.z = sz; b.px = b.x; b.py = b.y; b.pz = b.z;
      b.vx = end * dx / dl * speed; b.vy = dy / dl * speed; b.vz = dz / dl * speed;
      b.sx = 0; b.sy = (rnd() - 0.5) * 20; b.sz = 0;
      b.grounded = 0; b.inNet = 0; b.owner = -1; b.heldBy = -1; b.bounces = 0;
      // Did the straight path cross the goal-mouth plane inside the mouth (before anything could bend it)?
      const startedInFront = su <= GL;
      let enteredOther = false;
      let sawGoal = false;
      let minFrame = Infinity;
      let prevIn = inBox(su, sy, sz);
      for (let t = 0; t < 90; t++) {
        s.tick++;
        ev.begin(s.tick);
        b.cross = CrossKind.NONE;
        const pu = end * b.x, py = b.y, pz = b.z;
        ballTick(s, ev);
        const u = end * b.x;
        minFrame = Math.min(minFrame, frameDist(u, b.y, b.z));
        const nowIn = inBox(u, b.y, b.z);
        if (nowIn && !prevIn) {
          netEntries++;
          // Entering the box is only legal through the goal mouth: the previous centre in front of the goal line, and
          // the crossing point inside the mouth.
          const tt = pu < GL ? (GL - pu) / (u - pu) : -1;
          const zc = pz + (b.z - pz) * tt, yc = py + (b.y - py) * tt;
          if (!(tt >= 0 && tt <= 1 && Math.abs(zc) < GW && yc < GH)) enteredOther = true;
        }
        if (prevIn && !nowIn && u > GL) enteredOther = true; // left through a sheet (not back out of the mouth)
        prevIn = nowIn;
        const cross = b.cross as CrossKind; // ballTick sets it
        if (cross === CrossKind.GOAL) { sawGoal = true; goals++; }
        if (cross !== CrossKind.NONE && cross !== CrossKind.GOAL) break;
      }
      if (minFrame < FR_R + 0.01) frameHits++;
      expect(enteredOther, `shot ${n} kind ${kind}`).toBe(false);
      // Never inside a post or the bar (a little numerical slack for the push-out).
      expect(minFrame, `shot ${n} kind ${kind}`).toBeGreaterThan(FR_R - 1e-6);
      // A GOAL only for a ball that started in front of the line (from behind the goal or over it: impossible).
      if (sawGoal) expect(startedInFront, `shot ${n}`).toBe(true);
    }
    expect(goals).toBeGreaterThan(50);
    expect(frameHits).toBeGreaterThan(60);
    expect(netEntries).toBeGreaterThan(50);
  });
});
