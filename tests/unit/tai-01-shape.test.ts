/**
 * TAI-01: formations and home positions (src/ai/shape.ts). Direct calls of homePositionAt / updateShape on states
 * built with the scenario harness. Expectations are relative (orderings, monotonicity, mirroring, limits) so they
 * hold for any formation data DAT-04 authors.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  CENTRE_CIRCLE_RADIUS, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, PENALTY_AREA_DEPTH,
  PENALTY_AREA_HALF_WIDTH,
} from '../../src/contracts/constants';
import { FormationId, MatchPhase, RestartKind, Role, TacticalFocus, TeamPhase } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { T_AI } from '../../src/contracts/tuning';
import { FORMATIONS, ShapeLine, slotLine } from '../../src/data/formations';
import {
  BOX_SPOTS, createTacticParams, EXTRA_STRIKER_SHAPES, extraStrikerOverride, FOCUS_MODIFIERS, QUICK_TACTICS, resolveTactics,
  slotLineFor, slotRole, TacticFlag,
} from '../../src/data/tactics';
import { homePosition, homePositionAt, invalidateShape, lineGapMax, updateShape } from '../../src/ai/shape';
import { NULL_SINK } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { secondLastDefenderX } from '../../src/sim/core/query';
import { makeScenario } from '../harness/scenario';

const FORMS: FormationId[] = FORMATIONS.map((_, i) => i as FormationId);
const PHASES = [TeamPhase.BUILD_UP, TeamPhase.ATTACK, TeamPhase.DEFEND, TeamPhase.TRANSITION_ATTACK, TeamPhase.TRANSITION_DEFEND];
const FOCI = [TacticalFocus.DEFAULT, TacticalFocus.DEFENDING, TacticalFocus.ATTACKING];
const EPS = 1e-9;
const V_MAX = HALF_WIDTH - 1.5;
const U_MAX = HALF_LENGTH - 1;

const DEF_ROLES = [Role.RB, Role.CB, Role.LB];
const MID_ROLES = [Role.CDM, Role.CM, Role.CAM];
const FWD_ROLES = [Role.ST, Role.CF];
const RIGHT_ROLES = [Role.RB, Role.RWB, Role.RM, Role.RW];
const LEFT_ROLES = [Role.LB, Role.LWB, Role.LM, Role.LW];
const MIDFIELD_ROLES = [Role.CDM, Role.CM, Role.CAM, Role.RM, Role.LM, Role.RWB, Role.LWB];

interface Opts {
  form?: FormationId;
  phase?: TeamPhase;
  focus?: TacticalFocus;
  offside?: number;
  matchPhase?: MatchPhase;
}

/** Both teams in `form`, same team phase and focus; offside off unless asked (isolates the shape model). */
function scen(o: Opts = {}): SimState {
  const form = o.form ?? FormationId.F442;
  const s = makeScenario({
    phase: o.matchPhase ?? MatchPhase.IN_PLAY,
    config: { homeFormation: form, awayFormation: form, offside: o.offside ?? 0 },
  });
  for (let t = 0; t < 2; t++) {
    s.teams[t]!.phase = o.phase ?? TeamPhase.BUILD_UP;
    s.teams[t]!.focus = o.focus ?? TacticalFocus.DEFAULT;
  }
  return s;
}

interface H { x: number; z: number; u: number; v: number }

/** Homes of all 11 formation indices for `team` with the ball at team-frame (bu, bv). */
function homes(s: SimState, team: number, bu: number, bv: number): H[] {
  const dir = s.teams[team]!.dir;
  const out = { x: 0, z: 0 };
  const r: H[] = [];
  for (let f = 0; f < 11; f++) {
    homePositionAt(s, team, f, dir * bu, dir * bv, out);
    r.push({ x: out.x, z: out.z, u: dir * out.x, v: dir * out.z });
  }
  return r;
}

/** formIdx of the active outfield players of a team. */
function outfield(s: SimState, team: number): number[] {
  const r: number[] = [];
  for (let i = team * 11; i < team * 11 + 11; i++) {
    const p = s.players[i]!;
    if (p.active === 1 && p.isKeeper === 0) r.push(p.formIdx);
  }
  return r;
}

function role(form: FormationId, f: number): Role { return FORMATIONS[form]!.slots[f]!.role; }
function idxWithRoles(form: FormationId, roles: Role[]): number[] {
  const r: number[] = [];
  for (let f = 1; f < 11; f++) if (roles.includes(role(form, f))) r.push(f);
  return r;
}
function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function meanU(h: H[], idx: number[]): number { return mean(idx.map((f) => h[f]!.u)); }
function width(h: H[], idx: number[]): number {
  const vs = idx.map((f) => h[f]!.v);
  return Math.max(...vs) - Math.min(...vs);
}
function maxGap(h: H[], idx: number[]): number {
  const us = idx.map((f) => h[f]!.u).sort((a, b) => a - b);
  let g = 0;
  for (let i = 1; i < us.length; i++) g = Math.max(g, us[i]! - us[i - 1]!);
  return g;
}
function minPairDist(h: H[], idx: number[]): number {
  let d = Infinity;
  for (let i = 0; i < idx.length; i++) {
    for (let j = i + 1; j < idx.length; j++) {
      const a = h[idx[i]!]!, b = h[idx[j]!]!;
      d = Math.min(d, Math.hypot(a.u - b.u, a.v - b.v));
    }
  }
  return d;
}
function inOwnGoalArea(p: H): boolean {
  return p.u < -HALF_LENGTH + GOAL_AREA_DEPTH && Math.abs(p.v) < GOAL_AREA_HALF_WIDTH;
}

/** Mirror the whole state through the centre spot (positions, ball, both attack directions). */
function mirrorAll(s: SimState): void {
  for (const p of s.players) { p.x = -p.x; p.z = -p.z; }
  s.ball.x = -s.ball.x; s.ball.z = -s.ball.z;
  for (const t of s.teams) t.dir = -t.dir;
}

/** Remove a player from the pitch (as RUL-10 sendOff does for the shape's purposes). */
function sendOff(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  p.active = 0;
  p.x = 0; p.z = HALF_WIDTH + 5;
}

// ================================================================================================ base shape

describe('TAI-01 base shape of every formation', () => {
  it.each(FORMS)('formation %i: keeper deepest, defence < midfield < attack, flanks on their side, players apart', (form) => {
    for (const phase of PHASES) {
      const s = scen({ form, phase });
      const h = homes(s, 0, 0, 0);
      const of = outfield(s, 0);
      expect(h[0]!.u).toBeLessThan(Math.min(...of.map((f) => h[f]!.u)));
      expect(meanU(h, idxWithRoles(form, DEF_ROLES))).toBeLessThan(meanU(h, idxWithRoles(form, MID_ROLES)));
      expect(meanU(h, idxWithRoles(form, MID_ROLES))).toBeLessThan(meanU(h, idxWithRoles(form, FWD_ROLES)));
      for (const f of idxWithRoles(form, RIGHT_ROLES)) expect(h[f]!.v).toBeGreaterThan(3);
      for (const f of idxWithRoles(form, LEFT_ROLES)) expect(h[f]!.v).toBeLessThan(-3);
      expect(minPairDist(h, of)).toBeGreaterThan(3);
      // Ball in the middle: the keeper stands in front of his goal.
      expect(Math.abs(h[0]!.v)).toBeLessThanOrEqual(GOAL_HALF_WIDTH);
    }
  });

  it('every formation produces a different shape (formation data is used)', () => {
    const sigs = FORMS.map((form) => homes(scen({ form }), 0, 0, 0).map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`).join(';'));
    expect(new Set(sigs).size).toBe(FORMS.length);
  });

  it('an unknown formation id falls back to the first formation (like getFormation)', () => {
    const s = scen({ form: FormationId.F442 });
    const ref = homes(s, 0, 5, 5);
    s.teams[0]!.formation = 99 as FormationId;
    expect(homes(s, 0, 5, 5)).toEqual(ref);
  });

  it('homePosition reads the live ball and an invalid formIdx gives (0, 0)', () => {
    const s = scen();
    s.ball.x = 12; s.ball.z = -7;
    const a = { x: 0, z: 0 }, b = { x: 0, z: 0 };
    for (let f = 0; f < 11; f++) {
      homePosition(s, 0, f, a);
      homePositionAt(s, 0, f, 12, -7, b);
      expect(a).toEqual(b);
    }
    const o = { x: 9, z: 9 };
    homePosition(s, 0, -1, o); expect(o).toEqual({ x: 0, z: 0 });
    o.x = 9; homePosition(s, 0, 11, o); expect(o).toEqual({ x: 0, z: 0 });
    o.x = 9; homePosition(s, 0, 2.5, o); expect(o).toEqual({ x: 0, z: 0 });
  });
});

// ================================================================================================ mirroring

describe('TAI-01 mirroring by attack direction', () => {
  const BALLS: [number, number][] = [[0, 0], [20, 10], [-30, -25], [44, 30], [-50, 33], [10, -33]];

  it.each(FORMS)('formation %i: the same team attacking -x gets the exact mirror image (dir = -1)', (form) => {
    for (const phase of [...PHASES, TeamPhase.SET_PIECE]) {
      for (const focus of FOCI) {
        for (const offside of [0, 1]) {
          for (const [bx, bz] of BALLS) {
            const a = scen({ form, phase, focus, offside });
            a.teams[0]!.extraStriker = (bx > 0 ? 1 : 0);
            a.teams[0]!.getInBox = 1;
            a.ball.owner = bx > 30 ? 5 : -1;
            a.ball.x = bx; a.ball.z = bz;
            const b = scen({ form, phase, focus, offside });
            b.teams[0]!.extraStriker = a.teams[0]!.extraStriker;
            b.teams[0]!.getInBox = 1;
            b.ball.owner = a.ball.owner;
            b.ball.x = bx; b.ball.z = bz;
            mirrorAll(b);
            const pa = { x: 0, z: 0 }, pb = { x: 0, z: 0 };
            for (let f = 0; f < 11; f++) {
              homePositionAt(a, 0, f, a.ball.x, a.ball.z, pa);
              homePositionAt(b, 0, f, b.ball.x, b.ball.z, pb);
              expect(pb.x === -pa.x && pb.z === -pa.z, `${form}/${phase}/${focus}/${offside}/(${bx},${bz}) f${f}`).toBe(true);
            }
          }
        }
      }
    }
  });

  it.each(FORMS)('formation %i: the away team (dir = -1) mirrors the home team in the mirrored situation', (form) => {
    for (const phase of PHASES) {
      for (const [bx, bz] of BALLS) {
        const a = scen({ form, phase, offside: 1 });
        const b = scen({ form, phase, offside: 1 });
        // initMatch places both teams as exact mirror images of each other.
        for (let f = 0; f < 11; f++) {
          expect(b.players[11 + f]!.x).toBe(-a.players[f]!.x);
          expect(b.players[11 + f]!.z).toBe(-a.players[f]!.z);
        }
        const ha = homes(a, 0, bx, bz);
        const hb = homes(b, 1, bx, bz); // same team-frame ball => mirrored pitch ball
        for (let f = 0; f < 11; f++) {
          expect(hb[f]!.x === -ha[f]!.x && hb[f]!.z === -ha[f]!.z).toBe(true);
          expect(hb[f]!.u === ha[f]!.u).toBe(true);
        }
      }
    }
  });

  it('left/right symmetric formations give left/right symmetric shapes for a central ball', () => {
    for (const form of FORMS) {
      const slots = FORMATIONS[form]!.slots;
      const s = scen({ form, phase: TeamPhase.ATTACK });
      const h = homes(s, 0, 10, 0);
      for (let i = 1; i < 11; i++) {
        for (let j = 1; j < 11; j++) {
          if (slots[i]!.nx === slots[j]!.nx && slots[i]!.nz === -slots[j]!.nz) {
            expect(h[i]!.u).toBe(h[j]!.u);
            expect(h[i]!.v).toBeCloseTo(-h[j]!.v, 12);
          }
        }
      }
    }
  });
});

// ================================================================================================ ball shifts

describe('TAI-01 shifts with the ball', () => {
  it.each(FORMS)('formation %i: every home moves forward with ball x (block follows play vertically)', (form) => {
    for (const phase of PHASES) {
      for (const bv of [0, 20]) {
        const s = scen({ form, phase });
        const of = outfield(s, 0);
        let prev: H[] | null = null;
        for (let bu = -52; bu <= 52; bu += 2) {
          const h = homes(s, 0, bu, bv);
          if (prev) {
            for (const f of [0, ...of]) expect(h[f]!.u).toBeGreaterThanOrEqual(prev[f]!.u - EPS);
            if (bu > -30 && bu <= 35) expect(meanU(h, of)).toBeGreaterThan(meanU(prev, of));
          }
          prev = h;
        }
      }
    }
  });

  it.each(FORMS)('formation %i: the block slides toward the ball laterally and stays inside the touchlines', (form) => {
    for (const phase of PHASES) {
      for (const bu of [-35, 0, 30]) {
        const s = scen({ form, phase });
        const of = outfield(s, 0);
        let prev: H[] | null = null;
        for (let bv = -34; bv <= 34; bv += 2) {
          const h = homes(s, 0, bu, bv);
          for (const f of of) expect(Math.abs(h[f]!.v)).toBeLessThanOrEqual(V_MAX + EPS);
          if (prev) for (const f of [0, ...of]) expect(h[f]!.v).toBeGreaterThanOrEqual(prev[f]!.v - EPS);
          prev = h;
        }
        const mid = homes(s, 0, bu, 0), right = homes(s, 0, bu, 25), left = homes(s, 0, bu, -25);
        expect(mean(of.map((f) => right[f]!.v))).toBeGreaterThan(mean(of.map((f) => mid[f]!.v)) + 3);
        expect(mean(of.map((f) => left[f]!.v))).toBeLessThan(mean(of.map((f) => mid[f]!.v)) - 3);
      }
    }
  });

  it.each(FORMS)('formation %i: compactness - defending width shrinks when the ball is wide', (form) => {
    for (const phase of [TeamPhase.DEFEND, TeamPhase.TRANSITION_DEFEND]) {
      const s = scen({ form, phase });
      const of = outfield(s, 0);
      const central = width(homes(s, 0, 0, 0), of);
      for (const bv of [-30, -20, 20, 30]) expect(width(homes(s, 0, 0, bv), of)).toBeLessThan(central - 2);
      // Ball on the touchline: the ball-side players are squeezed in, not stacked on the line.
      const h = homes(s, 0, 0, 34);
      const ballSide = of.filter((f) => h[f]!.v > 15).map((f) => h[f]!.v).sort((a, b) => b - a);
      expect(ballSide[0]).toBeLessThanOrEqual(V_MAX + EPS);
      for (let i = 1; i < ballSide.length; i++) expect(ballSide[i - 1]! - ballSide[i]!).toBeGreaterThanOrEqual(0);
    }
  });

  it('Players: jitter - homes are bit-stable while the ball and players stand still', () => {
    for (const form of FORMS) {
      const s = scen({ form, phase: TeamPhase.DEFEND, offside: 1 });
      s.ball.x = 13.3; s.ball.z = -8.1;
      const recorded: string[] = [];
      for (let t = 0; t < 60; t++) {
        s.tick++;
        updateShape(s, 0, NULL_SINK);
        updateShape(s, 1, NULL_SINK);
        recorded.push(JSON.stringify([s.teams[0]!.homeX, s.teams[0]!.homeZ, s.teams[1]!.homeX, s.teams[1]!.homeZ]));
      }
      expect(new Set(recorded).size).toBe(1);
    }
  });
});

// ================================================================================================ phase and focus

describe('TAI-01 team phase and tactical focus', () => {
  const BALLS: [number, number][] = [[0, 0], [15, -10], [-20, 15]];

  it.each(FORMS)('formation %i: higher in attack/build-up, deeper when defending; wider in possession', (form) => {
    for (const [bu, bv] of BALLS) {
      const s = scen({ form });
      const of = outfield(s, 0);
      const at = (phase: TeamPhase): H[] => { s.teams[0]!.phase = phase; return homes(s, 0, bu, bv); };
      const buildUp = at(TeamPhase.BUILD_UP), attack = at(TeamPhase.ATTACK), defend = at(TeamPhase.DEFEND);
      const tAttack = at(TeamPhase.TRANSITION_ATTACK), tDefend = at(TeamPhase.TRANSITION_DEFEND);
      expect(meanU(attack, of)).toBeGreaterThan(meanU(buildUp, of));
      expect(meanU(buildUp, of)).toBeGreaterThan(meanU(defend, of));
      expect(meanU(defend, of)).toBeGreaterThan(meanU(tDefend, of));
      expect(meanU(tAttack, of)).toBeGreaterThan(meanU(defend, of));
      // Back line (deepest outfielder) follows the same order.
      const back = (h: H[]): number => Math.min(...of.map((f) => h[f]!.u));
      expect(back(attack)).toBeGreaterThan(back(buildUp));
      expect(back(buildUp)).toBeGreaterThan(back(defend));
      expect(back(defend)).toBeGreaterThan(back(tDefend));
      if (bv === 0) {
        expect(width(buildUp, of)).toBeGreaterThan(width(defend, of));
        expect(width(attack, of)).toBeGreaterThan(width(defend, of));
      }
    }
  });

  it('SET_PIECE: the restart team takes its possession shape, the other team defends', () => {
    for (const form of FORMS) {
      const s = scen({ form, matchPhase: MatchPhase.FREE_KICK });
      s.match.restart.kind = RestartKind.FREE_KICK;
      s.match.restart.team = 0;
      const of = outfield(s, 0);
      s.teams[0]!.phase = TeamPhase.ATTACK;
      const attack = homes(s, 0, 10, 0);
      s.teams[0]!.phase = TeamPhase.BUILD_UP;
      const buildUp = homes(s, 0, -30, 0);
      s.teams[0]!.phase = TeamPhase.DEFEND;
      const defend = homes(s, 0, 10, 0);
      s.teams[0]!.phase = TeamPhase.SET_PIECE;
      expect(homes(s, 0, 10, 0)).toEqual(attack);
      expect(homes(s, 0, -30, 0)).toEqual(buildUp);
      s.match.restart.team = 1;
      expect(homes(s, 0, 10, 0)).toEqual(defend);
      expect(meanU(attack, of)).toBeGreaterThan(meanU(defend, of));
    }
  });

  it('an unknown team phase or focus value falls back to build-up / default', () => {
    const s = scen();
    const ref = homes(s, 0, 7, 3);
    s.teams[0]!.phase = 42 as TeamPhase;
    s.teams[0]!.focus = 7 as TacticalFocus;
    expect(homes(s, 0, 7, 3)).toEqual(ref);
  });

  it.each(FORMS)('formation %i: DEFENDING focus is deeper and narrower, ATTACKING higher (and wider in possession)', (form) => {
    for (const phase of PHASES) {
      const inPossession = phase !== TeamPhase.DEFEND && phase !== TeamPhase.TRANSITION_DEFEND;
      for (const [bu, bv] of BALLS) {
        const s = scen({ form, phase });
        const of = outfield(s, 0);
        const at = (focus: TacticalFocus): H[] => { s.teams[0]!.focus = focus; return homes(s, 0, bu, bv); };
        const def = at(TacticalFocus.DEFAULT), dfn = at(TacticalFocus.DEFENDING), atk = at(TacticalFocus.ATTACKING);
        expect(meanU(dfn, of)).toBeLessThan(meanU(def, of) - 2);
        expect(meanU(atk, of)).toBeGreaterThan(meanU(def, of) + 2);
        if (bv === 0) {
          expect(width(dfn, of)).toBeLessThan(width(def, of));
          // DAT-04 FOCUS_MODIFIERS: ATTACKING widens in possession only (widthDefend = 1).
          if (inPossession) expect(width(atk, of)).toBeGreaterThan(width(def, of));
          else expect(width(atk, of)).toBeGreaterThanOrEqual(width(def, of) - EPS);
        }
      }
    }
  });

  it.each(FORMS)('formation %i: focus block push and widths are data/tactics FOCUS_MODIFIERS (one number for every module)', (form) => {
    const tp = createTacticParams();
    for (const phase of PHASES) {
      const inPossession = phase !== TeamPhase.DEFEND && phase !== TeamPhase.TRANSITION_DEFEND;
      const s = scen({ form, phase });
      const of = outfield(s, 0);
      const back = (h: H[]): number => Math.min(...of.map((f) => h[f]!.u));
      s.teams[0]!.focus = TacticalFocus.DEFAULT;
      const ref = homes(s, 0, 0, 0);
      for (const focus of [TacticalFocus.DEFENDING, TacticalFocus.ATTACKING]) {
        s.teams[0]!.focus = focus;
        const h = homes(s, 0, 0, 0);
        resolveTactics(focus, 0, tp);
        const push = (inPossession ? tp.pushAttackNx : tp.pushDefendNx) * HALF_LENGTH;
        const w = inPossession ? tp.widthAttack : tp.widthDefend;
        expect(push).toBeCloseTo(FOCUS_MODIFIERS[focus]!.pushNx * HALF_LENGTH, 12);
        expect(back(h) - back(ref), `${phase}/${focus}`).toBeCloseTo(push, 9);
        expect(width(h, of) / width(ref, of), `${phase}/${focus}`).toBeCloseTo(w, 9);
      }
    }
  });

  it.each(FORMS)('formation %i: team press pushes the block up out of possession by QUICK_TACTICS.teamPress.pushNx only', (form) => {
    for (const phase of [...PHASES, TeamPhase.SET_PIECE]) {
      for (const [bu, bv] of BALLS) {
        const s = scen({ form, phase, matchPhase: phase === TeamPhase.SET_PIECE ? MatchPhase.FREE_KICK : MatchPhase.IN_PLAY });
        s.match.restart.team = 1; // SET_PIECE: the other team restarts, we defend
        const of = outfield(s, 0);
        const back = (h: H[]): number => Math.min(...of.map((f) => h[f]!.u));
        const off = homes(s, 0, bu, bv);
        s.teams[0]!.teamPress = 1;
        const on = homes(s, 0, bu, bv);
        const defending = phase === TeamPhase.DEFEND || phase === TeamPhase.TRANSITION_DEFEND || phase === TeamPhase.SET_PIECE;
        if (!defending) { expect(on).toEqual(off); continue; }
        expect(back(on) - back(off), `${phase}/(${bu},${bv})`).toBeCloseTo(QUICK_TACTICS.teamPress.pushNx * HALF_LENGTH, 9);
        expect(meanU(on, of)).toBeGreaterThan(meanU(off, of) + 2);
      }
    }
    // Defending open play with TAI-04's line set: the back line stays on lineX (TAI-04 adds teamPress.lineNx itself).
    const s = scen({ form, phase: TeamPhase.DEFEND });
    s.teams[0]!.lineX = -20;
    const of = outfield(s, 0);
    s.teams[0]!.teamPress = 1;
    const h = homes(s, 0, 0, 0);
    expect(Math.min(...of.map((f) => h[f]!.u))).toBeCloseTo(-20, 9);
  });
});

// ================================================================================================ TAI-04 line

describe('TAI-01 defensive line from TAI-04 team.lineX', () => {
  function back(s: SimState, team: number, bu: number, bv: number): number {
    const h = homes(s, team, bu, bv);
    return Math.min(...outfield(s, team).map((f) => h[f]!.u));
  }

  it.each(FORMS)('formation %i: in defending phases the back line stands on lineX (both directions)', (form) => {
    for (const phase of [TeamPhase.DEFEND, TeamPhase.TRANSITION_DEFEND]) {
      for (const team of [0, 1]) {
        const s = scen({ form, phase });
        const dir = s.teams[team]!.dir;
        const own = back(s, team, 5, 0);
        for (const d of [-8, -3, 4, 9]) {
          s.teams[team]!.lineX = dir * (own + d);
          expect(back(s, team, 5, 0)).toBeCloseTo(own + d, 9);
        }
      }
    }
  });

  it('lineX is trusted only within 15 m of the own estimate and never inside the goal area', () => {
    const s = scen({ phase: TeamPhase.DEFEND });
    const own = back(s, 0, 0, 0);
    s.teams[0]!.lineX = own + 40;
    expect(back(s, 0, 0, 0)).toBeCloseTo(own + 15, 9);
    s.teams[0]!.lineX = -52;
    expect(back(s, 0, 0, 0)).toBeCloseTo(Math.max(own - 15, -HALF_LENGTH + GOAL_AREA_DEPTH + 0.5), 9);
    s.teams[0]!.lineX = -50;
    expect(back(s, 0, -45, 0)).toBeGreaterThanOrEqual(-HALF_LENGTH + GOAL_AREA_DEPTH + 0.5 - EPS);
  });

  it('lineX is ignored when unset (0), in possession phases and outside open play', () => {
    for (const phase of [TeamPhase.BUILD_UP, TeamPhase.ATTACK, TeamPhase.TRANSITION_ATTACK]) {
      const s = scen({ phase });
      const ref = homes(s, 0, 0, 0);
      s.teams[0]!.lineX = -5;
      expect(homes(s, 0, 0, 0)).toEqual(ref);
    }
    const s = scen({ phase: TeamPhase.DEFEND, matchPhase: MatchPhase.THROW_IN });
    const ref = homes(s, 0, 0, 0);
    s.teams[0]!.lineX = -5;
    expect(homes(s, 0, 0, 0)).toEqual(ref);
    const s2 = scen({ phase: TeamPhase.DEFEND });
    s2.teams[0]!.lineX = 0;
    const ref2 = homes(s2, 0, 0, 0);
    s2.teams[0]!.lineX = Number.NaN;
    expect(homes(s2, 0, 0, 0)).toEqual(ref2);
  });
});

// ================================================================================================ compactness

describe('TAI-01 compact lines', () => {
  const BALLS: [number, number][] = [[-48, 0], [-30, 25], [-10, -30], [0, 0], [12, 12], [25, -5], [40, 30], [50, -33]];

  // [INT-A] In possession the lines stretch (lineGapMax: up to 1.5 x T_AI.lineSpacingMax); out of possession they stay
  // within T_AI.lineSpacingMax (BRIEF §7 "out of possession: stay compact" / "in possession: stretch").
  it.each(FORMS)('formation %i: no gap between consecutive outfield depths exceeds the phase gap (T_AI.lineSpacingMax out of possession)', (form) => {
    let checked = 0;
    for (const phase of [...PHASES, TeamPhase.SET_PIECE]) {
      for (const focus of FOCI) {
        for (const extra of [0, 1]) {
          for (const missing of [[], [3], [6, 10], [2, 5, 9, 4]]) {
            for (const offside of [0, 1]) {
              const s = scen({ form, phase, focus, offside });
              s.teams[0]!.extraStriker = extra;
              for (const m of missing) sendOff(s, m);
              const of = outfield(s, 0);
              for (const [bu, bv] of BALLS) {
                const h = homes(s, 0, bu, bv);
                expect(maxGap(h, of), `${phase}/${focus}/${extra}/${missing}/(${bu},${bv})`).toBeLessThanOrEqual(lineGapMax(phase) + EPS);
                if (phase === TeamPhase.DEFEND || phase === TeamPhase.TRANSITION_DEFEND) expect(maxGap(h, of)).toBeLessThanOrEqual(T_AI.lineSpacingMax + EPS);
                checked++;
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('a stretched formation (long data shape) is compressed, keeping the line order', () => {
    const s = scen({ form: FormationId.F442, phase: TeamPhase.ATTACK, focus: TacticalFocus.ATTACKING });
    const h = homes(s, 0, 20, 0);
    const of = outfield(s, 0);
    expect(maxGap(h, of)).toBeLessThanOrEqual(lineGapMax(TeamPhase.ATTACK) + EPS);
    expect(meanU(h, idxWithRoles(FormationId.F442, FWD_ROLES))).toBeGreaterThan(meanU(h, idxWithRoles(FormationId.F442, MID_ROLES)));
  });
});

// ================================================================================================ quick tactics

describe('TAI-01 quick tactics', () => {
  /** formIdx DAT-04 / TAI-14 report as the extra striker: FWD line under EXTRA_STRIKER, another line without. */
  function dataStriker(form: FormationId): number {
    const r: number[] = [];
    for (let f = 1; f < 11; f++) {
      if (slotLine(form, f) !== ShapeLine.FWD && slotLineFor(form, f, TacticFlag.EXTRA_STRIKER) === ShapeLine.FWD) r.push(f);
    }
    expect(r).toHaveLength(1);
    return r[0]!;
  }
  const MID_FAMILY = [ShapeLine.DM, ShapeLine.MID, ShapeLine.AM];

  it('the DAT-04 extra striker of every formation (data check the shape relies on)', () => {
    expect(FORMS.map(dataStriker)).toEqual([6, 5, 8, 5, 7, 8]);
  });

  it.each(FORMS)('formation %i: extraStriker pushes exactly one midfielder into the forward line', (form) => {
    const es = dataStriker(form);
    for (const phase of [TeamPhase.BUILD_UP, TeamPhase.ATTACK, TeamPhase.TRANSITION_ATTACK]) {
      for (const [bu, bv] of [[0, 0], [15, 10], [-20, -10]] as [number, number][]) {
        const s = scen({ form, phase });
        const before = homes(s, 0, bu, bv);
        s.teams[0]!.extraStriker = 1;
        const after = homes(s, 0, bu, bv);
        const fwd = idxWithRoles(form, FWD_ROLES);
        const front = Math.max(...fwd.map((f) => after[f]!.u));
        const joined = (h: H[], frontU: number): number[] =>
          idxWithRoles(form, MIDFIELD_ROLES).filter((f) => Math.abs(h[f]!.u - frontU) <= 1.5);
        expect(joined(before, Math.max(...fwd.map((f) => before[f]!.u)))).toHaveLength(0);
        // Exactly one, and it is the formIdx every other module (slotRole / slotLineFor) treats as the striker.
        expect(joined(after, front), `${phase}/(${bu},${bv})`).toEqual([es]);
        // He takes a free lane in the front line: at least 4 m from every forward.
        for (const f of fwd) expect(Math.hypot(after[f]!.u - after[es]!.u, after[f]!.v - after[es]!.v)).toBeGreaterThan(4);
      }
    }
  });

  it.each(FORMS)('formation %i: with extraStriker the home lines agree with slotLineFor (TAI-04/05/06 view)', (form) => {
    for (const phase of [...PHASES, TeamPhase.SET_PIECE]) {
      for (const [bu, bv] of [[0, 0], [12, -15], [-25, 20]] as [number, number][]) {
        const s = scen({ form, phase });
        s.teams[0]!.extraStriker = 1;
        const h = homes(s, 0, bu, bv);
        const line = (f: number): ShapeLine => slotLineFor(form, f, TacticFlag.EXTRA_STRIKER);
        const of = outfield(s, 0);
        const fwdU = of.filter((f) => line(f) === ShapeLine.FWD).map((f) => h[f]!.u);
        const midU = of.filter((f) => MID_FAMILY.includes(line(f))).map((f) => h[f]!.u);
        const defU = of.filter((f) => line(f) === ShapeLine.DEF).map((f) => h[f]!.u);
        const tag = `${phase}/(${bu},${bv})`;
        expect(Math.min(...fwdU), tag).toBeGreaterThan(Math.max(...midU));
        expect(mean(midU), tag).toBeGreaterThan(mean(defU));
        // Every FWD-line player stands closer to the forward line than to the midfield line, and vice versa.
        const fwdMean = mean(fwdU), midMean = mean(midU);
        for (const u of fwdU) expect(Math.abs(u - fwdMean), tag).toBeLessThan(Math.abs(u - midMean));
        for (const u of midU) expect(Math.abs(u - midMean), tag).toBeLessThan(Math.abs(u - fwdMean));
      }
    }
  });

  it.each(FORMS)('formation %i: with a full side every EXTRA_STRIKER_SHAPES slot takes its DAT-04 position', (form) => {
    const s = scen({ form, phase: TeamPhase.BUILD_UP });
    const ref = homes(s, 0, 0, 0);
    s.teams[0]!.extraStriker = 1;
    const h = homes(s, 0, 0, 0);
    const list = EXTRA_STRIKER_SHAPES[form]!;
    const listed = new Set(list.map((o) => o.idx));
    // Unlisted slots keep their place laterally; listed ones keep the data's left/right order and centre line.
    for (let f = 1; f < 11; f++) if (!listed.has(f)) expect(h[f]!.v).toBeCloseTo(ref[f]!.v, 9);
    const base = FORMATIONS[form]!.slots;
    const scale = (ref[1]!.v - ref[4]!.v) / ((base[1]!.nz - base[4]!.nz) * HALF_WIDTH); // m per data metre (BUILD_UP width)
    for (const o of list) {
      expect(h[o.idx]!.v, `slot ${o.idx}`).toBeCloseTo(o.nz * HALF_WIDTH * scale, 6);
      expect(extraStrikerOverride(form, o.idx)).toBe(o);
      expect(slotRole(form, o.idx, TacticFlag.EXTRA_STRIKER)).toBe(o.role);
    }
  });

  it('extraStriker: 5-3-2 pushes formIdx 7 (the central CM, DAT-04 striker), not the right CM; midfield keeps both sides', () => {
    // Regression for the checker's case: ATTACK, ball on the centre spot, homePositionAt + slotLineFor.
    const s = scen({ form: FormationId.F532, phase: TeamPhase.ATTACK });
    s.teams[0]!.extraStriker = 1;
    const o = { x: 0, z: 0 };
    const h: { x: number; z: number }[] = [];
    for (let f = 0; f < 11; f++) { homePositionAt(s, 0, f, 0, 0, o); h.push({ x: o.x, z: o.z }); }
    const top = Math.max(h[9]!.x, h[10]!.x);
    expect(slotLineFor(FormationId.F532, 7, TacticFlag.EXTRA_STRIKER)).toBe(ShapeLine.FWD);
    expect(slotLineFor(FormationId.F532, 6, TacticFlag.EXTRA_STRIKER)).toBe(ShapeLine.MID);
    expect(Math.abs(h[7]!.x - top)).toBeLessThanOrEqual(1.5); // formIdx 7 is up front ...
    expect(Math.abs(h[7]!.z)).toBeLessThan(1); // ... centrally, between the two strikers
    expect(h[9]!.z).toBeGreaterThan(4);
    expect(h[10]!.z).toBeLessThan(-4);
    expect(h[6]!.x).toBeLessThan(top - 8); // formIdx 6 stays a midfielder ...
    expect(h[8]!.x).toBeLessThan(top - 8);
    expect(h[6]!.z).toBeGreaterThan(3); // ... and the right of midfield is not left empty
    expect(h[8]!.z).toBeLessThan(-3);
  });

  it.each(FORMS)('formation %i: out of possession the extra striker stays half way up', (form) => {
    const es = dataStriker(form);
    for (const phase of [TeamPhase.DEFEND, TeamPhase.TRANSITION_DEFEND]) {
      const s = scen({ form, phase });
      const before = homes(s, 0, 0, 0);
      s.teams[0]!.extraStriker = 1;
      const after = homes(s, 0, 0, 0);
      const gain = (f: number): number => after[f]!.u - before[f]!.u;
      expect(gain(es)).toBeGreaterThan(2);
      for (const f of idxWithRoles(form, MIDFIELD_ROLES)) if (f !== es) expect(gain(f)).toBeLessThan(gain(es) / 2);
      const front = Math.max(...idxWithRoles(form, FWD_ROLES).map((f) => after[f]!.u));
      expect(after[es]!.u).toBeLessThan(front - 1);
    }
  });

  it('extraStriker playing short: the DAT-04 striker goes up while he still plays in midfield', () => {
    // 5-3-2 without a striker: still 5-3-1 (no rebalancing); formIdx 7 joins the lone striker.
    const s = scen({ form: FormationId.F532, phase: TeamPhase.ATTACK });
    sendOff(s, 10);
    s.teams[0]!.extraStriker = 1;
    const h = homes(s, 0, 0, 0);
    expect(Math.abs(h[7]!.u - h[9]!.u)).toBeLessThanOrEqual(1.5);
    expect(Math.hypot(h[7]!.u - h[9]!.u, h[7]!.v - h[9]!.v)).toBeGreaterThan(4);
    expect(h[6]!.u).toBeLessThan(h[9]!.u - 8);
    expect(h[8]!.u).toBeLessThan(h[9]!.u - 8);
  });

  it('extraStriker playing short: without the DAT-04 striker in midfield the most central midfielder goes up', () => {
    // 5-3-2 minus the centre-back: formIdx 7 drops into the back five, striker 9 drops into the centre of
    // midfield. The tactic then pushes the most central midfielder (formIdx 9, a ST for slotRole) back up, not the
    // more advanced right CM (formIdx 6, which would empty the right of midfield).
    const s = scen({ form: FormationId.F532, phase: TeamPhase.ATTACK });
    sendOff(s, 3);
    const ref = homes(s, 0, 0, 0);
    const back = Math.min(...outfield(s, 0).map((f) => ref[f]!.u));
    expect(ref[7]!.u).toBeLessThanOrEqual(back + 3); // 7 plays in the back line
    expect(ref[9]!.u).toBeLessThan(ref[10]!.u - 8); // 9 plays in midfield
    expect(Math.abs(ref[9]!.v)).toBeLessThan(1);
    s.teams[0]!.extraStriker = 1;
    const h = homes(s, 0, 0, 0);
    const top = h[10]!.u;
    expect(Math.abs(h[9]!.u - top)).toBeLessThanOrEqual(1.5);
    expect(h[6]!.u).toBeLessThan(top - 8);
    expect(h[6]!.v).toBeGreaterThan(3);
    expect(h[8]!.v).toBeLessThan(-3);
    expect(h[7]!.u).toBe(ref[7]!.u); // the back line is not touched
  });

  /** Team 0 has the ball with `carrierIdx` at team-frame (bu, bv). */
  function crossing(form: FormationId, carrierIdx: number, bu: number, bv: number, getInBox: number, owner = carrierIdx): H[] {
    const s = scen({ form, phase: TeamPhase.ATTACK, offside: 1 });
    s.teams[0]!.getInBox = getInBox;
    s.ball.owner = owner;
    s.ball.x = bu; s.ball.z = bv;
    s.players[carrierIdx]!.x = bu; s.players[carrierIdx]!.z = bv;
    return homes(s, 0, bu, bv);
  }
  const inBox = (p: H): boolean => p.u >= HALF_LENGTH - PENALTY_AREA_DEPTH && Math.abs(p.v) <= PENALTY_AREA_HALF_WIDTH;

  it.each(FORMS)('formation %i: getInBox sends the wide players into the box when crossing', (form) => {
    for (const side of [1, -1]) {
      const carrier = 1; // right-back (or right centre-back) overlapping on the right ... mirrored for the left
      const carrierIdx = side > 0 ? carrier : idxWithRoles(form, DEF_ROLES).slice(-1)[0]!;
      const off = crossing(form, carrierIdx, 42, side * 26, 0);
      const on = crossing(form, carrierIdx, 42, side * 26, 1);
      const moved = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((f) => on[f]!.u !== off[f]!.u || on[f]!.v !== off[f]!.v);
      expect(moved.length).toBeGreaterThanOrEqual(1);
      expect(moved.length).toBeLessThanOrEqual(2);
      // Every moved player is a non-defender and ends inside the box; one attacks the far post side.
      for (const f of moved) {
        expect(DEF_ROLES.includes(role(form, f))).toBe(false);
        expect(inBox(on[f]!)).toBe(true);
      }
      expect(moved.some((f) => on[f]!.v * side < 0)).toBe(true);
      // ... and he was the widest far-side player.
      const far = moved.find((f) => on[f]!.v * side < 0)!;
      expect(FORMATIONS[form]!.slots[far]!.nz * side).toBeLessThan(-0.2);
    }
  });

  it('getInBox does nothing outside the crossing zone, without possession, or for the carrier', () => {
    for (const form of FORMS) {
      expect(crossing(form, 1, 10, 26, 1)).toEqual(crossing(form, 1, 10, 26, 0)); // not deep enough
      expect(crossing(form, 1, 42, 5, 1)).toEqual(crossing(form, 1, 42, 5, 0)); // central, not a crossing position
      expect(crossing(form, 1, 42, 26, 1, 12)).toEqual(crossing(form, 1, 42, 26, 0, 12)); // opponent has the ball
      expect(crossing(form, 1, 42, 26, 1, -1)).toEqual(crossing(form, 1, 42, 26, 0, -1)); // loose ball
    }
    // Carrier: in a 4-4-2 the right midfielder on the ball keeps his own home.
    const rm = idxWithRoles(FormationId.F442, [Role.RM])[0]!;
    const off = crossing(FormationId.F442, rm, 42, 26, 0);
    const on = crossing(FormationId.F442, rm, 42, 26, 1);
    expect(on[rm]).toEqual(off[rm]);
    const lm = idxWithRoles(FormationId.F442, [Role.LM])[0]!;
    expect(inBox(on[lm]!)).toBe(true);
  });

  it('getInBox targets are data/tactics BOX_SPOTS (far post, penalty spot), the spots TAI-03 box runners fill', () => {
    // BOX_SPOTS order: near post, far post, penalty spot, ... (nzSide is multiplied by the ball side).
    expect(BOX_SPOTS[1]!.nzSide).toBeLessThan(0);
    expect(BOX_SPOTS[2]!.nzSide).toBe(0);
    for (const side of [1, -1]) {
      // 4-4-2, right-back (or left-back) crossing, offside off: nothing clamps the spots.
      const carrierIdx = side > 0 ? 1 : 4;
      const s = scen({ form: FormationId.F442, phase: TeamPhase.ATTACK });
      s.teams[0]!.getInBox = 1;
      s.ball.owner = carrierIdx;
      s.players[carrierIdx]!.x = 44; s.players[carrierIdx]!.z = side * 28;
      const h = homes(s, 0, 44, side * 28);
      const far = idxWithRoles(FormationId.F442, [side > 0 ? Role.LM : Role.RM])[0]!;
      const near = idxWithRoles(FormationId.F442, [side > 0 ? Role.RM : Role.LM])[0]!;
      expect(h[far]!.u).toBeCloseTo(BOX_SPOTS[1]!.nx * HALF_LENGTH, 9);
      expect(h[far]!.v).toBeCloseTo(side * BOX_SPOTS[1]!.nzSide * HALF_WIDTH, 9);
      expect(h[near]!.u).toBeCloseTo(BOX_SPOTS[2]!.nx * HALF_LENGTH, 9);
      expect(Math.abs(h[near]!.v - side * BOX_SPOTS[2]!.nzSide * HALF_WIDTH)).toBeLessThan(T_AI.lineSpacingMax);
    }
  });

  it.each(FORMS)('formation %i: getInBox never stacks a box player on a team-mate\'s home (onside clamp included)', (form) => {
    let checked = 0;
    for (const offside of [0, 1]) {
      for (const extra of [0, 1]) {
        for (const side of [1, -1]) {
          for (const bu of [36, 42, 48]) {
            for (const bz of [22, 28, 33]) {
              const carrierIdx = side > 0 ? 1 : idxWithRoles(form, DEF_ROLES).slice(-1)[0]!;
              const s = scen({ form, phase: TeamPhase.ATTACK, offside });
              s.teams[0]!.getInBox = 1;
              s.teams[0]!.extraStriker = extra;
              s.ball.owner = carrierIdx;
              s.players[carrierIdx]!.x = bu; s.players[carrierIdx]!.z = side * bz;
              const off = homes(s, 0, bu, side * bz);
              const h = homes(s, 0, bu, side * bz);
              s.teams[0]!.getInBox = 0;
              const ref = homes(s, 0, bu, side * bz);
              const of = outfield(s, 0);
              const tag = `${offside}/${extra}/${side}/(${bu},${bz})`;
              // Onside ceiling (offside on): level with the ball or the second-last defender, minus the 0.7 m margin.
              const ceil = offside === 1 ? Math.max(s.teams[0]!.dir * secondLastDefenderX(s, 1), bu) - 0.7 : Infinity;
              expect(off).toEqual(h);
              expect(minPairDist(h, of), tag).toBeGreaterThanOrEqual(4 - 1e-9);
              // Only the box players move: into the box as deep as onside allows (with the ball on the box edge
              // they wait level with it, just outside), laterally within the box, never offside.
              let moved = 0;
              for (const f of of) {
                if (h[f]!.u === ref[f]!.u && h[f]!.v === ref[f]!.v) continue;
                moved++;
                expect(inBox(h[f]!) || h[f]!.u >= ceil - EPS, `${tag} f${f}`).toBe(true);
                expect(h[f]!.u, `${tag} f${f}`).toBeLessThanOrEqual(ceil + EPS);
                expect(Math.abs(h[f]!.v)).toBeLessThanOrEqual(PENALTY_AREA_HALF_WIDTH - 1 + EPS);
              }
              expect(moved, tag).toBeGreaterThanOrEqual(1);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBe(72);
  });
});

// ================================================================================================ playing short

describe('TAI-01 teams playing short', () => {
  function shortHomes(form: FormationId, out: number[], phase = TeamPhase.DEFEND, team = 0, bu = 0, bv = 0): { s: SimState; h: H[] } {
    const s = scen({ form, phase });
    for (const f of out) sendOff(s, team * 11 + f);
    return { s, h: homes(s, team, bu, bv) };
  }
  function checkSane(s: SimState, h: H[], team: number): void {
    const of = outfield(s, team);
    let keepers = 0;
    for (let i = team * 11; i < team * 11 + 11; i++) {
      const p = s.players[i]!;
      if (p.active !== 1) continue;
      const home = h[p.formIdx]!;
      if (p.isKeeper === 1) {
        keepers++;
        expect(Math.abs(home.v)).toBeLessThanOrEqual(GOAL_HALF_WIDTH);
        expect(home.u).toBeLessThan(-HALF_LENGTH + PENALTY_AREA_DEPTH);
      } else {
        expect(inOwnGoalArea(home)).toBe(false);
      }
    }
    expect(keepers).toBe(1);
    // Exactly one active player stands on the keeper home.
    const k = h[s.players[s.teams[team]!.keeperSlot]!.formIdx]!;
    expect(of.filter((f) => h[f]!.u === k.u && h[f]!.v === k.v)).toHaveLength(0);
    expect(minPairDist(h, of)).toBeGreaterThan(3);
    expect(maxGap(h, of)).toBeLessThanOrEqual(lineGapMax(s.teams[team]!.phase) + EPS);
    for (const f of of) {
      expect(Math.abs(h[f]!.v)).toBeLessThanOrEqual(V_MAX + EPS);
      expect(Math.abs(h[f]!.u)).toBeLessThanOrEqual(U_MAX + EPS);
    }
  }

  it('4-4-2 minus a centre-back plays 4-4-1: a midfielder drops in, a striker drops to midfield', () => {
    const { s, h } = shortHomes(FormationId.F442, [2]);
    checkSane(s, h, 0);
    const of = outfield(s, 0);
    const back = Math.min(...of.map((f) => h[f]!.u));
    expect(of.filter((f) => h[f]!.u <= back + 2)).toHaveLength(4); // four in the back line again
    const fwd = idxWithRoles(FormationId.F442, FWD_ROLES).filter((f) => of.includes(f));
    const top = Math.max(...of.map((f) => h[f]!.u));
    expect(of.filter((f) => h[f]!.u >= top - 2)).toHaveLength(1); // one striker left up front ...
    expect(Math.abs(h[of.find((f) => h[f]!.u === top)!]!.v)).toBeLessThan(1); // ... and central
    expect(fwd.length).toBe(2); // both strikers are still on the pitch; one now plays in midfield
  });

  it('4-3-3 minus a winger keeps two forwards and spreads them across the width', () => {
    const rw = idxWithRoles(FormationId.F433, [Role.RW])[0]!;
    const { s, h } = shortHomes(FormationId.F433, [rw], TeamPhase.BUILD_UP);
    checkSane(s, h, 0);
    const st = idxWithRoles(FormationId.F433, [Role.ST])[0]!, lw = idxWithRoles(FormationId.F433, [Role.LW])[0]!;
    const full = homes(scen({ form: FormationId.F433, phase: TeamPhase.BUILD_UP }), 0, 0, 0);
    expect(h[st]!.v).toBeGreaterThan(full[st]!.v + 3); // the striker shifts toward the empty right side
    expect(h[lw]!.v).toBeGreaterThan(full[lw]!.v); // the left winger tucks in a little
    expect(h[st]!.v).toBeGreaterThan(0);
    expect(h[lw]!.v).toBeLessThan(0);
  });

  it('a lone striker after a red card plays central', () => {
    for (const form of [FormationId.F442, FormationId.F352, FormationId.F532, FormationId.F41212]) {
      const st = idxWithRoles(form, FWD_ROLES);
      const { s, h } = shortHomes(form, [st[0]!], TeamPhase.ATTACK);
      checkSane(s, h, 0);
      expect(Math.abs(h[st[1]!]!.v)).toBeLessThan(1);
    }
  });

  it.each(FORMS)('formation %i: every single and double red card gives a sane, covered shape', (form) => {
    for (const team of [0, 1]) {
      for (let a = 1; a < 11; a++) {
        for (let b = a; b < 11; b++) {
          const out = a === b ? [a] : [a, b];
          for (const phase of [TeamPhase.BUILD_UP, TeamPhase.DEFEND]) {
            const { s, h } = shortHomes(form, out, phase, team, 5, -8);
            checkSane(s, h, team);
            const of = outfield(s, team);
            // The whole team still covers the width.
            expect(width(h, of)).toBeGreaterThan(30);
            if (phase !== TeamPhase.DEFEND) continue;
            // Defending, the (flat) back line keeps at least three players and covers most of the width.
            const back = Math.min(...of.map((f) => h[f]!.u));
            const line = of.filter((f) => h[f]!.u <= back + 3);
            expect(line.length, `${out}`).toBeGreaterThanOrEqual(3);
            expect(width(h, line)).toBeGreaterThan(15);
          }
        }
      }
    }
  });

  it.each(FORMS)('formation %i: down to seven players (four sent off) the shape stays sane', (form) => {
    const combos = [[1, 2, 3, 4], [5, 6, 7, 8], [7, 8, 9, 10], [2, 6, 9, 10], [1, 4, 5, 10]];
    for (const out of combos) {
      const { s, h } = shortHomes(form, out, TeamPhase.DEFEND, 0, -10, 10);
      checkSane(s, h, 0);
      expect(outfield(s, 0)).toHaveLength(6);
    }
  });

  it('keeper sent off: the outfielder who goes in goal gets the keeper home, the rest stretch', () => {
    for (const form of FORMS) {
      for (const goalie of [2, 5, 9]) {
        const s = scen({ form, phase: TeamPhase.DEFEND });
        sendOff(s, 0);
        const p = s.players[goalie]!;
        p.isKeeper = 1; p.role = Role.GK;
        s.teams[0]!.keeperSlot = goalie;
        const h = homes(s, 0, 20, 0);
        checkSane(s, h, 0);
        expect(h[goalie]!.u).toBeLessThan(-HALF_LENGTH + 13);
        expect(outfield(s, 0)).toHaveLength(9);
      }
    }
  });

  it('bench keeper replaces an outfielder after a red card: the slot keeps its formIdx, the shape follows isKeeper', () => {
    const s = scen({ form: FormationId.F433, phase: TeamPhase.BUILD_UP });
    sendOff(s, 0); // keeper sent off
    const slot = 10; // the bench keeper comes on in place of formIdx 10
    s.players[slot]!.isKeeper = 1;
    s.teams[0]!.keeperSlot = slot;
    const h = homes(s, 0, 0, 0);
    checkSane(s, h, 0);
    expect(h[10]!.u).toBe(h[0]!.u); // keeper home on formIdx 10 (and on the vacant formIdx 0 entry)
    expect(h[10]!.v).toBe(h[0]!.v);
  });

  it('an outfielder holding the keeper formation index takes an outfield spot (no second keeper home)', () => {
    const s = scen({ form: FormationId.F442, phase: TeamPhase.DEFEND });
    // Keeper moved to formIdx 4's slot and an outfielder holds formIdx 0 (odd remap): both must be handled.
    s.players[0]!.isKeeper = 0;
    s.players[4]!.isKeeper = 1;
    s.teams[0]!.keeperSlot = 4;
    const h = homes(s, 0, 0, 0);
    checkSane(s, h, 0);
    expect(h[0]!.u).toBeGreaterThan(-HALF_LENGTH + GOAL_AREA_DEPTH);
    expect(h[4]!.u).toBeLessThan(-HALF_LENGTH + 13);
  });

  it('a team without any keeper flag still gives exactly one keeper home (formIdx 0)', () => {
    const s = scen({ form: FormationId.F4231, phase: TeamPhase.BUILD_UP });
    s.players[0]!.isKeeper = 0;
    const h = homes(s, 0, 0, 0);
    const keeperLike = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((f) => h[f]!.u < -HALF_LENGTH + 13 && Math.abs(h[f]!.v) <= GOAL_HALF_WIDTH);
    expect(keeperLike).toEqual([0]);
  });

  it('short-handed shapes are deterministic and independent of slot order', () => {
    const a = shortHomes(FormationId.F352, [6, 9]).h;
    const b = shortHomes(FormationId.F352, [6, 9]).h;
    expect(a).toEqual(b);
  });
});

// ================================================================================================ clamps

describe('TAI-01 clamps', () => {
  const BALLS: [number, number][] = [[-52.5, 0], [-52.5, 34], [-52.5, -34], [52.5, 34], [52.5, -34], [-47, 3], [0, 34], [52, 0]];

  it.each(FORMS)('formation %i: homes stay inside the pitch; outfielders never in their own goal area', (form) => {
    for (const phase of [...PHASES, TeamPhase.SET_PIECE]) {
      for (const focus of FOCI) {
        const s = scen({ form, phase, focus, offside: 1 });
        s.teams[0]!.extraStriker = 1;
        s.teams[0]!.getInBox = 1;
        s.ball.owner = 5;
        s.teams[0]!.lineX = -51; // bogus TAI-04 value
        for (const [bu, bv] of BALLS) {
          const h = homes(s, 0, bu, bv);
          for (let f = 0; f < 11; f++) {
            expect(Number.isFinite(h[f]!.x) && Number.isFinite(h[f]!.z)).toBe(true);
            expect(Math.abs(h[f]!.u)).toBeLessThanOrEqual(U_MAX + EPS);
            expect(Math.abs(h[f]!.v)).toBeLessThanOrEqual(V_MAX + EPS);
          }
          for (const f of outfield(s, 0)) expect(inOwnGoalArea(h[f]!), `${phase}/${focus}/(${bu},${bv}) f${f}`).toBe(false);
          expect(h[0]!.u).toBeLessThan(-HALF_LENGTH + PENALTY_AREA_DEPTH);
          expect(Math.abs(h[0]!.v)).toBeLessThanOrEqual(GOAL_HALF_WIDTH);
        }
      }
    }
  });

  it('non-finite ball coordinates are treated as the centre spot', () => {
    const s = scen();
    expect(homes(s, 0, Number.NaN, Number.POSITIVE_INFINITY)).toEqual(homes(s, 0, 0, 0));
  });

  it('offside on: nobody stands beyond the second-last defender unless level with the ball or in his own half', () => {
    for (const form of FORMS) {
      const s = scen({ form, phase: TeamPhase.ATTACK, focus: TacticalFocus.ATTACKING, offside: 1 });
      // Opponents (attack -x, so they defend the goal at +x) hold a high line at x = 8; their keeper is deeper.
      for (let i = 12; i < 22; i++) s.players[i]!.x = 8 - (i - 12) * 0.5;
      s.players[11]!.x = 50;
      const line = 8; // second-last defender (the keeper is last)
      for (const bu of [-20, 0, 5]) {
        const h = homes(s, 0, bu, 0);
        for (const f of outfield(s, 0)) expect(h[f]!.u).toBeLessThanOrEqual(line - 0.5);
      }
      const ahead = homes(s, 0, 25, 0); // ball beyond the line: level with the ball is onside
      for (const f of outfield(s, 0)) expect(ahead[f]!.u).toBeLessThanOrEqual(25 - 0.5);
      expect(Math.max(...outfield(s, 0).map((f) => ahead[f]!.u))).toBeGreaterThan(line);
      // Opponents deep in our half: our players may still use their own half.
      for (let i = 12; i < 22; i++) s.players[i]!.x = -30;
      const deep = homes(s, 0, -35, 0);
      expect(Math.max(...outfield(s, 0).map((f) => deep[f]!.u))).toBeGreaterThan(-30);
      for (const f of outfield(s, 0)) expect(deep[f]!.u).toBeLessThanOrEqual(0);
      // Offside off: the forwards may stay beyond the line.
      s.config.offside = 0;
      for (let i = 12; i < 22; i++) s.players[i]!.x = 8;
      expect(Math.max(...outfield(s, 0).map((f) => homes(s, 0, 5, 0)[f]!.u))).toBeGreaterThan(line);
    }
  });

  it('the onside ceiling is sim/core/query secondLastDefenderX (both teams, both directions, sent-off opponents ignored)', () => {
    let binding = 0;
    for (const form of FORMS) {
      for (const swap of [false, true]) {
        const s = scen({ form, phase: TeamPhase.ATTACK, focus: TacticalFocus.ATTACKING, offside: 1 });
        // Scattered opponents (deterministic), one of them sent off far up the pitch.
        for (let i = 0; i < 22; i++) {
          s.players[i]!.x = ((i * 37) % 61) - 30 + 0.25;
          s.players[i]!.z = ((i * 23) % 41) - 20 + 0.5;
        }
        sendOff(s, 15);
        s.players[15]!.x = 51; // inactive: must not count for the offside line
        sendOff(s, 4);
        s.players[4]!.x = -51;
        if (swap) mirrorAll(s);
        for (let team = 0; team < 2; team++) {
          const dir = s.teams[team]!.dir;
          const lineU = dir * secondLastDefenderX(s, 1 - team);
          for (const bu of [-12.5, 3.25, 20.5]) {
            const tag = `${form}/${swap}/${team}/${bu}`;
            const of = outfield(s, team);
            s.config.offside = 0;
            const free = homes(s, team, bu, 7.5);
            s.config.offside = 1;
            const h = homes(s, team, bu, 7.5);
            const ceil = Math.max(lineU, bu, 0) - 0.7;
            // The clamp is the last step: every home is its offside-off value capped at the ceiling.
            for (const f of of) expect(h[f]!.u, `${tag} f${f}`).toBeCloseTo(Math.min(free[f]!.u, ceil), 9);
            if (Math.max(...of.map((f) => free[f]!.u)) > ceil + 1) binding++;
          }
        }
      }
    }
    expect(binding).toBeGreaterThan(10); // the ceiling really cuts in for many of the cases
  });

  it('KICK_OFF: everybody in his own half, the defending side outside the centre circle', () => {
    for (const form of FORMS) {
      for (const kicking of [0, 1]) {
        const s = scen({ form, phase: TeamPhase.ATTACK, focus: TacticalFocus.ATTACKING, matchPhase: MatchPhase.KICK_OFF });
        s.match.restart.kind = RestartKind.KICK_OFF;
        s.match.restart.team = kicking;
        s.teams[0]!.extraStriker = 1;
        for (const team of [0, 1]) {
          const h = homes(s, team, 0, 0);
          for (const f of outfield(s, team)) {
            expect(h[f]!.u).toBeLessThanOrEqual(-0.5 + EPS);
            if (team !== kicking) expect(Math.hypot(h[f]!.u, h[f]!.v)).toBeGreaterThanOrEqual(CENTRE_CIRCLE_RADIUS + 0.5 - 1e-6);
          }
        }
      }
    }
  });
});

// ================================================================================================ updates

describe('TAI-01 updateShape: staggering, writes, determinism', () => {
  function stepShape(s: SimState): void {
    s.tick++;
    updateShape(s, 0, NULL_SINK);
    updateShape(s, 1, NULL_SINK);
  }

  it('team 0 and team 1 recompute every shapeInterval ticks, offset by half an interval', () => {
    const s = scen({ phase: TeamPhase.DEFEND });
    const I = T_AI.shapeInterval;
    const updates: [number[], number[]] = [[], []];
    const last = [JSON.stringify(s.teams[0]!.homeX), JSON.stringify(s.teams[1]!.homeX)];
    for (let t = 0; t < 10 * I; t++) {
      s.ball.x = -30 + t * 0.7; // moving ball: every recompute changes the homes
      stepShape(s);
      for (const team of [0, 1]) {
        const now = JSON.stringify(s.teams[team]!.homeX);
        if (now !== last[team]) updates[team]!.push(s.tick);
        last[team] = now;
      }
    }
    // First call updates at once (shapeT starts at 0); then on the team's grid.
    expect(updates[0]![0]).toBe(1);
    expect(updates[1]![0]).toBe(1);
    const grid0 = updates[0]!.slice(1), grid1 = updates[1]!.slice(1);
    for (const t of grid0) expect(t % I).toBe(0);
    for (const t of grid1) expect(t % I).toBe(I >> 1);
    for (let i = 1; i < grid0.length; i++) expect(grid0[i]! - grid0[i - 1]!).toBe(I);
    for (let i = 1; i < grid1.length; i++) expect(grid1[i]! - grid1[i - 1]!).toBe(I);
    expect(grid0.length).toBeGreaterThanOrEqual(9);
    expect(grid1.length).toBeGreaterThanOrEqual(9);
  });

  it('shapeT counts down between updates and the result equals homePosition at the update tick', () => {
    const s = scen({ phase: TeamPhase.ATTACK });
    s.ball.x = 11; s.ball.z = -4;
    stepShape(s); // tick 1: update
    const o = { x: 0, z: 0 };
    for (let f = 0; f < 11; f++) {
      homePosition(s, 0, f, o);
      expect(s.teams[0]!.homeX[f]).toBe(o.x);
      expect(s.teams[0]!.homeZ[f]).toBe(o.z);
    }
    const t0 = s.teams[0]!.shapeT;
    expect(t0).toBeGreaterThanOrEqual(1);
    expect(t0).toBeLessThanOrEqual(T_AI.shapeInterval);
    if (t0 > 1) { stepShape(s); expect(s.teams[0]!.shapeT).toBe(t0 - 1); }
  });

  it('invalidateShape forces a recompute on the next call', () => {
    const s = scen({ phase: TeamPhase.DEFEND });
    stepShape(s);
    stepShape(s);
    const before = JSON.stringify(s.teams[0]!.homeX);
    s.teams[0]!.focus = TacticalFocus.ATTACKING;
    if (s.teams[0]!.shapeT > 1) {
      stepShape(s);
      expect(JSON.stringify(s.teams[0]!.homeX)).toBe(before); // not yet: staggered
    }
    invalidateShape(s, 0);
    stepShape(s);
    expect(JSON.stringify(s.teams[0]!.homeX)).not.toBe(before);
  });

  it('a half-time direction swap recomputes at once (no homes in the wrong half)', () => {
    const s = scen({ phase: TeamPhase.DEFEND, matchPhase: MatchPhase.KICK_OFF });
    stepShape(s);
    stepShape(s);
    mirrorAll(s);
    stepShape(s);
    for (const team of [0, 1]) {
      const t = s.teams[team]!;
      for (let f = 0; f < 11; f++) expect(t.homeX[f]! * t.dir).toBeLessThanOrEqual(0);
    }
  });

  it('writes team.homeX/homeZ per formIdx and copies them to each active player by p.formIdx (every tick)', () => {
    const s = scen({ phase: TeamPhase.BUILD_UP });
    // Formation indices are not tied to slot numbers (substitutions keep formIdx; a remap may shuffle them).
    s.players[9]!.formIdx = 10; s.players[10]!.formIdx = 9;
    s.players[13]!.formIdx = 3; s.players[14]!.formIdx = 2;
    stepShape(s);
    for (let i = 0; i < 22; i++) {
      const p = s.players[i]!;
      const t = s.teams[p.team]!;
      expect(p.homeX).toBe(t.homeX[p.formIdx]);
      expect(p.homeZ).toBe(t.homeZ[p.formIdx]);
    }
    // Clobbered player homes (e.g. a substitute's fresh state) are restored on the next tick, update or not.
    s.players[3]!.homeX = 0; s.players[3]!.homeZ = 0;
    stepShape(s);
    expect(s.players[3]!.homeX).toBe(s.teams[0]!.homeX[3]);
    expect(s.players[3]!.homeZ).toBe(s.teams[0]!.homeZ[3]);
    // Inactive players are left alone.
    sendOff(s, 5);
    s.players[5]!.homeX = 123;
    stepShape(s);
    expect(s.players[5]!.homeX).toBe(123);
  });

  it('homePosition / homePositionAt are pure (state hash unchanged)', () => {
    const s = scen({ phase: TeamPhase.ATTACK, offside: 1 });
    s.teams[0]!.extraStriker = 1;
    sendOff(s, 6);
    const h0 = hashState(s);
    const o = { x: 0, z: 0 };
    for (let f = 0; f < 11; f++) { homePosition(s, 0, f, o); homePositionAt(s, 1, f, 30, 20, o); }
    expect(hashState(s)).toBe(h0);
  });

  it('identical states give identical homes and hashes over a long run (determinism)', () => {
    const run = (): number[] => {
      const s = scen({ form: FormationId.F4231, phase: TeamPhase.ATTACK, offside: 1 });
      const hashes: number[] = [];
      for (let t = 0; t < 600; t++) {
        s.ball.x = 40 * Math.sin(t / 50); s.ball.z = 30 * Math.cos(t / 37);
        s.teams[0]!.phase = (t >> 6) % 5; s.teams[1]!.phase = ((t >> 6) + 2) % 5;
        if (t === 300) sendOff(s, 7);
        stepShape(s);
        hashes.push(hashState(s));
      }
      return hashes;
    };
    expect(run()).toEqual(run());
  });
});

// ================================================================================================ budget

describe('TAI-01 budget', () => {
  it('updateShape for both teams averages < 0.03 ms per tick (staggered), a full recompute < 0.03 ms', () => {
    const s = scen({ form: FormationId.F352, phase: TeamPhase.ATTACK, offside: 1 });
    s.teams[0]!.extraStriker = 1;
    sendOff(s, 4);
    const ticks = 6000;
    const bench = (): number => {
      const t0 = performance.now();
      for (let t = 0; t < ticks; t++) {
        s.ball.x = ((t * 7) % 100) - 50; s.ball.z = ((t * 3) % 60) - 30;
        s.tick++;
        updateShape(s, 0, NULL_SINK);
        updateShape(s, 1, NULL_SINK);
      }
      return (performance.now() - t0) / ticks;
    };
    bench();
    let best = Infinity;
    for (let i = 0; i < 5; i++) best = Math.min(best, bench());
    expect(best).toBeLessThan(0.03);
    // Worst case: both teams recompute in the same tick.
    const o = { x: 0, z: 0 };
    const full = (): number => {
      const t0 = performance.now();
      for (let t = 0; t < 2000; t++) { homePositionAt(s, 0, 3, t % 50, 0, o); homePositionAt(s, 1, 3, t % 50, 0, o); }
      return (performance.now() - t0) / 2000;
    };
    full();
    let bestFull = Infinity;
    for (let i = 0; i < 5; i++) bestFull = Math.min(bestFull, full());
    expect(bestFull).toBeLessThan(0.03);
  });

  it('updateShape and homePositionAt allocate nothing per call', () => {
    const code = `
      const { createMatchConfig } = await import('./src/contracts/state.ts');
      const { initMatch } = await import('./src/sim/init.ts');
      const { updateShape, homePositionAt } = await import('./src/ai/shape.ts');
      const { NULL_SINK } = await import('./src/sim/core/events.ts');
      const cfg = createMatchConfig();
      cfg.humans = [{ kind: 0, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 }, { kind: 0, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 }];
      cfg.homeFormation = 3;
      cfg.offside = 1;
      const s = initMatch(cfg);
      s.match.phase = 2; s.teams[0].extraStriker = 1; s.teams[0].getInBox = 1; s.teams[1].teamPress = 1; s.ball.owner = 5;
      s.teams[1].lineX = 10.37;
      s.players[6].active = 0;
      for (const p of s.players) { p.x += 0.123; p.z += 0.0371; } // non-integer numbers, as in a real match
      const o = { x: 0, z: 0 };
      // Non-integer ball coordinates: V8 boxes such numbers whenever they cross a call that is not inlined.
      const loop = (n) => { for (let i = 0; i < n; i++) { s.tick++; s.ball.x = ((i * 7) % 100) - 50.25; s.ball.z = ((i * 3) % 60) - 30.125;
        s.teams[0].phase = i % 6; s.teams[1].phase = (i >> 1) % 6; updateShape(s, 0, NULL_SINK); updateShape(s, 1, NULL_SINK);
        homePositionAt(s, 0, i % 11, 40.5, 25.25, o); homePositionAt(s, 1, i % 11, -44.5, 27.75, o); } };
      loop(200000); // warm-up: optimisation and feedback allocate once
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        globalThis.gc();
        const h0 = process.memoryUsage().heapUsed;
        loop(100000);
        best = Math.min(best, (process.memoryUsage().heapUsed - h0) / 100000);
      }
      console.log(JSON.stringify({ perCall: best }));
    `;
    // [TUN-7S] --single-threaded: synchronous compilation, load-independent bytes (tests/perf/qf-7r-alloc-flags.ts).
    const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const { perCall } = JSON.parse(r.stdout.trim().split('\n').pop()!) as { perCall: number };
    expect(perCall).toBeLessThan(1);
  }, 150_000);
});
