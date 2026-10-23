/**
 * [DAT-04] Role behaviour presets, team-phase offsets, tactical focus and quick-tactic modifiers (BRIEF §7 Team
 * shape, §10 Tactics) for the team AI. Pure data plus small allocation-free helpers; deterministic (no trig, no
 * randomness), so sim/ai code may call everything here every tick.
 *
 * Frame: normalised team frame as in formations.ts (nx +1 = opposition goal line, nz +1 = right flank for a team
 * attacking +x). World = (dir * nx * 52.5, dir * nz * 34). Ball inputs are given in the same frame:
 * bnx = ball.x * dir / 52.5, bnz = ball.z * dir / 34.
 *
 * Who reads what:
 *  - TAI-01 shape: ROLE_PRESETS (width, depth bands, push, ball follow), PHASE_OFFSETS, FOCUS_MODIFIERS,
 *    EXTRA_STRIKER_SHAPES, QUICK_TACTICS.getInBox. `tacticalHome` is the reference combination of all of them
 *    (before TAI-01's own compactness, team.lineX and short-handed adjustments).
 *  - TAI-02 support: runs.support, freedom/roamRadius.
 *  - TAI-03 runs: runs.inBehind/overlap/lateRun, TacticParams.maxRunners/runScale/lateRunScale/boxRunners, BOX_SPOTS.
 *  - TAI-04 defensive shape: TacticParams.lineNx (focus + offside trap + team press), QUICK_TACTICS.offsideTrap,
 *    duties.mark, zoneRadius, widthDefend.
 *  - TAI-05 pressing: TacticParams.pressScale/pressAdd/pressers/pressDistanceScale, duties.press/cover/track.
 *  - TAI-06 transitions: runs.counter, duties.recover, PHASE_OFFSETS[TRANSITION_*].speedScale.
 *  - TAI-14 commands: tacticFlagForCommand / focusForCommand, formations.ts remapFormation for SET_FORMATION.
 */
import { CROSS_ZONE_DEPTH, CROSS_ZONE_MIN_Z, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH } from '../contracts/constants';
import { Command, FormationId, Role, TacticalFocus, TeamPhase } from '../contracts/enums';
import type { TeamState } from '../contracts/state';
import { getFormation, roleSide, ShapeLine, slotLine } from './formations';

const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: shape limits of tacticalHome, which no sim / AI path calls)
  /** Max |nz| of an outfield home: 0.9 * 34 = 30.6 m, 3.4 m inside the touchline. */
  outfieldMaxNz: 0.9,
  /** Max |nz| of the keeper's home: inside the goal mouth (3.66 / 34). */
  keeperMaxNz: GOAL_HALF_WIDTH / HALF_WIDTH,
} as const;

// ---------------------------------------------------------------- role presets

/** Attacking run tendencies, 0..1 (0 = never, 1 = first choice). */
export interface RoleRuns {
  /** Run in behind the last defender, timed to stay onside (TAI-03 RUN_IN_BEHIND). */
  readonly inBehind: number;
  /** Overlap outside a team-mate on the ball in the wide channel (TAI-03 OVERLAP). */
  readonly overlap: number;
  /** Late run into the box when the ball is in the crossing zone (TAI-03 LATE_RUN). */
  readonly lateRun: number;
  /** Offer a short option / passing triangle near the carrier (TAI-02 SUPPORT). */
  readonly support: number;
  /** Break forward at sprint when the ball is won (TAI-06 TRANSITION_ATTACK). */
  readonly counter: number;
}

/** Defensive duties, 0..1. */
export interface RoleDuties {
  /** Step out to press the carrier (TAI-05 PRESS). */
  readonly press: number;
  /** Cover behind the presser on the carrier's path to goal (TAI-05 COVER). */
  readonly cover: number;
  /** Zonal marking of attackers entering his zone (TAI-04 MARK). */
  readonly mark: number;
  /** Track an opponent's forward run into the defensive third (TAI-05 TRACK_RUNNER). */
  readonly track: number;
  /** Recovery run goal-side after losing the ball (TAI-06 RECOVER). */
  readonly recover: number;
}

export interface RolePreset {
  readonly role: Role;
  /** Usual line of the role (formations.ts FORMATION_META.lines is authoritative per slot). */
  readonly line: ShapeLine;
  /** +1 right flank, -1 left flank, 0 central (team attacking +x). */
  readonly side: number;
  /** Multiplier on the slot's nz in possession (> 1 stretches the pitch). */
  readonly widthAttack: number;
  /** Multiplier on the slot's nz out of possession (< 1 = narrower, compact). */
  readonly widthDefend: number;
  /** Max |nz| of the home position. */
  readonly maxNz: number;
  /** Home nx band in possession (team attack band). */
  readonly attackMinNx: number;
  readonly attackMaxNx: number;
  /** Home nx band out of possession. */
  readonly defendMinNx: number;
  readonly defendMaxNx: number;
  /** Multiplier on the team push (phase + focus + tactics) when it is forward (> 0) ... */
  readonly pushAttack: number;
  /** ... and when it is backward (< 0). */
  readonly pushDefend: number;
  /** Fraction of the ball's nx the home follows while the ball is in the team's own half (bnx < 0): the block
   *  slides up and down with the ball. */
  readonly followXBack: number;
  /** Same with the ball in the opposition half (bnx > 0) when in possession (attack band); forwards follow more
   *  than defenders so the team stretches in attack. Out of possession followXBack applies (compact). */
  readonly followXFwd: number;
  /** Lateral slide toward the ball as a fraction of the room between the player and the ball-side limit (maxNz)
   *  when the ball is on a touchline (|bnz| = 1); the block slides toward the ball side and squeezes there. */
  readonly ballFollowZ: number;
  /** Freedom to roam, 0 (hold position) .. 1 (free role). */
  readonly freedom: number;
  /** Radius around the home position that support / run / dribble choices may use, m. */
  readonly roamRadius: number;
  /** Zonal marking radius around the home position, m (TAI-04). */
  readonly zoneRadius: number;
  /** Pull into the box under the GET_IN_BOX quick tactic, 0..1. */
  readonly boxPull: number;
  readonly runs: RoleRuns;
  readonly duties: RoleDuties;
}

type PresetDef = Omit<RolePreset, 'role' | 'side' | 'maxNz'>;

const KEEPER: PresetDef = {
  line: ShapeLine.GK, widthAttack: 1, widthDefend: 1,
  attackMinNx: -0.95, attackMaxNx: -0.72, defendMinNx: -0.96, defendMaxNx: -0.8,
  pushAttack: 0.4, pushDefend: 0.3, followXBack: 0.12, followXFwd: 0.2, ballFollowZ: 0.5,
  freedom: 0, roamRadius: 0, zoneRadius: 0, boxPull: 0,
  runs: { inBehind: 0, overlap: 0, lateRun: 0, support: 0.2, counter: 0 },
  duties: { press: 0, cover: 0, mark: 0, track: 0, recover: 1 },
};

const FULL_BACK: PresetDef = {
  line: ShapeLine.DEF, widthAttack: 1.25, widthDefend: 0.86,
  attackMinNx: -0.72, attackMaxNx: 0.5, defendMinNx: -0.84, defendMaxNx: -0.02,
  pushAttack: 1.45, pushDefend: 1.0, followXBack: 0.5, followXFwd: 0.55, ballFollowZ: 0.3,
  freedom: 0.45, roamRadius: 14, zoneRadius: 10, boxPull: 0,
  runs: { inBehind: 0.15, overlap: 0.85, lateRun: 0.05, support: 0.55, counter: 0.35 },
  duties: { press: 0.45, cover: 0.7, mark: 0.85, track: 0.9, recover: 0.95 },
};

const CENTRE_BACK: PresetDef = {
  line: ShapeLine.DEF, widthAttack: 1.3, widthDefend: 0.92,
  attackMinNx: -0.74, attackMaxNx: 0.22, defendMinNx: -0.84, defendMaxNx: -0.08,
  pushAttack: 0.9, pushDefend: 0.85, followXBack: 0.48, followXFwd: 0.48, ballFollowZ: 0.32,
  freedom: 0.15, roamRadius: 8, zoneRadius: 9, boxPull: 0,
  runs: { inBehind: 0.02, overlap: 0, lateRun: 0.02, support: 0.3, counter: 0.05 },
  duties: { press: 0.35, cover: 0.95, mark: 0.95, track: 0.85, recover: 1 },
};

const WING_BACK: PresetDef = {
  line: ShapeLine.DEF, widthAttack: 1.12, widthDefend: 0.9,
  attackMinNx: -0.64, attackMaxNx: 0.6, defendMinNx: -0.84, defendMaxNx: 0.02,
  pushAttack: 1.4, pushDefend: 1.1, followXBack: 0.52, followXFwd: 0.55, ballFollowZ: 0.3,
  freedom: 0.55, roamRadius: 16, zoneRadius: 11, boxPull: 0,
  runs: { inBehind: 0.25, overlap: 0.95, lateRun: 0.1, support: 0.6, counter: 0.5 },
  duties: { press: 0.5, cover: 0.6, mark: 0.7, track: 0.85, recover: 0.9 },
};

const HOLDING_MID: PresetDef = {
  line: ShapeLine.DM, widthAttack: 1, widthDefend: 0.9,
  attackMinNx: -0.6, attackMaxNx: 0.4, defendMinNx: -0.74, defendMaxNx: 0.06,
  pushAttack: 0.95, pushDefend: 1.0, followXBack: 0.52, followXFwd: 0.62, ballFollowZ: 0.36,
  freedom: 0.3, roamRadius: 12, zoneRadius: 9, boxPull: 0,
  runs: { inBehind: 0.02, overlap: 0, lateRun: 0.15, support: 0.85, counter: 0.15 },
  duties: { press: 0.75, cover: 0.95, mark: 0.75, track: 0.8, recover: 0.9 },
};

const CENTRAL_MID: PresetDef = {
  line: ShapeLine.MID, widthAttack: 1.15, widthDefend: 0.85,
  attackMinNx: -0.5, attackMaxNx: 0.54, defendMinNx: -0.7, defendMaxNx: 0.16,
  pushAttack: 1.05, pushDefend: 1.05, followXBack: 0.54, followXFwd: 0.72, ballFollowZ: 0.36,
  freedom: 0.55, roamRadius: 16, zoneRadius: 9, boxPull: 0.35,
  runs: { inBehind: 0.15, overlap: 0.05, lateRun: 0.6, support: 0.8, counter: 0.45 },
  duties: { press: 0.75, cover: 0.6, mark: 0.6, track: 0.65, recover: 0.8 },
};

const ATTACKING_MID: PresetDef = {
  line: ShapeLine.AM, widthAttack: 1, widthDefend: 0.85,
  attackMinNx: -0.36, attackMaxNx: 0.66, defendMinNx: -0.6, defendMaxNx: 0.24,
  pushAttack: 1.0, pushDefend: 1.1, followXBack: 0.55, followXFwd: 0.75, ballFollowZ: 0.34,
  freedom: 0.75, roamRadius: 18, zoneRadius: 8, boxPull: 0.5,
  runs: { inBehind: 0.35, overlap: 0, lateRun: 0.8, support: 0.75, counter: 0.6 },
  duties: { press: 0.65, cover: 0.3, mark: 0.35, track: 0.35, recover: 0.5 },
};

const WIDE_MID: PresetDef = {
  line: ShapeLine.MID, widthAttack: 1.2, widthDefend: 0.82,
  attackMinNx: -0.46, attackMaxNx: 0.68, defendMinNx: -0.68, defendMaxNx: 0.2,
  pushAttack: 1.1, pushDefend: 1.1, followXBack: 0.54, followXFwd: 0.74, ballFollowZ: 0.3,
  freedom: 0.55, roamRadius: 15, zoneRadius: 10, boxPull: 0.8,
  runs: { inBehind: 0.45, overlap: 0.2, lateRun: 0.55, support: 0.6, counter: 0.7 },
  duties: { press: 0.6, cover: 0.4, mark: 0.55, track: 0.7, recover: 0.75 },
};

const WINGER: PresetDef = {
  line: ShapeLine.FWD, widthAttack: 1.2, widthDefend: 0.78,
  attackMinNx: -0.3, attackMaxNx: 0.78, defendMinNx: -0.55, defendMaxNx: 0.3,
  pushAttack: 1.0, pushDefend: 1.15, followXBack: 0.56, followXFwd: 0.78, ballFollowZ: 0.28,
  freedom: 0.65, roamRadius: 16, zoneRadius: 10, boxPull: 1,
  runs: { inBehind: 0.7, overlap: 0.1, lateRun: 0.5, support: 0.45, counter: 0.85 },
  duties: { press: 0.55, cover: 0.15, mark: 0.3, track: 0.45, recover: 0.45 },
};

const STRIKER: PresetDef = {
  line: ShapeLine.FWD, widthAttack: 1, widthDefend: 0.8,
  attackMinNx: -0.25, attackMaxNx: 0.8, defendMinNx: -0.44, defendMaxNx: 0.33,
  pushAttack: 0.95, pushDefend: 1.2, followXBack: 0.56, followXFwd: 0.82, ballFollowZ: 0.32,
  freedom: 0.5, roamRadius: 14, zoneRadius: 8, boxPull: 1,
  runs: { inBehind: 0.95, overlap: 0, lateRun: 0.3, support: 0.4, counter: 0.9 },
  duties: { press: 0.55, cover: 0.05, mark: 0.15, track: 0.2, recover: 0.25 },
};

const CENTRE_FORWARD: PresetDef = {
  line: ShapeLine.FWD, widthAttack: 1, widthDefend: 0.82,
  attackMinNx: -0.3, attackMaxNx: 0.74, defendMinNx: -0.48, defendMaxNx: 0.3,
  pushAttack: 0.95, pushDefend: 1.2, followXBack: 0.56, followXFwd: 0.75, ballFollowZ: 0.32,
  freedom: 0.75, roamRadius: 18, zoneRadius: 8, boxPull: 0.8,
  runs: { inBehind: 0.6, overlap: 0, lateRun: 0.45, support: 0.75, counter: 0.7 },
  duties: { press: 0.55, cover: 0.1, mark: 0.2, track: 0.25, recover: 0.35 },
};

function preset(role: Role, d: PresetDef): RolePreset {
  const side = roleSide(role);
  const maxNz = role === Role.GK ? LOCAL_TUNING.keeperMaxNz : LOCAL_TUNING.outfieldMaxNz;
  return { ...d, role, side, maxNz };
}

/** Behaviour preset per Role (index = Role). Left-sided presets are mirror images of the right-sided ones. */
export const ROLE_PRESETS: readonly RolePreset[] = [
  preset(Role.GK, KEEPER),
  preset(Role.RB, FULL_BACK),
  preset(Role.CB, CENTRE_BACK),
  preset(Role.LB, FULL_BACK),
  preset(Role.RWB, WING_BACK),
  preset(Role.LWB, WING_BACK),
  preset(Role.CDM, HOLDING_MID),
  preset(Role.CM, CENTRAL_MID),
  preset(Role.CAM, ATTACKING_MID),
  preset(Role.RM, WIDE_MID),
  preset(Role.LM, WIDE_MID),
  preset(Role.RW, WINGER),
  preset(Role.LW, WINGER),
  preset(Role.ST, STRIKER),
  preset(Role.CF, CENTRE_FORWARD),
];

export function rolePreset(role: Role): RolePreset {
  return ROLE_PRESETS[role] ?? ROLE_PRESETS[Role.CM]!;
}

// ---------------------------------------------------------------- team phase offsets

export interface PhaseOffset {
  readonly phase: TeamPhase;
  /** Team push along the attack direction, nx (+ = toward the opposition goal); scaled per role by
   *  pushAttack / pushDefend. */
  readonly pushNx: number;
  /** 0 = defensive widths (role.widthDefend), 1 = attacking widths (role.widthAttack); lerp in between. */
  readonly widthBlend: number;
  /** 0 = defend depth band, 1 = attack depth band; the band limits are lerped. */
  readonly attackBand: number;
  /** Multiplier on the role's ball follow (how strongly the block tracks the ball). */
  readonly ballFollow: number;
  /** Speed multiplier for shape / recovery arrival (TAI-07): 1 = normal, > 1 hurry. */
  readonly speedScale: number;
  /** Multiplier on the role's run weights in this phase. */
  readonly runScale: number;
  /** Multiplier on the role's defensive duty weights in this phase. */
  readonly dutyScale: number;
  /** How strongly GET_IN_BOX pulls players into the box in this phase (0 = never: only when attacking). */
  readonly boxPull: number;
}

/** Offsets per TeamPhase (index = TeamPhase). */
export const PHASE_OFFSETS: readonly PhaseOffset[] = [
  { phase: TeamPhase.BUILD_UP, pushNx: 0.05, widthBlend: 1, attackBand: 1, ballFollow: 1, speedScale: 1, runScale: 0.6, dutyScale: 0.5, boxPull: 0 },
  { phase: TeamPhase.ATTACK, pushNx: 0.14, widthBlend: 1, attackBand: 1, ballFollow: 1, speedScale: 1.1, runScale: 1, dutyScale: 0.5, boxPull: 1 },
  { phase: TeamPhase.DEFEND, pushNx: -0.06, widthBlend: 0, attackBand: 0, ballFollow: 1, speedScale: 1.1, runScale: 0, dutyScale: 1, boxPull: 0 },
  { phase: TeamPhase.TRANSITION_ATTACK, pushNx: 0.1, widthBlend: 0.6, attackBand: 1, ballFollow: 0.9, speedScale: 1.4, runScale: 1.3, dutyScale: 0.4, boxPull: 0.5 },
  { phase: TeamPhase.TRANSITION_DEFEND, pushNx: -0.1, widthBlend: 0.2, attackBand: 0, ballFollow: 0.85, speedScale: 1.5, runScale: 0, dutyScale: 1.2, boxPull: 0 },
  { phase: TeamPhase.SET_PIECE, pushNx: 0, widthBlend: 0.5, attackBand: 0.5, ballFollow: 0.6, speedScale: 1, runScale: 0.5, dutyScale: 0.8, boxPull: 0 },
];

export function phaseOffset(phase: TeamPhase): PhaseOffset {
  return PHASE_OFFSETS[phase] ?? PHASE_OFFSETS[TeamPhase.BUILD_UP]!;
}

// ---------------------------------------------------------------- tactical focus

export interface FocusModifier {
  readonly focus: TacticalFocus;
  /** Team block push, nx (scaled per role like the phase push). */
  readonly pushNx: number;
  /** Defensive line offset, nx (+ = higher line), for TAI-04's team.lineX. */
  readonly lineNx: number;
  /** Width multipliers in and out of possession (applied on top of the role's widths). */
  readonly widthAttack: number;
  readonly widthDefend: number;
  /** Multiplier on attacking run weights (TAI-03) and the max number of simultaneous runners. */
  readonly runScale: number;
  readonly maxRunners: number;
  /** Multiplier on defensive duty weights (TAI-04/05/06). */
  readonly dutyScale: number;
  /** Multiplier on press intensity (TAI-05). */
  readonly pressScale: number;
  /** Outfield players kept behind the ball when attacking (rest defence; overlaps/late runs respect it). */
  readonly restDefenders: number;
}

/** Modifiers per TacticalFocus (index = TacticalFocus). */
export const FOCUS_MODIFIERS: readonly FocusModifier[] = [
  { focus: TacticalFocus.DEFAULT, pushNx: 0, lineNx: 0, widthAttack: 1, widthDefend: 1, runScale: 1, maxRunners: 3, dutyScale: 1, pressScale: 1, restDefenders: 4 },
  { focus: TacticalFocus.DEFENDING, pushNx: -0.07, lineNx: -0.06, widthAttack: 0.94, widthDefend: 0.9, runScale: 0.6, maxRunners: 2, dutyScale: 1.2, pressScale: 0.85, restDefenders: 5 },
  { focus: TacticalFocus.ATTACKING, pushNx: 0.07, lineNx: 0.05, widthAttack: 1.06, widthDefend: 1, runScale: 1.35, maxRunners: 4, dutyScale: 0.85, pressScale: 1.1, restDefenders: 3 },
];

export function focusModifier(focus: TacticalFocus): FocusModifier {
  return FOCUS_MODIFIERS[focus] ?? FOCUS_MODIFIERS[TacticalFocus.DEFAULT]!;
}

// ---------------------------------------------------------------- quick tactics

/** Quick tactics as bit flags (team.offsideTrap / teamPress / extraStriker / getInBox). */
export enum TacticFlag {
  NONE = 0,
  OFFSIDE_TRAP = 1,
  TEAM_PRESS = 2,
  EXTRA_STRIKER = 4,
  GET_IN_BOX = 8,
}

/** Quick-tactic toggles of a team as TacticFlag bits. */
export function tacticFlags(t: Readonly<TeamState>): number {
  return (t.offsideTrap ? TacticFlag.OFFSIDE_TRAP : 0) | (t.teamPress ? TacticFlag.TEAM_PRESS : 0) |
    (t.extraStriker ? TacticFlag.EXTRA_STRIKER : 0) | (t.getInBox ? TacticFlag.GET_IN_BOX : 0);
}

/** TacticFlag toggled by a quick-tactic Command, or 0. */
export function tacticFlagForCommand(cmd: Command): number {
  switch (cmd) {
    case Command.TACTIC_OFFSIDE_TRAP: return TacticFlag.OFFSIDE_TRAP;
    case Command.TACTIC_TEAM_PRESS: return TacticFlag.TEAM_PRESS;
    case Command.TACTIC_EXTRA_STRIKER: return TacticFlag.EXTRA_STRIKER;
    case Command.TACTIC_GET_IN_BOX: return TacticFlag.GET_IN_BOX;
    default: return TacticFlag.NONE;
  }
}

/** TacticalFocus set by a focus Command, or -1. */
export function focusForCommand(cmd: Command): number {
  switch (cmd) {
    case Command.FOCUS_DEFAULT: return TacticalFocus.DEFAULT;
    case Command.FOCUS_DEFENDING: return TacticalFocus.DEFENDING;
    case Command.FOCUS_ATTACKING: return TacticalFocus.ATTACKING;
    default: return -1;
  }
}

/** Quick-tactic numbers (BRIEF §10 D-pad up). */
export const QUICK_TACTICS = {
  offsideTrap: {
    /** Higher defensive line while active, nx (TAI-04 adds it to the team.lineX target). */
    lineNx: 0.05,
    /** The back line steps up together this far on a backward or square pass, m (TAI-04). */
    stepUpM: 6,
    /** A pass triggers the step when the ball travels at least this far toward the passer's own goal, m. */
    triggerBackM: 1,
    /** Duration of one step-up before the line re-evaluates, ticks. */
    stepTicks: 40,
    /** Speed multiplier for the back line's step-up arrival. */
    stepSpeedScale: 1.3,
  },
  teamPress: {
    /** Extra block push out of possession, nx (pressing higher up). */
    pushNx: 0.07,
    /** Higher defensive line, nx (TAI-04). */
    lineNx: 0.06,
    /** Added to press intensity (TAI-05), result capped at 1. */
    pressAdd: 0.2,
    /** Players pressing the carrier at once (TAI-05; 1 without the tactic). */
    pressers: 2,
    /** Scale on T_AI.pressDistance (press trigger reaches further). */
    pressDistanceScale: 1.4,
  },
  extraStriker: {
    /** Change to the rest-defence count while active. */
    restDefendersDelta: -1,
    /** Multiplier on run weights while active. */
    runScale: 1.15,
  },
  getInBox: {
    /** Players attacking the box when the ball is in the crossing zone (TAI-03 late runs). */
    boxRunners: 4,
    /** Multiplier on late-run weights while active. */
    lateRunScale: 1.5,
    /** Home nx that pulled roles push up to (0.74 * 52.5 = 38.9 m; the box edge is at 36 m). */
    boxNx: 0.74,
    /** nz multiplier at full pull for wide roles (far-side wide players tuck inside toward the far post). */
    widthScale: 0.4,
  },
} as const;

/** A replacement for one formation slot while a tactic is active (neutral frame, like FormationSlot). */
export interface SlotOverride {
  readonly idx: number;
  readonly role: Role;
  readonly nx: number;
  readonly nz: number;
}

const ov = (idx: number, role: Role, x: number, z: number): SlotOverride => ({ idx, role, nx: x / HALF_LENGTH, nz: z / HALF_WIDTH });

/**
 * EXTRA_STRIKER shapes per FormationId: one midfielder joins the forward line (role ST while active) and the
 * neighbours shift to keep the shape. Slots not listed keep their formation position.
 */
export const EXTRA_STRIKER_SHAPES: readonly (readonly SlotOverride[])[] = [
  /* 4-4-2: right CM becomes the central striker of a front three; the other CM holds the middle. */
  [ov(6, Role.ST, -3, 0), ov(9, Role.ST, -3.5, 11), ov(10, Role.ST, -3.5, -11), ov(7, Role.CM, -15, 0)],
  /* 4-3-3: right CM joins the striker as a pair; the CDM and left CM form a double pivot. */
  [ov(5, Role.ST, -3.5, 6.5), ov(9, Role.ST, -3.5, -6.5), ov(6, Role.CDM, -16.5, 6), ov(7, Role.CM, -16.5, -6)],
  /* 4-2-3-1: the CAM joins the striker as a pair. */
  [ov(8, Role.ST, -3.5, 6.5), ov(10, Role.ST, -3.5, -6.5)],
  /* 3-5-2: right CM becomes the central striker of a front three; the CDM and left CM form a double pivot. */
  [ov(5, Role.ST, -3, 0), ov(9, Role.ST, -3.5, 11), ov(10, Role.ST, -3.5, -11), ov(6, Role.CDM, -16.5, 6), ov(7, Role.CM, -16.5, -6)],
  /* 5-3-2: the central CM becomes the central striker; the other two CMs close the middle. */
  [ov(7, Role.ST, -3, 0), ov(9, Role.ST, -3.5, 11), ov(10, Role.ST, -3.5, -11), ov(6, Role.CM, -15, 7), ov(8, Role.CM, -15, -7)],
  /* 4-1-2-1-2: the CAM becomes the central striker of a front three. */
  [ov(8, Role.ST, -3, 0), ov(9, Role.ST, -3.5, 11), ov(10, Role.ST, -3.5, -11)],
];

/** EXTRA_STRIKER override for a slot, or null when the slot keeps its formation position. */
export function extraStrikerOverride(formation: FormationId, idx: number): SlotOverride | null {
  const list = EXTRA_STRIKER_SHAPES[formation];
  if (list === undefined) return null;
  for (let i = 0; i < list.length; i++) if (list[i]!.idx === idx) return list[i]!;
  return null;
}

/** Effective role of a formation slot under the active quick tactics (EXTRA_STRIKER turns one midfielder into a ST). */
export function slotRole(formation: FormationId, idx: number, flags: number): Role {
  if (flags & TacticFlag.EXTRA_STRIKER) {
    const o = extraStrikerOverride(formation, idx);
    if (o !== null) return o.role;
  }
  const sl = getFormation(formation).slots[idx];
  return sl === undefined ? Role.CM : sl.role;
}

/** Line of a formation slot under the active quick tactics (an EXTRA_STRIKER midfielder plays in the FWD line). */
export function slotLineFor(formation: FormationId, idx: number, flags: number): ShapeLine {
  if (flags & TacticFlag.EXTRA_STRIKER) {
    const o = extraStrikerOverride(formation, idx);
    if (o !== null && rolePreset(o.role).line === ShapeLine.FWD) return ShapeLine.FWD;
  }
  return slotLine(formation, idx);
}

/** Box target spots for crosses (team frame). nzSide is multiplied by the ball side (+1 ball on the right). */
export interface BoxSpot {
  readonly nx: number;
  readonly nzSide: number;
}

/** Near post, far post, penalty spot, back post wide, edge of the box (in the order runners should fill them). */
export const BOX_SPOTS: readonly BoxSpot[] = [
  { nx: 47.5 / HALF_LENGTH, nzSide: 3 / HALF_WIDTH },
  { nx: 47 / HALF_LENGTH, nzSide: -4.5 / HALF_WIDTH },
  { nx: 41.5 / HALF_LENGTH, nzSide: 0 },
  { nx: 44.5 / HALF_LENGTH, nzSide: -10 / HALF_WIDTH },
  { nx: 34.5 / HALF_LENGTH, nzSide: 2 / HALF_WIDTH },
];

/** True when a ball at (bnx, bnz) in the team frame is in the attacking crossing zone (constants CROSS_ZONE_*). */
export function inCrossingZone(bnx: number, bnz: number): boolean {
  return bnx * HALF_LENGTH >= HALF_LENGTH - CROSS_ZONE_DEPTH && (bnz < 0 ? -bnz : bnz) * HALF_WIDTH >= CROSS_ZONE_MIN_Z;
}

// ---------------------------------------------------------------- resolved team parameters

/** Focus + quick tactics resolved into the numbers TAI-01/03/04/05 read (fill with resolveTactics). */
export interface TacticParams {
  /** Block push from focus (+ team press out of possession), nx: in possession / out of possession. */
  pushAttackNx: number;
  pushDefendNx: number;
  /** Defensive line offset for TAI-04, nx (focus + offside trap + team press). */
  lineNx: number;
  /** Width multipliers from focus. */
  widthAttack: number;
  widthDefend: number;
  /** Run weights multiplier, late-run multiplier and max simultaneous runners (TAI-03). */
  runScale: number;
  lateRunScale: number;
  maxRunners: number;
  /** Players attacking the box on a cross (TAI-03); 0 = default behaviour. */
  boxRunners: number;
  /** Rest defence: outfield players kept behind the ball in attack. */
  restDefenders: number;
  /** Defensive duty multiplier and pressing (TAI-05). */
  dutyScale: number;
  pressScale: number;
  pressAdd: number;
  pressers: number;
  pressDistanceScale: number;
  /** Offside-trap step distance, m (0 = trap off). */
  trapStepM: number;
}

export function createTacticParams(): TacticParams {
  return {
    pushAttackNx: 0, pushDefendNx: 0, lineNx: 0, widthAttack: 1, widthDefend: 1, runScale: 1, lateRunScale: 1, maxRunners: 3,
    boxRunners: 0, restDefenders: 4, dutyScale: 1, pressScale: 1, pressAdd: 0, pressers: 1, pressDistanceScale: 1, trapStepM: 0,
  };
}

/** Resolve a focus and TacticFlag bits into `out`. Pure, allocation-free. */
export function resolveTactics(focus: TacticalFocus, flags: number, out: TacticParams): void {
  const fm = focusModifier(focus);
  const q = QUICK_TACTICS;
  const trap = (flags & TacticFlag.OFFSIDE_TRAP) !== 0;
  const press = (flags & TacticFlag.TEAM_PRESS) !== 0;
  const striker = (flags & TacticFlag.EXTRA_STRIKER) !== 0;
  const box = (flags & TacticFlag.GET_IN_BOX) !== 0;
  out.pushAttackNx = fm.pushNx;
  out.pushDefendNx = fm.pushNx + (press ? q.teamPress.pushNx : 0);
  out.lineNx = fm.lineNx + (trap ? q.offsideTrap.lineNx : 0) + (press ? q.teamPress.lineNx : 0);
  out.widthAttack = fm.widthAttack;
  out.widthDefend = fm.widthDefend;
  out.runScale = fm.runScale * (striker ? q.extraStriker.runScale : 1);
  out.lateRunScale = out.runScale * (box ? q.getInBox.lateRunScale : 1);
  out.maxRunners = fm.maxRunners + (striker ? 1 : 0);
  out.boxRunners = box ? q.getInBox.boxRunners : 0;
  out.restDefenders = fm.restDefenders + (striker ? q.extraStriker.restDefendersDelta : 0);
  out.dutyScale = fm.dutyScale;
  out.pressScale = fm.pressScale;
  out.pressAdd = press ? q.teamPress.pressAdd : 0;
  out.pressers = press ? q.teamPress.pressers : 1;
  out.pressDistanceScale = press ? q.teamPress.pressDistanceScale : 1;
  out.trapStepM = trap ? q.offsideTrap.stepUpM : 0;
}

/** Press intensity 0..1 for a base intensity (TAI-12 levelParams or a human-side default) under focus + tactics. */
export function pressIntensity(base: number, focus: TacticalFocus, flags: number): number {
  const v = base * focusModifier(focus).pressScale + ((flags & TacticFlag.TEAM_PRESS) !== 0 ? QUICK_TACTICS.teamPress.pressAdd : 0);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------- reference home position

/** Normalised point in the team frame. */
export interface ShapePoint {
  nx: number;
  nz: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** Clamp to [-1, 1]; NaN -> 0 (a corrupt ball never poisons the shape). */
const unit = (v: number): number => (v >= -1 ? (v <= 1 ? v : 1) : v < -1 ? -1 : 0);

/**
 * Reference home position of formation slot `idx` (team frame, normalised) for a team phase, focus, quick-tactic
 * flags and ball position (bnx, bnz in the team frame; (0, 0) = neutral). Combines: the slot (or its
 * EXTRA_STRIKER override), the team push (phase + focus + team press) scaled by the role, the block following the
 * ball, phase/focus width, GET_IN_BOX pull when the ball is in the crossing zone (ball-side wide players keep
 * their width), and the role's depth band and touchline margin. TAI-01 adds compactness, team.lineX and
 * short-handed stretching on top. World: x = dir * nx * 52.5, z = dir * nz * 34. Allocation-free.
 */
export function tacticalHome(
  formation: FormationId, idx: number, phase: TeamPhase, focus: TacticalFocus, flags: number,
  bnx: number, bnz: number, out: ShapePoint,
): void {
  const slots = getFormation(formation).slots;
  const sl = slots[idx] ?? slots[0]!;
  let nx = sl.nx;
  let nz = sl.nz;
  let role = sl.role;
  if (flags & TacticFlag.EXTRA_STRIKER) {
    const o = extraStrikerOverride(formation, idx);
    if (o !== null) { nx = o.nx; nz = o.nz; role = o.role; }
  }
  const rp = rolePreset(role);
  const ph = phaseOffset(phase);
  const fm = focusModifier(focus);
  const w = ph.attackBand;
  const bx = unit(bnx);
  const bz = unit(bnz);

  let push = ph.pushNx + fm.pushNx;
  if (flags & TacticFlag.TEAM_PRESS) push += QUICK_TACTICS.teamPress.pushNx * (1 - w);
  push *= push >= 0 ? rp.pushAttack : rp.pushDefend;
  const follow = bx < 0 ? rp.followXBack : rp.followXBack + (rp.followXFwd - rp.followXBack) * w;
  nx += push + follow * ph.ballFollow * bx;

  // Width for the phase and focus, then the lateral slide toward the ball: everybody moves toward the ball side,
  // squeezed against the ball-side touchline (spacing shrinks on the ball side, far-side players tuck in; the
  // order across the pitch never changes).
  const wd = rp.widthDefend * fm.widthDefend;
  const wa = rp.widthAttack * fm.widthAttack;
  const max = rp.maxNz;
  const u = clamp((nz * (wd + (wa - wd) * ph.widthBlend)) / max, -1, 1);
  const sgn = bz < 0 ? -1 : 1;
  const c = rp.ballFollowZ * ph.ballFollow * bz * sgn;
  let v = sgn * u;
  v = v < 0 ? v + c : v + c * (1 - v);
  nz = sgn * v * max;

  const lo = rp.defendMinNx + (rp.attackMinNx - rp.defendMinNx) * w;
  let hi = rp.defendMaxNx + (rp.attackMaxNx - rp.defendMaxNx) * w;

  const pull = rp.boxPull * ph.boxPull;
  if ((flags & TacticFlag.GET_IN_BOX) && pull > 0 && rp.side * bz <= 0 && inCrossingZone(bx, bz)) {
    const g = QUICK_TACTICS.getInBox;
    if (rp.side !== 0) nz *= 1 - pull * (1 - g.widthScale);
    if (nx < g.boxNx) nx += pull * (g.boxNx - nx);
    if (hi < g.boxNx) hi += pull * (g.boxNx - hi); // the depth cap moves toward the box by the same fraction
  }

  out.nx = clamp(nx, lo, hi);
  out.nz = clamp(nz, -max, max);
}
