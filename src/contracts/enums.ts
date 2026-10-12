/**
 * Shared enums. Lead-owned, frozen after Wave 0. Numeric values are part of the replay
 * and network format: append new members at the end, never renumber.
 */

/** Match state machine phases (section 5). PAUSED is an app-level overlay, not a sim phase. */
export enum MatchPhase {
  PRE_MATCH = 0,
  KICK_OFF = 1,
  IN_PLAY = 2,
  THROW_IN = 3,
  GOAL_KICK = 4,
  CORNER = 5,
  FREE_KICK = 6,
  PENALTY = 7,
  GOAL = 8,
  CELEBRATION = 9,
  REPLAY = 10,
  HALF_TIME = 11,
  FULL_TIME = 12,
  /** Break before extra time; leads to KICK_OFF of period 3. */
  EXTRA_TIME = 13,
  SHOOT_OUT = 14,
  POST_MATCH = 15,
}

/** Restart kinds. Restart phases map 1:1 except NONE. */
export enum RestartKind {
  NONE = 0,
  KICK_OFF = 1,
  THROW_IN = 2,
  GOAL_KICK = 3,
  CORNER = 4,
  FREE_KICK = 5,
  PENALTY = 6,
}

/** Match periods. */
export enum Period {
  FIRST_HALF = 1,
  SECOND_HALF = 2,
  ET_FIRST = 3,
  ET_SECOND = 4,
  SHOOT_OUT = 5,
}

/**
 * What a player is doing. Each action is a sim state with fixed tick counts for wind-up,
 * contact and recovery (tuning.ts). Locomotion is not an action (NONE = free to move).
 * Owner module in brackets.
 */
export enum ActionKind {
  NONE = 0,
  /** Any foot pass, cross, through ball, clearance [SIM-08/09/10/14]. actKick = KickKind. */
  KICK = 1,
  /** Any shot incl. first-time and low driven [SIM-11]. actKick = KickKind. */
  SHOT = 2,
  /** Header (pass or shot) [SIM-12]. */
  HEADER = 3,
  /** Volley (pass or shot) [SIM-12]. */
  VOLLEY = 4,
  /** Controlled first touch / trap animation window [SIM-07]. */
  FIRST_TOUCH = 5,
  /** Skill move; actSkill = SkillMove [SIM-13]. */
  SKILL = 6,
  /** Fake shot/pass wind-up cancelled into a touch [SIM-13]. */
  FAKE = 7,
  STAND_TACKLE = 8, // [SIM-14]
  HARD_TACKLE = 9, // [SIM-14]
  SLIDE_TACKLE = 10, // [SIM-14]
  SHOULDER = 11, // [SIM-14]
  PUSH_PULL = 12, // [SIM-14]
  /** Lost balance, short; can still move slowly [SIM-14/SIM-05]. */
  STUMBLE = 13,
  /** On the ground after a foul or slide; cannot act [SIM-14]. */
  FALLEN = 14,
  /** Getting up [SIM-14]. */
  GET_UP = 15,
  /** Keeper dive; actA = dive height class, actB = side (-1/+1) [GKP-02]. */
  GK_DIVE = 16,
  /** Keeper holding the ball in hands [GKP-05]. */
  GK_HOLD = 17,
  /** Keeper throw/roll [GKP-05]. */
  GK_THROW = 18,
  /** Keeper drop kick / driven kick [GKP-05]. */
  GK_KICK = 19,
  /** Keeper rushing out / smothering [GKP-03]. */
  GK_RUSH = 20,
  /** Keeper punch [GKP-03]. */
  GK_PUNCH = 21,
  /** Keeper catch (collect into hands) [GKP-02]. */
  GK_CATCH = 22,
  /** Throw-in taker holding / throwing [RUL-02]. */
  THROW_IN = 23,
  /** Restart taker waiting to take a set piece (free kick, corner, goal kick, penalty, kick-off) [RUL]. */
  SET_PIECE = 24,
  /** Celebration; actA = celebration variant 0..2 [RUL-01 sets, GFX animates]. */
  CELEBRATE = 25,
  DEJECTED = 26,
  /** Wall member jumping [RUL-05/SIM]. */
  WALL_JUMP = 27,
  /** Shielding the ball (held L2 while in possession) [SIM-05]. */
  SHIELD = 28,
}

/** What kind of kick or touch moved the ball. Part of events, offside and back-pass logic. */
export enum KickKind {
  NONE = 0,
  GROUND_PASS = 1,
  DRIVEN_PASS = 2,
  /** Lofted ground pass ("dinked pass"). */
  DINKED_PASS = 3,
  LOB_PASS = 4,
  HIGH_LOB = 5,
  DRIVEN_LOB = 6,
  CROSS = 7,
  GROUND_CROSS = 8,
  /** Driven / low cross. */
  LOW_CROSS = 9,
  THROUGH_GROUND = 10,
  THROUGH_LOBBED = 11,
  /** Lofted / dinked through ball. */
  THROUGH_DINKED = 12,
  SHOT_NORMAL = 13,
  SHOT_FINESSE = 14,
  SHOT_CHIP = 15,
  SHOT_POWER = 16,
  SHOT_LOW_DRIVEN = 17,
  HEADER_SHOT = 18,
  HEADER_PASS = 19,
  VOLLEY_SHOT = 20,
  VOLLEY_PASS = 21,
  CLEARANCE = 22,
  DRIBBLE_TOUCH = 23,
  KNOCK_ON = 24,
  FIRST_TOUCH = 25,
  DEFLECTION = 26,
  TACKLE_POKE = 27,
  GK_THROW = 28,
  GK_DRIVEN_THROW = 29,
  GK_ROLL = 30,
  GK_DROP_KICK = 31,
  GK_DRIVEN_KICK = 32,
  GK_PARRY = 33,
  GK_PUNCH = 34,
  GK_TIP = 35,
  GOAL_KICK = 36,
  THROW_IN = 37,
  KICK_OFF = 38,
  PENALTY = 39,
  /** Direct free-kick shot. */
  FREE_KICK_SHOT = 40,
  SKILL_TOUCH = 41,
  GK_RELEASE = 42,
}

/** True for kinds that count as a deliberate pass/kick by a player's foot (back-pass rule). */
export const isFootPassKind = (k: KickKind): boolean =>
  (k >= KickKind.GROUND_PASS && k <= KickKind.THROUGH_DINKED) || k === KickKind.CLEARANCE || k === KickKind.VOLLEY_PASS ||
  k === KickKind.FREE_KICK_SHOT || k === KickKind.GOAL_KICK || k === KickKind.KICK_OFF;

/** True for shots (used for stats, half-end logic, crowd). */
export const isShotKind = (k: KickKind): boolean =>
  (k >= KickKind.SHOT_NORMAL && k <= KickKind.SHOT_LOW_DRIVEN) || k === KickKind.HEADER_SHOT || k === KickKind.VOLLEY_SHOT ||
  k === KickKind.PENALTY || k === KickKind.FREE_KICK_SHOT;

/** Skill moves (section 6). Eight core moves plus utility touches. */
export enum SkillMove {
  NONE = 0,
  BALL_ROLL = 1,
  STEP_OVER = 2,
  BODY_FEINT = 3,
  DRAG_BACK = 4,
  FAKE_SHOT = 5,
  ROULETTE = 6,
  HEEL_FLICK = 7,
  KNOCK_ON = 8,
  /** Stop the ball dead (release stick + sprint). */
  STOP_BALL = 9,
  /** Stop and face goal (release stick + L1). */
  STOP_FACE_GOAL = 10,
  /** Hard stop (touch swipe left on SPRINT & SKILL). */
  HARD_STOP = 11,
}

/** Pitch gesture kinds produced by the touch layer (section 9). Semantics resolved in sim. */
export enum GestureKind {
  NONE = 0,
  TAP = 1,
  DOUBLE_TAP = 2,
  SWIPE = 3,
  CURVED_SWIPE = 4,
  BACK_FORTH_SWIPE = 5,
}

/** Commands carried in InputFrame.cmd (tactics, subs, set-piece tactics, skips). */
export enum Command {
  NONE = 0,
  TACTIC_OFFSIDE_TRAP = 1,
  TACTIC_TEAM_PRESS = 2,
  TACTIC_EXTRA_STRIKER = 3,
  TACTIC_GET_IN_BOX = 4,
  FOCUS_DEFAULT = 5,
  FOCUS_DEFENDING = 6,
  FOCUS_ATTACKING = 7,
  /** Open quick-sub prompt (app shows UI; resulting choice arrives as SUBSTITUTE). */
  QUICK_SUB = 8,
  /** cmdArg = outSlot | (inRosterIdx << 8). Applied at the next stoppage. */
  SUBSTITUTE = 9,
  /** cmdArg = FormationId. */
  SET_FORMATION = 10,
  CORNER_FAR_POST = 11,
  CORNER_EDGE_OF_BOX = 12,
  CORNER_CROWD_KEEPER = 13,
  CORNER_NEAR_POST = 14,
  /** Skip celebration / replay / establishing shot. */
  SKIP = 15,
  /** cmdArg = roster swap a | (b << 8) inside the pitch (position swap, no sub used). */
  SWAP_POSITIONS = 16,
}

/** Team-level phase used by team AI. */
export enum TeamPhase {
  BUILD_UP = 0,
  ATTACK = 1,
  DEFEND = 2,
  /** Just won the ball: counter-attack window. */
  TRANSITION_ATTACK = 3,
  /** Just lost the ball: recovery window. */
  TRANSITION_DEFEND = 4,
  SET_PIECE = 5,
}

export enum TacticalFocus {
  DEFAULT = 0,
  DEFENDING = 1,
  ATTACKING = 2,
}

/** Off-ball AI jobs, in ascending priority. A module may only overwrite a job of lower or equal priority in the same tick. */
export enum AiJob {
  NONE = 0,
  HOLD_SHAPE = 1,
  SUPPORT = 2,
  RUN_IN_BEHIND = 3,
  OVERLAP = 4,
  LATE_RUN = 5,
  MARK = 6,
  TRACK_RUNNER = 7,
  COVER = 8,
  RECOVER = 9,
  PRESS = 10,
  CHASE_LOOSE = 11,
  RECEIVE = 12,
  SET_PIECE = 13,
  CELEBRATE = 14,
}

export enum Role {
  GK = 0,
  RB = 1,
  CB = 2,
  LB = 3,
  RWB = 4,
  LWB = 5,
  CDM = 6,
  CM = 7,
  CAM = 8,
  RM = 9,
  LM = 10,
  RW = 11,
  LW = 12,
  ST = 13,
  CF = 14,
}

export enum FormationId {
  F442 = 0,
  F433 = 1,
  F4231 = 2,
  F352 = 3,
  F532 = 4,
  F41212 = 5,
}

export enum TeamStyle {
  POSSESSION = 0,
  COUNTER = 1,
  DIRECT = 2,
  HIGH_PRESS = 3,
  WING_PLAY = 4,
}

export enum Difficulty {
  BEGINNER = 0,
  AMATEUR = 1,
  SEMI_PRO = 2,
  PROFESSIONAL = 3,
  WORLD_CLASS = 4,
  LEGEND = 5,
}

export enum AssistLevel {
  ASSISTED = 0,
  SEMI = 1,
  MANUAL = 2,
}

export enum AutoSwitch {
  OFF = 0,
  AIR_AND_LOOSE = 1,
  AUTO = 2,
}

export enum ControllerKind {
  NONE = 0,
  HUMAN = 1,
  CPU = 2,
}

export enum CardKind {
  NONE = 0,
  YELLOW = 1,
  RED = 2,
  /** Second yellow, shown as yellow then red. */
  SECOND_YELLOW = 3,
}

/** Outcome of a challenge classified by RUL-09. */
export enum ChallengeOutcome {
  CLEAN = 0,
  FOUL = 1,
  FOUL_YELLOW = 2,
  FOUL_RED = 3,
}

export enum ChallengeKind {
  STAND = 0,
  HARD = 1,
  SLIDE = 2,
  SHOULDER = 3,
  PUSH_PULL = 4,
  KEEPER = 5,
}

/** How a save was made (GKP-02). */
export enum SaveKind {
  CATCH = 0,
  PARRY = 1,
  TIP_OVER = 2,
  PUNCH = 3,
  BLOCK = 4,
}

/** Ball line-crossing result (SIM-03). */
export enum CrossKind {
  NONE = 0,
  /** Whole ball over the goal line between the posts and under the bar. */
  GOAL = 1,
  /** Whole ball over a touchline (throw-in). */
  TOUCHLINE = 2,
  /** Whole ball over a goal line outside the goal (goal kick or corner). */
  GOAL_LINE = 3,
}

export enum ModeId {
  KICK_OFF = 0,
  FRIEND_LOCAL = 1,
  FRIEND_ONLINE = 2,
  CUP = 3,
  SHOOT_OUT = 4,
  PRACTICE = 5,
  BENCH = 6,
}

export enum PracticeKind {
  NONE = 0,
  FREE_PLAY = 1,
  FREE_KICKS = 2,
  CORNERS = 3,
  PENALTIES = 4,
  TUTORIAL = 5,
}

export enum KitPattern {
  PLAIN = 0,
  STRIPES = 1,
  HOOPS = 2,
  HALVES = 3,
  SASH = 4,
}

export enum KitSlot {
  HOME = 0,
  AWAY = 1,
  /** Keeper kit (used automatically for keepers). */
  KEEPER = 2,
}

export enum Foot {
  RIGHT = 0,
  LEFT = 1,
}

export enum CameraType {
  BROADCAST = 0,
  WIDE = 1,
  CLOSE = 2,
  END_TO_END = 3,
}

export enum QualityTier {
  AUTO = 0,
  PERFORMANCE = 1,
  BALANCED = 2,
  QUALITY = 3,
}

export enum PadFamily {
  AUTO = 0,
  PLAYSTATION = 1,
  XBOX = 2,
  SWITCH = 3,
  GENERIC = 4,
}

/** Reasons the watchdog forced a restart (RUL-11). */
export enum WatchdogReason {
  PHASE_TIMEOUT = 0,
  BALL_UNTOUCHED = 1,
  BALL_UNREACHABLE = 2,
  RESTART_BLOCKED = 3,
  ACTION_OVERRUN = 4,
  OTHER = 5,
}
