/**
 * [QF-13 skeptic] The contested AI header / volley pass fix (SIM-12 solveAerial: no flick over the attacked goal line)
 * from the other end: team 1 attacking -x (and both teams after the ends change), every seed of a grid. The
 * first pass's test only played team 0 toward +x.
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { ActionKind, KickKind } from '../../src/contracts/enums';
import { createBallState, type SimState } from '../../src/contracts/state';
import { createKickLaunch, type KickLaunch } from '../../src/contracts/systems';
import { ballStepTick } from '../../src/sim/ball/contact';
import { copyBallState } from '../../src/sim/ball/flight';
import { AERIAL_TUNING, solveHeader, solveVolley } from '../../src/sim/kicks/aerial';
import { quietScene } from './sim-12-helpers';

const F_AI = 2;
const LT = AERIAL_TUNING;

function atContact(s: SimState, slot: number, header: boolean, x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
  const p = s.players[slot]!;
  const dir = s.teams[p.team]!.dir;
  p.x = x - 0.1 * dir; p.z = z;
  p.act = header ? ActionKind.HEADER : ActionKind.VOLLEY;
  p.actKick = header ? KickKind.HEADER_PASS : KickKind.VOLLEY_PASS;
  p.actPower = LT.aiPassPower; p.actT = 10; p.actContact = 10;
  p.actDur = 30; p.actDone = 0; p.actDirX = 0; p.actDirZ = 0; p.actSlot = -1; p.actA = F_AI; p.actCurve = y;
  p.actX = x; p.actZ = z;
  const b = s.ball;
  b.x = x; b.y = y; b.z = z; b.vx = vx; b.vy = vy; b.vz = vz; b.owner = -1; b.heldBy = -1; b.grounded = 0;
}

/** Furthest excursion toward `dir` and off the touchlines of the launched ball rolled out alone. */
function excursion(s: SimState, out: KickLaunch, dir: number): { maxU: number; maxZ: number } {
  const b = createBallState();
  copyBallState(b, s.ball);
  b.vx = out.vx; b.vy = out.vy; b.vz = out.vz; b.sx = out.sx; b.sy = out.sy; b.sz = out.sz;
  b.grounded = 0; b.owner = -1; b.heldBy = -1; b.inNet = 0; b.bounces = 0;
  let maxU = dir * b.x, maxZ = Math.abs(b.z);
  for (let k = 0; k < 600; k++) {
    ballStepTick(b, null);
    if (dir * b.x > maxU) maxU = dir * b.x;
    if (Math.abs(b.z) > maxZ) maxZ = Math.abs(b.z);
    if (Math.hypot(b.vx, b.vz) < 0.05 && b.y < BALL_RADIUS + 0.01) break;
  }
  return { maxU, maxZ };
}

describe('QF-13 skeptic: AI flicks stay in play from either end', () => {
  it('glitch: header flicked over the goal line — from either end (team 1 attacking -x, both teams after the ends change)', () => {
    const out = createKickLaunch();
    let n = 0;
    const bad: string[] = [];
    for (const team of [0, 1]) {
      for (const swapped of [false, true]) {
        // Headers only: SIM-12 aiChoose never makes an AI volley pass that is not a clearance (F_CLEAR).
        for (const header of [true]) {
          for (let seed = 1; seed <= 3; seed++) {
            for (let toAttack = 6; toAttack <= 46; toAttack += 8) {
              for (let z = -30; z <= 30; z += 10) {
                const s = quietScene({ seed: seed * 977 + toAttack * 13 + z + (header ? 1 : 0) });
                if (swapped) { s.teams[0]!.dir = -1; s.teams[1]!.dir = 1; }
                const dir = s.teams[team]!.dir;
                // Park everybody of the heading team in their own half, far from the ball.
                for (let i = team * 11; i < team * 11 + 11; i++) {
                  const p = s.players[i]!;
                  if (p.isKeeper === 1) { p.x = -dir * 51; p.z = 0; } else { p.x = -dir * 40; p.z = -30 + (i % 11) * 5.5; }
                }
                const slot = team * 11 + 9;
                const x = dir * (HALF_LENGTH - toAttack);
                atContact(s, slot, header, x, header ? 2.1 : 0.7, z, -dir * 6, -3, z > 0 ? -2 : 2);
                const r = header ? solveHeader(s, slot, out) : solveVolley(s, slot, out);
                expect(r).toBe(1);
                n++;
                const e = excursion(s, out, dir);
                if (e.maxU > HALF_LENGTH || e.maxZ > HALF_WIDTH) {
                  if (bad.length < 10) bad.push(`team ${team} swapped ${swapped} ${header ? 'header' : 'volley'} at (${x}, ${z}) seed ${seed}: maxU ${e.maxU.toFixed(2)} maxZ ${e.maxZ.toFixed(2)} kind ${out.kind} target ${out.target}`);
                }
              }
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(200);
    expect(bad).toEqual([]);
  });
});
