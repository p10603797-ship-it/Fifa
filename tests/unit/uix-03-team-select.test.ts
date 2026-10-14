/**
 * UIX-03 unit tests: team and kit select logic (src/ui/screens/teamSelect.ts): star ratings, the clash check summary
 * (GFX-08 resolveKits), automatic kit choice on a club pick, random club, the partial MatchSetup written for the next
 * step, and reading a flow with out-of-range values.
 */
import { describe, expect, it } from 'vitest';
import { KitSlot, ModeId } from '../../src/contracts/enums';
import type { Club } from '../../src/contracts/data';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { resolveKits } from '../../src/render/kits';
import type { FlowParams } from '../../src/ui/screens/matchFlow';
import {
  applyTeamChoice, choiceFromFlow, clashSummary, keyPlayers, pickClub, randomClub, ratingStars, settleKits, type TeamChoice,
} from '../../src/ui/screens/teamSelect';

function flow(): FlowParams {
  return { mode: ModeId.KICK_OFF, setup: { config: createMatchConfig(), bindings: [] } };
}

/** First pair (home, away) of different clubs whose requested kits (home, home) clash. */
function clashingPair(): [number, number] {
  for (let a = 0; a < CLUBS.length; a++) {
    for (let b = 0; b < CLUBS.length; b++) {
      if (a === b) continue;
      const r = resolveKits(CLUBS[a]!, CLUBS[b]!, KitSlot.HOME, KitSlot.HOME);
      if (r.slot[1] !== KitSlot.HOME && !r.fallback[1] && r.slot[0] === KitSlot.HOME) return [a, b];
    }
  }
  throw new Error('no clashing pair in the data');
}

describe('UIX-03 team select', () => {
  it('star rating spans 1..5 in half steps across the 62..88 overall range', () => {
    expect(ratingStars(62)).toBe(1);
    expect(ratingStars(88)).toBe(5);
    expect(ratingStars(75)).toBe(3);
    expect(ratingStars(40)).toBe(1);
    expect(ratingStars(99)).toBe(5);
    expect(ratingStars(Number.NaN)).toBe(1);
    for (const c of CLUBS) {
      const s = ratingStars(c.rating);
      expect(s * 2).toBe(Math.round(s * 2));
    }
  });

  it('clash summary: clear fixture vs the same club twice in the same kit', () => {
    const clear: TeamChoice = { club: [0, 1], kit: [KitSlot.HOME, KitSlot.AWAY] };
    settleKits(CLUBS, clear);
    const ok = clashSummary(CLUBS, clear);
    expect(ok.clear).toBe(true);
    expect(ok.text).toMatch(/no clash/);
    expect(ok.sideClear).toEqual([true, true]);
    const same: TeamChoice = { club: [4, 4], kit: [KitSlot.HOME, KitSlot.HOME] };
    const bad = clashSummary(CLUBS, same);
    expect(bad.clear).toBe(false);
    expect(bad.sideClear[1]).toBe(false);
    expect(bad.side[1]).toMatch(/^Clash: /);
    expect(bad.text).toContain(CLUBS[4]!.code);
  });

  it('a club pick starts in its home kit and takes the kit the clash check would use', () => {
    const [a, b] = clashingPair();
    const choice: TeamChoice = { club: [a, 0], kit: [KitSlot.HOME, KitSlot.HOME] };
    pickClub(CLUBS, choice, 1, b);
    expect(choice.club).toEqual([a, b]);
    expect(choice.kit[1]).toBe(KitSlot.AWAY);
    expect(clashSummary(CLUBS, choice).sideClear[1]).toBe(true);
    // Picking for home resets the home kit to HOME.
    choice.kit[0] = KitSlot.AWAY;
    pickClub(CLUBS, choice, 0, a);
    expect(choice.kit[0]).toBe(KitSlot.HOME);
    // Out-of-range picks are ignored.
    pickClub(CLUBS, choice, 0, 99);
    pickClub(CLUBS, choice, 0, -1);
    expect(choice.club[0]).toBe(a);
  });

  it('random club never repeats the other side and stays in range', () => {
    for (let avoid = 0; avoid < 20; avoid++) {
      for (const r of [0, 0.1, 0.5, 0.9999, 1]) {
        const i = randomClub(20, avoid, () => r);
        expect(i).not.toBe(avoid);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(20);
      }
    }
    expect(randomClub(1, 0, () => 0.5)).toBe(0);
  });

  it('writes clubs, kits and the clubs\' preferred formations into the flow config', () => {
    const f = flow();
    applyTeamChoice(f, CLUBS, { club: [7, 13], kit: [KitSlot.AWAY, KitSlot.HOME] });
    const c = f.setup.config;
    expect([c.homeClub, c.awayClub, c.homeKit, c.awayKit]).toEqual([7, 13, KitSlot.AWAY, KitSlot.HOME]);
    expect(c.homeFormation).toBe(CLUBS[7]!.formation);
    expect(c.awayFormation).toBe(CLUBS[13]!.formation);
  });

  it('reads the flow, falling back to clubs 0 / 1 and valid kit slots for bad values', () => {
    const f = flow();
    f.setup.config.homeClub = 55;
    f.setup.config.awayClub = -3;
    f.setup.config.homeKit = KitSlot.KEEPER;
    expect(choiceFromFlow(f, CLUBS)).toEqual({ club: [0, 1], kit: [KitSlot.HOME, KitSlot.AWAY] });
    f.setup.config.homeClub = 9;
    f.setup.config.awayClub = 9;
    expect(choiceFromFlow(f, CLUBS).club).toEqual([9, 9]);
  });

  it('key players are the three best by overall', () => {
    const club = CLUBS[0] as Club;
    const k = keyPlayers(club);
    expect(k).toHaveLength(3);
    const best = club.squad.map((p) => p.overall).sort((x, y) => y - x).slice(0, 3);
    expect(k.map((p) => p.overall)).toEqual(best);
  });
});
