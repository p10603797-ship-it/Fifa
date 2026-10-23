/**
 * [UIX-12] Guided-tutorial steps and their observer (helper file of UIX-12; brief section 11 Practice: "a guided
 * tutorial for whichever input device is in use").
 *
 * Steps, in order: move, sprint, pass, through ball, shoot, tackle, switch, skill, set pieces. Each has hint lines per
 * device (touch / pad / keyboard; drawn with controlGlyphs.ts). TutorialTracker watches a practice match (PracticeKind
 * .TUTORIAL, started from the tutorial screen) through sim state and events and completes the current step when the
 * human performs it:
 *  - move      the controlled player runs under stick input for MOVE_TICKS ticks
 *  - sprint    the controlled player sprints (p.sprinting) for SPRINT_TICKS ticks
 *  - pass      KICK by the human's player with a pass / cross kick kind
 *  - through   KICK with a through-ball kind
 *  - shoot     SHOT (or a shot kick kind) by the human's player
 *  - tackle    TACKLE event with the human's player as the tackler (won or not)
 *  - switch    SWITCH event for the human's controller after the change-player button (MOD_L) press, or on touch
 *              while the opponents carry the ball (a SWITCH tap or a teammate tap; auto-switches happen on loose balls)
 *  - skill     SKILL event by the human's player
 *  - setpiece  a restart phase of the human's team ends with the ball back in play
 * Progress is stored in settings.tutorialDone under `<device>.<step>`; `<device>` alone marks the whole tutorial done.
 *
 * Pure (no DOM): unit-tested with scenario states in Node.
 */
import type { SettingsStore } from '../../contracts/app';
import { ControllerKind, KickKind, MatchPhase } from '../../contracts/enums';
import { EventType, type EventBuffer } from '../../contracts/events';
import { Btn } from '../../contracts/input';
import type { ReadonlySimState } from '../../contracts/state';
import type { DeviceLines } from '../hud/controlGlyphs';
import type { ControlDevice } from '../hud/hudShared';

/** Observation thresholds (UI tutorial checks, not gameplay; no tuning.ts entry needed). */
export const TUTORIAL_TUNING = {
  /** Ticks of running under stick input that complete "move" (1.5 s). */
  moveTicks: 90,
  /** Ticks of sprinting that complete "sprint" (1 s). */
  sprintTicks: 60,
  /** Stick deflection (0..1) and player speed (m/s) that count as moving. */
  stickMin: 0.3,
  speedMin: 1.0,
  /** A SWITCH within this many ticks of a change-player press counts as the human's switch. */
  switchPressTicks: 15,
} as const;

export type TutorialStepId = 'move' | 'sprint' | 'pass' | 'through' | 'shoot' | 'tackle' | 'switch' | 'skill' | 'setpiece';

export interface TutorialStep {
  readonly id: TutorialStepId;
  readonly title: string;
  /** One-line goal shown on the step list. */
  readonly goal: string;
  readonly lines: DeviceLines;
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: 'move', title: 'Move', goal: 'Run around with your player.',
    lines: {
      touch: [{ keys: ['STICK'], text: 'Thumb down on the left half and push: a small tilt jogs, a full tilt runs' }],
      pad: [{ keys: ['LS'], text: 'Move your player' }],
    },
  },
  {
    id: 'sprint', title: 'Sprint', goal: 'Sprint for a second. It costs stamina.',
    lines: {
      touch: [{ keys: [Btn.SPRINT], text: 'Hold the big button while you move' }],
      pad: [{ keys: [Btn.SPRINT], text: 'Hold while you move to sprint' }],
    },
  },
  {
    id: 'pass', title: 'Pass', goal: 'Pass to a teammate.',
    lines: {
      touch: [{ keys: [Btn.PASS], text: 'Tap for a ground pass, hold for power' }, { keys: ['TAP'], text: 'Or tap a teammate' }],
      pad: [{ keys: [Btn.PASS], text: 'Ground pass (hold for power)' }, { keys: [Btn.LOB], text: 'Lob pass or cross' }],
    },
  },
  {
    id: 'through', title: 'Through ball', goal: 'Play the ball into space for a runner.',
    lines: {
      touch: [{ keys: [Btn.THROUGH], text: 'Into space ahead of a runner' }, { keys: ['TAP'], text: 'Or tap the space in front of him' }],
      pad: [{ keys: [Btn.THROUGH], text: 'Through ball into space' }],
    },
  },
  {
    id: 'shoot', title: 'Shoot', goal: 'Take a shot at goal.',
    lines: {
      touch: [{ keys: [Btn.SHOOT], text: 'Tap to shoot, hold for power' }, { keys: ['SWIPE'], text: 'Or swipe toward goal' }],
      pad: [{ keys: [Btn.SHOOT], text: 'Shoot (hold for power)' }, { keys: [Btn.MOD_R, Btn.SHOOT], text: 'Finesse shot' }],
    },
  },
  {
    id: 'tackle', title: 'Tackle', goal: 'Win the ball back from the carrier.',
    lines: {
      touch: [{ keys: ['TACKLE'], text: 'Big button near the carrier' }, { keys: ['SLIDE'], text: 'Slide tackle' }],
      pad: [{ keys: [Btn.SHOOT], text: 'Tackle when you are close' }, { keys: [Btn.LOB], text: 'Slide tackle' }],
    },
  },
  {
    id: 'switch', title: 'Switch player', goal: 'Take control of another defender.',
    lines: {
      touch: [{ keys: ['SWITCH'], text: 'Best-placed defender' }, { keys: ['TAP'], text: 'Or tap a teammate' }],
      pad: [{ keys: [Btn.MOD_L], text: 'Change player' }, { keys: ['RS'], text: 'Flick to switch that way' }],
    },
  },
  {
    id: 'skill', title: 'Skill move', goal: 'Beat a man with a skill move.',
    lines: {
      touch: [{ keys: ['SKILL'], text: 'Tap the big button with the ball' }, { keys: ['SWIPE'], text: 'Swipe it up or right for others' }],
      pad: [{ keys: ['RS'], text: 'Flick or hold to a side' }],
      keyboard: [{ keys: ['T', 'F', 'R'], text: 'Step-over, feint, ball roll' }],
    },
  },
  {
    id: 'setpiece', title: 'Set pieces', goal: 'Take a restart for your team.',
    lines: {
      touch: [{ keys: [Btn.PASS], text: 'Play it short' }, { keys: ['TAP'], text: 'Or tap a teammate or swipe from the ball' }],
      pad: [{ keys: [Btn.PASS], text: 'Short pass' }, { keys: [Btn.LOB], text: 'Lob or cross' }, { keys: ['LS'], text: 'Aim' }],
    },
  },
];

export const TUTORIAL_STEP_COUNT = TUTORIAL_STEPS.length;

// ============================================================ progress in settings

/** settings.tutorialDone key of one step for a device. */
export function stepKey(device: ControlDevice, id: TutorialStepId): string {
  return `${device}.${id}`;
}

/** Done flags per step (TUTORIAL_STEPS order) for a device. */
export function tutorialProgress(settings: SettingsStore, device: ControlDevice): boolean[] {
  let rec: Readonly<Record<string, boolean>> = {};
  try {
    rec = settings.get().tutorialDone ?? {};
  } catch {
    rec = {};
  }
  return TUTORIAL_STEPS.map((s) => rec[stepKey(device, s.id)] === true);
}

/** True when the whole tutorial for the device is done (or skipped). */
export function tutorialComplete(settings: SettingsStore, device: ControlDevice): boolean {
  try {
    return settings.get().tutorialDone?.[device] === true;
  } catch {
    return false;
  }
}

/** Mark one step done; the device's tutorial is marked complete when every step is. */
export function markStepDone(settings: SettingsStore, device: ControlDevice, id: TutorialStepId): void {
  try {
    settings.update((s) => {
      const rec = s.tutorialDone ?? (s.tutorialDone = {});
      rec[stepKey(device, id)] = true;
      if (TUTORIAL_STEPS.every((st) => rec[stepKey(device, st.id)] === true)) rec[device] = true;
    });
  } catch {
    /* settings blocked: progress lives for this session only */
  }
}

/** Mark every step and the tutorial done (Skip tutorial). */
export function markTutorialDone(settings: SettingsStore, device: ControlDevice): void {
  try {
    settings.update((s) => {
      const rec = s.tutorialDone ?? (s.tutorialDone = {});
      for (const st of TUTORIAL_STEPS) rec[stepKey(device, st.id)] = true;
      rec[device] = true;
    });
  } catch {
    /* ignore */
  }
}

/** Clear a device's tutorial progress. */
export function resetTutorial(settings: SettingsStore, device: ControlDevice): void {
  try {
    settings.update((s) => {
      const rec = s.tutorialDone ?? (s.tutorialDone = {});
      for (const st of TUTORIAL_STEPS) delete rec[stepKey(device, st.id)];
      delete rec[device];
    });
  } catch {
    /* ignore */
  }
}

/** First step index at or after `from` that is not done (wrapping), or -1 when all are done. Pure. */
export function nextOpenStep(done: readonly boolean[], from = 0): number {
  const n = done.length;
  if (n === 0) return -1;
  const start = from >= 0 && from < n ? from : 0;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (!done[i]) return i;
  }
  return -1;
}

// ============================================================ observer

const PASS_KINDS: readonly number[] = [
  KickKind.GROUND_PASS, KickKind.DRIVEN_PASS, KickKind.DINKED_PASS, KickKind.LOB_PASS, KickKind.HIGH_LOB, KickKind.DRIVEN_LOB,
  KickKind.CROSS, KickKind.GROUND_CROSS, KickKind.LOW_CROSS, KickKind.HEADER_PASS, KickKind.VOLLEY_PASS,
];
const THROUGH_KINDS: readonly number[] = [KickKind.THROUGH_GROUND, KickKind.THROUGH_LOBBED, KickKind.THROUGH_DINKED];
const SHOT_KINDS: readonly number[] = [
  KickKind.SHOT_NORMAL, KickKind.SHOT_FINESSE, KickKind.SHOT_CHIP, KickKind.SHOT_POWER, KickKind.SHOT_LOW_DRIVEN,
  KickKind.HEADER_SHOT, KickKind.VOLLEY_SHOT,
];

/** Restart phases (a restart of the human's team that ends in IN_PLAY completes "set pieces"). */
export function isRestartPhase(phase: number): boolean {
  return phase === MatchPhase.KICK_OFF || phase === MatchPhase.THROW_IN || phase === MatchPhase.GOAL_KICK ||
    phase === MatchPhase.CORNER || phase === MatchPhase.FREE_KICK || phase === MatchPhase.PENALTY;
}

/** Bit index of MOD_L (change player) in the per-button hold / press arrays. */
const MOD_L_INDEX = 4;

export class TutorialTracker {
  /** Done flags per step. */
  readonly done: boolean[] = TUTORIAL_STEPS.map(() => false);
  /** Current step index, -1 when every step is done. */
  index = 0;
  /** Progress 0..1 of the current step (move / sprint), else 0. */
  progress = 0;
  private acc = 0;
  private lastSlot = -1;
  private ownRestart = false;

  constructor(readonly device: ControlDevice, readonly human = 0) {}

  get current(): TutorialStep | null {
    return this.index >= 0 ? TUTORIAL_STEPS[this.index]! : null;
  }

  get complete(): boolean {
    return this.index < 0;
  }

  /** Start from saved progress at the first open step at or after `from`. */
  start(done: readonly boolean[], from = 0): void {
    for (let i = 0; i < this.done.length; i++) this.done[i] = done[i] === true;
    this.index = nextOpenStep(this.done, from);
    this.resetStep();
  }

  /** Skip the current step (counts as done). Returns the skipped index or -1. */
  skip(): number {
    const i = this.index;
    if (i < 0) return -1;
    this.finish(i);
    return i;
  }

  /** Per rendered frame: state-based steps (move, sprint, set pieces). Returns the step index completed, else -1. */
  observeState(s: ReadonlySimState, ticks: number): number {
    const step = this.current;
    const c = s.ctrl[this.human];
    if (!step || !c || c.kind !== ControllerKind.HUMAN) return -1;
    const slot = c.slot;
    const n = ticks > 0 ? ticks : 0;
    const T = TUTORIAL_TUNING;
    let result = -1;
    if (slot >= 0 && slot < s.players.length) {
      const p = s.players[slot]!;
      const speed = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
      if (step.id === 'move' && n > 0) {
        const stick = Math.sqrt(c.mx * c.mx + c.mz * c.mz);
        if (stick >= T.stickMin && speed >= T.speedMin) this.acc += n;
        this.progress = this.acc >= T.moveTicks ? 1 : this.acc / T.moveTicks;
        if (this.acc >= T.moveTicks) result = this.finish(this.index);
      } else if (step.id === 'sprint' && n > 0) {
        if (p.sprinting === 1 && speed >= T.speedMin) this.acc += n;
        this.progress = this.acc >= T.sprintTicks ? 1 : this.acc / T.sprintTicks;
        if (this.acc >= T.sprintTicks) result = this.finish(this.index);
      }
    }
    if (step.id === 'setpiece') {
      const phase = s.match.phase;
      if (isRestartPhase(phase)) {
        if (s.match.restart.team === c.side) this.ownRestart = true;
      } else if (phase === MatchPhase.IN_PLAY && this.ownRestart) {
        result = this.finish(this.index);
      } else if (phase !== MatchPhase.IN_PLAY) {
        this.ownRestart = false;
      }
    }
    if (slot >= 0) this.lastSlot = slot;
    return result;
  }

  /** After each tick with events: event-based steps. Returns the step index completed, else -1. */
  observeEvents(ev: EventBuffer, s: ReadonlySimState): number {
    const step = this.current;
    const c = s.ctrl[this.human];
    if (!step || !c || c.kind !== ControllerKind.HUMAN) return -1;
    const mine = (slot: number): boolean => slot >= 0 && (slot === c.slot || slot === this.lastSlot);
    for (let i = 0; i < ev.count; i++) {
      const e = ev.get(i);
      let hit = false;
      switch (step.id) {
        case 'pass':
          hit = e.type === EventType.KICK && mine(e.a) && PASS_KINDS.includes(e.b);
          break;
        case 'through':
          hit = e.type === EventType.KICK && mine(e.a) && THROUGH_KINDS.includes(e.b);
          break;
        case 'shoot':
          hit = (e.type === EventType.SHOT && mine(e.a)) || (e.type === EventType.KICK && mine(e.a) && SHOT_KINDS.includes(e.b));
          break;
        case 'tackle':
          hit = e.type === EventType.TACKLE && mine(e.a);
          break;
        case 'switch':
          if (e.type === EventType.SWITCH && e.c === this.human) {
            const pressed = c.pressTick[MOD_L_INDEX] ?? -1;
            const byButton = pressed >= 0 && e.tick - pressed <= TUTORIAL_TUNING.switchPressTicks && e.tick >= pressed;
            const owner = s.ball.owner;
            const theyCarry = owner >= 0 && owner < s.players.length && s.players[owner]!.team !== c.side;
            hit = byButton || (this.device === 'touch' && theyCarry);
          }
          break;
        case 'skill':
          hit = e.type === EventType.SKILL && mine(e.a);
          break;
        default:
          hit = false;
      }
      if (hit) return this.finish(this.index);
    }
    return -1;
  }

  private finish(i: number): number {
    this.done[i] = true;
    this.index = nextOpenStep(this.done, i + 1);
    this.resetStep();
    return i;
  }

  private resetStep(): void {
    this.acc = 0;
    this.progress = 0;
    this.ownRestart = false;
  }
}
