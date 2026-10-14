/**
 * [QF-2 skeptic] QA-17 / glitch "players run in place against each other". TAI-07 steerJob turns a positional player
 * (MARK, COVER, HOLD_SHAPE ...) to face the ball (lookAt) within faceBallDist (3 m) of his target, and SIM-05's
 * slide-around skips a player who holds a facing. A marker 2.9 m from his goal-side spot with the attacker he marks
 * standing still on that line (arrived at his own run target) pushed into him at full intent and moved 0.12 m/s for
 * 1.5 s and more (Legend cup bot match, soak seed 4242 #8, 4-minute halves, t 3590: defender 13 vs attacker 10).
 * Fix: no ball-facing while a body blocks the way to the target (steer.ts pathBlocked), so SIM-05 slides him round.
 * Fixture: serializeState at t 3590 (pre-fix code).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AiJob } from '../../src/contracts/enums';
import { MoveMode } from '../../src/contracts/state';
import { deserializeState } from '../../src/sim/core/serialize';
import { runTicks } from '../harness/scenario';

describe('QF-2 positional players slide round a body on their line (real pipeline from a captured state)', () => {
  it('glitch: Players run in place against each other — a marker 2-3 m from his spot slides round the man standing on his line', () => {
    const s = deserializeState(readFileSync(new URL('./fixtures/qf-2-run-in-place.state.json', import.meta.url), 'utf8'));
    const m = s.players[13]!, a = s.players[10]!;
    expect(m.job).toBe(AiJob.MARK);
    expect(Math.hypot(m.x - a.x, m.z - a.z)).toBeLessThan(0.85);
    const x0 = m.x, z0 = m.z;
    let stuck = 0, longest = 0;
    runTicks(s, 60, undefined, {
      check: 'core',
      until: (st) => {
        const p = st.players[13]!;
        const want = p.moveMode === MoveMode.ARRIVE && Math.hypot(p.tgtX - p.x, p.tgtZ - p.z) > 1.5;
        stuck = want && Math.hypot(p.vx, p.vz) < 0.4 ? stuck + 1 : 0;
        if (stuck > longest) longest = stuck;
        return false;
      },
    });
    // Pre-fix: 0.12 m/s for the whole minute of ticks (moved 0.1 m).
    expect(longest).toBeLessThan(20);
    expect(Math.hypot(m.x - x0, m.z - z0)).toBeGreaterThan(1.5);
  });
});
