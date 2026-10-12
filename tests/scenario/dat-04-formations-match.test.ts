/**
 * DAT-04 scenarios: formation data used by a real match state (initMatch placement for both attack directions,
 * every formation pairing), an in-match formation switch and a short-handed re-balance applied the way TAI-14 /
 * RUL-10 are documented to apply remapFormation, and the real pipeline stepping with every formation.
 * Clubs are built locally from the formation data so the test does not depend on the generated club file.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, HALF_WIDTH, PLAYERS_PER_TEAM, teamFirstSlot } from '../../src/contracts/constants';
import type { Club, PlayerData } from '../../src/contracts/data';
import { FormationId, Foot, KitPattern, MatchPhase, Role, TeamStyle } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { createInvariantChecker } from '../../src/sim/debug/invariants';
import { FORMATIONS, getFormation, remapFormation, roleSide, slotWorld } from '../../src/data/formations';
import { tacticalHome, tacticFlags } from '../../src/data/tactics';
import { makeScenario, runTicks } from '../harness/scenario';

const IDS = FORMATIONS.map((f) => f.id);

function player(i: number, pos: Role): PlayerData {
  const gk = pos === Role.GK;
  const o = gk ? 30 : 70;
  const g = gk ? 70 : 15;
  return {
    name: `Test ${i}`, short: `T${i}`, shirt: i + 1, pos, height: gk ? 190 : 180, foot: Foot.RIGHT, weakFoot: 3,
    skillMoves: gk ? 1 : 3, overall: 70,
    acceleration: o, sprintSpeed: o, agility: o, ballControl: o, dribbling: o, shortPassing: o, longPassing: o,
    crossing: o, vision: o, finishing: o, shotPower: o, longShots: o, curve: o, heading: o, standingTackle: o,
    slidingTackle: o, interceptions: o, strength: o, stamina: o, composure: o,
    gkDiving: g, gkHandling: g, gkReflexes: g, gkPositioning: g, gkKicking: g,
  };
}

function testClub(id: number, formation: FormationId): Club {
  const squad: PlayerData[] = getFormation(formation).slots.map((s, i) => player(i, s.role));
  const bench = [Role.GK, Role.CB, Role.RB, Role.CDM, Role.CM, Role.RW, Role.ST];
  bench.forEach((r, k) => squad.push(player(PLAYERS_PER_TEAM + k, r)));
  const kit = { shirt: 0x3366cc, shirt2: 0xffffff, pattern: KitPattern.PLAIN, shorts: 0xffffff, socks: 0x3366cc, number: 0xffffff };
  return {
    id, name: `Test ${id}`, code: `T${String(id).padStart(2, '0')}`, city: 'Testville', rating: 75, style: TeamStyle.POSSESSION,
    formation, home: kit, away: { ...kit, shirt: 0xcc3333 }, keeper: { ...kit, shirt: 0x222222 }, keeper2: { ...kit, shirt: 0xeeee22 },
    crest: { shape: 0, primary: 0x3366cc, secondary: 0xffffff, emblem: 0, layout: 0 }, squad,
  };
}

const CLUBS: Club[] = IDS.map((f, i) => testClub(i, f));

function build(home: FormationId, away: FormationId, seed = 7): SimState {
  return makeScenario({ clubs: CLUBS, seed, config: { homeClub: home, awayClub: away, homeFormation: home, awayFormation: away } });
}

function teamPlayers(s: SimState, team: number): SimState['players'] {
  return s.players.slice(teamFirstSlot(team), teamFirstSlot(team) + PLAYERS_PER_TEAM);
}

describe('DAT-04 scenario: formations in a match state', () => {
  it('initMatch places every formation pairing legally for both attack directions', () => {
    const checker = createInvariantChecker(['finite', 'bounds', 'players']);
    for (const home of IDS) {
      for (const away of IDS) {
        const s = build(home, away);
        checker.reset();
        expect(checker.check(s, null), `${home} v ${away}`).toEqual([]);
        for (let team = 0; team < 2; team++) {
          const t = s.teams[team]!;
          const form = getFormation(team === 0 ? home : away);
          const ps = teamPlayers(s, team);
          expect(ps.filter((p) => p.isKeeper === 1)).toHaveLength(1);
          for (const p of ps) {
            const slot = form.slots[p.formIdx]!;
            expect(p.role).toBe(slot.role);
            expect(p.isKeeper).toBe(slot.role === Role.GK ? 1 : 0);
            expect(t.dir * p.x, `${home} v ${away} team ${team} slot ${p.slot} own half`).toBeLessThan(0);
            expect(Math.abs(p.x)).toBeLessThan(HALF_LENGTH);
            expect(Math.abs(p.z)).toBeLessThan(HALF_WIDTH);
            // Mirrored use: the side of the pitch matches the player's own right/left for his attack direction.
            const side = roleSide(slot.role);
            if (side !== 0) expect(Math.sign(p.z), `${home} v ${away} team ${team} ${Role[slot.role]}`).toBe(side * t.dir);
          }
        }
      }
    }
  });

  it('in-match formation switch (TAI-14 SET_FORMATION recipe) keeps one keeper and valid roles', () => {
    const out = new Array<number>(PLAYERS_PER_TEAM).fill(0);
    const natural = new Array<number>(PLAYERS_PER_TEAM).fill(-1);
    for (const from of IDS) {
      for (const to of IDS) {
        const s = build(from, from);
        const team = 0;
        const t = s.teams[team]!;
        const ps = teamPlayers(s, team);
        for (const p of ps) natural[p.formIdx] = s.squads[team]![p.rosterIdx]!.pos;
        const keeperIdx = s.players[t.keeperSlot]!.formIdx;
        remapFormation(from, to, natural, keeperIdx, out);
        for (const p of ps) {
          p.formIdx = out[p.formIdx]!;
          p.role = getFormation(to).slots[p.formIdx]!.role;
        }
        t.formation = to;
        const idx = ps.map((p) => p.formIdx).sort((a, b) => a - b);
        expect(idx).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(ps.filter((p) => p.role === Role.GK)).toHaveLength(1);
        expect(s.players[t.keeperSlot]!.formIdx).toBe(0);
        const w = { x: 0, z: 0 };
        for (const p of ps) {
          slotWorld(to, p.formIdx, t.dir, w);
          expect(Math.abs(w.x) < HALF_LENGTH && Math.abs(w.z) < HALF_WIDTH).toBe(true);
        }
      }
    }
  });

  it('a team down to ten re-balances in place: the empty slot is never a centre-back or the keeper', () => {
    const out = new Array<number>(PLAYERS_PER_TEAM).fill(0);
    for (const f of IDS) {
      const form = getFormation(f);
      for (let gone = 1; gone < PLAYERS_PER_TEAM; gone++) {
        const s = build(f, f);
        const team = 1;
        const ps = teamPlayers(s, team);
        ps[gone]!.active = 0; // sent off (RUL-10 parks him; the slot keeps its formIdx)
        const natural = ps.map((p) => (p.active ? s.squads[team]![p.rosterIdx]!.pos : -1));
        remapFormation(f, f, natural, 0, out);
        const emptyRole = form.slots[out[gone]!]!.role;
        expect(emptyRole === Role.CB || emptyRole === Role.GK, `${form.name} without slot ${gone}: empty ${Role[emptyRole]}`).toBe(false);
        // Every centre-back slot of the formation is held by an active player.
        form.slots.forEach((sl, j) => {
          if (sl.role !== Role.CB) return;
          const holder = ps.findIndex((_, i) => out[i] === j);
          expect(ps[holder]!.active, `${form.name} CB slot ${j}`).toBe(1);
        });
      }
    }
  });

  it('team state toggles feed the reference shape for both teams (mirrored by team.dir)', () => {
    const s = build(FormationId.F433, FormationId.F352);
    s.teams[1]!.teamPress = 1;
    const pt = { nx: 0, nz: 0 };
    for (let team = 0; team < 2; team++) {
      const t = s.teams[team]!;
      for (const p of teamPlayers(s, team)) {
        tacticalHome(t.formation, p.formIdx, t.phase, t.focus, tacticFlags(t), (s.ball.x * t.dir) / HALF_LENGTH, (s.ball.z * t.dir) / HALF_WIDTH, pt);
        const x = t.dir * pt.nx * HALF_LENGTH;
        const z = t.dir * pt.nz * HALF_WIDTH;
        expect(Number.isFinite(x) && Number.isFinite(z)).toBe(true);
        expect(Math.abs(x) < HALF_LENGTH && Math.abs(z) < HALF_WIDTH).toBe(true);
        const side = roleSide(p.role);
        if (side !== 0) expect(Math.sign(z)).toBe(side * t.dir);
      }
    }
  });

  it('the real pipeline runs with every formation (kick-off and a few seconds of play, core invariants)', () => {
    for (const f of IDS) {
      const away = IDS[(f + 3) % IDS.length]!;
      const s = makeScenario({
        clubs: CLUBS, seed: 11 + f, phase: MatchPhase.KICK_OFF,
        config: { homeClub: f, awayClub: away, homeFormation: f, awayFormation: away },
      });
      expect(() => runTicks(s, 240, undefined, { check: 'core' }), getFormation(f).name).not.toThrow();
    }
  });
});
