/**
 * [QF-1] QA-08 subs and send-offs under chaos (real pipeline, every invariant checked every tick): random red cards
 * (keepers included) and random substitution requests (any slot, any squad member, valid or not) during live play and
 * restarts. Never 12 players, onPitch always matches the active players, a sent-off keeper is always replaced in goal,
 * and the first team below 7 players ends the match by forfeit.
 */
import { describe, expect, it } from 'vitest';
import { PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { MatchPhase } from '../../src/contracts/enums';
import type { RngState, SimState } from '../../src/contracts/state';
import { rngFloat, rngInt, rngSeed } from '../../src/sim/core/rng';
import { requestSub, sendOff } from '../../src/sim/rules/subs';
import { makeScenario, runTicks } from '../harness/scenario';

const LIVE = [MatchPhase.IN_PLAY, MatchPhase.FREE_KICK, MatchPhase.THROW_IN, MatchPhase.GOAL_KICK, MatchPhase.CORNER];

function teamProblems(st: SimState): string | null {
  for (let t = 0; t < 2; t++) {
    let act = 0;
    for (let i = 0; i < PLAYERS_PER_TEAM; i++) act += st.players[t * PLAYERS_PER_TEAM + i]!.active;
    if (act > PLAYERS_PER_TEAM) return `t=${st.tick} team ${t} has ${act} players`;
    if (act !== st.teams[t]!.onPitch) return `t=${st.tick} team ${t} onPitch ${st.teams[t]!.onPitch} but ${act} active`;
    const k = st.teams[t]!.keeperSlot;
    if (act > 0 && (k < 0 || st.players[k]!.active !== 1 || st.players[k]!.isKeeper !== 1)) return `t=${st.tick} team ${t} has no keeper (${k})`;
  }
  return null;
}

describe('QF-1 QA-08 subs and send-offs under chaos', { timeout: 600_000 }, () => {
  it('glitch 12 players after a substitution / a team below 7 players not ending the match — 12 chaos matches', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, humans: 0 });
      const rng = { s: 0 } as unknown as RngState;
      rngSeed(rng, seed * 77);
      let problem: string | null = null;
      runTicks(s, 60 * 60 * 3, (tick, st) => {
        const m = st.match;
        if (tick % 97 !== 0 || m.finished === 1 || m.forfeitTeam >= 0 || !LIVE.includes(m.phase)) return;
        const team = rngInt(rng, 2);
        const slot = team * PLAYERS_PER_TEAM + rngInt(rng, PLAYERS_PER_TEAM);
        const r = rngFloat(rng);
        if (r < 0.35) sendOff(st, slot, { emit() { /* none */ } });
        else if (r < 0.9) requestSub(st, team, slot, rngInt(rng, 18));
      }, {
        check: 'all',
        until: (st) => {
          problem ??= teamProblems(st);
          return st.match.phase === MatchPhase.POST_MATCH;
        },
      });
      expect(problem, `seed ${seed}`).toBeNull();
      expect(s.match.phase, `seed ${seed}`).toBe(MatchPhase.POST_MATCH);
      const t = s.match.forfeitTeam;
      expect(t, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(s.teams[t]!.onPitch).toBeLessThan(7);
      expect(s.teams[1 - t]!.onPitch).toBeGreaterThanOrEqual(7);
    }
  });
});
