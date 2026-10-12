/** DAT-02: generated squads load through the real match initialisation (sim/init.ts copyAttrs) for every formation. */
import { describe, expect, it } from 'vitest';
import { PLAYERS_PER_TEAM, teamFirstSlot } from '../../src/contracts/constants';
import { ATTRIBUTE_KEYS, type Club } from '../../src/contracts/data';
import { FormationId, Role, TeamStyle } from '../../src/contracts/enums';
import type { RngState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { generateSquad } from '../../src/data/playerGen';
import { rngSeed } from '../../src/sim/core/rng';
import { makeScenario } from '../harness/scenario';

function generatedClubs(seed: number): Club[] {
  const r: RngState = { a: 0, b: 0, c: 0, d: 0 };
  rngSeed(r, seed);
  const used = new Set<string>();
  return CLUBS.map((c, i) => {
    const formation = (i % 6) as FormationId;
    const style = (i % 5) as TeamStyle;
    return { ...c, formation, style, squad: generateSquad(r, { rating: c.rating, formation, style }, { usedNames: used }) };
  });
}

describe('DAT-02 squads in a match', () => {
  const clubs = generatedClubs(2026);

  for (let home = 0; home < 6; home++) {
    it(`formation ${home} v ${(home + 1) % 6}: initMatch copies every generated attribute into the state`, () => {
      const away = (home + 1) % 6;
      const s = makeScenario({ clubs, config: { homeClub: home, awayClub: away } });
      for (let team = 0; team < 2; team++) {
        const club = clubs[team === 0 ? home : away]!;
        for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
          const slot = teamFirstSlot(team) + i;
          const src = club.squad[i]!;
          const a = s.attrs[slot]!;
          for (const k of ATTRIBUTE_KEYS) expect(a[k], `${src.name} ${k}`).toBe(src[k]);
          expect(a.height).toBe(src.height);
          expect(a.foot).toBe(src.foot);
          expect(a.weakFoot).toBe(src.weakFoot);
          expect(a.skillMoves).toBe(src.skillMoves);
          expect(a.shirt).toBe(src.shirt);
          expect(Number.isFinite(a.topSpeed) && a.topSpeed > 0).toBe(true);
          expect(Number.isFinite(a.accel) && a.accel > 0).toBe(true);
          expect(s.players[slot]!.isKeeper).toBe(i === 0 ? 1 : 0);
          if (i === 0) expect(src.pos).toBe(Role.GK);
        }
      }
    });
  }

  it('faster generated players get a higher derived top speed', () => {
    const s = makeScenario({ clubs, config: { homeClub: 19, awayClub: 0 } });
    const outfield = Array.from({ length: 2 * PLAYERS_PER_TEAM }, (_, i) => i).filter((i) => s.players[i]!.isKeeper === 0);
    outfield.sort((a, b) => s.attrs[a]!.sprintSpeed - s.attrs[b]!.sprintSpeed);
    const slow = s.attrs[outfield[0]!]!;
    const fast = s.attrs[outfield[outfield.length - 1]!]!;
    expect(fast.sprintSpeed).toBeGreaterThan(slow.sprintSpeed);
    expect(fast.topSpeed).toBeGreaterThanOrEqual(slow.topSpeed);
  });
});
