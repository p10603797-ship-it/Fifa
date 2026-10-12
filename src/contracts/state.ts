/**
 * Sim state layout. Lead-owned, frozen after Wave 0.
 *
 * Rules (ARCHITECTURE rule 1):
 *  - Plain data only: flat objects of finite numbers, fixed-length number arrays, nested plain objects.
 *    No Map/Set, no class instances, no closures, no strings in mutable state, no NaN/Infinity.
 *  - Booleans are stored as 0/1 numbers (hash- and network-friendly).
 *  - Field order is defined by the factory functions below and is the hash/serialise order.
 *  - `config` and `squads` are immutable for a match and are shared by reference between clones.
 *
 * Ownership of fields: the module named in [brackets] writes the field; everyone may read.
 * "lead" fields are written by sim/step.ts or sim/init.ts.
 */

import {
  ActionKind, AiJob, AssistLevel, AutoSwitch, CardKind, ChallengeKind, ControllerKind, CrossKind, Difficulty,
  FormationId, KickKind, KitSlot, MatchPhase, ModeId, Period, PracticeKind, RestartKind, Role, SkillMove,
  TacticalFocus, TeamPhase, TeamStyle,
} from './enums';
import { NUM_CONTROLLERS, NUM_SLOTS, PLAYERS_PER_TEAM, SQUAD_SIZE } from './constants';
import type { InputFrame } from './input';
import { createInputFrame } from './input';
import type { PlayerData } from './data';

// ============================================================ config (immutable per match)

export interface ControllerConfig {
  kind: ControllerKind;
  /** -1 = sits out, 0 = home, 1 = away. */
  side: number;
  assist: AssistLevel;
  autoSwitch: AutoSwitch;
  /** 1 = fast power bar setting. */
  fastPower: number;
}

export interface MatchConfig {
  /** Seed for the sim RNG (uint32). */
  seed: number;
  mode: ModeId;
  /** Club indices into data/clubs. */
  homeClub: number;
  awayClub: number;
  homeKit: KitSlot;
  awayKit: KitSlot;
  homeFormation: FormationId;
  awayFormation: FormationId;
  /** Real minutes per half, 2..10. */
  halfMinutes: number;
  /** Cup rules: extra time then shoot-out if level. */
  cupRules: number;
  /** Render only; kept here so replays reproduce the look. */
  night: number;
  offside: number;
  fouls: number;
  /** Difficulty for CPU-driven sides. */
  difficulty: Difficulty;
  /** Human controllers P1, P2 (index 0, 1). */
  humans: ControllerConfig[];
  practice: PracticeKind;
  /** Phase to start in after PRE_MATCH (KICK_OFF normally, SHOOT_OUT for shoot-out mode). */
  startPhase: MatchPhase;
  /** Max celebration + replay length in seconds (<= 12). 0 disables the replay phase. */
  replaySeconds: number;
}

export function createMatchConfig(): MatchConfig {
  return {
    seed: 1, mode: ModeId.KICK_OFF, homeClub: 0, awayClub: 1, homeKit: KitSlot.HOME, awayKit: KitSlot.AWAY,
    homeFormation: FormationId.F442, awayFormation: FormationId.F442, halfMinutes: 4, cupRules: 0, night: 0,
    offside: 1, fouls: 1, difficulty: Difficulty.PROFESSIONAL,
    humans: [
      { kind: ControllerKind.HUMAN, side: 0, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0 },
      { kind: ControllerKind.NONE, side: -1, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0 },
    ],
    practice: PracticeKind.NONE, startPhase: MatchPhase.KICK_OFF, replaySeconds: 8,
  };
}

// ============================================================ RNG

/** sfc32 state, four uint32 words [FND-03 core/rng.ts]. */
export interface RngState { a: number; b: number; c: number; d: number }

// ============================================================ ball

export interface BallState {
  // kinematics [SIM-01/02, kicks via sim/core/kick.ts]
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Spin angular velocity, rad/s, world axes (sy = curl about vertical axis). */
  sx: number; sy: number; sz: number;
  /** Position at the start of this tick (for swept tests) [SIM-01]. */
  px: number; py: number; pz: number;
  /** 1 while rolling on the ground [SIM-02]. */
  grounded: number;
  bounces: number;
  // possession [SIM-06 owner/ownerT; contacts via sim/core/touch.ts]
  /** Slot in possession (dribbling or holding), -1 = loose. At most one owner. */
  owner: number;
  ownerT: number;
  /** Keeper slot holding the ball in hands, -1 = none. When set, owner === heldBy. [GKP-02/05] */
  heldBy: number;
  lastTouch: number;
  lastTouchTeam: number;
  lastTouchTick: number;
  /** Tick of the latest contact; contact checks skip if === current tick (one contact per tick). */
  touchedTick: number;
  // last kick [sim/core/kick.ts]
  lastKickBy: number;
  lastKickTeam: number;
  lastKickKind: KickKind;
  lastKickTick: number;
  /** Intended receiver of the last pass, -1 none; passX/Z = intended reception point. [SIM-08/09/10] */
  passTarget: number;
  passX: number;
  passZ: number;
  /** Slot that took the shot in flight, -1 = none (cleared on next touch or out of play) [SIM-11/12]. */
  shotBy: number;
  shotTick: number;
  /** 1 if the shot in flight was on target when struck. */
  shotOnTarget: number;
  /** 0 = not in a net; -1 = in the goal at -x; +1 = in the goal at +x [SIM-02]. */
  inNet: number;
  /** Ticks since the last touch while IN_PLAY (watchdog) [lead]. */
  idleT: number;
  // line crossing this tick [SIM-03]
  cross: CrossKind;
  crossX: number;
  crossZ: number;
  /** Which end the ball crossed: -1 (x = -52.5) or +1; 0 for touchlines. */
  crossEnd: number;
}

export function createBallState(): BallState {
  return {
    x: 0, y: 0.11, z: 0, vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, px: 0, py: 0.11, pz: 0, grounded: 1, bounces: 0,
    owner: -1, ownerT: 0, heldBy: -1, lastTouch: -1, lastTouchTeam: -1, lastTouchTick: -1, touchedTick: -1,
    lastKickBy: -1, lastKickTeam: -1, lastKickKind: KickKind.NONE, lastKickTick: -1,
    passTarget: -1, passX: 0, passZ: 0, shotBy: -1, shotTick: -1, shotOnTarget: 0, inNet: 0, idleT: 0,
    cross: CrossKind.NONE, crossX: 0, crossZ: 0, crossEnd: 0,
  };
}

// ============================================================ players

/** How locomotion reads the movement intent. */
export enum MoveMode {
  /** Decelerate to a stop. */
  STOP = 0,
  /** Follow ix/iz directly (human stick, CPU stick). */
  DIRECT = 1,
  /** Arrival steering toward tgtX/tgtZ at up to tgtSpeed, slowing into the target. */
  ARRIVE = 2,
  /** Frozen by an action (no locomotion input, friction only). */
  LOCKED = 3,
}

/** Per-player attributes copied from squad data at kick-off or substitution (+ derived values). */
export interface PlayerAttrs {
  acceleration: number; sprintSpeed: number; agility: number; ballControl: number; dribbling: number;
  shortPassing: number; longPassing: number; crossing: number; vision: number; finishing: number;
  shotPower: number; longShots: number; curve: number; heading: number; standingTackle: number;
  slidingTackle: number; interceptions: number; strength: number; stamina: number; composure: number;
  gkDiving: number; gkHandling: number; gkReflexes: number; gkPositioning: number; gkKicking: number;
  /** cm */
  height: number;
  foot: number;
  /** 1..5 */
  weakFoot: number;
  /** 1..5 */
  skillMoves: number;
  shirt: number;
  // derived at copy time [sim/init.ts + SIM-04 formula]
  /** Top sprint speed m/s (7.0..9.6). */
  topSpeed: number;
  /** Acceleration m/s^2. */
  accel: number;
}

export interface PlayerState {
  // identity [lead / RUL-10]
  team: number;
  slot: number;
  /** Index into the team's squad (0..17). */
  rosterIdx: number;
  /** Formation position index 0..10 (0 = keeper). */
  formIdx: number;
  role: Role;
  isKeeper: number;
  /** 1 = on the pitch and able to act. 0 = sent off (slot empty). */
  active: number;
  // kinematics [SIM-04, SIM-05]
  x: number; z: number;
  vx: number; vz: number;
  /** Facing unit vector. */
  fx: number; fz: number;
  // movement intent [SIM-15 for humans/CPU-active player, ai/* for others]
  moveMode: MoveMode;
  /** Desired direction scaled by stick magnitude, |(ix,iz)| <= 1 (DIRECT). */
  ix: number; iz: number;
  /** ARRIVE target and speed cap (m/s). */
  tgtX: number; tgtZ: number; tgtSpeed: number;
  /** 1 = sprint requested. */
  wantSprint: number;
  /** 1 = keep facing (lookX, lookZ) while moving (jockey, strafe, shield, contain). */
  lookAt: number;
  lookX: number; lookZ: number;
  /** Effective states this tick [SIM-04]. */
  sprinting: number;
  jockeying: number;
  shielding: number;
  // action [owner module of the ActionKind]
  act: ActionKind;
  /** Ticks since the action started. */
  actT: number;
  /** Total ticks before the action ends (wind-up + contact + recovery); may be extended while charging. */
  actDur: number;
  /** Tick (relative to start) of contact; -1 = no contact. */
  actContact: number;
  /** 1 once the contact has been executed. */
  actDone: number;
  actKick: KickKind;
  actSkill: SkillMove;
  /** 0..1 power. While actCharging the input resolver raises it from the hold time. */
  actPower: number;
  /** 1 while the initiating button is still held (power bar filling). [SIM-15] */
  actCharging: number;
  /** Target point / direction / target slot / curl and free parameters. */
  actX: number; actZ: number;
  actDirX: number; actDirZ: number;
  actSlot: number;
  actCurve: number;
  actA: number; actB: number;
  // condition [SIM-04]
  /** 0..1 */
  stamina: number;
  // discipline [RUL-09]
  yellow: number;
  // control [SIM-15]
  /** Controller index controlling this player (0..3), -1 = team AI. */
  ctrl: number;
  // AI [ai/*]
  job: AiJob;
  jobT: number;
  /** Mark / track / press target slot. */
  jobSlot: number;
  /** Formation home position this tick [TAI-01]. */
  homeX: number; homeZ: number;
  // misc
  /** Ticks remaining of a stun (after stumble/fall/foul) [SIM-14]. */
  stunT: number;
  /** Tick this player last touched the ball [sim/core/touch.ts]. */
  lastTouchTick: number;
  /** Ticks until the next dribble touch is allowed [SIM-06]. */
  touchCd: number;
  /** Ticks this player cannot gain possession (after losing the ball / skill window) [SIM-06/13/14]. */
  noTouchT: number;
}

export function createPlayerAttrs(): PlayerAttrs {
  return {
    acceleration: 60, sprintSpeed: 60, agility: 60, ballControl: 60, dribbling: 60, shortPassing: 60, longPassing: 60,
    crossing: 60, vision: 60, finishing: 60, shotPower: 60, longShots: 60, curve: 60, heading: 60, standingTackle: 60,
    slidingTackle: 60, interceptions: 60, strength: 60, stamina: 60, composure: 60,
    gkDiving: 20, gkHandling: 20, gkReflexes: 20, gkPositioning: 20, gkKicking: 20,
    height: 180, foot: 0, weakFoot: 3, skillMoves: 3, shirt: 0, topSpeed: 8.2, accel: 6,
  };
}

export function createPlayerState(slot: number): PlayerState {
  return {
    team: slot < PLAYERS_PER_TEAM ? 0 : 1, slot, rosterIdx: slot % PLAYERS_PER_TEAM, formIdx: slot % PLAYERS_PER_TEAM,
    role: Role.CM, isKeeper: slot % PLAYERS_PER_TEAM === 0 ? 1 : 0, active: 1,
    x: 0, z: 0, vx: 0, vz: 0, fx: 1, fz: 0,
    moveMode: MoveMode.STOP, ix: 0, iz: 0, tgtX: 0, tgtZ: 0, tgtSpeed: 0, wantSprint: 0, lookAt: 0, lookX: 0, lookZ: 0,
    sprinting: 0, jockeying: 0, shielding: 0,
    act: ActionKind.NONE, actT: 0, actDur: 0, actContact: -1, actDone: 0, actKick: KickKind.NONE, actSkill: SkillMove.NONE,
    actPower: 0, actCharging: 0, actX: 0, actZ: 0, actDirX: 0, actDirZ: 0, actSlot: -1, actCurve: 0, actA: 0, actB: 0,
    stamina: 1, yellow: 0, ctrl: -1, job: AiJob.NONE, jobT: 0, jobSlot: -1, homeX: 0, homeZ: 0,
    stunT: 0, lastTouchTick: -1, touchCd: 0, noTouchT: 0,
  };
}

// ============================================================ controllers (humans + CPU brains)

export interface ControllerState {
  kind: ControllerKind;
  /** -1 none, 0 home, 1 away. */
  side: number;
  assist: AssistLevel;
  autoSwitch: AutoSwitch;
  fastPower: number;
  /** Controlled player slot, -1 = none [SIM-15]. */
  slot: number;
  /** Buttons this tick and last tick (Btn bits). */
  buttons: number;
  prevButtons: number;
  /** Ticks each tracked button (bits 0..7) has been held; 0 = up. */
  holdT: number[];
  /** Tick of the last press edge per tracked button (-1 = never). */
  pressTick: number[];
  /** Tick of the last release edge per tracked button (-1 = never). */
  releaseTick: number[];
  /** Movement axes this tick (-1..1 floats decoded from the frame) and ticks the stick has been idle. */
  mx: number; mz: number;
  stickIdleT: number;
  /** Buffered action (resolver-defined code, 0 = none) and the tick it expires. [SIM-15] */
  bufAction: number;
  bufArg: number;
  bufExpire: number;
  /** Switch lock-out ticks remaining, and the next switch target (faint marker). [SIM-15] */
  switchLockT: number;
  nextSwitch: number;
  /** Power bar for HUD: charging button bit (0 = none) and 0..1 value. [SIM-15] */
  powerBtn: number;
  power: number;
  /** Intended receiver auto-moving to collect, -1 = none [SIM-15/TAI-14]. */
  receiver: number;
  /** Teammate called as second defender, -1 = none [SIM-15]. */
  secondDef: number;
  /** D-pad / modifier sequence state for multi-press combos [SIM-15]. */
  seqA: number; seqB: number;
}

export function createControllerState(): ControllerState {
  const n = 8;
  return {
    kind: ControllerKind.NONE, side: -1, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0,
    slot: -1, buttons: 0, prevButtons: 0,
    holdT: new Array<number>(n).fill(0), pressTick: new Array<number>(n).fill(-1), releaseTick: new Array<number>(n).fill(-1),
    mx: 0, mz: 0, stickIdleT: 0, bufAction: 0, bufArg: 0, bufExpire: -1, switchLockT: 0, nextSwitch: -1,
    powerBtn: 0, power: 0, receiver: -1, secondDef: -1, seqA: 0, seqB: 0,
  };
}

/** CPU on-ball plan (TAI-08). */
export enum CpuPlan {
  NONE = 0,
  PASS = 1,
  THROUGH = 2,
  CROSS = 3,
  DRIBBLE = 4,
  SKILL = 5,
  SHIELD = 6,
  CLEAR = 7,
  SHOOT = 8,
  HOLD = 9,
}

/** CPU brain per team: produces the CPU controller's InputFrame each tick [TAI-08..12]. */
export interface CpuBrainState {
  active: number;
  level: Difficulty;
  /** Frame produced this tick; fed to the controller pipeline like a human frame. */
  out: InputFrame;
  plan: CpuPlan;
  planT: number;
  planSlot: number;
  planX: number; planZ: number;
  /** Ticks to keep the action button held (power) for the current plan. */
  holdTicks: number;
  /** Ticks until the next on-ball evaluation. */
  evalT: number;
  /** Reaction delay remaining before responding to a new situation. */
  reactT: number;
  /** Last observed situation key (possession team, ball owner) for reaction delays. */
  seenOwner: number;
  /** Defending: ticks until the next tackle attempt is allowed. */
  tackleCd: number;
  /** Free parameters for the CPU modules (documented in ai/cpu). */
  p0: number; p1: number; p2: number; p3: number;
}

export function createCpuBrainState(): CpuBrainState {
  return {
    active: 0, level: Difficulty.PROFESSIONAL, out: createInputFrame(), plan: CpuPlan.NONE, planT: 0, planSlot: -1,
    planX: 0, planZ: 0, holdTicks: 0, evalT: 0, reactT: 0, seenOwner: -1, tackleCd: 0, p0: 0, p1: 0, p2: 0, p3: 0,
  };
}

// ============================================================ teams

export enum RosterStatus {
  BENCH = 0,
  PLAYING = 1,
  SUBBED_OFF = 2,
  SENT_OFF = 3,
}

export interface TeamState {
  idx: number;
  /** Attack direction along x: +1 or -1. Home is +1 in the first half [RUL-01 swaps at half-time]. */
  dir: number;
  clubIdx: number;
  kit: KitSlot;
  formation: FormationId;
  style: TeamStyle;
  focus: TacticalFocus;
  // quick tactics toggles [TAI-14 via commands]
  offsideTrap: number;
  teamPress: number;
  extraStriker: number;
  getInBox: number;
  /** Corner tactic Command (CORNER_*) or 0. */
  cornerTactic: number;
  goals: number;
  /** Shoot-out goals are in match.shootout. */
  subsUsed: number;
  /** RosterStatus per squad index (length 18) [RUL-10]. */
  roster: number[];
  /** Pending substitutions applied at the next stoppage: out slot and in roster index (length 5 each), count. */
  subOut: number[];
  subIn: number[];
  subCount: number;
  /** Active players on the pitch [RUL-10]. */
  onPitch: number;
  /** Current keeper slot [RUL-10]. */
  keeperSlot: number;
  // team AI blackboard [ai/*]
  phase: TeamPhase;
  phaseT: number;
  /** Loose-ball chaser, -1 = none (exactly one while the ball is free) [TAI-07]. */
  chaser: number;
  chaserT: number;
  /** Defensive line x (in pitch coords) [TAI-04]. */
  lineX: number;
  /** Primary presser and cover [TAI-05]. */
  pressSlot: number;
  coverSlot: number;
  /** Ticks until the next shape update (staggered) [TAI-01]. */
  shapeT: number;
  /** Home position per formation index (length 11) [TAI-01]. */
  homeX: number[];
  homeZ: number[];
  /** Ticks since this team last had possession / last lost it [TAI-06]. */
  possT: number;
  lostT: number;
  cpu: CpuBrainState;
}

export function createTeamState(idx: number): TeamState {
  return {
    idx, dir: idx === 0 ? 1 : -1, clubIdx: idx, kit: idx === 0 ? KitSlot.HOME : KitSlot.AWAY, formation: FormationId.F442,
    style: TeamStyle.POSSESSION, focus: TacticalFocus.DEFAULT, offsideTrap: 0, teamPress: 0, extraStriker: 0, getInBox: 0,
    cornerTactic: 0, goals: 0, subsUsed: 0,
    roster: new Array<number>(SQUAD_SIZE).fill(RosterStatus.BENCH),
    subOut: new Array<number>(5).fill(-1), subIn: new Array<number>(5).fill(-1), subCount: 0,
    onPitch: PLAYERS_PER_TEAM, keeperSlot: idx === 0 ? 0 : PLAYERS_PER_TEAM,
    phase: TeamPhase.BUILD_UP, phaseT: 0, chaser: -1, chaserT: 0, lineX: 0, pressSlot: -1, coverSlot: -1, shapeT: 0,
    homeX: new Array<number>(PLAYERS_PER_TEAM).fill(0), homeZ: new Array<number>(PLAYERS_PER_TEAM).fill(0),
    possT: 0, lostT: 0, cpu: createCpuBrainState(),
  };
}

// ============================================================ match / rules

export interface RestartState {
  kind: RestartKind;
  /** Team taking the restart. */
  team: number;
  /** Ball spot. */
  x: number; z: number;
  taker: number;
  /** Ticks since the restart was awarded. */
  t: number;
  /** 1 once all players are in legal positions and the taker may act. */
  ready: number;
  /** 1 once the ball has been played (phase returns to IN_PLAY). */
  taken: number;
  /** Ticks until the default action is taken for a human who does not act (12 s). */
  timeoutT: number;
  /** Free-kick wall: count and member slots (length 5). */
  wallCount: number;
  wall: number[];
  wallX: number; wallZ: number;
  /** Aim state for set-piece preview (pitch point, power 0..1, curl -1..1) [RUL-04/05/06 + SIM-15]. */
  aimX: number; aimZ: number;
  aimPower: number;
  aimCurve: number;
  /** -1/+1: which corner flag or touchline side; free use per restart kind. */
  side: number;
}

export interface AdvantageState {
  active: number;
  /** Team that was fouled. */
  team: number;
  offender: number;
  victim: number;
  x: number; z: number;
  startTick: number;
  /** Pending card for the offender once play stops (CardKind). */
  card: CardKind;
  /** 1 = the foul was a penalty offence. */
  penalty: number;
}

export interface OffsideState {
  /** Bitmask over slots (bit = slot) of players in an offside position when the last pass was played. */
  flags: number;
  passTick: number;
  passTeam: number;
  passBy: number;
}

export interface ChallengeRecord {
  active: number;
  tackler: number;
  victim: number;
  kind: ChallengeKind;
  /** 1 = tackler touched the ball before the opponent. */
  ballFirst: number;
  /** Contact direction: 1 = from behind, 0 = from the side, -1 = from the front (dot of tackler dir and victim facing). */
  fromBehind: number;
  /** Relative closing speed m/s. */
  closingSpeed: number;
  x: number; z: number;
  tick: number;
}

export function createChallengeRecord(): ChallengeRecord {
  return { active: 0, tackler: -1, victim: -1, kind: ChallengeKind.STAND, ballFirst: 0, fromBehind: 0, closingSpeed: 0, x: 0, z: 0, tick: -1 };
}

export const MAX_CHALLENGES = 4;
export const MAX_SHOOTOUT_KICKS = 40;

export interface ShootoutState {
  active: number;
  /** Team to kick next. */
  team: number;
  /** Kick index per team (number taken). */
  taken: number[];
  goals: number[];
  /** Per team, order of squad indices still eligible this rotation, and next index into it. */
  order: number[];
  order2: number[];
  next: number[];
  /** Result per kick: kicks[team * MAX_SHOOTOUT_KICKS + i] = 0 not taken, 1 scored, 2 missed. */
  kicks: number[];
  /** Sub-state machine of the current kick (RUL-07 defined) and its ticks. */
  sub: number;
  subT: number;
  kicker: number;
  keeper: number;
  suddenDeath: number;
  /** -1 until decided. */
  winner: number;
}

export interface MatchState {
  phase: MatchPhase;
  /** Ticks in the current phase. */
  phaseT: number;
  prevPhase: MatchPhase;
  period: Period;
  /** Clock ticks elapsed in the current period (runs only while the clock runs). */
  periodT: number;
  /** Length of a period in ticks (halfMinutes * 60 * 60, ET periods a third). */
  periodLen: number;
  /** Added time for the current period, in ticks of real play (shown scaled). */
  addedT: number;
  /** Ticks of half-end extension used (capped at 20 s). */
  extensionT: number;
  clockRunning: number;
  /** Team kicking off next, and the team that kicked off the first half. */
  kickoffTeam: number;
  firstKickoffTeam: number;
  restart: RestartState;
  advantage: AdvantageState;
  offside: OffsideState;
  challenges: ChallengeRecord[];
  shootout: ShootoutState;
  /** Last goal: scoring team, scorer slot, assist slot, own goal, tick. */
  goalTeam: number;
  goalScorer: number;
  goalAssist: number;
  goalOwn: number;
  goalTick: number;
  /** -1 or the team that forfeited. */
  forfeitTeam: number;
  /** Number of watchdog interventions this match. */
  watchdogCount: number;
  /** 1 once the match result is final. */
  finished: number;
  /** Winner of a cup tie: 0/1, -1 draw/undecided. */
  winner: number;
}

export function createMatchState(): MatchState {
  return {
    phase: MatchPhase.PRE_MATCH, phaseT: 0, prevPhase: MatchPhase.PRE_MATCH, period: Period.FIRST_HALF, periodT: 0,
    periodLen: 4 * 60 * 60, addedT: 0, extensionT: 0, clockRunning: 0, kickoffTeam: 0, firstKickoffTeam: 0,
    restart: {
      kind: RestartKind.NONE, team: 0, x: 0, z: 0, taker: -1, t: 0, ready: 0, taken: 0, timeoutT: 0, wallCount: 0,
      wall: new Array<number>(5).fill(-1), wallX: 0, wallZ: 0, aimX: 0, aimZ: 0, aimPower: 0, aimCurve: 0, side: 0,
    },
    advantage: { active: 0, team: -1, offender: -1, victim: -1, x: 0, z: 0, startTick: -1, card: CardKind.NONE, penalty: 0 },
    offside: { flags: 0, passTick: -1, passTeam: -1, passBy: -1 },
    challenges: Array.from({ length: MAX_CHALLENGES }, createChallengeRecord),
    shootout: {
      active: 0, team: 0, taken: [0, 0], goals: [0, 0], order: new Array<number>(SQUAD_SIZE).fill(-1),
      order2: new Array<number>(SQUAD_SIZE).fill(-1), next: [0, 0], kicks: new Array<number>(2 * MAX_SHOOTOUT_KICKS).fill(0),
      sub: 0, subT: 0, kicker: -1, keeper: -1, suddenDeath: 0, winner: -1,
    },
    goalTeam: -1, goalScorer: -1, goalAssist: -1, goalOwn: 0, goalTick: -1, forfeitTeam: -1, watchdogCount: 0,
    finished: 0, winner: -1,
  };
}

// ============================================================ root

export interface SimState {
  /** SIM_VERSION at creation. */
  version: number;
  tick: number;
  rng: RngState;
  match: MatchState;
  ball: BallState;
  /** Length NUM_SLOTS. Slots 0..10 team 0, 11..21 team 1. */
  players: PlayerState[];
  /** Length NUM_SLOTS, parallel to players. */
  attrs: PlayerAttrs[];
  /** Length 2. */
  teams: TeamState[];
  /** Length NUM_CONTROLLERS: 0,1 humans; 2,3 CPU brains for team 0/1. */
  ctrl: ControllerState[];
  /** Immutable for the match; shared by reference between clones; not hashed per tick. */
  config: MatchConfig;
  /** Immutable squads [team][rosterIdx]; shared by reference; not hashed per tick. */
  squads: PlayerData[][];
}

/** Keys of SimState shared by reference (not copied by copyState, not part of the tick hash). */
export const IMMUTABLE_STATE_KEYS = ['config', 'squads'] as const;

/** Allocate an empty state with every array at full length. sim/init.ts fills it for a match. */
export function createSimState(config: MatchConfig, squads: PlayerData[][]): SimState {
  return {
    version: 1, tick: 0, rng: { a: 0, b: 0, c: 0, d: 0 }, match: createMatchState(), ball: createBallState(),
    players: Array.from({ length: NUM_SLOTS }, (_, i) => createPlayerState(i)),
    attrs: Array.from({ length: NUM_SLOTS }, createPlayerAttrs),
    teams: [createTeamState(0), createTeamState(1)],
    ctrl: Array.from({ length: NUM_CONTROLLERS }, createControllerState),
    config, squads,
  };
}

/** Deeply read-only view for consumers outside sim (render, ui, audio). */
export type DeepReadonly<T> = T extends (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type ReadonlySimState = DeepReadonly<SimState>;
