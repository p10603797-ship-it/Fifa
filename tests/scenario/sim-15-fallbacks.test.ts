/**
 * SIM-15 — documented-but-optional exports of other modules: without SIM-11 markLowDriven the second SHOOT tap
 * re-starts the shot as SHOT_LOW_DRIVEN (ReqFlag.LOW) through startShot; without SIM-14 quickGetUp a LOB press while
 * sliding is consumed (never a second slide).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sim/kicks/pass', async (o) => (await import('./sim-15-fakes')).mockPass((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/shot', async (o) => (await import('./sim-15-fakes')).mockShot((await o()) as Record<string, unknown>, false));
vi.mock('../../src/sim/kicks/skills', async (o) => (await import('./sim-15-fakes')).mockSkills((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/defend/tackle', async (o) => (await import('./sim-15-fakes')).mockTackle((await o()) as Record<string, unknown>, false));

import { ActionKind, KickKind } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
import { ReqFlag } from '../../src/contracts/systems';
import { T_PASS } from '../../src/contracts/tuning';
import { calls, resetFakes } from './sim-15-fakes';
import { keepBall, run, scene } from './sim-15-setup';

beforeEach(() => resetFakes());

describe('SIM-15 fallbacks for exports not landed yet', () => {
  it('low driven shot without SIM-11 markLowDriven: re-start as SHOT_LOW_DRIVEN with the held power', () => {
    const s = scene();
    run(s, 30, (i, st) => {
      if (st.ball.owner === 9 && st.players[9]!.act === ActionKind.NONE) keepBall(st, 9);
      return i <= 20 || (i >= 23 && i <= 24) ? { buttons: Btn.SHOOT } : {};
    });
    const c = calls('startShot');
    expect(c.map((x) => x.kind)).toEqual([KickKind.SHOT_NORMAL, KickKind.SHOT_LOW_DRIVEN]);
    expect(c[1]!.flags & ReqFlag.LOW).toBe(ReqFlag.LOW);
    expect(c[1]!.charging).toBe(0);
    expect(c[1]!.power).toBeCloseTo(20 / T_PASS.powerFillTicks, 9);
    expect(calls('markLowDriven')).toHaveLength(0);
  });
  it('quick get-up press without SIM-14 quickGetUp is consumed, never a second slide', () => {
    const s = scene({ slot: 5, x: -20, ball: 'none' });
    const q = s.players[20]!; q.x = -17; q.z = 0;
    const b = s.ball; b.owner = 20; b.heldBy = -1; b.x = -17.5; b.z = 0; b.lastTouchTeam = 1;
    run(s, 70, (i, st) => {
      st.ball.owner = 20; st.players[20]!.x = -17;
      return i <= 2 || (i >= 10 && i <= 11) ? { buttons: Btn.LOB } : {};
    });
    expect(calls('startTackle').map((x) => x.kind)).toEqual([ActionKind.SLIDE_TACKLE]);
  });
});
