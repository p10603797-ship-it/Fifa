/**
 * SIM-02 ball contact: the net is a soft volume that absorbs and holds the ball (NET once, inNet); from outside
 * the side netting, roof and back deflect and never let it in (glitch list "Goals: given through the side netting").
 */
import { describe, expect, it } from 'vitest';
import { DT } from '../../src/contracts/constants';
import { EventType } from '../../src/contracts/events';
import { T_BALL } from '../../src/contracts/tuning';
import type { BallState } from '../../src/contracts/state';
import { KickKind, MatchPhase } from '../../src/contracts/enums';
import { createKickLaunch } from '../../src/contracts/systems';
import { ballPhysicsStep, ballStepTick, ballSubsteps } from '../../src/sim/ball/contact';
import { createEventBuffer } from '../../src/sim/core/events';
import { applyKick } from '../../src/sim/core/kick';
import { makeScenario } from '../harness/scenario';
import { GB, GH, GL, GW, R, allFinite, ball, inNetBox, ofType, runBall, speed } from './sim-02-helpers';

const G = T_BALL.gravity;
const ev = createEventBuffer();

/** Run ticks substep by substep (exactly the ballStepTick sequence), calling `check` after every substep. */
function runSubsteps(b: BallState, ticks: number, check: (b: BallState, u0: number, y0: number, z0: number) => void): number {
  let nets = 0;
  for (let t = 0; t < ticks; t++) {
    ev.begin(t + 1);
    const n = ballSubsteps(b);
    for (let i = 0; i < n; i++) {
      const x0 = b.x;
      const y0 = b.y;
      const z0 = b.z;
      ballPhysicsStep(b, DT / n, ev);
      check(b, x0, y0, z0);
    }
    nets += ofType(ev.toArray(), EventType.NET).length;
  }
  return nets;
}

describe('SIM-02 net: shots into the goal', () => {
  it('a shot into the net stays in, emits NET exactly once and comes to rest inside (sweep, both ends)', () => {
    let runs = 0;
    for (const end of [-1, 1]) {
      for (const sp of [10, 20, 30, 36, 40]) {
        for (let deg = -40; deg <= 40; deg += 10) {
          for (const tz of [-3.2, -1.5, 0, 1.5, 3.2]) {
            for (const ty of [0.3, 1.2, 2.1]) {
              const th = (deg * Math.PI) / 180;
              const d = 6;
              const T = d / sp;
              const x = end * (GL - Math.cos(th) * d);
              const z = tz - Math.sin(th) * d;
              const b = ball({ x, y: ty, z, vx: end * Math.cos(th) * sp, vy: (G * T) / 2, vz: Math.sin(th) * sp });
              let entered = -1;
              let escaped = 0;
              const { events } = runBall(b, 300, (i, bb) => {
                if (bb.inNet !== 0 && entered < 0) entered = i;
                // Once in, always in: whole ball behind the line, inside the box.
                if (entered >= 0 && (bb.inNet !== end || end * bb.x < GL + R - 1e-9 || !inNetBox(end, bb.x, bb.y, bb.z))) escaped++;
              });
              runs++;
              expect(escaped).toBe(0);
              expect(entered).toBeGreaterThanOrEqual(0);
              const nets = ofType(events, EventType.NET);
              expect(nets).toHaveLength(1);
              expect(nets[0]!.a).toBe(end);
              expect(nets[0]!.c).toBeGreaterThan(0);
              expect(allFinite(b)).toBe(true);
              expect(speed(b)).toBe(0);
              expect(b.y).toBe(R);
            }
          }
        }
      }
    }
    expect(runs).toBe(2 * 5 * 9 * 5 * 3);
  });

  it('the net absorbs: a 36 m/s shot is slow within a few ticks of entering and never rebounds hard', () => {
    const b = ball({ x: 45, y: 1, z: 0, vx: 36, vy: 0.5 });
    let entered = -1;
    let maxAfter = 0;
    runBall(b, 120, (i, bb) => {
      if (bb.inNet && entered < 0) entered = i;
      if (entered >= 0 && i >= entered + 8) maxAfter = Math.max(maxAfter, Math.hypot(bb.vx, bb.vz));
    });
    expect(entered).toBeGreaterThan(0);
    // Horizontal speed is absorbed (the ball may still drop and bounce on the grass inside the net).
    expect(maxAfter).toBeLessThan(1);
  });

  it('a ball that crosses only part of the line (not wholly over) is not in the net and can be played back', () => {
    // Rolls to rest with its centre just behind the line (u in (GL, GL + R)): not inNet, no NET, no hold.
    // Find a deterministic roll speed that stops with the centre 2..9 cm behind the line.
    let v = 3;
    for (; v < 3.4; v += 0.002) {
      const t = ball({ x: GL - 2, z: 0.5, vx: v });
      runBall(t, 240);
      if (t.x > GL + 0.02 && t.x < GL + R - 0.02) break;
    }
    const b = ball({ x: GL - 2, z: 0.5, vx: v });
    const { events } = runBall(b, 240);
    expect(b.x).toBeGreaterThan(GL);
    expect(b.x).toBeLessThan(GL + R);
    expect(b.inNet).toBe(0);
    expect(ofType(events, EventType.NET)).toHaveLength(0);
    b.vx = -5; // played back out
    runBall(b, 30);
    expect(b.x).toBeLessThan(GL - 1);
  });

  it('inNet clears when the ball is moved out of the net (restart) and a new entry emits NET again', () => {
    const b = ball({ x: 45, y: 1, z: 0, vx: 30, vy: 1 });
    let r = runBall(b, 120);
    expect(b.inNet).toBe(1);
    expect(ofType(r.events, EventType.NET)).toHaveLength(1);
    b.x = 0; b.y = R; b.z = 0; b.vx = 0; b.vy = 0; b.vz = 0; // kick-off spot
    ballStepTick(b, null);
    expect(b.inNet).toBe(0);
    expect(b.x).toBe(0);
    b.x = -45; b.y = 1; b.vx = -30; b.vy = 1;
    r = runBall(b, 120);
    expect(b.inNet).toBe(-1);
    const nets = ofType(r.events, EventType.NET);
    expect(nets).toHaveLength(1);
    expect(nets[0]!.a).toBe(-1);
  });
});

describe('SIM-02 net: kicked out of the net', () => {
  it('a kick from inside the net (applyKick clears inNet) lets the ball out without a second NET', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const b = s.ball;
    Object.assign(b, { x: 45, y: 1, z: 0, vx: 30, vy: 1, grounded: 0 });
    const ev = createEventBuffer();
    let nets = 0;
    for (let i = 0; i < 120; i++) {
      s.tick++; ev.begin(s.tick); ballStepTick(b, ev);
      nets += ofType(ev.toArray(), EventType.NET).length;
    }
    expect(b.inNet).toBe(1);
    expect(nets).toBe(1);
    // A player hacks it back out toward the field.
    const l = createKickLaunch();
    l.kind = KickKind.CLEARANCE; l.vx = -20; l.vy = 3; l.vz = 1; l.target = -1;
    s.tick++; ev.begin(s.tick);
    applyKick(s, 5, l, 1, ev);
    expect(b.inNet).toBe(0);
    for (let i = 0; i < 60; i++) {
      s.tick++; ev.begin(s.tick); ballStepTick(b, ev);
      nets += ofType(ev.toArray(), EventType.NET).length;
    }
    expect(nets).toBe(1);
    expect(b.inNet).toBe(0);
    expect(b.x).toBeLessThan(GL - 5);
  });
});

describe('SIM-02 net: from outside it deflects and never lets the ball in', () => {
  it('Goals: given through the side netting - side-netting shots from outside never enter (sweep)', () => {
    let runs = 0;
    let deflected = 0;
    let bad = 0;
    for (const end of [-1, 1]) {
      for (const side of [-1, 1]) {
        for (const sp of [5, 15, 25, 36, 40]) {
          for (let deg = -70; deg <= 70; deg += 10) {
            for (const tu of [GL + 0.02, GL + 0.3, GL + 1, GL + 1.7, GB - 0.02]) {
              for (const ty of [R, 0.8, 1.8, GH - 0.05]) {
                // Aim at the side sheet point (tu, ty, side * GW) from outside, travelling toward -side in z.
                const th = (deg * Math.PI) / 180;
                const dz = -side * Math.cos(th);
                const du = Math.sin(th);
                const d = 3;
                const T = d / sp;
                const b = ball({
                  x: end * (tu - du * d), y: ty, z: side * GW - dz * d,
                  vx: end * du * sp, vy: ty > R ? (G * T) / 2 : 0, vz: dz * sp,
                });
                if (inNetBox(end, b.x, b.y, b.z)) continue;
                runs++;
                const z0 = b.z;
                const nets = runSubsteps(b, 120, (bb) => {
                  if (inNetBox(end, bb.x, bb.y, bb.z) || bb.inNet !== 0) bad++;
                });
                if (nets !== 0 || !allFinite(b)) bad++;
                if (Math.sign(b.z - side * GW) === Math.sign(z0 - side * GW)) deflected++;
              }
            }
          }
        }
      }
    }
    expect(bad).toBe(0);
    expect(runs).toBeGreaterThan(2000);
    expect(deflected).toBeGreaterThan(runs * 0.5);
  });

  it('shots at the back of the net from behind and balls dropped on the roof never enter (sweep)', () => {
    let runs = 0;
    for (const end of [-1, 1]) {
      for (const sp of [5, 20, 36]) {
        for (let k = 0; k < 40; k++) {
          // From behind the goal toward the back sheet.
          const tz = -GW + 0.1 + ((k * 0.37) % (2 * GW - 0.2));
          const ty = R + ((k * 0.29) % (GH - R));
          const th = (((k * 11) % 120) - 60) * (Math.PI / 180);
          const b = ball({
            x: end * (GB + 3 * Math.cos(th)), y: ty, z: tz - 3 * Math.sin(th),
            vx: -end * sp * Math.cos(th), vy: 0.5, vz: sp * Math.sin(th),
          });
          runs++;
          let inside = 0;
          const nets = runSubsteps(b, 120, (bb) => { if (inNetBox(end, bb.x, bb.y, bb.z)) inside++; });
          expect(inside).toBe(0);
          expect(nets).toBe(0);
          expect(b.inNet).toBe(0);
          // Dropped / lobbed onto the roof.
          const c = ball({
            x: end * (GL + 0.05 + ((k * 0.13) % (GB - GL - 0.1))), y: GH + 1 + (k % 5), z: -GW + ((k * 0.61) % (2 * GW)),
            vx: end * (((k % 7) - 3) * sp) / 10, vy: -sp / 4, vz: (((k % 5) - 2) * sp) / 10,
          });
          if (end * c.x < GL) continue;
          runs++;
          let inside2 = 0;
          const n2 = runSubsteps(c, 240, (bb) => { if (inNetBox(end, bb.x, bb.y, bb.z)) inside2++; });
          expect(inside2).toBe(0);
          expect(n2).toBe(0);
          expect(c.inNet).toBe(0);
        }
      }
    }
    expect(runs).toBeGreaterThan(200);
  });

  it('the netting is a surface: the ball touches it but never overlaps it, from outside or inside', () => {
    for (const end of [-1, 1]) {
      // Outside: side (+z / -z), roof, back. Track the closest approach of the centre to each sheet plane.
      const out: [number, number, number, number, number, number, (b: BallState) => number][] = [
        [GL + 1, 1, GW + 2, 0, 0, -15, (b) => b.z - GW],
        [GL + 1, 1, -GW - 2, 0, 0, 15, (b) => -GW - b.z],
        [GL + 1, GH + 2, 0.5, 0, -2, 0, (b) => b.y - GH],
        [GB + 2, 1, 0.5, -15, 0.5, 0, (b) => end * b.x - GB],
      ];
      for (const [u, y, z, vu, vy, vz, gap] of out) {
        const b = ball({ x: end * u, y, z, vx: end * vu, vy, vz, grounded: 0 });
        let min = Infinity;
        runSubsteps(b, 40, (bb) => { min = Math.min(min, gap(bb)); });
        expect(min).toBeGreaterThanOrEqual(R - 1e-9);
        expect(min).toBeLessThan(R + 0.02); // it did reach the sheet
      }
      // Inside (in the net): side, roof, back.
      const ins: [number, number, number, number, number, number, (b: BallState) => number][] = [
        // Start 0.6 m from the sheet: the net damping (35% per tick) would stop a ball from much further away.
        [GL + 0.5, 1, GW - 0.6, 0, 0, 25, (b) => GW - b.z],
        [GL + 0.5, 1, 0.6 - GW, 0, 0, -25, (b) => b.z + GW],
        [GL + 0.5, GH - 0.6, 0, 0, 25, 0, (b) => GH - b.y],
        [GB - 0.6, 1, 0, 25, 0, 0, (b) => GB - end * b.x],
      ];
      for (const [u, y, z, vu, vy, vz, gap] of ins) {
        const b = ball({ x: end * u, y, z, vx: end * vu, vy, vz, grounded: 0, inNet: end });
        let min = Infinity;
        runSubsteps(b, 40, (bb) => { min = Math.min(min, gap(bb)); });
        expect(min).toBeGreaterThanOrEqual(R - 1e-9);
        expect(min).toBeLessThan(R + 0.02);
        expect(b.inNet).toBe(end);
      }
    }
  });

  it('the side netting deflects with netOutsideRestitution (soft)', () => {
    const b = ball({ x: 53.5, y: R, z: 6, vz: -20 });
    runBall(b, 12);
    expect(b.z).toBeGreaterThan(GW);
    expect(b.vz).toBeGreaterThan(0);
    expect(b.vz).toBeLessThan(20 * T_BALL.netOutsideRestitution * 1.05);
  });

  it('a ball can never enter the box from a position level with the net but outside it (one substep)', () => {
    // Start already pressed against each sheet from outside with a huge inward velocity.
    const cases: [number, number, number, number, number, number][] = [
      [GL + 1, 1, GW + R, 0, 0, -40],
      [GL + 1, 1, -GW - R, 0, 0, 40],
      [GL + 1, GH + R, 0, 0, -40, 0],
      [GB + R, 1, 0, -40, 0, 0],
      [GL + 0.001, GH + R, GW + R, 0, -30, -30],
      [GB + R, GH + R, GW + R, -25, -25, -25],
    ];
    for (const end of [-1, 1]) {
      for (const [u, y, z, vu, vy, vz] of cases) {
        const b = ball({ x: end * u, y, z, vx: end * vu, vy, vz, grounded: 0 });
        runSubsteps(b, 30, (bb) => expect(inNetBox(end, bb.x, bb.y, bb.z)).toBe(false));
        expect(b.inNet).toBe(0);
      }
    }
  });
});
