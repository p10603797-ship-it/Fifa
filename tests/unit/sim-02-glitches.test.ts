/**
 * SIM-02 regression tests named after the BRIEF section 14 glitch list lines SIM-02 owns:
 *  - Ball stuck: on the roof of the net, behind the goal, wedged against a post or board, resting on the goal line.
 *  - Goals: counted twice (NET once), given through the side netting (see also sim-02-net), not given when the ball
 *    crosses and bounces out (the whole-ball crossing is kept in the net).
 */
import { describe, expect, it } from 'vitest';
import { BOARD_X, BOARD_Z, WORLD_MAX_X, WORLD_MAX_Z, WORLD_MIN_X, WORLD_MIN_Z } from '../../src/contracts/constants';
import { EventType } from '../../src/contracts/events';
import { BALL_CONTACT_TUNING } from '../../src/sim/ball/contact';
import { FR_R, FR_U, FR_Y, FR_Z, GB, GH, GL, GW, R, allFinite, ball, frameDist, inNetBox, ofType, runBall, speed } from './sim-02-helpers';

const BH = BALL_CONTACT_TUNING.boardHeight;
const SLOP = BALL_CONTACT_TUNING.touchSlop;

/** Ticks until the ball is fully at rest (speed 0 on the grass), or -1. */
function ticksToRest(b: ReturnType<typeof ball>, max: number): number {
  for (let t = 1; t <= max; t++) {
    runBall(b, 1);
    if (speed(b) === 0 && b.y === R) return t;
  }
  return -1;
}

describe('Glitch: Ball stuck on the roof of the net', () => {
  it('a ball dropped on the roof (anywhere, any small speed) rolls off within 3 s and never rests on it', () => {
    let runs = 0;
    for (const end of [-1, 1]) {
      for (let iu = 0; iu <= 8; iu++) {
        for (let iz = -6; iz <= 6; iz++) {
          const u = GL + 0.02 + (iu / 8) * (GB - GL - 0.04);
          const z = (iz / 6) * (GW - 0.02);
          for (const [vu, vz] of [[0, 0], [-0.4, 0], [0.2, -0.3], [-1, 0.5]] as [number, number][]) {
            const b = ball({ x: end * u, y: GH + R + 0.3, z, vx: end * vu, vz });
            runs++;
            let onRoof = 0;
            runBall(b, 180, (_i, bb) => {
              if (bb.y > GH && end * bb.x > GL && end * bb.x < GB && Math.abs(bb.z) < GW) onRoof++;
            });
            // Off the roof within 3 s, on the grass, outside the net, never inside it.
            expect(onRoof).toBeLessThan(180);
            expect(b.y).toBeLessThan(GH);
            expect(inNetBox(end, b.x, b.y, b.z)).toBe(false);
            expect(b.inNet).toBe(0);
            expect(allFinite(b)).toBe(true);
          }
        }
      }
    }
    expect(runs).toBe(2 * 9 * 13 * 4);
  });

  it('a ball placed at rest exactly on the roof centre rolls off the back (never toward the field)', () => {
    for (const end of [-1, 1]) {
      const b = ball({ x: end * (GL + 1), y: GH + R, z: 0, grounded: 0 });
      runBall(b, 240);
      expect(end * b.x).toBeGreaterThan(GB);
      expect(b.y).toBe(R);
    }
  });

  it('a ball balanced exactly on the crossbar is not left there', () => {
    for (const end of [-1, 1]) {
      const b = ball({ x: end * FR_U, y: FR_Y + FR_R, z: 1, grounded: 0 });
      runBall(b, 900);
      expect(b.y).toBe(R);
      expect(end * b.x).toBeGreaterThan(GL); // dropped behind (onto the roof, then off the back)
      expect(frameDist(end * b.x, b.y, b.z)).toBeGreaterThan(FR_R + SLOP);
    }
  });
});

describe('Glitch: Ball stuck wedged against a post or board', () => {
  it('a ball at rest touching a post (any side, both ends) is nudged off and comes to rest clear of it', () => {
    for (const end of [-1, 1]) {
      for (const side of [-1, 1]) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * 2 * Math.PI;
          const u = FR_U + Math.cos(a) * FR_R;
          const z = side * FR_Z + Math.sin(a) * FR_R;
          const b = ball({ x: end * u, y: R, z });
          const rest = ticksToRest(b, 600);
          expect(rest).toBeGreaterThan(0);
          expect(frameDist(end * b.x, b.y, b.z)).toBeGreaterThan(FR_R + SLOP);
          expect(allFinite(b)).toBe(true);
        }
      }
    }
  });

  it('a ball wedged in the outside corner between a post and the side netting gets out', () => {
    for (const end of [-1, 1]) {
      for (const side of [-1, 1]) {
        const b = ball({ x: end * (GL + 0.04), y: R, z: side * (GW + R) });
        const rest = ticksToRest(b, 600);
        expect(rest).toBeGreaterThan(0);
        expect(frameDist(end * b.x, b.y, b.z)).toBeGreaterThan(FR_R + SLOP);
        expect(inNetBox(end, b.x, b.y, b.z)).toBe(false);
      }
    }
  });

  it('a ball rolling slowly along the goal line into a post does not stick to it', () => {
    for (const end of [-1, 1]) {
      for (const side of [-1, 1]) {
        const b = ball({ x: end * GL, y: R, z: side * 2.5, vz: side * 1.6 });
        const rest = ticksToRest(b, 600);
        expect(rest).toBeGreaterThan(0);
        expect(frameDist(end * b.x, b.y, b.z)).toBeGreaterThan(FR_R + SLOP);
      }
    }
  });

  it('a ball at rest touching an advertising board (sides, ends, corners, on top) is nudged off it', () => {
    const cases: [number, number, number][] = [
      [BOARD_X - R, R, 10], [-BOARD_X + R, R, -20], [30, R, BOARD_Z - R], [-12, R, -BOARD_Z + R],
      [BOARD_X - R, R, BOARD_Z - R], [-BOARD_X + R, R, -BOARD_Z + R], // inside corners
      [BOARD_X + R, R, 5], [7, R, -BOARD_Z - R], // behind the boards
      [BOARD_X, BH + R, 3], [-20, BH + R, BOARD_Z], // balanced on top
    ];
    for (const [x, y, z] of cases) {
      const b = ball({ x, y, z, grounded: y > R ? 0 : 1 });
      const rest = ticksToRest(b, 600);
      expect(rest).toBeGreaterThan(0);
      const dx = BOARD_X - Math.abs(b.x);
      const dz = BOARD_Z - Math.abs(b.z);
      // Clear of both boards (centre further than the radius + slop from each board plane).
      expect(Math.abs(dx)).toBeGreaterThan(R + SLOP);
      expect(Math.abs(dz)).toBeGreaterThan(R + SLOP);
      expect(allFinite(b)).toBe(true);
    }
  });

  it('a hard shot into the boards bounces back (boardRestitution, BOUNCE event) and never passes them', () => {
    const b = ball({ x: 40, y: 0.5, z: 10, vx: 36, vy: 1 });
    let maxX = -Infinity;
    const { events } = runBall(b, 120, (_i, bb) => { maxX = Math.max(maxX, bb.x); });
    expect(maxX).toBeLessThanOrEqual(BOARD_X - R + 1e-9);
    expect(b.vx).toBeLessThanOrEqual(0);
    expect(ofType(events, EventType.BOUNCE).some((e) => e.x === BOARD_X - R)).toBe(true);
  });

  it('a ball cleared over the boards stays inside the world (stand walls) and comes to rest', () => {
    for (const [vx, vz] of [[30, 0], [-30, 5], [5, 30], [-8, -32], [25, 25]] as [number, number][]) {
      const b = ball({ x: 0, y: R, z: 0, vx, vy: 18, vz });
      let ok = true;
      runBall(b, 900, (_i, bb) => {
        if (bb.x < WORLD_MIN_X || bb.x > WORLD_MAX_X || bb.z < WORLD_MIN_Z || bb.z > WORLD_MAX_Z) ok = false;
      });
      expect(ok).toBe(true);
      expect(speed(b)).toBe(0);
      expect(allFinite(b)).toBe(true);
    }
  });
});

describe('Glitch: Ball stuck resting on the goal line', () => {
  it('a ball at rest on the goal line between the posts stays exactly put: no jitter, no events, not in the net', () => {
    for (const end of [-1, 1]) {
      for (const du of [-R, -0.05, 0, 0.05, R - 0.001]) {
        for (const z of [-3.3, -1, 0, 2, 3.3]) {
          const b = ball({ x: end * (GL + du), y: R, z });
          const x = b.x;
          const { events } = runBall(b, 300);
          expect(b.x).toBe(x);
          expect(b.z).toBe(z);
          expect(b.y).toBe(R);
          expect(b.inNet).toBe(0);
          expect(events).toHaveLength(0);
        }
      }
    }
  });

  it('a ball rolling slowly onto the goal line stops there without being pulled in or pushed out', () => {
    for (const end of [-1, 1]) {
      const b = ball({ x: end * (GL - 1), z: 1, vx: end * 2.2 });
      runBall(b, 300);
      expect(speed(b)).toBe(0);
      expect(end * b.x).toBeGreaterThan(GL - 0.2);
      expect(end * b.x).toBeLessThan(GL + R);
      expect(b.inNet).toBe(0);
      // It can be played away again.
      b.vx = -end * 6;
      runBall(b, 30);
      expect(end * b.x).toBeLessThan(GL - 1.5);
    }
  });
});

describe('Glitch: Ball stuck behind the goal', () => {
  it('a ball loose behind the goal (between net and boards) comes to rest outside the net, never inside it', () => {
    let runs = 0;
    for (const end of [-1, 1]) {
      for (let k = 0; k < 60; k++) {
        const u = GL + 0.2 + ((k * 0.53) % (BOARD_X - GL - 0.4));
        const z = -9 + ((k * 1.7) % 18);
        const sp = 2 + (k % 9) * 3;
        const a = (k * 0.7) % (2 * Math.PI);
        if (inNetBox(end, end * u, R, z)) continue;
        const b = ball({ x: end * u, y: R + (k % 3) * 0.8, z, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp });
        if (inNetBox(end, b.x, b.y, b.z)) continue;
        runs++;
        let inside = 0;
        runBall(b, 900, (_i, bb) => { if (inNetBox(end, bb.x, bb.y, bb.z)) inside++; });
        expect(inside).toBe(0);
        expect(speed(b)).toBe(0);
        expect(b.y).toBe(R);
        expect(allFinite(b)).toBe(true);
      }
    }
    expect(runs).toBeGreaterThan(80);
  });
});

describe('Glitch: Goals counted twice / not given when the ball crosses and bounces out', () => {
  it('a shot off the underside of the bar that drops wholly over the line is held in the net (NET once)', () => {
    let overAndHeld = 0;
    let backOut = 0;
    for (const end of [-1, 1]) {
      for (let vy = 5; vy <= 8.5; vy += 0.02) {
        // Rising shot from 6 m that meets the bar somewhere between its underside and its face.
        const b = ball({ x: end * (GL - 6), y: 1.2, z: 0.4, vx: end * 30, vy });
        let over = -1;
        let backAfterOver = 0;
        const { events } = runBall(b, 300, (i, bb) => {
          const u = end * bb.x;
          if (over < 0 && u > GL + R && inNetBox(end, bb.x, bb.y, bb.z)) over = i;
          if (over >= 0 && u < GL + R - 1e-9) backAfterOver++;
        });
        const bar = ofType(events, EventType.POST).filter((e) => e.b === 1);
        if (bar.length === 0) continue;
        expect(bar[0]!.a).toBe(end);
        if (over >= 0) {
          overAndHeld++;
          expect(backAfterOver).toBe(0);
          expect(b.inNet).toBe(end);
          expect(ofType(events, EventType.NET)).toHaveLength(1);
        } else {
          backOut++;
          expect(b.inNet).toBe(0);
          expect(ofType(events, EventType.NET)).toHaveLength(0);
        }
      }
    }
    expect(overAndHeld).toBeGreaterThanOrEqual(4);
    expect(backOut).toBeGreaterThanOrEqual(4);
  });

  it('a ball in the net hit hard again (scramble) still never comes back out over the line', () => {
    const b = ball({ x: 45, y: 0.5, z: 0, vx: 30, vy: 1 });
    runBall(b, 120);
    expect(b.inNet).toBe(1);
    for (const [vx, vy, vz] of [[-30, 2, 0], [-20, 8, 5], [-35, 0, -10]] as [number, number, number][]) {
      b.vx = vx; b.vy = vy; b.vz = vz;
      const { events } = runBall(b, 120, (_i, bb) => {
        expect(bb.x).toBeGreaterThanOrEqual(GL + R - 1e-9);
      });
      expect(b.inNet).toBe(1);
      expect(ofType(events, EventType.NET)).toHaveLength(0);
    }
  });
});
