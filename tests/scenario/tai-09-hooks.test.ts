/**
 * [TAI-09] The dependencies scorePassOptions defers to: SIM-10 throughLeadPoint (its lead point replaces the own model
 * when it gives one) and SIM-09 crossTarget (its near post / spot / far post when inside the attacked area, else the
 * own geometry). Both are replaced here by controllable doubles (they are Wave-1 stubs). Also pins the inline roll
 * model to SIM-01 groundPassSpeed / groundRollTime.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { AiJob, KickKind, MatchPhase, TeamStyle } from '../../src/contracts/enums';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { createPassOptions, rollModelForTest, scorePassOptions, type PassOption } from '../../src/ai/cpu/passing';
import { groundPassSpeed, groundRollTime } from '../../src/sim/ball/flight';
import { makeScenario } from '../harness/scenario';

const H = vi.hoisted(() => ({
  lead: null as null | { x: number; z: number },
  leadCalls: [] as { slot: number; target: number; power: number; lofted: number }[],
  cross: null as null | ((power: number) => { x: number; z: number }),
  crossCalls: [] as { power: number; dirX: number; dirZ: number }[],
}));

vi.mock('../../src/sim/kicks/through', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/through')>()),
  throughLeadPoint: (_s: SimState, slot: number, target: number, power: number, lofted: number, out: { x: number; z: number }): number => {
    H.leadCalls.push({ slot, target, power, lofted });
    if (!H.lead) return 0;
    out.x = H.lead.x; out.z = H.lead.z;
    return 1;
  },
}));
vi.mock('../../src/sim/kicks/lob', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/lob')>()),
  crossTarget: (_s: SimState, _slot: number, power: number, dirX: number, dirZ: number, out: { x: number; z: number }): void => {
    H.crossCalls.push({ power, dirX, dirZ });
    const p = H.cross ? H.cross(power) : { x: 0, z: 0 };
    out.x = p.x; out.z = p.z;
  },
}));

const HOME: [number, number, number][] = [[0, -45, 0], [1, -8, 24], [2, -15, 8], [3, -15, -8], [4, -8, -24], [5, 12, 25],
  [6, 10, 0], [7, -2, -6], [8, 12, -25], [9, 20, 6], [10, 22, -8]];
const AWAY: [number, number, number][] = [[11, 49, 0], [12, 28, -20], [13, 27, -7], [14, 27, 7], [15, 28, 20], [16, 14, -18],
  [17, 12, -5], [18, 13, 9], [19, 15, 18], [20, -5, -6], [21, -4, 8]];

function scene(carrier = 6): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY });
  for (const [i, x, z] of [...HOME, ...AWAY]) {
    const p = s.players[i]!;
    p.x = x; p.z = z; p.vx = 0; p.vz = 0; p.fx = i < PLAYERS_PER_TEAM ? 1 : -1; p.fz = 0;
    p.act = 0; p.moveMode = MoveMode.STOP; p.stunT = 0; p.job = AiJob.HOLD_SHAPE;
  }
  s.teams[0]!.dir = 1; s.teams[1]!.dir = -1; s.teams[0]!.style = TeamStyle.POSSESSION;
  const c = s.players[carrier]!;
  s.ball.owner = carrier; s.ball.x = c.x + 0.4; s.ball.z = c.z; s.ball.px = s.ball.x; s.ball.pz = s.ball.z;
  return s;
}

function scan(s: SimState, slot: number): PassOption[] {
  const out = createPassOptions(48);
  const n = scorePassOptions(s, slot, out);
  return out.slice(0, n).map((o) => ({ ...o }));
}

beforeEach(() => {
  H.lead = null; H.leadCalls.length = 0; H.cross = null; H.crossCalls.length = 0;
});

describe('TAI-09 uses SIM-10 throughLeadPoint', () => {
  it('asks SIM-10 for each runner with a quantised power and uses its point', () => {
    const s = scene();
    s.players[9]!.vx = 7;
    const own = scan(s, 6).filter((o) => o.kind === KickKind.THROUGH_GROUND && o.target === 9);
    expect(own).toHaveLength(1);
    expect(H.leadCalls.length).toBeGreaterThan(0);
    for (const c of H.leadCalls) {
      expect(c.slot).toBe(6);
      expect(c.target).toBe(9);
      expect([0.2, 0.4, 0.6, 0.8, 1]).toContain(c.power);
      expect([0, 1]).toContain(c.lofted);
    }
    H.lead = { x: 31, z: 9 };
    const sim = scan(s, 6).filter((o) => o.kind === KickKind.THROUGH_GROUND && o.target === 9);
    expect(sim).toHaveLength(1);
    expect(sim[0]!.x).toBe(31);
    expect(sim[0]!.z).toBe(9);
    expect(sim[0]!.x).not.toBe(own[0]!.x);
  });

  it('ignores a lead point off the pitch and drops one that is not ahead of the runner', () => {
    const s = scene();
    s.players[9]!.vx = 7;
    const own = scan(s, 6).find((o) => o.kind === KickKind.THROUGH_GROUND && o.target === 9)!;
    H.lead = { x: NaN, z: 3 };
    expect(scan(s, 6).find((o) => o.kind === KickKind.THROUGH_GROUND && o.target === 9)!.x).toBe(own.x);
    H.lead = { x: 70, z: 3 };
    expect(scan(s, 6).find((o) => o.kind === KickKind.THROUGH_GROUND && o.target === 9)!.x).toBe(own.x);
    H.lead = { x: 21, z: 6 }; // 1 m ahead of him: not a through ball
    expect(scan(s, 6).filter((o) => o.kind === KickKind.THROUGH_GROUND && o.target === 9)).toHaveLength(0);
  });

  it('is never asked about non-runners', () => {
    const s = scene();
    scan(s, 6);
    expect(H.leadCalls).toHaveLength(0);
  });
});

describe('TAI-09 uses SIM-09 crossTarget', () => {
  function boxScene(): SimState {
    const s = scene(5);
    const c = s.players[5]!; c.x = 38; c.z = 26;
    s.ball.x = 38.4; s.ball.z = 26;
    const at = (i: number, x: number, z: number): void => { const p = s.players[i]!; p.x = x; p.z = z; };
    at(9, 41, 2); at(10, 39, -5); at(13, 45, -3); at(14, 45, 4); at(15, 37, 22);
    s.players[9]!.vx = 2; s.players[10]!.vx = 2;
    return s;
  }

  it('asks for three targets with the stick at the goal line and uses answers inside the box', () => {
    const s = boxScene();
    H.cross = (power) => ({ x: 46 - power * 4, z: 6 - power * 10 });
    const cr = scan(s, 5).filter((o) => o.kind === KickKind.CROSS);
    expect(H.crossCalls.map((c) => c.power)).toEqual([0.3, 0.6, 0.9]);
    for (const c of H.crossCalls) { expect(c.dirX).toBe(1); expect(c.dirZ).toBe(0); }
    const pts = cr.map((o) => `${o.x.toFixed(2)},${o.z.toFixed(2)}`).sort();
    for (const p of pts) expect(['44.80,3.00', '43.60,0.00', '42.40,-3.00']).toContain(p);
    expect(cr.length).toBeGreaterThan(0);
  });

  it('falls back to its own near post / spot / far post when SIM-09 answers outside the box, and dedupes', () => {
    const s = boxScene();
    const own = scan(s, 5).filter((o) => o.kind === KickKind.CROSS).map((o) => [o.x, o.z]);
    expect(own.length).toBeGreaterThan(1);
    H.cross = () => ({ x: 46, z: 1 }); // the same point for every power
    const same = scan(s, 5).filter((o) => o.kind === KickKind.CROSS);
    expect(same).toHaveLength(1);
    expect([same[0]!.x, same[0]!.z]).toEqual([46, 1]);
  });

  it('is never asked outside the crossing zone', () => {
    const s = boxScene();
    s.players[5]!.z = 8; s.ball.z = 8;
    scan(s, 5);
    expect(H.crossCalls).toHaveLength(0);
  });
});

describe('TAI-09 roll model mirrors SIM-01', () => {
  it('launch speed and roll time match groundPassSpeed / groundRollTime', () => {
    for (const d of [0.5, 3, 8, 15, 25, 40, 60, 90]) {
      for (const arrive of [0, 3.5, 6, 8, 12]) {
        const [v, t] = rollModelForTest(d, arrive);
        const vRef = groundPassSpeed(d, arrive);
        expect(Math.abs(v - vRef)).toBeLessThan(1e-6 * Math.max(1, vRef));
        const tRef = groundRollTime(vRef, d);
        if (arrive === 0) {
          // Arrival 0 = the stop point itself: rounding decides "just gets there" vs "-1", and both Newton solves
          // converge slowly there. Either answer is fine; a time must be close to the full stopping time.
          if (t >= 0 && tRef >= 0) expect(Math.abs(t - tRef)).toBeLessThan(2e-3);
          continue;
        }
        if (tRef < 0) expect(t).toBe(-1);
        else expect(Math.abs(t - tRef)).toBeLessThan(1e-6 * Math.max(1, tRef));
      }
    }
  });
});
