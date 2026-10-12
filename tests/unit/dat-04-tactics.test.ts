/** DAT-04: role presets, phase offsets, focus and quick-tactic modifiers, and the reference shape (tacticalHome). */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  CROSS_ZONE_DEPTH, CROSS_ZONE_MIN_Z, GOAL_AREA_DEPTH, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, PENALTY_AREA_DEPTH,
  PENALTY_AREA_HALF_WIDTH, PLAYERS_PER_TEAM,
} from '../../src/contracts/constants';
import { Command, FormationId, Role, TacticalFocus, TeamPhase } from '../../src/contracts/enums';
import { createTeamState } from '../../src/contracts/state';
import { T_AI } from '../../src/contracts/tuning';
import { FORMATIONS, ShapeLine, getFormation, getFormationMeta, mirrorRole, roleSide } from '../../src/data/formations';
import {
  BOX_SPOTS, EXTRA_STRIKER_SHAPES, FOCUS_MODIFIERS, PHASE_OFFSETS, QUICK_TACTICS, ROLE_PRESETS, TacticFlag,
  createTacticParams, extraStrikerOverride, focusForCommand, focusModifier, inCrossingZone, phaseOffset, pressIntensity,
  resolveTactics, rolePreset, slotLineFor, slotRole, tacticFlagForCommand, tacticFlags, tacticalHome, type RolePreset,
  type ShapePoint,
} from '../../src/data/tactics';

const ROOT = new URL('../..', import.meta.url).pathname;
const NUM_ROLES = 15;
const ROLES = Array.from({ length: NUM_ROLES }, (_, r) => r as Role);
const IDS = FORMATIONS.map((f) => f.id);
const PHASES = [TeamPhase.BUILD_UP, TeamPhase.ATTACK, TeamPhase.DEFEND, TeamPhase.TRANSITION_ATTACK, TeamPhase.TRANSITION_DEFEND, TeamPhase.SET_PIECE];
const FOCI = [TacticalFocus.DEFAULT, TacticalFocus.DEFENDING, TacticalFocus.ATTACKING];
const ALL_FLAGS = Array.from({ length: 16 }, (_, i) => i);
const OUT_OF_POSSESSION = new Set<TeamPhase>([TeamPhase.DEFEND, TeamPhase.TRANSITION_DEFEND]);
const BX = [-1, -0.8, -0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8, 1];
const BZ = [-1, -0.5, 0, 0.5, 1];
/** Phase with no push (neutral shape around the formation slots). */
const TacticPhaseNeutral = TeamPhase.SET_PIECE;

interface Shape { x: number[]; z: number[] }
const pt: ShapePoint = { nx: 0, nz: 0 };

/** Home positions in metres for a team attacking +x. */
function shape(f: FormationId, phase: TeamPhase, focus: TacticalFocus, flags: number, bnx: number, bnz: number): Shape {
  const x: number[] = [];
  const z: number[] = [];
  for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
    tacticalHome(f, i, phase, focus, flags, bnx, bnz, pt);
    x.push(pt.nx * HALF_LENGTH);
    z.push(pt.nz * HALF_WIDTH);
  }
  return { x, z };
}

const outfieldMean = (a: number[]): number => a.slice(1).reduce((s, v) => s + v, 0) / (a.length - 1);
const spread = (a: number[]): number => Math.max(...a.slice(1)) - Math.min(...a.slice(1));

/** Phase/ball combinations TAI-06 can produce: build-up only in the own third-ish, attack not from the own box. */
function realistic(phase: TeamPhase, bnx: number): boolean {
  if (phase === TeamPhase.BUILD_UP) return bnx <= -0.2;
  if (phase === TeamPhase.ATTACK) return bnx >= -0.5;
  return true;
}

function lineMeans(f: FormationId, flags: number, s: Shape): number[] {
  const means: number[] = [];
  for (let l = ShapeLine.DEF; l <= ShapeLine.FWD; l++) {
    let sum = 0;
    let n = 0;
    for (let i = 1; i < PLAYERS_PER_TEAM; i++) if (slotLineFor(f, i, flags) === l) { sum += s.x[i]!; n++; }
    if (n > 0) means.push(sum / n);
  }
  return means;
}

/** Largest empty band along the pitch length between consecutive outfielders (a "hole" in the block). */
function maxHole(s: Shape): number {
  const xs = s.x.slice(1).sort((a, b) => a - b);
  let h = 0;
  for (let k = 1; k < xs.length; k++) h = Math.max(h, xs[k]! - xs[k - 1]!);
  return h;
}

function minPairDistance(s: Shape): number {
  let d = Infinity;
  for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
    for (let j = i + 1; j < PLAYERS_PER_TEAM; j++) d = Math.min(d, Math.hypot(s.x[i]! - s.x[j]!, s.z[i]! - s.z[j]!));
  }
  return d;
}

describe('DAT-04 tactics: role presets', () => {
  it('a preset for every Role, indexed by Role', () => {
    expect(ROLE_PRESETS).toHaveLength(NUM_ROLES);
    for (const r of ROLES) {
      expect(ROLE_PRESETS[r]!.role).toBe(r);
      expect(rolePreset(r)).toBe(ROLE_PRESETS[r]);
    }
    expect(rolePreset(77 as Role).role).toBe(Role.CM);
  });

  it('every number is finite and inside its documented range', () => {
    const unit = (v: number): boolean => Number.isFinite(v) && v >= 0 && v <= 1;
    for (const p of ROLE_PRESETS) {
      const name = Role[p.role];
      expect(p.side, name).toBe(roleSide(p.role));
      expect(p.widthAttack > 0.5 && p.widthAttack <= 1.5, name).toBe(true);
      expect(p.widthDefend > 0.5 && p.widthDefend <= 1.5, name).toBe(true);
      expect(p.widthAttack, name).toBeGreaterThanOrEqual(p.widthDefend);
      expect(p.maxNz > 0 && p.maxNz <= 0.9, name).toBe(true);
      for (const v of [p.attackMinNx, p.attackMaxNx, p.defendMinNx, p.defendMaxNx]) expect(v > -1 && v < 1, name).toBe(true);
      expect(p.attackMinNx, name).toBeLessThan(p.attackMaxNx);
      expect(p.defendMinNx, name).toBeLessThan(p.defendMaxNx);
      expect(p.attackMaxNx, name).toBeGreaterThanOrEqual(p.defendMaxNx);
      expect(p.attackMinNx, name).toBeGreaterThanOrEqual(p.defendMinNx);
      expect(p.pushAttack > 0 && p.pushAttack <= 2 && p.pushDefend > 0 && p.pushDefend <= 2, name).toBe(true);
      for (const v of [p.followXBack, p.followXFwd, p.ballFollowZ, p.freedom, p.boxPull]) expect(unit(v), name).toBe(true);
      expect(p.roamRadius >= 0 && p.roamRadius <= 30 && p.zoneRadius >= 0 && p.zoneRadius <= 20, name).toBe(true);
      for (const v of Object.values(p.runs)) expect(unit(v), name).toBe(true);
      for (const v of Object.values(p.duties)) expect(unit(v), name).toBe(true);
    }
  });

  it('outfield bands never reach the own goal area; the keeper stays in his penalty area and the goal mouth', () => {
    for (const p of ROLE_PRESETS) {
      if (p.role === Role.GK) {
        expect(p.attackMaxNx * HALF_LENGTH).toBeLessThan(-HALF_LENGTH + PENALTY_AREA_DEPTH);
        expect(p.maxNz * HALF_WIDTH).toBeLessThanOrEqual(GOAL_HALF_WIDTH + 1e-12);
        expect(p.line).toBe(ShapeLine.GK);
      } else {
        expect(p.defendMinNx * HALF_LENGTH, Role[p.role]).toBeGreaterThan(-HALF_LENGTH + GOAL_AREA_DEPTH + 1);
        expect(p.maxNz * HALF_WIDTH, Role[p.role]).toBeLessThanOrEqual(HALF_WIDTH - 3);
      }
    }
  });

  it('left-sided presets mirror the right-sided ones', () => {
    const strip = (p: RolePreset): Omit<RolePreset, 'role' | 'side'> => {
      const { role: _r, side: _s, ...rest } = p;
      return rest;
    };
    for (const r of ROLES) {
      const a = rolePreset(r);
      const b = rolePreset(mirrorRole(r));
      expect(strip(b), Role[r]).toEqual(strip(a));
      expect(b.side + a.side).toBe(0);
    }
  });

  it('roles behave like their names: depth bands ordered back to front, runs and duties where they belong', () => {
    const P = rolePreset;
    const order = [Role.CB, Role.CDM, Role.CM, Role.CAM, Role.ST];
    for (let k = 1; k < order.length; k++) {
      expect(P(order[k]!).attackMaxNx, Role[order[k]!]).toBeGreaterThan(P(order[k - 1]!).attackMaxNx);
      expect(P(order[k]!).defendMinNx, Role[order[k]!]).toBeGreaterThan(P(order[k - 1]!).defendMinNx);
    }
    expect(P(Role.CB).line).toBe(ShapeLine.DEF);
    expect(P(Role.RB).line).toBe(ShapeLine.DEF);
    expect(P(Role.CDM).line).toBe(ShapeLine.DM);
    expect(P(Role.CAM).line).toBe(ShapeLine.AM);
    expect(P(Role.ST).line).toBe(ShapeLine.FWD);
    expect(P(Role.RW).line).toBe(ShapeLine.FWD);
    const max = (f: (p: RolePreset) => number): number => Math.max(...ROLE_PRESETS.map(f));
    expect(P(Role.ST).runs.inBehind).toBe(max((p) => p.runs.inBehind));
    expect(P(Role.RWB).runs.overlap).toBe(max((p) => p.runs.overlap));
    expect(P(Role.RB).runs.overlap).toBeGreaterThan(P(Role.RM).runs.overlap);
    expect(P(Role.CB).duties.mark).toBe(max((p) => p.duties.mark));
    expect(P(Role.CB).duties.cover).toBe(max((p) => p.duties.cover));
    expect(P(Role.CAM).runs.lateRun).toBe(max((p) => p.runs.lateRun));
    expect(P(Role.CDM).runs.support).toBe(max((p) => p.runs.support));
    expect(P(Role.CB).freedom).toBeLessThan(P(Role.CAM).freedom);
    expect(Object.values(P(Role.GK).runs).filter((v) => v > 0.25)).toHaveLength(0);
    expect(P(Role.RB).widthAttack).toBeGreaterThan(1);
    expect(P(Role.ST).duties.press).toBeGreaterThan(P(Role.ST).duties.mark);
  });
});

describe('DAT-04 tactics: phase offsets and tactical focus', () => {
  it('one offset per TeamPhase, pushing up in possession and dropping without the ball', () => {
    expect(PHASE_OFFSETS).toHaveLength(6);
    PHASE_OFFSETS.forEach((o, i) => expect(o.phase).toBe(i));
    const push = (p: TeamPhase): number => phaseOffset(p).pushNx;
    expect(push(TeamPhase.ATTACK)).toBeGreaterThan(push(TeamPhase.TRANSITION_ATTACK));
    expect(push(TeamPhase.TRANSITION_ATTACK)).toBeGreaterThan(push(TeamPhase.BUILD_UP));
    expect(push(TeamPhase.BUILD_UP)).toBeGreaterThan(push(TeamPhase.SET_PIECE));
    expect(push(TeamPhase.SET_PIECE)).toBe(0);
    expect(push(TeamPhase.DEFEND)).toBeLessThan(0);
    expect(push(TeamPhase.TRANSITION_DEFEND)).toBeLessThan(push(TeamPhase.DEFEND));
    for (const p of PHASES) {
      const o = phaseOffset(p);
      const inPoss = !OUT_OF_POSSESSION.has(p) && p !== TeamPhase.SET_PIECE;
      if (inPoss) { expect(o.attackBand).toBe(1); expect(o.widthBlend).toBeGreaterThanOrEqual(0.5); }
      if (OUT_OF_POSSESSION.has(p)) { expect(o.attackBand).toBe(0); expect(o.runScale).toBe(0); expect(o.widthBlend).toBeLessThan(0.5); }
      if (!inPoss) expect(o.boxPull).toBe(0);
      expect(o.speedScale).toBeGreaterThanOrEqual(1);
    }
    expect(phaseOffset(TeamPhase.TRANSITION_DEFEND).speedScale).toBeGreaterThan(phaseOffset(TeamPhase.DEFEND).speedScale);
    expect(phaseOffset(TeamPhase.TRANSITION_ATTACK).runScale).toBeGreaterThan(phaseOffset(TeamPhase.ATTACK).runScale);
    expect(phaseOffset(99 as TeamPhase)).toBe(phaseOffset(TeamPhase.BUILD_UP));
  });

  it('focus: DEFENDING sits deeper and narrower and runs less; ATTACKING the opposite; DEFAULT is neutral', () => {
    expect(FOCUS_MODIFIERS).toHaveLength(3);
    FOCUS_MODIFIERS.forEach((m, i) => expect(m.focus).toBe(i));
    const d = focusModifier(TacticalFocus.DEFENDING);
    const n = focusModifier(TacticalFocus.DEFAULT);
    const a = focusModifier(TacticalFocus.ATTACKING);
    expect(n).toMatchObject({ pushNx: 0, lineNx: 0, widthAttack: 1, widthDefend: 1, runScale: 1, dutyScale: 1, pressScale: 1 });
    for (const k of ['pushNx', 'lineNx', 'runScale', 'maxRunners', 'pressScale', 'widthAttack'] as const) {
      expect(d[k], k).toBeLessThan(n[k]);
      expect(a[k], k).toBeGreaterThan(n[k]);
    }
    for (const k of ['dutyScale', 'restDefenders'] as const) {
      expect(d[k], k).toBeGreaterThan(n[k]);
      expect(a[k], k).toBeLessThan(n[k]);
    }
    expect(d.widthDefend).toBeLessThan(1);
    expect(focusModifier(9 as TacticalFocus)).toBe(n);
  });
});

describe('DAT-04 tactics: quick tactics', () => {
  it('commands map to quick-tactic flags and focus values', () => {
    expect(tacticFlagForCommand(Command.TACTIC_OFFSIDE_TRAP)).toBe(TacticFlag.OFFSIDE_TRAP);
    expect(tacticFlagForCommand(Command.TACTIC_TEAM_PRESS)).toBe(TacticFlag.TEAM_PRESS);
    expect(tacticFlagForCommand(Command.TACTIC_EXTRA_STRIKER)).toBe(TacticFlag.EXTRA_STRIKER);
    expect(tacticFlagForCommand(Command.TACTIC_GET_IN_BOX)).toBe(TacticFlag.GET_IN_BOX);
    expect(tacticFlagForCommand(Command.FOCUS_ATTACKING)).toBe(TacticFlag.NONE);
    expect(focusForCommand(Command.FOCUS_DEFAULT)).toBe(TacticalFocus.DEFAULT);
    expect(focusForCommand(Command.FOCUS_DEFENDING)).toBe(TacticalFocus.DEFENDING);
    expect(focusForCommand(Command.FOCUS_ATTACKING)).toBe(TacticalFocus.ATTACKING);
    expect(focusForCommand(Command.TACTIC_TEAM_PRESS)).toBe(-1);
  });

  it('tacticFlags reads the team toggles', () => {
    const t = createTeamState(0);
    expect(tacticFlags(t)).toBe(0);
    t.offsideTrap = 1; t.getInBox = 1;
    expect(tacticFlags(t)).toBe(TacticFlag.OFFSIDE_TRAP | TacticFlag.GET_IN_BOX);
    t.teamPress = 1; t.extraStriker = 1;
    expect(tacticFlags(t)).toBe(15);
  });

  it('resolveTactics: each quick tactic changes exactly the numbers it owns, and they combine', () => {
    const base = createTacticParams();
    const p = createTacticParams();
    resolveTactics(TacticalFocus.DEFAULT, 0, p);
    expect(p).toEqual(base);

    resolveTactics(TacticalFocus.DEFAULT, TacticFlag.OFFSIDE_TRAP, p);
    expect(p).toEqual({ ...base, lineNx: QUICK_TACTICS.offsideTrap.lineNx, trapStepM: QUICK_TACTICS.offsideTrap.stepUpM });

    resolveTactics(TacticalFocus.DEFAULT, TacticFlag.TEAM_PRESS, p);
    expect(p).toEqual({
      ...base, pushDefendNx: QUICK_TACTICS.teamPress.pushNx, lineNx: QUICK_TACTICS.teamPress.lineNx,
      pressAdd: QUICK_TACTICS.teamPress.pressAdd, pressers: 2, pressDistanceScale: QUICK_TACTICS.teamPress.pressDistanceScale,
    });

    resolveTactics(TacticalFocus.DEFAULT, TacticFlag.EXTRA_STRIKER, p);
    expect(p.maxRunners).toBe(base.maxRunners + 1);
    expect(p.restDefenders).toBe(base.restDefenders - 1);
    expect(p.runScale).toBeGreaterThan(1);

    resolveTactics(TacticalFocus.DEFAULT, TacticFlag.GET_IN_BOX, p);
    expect(p).toEqual({ ...base, boxRunners: QUICK_TACTICS.getInBox.boxRunners, lateRunScale: QUICK_TACTICS.getInBox.lateRunScale });

    resolveTactics(TacticalFocus.ATTACKING, 15, p);
    const a = focusModifier(TacticalFocus.ATTACKING);
    expect(p.lineNx).toBeCloseTo(a.lineNx + QUICK_TACTICS.offsideTrap.lineNx + QUICK_TACTICS.teamPress.lineNx, 12);
    expect(p.pushAttackNx).toBe(a.pushNx);
    expect(p.pushDefendNx).toBeCloseTo(a.pushNx + QUICK_TACTICS.teamPress.pushNx, 12);
    expect(p.maxRunners).toBe(a.maxRunners + 1);
    expect(p.boxRunners).toBe(QUICK_TACTICS.getInBox.boxRunners);
    expect(p.pressers).toBe(2);
    expect(p.trapStepM).toBeGreaterThan(0);

    resolveTactics(TacticalFocus.DEFENDING, 0, p);
    expect(p.lineNx).toBeLessThan(0);
    expect(p.dutyScale).toBeGreaterThan(1);
  });

  it('pressIntensity scales with focus, adds the team press and stays in [0, 1]', () => {
    const b = 0.7;
    expect(pressIntensity(b, TacticalFocus.DEFENDING, 0)).toBeLessThan(pressIntensity(b, TacticalFocus.DEFAULT, 0));
    expect(pressIntensity(b, TacticalFocus.ATTACKING, 0)).toBeGreaterThan(pressIntensity(b, TacticalFocus.DEFAULT, 0));
    expect(pressIntensity(b, TacticalFocus.DEFAULT, TacticFlag.TEAM_PRESS)).toBeCloseTo(b + QUICK_TACTICS.teamPress.pressAdd, 12);
    expect(pressIntensity(0.95, TacticalFocus.ATTACKING, TacticFlag.TEAM_PRESS)).toBe(1);
    expect(pressIntensity(-3, TacticalFocus.DEFAULT, 0)).toBe(0);
  });

  it('EXTRA_STRIKER shapes push exactly one midfielder into the front line', () => {
    expect(EXTRA_STRIKER_SHAPES).toHaveLength(6);
    for (const f of FORMATIONS) {
      const list = EXTRA_STRIKER_SHAPES[f.id]!;
      const lines = getFormationMeta(f.id).lines;
      const idx = list.map((o) => o.idx);
      expect(new Set(idx).size, f.name).toBe(idx.length);
      for (const o of list) {
        expect(o.idx >= 1 && o.idx < PLAYERS_PER_TEAM, f.name).toBe(true);
        expect(extraStrikerOverride(f.id, o.idx)).toBe(o);
        expect(o.nx * HALF_LENGTH < 0 && Math.abs(o.nz) < 0.9, f.name).toBe(true);
      }
      const promoted = list.filter((o) => o.role === Role.ST && f.slots[o.idx]!.role !== Role.ST);
      expect(promoted, f.name).toHaveLength(1);
      const pm = promoted[0]!;
      expect([ShapeLine.DM, ShapeLine.MID, ShapeLine.AM]).toContain(lines[pm.idx]);
      expect(slotRole(f.id, pm.idx, TacticFlag.EXTRA_STRIKER)).toBe(Role.ST);
      expect(slotLineFor(f.id, pm.idx, TacticFlag.EXTRA_STRIKER)).toBe(ShapeLine.FWD);
      expect(slotRole(f.id, pm.idx, 0)).toBe(f.slots[pm.idx]!.role);
      expect(slotLineFor(f.id, pm.idx, 0)).toBe(lines[pm.idx]);
      // The resulting neutral shape: one more forward, one keeper, still spaced and in the own half.
      const fwd = (flags: number): number => Array.from({ length: 11 }, (_, i) => slotLineFor(f.id, i, flags)).filter((l) => l === ShapeLine.FWD).length;
      expect(fwd(TacticFlag.EXTRA_STRIKER), f.name).toBe(fwd(0) + 1);
      const s = shape(f.id, TacticPhaseNeutral, TacticalFocus.DEFAULT, TacticFlag.EXTRA_STRIKER, 0, 0);
      expect(minPairDistance(s), f.name).toBeGreaterThanOrEqual(6);
      expect(Array.from({ length: 11 }, (_, i) => slotRole(f.id, i, TacticFlag.EXTRA_STRIKER)).filter((r) => r === Role.GK)).toHaveLength(1);
    }
    expect(extraStrikerOverride(FormationId.F442, 1)).toBeNull();
    expect(extraStrikerOverride(42 as FormationId, 6)).toBeNull();
    expect(slotRole(FormationId.F442, 99, 0)).toBe(Role.CM);
  });

  it('box spots are inside the penalty area and apart; crossing zone matches the constants', () => {
    for (const side of [1, -1]) {
      const pts = BOX_SPOTS.map((b) => ({ x: b.nx * HALF_LENGTH, z: b.nzSide * side * HALF_WIDTH }));
      for (const p of pts) {
        expect(p.x).toBeGreaterThanOrEqual(HALF_LENGTH - PENALTY_AREA_DEPTH - 2.5);
        expect(p.x).toBeLessThan(HALF_LENGTH);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(PENALTY_AREA_HALF_WIDTH);
      }
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.z - pts[j]!.z)).toBeGreaterThan(3);
      }
    }
    expect(BOX_SPOTS[0]!.nzSide).toBeGreaterThan(0); // near post on the ball side
    expect(BOX_SPOTS[1]!.nzSide).toBeLessThan(0); // far post
    const zx = (HALF_LENGTH - CROSS_ZONE_DEPTH + 0.5) / HALF_LENGTH;
    const zz = (CROSS_ZONE_MIN_Z + 0.5) / HALF_WIDTH;
    expect(inCrossingZone(zx, zz)).toBe(true);
    expect(inCrossingZone(zx, -zz)).toBe(true);
    expect(inCrossingZone(zx, 0)).toBe(false);
    expect(inCrossingZone(0, zz)).toBe(false);
  });
});


describe('DAT-04 tactics: reference shape (tacticalHome)', () => {
  it('always valid: finite, inside the pitch, keeper in his area, outfielders out of the own goal area', () => {
    for (const f of IDS) for (const phase of PHASES) for (const focus of FOCI) for (const flags of ALL_FLAGS) {
      for (const bx of BX) for (const bz of BZ) {
        const s = shape(f, phase, focus, flags, bx, bz);
        const ctx = `${f} ph${phase} fo${focus} fl${flags} b(${bx},${bz})`;
        for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
          const x = s.x[i]!;
          const z = s.z[i]!;
          if (!(Number.isFinite(x) && Number.isFinite(z) && Math.abs(x) < HALF_LENGTH && Math.abs(z) <= HALF_WIDTH - 3 + 1e-9)) {
            throw new Error(`${ctx} slot ${i} at (${x}, ${z})`);
          }
          if (i === 0) {
            if (x > -HALF_LENGTH + PENALTY_AREA_DEPTH || Math.abs(z) > GOAL_HALF_WIDTH + 1e-9) throw new Error(`${ctx} keeper at (${x}, ${z})`);
          } else if (x < -HALF_LENGTH + GOAL_AREA_DEPTH + 1) {
            throw new Error(`${ctx} slot ${i} in the own goal area (${x})`);
          }
        }
      }
    }
  });

  it('out of possession the block is compact: no hole longer than T_AI.lineSpacingMax, at most 30 m deep', () => {
    let worstHole = 0;
    let worstLen = 0;
    for (const f of IDS) for (const phase of [TeamPhase.DEFEND, TeamPhase.TRANSITION_DEFEND]) for (const focus of FOCI) {
      for (const flags of ALL_FLAGS) for (const bx of BX) for (const bz of BZ) {
        const s = shape(f, phase, focus, flags, bx, bz);
        worstHole = Math.max(worstHole, maxHole(s));
        worstLen = Math.max(worstLen, spread(s.x));
      }
    }
    expect(worstHole).toBeLessThanOrEqual(T_AI.lineSpacingMax);
    expect(worstLen).toBeLessThanOrEqual(30);
  });

  it('in possession the team stretches but keeps connected (holes <= 20 m, length <= 45 m; get-in-box floods <= 55 m)', () => {
    for (const f of IDS) for (const phase of [TeamPhase.BUILD_UP, TeamPhase.ATTACK, TeamPhase.TRANSITION_ATTACK, TeamPhase.SET_PIECE]) {
      for (const focus of FOCI) for (const flags of ALL_FLAGS) for (const bx of BX) for (const bz of BZ) {
        if (!realistic(phase, bx)) continue;
        const s = shape(f, phase, focus, flags, bx, bz);
        const ctx = `${f} ph${phase} fo${focus} fl${flags} b(${bx},${bz})`;
        const box = (flags & TacticFlag.GET_IN_BOX) !== 0 && phase !== TeamPhase.SET_PIECE;
        const holeMax = phase === TeamPhase.SET_PIECE ? 16 : box ? 26 : 20;
        const lenMax = phase === TeamPhase.SET_PIECE ? 35 : box ? 55 : 45;
        expect(maxHole(s), ctx).toBeLessThanOrEqual(holeMax);
        expect(spread(s.x), ctx).toBeLessThanOrEqual(lenMax);
      }
    }
  });

  it('lines stay in order and nobody shares a spot (>= 4 m apart) in every phase, focus and tactic', () => {
    for (const f of IDS) for (const phase of PHASES) for (const focus of FOCI) for (const flags of ALL_FLAGS) {
      for (const bx of BX) for (const bz of BZ) {
        if (!realistic(phase, bx)) continue;
        const s = shape(f, phase, focus, flags, bx, bz);
        const ctx = `${f} ph${phase} fo${focus} fl${flags} b(${bx},${bz})`;
        const m = lineMeans(f, flags, s);
        for (let k = 1; k < m.length; k++) if (!(m[k]! - m[k - 1]! >= 1)) throw new Error(`${ctx} lines ${k - 1}/${k}: ${m.join(', ')}`);
        const d = minPairDistance(s);
        if (!(d >= 4)) throw new Error(`${ctx} min distance ${d}`);
      }
    }
  });

  it('right-to-left order inside every line is preserved wherever the ball is', () => {
    for (const f of IDS) {
      const lines = getFormationMeta(f).lines;
      for (const phase of PHASES) for (const focus of FOCI) for (const flags of [0, TacticFlag.TEAM_PRESS, TacticFlag.GET_IN_BOX]) {
        for (const bx of BX) for (const bz of BZ) {
          const s = shape(f, phase, focus, flags, bx, bz);
          for (let i = 2; i < PLAYERS_PER_TEAM; i++) {
            if (lines[i] === lines[i - 1] && !(s.z[i]! < s.z[i - 1]!)) {
              throw new Error(`${f} ph${phase} fo${focus} fl${flags} b(${bx},${bz}) slots ${i - 1}/${i}: ${s.z[i - 1]} vs ${s.z[i]}`);
            }
          }
        }
      }
    }
  });

  it('left/right symmetric: the mirror slot with the ball mirrored stands at the mirrored spot', () => {
    const a: ShapePoint = { nx: 0, nz: 0 };
    const b: ShapePoint = { nx: 0, nz: 0 };
    for (const f of IDS) {
      const mirror = getFormationMeta(f).mirror;
      for (const phase of PHASES) for (const focus of FOCI) for (const flags of [0, 1, 2, 3, 8, 9, 10, 11]) {
        for (const bx of BX) for (const bz of BZ) {
          for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
            tacticalHome(f, i, phase, focus, flags, bx, bz, a);
            tacticalHome(f, mirror[i]!, phase, focus, flags, bx, -bz, b);
            if (Math.abs(b.nx - a.nx) > 1e-12 || Math.abs(b.nz + a.nz) > 1e-12) {
              throw new Error(`${f} ph${phase} fo${focus} fl${flags} b(${bx},${bz}) slot ${i}: (${a.nx}, ${a.nz}) vs mirror (${b.nx}, ${b.nz})`);
            }
          }
        }
      }
    }
  });

  it('mirrored use for a team attacking -x: world = (-nx * 52.5, -nz * 34) stays in the own half at kick-off spots', () => {
    for (const f of IDS) {
      for (const phase of PHASES) {
        const s = shape(f, phase, TacticalFocus.DEFAULT, 0, 0, 0);
        for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
          const x = -s.x[i]!;
          const z = -s.z[i]!;
          expect(Math.abs(x)).toBeLessThan(HALF_LENGTH);
          expect(Math.abs(z)).toBeLessThan(HALF_WIDTH);
          const side = roleSide(getFormation(f).slots[i]!.role);
          if (side !== 0) expect(Math.sign(z), `${f} ${i}`).toBe(-side);
          if (OUT_OF_POSSESSION.has(phase)) expect(x, `${f} ph${phase} ${i}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('shifts with the team phase: higher and wider in possession, deeper and narrower without the ball', () => {
    for (const f of IDS) {
      const at = shape(f, TeamPhase.ATTACK, TacticalFocus.DEFAULT, 0, 0, 0);
      const bu = shape(f, TeamPhase.BUILD_UP, TacticalFocus.DEFAULT, 0, 0, 0);
      const de = shape(f, TeamPhase.DEFEND, TacticalFocus.DEFAULT, 0, 0, 0);
      const td = shape(f, TeamPhase.TRANSITION_DEFEND, TacticalFocus.DEFAULT, 0, 0, 0);
      expect(outfieldMean(at.x)).toBeGreaterThan(outfieldMean(bu.x) + 3);
      expect(outfieldMean(bu.x)).toBeGreaterThan(outfieldMean(de.x) + 3);
      expect(outfieldMean(de.x)).toBeGreaterThan(outfieldMean(td.x));
      expect(spread(at.z)).toBeGreaterThan(spread(de.z) + 6);
      for (let i = 0; i < PLAYERS_PER_TEAM; i++) expect(at.x[i]!).toBeGreaterThanOrEqual(de.x[i]!);
    }
  });

  it('shifts with the tactical focus, in and out of possession', () => {
    for (const f of IDS) for (const phase of PHASES) {
      const d = shape(f, phase, TacticalFocus.DEFENDING, 0, 0, 0);
      const n = shape(f, phase, TacticalFocus.DEFAULT, 0, 0, 0);
      const a = shape(f, phase, TacticalFocus.ATTACKING, 0, 0, 0);
      expect(outfieldMean(a.x), `${f} ${phase}`).toBeGreaterThan(outfieldMean(n.x) + 2);
      expect(outfieldMean(n.x), `${f} ${phase}`).toBeGreaterThan(outfieldMean(d.x) + 2);
      expect(spread(d.z), `${f} ${phase}`).toBeLessThan(spread(n.z));
    }
  });

  it('the block follows the ball: up and down with ball x, sliding and squeezing toward the ball side', () => {
    for (const f of IDS) for (const phase of PHASES) {
      let prev = -Infinity;
      for (const bx of BX) {
        const m = outfieldMean(shape(f, phase, TacticalFocus.DEFAULT, 0, bx, 0).x);
        expect(m, `${f} ph${phase} bx${bx}`).toBeGreaterThanOrEqual(prev); // flat only where depth bands clamp
        prev = m;
      }
      const lowBall = outfieldMean(shape(f, phase, TacticalFocus.DEFAULT, 0, -1, 0).x);
      const highBall = outfieldMean(shape(f, phase, TacticalFocus.DEFAULT, 0, 1, 0).x);
      expect(highBall - lowBall, `${f} ph${phase}`).toBeGreaterThan(25);
      let prevZ = -Infinity;
      for (const bz of BZ) {
        const s = shape(f, phase, TacticalFocus.DEFAULT, 0, 0, bz);
        const mz = outfieldMean(s.z);
        expect(mz, `${f} ph${phase} bz${bz}`).toBeGreaterThan(prevZ);
        if (bz !== 0) expect(Math.sign(mz)).toBe(Math.sign(bz));
        prevZ = mz;
      }
      // Squeeze: ball on the right touchline -> the two right-most back-line players are closer than in the
      // neutral shape, the two left-most are not.
      const back = getFormationMeta(f).backLine;
      const c = shape(f, phase, TacticalFocus.DEFAULT, 0, 0, 0);
      const r = shape(f, phase, TacticalFocus.DEFAULT, 0, 0, 1);
      const gap = (s: Shape, i: number, j: number): number => s.z[i]! - s.z[j]!;
      const n = back.length;
      expect(gap(r, back[0]!, back[1]!), `${f} ph${phase}`).toBeLessThan(gap(c, back[0]!, back[1]!) - 1);
      expect(Math.abs(gap(r, back[n - 2]!, back[n - 1]!) - gap(c, back[n - 2]!, back[n - 1]!)), `${f} ph${phase}`).toBeLessThan(1);
    }
  });

  it('team press pushes the block up only when defending', () => {
    for (const f of IDS) {
      const off = shape(f, TeamPhase.DEFEND, TacticalFocus.DEFAULT, 0, 0, 0);
      const on = shape(f, TeamPhase.DEFEND, TacticalFocus.DEFAULT, TacticFlag.TEAM_PRESS, 0, 0);
      expect(outfieldMean(on.x)).toBeGreaterThan(outfieldMean(off.x) + 2);
      expect(shape(f, TeamPhase.ATTACK, TacticalFocus.DEFAULT, TacticFlag.TEAM_PRESS, 0.3, 0)).toEqual(shape(f, TeamPhase.ATTACK, TacticalFocus.DEFAULT, 0, 0.3, 0));
      // Offside trap is a back-line behaviour (TAI-04 via TacticParams), not a shape change.
      expect(shape(f, TeamPhase.DEFEND, TacticalFocus.DEFAULT, TacticFlag.OFFSIDE_TRAP, 0.2, 0.3)).toEqual(shape(f, TeamPhase.DEFEND, TacticalFocus.DEFAULT, 0, 0.2, 0.3));
    }
  });

  it('extra striker: the promoted midfielder plays in the front line, untouched slots do not move', () => {
    for (const f of IDS) for (const phase of PHASES) for (const bx of [-0.4, 0, 0.5]) {
      const base = shape(f, phase, TacticalFocus.DEFAULT, 0, bx, 0.2);
      const es = shape(f, phase, TacticalFocus.DEFAULT, TacticFlag.EXTRA_STRIKER, bx, 0.2);
      const list = EXTRA_STRIKER_SHAPES[f]!;
      const pm = list.find((o) => o.role === Role.ST && getFormation(f).slots[o.idx]!.role !== Role.ST)!;
      expect(es.x[pm.idx]!, `${f} ph${phase}`).toBeGreaterThan(base.x[pm.idx]! + 4);
      for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
        if (list.some((o) => o.idx === i)) continue;
        expect(es.x[i]).toBe(base.x[i]);
        expect(es.z[i]).toBe(base.z[i]);
      }
    }
  });

  it('get in the box: with the ball in the crossing zone the central forwards and far-side wide men attack the box', () => {
    const boxEdge = HALF_LENGTH - PENALTY_AREA_DEPTH;
    for (const f of IDS) {
      const bx = 0.75;
      const bz = 0.75; // ball on the right flank, inside the crossing zone
      expect(inCrossingZone(bx, bz)).toBe(true);
      const off = shape(f, TeamPhase.ATTACK, TacticalFocus.DEFAULT, 0, bx, bz);
      const on = shape(f, TeamPhase.ATTACK, TacticalFocus.DEFAULT, TacticFlag.GET_IN_BOX, bx, bz);
      let inBox = 0;
      let inBoxOff = 0;
      let pulledGain = 0;
      for (let i = 1; i < PLAYERS_PER_TEAM; i++) {
        const p = rolePreset(getFormation(f).slots[i]!.role);
        if (p.side > 0 || p.boxPull === 0) {
          expect(on.x[i], `${f} ${i}`).toBe(off.x[i]);
          expect(on.z[i], `${f} ${i}`).toBe(off.z[i]);
        } else {
          expect(on.x[i]!, `${f} ${i}`).toBeGreaterThanOrEqual(off.x[i]!);
          pulledGain += on.x[i]! - off.x[i]!;
          if (p.side < 0) expect(Math.abs(on.z[i]!), `${f} ${i}`).toBeLessThan(Math.abs(off.z[i]!));
        }
        if (on.x[i]! >= boxEdge && Math.abs(on.z[i]!) <= PENALTY_AREA_HALF_WIDTH) inBox++;
        if (off.x[i]! >= boxEdge && Math.abs(off.z[i]!) <= PENALTY_AREA_HALF_WIDTH) inBoxOff++;
      }
      expect(inBox, FORMATIONS[f]!.name).toBeGreaterThanOrEqual(Math.max(2, inBoxOff));
      expect(pulledGain, FORMATIONS[f]!.name).toBeGreaterThan(5);
      // No pull when the ball is not in the crossing zone or the team is defending.
      expect(shape(f, TeamPhase.ATTACK, TacticalFocus.DEFAULT, TacticFlag.GET_IN_BOX, 0.2, 0.75)).toEqual(shape(f, TeamPhase.ATTACK, TacticalFocus.DEFAULT, 0, 0.2, 0.75));
      expect(shape(f, TeamPhase.DEFEND, TacticalFocus.DEFAULT, TacticFlag.GET_IN_BOX, bx, bz)).toEqual(shape(f, TeamPhase.DEFEND, TacticalFocus.DEFAULT, 0, bx, bz));
    }
  });

  it('robust to bad input: unknown phase/focus fall back, NaN or huge ball values give a valid shape', () => {
    const a: ShapePoint = { nx: 0, nz: 0 };
    const b: ShapePoint = { nx: 0, nz: 0 };
    for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
      tacticalHome(FormationId.F433, i, 42 as TeamPhase, 7 as TacticalFocus, 0, 0.3, -0.2, a);
      tacticalHome(FormationId.F433, i, TeamPhase.BUILD_UP, TacticalFocus.DEFAULT, 0, 0.3, -0.2, b);
      expect(a).toEqual(b);
      tacticalHome(FormationId.F433, i, TeamPhase.DEFEND, TacticalFocus.DEFAULT, 0, NaN, NaN, a);
      tacticalHome(FormationId.F433, i, TeamPhase.DEFEND, TacticalFocus.DEFAULT, 0, 0, 0, b);
      expect(a).toEqual(b);
      tacticalHome(FormationId.F433, i, TeamPhase.ATTACK, TacticalFocus.DEFAULT, 0, 1e9, -Infinity, a);
      tacticalHome(FormationId.F433, i, TeamPhase.ATTACK, TacticalFocus.DEFAULT, 0, 1, -1, b);
      expect(a).toEqual(b);
    }
    tacticalHome(FormationId.F442, 99, TeamPhase.DEFEND, TacticalFocus.DEFAULT, 0, 0, 0, a);
    tacticalHome(FormationId.F442, 0, TeamPhase.DEFEND, TacticalFocus.DEFAULT, 0, 0, 0, b);
    expect(a).toEqual(b);
    tacticalHome(17 as FormationId, 5, TeamPhase.DEFEND, TacticalFocus.DEFAULT, 0, 0, 0, a);
    tacticalHome(FormationId.F442, 5, TeamPhase.DEFEND, TacticalFocus.DEFAULT, 0, 0, 0, b);
    expect(a).toEqual(b);
  });

  it('per-tick helpers do not allocate (tacticalHome, resolveTactics, pressIntensity, remapFormation)', () => {
    const code = `
      const { tacticalHome, resolveTactics, createTacticParams, pressIntensity } = await import('./src/data/tactics.ts');
      const { remapFormation, getFormation } = await import('./src/data/formations.ts');
      const out = { nx: 0.5, nz: 0.5 }; const tp = createTacticParams(); const map = new Array(11).fill(0);
      const roles = getFormation(0).slots.map((s) => s.role);
      function shape(n) { let acc = 0; for (let k = 0; k < n; k++) { tacticalHome(k % 6, k % 11, k % 6, k % 3, k & 15, (k % 21) / 10 - 1, (k % 9) / 4 - 1, out); acc += out.nx; } return acc; }
      function tactics(n) { let acc = 0; for (let k = 0; k < n; k++) { resolveTactics(k % 3, k & 15, tp); acc += tp.lineNx + pressIntensity(0.5, k % 3, k & 15); } return acc; }
      function remap(n) { let acc = 0; for (let k = 0; k < n; k++) { remapFormation(k % 6, (k + 1) % 6, roles, 0, map); acc += map[3]; } return acc; }
      const res = {}; let s = 0;
      for (const [name, fn, n] of [['shape', shape, 1000000], ['tactics', tactics, 1000000], ['remap', remap, 20000]]) {
        s += fn(n); s += fn(n); globalThis.gc();
        const h0 = process.memoryUsage().heapUsed; s += fn(n); res[name] = (process.memoryUsage().heapUsed - h0) / n;
      }
      console.log(JSON.stringify({ res, ok: Number.isFinite(s) }));
    `;
    const r = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const { res, ok } = JSON.parse(r.stdout.trim().split('\n').pop()!) as { res: Record<string, number>; ok: boolean };
    expect(ok).toBe(true);
    // JIT boxing noise only (a few bytes per call at most); a real allocation would cost >= 16-32 bytes per call.
    expect(res.shape!, 'tacticalHome bytes/call').toBeLessThan(4);
    expect(res.tactics!, 'resolveTactics bytes/call').toBeLessThan(4);
    expect(res.remap!, 'remapFormation bytes/call').toBeLessThan(16);
  }, 150_000);

  it('deterministic: identical inputs give bit-identical outputs regardless of call history', () => {
    const run = (): number[] => {
      const out: number[] = [];
      for (const f of IDS) for (const phase of PHASES) for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
        tacticalHome(f, i, phase, (i % 3) as TacticalFocus, i & 15, (i - 5) / 5, (5 - i) / 6, pt);
        out.push(pt.nx, pt.nz);
      }
      return out;
    };
    const first = run();
    shape(FormationId.F352, TeamPhase.ATTACK, TacticalFocus.ATTACKING, 15, 0.9, -0.9);
    expect(run()).toEqual(first);
  });
});
