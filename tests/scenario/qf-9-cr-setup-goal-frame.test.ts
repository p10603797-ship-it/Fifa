/**
 * [QF-9] CR for QF-10 (src/sim/rules/restart.ts legalizePositions / the set-up walk): a player standing behind the goal
 * net when a goal kick is awarded (he chased the ball over the byline) is teleported at ready (restart.t =
 * restartSetupTicks) to a "legal" spot inside the goal frame's exclusion zone, right against the post: QF-1's
 * "players walk through the goal frame or net" match scan (tests/scenario/qf-1-bodies.test.ts, soak seed 77 #21, 2-minute
 * halves, t 5973: slot 14 from (55.19, -3.98) behind the net to (52.20, -4.07), 3 cm inside the post + body radius) fails
 * with the current tree. The legal-spot search should treat the goal frame / net box (SIM-04 confinePlayer's zone: posts
 * + POST_RADIUS + body radius, the side and back netting) as illegal, or the teleport should go through confinePlayer.
 * Reproduction: the taking side's player held behind his own net through the set-up is put on the goal line inside the
 * mouth / against the post at ready (0.08 m inside the frame zone: the nearest on-pitch point straight in front of him).
 * Was it.fails; QF-10 landed restart.ts ptInGoalFrame (outfield bodies' goal-frame clearance in the legal-spot search)
 * while this ran, so it is a plain regression test now.
 */
import { describe, expect, it } from 'vitest';
import { GOAL_DEPTH, GOAL_HALF_WIDTH, HALF_LENGTH, POST_RADIUS } from '../../src/contracts/constants';
import { MatchPhase, RestartKind } from '../../src/contracts/enums';
import { T_PLAYER, T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { awardRestart } from '../../src/sim/rules/restart';
import { makeScenario, runTicks } from '../harness/scenario';

/** Penetration (m) of a body centre into goal `end`'s frame + net box (as qf-1-bodies goalPenetration): > 0 inside. */
function goalPenetration(x: number, z: number, keeper: boolean): number {
  const GL = HALF_LENGTH, GB = HALF_LENGTH + GOAL_DEPTH, SIDE = GOAL_HALF_WIDTH + POST_RADIUS;
  let worst = -1;
  for (const end of [-1, 1]) {
    const u = end * x;
    const front = keeper ? GL : GL - T_PLAYER.bodyRadius;
    const pen = Math.min(u - front, GB + T_PLAYER.bodyRadius - u, SIDE + T_PLAYER.bodyRadius - Math.abs(z));
    if (pen > worst) worst = pen;
  }
  return worst;
}

describe('QF-9 CR (QF-10 restart set-up): nobody is placed inside the goal frame', () => {
  it('a defender held behind the net through a goal-kick set-up is not teleported into the goal frame zone', () => {
    let worst = -1;
    for (const z of [-3.9, -2, 0, 2, 3.9]) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 5, humans: 0 });
      s.tick = 600;
      // The end team 1 defends (its goal kick).
      const end = -s.teams[1]!.dir;
      const p = s.players[14]!;
      p.x = end * 55.2; p.z = z; p.vx = 0; p.vz = 0;
      const ev = createEventBuffer();
      ev.begin(s.tick);
      awardRestart(s, RestartKind.GOAL_KICK, 1, end * (HALF_LENGTH - 5.5), 4, ev);
      // He stays behind the net through the set-up (in the match he slid along the back of the goal, held there by
      // the netting, until the teleport at ready).
      runTicks(s, T_RULES.restartSetupTicks + 5, (_t, st) => {
        if (st.match.phaseT < T_RULES.restartSetupTicks - 1) { const q = st.players[14]!; q.x = end * 55.2; q.z = z; q.vx = 0; q.vz = 0; }
      }, {
        until: (st) => {
          const q = st.players[14]!;
          const pen = goalPenetration(q.x, q.z, q.isKeeper === 1);
          if (pen > worst) worst = pen;
          return false;
        },
      });
    }
    expect(worst).toBeLessThanOrEqual(1e-6);
  });
});
