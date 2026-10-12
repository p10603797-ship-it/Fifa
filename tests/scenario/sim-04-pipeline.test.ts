/**
 * SIM-04 through the real tick pipeline (step): a human's stick drives his player via the resolver's DIRECT intent,
 * and in a bot-v-bot run nobody ever leaves the boards or enters a goal frame / net.
 */
import { describe, expect, it } from 'vitest';
import {
  BOARD_X, BOARD_Z, GOAL_DEPTH, GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS, POST_RADIUS,
} from '../../src/contracts/constants';
import { AutoSwitch, MatchPhase } from '../../src/contracts/enums';
import { AXIS_SCALE, Btn } from '../../src/contracts/input';
import { T_PLAYER } from '../../src/contracts/tuning';
import { makeScenario, runTicks } from '../harness/scenario';

describe('SIM-04 in the step pipeline', () => {
  it('a sprinting human player accelerates along his stick and stays inside the world', () => {
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY,
      humans: [{ side: 0, slot: 9, autoSwitch: AutoSwitch.OFF }],
      players: [{ slot: 9, x: -20, z: 10, fx: 1, fz: 0 }],
      ball: { x: 0, z: -20 },
    });
    const p = s.players[9]!;
    const x0 = p.x;
    runTicks(s, 120, (_t, _s, out) => { out[0]!.mx = AXIS_SCALE; out[0]!.buttons = Btn.SPRINT; }, { check: 'core' });
    expect(p.x - x0).toBeGreaterThan(8);
    expect(p.vx).toBeGreaterThan(0.9 * s.attrs[9]!.topSpeed);
    expect(p.sprinting).toBe(1);
    expect(p.stamina).toBeLessThan(1);
  });

  it('Players: walk through the goal frame or net - bot v bot: nobody passes the boards or enters a goal box', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 11 });
    const r = T_PLAYER.bodyRadius;
    runTicks(s, 1200, undefined, {
      check: 'core',
      until: (st) => {
        for (let i = 0; i < NUM_SLOTS; i++) {
          const p = st.players[i]!;
          if (p.active !== 1) continue;
          const ax = Math.abs(p.x);
          // Net volume proper (behind the line, inside the posts); keepers may stand on the line itself.
          if (ax > HALF_LENGTH + 1e-9 && ax < HALF_LENGTH + GOAL_DEPTH + r && Math.abs(p.z) < GOAL_HALF_WIDTH + POST_RADIUS + r) {
            throw new Error(`player ${i} inside a goal at (${p.x}, ${p.z}), tick ${st.tick}`);
          }
          if (ax > BOARD_X || Math.abs(p.z) > BOARD_Z) throw new Error(`player ${i} past the boards at (${p.x}, ${p.z})`);
        }
        return false;
      },
    });
    expect(s.tick).toBeGreaterThan(0);
  });
});
