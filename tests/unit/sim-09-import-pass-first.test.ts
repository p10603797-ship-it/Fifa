/**
 * [SIM-09] Regression: kicks/pass.ts imported FIRST. Then pass -> actions/dispatch -> actions/registry -> lob evaluates
 * lob.ts while pass.ts is still mid-evaluation, so nothing lob.ts reads from pass.ts at its own evaluation exists yet
 * (undefined under vitest, a TDZ ReferenceError in a bundle). lob.ts once kept `const PT = LOCAL_TUNING` (SIM-08's
 * tuning) at module level: every cross then threw "Cannot read properties of undefined (reading 'powerKnee')" at
 * contact (seen in TAI-13's end-to-end free kicks). SIM-08 tuning is now read inside functions only.
 */
import { startPass } from '../../src/sim/kicks/pass';
import { describe, expect, it } from 'vitest';
import { KickKind } from '../../src/contracts/enums';
import { createKickLaunch } from '../../src/contracts/systems';
import { NULL_SINK } from '../../src/sim/core/events';
import { solveCross, startLob } from '../../src/sim/kicks/lob';
import { solveThrough, startThrough } from '../../src/sim/kicks/through';
import { KICKER, MATE_A, place, quiet, req } from './sim-09-helpers';

describe('SIM-09 with kicks/pass.ts imported first', () => {
  it('crosses, first-time lobs and through balls still start and solve', () => {
    expect(typeof startPass).toBe('function');
    const s = quiet(1, 38, 26, 0.5, -1);
    expect(startLob(s, KICKER, KickKind.CROSS, req({ power: 0.95 }), NULL_SINK)).toBe(1);
    const out = createKickLaunch();
    expect(() => solveCross(s, KICKER, out)).not.toThrow();
    expect(out.kind).toBe(KickKind.CROSS);
    expect(out.vy).toBeGreaterThan(1);
    // A loose ball arriving (SIM-08's start-arrive tuning).
    const a = quiet();
    a.ball.owner = -1; a.ball.x = -6; a.ball.vx = 12;
    expect(startLob(a, KICKER, KickKind.LOB_PASS, req(), NULL_SINK)).toBe(1);
    const t = quiet();
    place(t, MATE_A, 12, 6, 1, 0, 7, 0);
    expect(startThrough(t, KICKER, KickKind.THROUGH_LOBBED, req({ dirX: 1 }), NULL_SINK)).toBe(1);
    expect(solveThrough(t, KICKER, out)).toBe(1);
    expect(out.target).toBe(MATE_A);
  });
});
