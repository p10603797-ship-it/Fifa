/**
 * [DAT-04] Formation data: neutral-phase home positions for the six formations (BRIEF §7), the line each slot
 * belongs to, mirror partners, role familiarity and the in-match formation switch mapping.
 *
 * Coordinates (contracts/data.ts FormationSlot): normalised for a team attacking +x, neutral phase (ball on the
 * centre spot, nobody in possession yet). nx: -1 own goal line .. +1 opposition goal line (x = nx * 52.5);
 * nz: +1 = right flank (+z, near touchline; z = nz * 34). For a team attacking -x mirror both:
 * x = -nx * 52.5, z = -nz * 34 (`slotWorld`).
 * Slot order: index 0 = GK, then defenders right to left, then midfield lines from the deepest to the most
 * advanced (right to left within a line), then forwards right to left. Every formation is left/right symmetric.
 * The role sequence per formation is the Wave 0 one (DAT-01/02 build squads in this order); only positions changed.
 *
 * The values are hand-authored (no randomness), so they are identical in every build. The switch table is derived
 * from them deterministically at module load (integer costs, Hungarian assignment). Nothing here allocates after
 * module load; `remapFormation` and `slotWorld` are safe to call from sim/ai code.
 */
import { HALF_LENGTH, HALF_WIDTH, PLAYERS_PER_TEAM } from '../contracts/constants';
import type { Formation, FormationSlot } from '../contracts/data';
import { FormationId, Role } from '../contracts/enums';

const LOCAL_TUNING = { // TUNING-CR (formation switch / remap cost model; used only by the mapping helpers)
  /** Cost per familiarity point lost when a player takes a new slot, centimetres-equivalent (100 pts = 20 m). */
  remapRolePenaltyCm: 20,
  /** Cost per ROLE_FILL_PRIORITY point for leaving a new slot empty (team playing short), cm: large, so the most
   *  important slots are always filled first (CB 95 vs W 45 = 150 m outweighs any reshuffle). */
  remapEmptySlotCm: 300,
} as const;

// ---------------------------------------------------------------- lines and roles

/** Horizontal band a formation slot belongs to (formation-specific: a CDM is in the MID line of a flat 4-3-3). */
export enum ShapeLine {
  GK = 0,
  /** Back line (back four, back three, back five incl. its wing-backs). */
  DEF = 1,
  /** Holding line in front of the defence (4-2-3-1 pivots, the 4-1-2-1-2 anchor). */
  DM = 2,
  MID = 3,
  /** Attacking-midfield line (4-2-3-1 three, 4-1-2-1-2 tip of the diamond). */
  AM = 4,
  FWD = 5,
}

const NUM_ROLES = 15;

/** Mirror image of a role across the pitch's long axis (RB <-> LB ...); central roles map to themselves. */
export function mirrorRole(role: Role): Role {
  switch (role) {
    case Role.RB: return Role.LB;
    case Role.LB: return Role.RB;
    case Role.RWB: return Role.LWB;
    case Role.LWB: return Role.RWB;
    case Role.RM: return Role.LM;
    case Role.LM: return Role.RM;
    case Role.RW: return Role.LW;
    case Role.LW: return Role.RW;
    default: return role;
  }
}

/** Flank of a role for a team attacking +x: +1 right (+z), -1 left (-z), 0 central. */
export function roleSide(role: Role): number {
  switch (role) {
    case Role.RB: case Role.RWB: case Role.RM: case Role.RW: return 1;
    case Role.LB: case Role.LWB: case Role.LM: case Role.LW: return -1;
    default: return 0;
  }
}

/**
 * How well a player whose natural position is the row role plays the column role, 0..100 (symmetric; GK only
 * fits GK). Used by the formation remap, and available to subs/bench logic (RUL-10, DAT-02).
 * Order: GK RB CB LB RWB LWB CDM CM CAM RM LM RW LW ST CF (enum Role order).
 */
export const ROLE_FAMILIARITY: readonly (readonly number[])[] = [
  /* GK  */ [100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  /* RB  */ [0, 100, 60, 80, 90, 70, 45, 35, 15, 65, 45, 45, 30, 10, 10],
  /* CB  */ [0, 60, 100, 60, 40, 40, 70, 45, 20, 25, 25, 15, 15, 20, 15],
  /* LB  */ [0, 80, 60, 100, 70, 90, 45, 35, 15, 45, 65, 30, 45, 10, 10],
  /* RWB */ [0, 90, 40, 70, 100, 80, 40, 45, 25, 80, 55, 65, 45, 15, 15],
  /* LWB */ [0, 70, 40, 90, 80, 100, 40, 45, 25, 55, 80, 45, 65, 15, 15],
  /* CDM */ [0, 45, 70, 45, 40, 40, 100, 90, 60, 45, 45, 25, 25, 25, 30],
  /* CM  */ [0, 35, 45, 35, 45, 45, 90, 100, 85, 70, 70, 50, 50, 45, 55],
  /* CAM */ [0, 15, 20, 15, 25, 25, 60, 85, 100, 65, 65, 70, 70, 70, 90],
  /* RM  */ [0, 65, 25, 45, 80, 55, 45, 70, 65, 100, 80, 90, 70, 45, 50],
  /* LM  */ [0, 45, 25, 65, 55, 80, 45, 70, 65, 80, 100, 70, 90, 45, 50],
  /* RW  */ [0, 45, 15, 30, 65, 45, 25, 50, 70, 90, 70, 100, 85, 65, 70],
  /* LW  */ [0, 30, 15, 45, 45, 65, 25, 50, 70, 70, 90, 85, 100, 65, 70],
  /* ST  */ [0, 10, 20, 10, 15, 15, 25, 45, 70, 45, 45, 65, 65, 100, 90],
  /* CF  */ [0, 10, 15, 10, 15, 15, 30, 55, 90, 50, 50, 70, 70, 90, 100],
];

/** Familiarity 0..100 of a player with natural role `natural` playing `role` (0 for unknown roles). */
export function roleFamiliarity(natural: Role, role: Role): number {
  const row = ROLE_FAMILIARITY[natural];
  return row === undefined ? 0 : (row[role] ?? 0);
}

/**
 * How important it is to keep a role's slot filled when a team plays short (0..100, higher = fill first).
 * Used by `remapFormation` to decide which slot stays empty; TAI-01 may use it to pick which role stretches.
 */
export const ROLE_FILL_PRIORITY: readonly number[] = [
  /* GK */ 100, /* RB */ 75, /* CB */ 95, /* LB */ 75, /* RWB */ 70, /* LWB */ 70, /* CDM */ 85, /* CM */ 70,
  /* CAM */ 50, /* RM */ 55, /* LM */ 55, /* RW */ 45, /* LW */ 45, /* ST */ 60, /* CF */ 55,
];

// ---------------------------------------------------------------- formations

/** Slot from metres (team attacking +x, neutral phase). */
const m = (role: Role, x: number, z: number): FormationSlot => ({ role, nx: x / HALF_LENGTH, nz: z / HALF_WIDTH });

/** Keeper ~6.3 m off his line (just outside the goal area); GKP-01 owns the live keeper position. */
const GK_X = -46.2;
const GK = (): FormationSlot => m(Role.GK, GK_X, 0);

interface FormationDef {
  formation: Formation;
  lines: ShapeLine[];
}

const { GK: L_GK, DEF, DM, MID, AM, FWD } = ShapeLine;

/*
 * Neutral mid-block shapes in metres. Back line 23-28 m from the halfway line, lines 6-12 m apart
 * (T_AI.lineSpacingMax = 14), everybody in his own half, widths 42-52 m of the 68 m pitch.
 */
const DEFS: readonly FormationDef[] = [
  { // 4-4-2: flat back four, flat four in midfield, two strikers side by side.
    formation: { id: FormationId.F442, name: '4-4-2', slots: [
      GK(),
      m(Role.RB, -24, 21), m(Role.CB, -26.5, 7), m(Role.CB, -26.5, -7), m(Role.LB, -24, -21),
      m(Role.RM, -12.5, 22.5), m(Role.CM, -14.5, 7), m(Role.CM, -14.5, -7), m(Role.LM, -12.5, -22.5),
      m(Role.ST, -3.5, 6.5), m(Role.ST, -3.5, -6.5),
    ] },
    lines: [L_GK, DEF, DEF, DEF, DEF, MID, MID, MID, MID, FWD, FWD],
  },
  { // 4-3-3: midfield triangle with the holding player at its base, wingers high and wide, a lone striker.
    formation: { id: FormationId.F433, name: '4-3-3', slots: [
      GK(),
      m(Role.RB, -24, 21.5), m(Role.CB, -26.5, 7), m(Role.CB, -26.5, -7), m(Role.LB, -24, -21.5),
      m(Role.CM, -13.5, 10.5), m(Role.CDM, -19, 0), m(Role.CM, -13.5, -10.5),
      m(Role.RW, -5, 24), m(Role.ST, -3, 0), m(Role.LW, -5, -24),
    ] },
    lines: [L_GK, DEF, DEF, DEF, DEF, MID, MID, MID, FWD, FWD, FWD],
  },
  { // 4-2-3-1: double pivot, three attacking midfielders, one striker.
    formation: { id: FormationId.F4231, name: '4-2-3-1', slots: [
      GK(),
      m(Role.RB, -24, 21), m(Role.CB, -26.5, 7), m(Role.CB, -26.5, -7), m(Role.LB, -24, -21),
      m(Role.CDM, -18.5, 6.5), m(Role.CDM, -18.5, -6.5),
      m(Role.RM, -9.5, 22), m(Role.CAM, -10.5, 0), m(Role.LM, -9.5, -22),
      m(Role.ST, -2.5, 0),
    ] },
    lines: [L_GK, DEF, DEF, DEF, DEF, DM, DM, AM, AM, AM, FWD],
  },
  { // 3-5-2: back three, wing-backs high and wide, anchor plus two central midfielders, two strikers.
    formation: { id: FormationId.F352, name: '3-5-2', slots: [
      GK(),
      m(Role.CB, -25, 13), m(Role.CB, -27.5, 0), m(Role.CB, -25, -13),
      m(Role.RWB, -14, 26), m(Role.CM, -12.5, 9.5), m(Role.CDM, -19, 0), m(Role.CM, -12.5, -9.5), m(Role.LWB, -14, -26),
      m(Role.ST, -3.5, 6.5), m(Role.ST, -3.5, -6.5),
    ] },
    lines: [L_GK, DEF, DEF, DEF, MID, MID, MID, MID, MID, FWD, FWD],
  },
  { // 5-3-2: back five (wing-backs a step ahead of the three centre-backs), flat three, two strikers.
    formation: { id: FormationId.F532, name: '5-3-2', slots: [
      GK(),
      m(Role.RWB, -22, 25), m(Role.CB, -26, 12), m(Role.CB, -28, 0), m(Role.CB, -26, -12), m(Role.LWB, -22, -25),
      m(Role.CM, -14, 11.5), m(Role.CM, -15.5, 0), m(Role.CM, -14, -11.5),
      m(Role.ST, -3.5, 7), m(Role.ST, -3.5, -7),
    ] },
    lines: [L_GK, DEF, DEF, DEF, DEF, DEF, MID, MID, MID, FWD, FWD],
  },
  { // 4-1-2-1-2: narrow diamond (anchor, two shuttlers, playmaker), full-backs give the width, two strikers.
    formation: { id: FormationId.F41212, name: '4-1-2-1-2', slots: [
      GK(),
      m(Role.RB, -23, 22.5), m(Role.CB, -26.5, 7), m(Role.CB, -26.5, -7), m(Role.LB, -23, -22.5),
      m(Role.CDM, -19.5, 0),
      m(Role.CM, -14, 11), m(Role.CM, -14, -11),
      m(Role.CAM, -8.5, 0),
      m(Role.ST, -3, 6.5), m(Role.ST, -3, -6.5),
    ] },
    lines: [L_GK, DEF, DEF, DEF, DEF, DM, MID, MID, AM, FWD, FWD],
  },
];

export const FORMATIONS: readonly Formation[] = DEFS.map((d) => d.formation);

export function getFormation(id: FormationId): Formation {
  return FORMATIONS[id] ?? FORMATIONS[0]!;
}

/** Per-formation metadata derived from the slots (index = FormationId). */
export interface FormationMeta {
  id: FormationId;
  /** ShapeLine per slot index. */
  lines: readonly ShapeLine[];
  /** Mirror partner per slot (itself for central slots on nz = 0). */
  mirror: readonly number[];
  /** Number of players in the back line (DEF line). */
  backCount: number;
  /** Slot indices of the back line, right to left. */
  backLine: readonly number[];
}

function buildMeta(d: FormationDef): FormationMeta {
  const slots = d.formation.slots;
  const mirror: number[] = [];
  const backLine: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    const a = slots[i]!;
    let partner = -1;
    for (let j = 0; j < slots.length; j++) {
      const b = slots[j]!;
      if (b.role === mirrorRole(a.role) && b.nx === a.nx && b.nz === -a.nz) { partner = j; break; }
    }
    mirror.push(partner);
    if (d.lines[i] === ShapeLine.DEF) backLine.push(i);
  }
  return { id: d.formation.id, lines: d.lines, mirror, backCount: backLine.length, backLine };
}

export const FORMATION_META: readonly FormationMeta[] = DEFS.map(buildMeta);

export function getFormationMeta(id: FormationId): FormationMeta {
  return FORMATION_META[id] ?? FORMATION_META[0]!;
}

/** Line of a formation slot. */
export function slotLine(id: FormationId, idx: number): ShapeLine {
  return getFormationMeta(id).lines[idx] ?? ShapeLine.MID;
}

/** Neutral home of a formation slot in pitch metres for a team attacking `dir` (+1 / -1). */
export function slotWorld(id: FormationId, idx: number, dir: number, out: { x: number; z: number }): void {
  const sl = getFormation(id).slots[idx] ?? getFormation(id).slots[0]!;
  out.x = dir * sl.nx * HALF_LENGTH;
  out.z = dir * sl.nz * HALF_WIDTH;
}

// ---------------------------------------------------------------- formation switch (in-match)

const N = PLAYERS_PER_TEAM;
const BIG = 1e9;
const INF = 1e15;
// Hungarian scratch (1-indexed, size N + 1), preallocated.
const H_COST: number[] = new Array<number>(N * N).fill(0);
const H_U: number[] = new Array<number>(N + 1).fill(0);
const H_V: number[] = new Array<number>(N + 1).fill(0);
const H_P: number[] = new Array<number>(N + 1).fill(0);
const H_WAY: number[] = new Array<number>(N + 1).fill(0);
const H_MINV: number[] = new Array<number>(N + 1).fill(0);
const H_USED: number[] = new Array<number>(N + 1).fill(0);

/** Min-cost perfect assignment over H_COST (row i -> column out[i]). Integer costs, exact and deterministic. */
function hungarian(out: number[]): void {
  for (let j = 0; j <= N; j++) { H_U[j] = 0; H_V[j] = 0; H_P[j] = 0; H_WAY[j] = 0; }
  for (let i = 1; i <= N; i++) {
    H_P[0] = i;
    let j0 = 0;
    for (let j = 0; j <= N; j++) { H_MINV[j] = INF; H_USED[j] = 0; }
    do {
      H_USED[j0] = 1;
      const i0 = H_P[j0]!;
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= N; j++) {
        if (H_USED[j]) continue;
        const cur = H_COST[(i0 - 1) * N + (j - 1)]! - H_U[i0]! - H_V[j]!;
        if (cur < H_MINV[j]!) { H_MINV[j] = cur; H_WAY[j] = j0; }
        if (H_MINV[j]! < delta) { delta = H_MINV[j]!; j1 = j; }
      }
      for (let j = 0; j <= N; j++) {
        if (H_USED[j]) { H_U[H_P[j]!] = H_U[H_P[j]!]! + delta; H_V[j] = H_V[j]! - delta; } else H_MINV[j] = H_MINV[j]! - delta;
      }
      j0 = j1;
    } while (H_P[j0] !== 0);
    do { const j1 = H_WAY[j0]!; H_P[j0] = H_P[j1]!; j0 = j1; } while (j0 !== 0);
  }
  for (let j = 1; j <= N; j++) out[H_P[j]! - 1] = j - 1;
}

/**
 * Re-map players when a team switches formation in-match (Command.SET_FORMATION, TAI-14).
 * Input: `naturalRoles[i]` = natural Role (PlayerData.pos) of the player currently at formation index i of `from`,
 * or -1 if nobody active holds that index (sent off); `keeperIdx` = formation index of the player currently in goal
 * (0 normally). Output: `out[i]` = new formation index for the player at old index i (a permutation of 0..10;
 * the keeper always gets 0). Cost = distance between the old and new neutral slots + a familiarity penalty for
 * the new role; empty indices take the slots that matter least (ROLE_FILL_PRIORITY). Deterministic, no allocation.
 * Then set p.formIdx = out[p.formIdx] and p.role = getFormation(to).slots[p.formIdx].role.
 * With from === to it re-balances a team playing short (e.g. after a centre-back is sent off a midfielder takes
 * the centre-back slot and the least important slot is left empty).
 */
/**
 * Cost (integer, centimetres-equivalent) of moving the player at slot `i` of formation `from`, whose natural role
 * is `natural` (-1 = nobody there), to slot `j` of formation `to`: distance between the two neutral slots plus
 * the familiarity penalty for the new role; an empty index costs the new slot's fill priority instead.
 * The keeper constraint is applied by remapFormation, not here.
 */
export function formationMoveCost(from: FormationId, i: number, to: FormationId, j: number, natural: number): number {
  const sb = getFormation(to).slots[j] ?? getFormation(to).slots[0]!;
  if (natural < 0 || natural >= NUM_ROLES) return ROLE_FILL_PRIORITY[sb.role]! * LOCAL_TUNING.remapEmptySlotCm;
  const sa = getFormation(from).slots[i] ?? getFormation(from).slots[0]!;
  const dx = (sa.nx - sb.nx) * HALF_LENGTH;
  const dz = (sa.nz - sb.nz) * HALF_WIDTH;
  return Math.round(Math.sqrt(dx * dx + dz * dz) * 100) +
    (100 - roleFamiliarity(natural as Role, sb.role)) * LOCAL_TUNING.remapRolePenaltyCm;
}

export function remapFormation(
  from: FormationId, to: FormationId, naturalRoles: ArrayLike<number>, keeperIdx: number, out: number[],
): void {
  const gk = keeperIdx >= 0 && keeperIdx < N ? keeperIdx | 0 : 0;
  for (let i = 0; i < N; i++) {
    const nat = naturalRoles[i] ?? -1;
    for (let j = 0; j < N; j++) {
      H_COST[i * N + j] = i === gk || j === 0 ? (i === gk && j === 0 ? 0 : BIG) : formationMoveCost(from, i, to, j, nat);
    }
  }
  hungarian(out);
}

function buildSwitchTable(): readonly (readonly number[])[] {
  const table: number[][] = [];
  const roles: number[] = new Array<number>(N).fill(0);
  for (let f = 0; f < FORMATIONS.length; f++) {
    for (let t = 0; t < FORMATIONS.length; t++) {
      const slots = FORMATIONS[f]!.slots;
      for (let i = 0; i < N; i++) roles[i] = slots[i]!.role;
      const out: number[] = new Array<number>(N).fill(0);
      remapFormation(f as FormationId, t as FormationId, roles, 0, out);
      table.push(out);
    }
  }
  return table;
}

/**
 * Default switch mapping, index [from * 6 + to]: entry[i] = new formation index for the player at old index i,
 * assuming each player's natural role is his old slot's role (use `remapFormation` with real roles in a match).
 */
export const FORMATION_SWITCH: readonly (readonly number[])[] = buildSwitchTable();

/** Default switch mapping from one formation to another (see FORMATION_SWITCH). */
export function formationSwitchMap(from: FormationId, to: FormationId): readonly number[] {
  const f = FORMATIONS[from] === undefined ? 0 : from;
  const t = FORMATIONS[to] === undefined ? 0 : to;
  return FORMATION_SWITCH[f * FORMATIONS.length + t]!;
}
