/**
 * [DAT-02] Squad generator: invented names, positions, attributes, height, feet, skill ratings, shirt numbers.
 * Spec: BRIEF §15 (18 players per club: 11 starters + 7 subs incl. 2 keepers; outfield attributes 1-99; keeper
 * attributes; height, preferred foot, weak foot 1-5, skill moves 1-5, position, shirt number; names from
 * mixed-origin lists screened against famous footballers) and §2 (everything invented).
 *
 * Used by tools/gen-data.ts (DAT-01), which commits the output, so this runs at generation time only (never per
 * tick). Deterministic: the output depends only on the RNG stream and the params; no Math.random, clocks or
 * engine-dependent maths (only + - * / and Math.round/floor/min), so every Node version produces identical data.
 *
 * Squad layout (contracts/data.ts Club.squad): 0..10 starters in formation slot order (0 = GK, see
 * data/formations.ts), 11..17 bench: 11 = reserve keeper, then CB, full-back or wing-back, deep midfielder,
 * attacking/central midfielder, wide player (or a third centre-back for back-three formations), striker.
 *
 * Attributes: per role a profile of offsets from the player's level, a per-player archetype tweak, a club-style
 * bias, a height effect and noise; then the attributes are calibrated so the role-weighted overall
 * (`computeOverall`, OVERALL_WEIGHTS) equals the player's target. Starter targets are centred on the club rating
 * (one star, spread both ways), so `squadRating(squad)` equals the club rating; bench players are weaker.
 */
import { ATTRIBUTE_KEYS, type AttributeKey, type PlayerData } from '../contracts/data';
import { FormationId, Foot, Role, TeamStyle } from '../contracts/enums';
import type { RngState } from '../contracts/state';
import { rngFloat } from '../sim/core/rng';
import { getFormation } from './formations';
import { nameKey, screenName } from './screen';

const LOCAL_TUNING = { // TUNING-CR (squad generation; generation-time only — re-run `npm run gen:data` after a change)
  /** Height limits for everybody, cm (BRIEF: 165-200). */
  heightMinCm: 165,
  heightMaxCm: 200,
  /** Keepers are never shorter than this, cm. */
  keeperHeightMinCm: 183,
  /** Starter overall spread around the club rating, overall points, 1 sd (before centring). */
  starterSpreadSd: 3,
  /** Extra overall points for the club's star starter (re-centred, so the mean stays on the rating). */
  starBoost: 5,
  /** Bench outfield players sit this many overall points below the club rating on average. */
  benchDrop: 5,
  /** Bench spread, overall points, 1 sd. */
  benchSpreadSd: 2.5,
  /** Reserve keeper sits this many overall points below the club rating on average. */
  benchKeeperDrop: 7,
  /** Player overall targets are clamped to this range. */
  targetMin: 40,
  targetMax: 95,
  /** Attribute noise around the role profile, attribute points, 1 sd. */
  attrNoiseSd: 3.5,
  /** Lowest generated value of any attribute (contract range is 1..99). */
  attrMin: 5,
  attrMax: 99,
  /** Outfield players' keeper attributes: base value and uniform extra range, points. */
  outfieldGkBase: 6,
  outfieldGkRange: 10,
  /** Attribute change per cm above the role's mean height (heading, strength up; agility, acceleration down). */
  heightHeadingPerCm: 0.5,
  heightStrengthPerCm: 0.45,
  heightAgilityPerCm: -0.5,
  heightAccelPerCm: -0.3,
  /** Weak foot and skill moves: level effect per overall point above 75, and noise sd (stars). */
  weakFootPerLevel: 0.03,
  weakFootNoiseSd: 0.75,
  skillPerDribbling: 0.04,
  skillNoiseSd: 0.55,
  /** Chance the surname comes from a different origin than the first name. */
  mixedOriginChance: 0.35,
  /** Chance of a double-barrelled surname (two origins). */
  hyphenChance: 0.05,
  /** Max candidate names tried per player before generation fails loudly. */
  maxNameAttempts: 500,
} as const;

// ---------------------------------------------------------------- RNG

/** Either the sim's sfc32 state (src/sim/core/rng.ts, e.g. tools/lib/rand.ts createRng) or a function returning
 *  uniform floats in [0, 1). A function returning uint32 values (e.g. `() => rngNext(r)`) is also accepted. */
export type GenRng = RngState | (() => number);

const INV_2_32 = 1 / 4294967296;

function toNext(rng: GenRng): () => number {
  if (typeof rng !== 'function') return () => rngFloat(rng);
  return () => {
    const v = rng();
    if (v >= 0 && v < 1) return v;
    if (Number.isInteger(v) && v >= 1 && v < 4294967296) return v * INV_2_32;
    throw new Error(`playerGen: rng returned ${v}; expected a float in [0, 1) or a uint32`);
  };
}

/** Approximately normal (mean 0, sd 1), Irwin-Hall of 4 uniforms (same shape as sim rngGauss). */
function gauss(next: () => number): number {
  return (next() + next() + next() + next() - 2) * 1.7320508075688772;
}

function pickIndex(next: () => number, n: number): number {
  const i = Math.floor(next() * n);
  return i < n ? i : n - 1;
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[pickIndex(next, items.length)]!;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------- roles

/** Attribute profile groups. */
export type RoleGroup = 'GK' | 'CB' | 'FB' | 'WB' | 'DM' | 'CM' | 'AM' | 'WM' | 'W' | 'ST' | 'CF';

export function roleGroup(role: Role): RoleGroup {
  switch (role) {
    case Role.GK: return 'GK';
    case Role.CB: return 'CB';
    case Role.RB: case Role.LB: return 'FB';
    case Role.RWB: case Role.LWB: return 'WB';
    case Role.CDM: return 'DM';
    case Role.CM: return 'CM';
    case Role.CAM: return 'AM';
    case Role.RM: case Role.LM: return 'WM';
    case Role.RW: case Role.LW: return 'W';
    case Role.ST: return 'ST';
    case Role.CF: return 'CF';
    default: return 'CM';
  }
}

const NUM_ATTRS = ATTRIBUTE_KEYS.length;
/** ATTRIBUTE_KEYS 0..19 are outfield attributes, 20..24 keeper attributes. */
const NUM_OUTFIELD = 20;
const ATTR_INDEX = Object.fromEntries(ATTRIBUTE_KEYS.map((k, i) => [k, i])) as Record<AttributeKey, number>;

type Partial25 = Partial<Record<AttributeKey, number>>;

function vec(p: Partial25): number[] {
  const v = new Array<number>(NUM_ATTRS).fill(0);
  for (const k of ATTRIBUTE_KEYS) v[ATTR_INDEX[k]] = p[k] ?? 0;
  return v;
}

/**
 * Overall formula: per role group, weights in percent (sum 100) over the attributes that matter for the role.
 * overall = round(sum(weight * attribute) / 100). Outfield groups weigh only outfield attributes; keepers only
 * keeper attributes.
 */
export const OVERALL_WEIGHTS: Readonly<Record<RoleGroup, Partial25>> = {
  GK: { gkDiving: 21, gkHandling: 21, gkReflexes: 23, gkPositioning: 23, gkKicking: 12 },
  CB: {
    standingTackle: 17, slidingTackle: 12, interceptions: 14, heading: 12, strength: 12, composure: 6,
    shortPassing: 6, longPassing: 4, ballControl: 4, sprintSpeed: 5, acceleration: 4, stamina: 4,
  },
  FB: {
    sprintSpeed: 10, acceleration: 8, stamina: 9, crossing: 9, standingTackle: 13, slidingTackle: 10,
    interceptions: 11, shortPassing: 8, ballControl: 7, dribbling: 5, heading: 4, agility: 3, composure: 3,
  },
  WB: {
    sprintSpeed: 11, acceleration: 9, stamina: 10, crossing: 12, dribbling: 8, ballControl: 8, shortPassing: 8,
    standingTackle: 10, slidingTackle: 6, interceptions: 9, agility: 4, composure: 3, vision: 2,
  },
  DM: {
    standingTackle: 14, slidingTackle: 8, interceptions: 15, shortPassing: 13, longPassing: 9, strength: 9,
    stamina: 8, ballControl: 7, vision: 5, composure: 7, heading: 3, acceleration: 2,
  },
  CM: {
    shortPassing: 16, longPassing: 12, vision: 12, ballControl: 12, dribbling: 7, stamina: 8, interceptions: 6,
    standingTackle: 5, composure: 8, longShots: 6, acceleration: 3, agility: 3, shotPower: 2,
  },
  AM: {
    shortPassing: 13, vision: 15, ballControl: 14, dribbling: 12, agility: 6, acceleration: 6, finishing: 9,
    longShots: 8, composure: 8, curve: 4, shotPower: 3, longPassing: 2,
  },
  WM: {
    sprintSpeed: 11, acceleration: 10, crossing: 13, dribbling: 13, ballControl: 12, shortPassing: 10, stamina: 8,
    agility: 6, vision: 5, curve: 4, finishing: 3, longShots: 2, composure: 3,
  },
  W: {
    sprintSpeed: 11, acceleration: 11, agility: 8, dribbling: 15, ballControl: 13, crossing: 9, finishing: 10,
    shortPassing: 7, vision: 5, curve: 4, longShots: 4, composure: 3,
  },
  ST: {
    finishing: 20, composure: 10, heading: 10, shotPower: 10, ballControl: 10, acceleration: 8, sprintSpeed: 8,
    strength: 8, dribbling: 6, longShots: 4, agility: 3, shortPassing: 3,
  },
  CF: {
    finishing: 16, ballControl: 14, dribbling: 11, shortPassing: 9, vision: 9, composure: 9, acceleration: 7,
    agility: 6, shotPower: 6, longShots: 6, sprintSpeed: 4, curve: 3,
  },
};

const GROUPS: readonly RoleGroup[] = ['GK', 'CB', 'FB', 'WB', 'DM', 'CM', 'AM', 'WM', 'W', 'ST', 'CF'];
const WEIGHT_VEC: Readonly<Record<RoleGroup, number[]>> = Object.fromEntries(
  GROUPS.map((g) => [g, vec(OVERALL_WEIGHTS[g])]),
) as Record<RoleGroup, number[]>;
/** Attribute indices with a weight, heaviest first (ties by index): the fine-tune order. */
const WEIGHT_ORDER: Readonly<Record<RoleGroup, number[]>> = Object.fromEntries(
  GROUPS.map((g) => {
    const w = WEIGHT_VEC[g];
    const idx = w.map((_, i) => i).filter((i) => w[i]! > 0);
    idx.sort((a, b) => w[b]! - w[a]! || a - b);
    return [g, idx];
  }),
) as Record<RoleGroup, number[]>;

/** Role-weighted overall (1..99) of a player's attributes, evaluated for `role` (any role, not only his own). */
export function computeOverall(attrs: Readonly<Record<AttributeKey, number>>, role: Role): number {
  const w = WEIGHT_VEC[roleGroup(role)];
  let sum = 0;
  for (let i = 0; i < NUM_ATTRS; i++) sum += w[i]! * attrs[ATTRIBUTE_KEYS[i]!];
  return Math.round(sum / 100);
}

function weightedSum(v: readonly number[], w: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < NUM_ATTRS; i++) sum += w[i]! * v[i]!;
  return sum;
}

// ---------------------------------------------------------------- attribute profiles

/**
 * Offsets from the player's level for the 20 outfield attributes, columns in ATTRIBUTE_KEYS order:
 *   acc spd agi bc dri sp lp cro vis fin shp ls cur hea st sl int str sta com
 */
const OUTFIELD_PROFILE: Readonly<Record<RoleGroup, readonly number[]>> = {
  CB: [-8, -5, -14, -12, -20, -8, -10, -25, -20, -35, -10, -30, -28, 6, 6, 4, 5, 6, -4, -3],
  FB: [1, 2, -4, -6, -8, -5, -10, -2, -14, -30, -15, -25, -15, -8, 3, 2, 2, -4, 2, -6],
  WB: [3, 4, -2, -3, -4, -4, -8, 2, -10, -25, -15, -22, -10, -10, -2, -4, -2, -6, 4, -6],
  DM: [-8, -8, -10, -4, -10, 1, 0, -18, -6, -25, -8, -12, -15, -4, 4, 1, 4, 2, 1, -1],
  CM: [-5, -6, -4, 1, -3, 3, 1, -10, 2, -14, -6, -3, -6, -12, -8, -14, -6, -6, 0, 0],
  AM: [-2, -6, 2, 3, 2, 1, -6, -8, 4, -2, -6, -1, -2, -22, -32, -38, -22, -12, -8, 0],
  WM: [2, 3, 0, 0, 1, -2, -8, 2, -4, -12, -8, -10, -3, -20, -24, -28, -16, -12, -1, -5],
  W: [3, 3, 2, 1, 3, -4, -12, -3, -4, -2, -6, -6, -4, -18, -38, -42, -26, -12, -6, -3],
  ST: [-1, -1, -4, -1, -4, -10, -20, -20, -12, 5, 1, -6, -12, 1, -40, -45, -30, 1, -8, 1],
  CF: [-1, -4, -1, 2, 1, -3, -10, -12, -2, 1, -3, -2, -6, -10, -40, -45, -28, -8, -8, 1],
  // Keepers: outfield skills far below their level; strength/composure/kicking-related passing least so.
  GK: [-30, -32, -20, -40, -50, -35, -25, -55, -35, -60, -25, -60, -50, -55, -60, -60, -45, -15, -40, -20],
};

/** Keeper attribute offsets: gkDiving gkHandling gkReflexes gkPositioning gkKicking. */
const KEEPER_PROFILE: readonly number[] = [1, 0, 2, 1, -6];

/** Mean and sd of height per group, cm. */
const HEIGHT: Readonly<Record<RoleGroup, readonly [number, number]>> = {
  GK: [190, 4], CB: [187, 4], FB: [178, 4.5], WB: [177, 4.5], DM: [182, 5], CM: [179, 5], AM: [175, 5],
  WM: [175, 5], W: [174, 5], ST: [183, 6], CF: [178, 5.5],
};

/** Base weak foot (1..5 scale) per group before level and noise. */
const WEAK_FOOT_BASE: Readonly<Record<RoleGroup, number>> = {
  GK: 2.2, CB: 2.5, FB: 2.7, WB: 2.8, DM: 2.8, CM: 3.1, AM: 3.4, WM: 3.1, W: 3.4, ST: 3.3, CF: 3.4,
};

/** Base skill-move stars per group before dribbling and noise (keepers are always 1). */
const SKILL_BASE: Readonly<Record<RoleGroup, number>> = {
  GK: 1, CB: 2.2, FB: 2.5, WB: 2.8, DM: 2.4, CM: 2.8, AM: 3.4, WM: 3.2, W: 3.5, ST: 3.2, CF: 3.5,
};

/** Probability a player in this role is left-footed (left-sided roles mostly left, some inverted wingers). */
function leftFootChance(role: Role): number {
  switch (role) {
    case Role.GK: return 0.12;
    case Role.LB: return 0.65;
    case Role.LWB: return 0.6;
    case Role.LM: return 0.6;
    case Role.LW: return 0.35;
    case Role.RW: return 0.45;
    case Role.RB: case Role.RWB: return 0.08;
    case Role.RM: return 0.15;
    case Role.CAM: return 0.22;
    case Role.CDM: return 0.2;
    case Role.CB: return 0.25;
    default: return 0.22;
  }
}

interface Archetype {
  name: string;
  attrs: Partial25;
  /** Height shift, cm. */
  heightCm?: number;
  /** Skill-move shift, stars. */
  skill?: number;
}

const BALANCED: Archetype = { name: 'balanced', attrs: {} };

/** Per-group playing styles that make players of one role differ from each other. */
const ARCHETYPES: Readonly<Record<RoleGroup, readonly Archetype[]>> = {
  GK: [
    BALANCED,
    { name: 'shot-stopper', attrs: { gkReflexes: 5, gkDiving: 5, gkKicking: -4, gkPositioning: -2 } },
    { name: 'sweeper', attrs: { gkPositioning: 4, gkKicking: 6, acceleration: 6, sprintSpeed: 5, shortPassing: 6, gkReflexes: -3 } },
    { name: 'commander', attrs: { gkHandling: 5, strength: 6, gkPositioning: 3, gkDiving: -3 }, heightCm: 2 },
  ],
  CB: [
    BALANCED,
    { name: 'stopper', attrs: { standingTackle: 3, heading: 4, strength: 5, shortPassing: -4, ballControl: -3 }, heightCm: 2 },
    { name: 'ball-player', attrs: { shortPassing: 6, longPassing: 6, composure: 3, vision: 4, ballControl: 3, strength: -3, heading: -3 } },
    { name: 'quick', attrs: { acceleration: 6, sprintSpeed: 7, interceptions: 2, heading: -4, strength: -2 }, heightCm: -2 },
  ],
  FB: [
    BALANCED,
    { name: 'attacking', attrs: { crossing: 5, sprintSpeed: 3, stamina: 3, dribbling: 3, standingTackle: -4, interceptions: -3 }, skill: 0.4 },
    { name: 'defensive', attrs: { standingTackle: 4, slidingTackle: 4, interceptions: 3, crossing: -5, dribbling: -3 } },
  ],
  WB: [
    BALANCED,
    { name: 'flyer', attrs: { sprintSpeed: 5, acceleration: 4, crossing: 3, standingTackle: -4, strength: -3 }, skill: 0.3 },
    { name: 'tireless', attrs: { stamina: 7, interceptions: 3, standingTackle: 2, dribbling: -3, agility: -2 } },
  ],
  DM: [
    BALANCED,
    { name: 'destroyer', attrs: { standingTackle: 5, slidingTackle: 4, strength: 5, interceptions: 3, dribbling: -4, vision: -4 } },
    { name: 'deep-playmaker', attrs: { shortPassing: 5, longPassing: 6, vision: 5, curve: 3, standingTackle: -4, strength: -3 } },
  ],
  CM: [
    BALANCED,
    { name: 'box-to-box', attrs: { stamina: 6, strength: 3, standingTackle: 3, longShots: 2, curve: -3, vision: -2 } },
    { name: 'playmaker', attrs: { vision: 6, shortPassing: 4, longPassing: 4, ballControl: 2, strength: -4, standingTackle: -4 }, skill: 0.3 },
    { name: 'long-range', attrs: { longShots: 7, shotPower: 6, curve: 3, interceptions: -3, stamina: -2 } },
  ],
  AM: [
    BALANCED,
    { name: 'playmaker', attrs: { vision: 6, shortPassing: 4, curve: 3, strength: -4, finishing: -2 } },
    { name: 'shadow-striker', attrs: { finishing: 6, longShots: 3, acceleration: 3, vision: -4, longPassing: -3 } },
    { name: 'dribbler', attrs: { dribbling: 6, agility: 5, ballControl: 3, strength: -4, longPassing: -3 }, skill: 0.6, heightCm: -3 },
  ],
  WM: [
    BALANCED,
    { name: 'speedster', attrs: { sprintSpeed: 7, acceleration: 6, composure: -3, strength: -4, vision: -2 } },
    { name: 'crosser', attrs: { crossing: 7, curve: 5, longPassing: 3, dribbling: -3, acceleration: -2 } },
    { name: 'workhorse', attrs: { stamina: 7, standingTackle: 5, interceptions: 4, dribbling: -3, finishing: -3 } },
  ],
  W: [
    BALANCED,
    { name: 'speedster', attrs: { sprintSpeed: 7, acceleration: 6, composure: -3, strength: -4, vision: -2 } },
    { name: 'crosser', attrs: { crossing: 7, curve: 5, longPassing: 3, finishing: -4, dribbling: -2 } },
    { name: 'inside-forward', attrs: { finishing: 6, dribbling: 3, longShots: 3, crossing: -5, stamina: -2 }, skill: 0.4 },
    { name: 'trickster', attrs: { dribbling: 6, agility: 6, ballControl: 3, strength: -5, heading: -3 }, skill: 0.8, heightCm: -3 },
  ],
  ST: [
    BALANCED,
    { name: 'poacher', attrs: { finishing: 5, composure: 4, acceleration: 2, strength: -4, heading: -3, stamina: -3 } },
    { name: 'target', attrs: { heading: 8, strength: 8, acceleration: -5, agility: -5, sprintSpeed: -4, dribbling: -2 }, heightCm: 6, skill: -0.6 },
    { name: 'pace', attrs: { acceleration: 6, sprintSpeed: 7, strength: -5, heading: -4 }, skill: 0.3 },
    { name: 'complete', attrs: { shotPower: 4, longShots: 4, ballControl: 2, heading: 2, agility: -3, stamina: -3 } },
  ],
  CF: [
    BALANCED,
    { name: 'false-nine', attrs: { vision: 6, shortPassing: 5, dribbling: 3, finishing: -3, strength: -4, heading: -4 }, skill: 0.4 },
    { name: 'second-striker', attrs: { finishing: 5, acceleration: 4, longShots: 3, vision: -3, strength: -3 } },
  ],
};

/** Club-style bias added to every outfield player's attributes (the calibration keeps the overall, so the bias
 *  shifts the shape of the squad, not its level). Keepers get only the keeper-attribute part. */
const STYLE_BIAS: Readonly<Record<TeamStyle, Partial25>> = {
  [TeamStyle.POSSESSION]: { shortPassing: 3, vision: 2, ballControl: 2, composure: 2, longPassing: 1, strength: -2, heading: -1, gkKicking: 3 },
  [TeamStyle.COUNTER]: { acceleration: 3, sprintSpeed: 3, longPassing: 2, finishing: 1, shortPassing: -1, stamina: -1 },
  [TeamStyle.DIRECT]: { strength: 3, heading: 3, longPassing: 3, shotPower: 2, agility: -2, dribbling: -2, shortPassing: -1, gkKicking: 2 },
  [TeamStyle.HIGH_PRESS]: { stamina: 4, interceptions: 2, standingTackle: 2, acceleration: 1, agility: 1, composure: -1, longPassing: -1 },
  [TeamStyle.WING_PLAY]: { crossing: 4, sprintSpeed: 2, heading: 2, dribbling: 1, curve: 1, vision: -1, longShots: -1 },
};
const STYLE_VEC: Readonly<Record<number, number[]>> = Object.fromEntries(
  Object.entries(STYLE_BIAS).map(([k, v]) => [k, vec(v)]),
) as Record<number, number[]>;

// ---------------------------------------------------------------- bench and shirts

/** Bench roles (7) for a formation: reserve keeper, then cover for each line. `sideRight` picks RB/RWB/RM/RW
 *  over the left-sided version. Back-three formations without wide attackers carry a second centre-back. */
export function benchRoles(formation: FormationId, sideRight: boolean): Role[] {
  const roles = getFormation(formation).slots.map((s) => s.role);
  const has = (r: Role): boolean => roles.includes(r);
  const fullBack = has(Role.RB) || has(Role.LB)
    ? (sideRight ? Role.RB : Role.LB)
    : (sideRight ? Role.RWB : Role.LWB);
  const deepMid = has(Role.CDM) ? Role.CDM : Role.CM;
  const attMid = has(Role.CAM) ? Role.CAM : Role.CM;
  let wide: Role;
  if (has(Role.RW) || has(Role.LW)) wide = sideRight ? Role.RW : Role.LW;
  else if (has(Role.RM) || has(Role.LM)) wide = sideRight ? Role.RM : Role.LM;
  else if (roles.filter((r) => r === Role.CB).length >= 3) wide = Role.CB;
  else wide = sideRight ? Role.RW : Role.LW;
  const striker = has(Role.CF) && !has(Role.ST) ? Role.CF : Role.ST;
  return [Role.GK, Role.CB, fullBack, deepMid, attMid, wide, striker];
}

/** Conventional shirt numbers per role, most traditional first. With SHIRT_PRIORITY every formation's starting
 *  eleven wears 1..11 (a diamond's second CM takes the 7, a strike partner without wingers the 11). */
const ROLE_SHIRTS: Readonly<Record<Role, readonly number[]>> = {
  [Role.GK]: [1, 13, 12, 23, 25, 30, 31, 40],
  [Role.RB]: [2, 12, 22, 24, 26],
  [Role.LB]: [3, 15, 13, 23, 28],
  [Role.CB]: [5, 4, 6, 15, 16, 24, 26, 33, 35],
  [Role.RWB]: [2, 12, 22, 24, 17],
  [Role.LWB]: [3, 15, 13, 23, 28],
  [Role.CDM]: [6, 8, 4, 16, 14, 21, 25],
  [Role.CM]: [8, 6, 10, 7, 14, 16, 18, 20, 21, 25],
  [Role.CAM]: [10, 8, 14, 20, 21, 18],
  [Role.RM]: [7, 17, 16, 19, 27],
  [Role.LM]: [11, 17, 19, 18, 27],
  [Role.RW]: [7, 17, 19, 27, 11],
  [Role.LW]: [11, 17, 19, 27, 7],
  [Role.ST]: [9, 10, 11, 19, 18, 20, 29, 39, 99],
  [Role.CF]: [10, 9, 20, 19, 18],
};

/** Order in which starters claim numbers: keeper, centre-backs, full/wing-backs, holding, attacking, central,
 *  wide, forwards (so the 4 and 5 go to centre-backs, the 10 to a CAM before a second CM or striker). */
const SHIRT_PRIORITY: Readonly<Record<RoleGroup, number>> = {
  GK: 0, CB: 1, FB: 2, WB: 2, DM: 3, AM: 4, CM: 5, WM: 6, W: 6, ST: 7, CF: 7,
};

/** Unique conventional shirt numbers for a squad's roles (index 0..10 starters, 11.. bench). */
export function assignShirtNumbers(roles: readonly Role[]): number[] {
  const used = new Array<boolean>(100).fill(false);
  const out = new Array<number>(roles.length).fill(0);
  const take = (i: number): void => {
    for (const n of ROLE_SHIRTS[roles[i]!] ?? []) {
      if (!used[n]) { used[n] = true; out[i] = n; return; }
    }
    for (let n = 12; n <= 99; n++) {
      if (!used[n]) { used[n] = true; out[i] = n; return; }
    }
    throw new Error('playerGen: ran out of shirt numbers');
  };
  const starters = Math.min(roles.length, 11);
  const order = Array.from({ length: starters }, (_, i) => i);
  order.sort((a, b) => SHIRT_PRIORITY[roleGroup(roles[a]!)] - SHIRT_PRIORITY[roleGroup(roles[b]!)] || a - b);
  for (const i of order) take(i);
  for (let i = starters; i < roles.length; i++) take(i);
  return out;
}

// ---------------------------------------------------------------- names

interface Origin {
  id: string;
  firstA: readonly string[];
  firstB: readonly string[];
  lastA: readonly string[];
  lastB: readonly string[];
}

/** Mixed-origin syllable lists. Every name is a combination; none is a stored real name. A tail written with a
 *  leading '+' only follows a part that ends in a vowel ("Ema" + "nuele", never "Mas" + "nuele"). */
const ORIGINS: readonly Origin[] = [
  {
    id: 'anglo',
    firstA: ['Al', 'Bran', 'Cal', 'Dar', 'Ed', 'Fin', 'Gar', 'Hal', 'Jas', 'Kel', 'Lor', 'Mar', 'Nev', 'Os', 'Rhy', 'Tam', 'Wil', 'Cor', 'Den', 'Reg'],
    firstB: ['an', 'en', 'ric', 'ley', 'ton', 'win', 'den', 'by', 'lan', 'mond', 'ett', 'ry'],
    lastA: ['Ash', 'Brack', 'Cran', 'Dun', 'Fair', 'Hal', 'Kes', 'Lang', 'Mar', 'North', 'Pen', 'Rad', 'Stan', 'Thorn', 'Wel', 'Whit', 'Brom', 'Hart', 'Sel', 'Tal'],
    lastB: ['by', 'ford', 'ley', 'ton', 'wick', 'more', 'well', 'ridge', 'sted', 'combe', 'ham', 'croft', 'den', 'field'],
  },
  {
    id: 'iberian',
    firstA: ['Al', 'Bel', 'Cris', 'Da', 'Es', 'Fa', 'Gus', 'Ig', 'Jo', 'Le', 'Ma', 'Ne', 'Ra', 'Se', 'Ti', 'Va', 'Hu', 'Lo', 'Ru'],
    firstB: ['bián', 'dro', 'món', 'rio', 'tavo', 'ino', 'ero', 'uel', 'icio', 'fredo', 'andro', 'nato'],
    lastA: ['Al', 'Bar', 'Cal', 'Del', 'Es', 'Fon', 'Gar', 'Lu', 'Mon', 'Or', 'Pa', 'Ri', 'San', 'Ter', 'Val', 'Zu', 'Ar', 'Bo', 'Cer', 'Gal'],
    lastB: ['vera', 'dez', 'cruz', 'tano', 'mira', 'bón', 'celo', 'rrete', 'onda', 'eira', 'ales', 'lleja', 'zar', 'reño', 'redo', 'dillo', 'rán', 'tegui'],
  },
  {
    id: 'italian',
    firstA: ['Ales', 'Bru', 'Car', 'Da', 'Ema', 'Fa', 'Gia', 'Lo', 'Mas', 'Nic', 'Ric', 'Sal', 'Tom', 'Vit', 'Ser', 'Ot', 'Pie', 'Ste'],
    firstB: ['+nuele', 'rio', 'lo', '+nzo', 'ndro', 'tino', 'lio', 'co', '+vio', 'rino', 'dano'],
    lastA: ['Bel', 'Cap', 'Del', 'Fan', 'Gal', 'Lom', 'Mar', 'Pal', 'Ros', 'San', 'Tor', 'Vin', 'Zan', 'Cor', 'Fer', 'Mel', 'Ner', 'Ser'],
    lastB: ['etti', 'ardi', 'otti', 'ini', 'ello', 'one', 'ato', 'esi', 'aldi', 'ozzi', 'urro', 'agna', 'iero'],
  },
  {
    id: 'french',
    firstA: ['An', 'Bas', 'Clé', 'Da', 'É', 'Flo', 'Ga', 'Ju', 'Lu', 'Ma', 'No', 'Ré', 'Thi', 'Yan', 'Ber', 'Gil', 'Lio', 'Sé'],
    firstB: ['tien', 'rent', 'mien', 'tan', 'lien', 'cien', 'this', 'ric', 'nis', 'vin', 'bert'],
    lastA: ['Beau', 'Bou', 'Char', 'Du', 'Fau', 'Gre', 'La', 'Le', 'Mar', 'Mo', 'Per', 'Ro', 'Sau', 'Ver', 'Cla', 'Fon', 'Gui', 'Tes'],
    lastB: ['champ', 'vin', 'ret', 'mont', 'lier', 'bert', 'rand', 'chet', 'zel', 'noir', 'vier', 'tier', 'nay', 'geon'],
  },
  {
    id: 'germanic',
    firstA: ['Ar', 'Ben', 'Dir', 'Eb', 'Fal', 'Hen', 'Jo', 'Kas', 'Lu', 'Mar', 'Ru', 'Til', 'Wou', 'Ger'],
    firstB: ['ko', 'nik', 'bert', 'mo', 'rik', 'ian', 'ius', 'tin', 'ten', 'win', 'dolf', 'ter'],
    lastA: ['Ber', 'Dorn', 'Eck', 'Fal', 'Grün', 'Hel', 'Kal', 'Lind', 'Mer', 'Rau', 'Stein', 'Wal', 'Zim', 'Haf', 'Brem', 'Ost', 'Vos', 'Kre'],
    lastB: ['hardt', 'mann', 'berg', 'feld', 'ke', 'ner', 'holt', 'ring', 'stra', 'weg', 'dorf', 'meier', 'inga', 'bach'],
  },
  {
    id: 'nordic',
    firstA: ['Ar', 'Bjør', 'Ei', 'Fre', 'Hal', 'Iv', 'Kjel', 'Lei', 'Ny', 'Os', 'Sig', 'Tor', 'Ul', 'Vi', 'Sten', 'Ha'],
    firstB: ['vid', 'n', 'ar', 'dor', 'e', 'geir', 'vald', 'mund', 'rik', 'lev', 'fin', 'sten'],
    lastA: ['Ake', 'Berg', 'Dahl', 'Eng', 'Fjeld', 'Holm', 'Lund', 'Ny', 'Sand', 'Strand', 'Vik', 'Skog', 'Lid', 'Moe', 'Rud', 'Hov', 'Øs', 'Brå'],
    lastB: ['vik', 'dal', 'stad', 'heim', 'sen', 'gren', 'qvist', 'by', 'strøm', 'lund', 'ås', 'nes', 'ang', 'rud'],
  },
  {
    id: 'west-african',
    firstA: ['A', 'Ba', 'Chi', 'Da', 'E', 'Fe', 'I', 'Ko', 'Ma', 'Nna', 'O', 'Se', 'Tun', 'Ya', 'Ke', 'Ade', 'Ama', 'Ola'],
    firstB: ['demi', 'ku', 'nedu', 'yo', 'lade', 'bu', 'sa', 'femi', 'che', 'wale', 'kwe', 'dou', 'tunde', 'jide', 'bisi'],
    lastA: ['Ade', 'Ako', 'Bam', 'Chuk', 'Ebo', 'Iwu', 'Kan', 'Mens', 'Nwo', 'Oke', 'Ola', 'Ose', 'Tet', 'Ama', 'Dia', 'Ndi', 'Sow', 'Bodu'],
    lastB: ['yemi', 'nde', 'wu', 'ndu', 'ku', 'lowo', 'rah', 'bisi', 'fo', 'eke', 'teng', 'dou', 'ye', 'gbe', 'kye'],
  },
  {
    id: 'east-african',
    firstA: ['Ba', 'Je', 'Ka', 'Lu', 'Mo', 'Nde', 'Si', 'Tha', 'Za', 'Bo', 'Ki', 'Mu'],
    firstB: ['bo', 'lani', 'tu', 'ngo', 'zi', 'ba', 'thando', 'lu', 'nga', 'to', 'sani'],
    lastA: ['Dla', 'Kho', 'Mabu', 'Ndlo', 'Ntu', 'Shon', 'Zwa', 'Mwa', 'Odhi', 'Waki', 'Kaba', 'Mutu'],
    lastB: ['mini', 'za', 'ane', 'vu', 'sa', 'ngu', 'mbe', 'ngi', 'ambo', 'ra', 'yo', 'ko'],
  },
  {
    id: 'slavic',
    firstA: ['Bra', 'Da', 'Dra', 'Go', 'Iv', 'Ja', 'Mi', 'Ne', 'Ra', 'Sta', 'Vla', 'Zo', 'Bo', 'Lu', 'Pe', 'Vo'],
    firstB: ['nko', 'ro', 'šan', 'ran', 'mir', 'slav', 'dan', 'jan', 'tko', 'ven', 'lan'],
    lastA: ['Bo', 'Dra', 'Ko', 'Ma', 'Pe', 'Ra', 'Sto', 'Ve', 'Zu', 'Ja', 'Lu', 'Mi', 'No', 'Sa', 'Ta', 'Vu'],
    lastB: ['vić', 'šić', 'kov', 'rović', 'nek', 'jević', 'lski', 'nčar', 'dić', 'ček', 'lak', 'ško', 'rić'],
  },
  {
    id: 'turkish',
    firstA: ['Al', 'Bur', 'Can', 'Em', 'Er', 'Hak', 'Ka', 'Mert', 'O', 'Ser', 'Tol', 'Yu', 'Ce', 'De', 'Ön', 'Gö'],
    firstB: ['kan', 'ak', 're', 'han', '+dem', 'ay', 'tuğ', 'zan', 'san', 'ver', 'lim', 'nur'],
    lastA: ['Ak', 'Bal', 'Demir', 'Er', 'Kara', 'Öz', 'Sar', 'Tek', 'Yıl', 'Kay', 'Çe', 'Ay', 'Tun', 'Bay'],
    lastB: ['soy', 'kaya', 'doğan', 'taş', 'oğlu', 'can', 'türk', 'lı', 'göz', 'dağ', 'ören', 'yurt', 'tan'],
  },
  {
    id: 'japanese',
    firstA: ['Hi', 'Ka', 'Ke', 'Ma', 'Ri', 'Sho', 'Ta', 'Yu', 'Ryo', 'Ko', 'Dai', 'Shu'],
    firstB: ['ito', 'nji', 'suke', 'ta', 'ki', 'hei', 'ma', 'ro', 'go', 'ichi', 'ya', 'to'],
    lastA: ['Hara', 'Ishi', 'Kawa', 'Mori', 'Naka', 'Saka', 'Taka', 'Yama', 'Fuji', 'Kuro', 'Hoshi', 'Ono', 'Aki', 'Matsu', 'Shima'],
    lastB: ['da', 'no', 'moto', 'mura', 'shima', 'zaki', 'oka', 'gawa', 'be', 'ue', 'hara', 'kawa', 'yama', 'uchi'],
  },
  {
    id: 'maghreb',
    firstA: ['Ah', 'Ka', 'Ma', 'Na', 'Ra', 'Sa', 'Ta', 'Ya', 'Za', 'Ha', 'Ou', 'Il', 'Bi', 'Fa'],
    firstB: ['mir', 'rim', 'lik', 'hid', 'fiq', 'sin', 'bil', 'mad', 'ssim', 'zim', 'dir', 'kim'],
    lastA: ['Bena', 'Bel', 'Bou', 'Haj', 'Kha', 'Man', 'Saa', 'Taz', 'Zer', 'Lah', 'Am', 'Ra'],
    lastB: ['dri', 'ssa', 'lem', 'rouf', 'ziz', 'oui', 'hadi', 'mar', 'dane', 'laoui', 'rani', 'bari', 'kri'],
  },
  {
    id: 'lusophone',
    firstA: ['Adi', 'Bru', 'Cle', 'Dé', 'Edi', 'Gil', 'Ja', 'Lu', 'Mar', 'Ri', 'Tia', 'Va', 'Wel', 'Ro', 'Ge'],
    firstB: ['son', 'ilton', 'berto', 'nho', 'ério', 'sinho', 'valdir', 'ciano', 'lino', 'mar', 'ton', 'iel'],
    lastA: ['Ara', 'Bra', 'Car', 'Fer', 'Lou', 'Mo', 'Pin', 'Que', 'Ri', 'Ta', 'Vi', 'Gou', 'Mace', 'Ser', 'Bor'],
    lastB: ['ujo', 'nhas', 'valho', 'reira', 'rão', 'deiro', 'ssis', 'toso', 'queira', 'tim', 'gal'],
  },
];

const VOWELS = 'aeiouyáéíóúàèìòùâêîôûäëïöüåøæœãõ';

function isVowel(c: string): boolean {
  return VOWELS.includes(c.toLowerCase());
}

/** Join two syllables; a doubled vowel at the seam ("Ti" + "icio") collapses to one. */
function joinSyllables(a: string, b: string): string {
  const la = a.charAt(a.length - 1).toLowerCase();
  const fb = b.charAt(0).toLowerCase();
  if (isVowel(la) && la === fb) return a + b.slice(1);
  return a + b;
}

/** Vowel pairs that read naturally across a seam ("Le" + "andro", "Da" + "ito"). */
const SEAM_VOWEL_PAIRS: readonly string[] = ['ai', 'au', 'ei', 'eu', 'ea', 'ou'];
/** Sonorants that may not start a consonant cluster after a consonant ("Car" + "nzo", "Or" + "rrete"). */
const SONORANTS = 'nrl';

/**
 * Pronounceability of a syllable seam: no letter three times in a row, no three vowels in a row at the seam,
 * vowel-vowel seams only from SEAM_VOWEL_PAIRS (or a collapsed double), and no consonant followed by a
 * sonorant-led cluster.
 */
export function seamOk(a: string, rawB: string): boolean {
  const needsVowel = rawB.startsWith('+');
  const b = needsVowel ? rawB.slice(1) : rawB;
  if (needsVowel && !isVowel(a.charAt(a.length - 1))) return false;
  if (a.toLowerCase() === b.toLowerCase()) return false;
  const joined = joinSyllables(a, b).toLowerCase();
  for (let i = 2; i < joined.length; i++) {
    if (joined[i] === joined[i - 1] && joined[i] === joined[i - 2]) return false;
  }
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  const a1 = al.charAt(al.length - 1);
  const a2 = al.charAt(al.length - 2);
  const b1 = bl.charAt(0);
  const b2 = bl.charAt(1);
  if (isVowel(a1) && isVowel(b1)) {
    if (a1 === b1) return !(a2 !== '' && isVowel(a2) && b2 !== '' && isVowel(b2));
    if (a2 !== '' && isVowel(a2)) return false;
    if (b2 !== '' && isVowel(b2)) return false;
    return SEAM_VOWEL_PAIRS.includes(a1 + b1);
  }
  if (!isVowel(a1) && SONORANTS.includes(b1) && b2 !== '' && !isVowel(b2)) return false;
  return true;
}

/** Up to this many re-picks to find a pronounceable seam (the last pick is used if none is). */
const SEAM_TRIES = 8;

function compose(next: () => number, parts: readonly string[], tails: readonly string[]): string {
  let a = pick(next, parts);
  let b = pick(next, tails);
  for (let t = 1; t < SEAM_TRIES && !seamOk(a, b); t++) {
    a = pick(next, parts);
    b = pick(next, tails);
  }
  return joinSyllables(a, b.startsWith('+') ? b.slice(1) : b);
}

/** One raw invented name (not yet screened). Exposed so tests and tools can sample the name space. */
export function rawName(next: () => number): { first: string; last: string } {
  const o1 = pick(next, ORIGINS);
  const o2 = next() < LOCAL_TUNING.mixedOriginChance ? pick(next, ORIGINS) : o1;
  const first = compose(next, o1.firstA, o1.firstB);
  let last = compose(next, o2.lastA, o2.lastB);
  if (next() < LOCAL_TUNING.hyphenChance) {
    const o3 = pick(next, ORIGINS);
    last = `${last}-${compose(next, o3.lastA, o3.lastB)}`;
  }
  return { first, last };
}

/** Display name ("T. Okafor-Lind") from first name and surname. */
export function displayName(first: string, last: string): string {
  return `${first.charAt(0).toUpperCase()}. ${last}`;
}

function nameShapeOk(first: string, last: string): boolean {
  if (first.length < 4 || first.length > 10) return false;
  const maxLast = last.includes('-') ? 15 : 12;
  return last.length >= 3 && last.length <= maxLast;
}

/** Candidate name source: (uniform RNG) -> first name + surname. */
export type NameSource = (next: () => number) => { first: string; last: string };

export interface SquadOptions {
  /**
   * Display-name keys (`nameKey(displayName)`) already used, e.g. by clubs generated earlier. Generated names
   * avoid them and are added. Share one Set across all clubs for league-wide unique display names.
   */
  usedNames?: Set<string>;
  /** Replace the raw candidate source (tests inject famous names). Screening and uniqueness still apply. */
  nameSource?: NameSource;
}

interface NameState {
  next: () => number;
  source: NameSource;
  used: Set<string>;
  surnames: Set<string>;
}

function generateName(st: NameState): { name: string; short: string } {
  for (let attempt = 0; attempt < LOCAL_TUNING.maxNameAttempts; attempt++) {
    const { first, last } = st.source(st.next);
    if (!nameShapeOk(first, last)) continue;
    if (screenName(first, last, true) !== null) continue;
    const name = displayName(first, last);
    const key = nameKey(name);
    const surnameKey = nameKey(last);
    if (st.used.has(key) || st.surnames.has(surnameKey)) continue;
    st.used.add(key);
    st.surnames.add(surnameKey);
    return { name, short: last };
  }
  throw new Error(`playerGen: no screened, unique name after ${LOCAL_TUNING.maxNameAttempts} attempts`);
}

// ---------------------------------------------------------------- players

export interface SquadParams {
  /** Club overall rating (62..88); the starters' mean overall equals it. */
  rating: number;
  formation: FormationId;
  style: TeamStyle;
}

interface GenPlayer {
  role: Role;
  target: number;
}

function generateAttributes(next: () => number, role: Role, target: number, style: TeamStyle, arch: Archetype, heightCm: number): number[] {
  const group = roleGroup(role);
  const T = LOCAL_TUNING;
  const v = new Array<number>(NUM_ATTRS).fill(0);
  const archVec = vec(arch.attrs);
  const styleVec = STYLE_VEC[style] ?? vec({});
  const prof = OUTFIELD_PROFILE[group];
  const dh = heightCm - HEIGHT[group][0];
  const isGk = group === 'GK';
  for (let i = 0; i < NUM_OUTFIELD; i++) {
    const styleOff = isGk ? 0 : styleVec[i]!;
    v[i] = target + prof[i]! + styleOff + archVec[i]! + gauss(next) * T.attrNoiseSd;
  }
  if (!isGk) {
    v[ATTR_INDEX.heading] = v[ATTR_INDEX.heading]! + dh * T.heightHeadingPerCm;
    v[ATTR_INDEX.strength] = v[ATTR_INDEX.strength]! + dh * T.heightStrengthPerCm;
    v[ATTR_INDEX.agility] = v[ATTR_INDEX.agility]! + dh * T.heightAgilityPerCm;
    v[ATTR_INDEX.acceleration] = v[ATTR_INDEX.acceleration]! + dh * T.heightAccelPerCm;
  }
  for (let j = 0; j < 5; j++) {
    const i = NUM_OUTFIELD + j;
    v[i] = isGk
      ? target + KEEPER_PROFILE[j]! + styleVec[i]! + archVec[i]! + gauss(next) * T.attrNoiseSd
      : T.outfieldGkBase + next() * T.outfieldGkRange;
  }
  calibrate(v, group, target);
  return v;
}

/** Shift the attributes the overall depends on so the weighted overall equals `target`, then round, then
 *  fine-tune single points (heaviest weights first) so the rounded overall matches exactly when possible. */
function calibrate(v: number[], group: RoleGroup, target: number): void {
  const T = LOCAL_TUNING;
  const w = WEIGHT_VEC[group];
  const lo = group === 'GK' ? NUM_OUTFIELD : 0;
  const hi = group === 'GK' ? NUM_ATTRS : NUM_OUTFIELD;
  for (let i = 0; i < NUM_ATTRS; i++) v[i] = clamp(v[i]!, T.attrMin, T.attrMax);
  for (let iter = 0; iter < 6; iter++) {
    const d = target - weightedSum(v, w) / 100;
    if (d > -0.01 && d < 0.01) break;
    for (let i = lo; i < hi; i++) v[i] = clamp(v[i]! + d, T.attrMin, T.attrMax);
  }
  for (let i = 0; i < NUM_ATTRS; i++) v[i] = Math.round(v[i]!);
  const order = WEIGHT_ORDER[group];
  let sum = weightedSum(v, w);
  for (let step = 0; step < 4 * order.length; step++) {
    const ov = Math.round(sum / 100);
    if (ov === target) break;
    const dir = ov < target ? 1 : -1;
    const i = order[step % order.length]!;
    const nv = v[i]! + dir;
    if (nv < T.attrMin || nv > T.attrMax) continue;
    v[i] = nv;
    sum += dir * w[i]!;
  }
}

function genHeight(next: () => number, group: RoleGroup, arch: Archetype): number {
  const [mean, sd] = HEIGHT[group];
  const lo = group === 'GK' ? LOCAL_TUNING.keeperHeightMinCm : LOCAL_TUNING.heightMinCm;
  return clamp(Math.round(mean + (arch.heightCm ?? 0) + gauss(next) * sd), lo, LOCAL_TUNING.heightMaxCm);
}

function genPlayer(next: () => number, gp: GenPlayer, style: TeamStyle, names: NameState, shirt: number): PlayerData {
  const group = roleGroup(gp.role);
  const arch = pick(next, ARCHETYPES[group]);
  const height = genHeight(next, group, arch);
  const v = generateAttributes(next, gp.role, gp.target, style, arch, height);
  const foot = next() < leftFootChance(gp.role) ? Foot.LEFT : Foot.RIGHT;
  const T = LOCAL_TUNING;
  const weakFoot = clamp(Math.round(WEAK_FOOT_BASE[group] + (gp.target - 75) * T.weakFootPerLevel + gauss(next) * T.weakFootNoiseSd), 1, 5);
  const sm = SKILL_BASE[group] + (v[ATTR_INDEX.dribbling]! - 70) * T.skillPerDribbling + (arch.skill ?? 0) + gauss(next) * T.skillNoiseSd;
  const skillMoves = group === 'GK' ? 1 : clamp(Math.round(sm), 1, 5);
  const { name, short } = generateName(names);
  const p: Record<string, unknown> = {
    name, short, shirt, pos: gp.role, height, foot, weakFoot, skillMoves, overall: 0,
  };
  for (let i = 0; i < NUM_ATTRS; i++) p[ATTRIBUTE_KEYS[i]!] = v[i]!;
  const player = p as unknown as PlayerData;
  player.overall = computeOverall(player, gp.role);
  return player;
}

/** Starter overall targets: centred on the rating (exact integer mean where clamps allow), one star. */
function starterTargets(next: () => number, rating: number, roles: readonly Role[]): number[] {
  const T = LOCAL_TUNING;
  const n = roles.length;
  const off = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) off[i] = gauss(next) * T.starterSpreadSd;
  // Star: forwards and creators are likelier (weights 3 / 2 / 1), never the keeper.
  let total = 0;
  const weight = roles.map((r) => {
    const g = roleGroup(r);
    const wgt = g === 'GK' ? 0 : g === 'ST' || g === 'CF' || g === 'W' || g === 'AM' ? 3 : g === 'CM' || g === 'WM' ? 2 : 1;
    total += wgt;
    return wgt;
  });
  let pickW = next() * total;
  let star = 1;
  for (let i = 0; i < n; i++) {
    pickW -= weight[i]!;
    if (pickW < 0 && weight[i]! > 0) { star = i; break; }
  }
  off[star] = off[star]! + T.starBoost;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += off[i]!;
  mean /= n;
  // Largest-remainder rounding so the integer targets sum to n * rating.
  const raw = off.map((o) => rating + o - mean);
  const out = raw.map((x) => Math.floor(x));
  let remaining = n * Math.round(rating) - out.reduce((a, b) => a + b, 0);
  const byFrac = raw.map((x, i) => i).sort((a, b) => (raw[b]! - out[b]!) - (raw[a]! - out[a]!) || a - b);
  for (let k = 0; k < byFrac.length && remaining > 0; k++, remaining--) out[byFrac[k]!] = out[byFrac[k]!]! + 1;
  return out.map((x) => clamp(x, T.targetMin, T.targetMax));
}

/**
 * Generate an 18-player squad for a club: 0..10 starters in formation slot order (0 = GK), 11 reserve keeper,
 * 12..17 outfield cover. Deterministic for a given RNG stream and params.
 */
export function generateSquad(rng: GenRng, params: SquadParams, opts: SquadOptions = {}): PlayerData[] {
  const next = toNext(rng);
  const T = LOCAL_TUNING;
  const rating = clamp(Math.round(params.rating), 1, 99);
  const starters = getFormation(params.formation).slots.map((s) => s.role);
  const bench = benchRoles(params.formation, next() < 0.5);
  const roles = [...starters, ...bench];
  const targets = starterTargets(next, rating, starters);
  for (let i = 0; i < bench.length; i++) {
    const keeper = bench[i] === Role.GK;
    const mean = rating - (keeper ? T.benchKeeperDrop : T.benchDrop);
    const sd = keeper ? T.benchSpreadSd * 0.6 : T.benchSpreadSd;
    targets.push(clamp(Math.round(mean + gauss(next) * sd), T.targetMin, T.targetMax));
  }
  const shirts = assignShirtNumbers(roles);
  const names: NameState = {
    next, source: opts.nameSource ?? rawName, used: opts.usedNames ?? new Set<string>(), surnames: new Set<string>(),
  };
  const squad: PlayerData[] = [];
  for (let i = 0; i < roles.length; i++) {
    squad.push(genPlayer(next, { role: roles[i]!, target: targets[i]! }, params.style, names, shirts[i]!));
  }
  return squad;
}

/** Mean overall of the starting eleven (indices 0..10), rounded: the club rating the squad was built for. */
export function squadRating(squad: readonly PlayerData[]): number {
  const n = Math.min(11, squad.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += squad[i]!.overall;
  return Math.round(sum / n);
}

/** Every problem found in a squad (empty = valid). Used by tests and gen-data sanity checks. */
export function validateSquad(squad: readonly PlayerData[], formation: FormationId): string[] {
  const errs: string[] = [];
  if (squad.length !== 18) errs.push(`squad has ${squad.length} players, expected 18`);
  const slots = getFormation(formation).slots;
  for (let i = 0; i < 11 && i < squad.length; i++) {
    if (squad[i]!.pos !== slots[i]!.role) errs.push(`starter ${i} is role ${squad[i]!.pos}, formation needs ${slots[i]!.role}`);
  }
  const keepers = squad.filter((p) => p.pos === Role.GK).length;
  if (keepers !== 2) errs.push(`${keepers} keepers, expected 2`);
  if (!squad.slice(11).some((p) => p.pos === Role.GK)) errs.push('no keeper on the bench');
  const shirts = new Set<number>();
  const names = new Set<string>();
  const shorts = new Set<string>();
  for (const p of squad) {
    const who = `${p.name} (#${p.shirt})`;
    if (!Number.isInteger(p.shirt) || p.shirt < 1 || p.shirt > 99) errs.push(`${who}: shirt out of range`);
    if (shirts.has(p.shirt)) errs.push(`${who}: duplicate shirt`);
    shirts.add(p.shirt);
    if (names.has(nameKey(p.name))) errs.push(`${who}: duplicate name`);
    names.add(nameKey(p.name));
    if (shorts.has(nameKey(p.short))) errs.push(`${who}: duplicate short name`);
    shorts.add(nameKey(p.short));
    for (const k of ATTRIBUTE_KEYS) {
      const a = p[k];
      if (!Number.isInteger(a) || a < 1 || a > 99) errs.push(`${who}: ${k}=${a} out of 1..99`);
    }
    if (!Number.isInteger(p.height) || p.height < LOCAL_TUNING.heightMinCm || p.height > LOCAL_TUNING.heightMaxCm) errs.push(`${who}: height ${p.height}`);
    if (p.foot !== Foot.LEFT && p.foot !== Foot.RIGHT) errs.push(`${who}: foot ${p.foot}`);
    if (!Number.isInteger(p.weakFoot) || p.weakFoot < 1 || p.weakFoot > 5) errs.push(`${who}: weakFoot ${p.weakFoot}`);
    if (!Number.isInteger(p.skillMoves) || p.skillMoves < 1 || p.skillMoves > 5) errs.push(`${who}: skillMoves ${p.skillMoves}`);
    if (p.overall !== computeOverall(p, p.pos)) errs.push(`${who}: overall ${p.overall} != formula ${computeOverall(p, p.pos)}`);
    const parts = p.name.split('. ');
    if (parts.length < 2 || parts[1] !== p.short) errs.push(`${who}: display name does not end with the short name`);
    const hit = screenName(p.name.charAt(0), p.short, true);
    if (hit !== null) errs.push(`${who}: screened (${hit.reason}: ${hit.match})`);
  }
  return errs;
}
