/**
 * QF-3 QA-26 (second pass): touch while DEFENDING a free kick. The sim reads R2 / L2 as "move the wall" and Triangle as
 * "wall jump" there (section 10, Defending a free kick); touch has no wall controls (section 9). Before the fix the
 * defence cluster's SPRINT & TACKLE (R2 from touch-down) slid the wall one way only (2.5 m in a second's hold, and every
 * tackle tap nudged it; defenders cannot sprint at a free kick anyway) and a 2ND DEF swipe down (keeper rush, Triangle
 * held) made the wall jump long before the kick. Through the real touch source, mapper and sim (qf-3-touch-rig).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
import { ClusterMode, ClusterSlot } from '../../src/contracts/touch';
import { NULL_SINK } from '../../src/sim/core/events';
import { awardRestart } from '../../src/sim/rules/restart';
import { makeScenario } from '../harness/scenario';
import { createTouchRig, type TouchRig } from './qf-3-touch-rig';

/** Away free kick 28 m from P1's goal (P1 home defends -x), wall set, taker waiting. */
function defendFk(): TouchRig {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 4 }], ball: { owner: -1, x: -30, z: 5, y: 0.11 } });
  awardRestart(s, RestartKind.FREE_KICK, 1, -28, 5, NULL_SINK);
  const r = createTouchRig(s);
  for (let i = 0; i < 400 && r.s.match.restart.ready !== 1; i++) r.tick();
  expect(r.s.match.restart.ready).toBe(1);
  expect(r.s.match.restart.wallCount).toBeGreaterThan(0);
  expect(r.st.mode).toBe(ClusterMode.DEFENCE);
  return r;
}

function wallJumping(r: TouchRig): boolean {
  const rs = r.s.match.restart;
  for (let k = 0; k < rs.wallCount; k++) {
    const w = rs.wall[k]!;
    if (w >= 0 && r.s.players[w]!.act === ActionKind.WALL_JUMP) return true;
  }
  return false;
}

describe('QF-3 QA-26 touch defending a free kick never moves or jumps the wall', () => {
  it('holding SPRINT & TACKLE for a second never slides the wall (before: 2.5 m, one way only)', () => {
    const r = defendFk();
    const rs = r.s.match.restart;
    const x0 = rs.wallX, z0 = rs.wallZ;
    const big = r.slot(ClusterSlot.BIG);
    r.down(2, big.x, big.y);
    r.tick(60);
    expect(r.s.match.phase).toBe(MatchPhase.FREE_KICK);
    expect(rs.wallX).toBe(x0);
    expect(rs.wallZ).toBe(z0);
    expect(r.frames.slice(-60).every((f) => (f.buttons & Btn.SPRINT) === 0)).toBe(true);
    r.up(2, big.x, big.y);
  });

  it('tackle taps at a defending free kick never nudge the wall', () => {
    const r = defendFk();
    const rs = r.s.match.restart;
    const z0 = rs.wallZ;
    const big = r.slot(ClusterSlot.BIG);
    for (let k = 0; k < 6; k++) { r.down(2, big.x, big.y); r.wait(80); r.up(2, big.x, big.y); r.wait(100); }
    expect(rs.wallZ).toBe(z0);
  });

  it('a 2ND DEF swipe down (keeper rush) at a defending free kick never makes the wall jump before the kick', () => {
    const r = defendFk();
    const mid = r.slot(ClusterSlot.MID);
    r.down(2, mid.x, mid.y); r.wait(17); r.move(2, mid.x, mid.y + 15); r.wait(17); r.move(2, mid.x, mid.y + 40);
    let jumped = false;
    for (let i = 0; i < 30; i++) { r.tick(); if (wallJumping(r)) jumped = true; }
    r.up(2, mid.x, mid.y + 40);
    expect(r.s.match.phase).toBe(MatchPhase.FREE_KICK);
    expect(jumped).toBe(false);
  });

  it('SPRINT held from open play into a free kick against us does not slide the wall either', () => {
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 4 }],
      players: [{ slot: 4, x: -24, z: 2 }, { slot: 18, x: -20, z: 0 }],
      ball: { owner: 18, lastTouchTeam: 1, x: -19.6, y: 0.11, z: 0 },
    });
    for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
    const r = createTouchRig(s);
    r.tick(2);
    const big = r.slot(ClusterSlot.BIG);
    r.down(2, big.x, big.y);
    r.wait(300);
    expect(r.frames.at(-1)!.buttons & Btn.SPRINT).toBe(Btn.SPRINT);
    awardRestart(r.s, RestartKind.FREE_KICK, 1, -28, 5, NULL_SINK);
    for (let i = 0; i < 400 && r.s.match.restart.ready !== 1; i++) r.tick();
    const rs = r.s.match.restart;
    const z0 = rs.wallZ;
    r.tick(40);
    expect(rs.wallZ).toBe(z0);
    r.up(2, big.x, big.y);
  });
});
