/**
 * [QF-1] QA-07 shoot-outs end to end (bot v bot, real keepers and kickers): alternate kicks, five each then sudden death,
 * the result decided exactly when it can no longer change, every eligible player kicks once before anyone kicks twice
 * (equal numbers: the side with more players leaves its extra ones out), a team that lost players still finishes, and
 * nothing needs the watchdog.
 */
import { describe, expect, it } from 'vitest';
import { PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { MatchPhase, ModeId } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { sendOff } from '../../src/sim/rules/subs';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';

interface Kick { team: number; idx: number; scored: number; kicker: number }

function runShootout(seed: number, prep?: (s: SimState) => void): { s: SimState; kicks: Kick[]; events: SimEvent[] } {
  const s = makeScenario({ seed, config: { mode: ModeId.SHOOT_OUT, startPhase: MatchPhase.SHOOT_OUT } });
  prep?.(s);
  const kicks: Kick[] = [];
  const events = runTicks(s, 60 * 60 * 6, undefined, {
    check: 'core',
    until: (st, ev) => {
      for (const e of ev) {
        if (e.type === EventType.SHOOTOUT_KICK) kicks.push({ team: e.a, idx: e.b, scored: e.c, kicker: st.match.shootout.kicker });
      }
      return st.match.phase === MatchPhase.POST_MATCH;
    },
  });
  return { s, kicks, events };
}

/** True when the shoot-out was decided after kick k (0-based, both teams' kicks interleaved). */
function decidedAfter(kicks: readonly Kick[], k: number): boolean {
  const g = [0, 0], n = [0, 0];
  for (let i = 0; i <= k; i++) { const q = kicks[i]!; n[q.team]!++; g[q.team]! += q.scored; }
  for (let t = 0; t < 2; t++) {
    const o = 1 - t;
    const left = (r: number): number => Math.max(0, 5 - n[r]!);
    if (n[0]! <= 5 && n[1]! <= 5 && (n[0]! < 5 || n[1]! < 5)) {
      if (g[t]! > g[o]! + left(o)) return true;
    }
  }
  if (n[0]! >= 5 && n[1]! >= 5 && n[0] === n[1] && g[0] !== g[1]) return true;
  return false;
}

describe('QF-1 QA-07 shoot-outs end to end', { timeout: 600_000 }, () => {
  it('20 shoot-outs: alternate kicks, decided exactly when it cannot change, winner = more goals, no watchdog', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { s, kicks, events } = runShootout(seed);
      expect(s.match.phase, `seed ${seed}`).toBe(MatchPhase.POST_MATCH);
      expect(findEvents(events, EventType.WATCHDOG), `seed ${seed}`).toEqual([]);
      expect(kicks.length).toBeGreaterThanOrEqual(6);
      for (let i = 1; i < kicks.length; i++) expect(kicks[i]!.team, `seed ${seed} kick ${i}`).toBe(1 - kicks[i - 1]!.team);
      for (let i = 0; i < kicks.length - 1; i++) expect(decidedAfter(kicks, i), `seed ${seed}: decided early after kick ${i}`).toBe(false);
      expect(decidedAfter(kicks, kicks.length - 1), `seed ${seed}`).toBe(true);
      const g = [0, 0];
      for (const k of kicks) g[k.team]! += k.scored;
      expect(s.match.winner).toBe(g[0]! > g[1]! ? 0 : 1);
      expect(s.match.shootout.goals).toEqual(g);
    }
  });

  it('every eligible player kicks once before anyone kicks twice, with equal numbers when a side is short', () => {
    let longest = 0;
    for (let seed = 1; seed <= 12; seed++) {
      // Team 1 lost two players before the shoot-out: both sides use 9 kickers.
      const { kicks } = runShootout(100 + seed, (st) => { sendOff(st, PLAYERS_PER_TEAM + 4, { emit() { /* none */ } }); sendOff(st, PLAYERS_PER_TEAM + 7, { emit() { /* none */ } }); });
      longest = Math.max(longest, kicks.length);
      for (let t = 0; t < 2; t++) {
        const order = kicks.filter((k) => k.team === t).map((k) => k.kicker);
        for (let i = 0; i < order.length; i++) {
          const round = Math.floor(i / 9);
          const inRound = order.slice(round * 9, round * 9 + 9);
          expect(new Set(inRound).size, `seed ${seed} team ${t}`).toBe(inRound.length);
          if (i >= 9) expect(order[i], `seed ${seed} team ${t} kick ${i}`).toBe(order[i - 9]);
        }
        if (t === 1) for (const k of order) expect([PLAYERS_PER_TEAM + 4, PLAYERS_PER_TEAM + 7]).not.toContain(k);
      }
    }
    console.log(`QF-1 shoot-out: longest ${longest} kicks`);
    expect(longest).toBeGreaterThanOrEqual(10);
  });
});
