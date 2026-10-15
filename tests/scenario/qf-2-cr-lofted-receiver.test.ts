/**
 * [QF-2 skeptic] CR for QF-1 (src/sim/control/resolveShared.ts meetPoint, SIM-15): the controlled receiver of a lofted
 * pass (lob, keeper throw, cross) runs to the first point of the ball's GROUND TRACK he can reach, ignoring its
 * height, so he stands where the ball flies over him at 4-10 m and it lands behind him and runs on. The CPU controller
 * always holds the receiver of its own pass (SIM-16 switches to him), so every CPU lofted pass is played this way; a
 * human receiver with the stick released too. Measured over 6 Professional bot matches (soak seed 515): LOB_PASS
 * reached a teammate 2 times in 64 (60 to an opponent), keeper overarm throws 1 in 10 (8 rolled out for a throw-in),
 * driven throws 2 in 6. INT-A's "lobs completed 4-13%" and TAI-09's low aerial completion factors come from this.
 * Proposed fix (meetPoint): for an airborne ball skip the samples where it is still above head height
 *     if (b.grounded !== 1 && b.y + b.vy * t - 0.5 * T_BALL.gravity * t * t > LT.meetMaxHeight) continue;
 * (LT.meetMaxHeight ~2.0 m, TAI-07 chaseReachHeight). With that one line the same 6 matches give LOB_PASS 38 / 65 to a
 * teammate, GK_THROW 11 / 11, GK_DRIVEN_THROW 20 / 20. (Then TAI-09's aerialMin / Max and throughLobCompletionMul can be
 * re-fitted by QF-2.)
 * Fixture: Professional soak seed 515 #0 (4-minute halves), t 10303: team 1's keeper is about to throw to defender 12
 * (26 m, lands at (36.5, -19.4)); with the current meetPoint the ball rolls out for a throw-in.
 * Marked it.fails until QF-1 lands a fix.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import { deserializeState } from '../../src/sim/core/serialize';
import { runTicks } from '../harness/scenario';

describe('QF-2 CR (SIM-15): the controlled receiver of a lofted pass meets it where it comes down', () => {
  it('the keeper\'s throw to the CPU-controlled defender reaches him (not out for a throw-in)', () => {
    const s = deserializeState(readFileSync(new URL('./fixtures/qf-2-lofted-receiver.state.json', import.meta.url), 'utf8'));
    const keeper = s.ball.heldBy;
    expect(keeper).toBeGreaterThanOrEqual(0);
    const team = s.players[keeper]!.team;
    runTicks(s, 300, undefined, {
      check: 'core',
      until: (st) => st.match.phase !== MatchPhase.IN_PLAY || (st.ball.lastTouch !== keeper && st.ball.lastTouchTick > 10304),
    });
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(s.players[s.ball.lastTouch]!.team).toBe(team);
  });
});
