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
 * SIM HOOKS [QF-12]: one implementation, in the sim (src/sim/rules/practice.ts, moved there by QF-1). sim/init
 * initMatch runs preparePracticeState on the fresh state and sim/step runs practiceRulesTick once per tick after
 * rulesTick, so the app loop is a plain sim step (replays and headless runs play the same game). This module
 * re-exports those hooks (practiceSide / practiceAttemptOver / practiceSpotWorld are MOD-04's names for practiceTeam /
 * practiceAttemptDone / practiceSpotPoint). The chosen spot travels as config.practiceSpot (proposed MatchConfig
 * field; read through practiceSpotOf = the sim's practiceSpotIndex). PRACTICE_SPOTS (labels for the practice screen)
 * mirrors the sim's spot geometry; tests/scenario/qf-12-practice.test.ts keeps the two equal.
 *
 * Attempt rules (sim practiceRulesTick, set-piece kinds only): the practice restart is (kind, your side, spot). In any
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
import { HALF_WIDTH, NUM_SLOTS, PENALTY_SPOT_DIST } from '../contracts/constants';
import { Difficulty, KickKind, MatchPhase, ModeId, PracticeKind, type RestartKind } from '../contracts/enums';
import { EventType, type EventBuffer } from '../contracts/events';
import type { MatchConfig, ReadonlySimState } from '../contracts/state';
import { T_PRACTICE_MODE } from '../contracts/tuning';
import {
  practiceAttemptDone as simPracticeAttemptDone, practiceSpotIndex as simPracticeSpotIndex,
  practiceSpotPoint as simPracticeSpotPoint, practiceTeam as simPracticeTeam,
} from '../sim/rules/practice';
import { buildSetup, type HumanChoice } from './setup';

/** Tutorial thresholds and the sim's attempt timing: contracts/tuning.ts T_PRACTICE_MODE ([TUN-2]; old name kept). */
export const LOCAL_TUNING = T_PRACTICE_MODE;

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

/** Spot index carried by a config (proposed MatchConfig.practiceSpot), 0 when absent: the index the sim uses. */
export function practiceSpotOf(config: Readonly<MatchConfig>): number {
  return simPracticeSpotIndex(config);
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

// ================================================================ sim hooks (one copy, in the sim)

/**
 * [QF-12] The practice hooks live in the sim (src/sim/rules/practice.ts, QF-1): sim/init initMatch applies the layout
 * and sim/step runs the per-tick rule, so the app loop is a plain step and a replay or headless run plays the same
 * game. These are re-exports of that one implementation (the names MOD-04 shipped are kept as aliases).
 */
export {
  practiceAttemptDone, practiceRestartKind, practiceRulesTick, practiceSpotIndex, practiceSpotPoint, practiceSpotTotal,
  practiceTeam, preparePracticeState,
} from '../sim/rules/practice';

/** Side the human(s) play (home preferred); 0 when nobody does. Alias of the sim's practiceTeam. */
export const practiceSide: (config: Readonly<MatchConfig>) => number = simPracticeTeam;

/** True when the current set-piece attempt is over. Alias of the sim's practiceAttemptDone. Pure. */
export const practiceAttemptOver: (s: ReadonlySimState, team: number, kind: RestartKind) => boolean =
  simPracticeAttemptDone as (s: ReadonlySimState, team: number, kind: RestartKind) => boolean;

/** World position of a practice spot for a team attacking `dir` (+1 / -1), through the sim's practiceSpotPoint. Pure. */
export function practiceSpotWorld(kind: PracticeKind, spot: number, dir: number, out: { x: number; z: number }): { x: number; z: number } {
  simPracticeSpotPoint(kind, spot, dir, out);
  return out;
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
