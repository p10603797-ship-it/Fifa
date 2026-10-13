/**
 * TAI-14 commands and per-tick upkeep: every Command changes the team state it documents and emits TACTIC
 * (a = team, b = Command, c = resulting value); refused commands change nothing and emit nothing; SET_FORMATION
 * re-maps the 11 slots with one keeper and valid roles for every formation pair (full sides, short sides, a
 * replaced keeper, corrupt indices); SWAP_POSITIONS; tacticsTick keeps the fields valid and expires the per-corner
 * tactic. Readers (data/tactics resolveTactics, TAI-01 shape) see the change.
 */
import '../../src/sim/actions/dispatch'; // load the action registry before the keeper modules (import-cycle order)
import { describe, expect, it } from 'vitest';
import { PLAYERS_PER_TEAM, teamFirstSlot } from '../../src/contracts/constants';
import { Command, Foot, FormationId, KitPattern, MatchPhase, Role, TacticalFocus, TeamStyle } from '../../src/contracts/enums';
import type { Club, PlayerData } from '../../src/contracts/data';
import { EventType } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { applyCommand, tacticsTick } from '../../src/ai/tactics';
import { homePositionAt } from '../../src/ai/shape';
import { createEventBuffer } from '../../src/sim/core/events';
import { FORMATIONS, formationSwitchMap, getFormation, remapFormation, roleFamiliarity } from '../../src/data/formations';
import { createTacticParams, resolveTactics, tacticFlags } from '../../src/data/tactics';
import { makeScenario } from '../harness/scenario';

const IDS = FORMATIONS.map((f) => f.id);

/** Squad member with natural role `pos` (clubs built from the formation data, as in DAT-04's scenario test). */
function member(i: number, pos: Role): PlayerData {
  const gk = pos === Role.GK;
  const o = gk ? 30 : 70;
  const g = gk ? 70 : 15;
  return {
    name: `Test ${i}`, short: `T${i}`, shirt: i + 1, pos, height: gk ? 190 : 180, foot: Foot.RIGHT, weakFoot: 3,
    skillMoves: 3, overall: 70, acceleration: o, sprintSpeed: o, agility: o, ballControl: o, dribbling: o,
    shortPassing: o, longPassing: o, crossing: o, vision: o, finishing: o, shotPower: o, longShots: o, curve: o,
    heading: o, standingTackle: o, slidingTackle: o, interceptions: o, strength: o, stamina: o, composure: o,
    gkDiving: g, gkHandling: g, gkReflexes: g, gkPositioning: g, gkKicking: g,
  };
}

/** One club per formation (club id = FormationId) whose starters' natural roles are that formation's slot roles. */
const CLUBS: Club[] = IDS.map((f) => {
  const squad = getFormation(f).slots.map((sl, i) => member(i, sl.role));
  [Role.GK, Role.CB, Role.RB, Role.CDM, Role.CM, Role.RW, Role.ST].forEach((r, k) => squad.push(member(PLAYERS_PER_TEAM + k, r)));
  const kit = { shirt: 0x3366cc, shirt2: 0xffffff, pattern: KitPattern.PLAIN, shorts: 0xffffff, socks: 0x3366cc, number: 0xffffff };
  return {
    id: f, name: `Club ${f}`, code: `C${String(f).padStart(2, '0')}`, city: 'Testville', rating: 75, style: TeamStyle.POSSESSION,
    formation: f, home: kit, away: { ...kit, shirt: 0xcc3333 }, keeper: { ...kit, shirt: 0x222222 }, keeper2: { ...kit, shirt: 0xeeee22 },
    crest: { shape: 0, primary: 0x3366cc, secondary: 0xffffff, emblem: 0, layout: 0 }, squad,
  };
});

interface Tactic { type: number; a: number; b: number; c: number }

/** Apply one command and return the TACTIC events it emitted. */
function cmd(s: SimState, team: number, c: Command, arg = 0): Tactic[] {
  const ev = createEventBuffer();
  ev.begin(s.tick);
  applyCommand(s, team, c, arg, ev);
  const out: Tactic[] = [];
  for (let i = 0; i < ev.count; i++) {
    const e = ev.get(i);
    out.push({ type: e.type, a: e.a, b: e.b, c: e.c });
  }
  return out;
}

function teamSlots(team: number): number[] {
  return Array.from({ length: PLAYERS_PER_TEAM }, (_, i) => teamFirstSlot(team) + i);
}

/** Snapshot of everything applyCommand may touch on a team (for "nothing changed" checks). */
function snap(s: SimState, team: number): string {
  const t = s.teams[team]!;
  const ps = teamSlots(team).map((i) => [s.players[i]!.formIdx, s.players[i]!.role, s.players[i]!.isKeeper]);
  return JSON.stringify([t.formation, t.focus, t.offsideTrap, t.teamPress, t.extraStriker, t.getInBox, t.cornerTactic, t.shapeT, ps]);
}

/** Formation-consistency check used after every remap. */
function expectValidLineup(s: SimState, team: number, label: string): void {
  const t = s.teams[team]!;
  const form = getFormation(t.formation);
  const active = teamSlots(team).filter((i) => s.players[i]!.active === 1);
  const idx = active.map((i) => s.players[i]!.formIdx);
  expect(new Set(idx).size, `${label}: unique formIdx ${idx}`).toBe(idx.length);
  for (const i of active) {
    const p = s.players[i]!;
    expect(Number.isInteger(p.formIdx) && p.formIdx >= 0 && p.formIdx < PLAYERS_PER_TEAM, `${label} slot ${i}`).toBe(true);
    if (p.isKeeper === 1) {
      expect(p.formIdx, `${label}: keeper index`).toBe(0);
      expect(p.role, `${label}: keeper role`).toBe(Role.GK);
    } else {
      expect(p.role, `${label}: slot ${i} role`).not.toBe(Role.GK);
      expect(p.role, `${label}: slot ${i} takes his slot's role`).toBe(form.slots[p.formIdx]!.role);
    }
  }
  expect(active.filter((i) => s.players[i]!.isKeeper === 1), `${label}: one keeper`).toHaveLength(1);
  expect(active.filter((i) => s.players[i]!.role === Role.GK), `${label}: one GK role`).toHaveLength(1);
}

describe('TAI-14 applyCommand: quick tactics, focus, corner tactics', () => {
  const quick: [Command, 'offsideTrap' | 'teamPress' | 'extraStriker' | 'getInBox'][] = [
    [Command.TACTIC_OFFSIDE_TRAP, 'offsideTrap'],
    [Command.TACTIC_TEAM_PRESS, 'teamPress'],
    [Command.TACTIC_EXTRA_STRIKER, 'extraStriker'],
    [Command.TACTIC_GET_IN_BOX, 'getInBox'],
  ];
  for (const [c, field] of quick) {
    it(`${Command[c]} toggles team.${field} on and off for either team, emits TACTIC and invalidates the shape`, () => {
      for (const team of [0, 1]) {
        const s = makeScenario({ phase: MatchPhase.IN_PLAY });
        const other = s.teams[1 - team]!;
        const before = snap(s, 1 - team);
        s.teams[team]!.shapeT = 5;
        expect(cmd(s, team, c)).toEqual([{ type: EventType.TACTIC, a: team, b: c, c: 1 }]);
        expect(s.teams[team]![field]).toBe(1);
        expect(s.teams[team]!.shapeT).toBe(0);
        expect(cmd(s, team, c)).toEqual([{ type: EventType.TACTIC, a: team, b: c, c: 0 }]);
        expect(s.teams[team]![field]).toBe(0);
        expect(snap(s, 1 - team)).toBe(before);
        expect(other[field]).toBe(0);
      }
    });
  }

  it('quick tactics are independent toggles: all four can be on together', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    for (const [c] of quick) cmd(s, 0, c);
    const t = s.teams[0]!;
    expect([t.offsideTrap, t.teamPress, t.extraStriker, t.getInBox]).toEqual([1, 1, 1, 1]);
  });

  it('focus commands set team.focus (value in the event)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const cases: [Command, TacticalFocus][] = [
      [Command.FOCUS_ATTACKING, TacticalFocus.ATTACKING], [Command.FOCUS_DEFENDING, TacticalFocus.DEFENDING],
      [Command.FOCUS_DEFAULT, TacticalFocus.DEFAULT],
    ];
    for (const team of [0, 1]) {
      for (const [c, f] of cases) {
        s.teams[team]!.shapeT = 4;
        expect(cmd(s, team, c)).toEqual([{ type: EventType.TACTIC, a: team, b: c, c: f }]);
        expect(s.teams[team]!.focus).toBe(f);
        expect(s.teams[team]!.shapeT).toBe(0);
      }
    }
  });

  it('corner tactic commands set team.cornerTactic to the command', () => {
    const s = makeScenario({ phase: MatchPhase.CORNER });
    for (const c of [Command.CORNER_FAR_POST, Command.CORNER_EDGE_OF_BOX, Command.CORNER_CROWD_KEEPER, Command.CORNER_NEAR_POST]) {
      expect(cmd(s, 1, c)).toEqual([{ type: EventType.TACTIC, a: 1, b: c, c }]);
      expect(s.teams[1]!.cornerTactic).toBe(c);
      expect(s.teams[0]!.cornerTactic).toBe(0);
    }
  });

  it('readers agree: team press / offside trap / focus feed data/tactics resolveTactics', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const tp = createTacticParams();
    const t = s.teams[0]!;
    resolveTactics(t.focus, tacticFlags(t), tp);
    const base = { pressers: tp.pressers, lineNx: tp.lineNx, trap: tp.trapStepM, runs: tp.maxRunners };
    cmd(s, 0, Command.TACTIC_TEAM_PRESS);
    cmd(s, 0, Command.TACTIC_OFFSIDE_TRAP);
    cmd(s, 0, Command.FOCUS_ATTACKING);
    resolveTactics(t.focus, tacticFlags(t), tp);
    expect(tp.pressers).toBeGreaterThan(base.pressers);
    expect(tp.lineNx).toBeGreaterThan(base.lineNx);
    expect(tp.trapStepM).toBeGreaterThan(base.trap);
    expect(tp.maxRunners).toBeGreaterThan(base.runs);
  });

  it('focus moves TAI-01 home positions: the back line stands higher attacking than defending (both directions)', () => {
    for (const team of [0, 1]) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, ball: { x: 0, z: 0 } });
      const dir = s.teams[team]!.dir;
      const out = { x: 0, z: 0 };
      cmd(s, team, Command.FOCUS_DEFENDING);
      homePositionAt(s, team, 2, 0, 0, out); // a centre-back in 4-4-2
      const uDef = dir * out.x;
      cmd(s, team, Command.FOCUS_ATTACKING);
      homePositionAt(s, team, 2, 0, 0, out);
      const uAtt = dir * out.x;
      expect(uAtt - uDef, `team ${team}`).toBeGreaterThan(3);
    }
  });
});

describe('TAI-14 applyCommand: SET_FORMATION', () => {
  it('every formation pair, both teams: one keeper (index 0, GK), a permutation of indices, slot roles, TACTIC', () => {
    for (const from of IDS) {
      for (const to of IDS) {
        for (const team of [0, 1]) {
          const s = makeScenario({ config: { homeFormation: from, awayFormation: from } });
          const label = `${getFormation(from).name} -> ${getFormation(to).name} team ${team}`;
          const ev = cmd(s, team, Command.SET_FORMATION, to);
          expect(ev, label).toEqual([{ type: EventType.TACTIC, a: team, b: Command.SET_FORMATION, c: to }]);
          expect(s.teams[team]!.formation).toBe(to);
          expectValidLineup(s, team, label);
          const idx = teamSlots(team).map((i) => s.players[i]!.formIdx).sort((a, b) => a - b);
          expect(idx, label).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
          expect(s.players[s.teams[team]!.keeperSlot]!.formIdx).toBe(0);
          expect(s.teams[1 - team]!.formation).toBe(from);
        }
      }
    }
  });

  it('sensible mapping: squads built for the formation follow the DAT-04 switch table, roles stay familiar', () => {
    for (const from of IDS) {
      for (const to of IDS) {
        const s = makeScenario({ clubs: CLUBS, config: { homeClub: from, homeFormation: from } });
        const label = `${getFormation(from).name} -> ${getFormation(to).name}`;
        const nat = teamSlots(0).map((i) => s.squads[0]![s.players[i]!.rosterIdx]!.pos);
        expect(nat, label).toEqual(getFormation(from).slots.map((sl) => sl.role));
        cmd(s, 0, Command.SET_FORMATION, to);
        expectValidLineup(s, 0, label);
        const map = formationSwitchMap(from, to);
        const fam = teamSlots(0).map((i, k) => {
          expect(s.players[i]!.formIdx, `${label} slot ${i}`).toBe(map[k]);
          return roleFamiliarity(nat[k]!, s.players[i]!.role);
        });
        expect(fam.reduce((a, b) => a + b, 0) / fam.length, label).toBeGreaterThanOrEqual(75);
        expect(Math.min(...fam), label).toBeGreaterThanOrEqual(45);
      }
    }
  });

  it('uses each player\'s natural role from his squad entry (not his current slot role)', () => {
    // Swap a natural centre-back and a natural striker on the pitch, then change formation: the remap must be the
    // one remapFormation gives for the real natural roles (which differs from the slot-role table for some targets).
    let differs = 0;
    for (const to of IDS) {
      const s = makeScenario({ clubs: CLUBS, config: { homeClub: FormationId.F442, homeFormation: FormationId.F442 } });
      expect(cmd(s, 0, Command.SWAP_POSITIONS, 2 | (9 << 8))).toHaveLength(1);
      const natural = new Array<number>(PLAYERS_PER_TEAM).fill(-1);
      for (const i of teamSlots(0)) natural[s.players[i]!.formIdx] = s.squads[0]![s.players[i]!.rosterIdx]!.pos;
      const old = teamSlots(0).map((i) => s.players[i]!.formIdx);
      const out = new Array<number>(PLAYERS_PER_TEAM).fill(0);
      remapFormation(FormationId.F442, to, natural, 0, out);
      if (to === FormationId.F442) continue; // same formation: nothing re-mapped (see below)
      const table = formationSwitchMap(FormationId.F442, to);
      if (old.some((f) => out[f] !== table[f])) differs++;
      cmd(s, 0, Command.SET_FORMATION, to);
      teamSlots(0).forEach((i, k) => expect(s.players[i]!.formIdx, `-> ${getFormation(to).name} slot ${i}`).toBe(out[old[k]!]));
      expectValidLineup(s, 0, `swapped -> ${getFormation(to).name}`);
    }
    expect(differs).toBeGreaterThan(0);
  });

  it('a short side (sent off) re-maps the active players; the vacant index is never the keeper or a centre-back', () => {
    for (const from of IDS) {
      for (const to of IDS) {
        if (from === to) continue;
        for (let gone = 1; gone < PLAYERS_PER_TEAM; gone += 3) {
          const s = makeScenario({ config: { homeFormation: from, awayFormation: from } });
          const team = 1;
          const off = teamFirstSlot(team) + gone;
          s.players[off]!.active = 0; // RUL-10 sendOff: slot inactive, keeps its formIdx
          s.teams[team]!.onPitch = 10;
          cmd(s, team, Command.SET_FORMATION, to);
          const label = `${getFormation(from).name} -> ${getFormation(to).name} without ${gone}`;
          expectValidLineup(s, team, label);
          const used = new Set(teamSlots(team).filter((i) => s.players[i]!.active === 1).map((i) => s.players[i]!.formIdx));
          const vacant = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((k) => !used.has(k));
          expect(vacant, label).toHaveLength(1);
          const vr = getFormation(to).slots[vacant[0]!]!.role;
          expect(vr === Role.GK || vr === Role.CB, `${label}: vacant ${Role[vr]}`).toBe(false);
          // The sent-off player follows the permutation onto the vacant index.
          expect(s.players[off]!.formIdx, label).toBe(vacant[0]);
        }
      }
    }
  });

  it('a replaced keeper (outfielder in goal, RUL-10 makeKeeper) keeps index 0 and GK; nobody else gets GK', () => {
    for (const to of IDS) {
      const s = makeScenario({ config: { homeFormation: FormationId.F433, awayFormation: FormationId.F433 } });
      const old = s.players[0]!;
      old.active = 0; old.isKeeper = 0; // sent off, still on formIdx 0
      const nk = s.players[5]!;
      nk.isKeeper = 1; nk.role = Role.GK; nk.formIdx = 0;
      s.teams[0]!.keeperSlot = 5;
      s.teams[0]!.onPitch = 10;
      cmd(s, 0, Command.SET_FORMATION, to === FormationId.F433 ? FormationId.F442 : to);
      expectValidLineup(s, 0, `keeper replaced -> ${to}`);
      expect(nk.formIdx).toBe(0);
      expect(nk.role).toBe(Role.GK);
    }
  });

  it('corrupt indices (duplicate / out of range) still end as a valid lineup', () => {
    const s = makeScenario({});
    s.players[3]!.formIdx = 2; // duplicate of slot 2
    s.players[7]!.formIdx = 42; // out of range
    s.players[8]!.formIdx = 0; // claims the keeper's index
    cmd(s, 0, Command.SET_FORMATION, FormationId.F352);
    expectValidLineup(s, 0, 'corrupt');
    const idx = teamSlots(0).map((i) => s.players[i]!.formIdx).sort((a, b) => a - b);
    expect(idx).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('the same formation re-maps nothing but is acknowledged; bad arguments are refused silently', () => {
    const s = makeScenario({ config: { homeFormation: FormationId.F4231 } });
    s.teams[0]!.shapeT = 3;
    const before = snap(s, 0);
    expect(cmd(s, 0, Command.SET_FORMATION, FormationId.F4231)).toEqual([
      { type: EventType.TACTIC, a: 0, b: Command.SET_FORMATION, c: FormationId.F4231 },
    ]);
    expect(snap(s, 0)).toBe(before);
    for (const bad of [-1, 6, 1.5, Number.NaN, 1e9, -0x7fffffff]) {
      expect(cmd(s, 0, Command.SET_FORMATION, bad), `arg ${bad}`).toEqual([]);
      expect(snap(s, 0)).toBe(before);
    }
  });
});

describe('TAI-14 applyCommand: SWAP_POSITIONS and refused commands', () => {
  it('swaps formIdx and role of two outfielders given by squad index', () => {
    const s = makeScenario({ config: { awayFormation: FormationId.F433 } });
    const a = s.players[11 + 2]!, b = s.players[11 + 9]!; // CB and ST of the away side
    const [fa, ra, fb, rb] = [a.formIdx, a.role, b.formIdx, b.role];
    const arg = a.rosterIdx | (b.rosterIdx << 8);
    s.teams[1]!.shapeT = 2;
    expect(cmd(s, 1, Command.SWAP_POSITIONS, arg)).toEqual([{ type: EventType.TACTIC, a: 1, b: Command.SWAP_POSITIONS, c: arg }]);
    expect([a.formIdx, a.role, b.formIdx, b.role]).toEqual([fb, rb, fa, ra]);
    expect(s.teams[1]!.shapeT).toBe(0);
  });

  it('refuses the keeper, the same player, unknown / inactive players and bad arguments', () => {
    const s = makeScenario({});
    s.players[4]!.active = 0;
    const before = snap(s, 0);
    for (const arg of [0 | (3 << 8), 3 | (3 << 8), 3 | (17 << 8), 3 | (4 << 8), -1, 0x10000, 2.5]) {
      expect(cmd(s, 0, Command.SWAP_POSITIONS, arg), `arg ${arg}`).toEqual([]);
      expect(snap(s, 0)).toBe(before);
    }
  });

  it('commands that are not tactics, a bad team or a finished match change nothing and emit nothing', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const b0 = snap(s, 0), b1 = snap(s, 1);
    for (const c of [Command.NONE, Command.QUICK_SUB, Command.SUBSTITUTE, Command.SKIP, 99 as Command, -3 as Command]) {
      expect(cmd(s, 0, c, 5)).toEqual([]);
    }
    for (const team of [-1, 2, 0.5, Number.NaN]) expect(cmd(s, team, Command.TACTIC_TEAM_PRESS)).toEqual([]);
    s.match.finished = 1;
    expect(cmd(s, 0, Command.TACTIC_TEAM_PRESS)).toEqual([]);
    expect(cmd(s, 1, Command.SET_FORMATION, FormationId.F532)).toEqual([]);
    expect([snap(s, 0), snap(s, 1)]).toEqual([b0, b1]);
  });
});

describe('TAI-14 tacticsTick', () => {
  const ev = createEventBuffer();

  it('leaves valid values alone (no shape invalidation)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const t = s.teams[0]!;
    Object.assign(t, { offsideTrap: 1, teamPress: 0, extraStriker: 1, getInBox: 0, focus: TacticalFocus.ATTACKING, cornerTactic: Command.CORNER_NEAR_POST, shapeT: 4 });
    const before = snap(s, 0);
    tacticsTick(s, 0, ev);
    expect(snap(s, 0)).toBe(before);
  });

  it('repairs corrupt tactic fields to what the readers assume and invalidates the shape', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const t = s.teams[1]!;
    Object.assign(t, { offsideTrap: 2, teamPress: Number.NaN, extraStriker: -1, getInBox: 0, focus: 7, formation: 9, cornerTactic: 3, shapeT: 4 });
    tacticsTick(s, 1, ev);
    expect([t.offsideTrap, t.teamPress, t.extraStriker, t.getInBox]).toEqual([1, 0, 1, 0]);
    expect(t.focus).toBe(TacticalFocus.DEFAULT);
    expect(t.formation).toBe(FormationId.F442);
    expect(t.cornerTactic).toBe(0);
    expect(t.shapeT).toBe(0);
  });

  it('corner tactic is temporary: kept through the corner, reset for the taking team when play resumes', () => {
    const s = makeScenario({ phase: MatchPhase.CORNER });
    s.match.restart.team = 0;
    cmd(s, 0, Command.CORNER_CROWD_KEEPER);
    cmd(s, 1, Command.CORNER_FAR_POST); // a defending side's pick for its own next corner
    for (let k = 0; k < 30; k++) {
      s.match.phaseT++;
      tacticsTick(s, 0, ev);
      tacticsTick(s, 1, ev);
    }
    expect(s.teams[0]!.cornerTactic).toBe(Command.CORNER_CROWD_KEEPER);
    // RUL-01 leaves the corner (CORNER -> IN_PLAY, phaseT 0, restart.kind NONE, restart.team kept); the next tick's
    // AI sees phaseT 1.
    Object.assign(s.match, { prevPhase: MatchPhase.CORNER, phase: MatchPhase.IN_PLAY, phaseT: 1 });
    tacticsTick(s, 0, ev);
    tacticsTick(s, 1, ev);
    expect(s.teams[0]!.cornerTactic).toBe(0);
    expect(s.teams[1]!.cornerTactic).toBe(Command.CORNER_FAR_POST);
    // A tactic picked later in play is kept for the next corner.
    cmd(s, 0, Command.CORNER_NEAR_POST);
    s.match.phaseT = 2;
    tacticsTick(s, 0, ev);
    expect(s.teams[0]!.cornerTactic).toBe(Command.CORNER_NEAR_POST);
  });

  it('a corner left any other way (re-award, period end) resets both teams', () => {
    const s = makeScenario({ phase: MatchPhase.CORNER });
    cmd(s, 0, Command.CORNER_EDGE_OF_BOX);
    cmd(s, 1, Command.CORNER_NEAR_POST);
    Object.assign(s.match, { prevPhase: MatchPhase.CORNER, phase: MatchPhase.FREE_KICK, phaseT: 0 });
    tacticsTick(s, 0, ev);
    tacticsTick(s, 1, ev);
    expect([s.teams[0]!.cornerTactic, s.teams[1]!.cornerTactic]).toEqual([0, 0]);
  });
});
