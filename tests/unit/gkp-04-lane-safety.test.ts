/**
 * [GKP-04] TAI-09 laneSafety takes over the safety model as soon as it is available (any candidate > 0); while it is
 * a stub (0 for everything) or returns garbage, GKP-04's own model decides. TAI-09 is mocked here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KickKind, TeamStyle } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { createDistributionPlan, planDistribution, type DistributionPlan } from '../../src/sim/keeper/distribution';
import { PICKUP, holdingScene } from './gkp-04-helpers';

/** Mock control: 'stub' = 0 everywhere, 'nan' = NaN everywhere, 'favour' = FAVOUR_SAFETY near slot FAVOUR, else OTHER. */
const MOCK = { mode: 'stub' as 'stub' | 'nan' | 'favour', favour: -1, calls: 0 };
const FAVOUR_SAFETY = 0.95;
const OTHER_SAFETY = 0.05;

vi.mock('../../src/ai/cpu/passing', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/cpu/passing')>();
  return {
    ...orig,
    laneSafety: (s: SimState, _team: number, _x0: number, _z0: number, x1: number, z1: number): number => {
      MOCK.calls++;
      if (MOCK.mode === 'stub') return 0;
      if (MOCK.mode === 'nan') return Number.NaN;
      const q = s.players[MOCK.favour]!;
      return Math.hypot(q.x - x1, q.z - z1) < 1.5 ? FAVOUR_SAFETY : OTHER_SAFETY;
    },
  };
});

function first(style = TeamStyle.POSSESSION): DistributionPlan {
  const s = holdingScene({ style });
  const plan = createDistributionPlan();
  for (let h = 0; h <= 200; h++) {
    s.tick = PICKUP + h;
    if (planDistribution(s, 0, plan) === 1) return { ...plan };
  }
  throw new Error('no release');
}

describe('GKP-04 uses TAI-09 laneSafety when available', () => {
  beforeEach(() => { MOCK.mode = 'stub'; MOCK.favour = -1; MOCK.calls = 0; });

  it('stub TAI-09 (0 everywhere): own model decides (open full-back / centre-back)', () => {
    const p = first();
    expect(MOCK.calls).toBeGreaterThan(0);
    expect([1, 2, 3, 4]).toContain(p.slot);
    expect(p.safety).toBe(1);
  });

  it('NaN from TAI-09 is treated as unavailable', () => {
    MOCK.mode = 'nan';
    const p = first();
    expect([1, 2, 3, 4]).toContain(p.slot);
    expect(Number.isFinite(p.score)).toBe(true);
  });

  it('available TAI-09: its safety is used (the only safe lane wins, with that safety)', () => {
    MOCK.mode = 'favour';
    for (const favour of [4, 7, 2]) {
      MOCK.favour = favour;
      const p = first();
      expect(p.slot).toBe(favour);
      expect(p.safety).toBe(FAVOUR_SAFETY);
    }
  });

  it('available TAI-09 rating every short lane unsafe: a direct team goes long to a striker (long balls: own model)', () => {
    // [QF-2] TAI-09's ground-lane model does not judge a 50 m+ lofted kick (it is over every head until it drops),
    // so LONG releases keep GKP-04's own model even when TAI-09 is available: the short lanes it rates unsafe stay
    // unsafe, and the long ball goes to whichever striker GKP-04's own model prefers.
    MOCK.mode = 'favour';
    MOCK.favour = 10;
    const p = first(TeamStyle.DIRECT);
    expect([9, 10]).toContain(p.slot);
    expect(p.kind === KickKind.GK_DROP_KICK || p.kind === KickKind.GK_DRIVEN_KICK).toBe(true);
    expect(p.safety).not.toBe(OTHER_SAFETY);
  });
});
