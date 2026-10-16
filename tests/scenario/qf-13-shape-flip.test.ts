/**
 * [QF-13] TAI-04 isDefending for a loose ball used only "whose player is nearest the ball", so while an opponent's long
 * ball (a clearance or header on, no pass target) flew over players the defending shape switched on and off: the back
 * line's HOLD_SHAPE targets jumped 3 m to and fro every 0.5 s and the defenders ran back and forth (glitch "players
 * jitter"; World Class bot match, soak seed 61 #16, t 1390: 14 jumps of over 1.5 m in 2.5 s). A deliberate kick still
 * travelling untouched now belongs to the kicking team, as in TAI-06's possession model.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AiJob, KickKind, MatchPhase } from '../../src/contracts/enums';
import { isDefending } from '../../src/ai/defshape';
import { deserializeState } from '../../src/sim/core/serialize';
import { makeScenario, runTicks } from '../harness/scenario';

describe('QF-13 TAI-04: the defending shape does not flip while a long ball is in the air', () => {
  it('glitch: players jitter — back-line targets hold steady under an opponent\'s long ball (seed 61 #16)', () => {
    const s = deserializeState(readFileSync(new URL('./fixtures/qf-13-long-ball-shape.state.json', import.meta.url), 'utf8'));
    expect(s.ball.owner).toBe(-1);
    const prev = new Float64Array(22).fill(NaN);
    let jumps = 0, samples = 0, t = 0;
    runTicks(s, 150, undefined, {
      until: (st) => {
        t++;
        if (t % 6 !== 0 || st.match.phase !== MatchPhase.IN_PLAY) return false;
        for (let i = 1; i < 11; i++) {
          const p = st.players[i]!;
          if (p.job !== AiJob.HOLD_SHAPE || p.ctrl >= 0) { prev[i] = NaN; continue; }
          samples++;
          if (prev[i] === prev[i] && Math.abs(p.tgtX - prev[i]!) > 1.5) jumps++;
          prev[i] = p.tgtX;
        }
        return false;
      },
    });
    expect(samples).toBeGreaterThan(50);
    expect(jumps).toBe(0); // was 14
  });

  it('isDefending follows the last deliberate kick while it travels untouched, else the nearest player', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 4, humans: 0 });
    for (let i = 0; i < 22; i++) { const p = s.players[i]!; p.x = i < 11 ? -20 : 20; p.z = -25 + (i % 11) * 5; }
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.passTarget = -1; b.y = 5; b.x = -19.5; b.z = 0; // over team 0's players
    // Team 1's clearance (no pass target) still flying: team 0 defends, team 1 does not, wherever it is.
    b.lastTouch = 15; b.lastTouchTeam = 1; b.lastKickBy = 15; b.lastKickTeam = 1; b.lastKickKind = KickKind.CLEARANCE;
    b.lastTouchTick = s.tick - 10; b.lastKickTick = s.tick - 10;
    expect(isDefending(s, 0)).toBe(true);
    expect(isDefending(s, 1)).toBe(false);
    // Team 0's own long pass to nobody: team 0 keeps it.
    b.lastTouch = 4; b.lastTouchTeam = 0; b.lastKickBy = 4; b.lastKickTeam = 0; b.lastKickKind = KickKind.LOB_PASS;
    b.x = 19.5;
    expect(isDefending(s, 0)).toBe(false);
    expect(isDefending(s, 1)).toBe(true);
    // A deflection (not a deliberate kick): the nearest-player rule (team 1 nearest at x = 19.5).
    b.lastKickKind = KickKind.DEFLECTION;
    expect(isDefending(s, 0)).toBe(true);
    // Touched since the kick (a first touch / dribble touch): nearest player again.
    b.lastKickKind = KickKind.LOB_PASS; b.lastTouchTick = s.tick - 2;
    b.x = -19.5;
    expect(isDefending(s, 0)).toBe(false);
  });
});
