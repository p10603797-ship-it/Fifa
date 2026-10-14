/**
 * [QF-2 skeptic] CR for QF-1 (src/sim/players/bodies.ts, SIM-05 slide-around): glitch "players run in place against
 * each other / jitter". An AI runner (TAI-03 RUN_IN_BEHIND, ARRIVE target ~20 m away on the far side of the man next to
 * him) is locked shoulder to shoulder (0.75 m) with an opponent who runs alongside him the same way (CPU-controlled
 * defender, stick-driven at ~3 m/s): for 80 ticks he is carried along at the opponent's pace, away from his target,
 * and his velocity flips sign 14 times in 1.5 s (vz +2.5 -> -1.6 -> +2.5 ...: the slide-around nudge, then the
 * steering back into the body). The jitter detector (>= 6 reversals in 2 s) sees about one such lock every two bot
 * matches (soak seeds 4242 / 5151 / 6262, every level), between teammates too (two defenders after a joint header).
 * Professional bot match, soak seed 6262 #0 (4-minute halves), t 27725, runner 10 vs defender 17.
 * Proposed fix (bodies.ts): when a player's ARRIVE intent pushes into a body that moves with him (relative velocity
 * along the tangent below slideSpeed), slide round its back (the side away from its velocity) with the side kept for
 * the whole contact (no per-tick re-choice), or brake him so the other body passes; never let the nudge alternate.
 * Fixture: serializeState at t 27725 (post-QF-2-skeptic code). Marked it.fails until QF-1 lands a fix.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deserializeState } from '../../src/sim/core/serialize';
import { runTicks } from '../harness/scenario';

describe('QF-2 CR (SIM-05): no body lock between a runner and an opponent running alongside', () => {
  it.fails('glitch: Players run in place against each other — the runner gets free of the man alongside within 30 ticks, without velocity flips', () => {
    const s = deserializeState(readFileSync(new URL('./fixtures/qf-2-body-lock.state.json', import.meta.url), 'utf8'));
    const a = 10, b = 17;
    let reversals = 0, locked = 0, longest = 0;
    let pvx = s.players[a]!.vx, pvz = s.players[a]!.vz;
    runTicks(s, 90, undefined, {
      until: (st) => {
        const p = st.players[a]!, q = st.players[b]!;
        if (Math.hypot(p.vx, p.vz) > 1 && Math.hypot(pvx, pvz) > 1 && p.vx * pvx + p.vz * pvz < 0) reversals++;
        pvx = p.vx; pvz = p.vz;
        locked = Math.hypot(p.x - q.x, p.z - q.z) < 0.85 ? locked + 1 : 0;
        if (locked > longest) longest = locked;
        return false;
      },
    });
    expect(reversals).toBeLessThanOrEqual(2);
    expect(longest).toBeLessThanOrEqual(30);
  });
});
