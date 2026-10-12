/** DAT-04: formation data (neutral home positions, lines, symmetry, mirrored use) and the formation switch helpers. */
import { describe, expect, it } from 'vitest';
import {
  GOAL_AREA_DEPTH, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, PENALTY_AREA_DEPTH, PLAYERS_PER_TEAM,
} from '../../src/contracts/constants';
import { FormationId, Role } from '../../src/contracts/enums';
import { T_AI } from '../../src/contracts/tuning';
import {
  FORMATION_META, FORMATION_SWITCH, FORMATIONS, ROLE_FAMILIARITY, ROLE_FILL_PRIORITY, ShapeLine, formationMoveCost,
  formationSwitchMap, getFormation, getFormationMeta, mirrorRole, remapFormation, roleFamiliarity, roleSide, slotLine,
  slotWorld,
} from '../../src/data/formations';

const ALL_IDS = [FormationId.F442, FormationId.F433, FormationId.F4231, FormationId.F352, FormationId.F532, FormationId.F41212];
const NUM_ROLES = 15;
const ROLES = Array.from({ length: NUM_ROLES }, (_, r) => r as Role);
const CENTRAL = new Set<Role>([Role.GK, Role.CB, Role.CDM, Role.CM, Role.CAM, Role.ST, Role.CF]);
const xOf = (nx: number): number => nx * HALF_LENGTH;
const zOf = (nz: number): number => nz * HALF_WIDTH;

function isPermutation(a: readonly number[]): boolean {
  if (a.length !== PLAYERS_PER_TEAM) return false;
  const seen = new Array<boolean>(PLAYERS_PER_TEAM).fill(false);
  for (const v of a) {
    if (!Number.isInteger(v) || v < 0 || v >= PLAYERS_PER_TEAM || seen[v]) return false;
    seen[v] = true;
  }
  return true;
}

describe('DAT-04 formations: catalogue', () => {
  it('has the six formations of BRIEF §7, indexed by FormationId', () => {
    expect(FORMATIONS.map((f) => f.name)).toEqual(['4-4-2', '4-3-3', '4-2-3-1', '3-5-2', '5-3-2', '4-1-2-1-2']);
    FORMATIONS.forEach((f, i) => expect(f.id).toBe(i));
    for (const id of ALL_IDS) expect(getFormation(id).id).toBe(id);
    expect(getFormation(99 as FormationId).id).toBe(FormationId.F442);
    expect(getFormation(-1 as FormationId).id).toBe(FormationId.F442);
    expect(FORMATION_META).toHaveLength(6);
    FORMATION_META.forEach((m, i) => expect(m.id).toBe(i));
    expect(getFormationMeta(42 as FormationId).id).toBe(FormationId.F442);
  });

  it('11 slots each, exactly one GK and it is slot 0, every role a valid Role', () => {
    for (const f of FORMATIONS) {
      expect(f.slots, f.name).toHaveLength(PLAYERS_PER_TEAM);
      expect(f.slots[0]!.role, f.name).toBe(Role.GK);
      expect(f.slots.filter((s) => s.role === Role.GK), f.name).toHaveLength(1);
      for (const s of f.slots) {
        expect(Number.isInteger(s.role) && s.role >= 0 && s.role < NUM_ROLES, f.name).toBe(true);
        expect(Number.isFinite(s.nx) && Number.isFinite(s.nz), f.name).toBe(true);
      }
    }
  });

  it('keeps the Wave 0 role sequence (squads from DAT-01/02 are generated in this order)', () => {
    const R = Role;
    expect(FORMATIONS.map((f) => f.slots.map((s) => s.role))).toEqual([
      [R.GK, R.RB, R.CB, R.CB, R.LB, R.RM, R.CM, R.CM, R.LM, R.ST, R.ST],
      [R.GK, R.RB, R.CB, R.CB, R.LB, R.CM, R.CDM, R.CM, R.RW, R.ST, R.LW],
      [R.GK, R.RB, R.CB, R.CB, R.LB, R.CDM, R.CDM, R.RM, R.CAM, R.LM, R.ST],
      [R.GK, R.CB, R.CB, R.CB, R.RWB, R.CM, R.CDM, R.CM, R.LWB, R.ST, R.ST],
      [R.GK, R.RWB, R.CB, R.CB, R.CB, R.LWB, R.CM, R.CM, R.CM, R.ST, R.ST],
      [R.GK, R.RB, R.CB, R.CB, R.LB, R.CDM, R.CM, R.CM, R.CAM, R.ST, R.ST],
    ]);
  });

  it('line counts read exactly like the formation name (4-2-3-1 = 4 DEF, 2 DM, 3 AM, 1 FWD)', () => {
    for (const f of FORMATIONS) {
      const lines = getFormationMeta(f.id).lines;
      expect(lines, f.name).toHaveLength(PLAYERS_PER_TEAM);
      expect(lines[0]).toBe(ShapeLine.GK);
      const counts: number[] = [];
      for (let l = ShapeLine.DEF; l <= ShapeLine.FWD; l++) {
        const n = lines.filter((x) => x === l).length;
        if (n > 0) counts.push(n);
      }
      expect(counts.join('-'), f.name).toBe(f.name);
      for (let i = 0; i < PLAYERS_PER_TEAM; i++) expect(slotLine(f.id, i)).toBe(lines[i]);
    }
  });

  it('slot order: GK, defenders right to left, midfield lines deepest first (right to left), forwards right to left', () => {
    for (const f of FORMATIONS) {
      const lines = getFormationMeta(f.id).lines;
      for (let i = 1; i < PLAYERS_PER_TEAM; i++) {
        expect(lines[i]! >= lines[i - 1]!, `${f.name} line order at ${i}`).toBe(true);
        if (lines[i] === lines[i - 1]) expect(f.slots[i]!.nz < f.slots[i - 1]!.nz, `${f.name} right-to-left at ${i}`).toBe(true);
      }
    }
  });

  it('back line metadata matches the DEF line', () => {
    const backCounts = FORMATION_META.map((m) => m.backCount);
    expect(backCounts).toEqual([4, 4, 4, 3, 5, 4]);
    for (const m of FORMATION_META) {
      expect(m.backLine).toEqual(m.lines.map((l, i) => (l === ShapeLine.DEF ? i : -1)).filter((i) => i >= 0));
    }
  });
});

describe('DAT-04 formations: neutral home positions', () => {
  it('sides follow the role: right-sided roles on +z, left-sided on -z, central roles near the middle', () => {
    for (const f of FORMATIONS) {
      for (const s of f.slots) {
        const side = roleSide(s.role);
        if (side > 0) expect(s.nz, `${f.name} ${Role[s.role]}`).toBeGreaterThan(0.5);
        else if (side < 0) expect(s.nz, `${f.name} ${Role[s.role]}`).toBeLessThan(-0.5);
        else expect(Math.abs(s.nz), `${f.name} ${Role[s.role]}`).toBeLessThanOrEqual(0.4);
      }
      expect(f.slots[0]!.nz).toBe(0);
    }
  });

  it('symmetric: every slot has a mirror partner (mirrored role, same depth, opposite width)', () => {
    for (const f of FORMATIONS) {
      const mirror = getFormationMeta(f.id).mirror;
      for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
        const j = mirror[i]!;
        expect(j, `${f.name} slot ${i}`).toBeGreaterThanOrEqual(0);
        const a = f.slots[i]!;
        const b = f.slots[j]!;
        expect(b.role).toBe(mirrorRole(a.role));
        expect(b.nx).toBe(a.nx);
        expect(b.nz + a.nz).toBe(0);
        expect(mirror[j]).toBe(i);
        if (j === i) expect(a.nz).toBe(0);
      }
    }
  });

  it('inside the pitch, everybody in his own half, outfielders outside their own penalty area', () => {
    for (const f of FORMATIONS) {
      for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
        const s = f.slots[i]!;
        expect(Math.abs(s.nx), f.name).toBeLessThan(1);
        expect(Math.abs(s.nz), f.name).toBeLessThan(1);
        expect(xOf(s.nx), `${f.name} ${i} own half`).toBeLessThan(0);
        expect(Math.abs(zOf(s.nz)), `${f.name} ${i} touchline margin`).toBeLessThanOrEqual(HALF_WIDTH - 6);
        if (i === 0) {
          expect(xOf(s.nx)).toBeGreaterThan(-HALF_LENGTH + GOAL_AREA_DEPTH);
          expect(xOf(s.nx)).toBeLessThan(-HALF_LENGTH + PENALTY_AREA_DEPTH);
          expect(Math.abs(zOf(s.nz))).toBeLessThanOrEqual(GOAL_HALF_WIDTH);
        } else {
          expect(xOf(s.nx), `${f.name} ${i}`).toBeGreaterThan(-HALF_LENGTH + PENALTY_AREA_DEPTH);
        }
      }
    }
  });

  it('compact and spaced: lines ordered, gaps <= T_AI.lineSpacingMax, no two slots closer than 7 m', () => {
    for (const f of FORMATIONS) {
      const lines = getFormationMeta(f.id).lines;
      const means: number[] = [];
      for (let l = ShapeLine.DEF; l <= ShapeLine.FWD; l++) {
        const xs = f.slots.filter((_, i) => lines[i] === l).map((s) => xOf(s.nx));
        if (xs.length > 0) means.push(xs.reduce((a, b) => a + b, 0) / xs.length);
      }
      for (let k = 1; k < means.length; k++) {
        expect(means[k]! - means[k - 1]!, `${f.name} line ${k} ahead of ${k - 1}`).toBeGreaterThan(4);
        expect(means[k]! - means[k - 1]!, `${f.name} line gap ${k}`).toBeLessThanOrEqual(T_AI.lineSpacingMax);
      }
      const outX = f.slots.slice(1).map((s) => xOf(s.nx));
      expect(Math.max(...outX) - Math.min(...outX), `${f.name} depth`).toBeLessThanOrEqual(28);
      const outZ = f.slots.slice(1).map((s) => zOf(s.nz));
      const width = Math.max(...outZ) - Math.min(...outZ);
      expect(width, `${f.name} width`).toBeGreaterThanOrEqual(40);
      expect(width, `${f.name} width`).toBeLessThanOrEqual(56);
      for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
        for (let j = i + 1; j < PLAYERS_PER_TEAM; j++) {
          const a = f.slots[i]!;
          const b = f.slots[j]!;
          const d = Math.hypot(xOf(a.nx - b.nx), zOf(a.nz - b.nz));
          expect(d, `${f.name} ${i}-${j}`).toBeGreaterThanOrEqual(7);
        }
      }
    }
  });

  it('mirrored use (x = -nx * 52.5, z = -nz * 34 for dir -1) stays valid', () => {
    const p = { x: 0, z: 0 };
    const q = { x: 0, z: 0 };
    for (const f of FORMATIONS) {
      for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
        const s = f.slots[i]!;
        slotWorld(f.id, i, -1, p);
        slotWorld(f.id, i, 1, q);
        expect(p.x).toBeCloseTo(-s.nx * HALF_LENGTH, 12);
        expect(p.z).toBeCloseTo(-s.nz * HALF_WIDTH, 12);
        expect(q.x).toBeCloseTo(s.nx * HALF_LENGTH, 12);
        expect(q.z).toBeCloseTo(s.nz * HALF_WIDTH, 12);
        // Away side (attacks -x): own half is +x, own goal at +52.5, inside the pitch.
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(HALF_LENGTH);
        expect(Math.abs(p.z)).toBeLessThan(HALF_WIDTH);
        if (i > 0) expect(HALF_LENGTH - p.x).toBeGreaterThan(PENALTY_AREA_DEPTH);
        // Facing -x a player's right hand points to -z: right-sided roles stand on -z, left-sided on +z.
        const side = roleSide(s.role);
        if (side !== 0) expect(Math.sign(p.z)).toBe(-side);
        // Point reflection through the centre spot of the dir +1 position.
        expect(p.x).toBeCloseTo(-q.x, 12);
        expect(p.z).toBeCloseTo(-q.z, 12);
      }
    }
    // Out-of-range slot index falls back to the keeper.
    slotWorld(FormationId.F433, 99, 1, p);
    expect(p.x).toBeCloseTo(getFormation(FormationId.F433).slots[0]!.nx * HALF_LENGTH, 12);
  });
});

describe('DAT-04 formations: roles', () => {
  it('mirrorRole is an involution that swaps flanks and keeps central roles', () => {
    for (const r of ROLES) {
      expect(mirrorRole(mirrorRole(r))).toBe(r);
      expect(roleSide(mirrorRole(r)) + roleSide(r)).toBe(0);
      if (CENTRAL.has(r)) expect(mirrorRole(r)).toBe(r);
    }
    expect(mirrorRole(Role.RB)).toBe(Role.LB);
    expect(mirrorRole(Role.RWB)).toBe(Role.LWB);
    expect(mirrorRole(Role.RM)).toBe(Role.LM);
    expect(mirrorRole(Role.RW)).toBe(Role.LW);
  });

  it('familiarity matrix: 15x15, symmetric, 100 on the diagonal, flank-mirror invariant, keepers only in goal', () => {
    expect(ROLE_FAMILIARITY).toHaveLength(NUM_ROLES);
    for (const a of ROLES) {
      expect(ROLE_FAMILIARITY[a]).toHaveLength(NUM_ROLES);
      expect(roleFamiliarity(a, a)).toBe(100);
      for (const b of ROLES) {
        const v = roleFamiliarity(a, b);
        expect(Number.isInteger(v) && v >= 0 && v <= 100).toBe(true);
        expect(v, `${Role[a]}/${Role[b]}`).toBe(roleFamiliarity(b, a));
        expect(v, `mirror ${Role[a]}/${Role[b]}`).toBe(roleFamiliarity(mirrorRole(a), mirrorRole(b)));
        if (a !== b && (a === Role.GK || b === Role.GK)) expect(v).toBe(0);
        if (a !== b) expect(v).toBeLessThan(100);
      }
    }
    expect(roleFamiliarity(99 as Role, Role.CB)).toBe(0);
    // A few anchors that make the matrix football-sensible.
    expect(roleFamiliarity(Role.RB, Role.RWB)).toBeGreaterThan(roleFamiliarity(Role.RB, Role.ST));
    expect(roleFamiliarity(Role.CDM, Role.CM)).toBeGreaterThan(roleFamiliarity(Role.CDM, Role.RW));
    expect(roleFamiliarity(Role.ST, Role.CF)).toBeGreaterThan(roleFamiliarity(Role.ST, Role.CB));
  });

  it('fill priority covers every role, keeper first, centre-backs before wingers', () => {
    expect(ROLE_FILL_PRIORITY).toHaveLength(NUM_ROLES);
    for (const r of ROLES) expect(ROLE_FILL_PRIORITY[r]! > 0 && ROLE_FILL_PRIORITY[r]! <= 100).toBe(true);
    expect(Math.max(...ROLE_FILL_PRIORITY)).toBe(ROLE_FILL_PRIORITY[Role.GK]);
    expect(ROLE_FILL_PRIORITY[Role.CB]!).toBeGreaterThan(ROLE_FILL_PRIORITY[Role.RW]!);
    for (const r of ROLES) expect(ROLE_FILL_PRIORITY[r]).toBe(ROLE_FILL_PRIORITY[mirrorRole(r)]);
  });
});

describe('DAT-04 formations: formation switch mapping', () => {
  function totalCost(from: FormationId, to: FormationId, roles: readonly number[], map: readonly number[]): number {
    let c = 0;
    for (let i = 1; i < PLAYERS_PER_TEAM; i++) c += formationMoveCost(from, i, to, map[i]!, roles[i]!);
    return c;
  }

  it('every switch is a permutation that keeps the keeper in goal; same formation = identity', () => {
    expect(FORMATION_SWITCH).toHaveLength(36);
    for (const a of ALL_IDS) {
      for (const b of ALL_IDS) {
        const m = formationSwitchMap(a, b);
        expect(isPermutation(m), `${a}->${b}`).toBe(true);
        expect(m[0]).toBe(0);
        if (a === b) expect([...m]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      }
    }
    // Out-of-range ids fall back to 4-4-2 like getFormation.
    expect(formationSwitchMap(9 as FormationId, FormationId.F433)).toBe(formationSwitchMap(FormationId.F442, FormationId.F433));
    expect(formationSwitchMap(FormationId.F433, 9 as FormationId)).toBe(formationSwitchMap(FormationId.F433, FormationId.F442));
  });

  it('players never switch flanks and land on sensible roles', () => {
    for (const a of ALL_IDS) {
      for (const b of ALL_IDS) {
        const m = formationSwitchMap(a, b);
        for (let i = 1; i < PLAYERS_PER_TEAM; i++) {
          const sa = getFormation(a).slots[i]!;
          const sb = getFormation(b).slots[m[i]!]!;
          expect(sa.nz * sb.nz, `${a}->${b} slot ${i}`).toBeGreaterThanOrEqual(0);
          expect(roleFamiliarity(sa.role, sb.role), `${a}->${b} ${Role[sa.role]}->${Role[sb.role]}`).toBeGreaterThanOrEqual(40);
        }
      }
    }
  });

  it('natural switches: 4-4-2 -> 4-3-3 wide midfielders become wingers; 3-5-2 -> 5-3-2 wing-backs stay wing-backs', () => {
    const m1 = formationSwitchMap(FormationId.F442, FormationId.F433);
    expect(getFormation(FormationId.F433).slots[m1[5]!]!.role).toBe(Role.RW);
    expect(getFormation(FormationId.F433).slots[m1[8]!]!.role).toBe(Role.LW);
    for (let i = 1; i <= 4; i++) expect(m1[i]).toBe(i); // the back four stays
    const m2 = formationSwitchMap(FormationId.F352, FormationId.F532);
    expect(getFormation(FormationId.F532).slots[m2[4]!]!.role).toBe(Role.RWB);
    expect(getFormation(FormationId.F532).slots[m2[8]!]!.role).toBe(Role.LWB);
    expect(m2[9]).toBe(9);
    expect(m2[10]).toBe(10);
  });

  it('the assignment is optimal: no swap of two players lowers the total cost', () => {
    for (const a of ALL_IDS) {
      const roles = getFormation(a).slots.map((s) => s.role as number);
      for (const b of ALL_IDS) {
        const m = [...formationSwitchMap(a, b)];
        const base = totalCost(a, b, roles, m);
        for (let i = 1; i < PLAYERS_PER_TEAM; i++) {
          for (let j = i + 1; j < PLAYERS_PER_TEAM; j++) {
            const s = [...m];
            s[i] = m[j]!; s[j] = m[i]!;
            expect(totalCost(a, b, roles, s), `${a}->${b} swap ${i}/${j}`).toBeGreaterThanOrEqual(base);
          }
        }
      }
    }
  });

  it('remapFormation uses the players\' natural roles', () => {
    // A 4-4-2 whose wide midfielders are natural wingers and whose right CM is a natural CAM, switched to 4-2-3-1.
    const roles = getFormation(FormationId.F442).slots.map((s) => s.role as number);
    roles[5] = Role.RW; roles[8] = Role.LW; roles[6] = Role.CAM; roles[9] = Role.ST; roles[10] = Role.CDM;
    const out = new Array<number>(PLAYERS_PER_TEAM).fill(-1);
    remapFormation(FormationId.F442, FormationId.F4231, roles, 0, out);
    expect(isPermutation(out)).toBe(true);
    const to = getFormation(FormationId.F4231).slots;
    expect(to[out[6]!]!.role).toBe(Role.CAM);
    expect(to[out[9]!]!.role).toBe(Role.ST);
    expect(to[out[10]!]!.role).toBe(Role.CDM);
    expect(to[out[5]!]!.role).toBe(Role.RM);
    expect(to[out[8]!]!.role).toBe(Role.LM);
  });

  it('switching away and back puts every player on a slot of his natural role again', () => {
    const out = new Array<number>(PLAYERS_PER_TEAM).fill(-1);
    for (const y of ALL_IDS) {
      for (const x of ALL_IDS) {
        // A squad built for formation y is moved into formation x, then switched back to y.
        const m = formationSwitchMap(y, x);
        const naturalAtX = new Array<number>(PLAYERS_PER_TEAM).fill(-1);
        for (let i = 0; i < PLAYERS_PER_TEAM; i++) naturalAtX[m[i]!] = getFormation(y).slots[i]!.role;
        remapFormation(x, y, naturalAtX, 0, out);
        expect(isPermutation(out)).toBe(true);
        for (let k = 0; k < PLAYERS_PER_TEAM; k++) {
          expect(getFormation(y).slots[out[k]!]!.role, `${y}->${x}->${y} player ${k}`).toBe(naturalAtX[k]);
        }
      }
    }
  });

  it('remapFormation keeps whoever is in goal in the keeper slot (keeper sent off, outfielder in goal)', () => {
    const roles = getFormation(FormationId.F433).slots.map((s) => s.role as number);
    roles[0] = -1; // the original keeper was sent off
    roles[7] = Role.CM; // the left CM went in goal
    const out = new Array<number>(PLAYERS_PER_TEAM).fill(-1);
    remapFormation(FormationId.F433, FormationId.F433, roles, 7, out);
    expect(isPermutation(out)).toBe(true);
    expect(out[7]).toBe(0);
    expect(out[0]).not.toBe(0);
    // Out-of-range keeper index falls back to slot 0.
    remapFormation(FormationId.F433, FormationId.F442, getFormation(FormationId.F433).slots.map((s) => s.role), 42, out);
    expect(out[0]).toBe(0);
  });

  it('a team playing short leaves the least important slot empty (fills centre-backs and holding midfielders first)', () => {
    const out = new Array<number>(PLAYERS_PER_TEAM).fill(-1);
    for (const a of ALL_IDS) {
      for (const b of ALL_IDS) {
        const minP = Math.min(...getFormation(b).slots.slice(1).map((s) => ROLE_FILL_PRIORITY[s.role]!));
        for (let e = 1; e < PLAYERS_PER_TEAM; e++) {
          const roles = getFormation(a).slots.map((s) => s.role as number);
          roles[e] = -1;
          remapFormation(a, b, roles, 0, out);
          expect(isPermutation(out)).toBe(true);
          const r = getFormation(b).slots[out[e]!]!.role;
          expect(ROLE_FILL_PRIORITY[r]!, `${a}->${b} empty ${e} on ${Role[r]}`).toBeLessThanOrEqual(minP + 15);
          expect(r === Role.CB || r === Role.CDM || r === Role.GK, `${a}->${b} empty ${e} on ${Role[r]}`).toBe(false);
        }
      }
    }
    // Centre-back sent off in a 4-4-2: re-balancing in place moves somebody into the centre-back slot.
    const roles = getFormation(FormationId.F442).slots.map((s) => s.role as number);
    roles[2] = -1;
    remapFormation(FormationId.F442, FormationId.F442, roles, 0, out);
    expect(out[2]).not.toBe(2);
    expect([2, 3].every((cb) => out.indexOf(cb) !== 2)).toBe(true);
  });

  it('deterministic and stateless: interleaved calls give identical results', () => {
    const a = new Array<number>(PLAYERS_PER_TEAM).fill(0);
    const b = new Array<number>(PLAYERS_PER_TEAM).fill(0);
    const roles = getFormation(FormationId.F352).slots.map((s) => s.role as number);
    remapFormation(FormationId.F352, FormationId.F4231, roles, 0, a);
    const other = getFormation(FormationId.F532).slots.map((s) => s.role as number);
    other[4] = -1;
    remapFormation(FormationId.F532, FormationId.F41212, other, 0, b);
    remapFormation(FormationId.F352, FormationId.F4231, roles, 0, b);
    expect(b).toEqual(a);
    expect(a).toEqual([...formationSwitchMap(FormationId.F352, FormationId.F4231)]);
  });
});
