/**
 * [MOD-04] Practice arena, set-piece practice and the tutorial driver (BRIEF §11 Practice: "Free play against a
 * keeper with no clock, set-piece practice, and a guided tutorial for whichever input device is in use").
 *
 * SETUPS (buildPracticeSetup): config.mode = PRACTICE, config.practice = the kind, config.startPhase = IN_PLAY
 * (PRE_MATCH -> IN_PLAY is legal), no replays, human 0 at home on every local device (or the given humans), the
 * opponent is the CPU. The sim runs practice without a clock, forfeits or the idle-ball watchdog (RUL-01/10/11).
 *  - FREE_PLAY: your team against the opponent keeper only. preparePracticeState(s) takes the opponent's outfield
 *    players off the pitch through the supported mechanism (RUL-10 sendOff: active 0, parked beyond the boards);
 *    the invariants allow reduced sides in practice.
 *  - FREE_KICKS / CORNERS / PENALTIES: full teams; the same restart is awarded again after every attempt at the chosen
 *    spot (PRACTICE_SPOTS, setup option `spot`) by practiceRulesTick(s, ev).
 *  - TUTORIAL: full teams, CPU at Beginner; the tutorial screen (UIX-12) drives a TutorialDriver over the session.
 * modeData is a PracticeData { kind, spot, device }.
 *
 * SIM HOOKS (pending lead wiring, see the MOD-04 report): preparePracticeState must run once on the fresh state
 * (end of sim/init initMatch, or session load right after initMatch) and practiceRulesTick once per tick after
 * rulesTick. Both are written to the sim rules (deterministic, no allocation, slot-index loops), so they can move
 * into src/sim unchanged. The chosen spot travels as config.practiceSpot (proposed MatchConfig field; read through
 * practiceSpotOf until the contract has it).
 *
 * Attempt rules (practiceRulesTick, set-piece kinds only): the practice restart is (kind, your side, spot). In any
 * other restart phase (a goal kick, throw-in, the kick-off after a goal, a free kick for the defenders) the pending
 * restart is cancelled through IN_PLAY and the practice restart is awarded instead. In IN_PLAY the attempt ends when
 * the defending side owns the ball (keeper catch included) or after LOCAL_TUNING.attemptTicks (penalties:
 * penaltyAttemptTicks) of live play; IN_PLAY entered from anything but the practice restart (the start) awards at once.
 * Goals still go through GOAL -> CELEBRATION (no replay) -> KICK_OFF and so count on the scoreboard.
 *
 * TUTORIAL DRIVER (createTutorialDriver): steps move, sprint, pass, through ball, shoot, tackle, switch, skill, set
 * piece; each has device-specific text (touch / pad / keyboard) and a completion check over the state and the tick's
 * events for the given human; next() / skip() advance, onTick() returns true on the tick a step completes.
 */
import type { AppContext, DeviceRegistry, MatchSetup } from '../contracts/app';
import { HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_SPOT_DIST, PLAYERS_PER_TEAM } from '../contracts/constants';
import { ControllerKind, Difficulty, KickKind, MatchPhase, ModeId, PracticeKind, RestartKind } from '../contracts/enums';
import { EventType, type EventBuffer, type EventSink } from '../contracts/events';
import type { MatchConfig, ReadonlySimState, SimState } from '../contracts/state';
import { setPhase } from '../sim/rules/machine';
import { awardRestart } from '../sim/rules/restart';
import { sendOff } from '../sim/rules/subs';
import { buildSetup, type HumanChoice } from './setup';

/** TUNING-CR (MOD-04): practice attempt timing (ticks at 60 Hz). */
export const LOCAL_TUNING = { // TUNING-CR
  /** Live play allowed after a free kick or corner is taken before the attempt is over, ticks (6 s). */
  attemptTicks: 360,
  /** Live play allowed after a penalty kick before the attempt is over, ticks (3 s). */
  penaltyAttemptTicks: 180,
  /** Tutorial: metres the controlled player must move for the Move step. */
  tutorialMoveM: 6,
  /** Tutorial: consecutive sprinting ticks for the Sprint step (0.75 s). */
  tutorialSprintTicks: 45,
} as const;

/** A practice spot: `dist` metres out from the attacked goal line, `right` metres to the attacker's right (+z when
 *  attacking +x). Corners use dist 0 and right = +-HALF_WIDTH. */
export interface PracticeSpot {
  id: string;
  label: string;
  dist: number;
  right: number;
}

/** Spots per set-piece kind (index = the `spot` option). Free kicks sit outside the penalty area. */
export const PRACTICE_SPOTS: Readonly<Record<number, readonly PracticeSpot[]>> = {
  [PracticeKind.FREE_KICKS]: [
    { id: 'fk-central', label: 'Central, 22 m', dist: 22, right: 0 },
    { id: 'fk-left', label: 'Left of the D, 21 m', dist: 21, right: -9 },
    { id: 'fk-right', label: 'Right of the D, 21 m', dist: 21, right: 9 },
    { id: 'fk-long', label: 'Long range, 30 m', dist: 30, right: 4 },
    { id: 'fk-wide-left', label: 'Wide left, crossing', dist: 14, right: -26 },
    { id: 'fk-wide-right', label: 'Wide right, crossing', dist: 14, right: 26 },
  ],
  [PracticeKind.CORNERS]: [
    { id: 'corner-left', label: 'Left corner', dist: 0, right: -HALF_WIDTH },
    { id: 'corner-right', label: 'Right corner', dist: 0, right: HALF_WIDTH },
  ],
  [PracticeKind.PENALTIES]: [{ id: 'penalty', label: 'Penalty spot', dist: PENALTY_SPOT_DIST, right: 0 }],
};

/** Restart kind practised by a practice kind (NONE for free play / tutorial). */
export function practiceRestartKind(kind: PracticeKind): RestartKind {
  if (kind === PracticeKind.FREE_KICKS) return RestartKind.FREE_KICK;
  if (kind === PracticeKind.CORNERS) return RestartKind.CORNER;
  if (kind === PracticeKind.PENALTIES) return RestartKind.PENALTY;
  return RestartKind.NONE;
}

/** Number of spots for a kind (0 when it has none). */
export function practiceSpotCount(kind: PracticeKind): number {
  return PRACTICE_SPOTS[kind]?.length ?? 0;
}

/** A valid spot index for the kind (0 when out of range). */
export function clampSpot(kind: PracticeKind, spot: unknown): number {
  const n = practiceSpotCount(kind);
  return typeof spot === 'number' && Number.isInteger(spot) && spot >= 0 && spot < n ? spot : 0;
}

export type TutorialDevice = 'touch' | 'pad' | 'keyboard';

/** modeData of a practice setup. */
export interface PracticeData {
  kind: PracticeKind;
  spot: number;
  device: TutorialDevice | null;
}

export interface PracticeOptions {
  /** Set-piece spot index (PRACTICE_SPOTS). */
  spot?: number;
  homeClub?: number;
  awayClub?: number;
  humans?: HumanChoice[];
  /** Tutorial device (default: the most recently used device). */
  device?: TutorialDevice;
}

type ConfigWithSpot = MatchConfig & { practiceSpot?: number };

/** Spot index carried by a config (proposed MatchConfig.practiceSpot), 0 when absent. */
export function practiceSpotOf(config: Readonly<MatchConfig>): number {
  return clampSpot(config.practice, (config as Readonly<ConfigWithSpot>).practiceSpot);
}

/** Tutorial device for the device used last (touch when unknown). */
export function tutorialDeviceFor(devices: Pick<DeviceRegistry, 'list' | 'lastActive'> | null | undefined): TutorialDevice {
  try {
    const id = devices?.lastActive() ?? null;
    const d = id ? devices!.list().find((x) => x.id === id) : undefined;
    if (d) return d.kind;
  } catch {
    /* registry unavailable */
  }
  return 'touch';
}

export function buildPracticeSetup(ctx: AppContext, kind: PracticeKind = PracticeKind.FREE_PLAY, opts: PracticeOptions = {}): MatchSetup {
  const k = kind >= PracticeKind.FREE_PLAY && kind <= PracticeKind.TUTORIAL ? kind : PracticeKind.FREE_PLAY;
  const setup = buildSetup(ctx, {
    mode: ModeId.PRACTICE, practice: k, homeClub: opts.homeClub, awayClub: opts.awayClub, humans: opts.humans,
    difficulty: k === PracticeKind.TUTORIAL ? Difficulty.BEGINNER : undefined, replays: false,
  });
  const c = setup.config as ConfigWithSpot;
  c.mode = ModeId.PRACTICE;
  c.practice = k;
  c.startPhase = MatchPhase.IN_PLAY;
  c.cupRules = 0;
  c.replaySeconds = 0;
  const spot = clampSpot(k, opts.spot);
  if (practiceSpotCount(k) > 0) c.practiceSpot = spot;
  const data: PracticeData = {
    kind: k, spot, device: k === PracticeKind.TUTORIAL ? (opts.device ?? tutorialDeviceFor(ctx.devices)) : null,
  };
  setup.modeData = data;
  return setup;
}

// ================================================================ sim hooks (sim-safe)

const NULL_SINK: EventSink = { emit() { /* discarded */ } };

function isPracticeState(s: ReadonlySimState): boolean {
  return s.config.mode === ModeId.PRACTICE && s.config.practice !== PracticeKind.NONE;
}

/** Side the human(s) play (home preferred); 0 when nobody does. */
export function practiceSide(config: Readonly<MatchConfig>): number {
  let side = -1;
  for (let h = 0; h < config.humans.length; h++) {
    const c = config.humans[h]!;
    if (c.kind === ControllerKind.HUMAN && (c.side === 0 || c.side === 1) && (side < 0 || c.side < side)) side = c.side;
  }
  return side < 0 ? 0 : side;
}

/**
 * Practice layout on a fresh state (once, before the first tick). FREE_PLAY: every opponent outfield player leaves
 * the pitch (sendOff), so your team faces the keeper alone. Other kinds: no change. Returns the players removed.
 */
export function preparePracticeState(s: SimState): number {
  if (!isPracticeState(s) || s.config.practice !== PracticeKind.FREE_PLAY) return 0;
  const opp = 1 - practiceSide(s.config);
  const first = opp === 0 ? 0 : PLAYERS_PER_TEAM;
  let removed = 0;
  for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
    const slot = first + i;
    const p = s.players[slot]!;
    if (p.active !== 1 || p.isKeeper === 1 || s.teams[opp]!.keeperSlot === slot) continue;
    sendOff(s, slot, NULL_SINK);
    if (s.players[slot]!.active !== 1) removed++;
  }
  return removed;
}

const SPOT_OUT = { x: 0, z: 0 };

/** World position of a practice spot for `team` attacking `dir` (+1 / -1). Pure. */
export function practiceSpotWorld(kind: PracticeKind, spot: number, dir: number, out: { x: number; z: number }): { x: number; z: number } {
  const list = PRACTICE_SPOTS[kind];
  const sp = list ? list[clampSpot(kind, spot)] : undefined;
  const d = dir < 0 ? -1 : 1;
  if (!sp) {
    out.x = 0;
    out.z = 0;
    return out;
  }
  out.x = d * (HALF_LENGTH - sp.dist);
  out.z = d * sp.right;
  return out;
}

function isRestartPhase(p: number): boolean {
  return p === MatchPhase.KICK_OFF || (p >= MatchPhase.THROW_IN && p <= MatchPhase.PENALTY);
}

const RESTART_PHASE: readonly number[] = [
  MatchPhase.IN_PLAY, MatchPhase.KICK_OFF, MatchPhase.THROW_IN, MatchPhase.GOAL_KICK, MatchPhase.CORNER, MatchPhase.FREE_KICK,
  MatchPhase.PENALTY,
];

function ownerTeam(s: ReadonlySimState): number {
  const o = s.ball.owner;
  return o >= 0 && o < NUM_SLOTS ? (o < PLAYERS_PER_TEAM ? 0 : 1) : -1;
}

/** True when the current set-piece attempt (live play after the practice restart) is over. Pure. */
export function practiceAttemptOver(s: ReadonlySimState, team: number, kind: RestartKind): boolean {
  const m = s.match;
  if (m.phase !== MatchPhase.IN_PLAY) return false;
  if (m.prevPhase !== RESTART_PHASE[kind]) return true;
  const ot = ownerTeam(s);
  if (ot >= 0 && ot !== team) return true;
  const limit = kind === RestartKind.PENALTY ? LOCAL_TUNING.penaltyAttemptTicks : LOCAL_TUNING.attemptTicks;
  return m.phaseT >= limit;
}

/**
 * Per tick after rulesTick (set-piece practice only): award the practice restart again when an attempt is over or
 * another restart is pending (see header). Returns 1 when it awarded the restart this tick.
 */
export function practiceRulesTick(s: SimState, ev: EventSink): number {
  if (!isPracticeState(s)) return 0;
  const kind = practiceRestartKind(s.config.practice);
  if (kind === RestartKind.NONE) return 0;
  const m = s.match;
  if (m.finished === 1 || m.phase === MatchPhase.POST_MATCH) return 0;
  const team = practiceSide(s.config);
  const r = m.restart;
  if (isRestartPhase(m.phase)) {
    if (r.taken === 1) return 0;
    if (r.kind === kind && r.team === team) return 0;
    setPhase(s, MatchPhase.IN_PLAY, ev);
  } else if (m.phase !== MatchPhase.IN_PLAY || !practiceAttemptOver(s, team, kind)) {
    return 0;
  }
  practiceSpotWorld(s.config.practice, practiceSpotOf(s.config), s.teams[team]!.dir, SPOT_OUT);
  awardRestart(s, kind, team, SPOT_OUT.x, SPOT_OUT.z, ev);
  return m.phase === RESTART_PHASE[kind] ? 1 : 0;
}

// ================================================================ tutorial driver

export type TutorialStepId = 'move' | 'sprint' | 'pass' | 'through' | 'shoot' | 'tackle' | 'switch' | 'skill' | 'setpiece';

export interface TutorialStep {
  id: TutorialStepId;
  title: string;
  /** What to do, for the device in use. */
  text: string;
}

const STEP_TEXT: Readonly<Record<TutorialStepId, { title: string; touch: string; pad: string; keyboard: string }>> = {
  move: {
    title: 'Move', touch: 'Drag the stick on the left of the screen to run.', pad: 'Move with the left stick.',
    keyboard: 'Move with the arrow keys or WASD.',
  },
  sprint: {
    title: 'Sprint', touch: 'Hold SPRINT while you move.', pad: 'Hold R2 / RT while you move.',
    keyboard: 'Hold the sprint key while you move.',
  },
  pass: {
    title: 'Pass', touch: 'Tap PASS to play a ground pass to a teammate.', pad: 'Press Cross / A to pass.',
    keyboard: 'Press the pass key to pass.',
  },
  through: {
    title: 'Through ball', touch: 'Tap THROUGH to play the ball into space ahead of a runner.',
    pad: 'Press Triangle / Y for a through ball.', keyboard: 'Press the through-ball key.',
  },
  shoot: {
    title: 'Shoot', touch: 'Hold SHOOT for power, release to shoot.', pad: 'Hold Circle / B for power, release to shoot.',
    keyboard: 'Hold the shoot key for power, release to shoot.',
  },
  tackle: {
    title: 'Tackle', touch: 'Without the ball, tap TACKLE when you are goal-side of the carrier.',
    pad: 'Without the ball, press Circle / B to tackle.', keyboard: 'Without the ball, press the tackle key.',
  },
  switch: {
    title: 'Switch player', touch: 'Tap SWITCH to take the best-placed defender.', pad: 'Press L1 / LB to switch player.',
    keyboard: 'Press the switch key to change player.',
  },
  skill: {
    title: 'Skill move', touch: 'Tap SPRINT & SKILL while dribbling.', pad: 'Flick the right stick while dribbling.',
    keyboard: 'Press the skill key while dribbling.',
  },
  setpiece: {
    title: 'Set piece', touch: 'Take a throw-in, corner or free kick: aim, then PASS or SHOOT.',
    pad: 'Take a throw-in, corner or free kick: aim, then pass or shoot.',
    keyboard: 'Take a throw-in, corner or free kick: aim, then pass or shoot.',
  },
};

/** Step order of the guided tutorial. */
export const TUTORIAL_STEP_IDS: readonly TutorialStepId[] = ['move', 'sprint', 'pass', 'through', 'shoot', 'tackle', 'switch', 'skill', 'setpiece'];

/** The tutorial steps with text for `device`. Pure. */
export function tutorialSteps(device: TutorialDevice): TutorialStep[] {
  return TUTORIAL_STEP_IDS.map((id) => ({ id, title: STEP_TEXT[id].title, text: STEP_TEXT[id][device] }));
}

export interface TutorialDriver {
  readonly device: TutorialDevice;
  readonly human: number;
  readonly steps: readonly TutorialStep[];
  /** Index of the current step (steps.length once done). */
  readonly index: number;
  readonly current: TutorialStep | null;
  readonly done: boolean;
  /** Per step: true when it was performed (false = skipped or not reached). */
  readonly completed: readonly boolean[];
  /** Check the current step against this tick. Returns true on the tick the step completes (then advances). */
  onTick(state: ReadonlySimState, events: EventBuffer): boolean;
  /** Advance without completing (Skip). */
  skip(): void;
  /** Advance (Next after a completed step; same as skip for an unfinished one). */
  next(): void;
  /** Go back to the first step. */
  reset(): void;
}

function isPassKick(k: number): boolean {
  return (k >= KickKind.GROUND_PASS && k <= KickKind.LOW_CROSS) || k === KickKind.VOLLEY_PASS || k === KickKind.HEADER_PASS;
}

function isThroughKick(k: number): boolean {
  return k >= KickKind.THROUGH_GROUND && k <= KickKind.THROUGH_DINKED;
}

/** Guided tutorial over a running practice session for `human` (0 or 1). */
export function createTutorialDriver(device: TutorialDevice = 'touch', human = 0): TutorialDriver {
  const steps = tutorialSteps(device);
  const completed = steps.map(() => false);
  let index = 0;
  /** Baseline of the current step (captured on its first tick). */
  let started = false;
  let baseX = 0;
  let baseZ = 0;
  let baseSlot = -1;
  let counter = 0;

  function advance(done: boolean): void {
    if (index >= steps.length) return;
    completed[index] = done;
    index++;
    started = false;
    counter = 0;
  }

  function controlledBy(state: ReadonlySimState, slot: number): boolean {
    return slot >= 0 && slot < NUM_SLOTS && state.players[slot]!.ctrl === human;
  }

  function check(state: ReadonlySimState, events: EventBuffer, id: TutorialStepId): boolean {
    const c = state.ctrl[human];
    if (!c) return false;
    const slot = c.slot;
    const side = c.side;
    switch (id) {
      case 'move': {
        if (slot < 0) return false;
        const p = state.players[slot]!;
        if (!started || slot !== baseSlot) {
          started = true;
          baseSlot = slot;
          baseX = p.x;
          baseZ = p.z;
          return false;
        }
        const dx = p.x - baseX;
        const dz = p.z - baseZ;
        return dx * dx + dz * dz >= LOCAL_TUNING.tutorialMoveM * LOCAL_TUNING.tutorialMoveM;
      }
      case 'sprint': {
        const p = slot >= 0 ? state.players[slot]! : null;
        counter = p && p.sprinting === 1 ? counter + 1 : 0;
        return counter >= LOCAL_TUNING.tutorialSprintTicks;
      }
      case 'setpiece': {
        for (let i = 0; i < events.count; i++) {
          const e = events.get(i);
          if (e.type === EventType.PHASE_CHANGE && e.b === MatchPhase.IN_PLAY && e.a >= MatchPhase.THROW_IN && e.a <= MatchPhase.PENALTY &&
            state.match.restart.team === side) return true;
        }
        return false;
      }
      default: {
        for (let i = 0; i < events.count; i++) {
          const e = events.get(i);
          switch (id) {
            case 'pass':
              if (e.type === EventType.KICK && isPassKick(e.b) && controlledBy(state, e.a)) return true;
              break;
            case 'through':
              if (e.type === EventType.KICK && isThroughKick(e.b) && controlledBy(state, e.a)) return true;
              break;
            case 'shoot':
              if (e.type === EventType.SHOT && controlledBy(state, e.a)) return true;
              break;
            case 'tackle':
              if (e.type === EventType.TACKLE && controlledBy(state, e.a)) return true;
              break;
            case 'switch':
              if (e.type === EventType.SWITCH && e.c === human) return true;
              break;
            case 'skill':
              if (e.type === EventType.SKILL && controlledBy(state, e.a)) return true;
              break;
            default:
              break;
          }
        }
        return false;
      }
    }
  }

  return {
    device,
    human,
    steps,
    get index() {
      return index;
    },
    get current() {
      return index < steps.length ? steps[index]! : null;
    },
    get done() {
      return index >= steps.length;
    },
    completed,
    onTick(state, events) {
      if (index >= steps.length) return false;
      if (!check(state, events, steps[index]!.id)) return false;
      advance(true);
      return true;
    },
    skip() {
      advance(false);
    },
    next() {
      advance(false);
    },
    reset() {
      index = 0;
      started = false;
      counter = 0;
      for (let i = 0; i < completed.length; i++) completed[i] = false;
    },
  };
}
