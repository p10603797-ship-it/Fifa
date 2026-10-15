/**
 * [UIX-12] Control hints in the match HUD.
 *
 * 1. Set-piece hint cards (brief section 12: "Set-piece hints for the first few uses of each restart"): when a restart
 *    phase starts (kick-off, throw-in, goal kick, corner, free kick, penalty; each shoot-out kick) for a side a human
 *    plays, a card shows how to take it on that human's device, with PAD-07 glyphs for pads, key caps for the
 *    keyboard and button names / gestures for touch (e.g. corner: "[X] Lob cross · [A] Short pass"). Penalties also
 *    show the saving hint to a human defending one. A card counts one use in settings.setPieceHintsSeen[RestartKind];
 *    after HINT_USES uses of a kind it no longer shows. It is dismissed by the action: the restart is taken (the phase
 *    ends) or the human presses an action button.
 * 2. The tutorial coach card (PracticeKind.TUTORIAL sessions started from the tutorial screen): the current step with
 *    its glyph lines and progress; steps complete when TutorialTracker (screens/tutorialSteps.ts) sees them performed;
 *    a short "Done" beat, then the next step. Progress persists in settings.tutorialDone.
 * 3. Touch direction-hint countdown (brief section 9: "Show direction hints on a 250 ms hold during the first few
 *    matches"; the touch layer draws them while settings.controls.touch.hintMatchesLeft > 0): one match is counted
 *    off when a non-practice match with a touch device bound reaches its end.
 *
 * One card element top centre, below the toast lane (toasts.ts TOAST_LANE_PX), so it never covers the scoreboard,
 * the touch controls or the safe areas. DOM writes only when the card content changes (a numeric content key is
 * compared every frame; the card is rebuilt on change) or when it shows / hides (class: transform + opacity).
 */
import type { AppContext, FrameInfo, HudPart } from '../../contracts/app';
import type { Club } from '../../contracts/data';
import { ControllerKind, MatchPhase, ModeId, PracticeKind, RestartKind } from '../../contracts/enums';
import type { EventBuffer } from '../../contracts/events';
import { Btn, type CameraProjector } from '../../contracts/input';
import type { ReadonlySimState } from '../../contracts/state';
import { h, injectStyle } from '../components';
import {
  TUTORIAL_STEPS, TUTORIAL_STEP_COUNT, TutorialTracker, isRestartPhase, markStepDone, tutorialProgress,
  type TutorialStepId,
} from '../screens/tutorialSteps';
import { GLYPH_CSS, linesFor, renderHintLines, type DeviceLines } from './controlGlyphs';
import { HUD_SHARED_CSS, bindLargerHud, humanDevice, setRadarEnabled, touchBoundToMatch, type ControlDevice, type DeviceSpec } from './hudShared';
import { TOAST_LANE_PX, TOAST_NARROW_PX } from './toasts';
import { isReplayPlayback } from '../screens/pause';

function sessionSetup(ctx: AppContext): { modeData?: unknown } | null {
  try {
    return ctx.session.getSetup();
  } catch {
    return null;
  }
}

/** Hint constants (UI, not gameplay; no TUNING-CR needed). */
export const HINT_TUNING = {
  /** Set-piece hint cards show for this many uses of each restart kind. */
  uses: 3,
  /** "Done" beat between tutorial steps, ms of unpaused frame time. */
  doneBeatMs: 1200,
} as const;

const CSS = `
.hud-hints { position:absolute; left: 50%; top: calc(var(--safe-top, 0px) + 16px + ${TOAST_LANE_PX}px * var(--hs) + 10px); width: 0; height: 0; }
.hud-hints[hidden] { display:none; }
.hud-hint { position:absolute; left: 0; top: 0; transform: translate(-50%, -10px); opacity: 0; box-sizing: border-box;
  width: max-content; min-width: calc(260px * var(--hs)); max-width: min(calc(520px * var(--hs)), calc(100vw - 48px));
  padding: calc(12px * var(--hs)) calc(16px * var(--hs)); border-radius: calc(14px * var(--hs));
  background: rgba(7,7,13,.86); border: 1px solid var(--hairline-strong); box-shadow: 0 12px 30px rgba(0,0,0,.35);
  font-family: var(--font-ui); color: var(--text-1); font-size: calc(15px * var(--hs)); line-height: 1.2;
  transition: opacity 180ms var(--ease, ease-out), transform 180ms var(--ease, ease-out); will-change: transform, opacity;
  pointer-events: none; }
.hud-hint.is-on { opacity: 1; transform: translate(-50%, 0); }
.hud-hint .hh-head { display:flex; align-items:center; gap: calc(10px * var(--hs)); margin-bottom: calc(8px * var(--hs)); }
.hud-hint .hh-eyebrow { font-size: calc(11px * var(--hs)); font-weight: 700; letter-spacing: .16em; color: var(--ember); }
.hud-hint .hh-title { font-size: calc(17px * var(--hs)); font-weight: 700; }
.hud-hint .hh-title:empty { display:none; }
.hud-hint .hh-count { margin-left: auto; font-family: var(--font-num); font-variant-numeric: tabular-nums; font-size: calc(12px * var(--hs)); color: var(--text-3); }
.hud-hint .hh-lines { display:flex; flex-direction:column; gap: calc(7px * var(--hs)); }
.hud-hint .hh-foot { margin-top: calc(9px * var(--hs)); font-size: calc(12px * var(--hs)); color: var(--text-3); }
.hud-hint .hh-foot:empty { display:none; }
.hud-hint .hh-progress { margin-top: calc(9px * var(--hs)); height: 3px; border-radius: 2px; background: var(--surface-4); overflow:hidden; }
.hud-hint .hh-progress > i { display:block; height: 100%; background: var(--ember); transform-origin: 0 50%; transform: scaleX(0); }
.hud-hint[data-kind="done"] .hh-eyebrow { color: var(--success); }
.hud-hint[data-kind="tutorial"] { border-color: rgba(255,107,53,.35); }
/* Short screens (21:9): the lines flow in rows so the card stays shallow, clear of the ball's usual region. */
@media (max-height: 600px) {
  .hud-hint .hh-lines { flex-direction: row; flex-wrap: wrap; column-gap: calc(18px * var(--hs)); row-gap: calc(6px * var(--hs)); }
  .hud-hint { max-width: min(calc(760px * var(--hs)), calc(100vw - 48px)); padding-top: calc(9px * var(--hs)); padding-bottom: calc(9px * var(--hs)); }
  .hud-hint .hh-head { margin-bottom: calc(6px * var(--hs)); }
}
@media (max-width: ${TOAST_NARROW_PX}px) {
  .hud-hints { top: calc(var(--safe-top, 0px) + 16px + 40px * var(--hs) + 12px + ${TOAST_LANE_PX}px * var(--hs) + 10px); }
}
`;

// ============================================================ set-piece hint content (pure)

interface SetPieceHint {
  readonly title: string;
  readonly lines: DeviceLines;
}

/** Hint content per restart kind (taking) — brief section 9 "Set pieces on touch" and section 10's set-piece table. */
export const SET_PIECE_HINTS: Readonly<Record<number, SetPieceHint>> = {
  [RestartKind.KICK_OFF]: {
    title: 'Kick-off',
    lines: { touch: [{ keys: [Btn.PASS], text: 'Kick off' }], pad: [{ keys: [Btn.PASS], text: 'Kick off' }] },
  },
  [RestartKind.THROW_IN]: {
    title: 'Throw-in',
    lines: {
      touch: [{ keys: ['TAP'], text: 'Tap a teammate' }, { keys: [Btn.PASS], text: 'Short throw' }],
      pad: [{ keys: ['LS'], text: 'Move along the line' }, { keys: [Btn.PASS], text: 'Short throw' }, { keys: [Btn.LOB], text: 'Hold for a long throw' }],
    },
  },
  [RestartKind.GOAL_KICK]: {
    title: 'Goal kick',
    lines: {
      touch: [{ keys: ['TAP'], text: 'Tap a teammate' }, { keys: [Btn.PASS], text: 'Short pass' }],
      pad: [{ keys: [Btn.PASS], text: 'Short pass' }, { keys: [Btn.LOB], text: 'Long kick' }],
    },
  },
  [RestartKind.CORNER]: {
    title: 'Corner',
    lines: {
      touch: [{ keys: ['TAP'], text: 'Tap a teammate or a spot in the box' }, { keys: ['SWIPE'], text: 'Swipe from the ball; curve it for curl' }, { keys: [Btn.PASS], text: 'Play it short' }],
      pad: [{ keys: [Btn.LOB], text: 'Lob cross' }, { keys: [Btn.PASS], text: 'Short pass' }, { keys: ['LS'], text: 'Aim' }],
    },
  },
  [RestartKind.FREE_KICK]: {
    title: 'Free kick',
    lines: {
      touch: [{ keys: ['SWIPE'], text: 'Swipe from the ball: speed sets power, curve sets curl' }, { keys: ['TAP'], text: 'Tap a teammate' }, { keys: [Btn.PASS], text: 'Play it short' }],
      pad: [{ keys: [Btn.SHOOT], text: 'Shoot' }, { keys: [Btn.PASS], text: 'Ground pass' }, { keys: [Btn.LOB], text: 'Lob or cross' }, { keys: ['RS'], text: 'Curl or dip' }, { keys: [Btn.SPRINT], text: 'Choose the taker' }],
    },
  },
  [RestartKind.PENALTY]: {
    title: 'Penalty',
    lines: {
      touch: [{ keys: ['SWIPE'], text: 'Swipe toward the part of the goal you want; faster is harder' }],
      pad: [{ keys: ['LS'], text: 'Aim' }, { keys: [Btn.SHOOT], text: 'Shoot' }, { keys: [Btn.MOD_R, Btn.SHOOT], text: 'Finesse' }, { keys: [Btn.MOD_L, Btn.SHOOT], text: 'Chip' }],
    },
  },
};

/** Saving a penalty. */
export const PENALTY_SAVE_HINT: SetPieceHint = {
  title: 'Save the penalty',
  lines: {
    touch: [{ keys: ['TAP'], text: 'Tap or swipe the way the keeper should dive' }],
    pad: [{ keys: ['LS'], text: 'Move along the line' }, { keys: ['RS'], text: 'Dive' }],
  },
};

/** Restart kind for a restart phase (they map 1:1), RestartKind.NONE otherwise. Pure. */
export function restartKindOfPhase(phase: number): RestartKind {
  switch (phase) {
    case MatchPhase.KICK_OFF: return RestartKind.KICK_OFF;
    case MatchPhase.THROW_IN: return RestartKind.THROW_IN;
    case MatchPhase.GOAL_KICK: return RestartKind.GOAL_KICK;
    case MatchPhase.CORNER: return RestartKind.CORNER;
    case MatchPhase.FREE_KICK: return RestartKind.FREE_KICK;
    case MatchPhase.PENALTY: return RestartKind.PENALTY;
    case MatchPhase.SHOOT_OUT: return RestartKind.PENALTY;
    default: return RestartKind.NONE;
  }
}

/** Uses of a restart kind's hint so far. Pure. */
export function hintUses(seen: Readonly<Record<string, number>> | undefined, kind: RestartKind): number {
  const v = seen ? seen[String(kind)] : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** True while the hint for `kind` should still show. Pure. */
export function shouldShowHint(seen: Readonly<Record<string, number>> | undefined, kind: RestartKind, uses: number = HINT_TUNING.uses): boolean {
  return kind !== RestartKind.NONE && hintUses(seen, kind) < uses;
}

export interface HintTarget {
  /** Human index the card is for, -1 none. */
  human: number;
  /** True: taking the restart; false: defending (penalty save). */
  taking: boolean;
}

/**
 * Which human (if any) gets the hint for a restart awarded to `team`: the human playing that side takes it; for a
 * penalty, a human on the other side saves it. Pure.
 */
export function hintTarget(s: ReadonlySimState, kind: RestartKind, team: number, out: HintTarget): HintTarget {
  out.human = -1;
  out.taking = true;
  for (let h = 0; h < 2; h++) {
    const c = s.ctrl[h];
    if (c && c.kind === ControllerKind.HUMAN && c.side === team) {
      out.human = h;
      return out;
    }
  }
  if (kind === RestartKind.PENALTY) {
    for (let h = 0; h < 2; h++) {
      const c = s.ctrl[h];
      if (c && c.kind === ControllerKind.HUMAN && c.side >= 0 && c.side !== team) {
        out.human = h;
        out.taking = false;
        return out;
      }
    }
  }
  return out;
}

/** Buttons whose press dismisses a set-piece card (taking the kick). */
const ACTION_MASK = Btn.PASS | Btn.SHOOT | Btn.LOB | Btn.THROUGH;

// ============================================================ part

/** Content keys (numeric, compared every frame without allocating). */
const KEY_NONE = 0;
const KEY_SET_PIECE = 1000;
const KEY_TUTORIAL = 2000;
const KEY_TUTORIAL_DONE = 3000;
const KEY_TUTORIAL_COMPLETE = 4000;

/** Setup modeData of a tutorial: MOD-04 PracticeData ({ kind, spot, device }) plus the start step from the screen. */
interface TutorialModeData {
  device?: ControlDevice | null;
  tutorial?: { device?: ControlDevice; startStep?: number };
}

function isDeviceKind(v: unknown): v is ControlDevice {
  return v === 'touch' || v === 'pad' || v === 'keyboard';
}

/** The hints part that runs a tutorial right now (one HUD per app), for the pause menu's Skip step. */
let activeTutorial: { skip(): boolean } | null = null;

/** True while a tutorial practice match has an open step (the pause menu can offer "Skip step"). */
export function tutorialStepActive(): boolean {
  return activeTutorial !== null;
}

/**
 * Skip the tutorial's current step (counts as done, the coach card moves on). For a controller or keyboard player,
 * whose inputs drive the match, from the pause menu. Returns false when no tutorial step is open.
 */
export function skipTutorialStep(): boolean {
  return activeTutorial ? activeTutorial.skip() : false;
}

declare global {
  interface Window {
    /** HUD menu hooks (e2e tests, debug overlay): radar toggle and tutorial skip, as the menus call them. */
    __dotkickHud?: { setRadarEnabled: typeof setRadarEnabled; skipTutorialStep: typeof skipTutorialStep; tutorialStepActive: typeof tutorialStepActive };
  }
}

if (typeof window !== 'undefined') window.__dotkickHud = { setRadarEnabled, skipTutorialStep, tutorialStepActive };

export function createHints(): HudPart {
  let root: HTMLElement | null = null;
  let card: HTMLElement | null = null;
  let ctxRef: AppContext | null = null;
  let unbindLarge: (() => void) | null = null;
  let shownKey = KEY_NONE;
  let shownOn = false;
  let progressBar: HTMLElement | null = null;
  let shownProgress = -1;
  // set-piece state
  let lastPhase = -1;
  let lastKicks = -1;
  let hintKind: RestartKind = RestartKind.NONE;
  let hintTaking = true;
  let hintHuman = -1;
  let hintDevice: DeviceSpec | null = null;
  const target: HintTarget = { human: -1, taking: true };
  // tutorial state
  let tracker: TutorialTracker | null = null;
  let tutDevice: DeviceSpec | null = null;
  let doneBeat = 0;
  let doneStep = -1;
  // direction-hint countdown
  let matchCounted = false;
  let practice = false;

  function setOn(on: boolean): void {
    if (on === shownOn || !card) return;
    shownOn = on;
    card.classList.toggle('is-on', on);
  }

  function buildCard(eyebrow: string, title: string, count: string, dev: DeviceSpec, lines: DeviceLines | null, foot: string, kind: string, progress: boolean): void {
    if (!card) return;
    const linesEl = h('div', { class: 'hh-lines', testId: 'hint-lines' });
    if (lines) renderHintLines(linesEl, dev, linesFor(lines, dev));
    const head = h('div', { class: 'hh-head' }, h('span', { class: 'hh-eyebrow', text: eyebrow, testId: 'hint-eyebrow' }),
      h('span', { class: 'hh-title', text: title, testId: 'hint-title' }));
    if (count) head.append(h('span', { class: 'hh-count', text: count, testId: 'hint-count' }));
    const parts: HTMLElement[] = [head, linesEl];
    progressBar = null;
    shownProgress = -1;
    if (progress) {
      progressBar = h('i');
      parts.push(h('div', { class: 'hh-progress' }, progressBar));
    }
    parts.push(h('div', { class: 'hh-foot', text: foot }));
    card.replaceChildren(...parts);
    card.dataset.kind = kind;
    card.dataset.device = dev.kind;
    card.setAttribute('aria-label', `${eyebrow} ${title}`.trim());
  }

  function dismissSetPiece(): void {
    hintKind = RestartKind.NONE;
    hintHuman = -1;
  }

  function startSetPiece(s: ReadonlySimState, kind: RestartKind, team: number): void {
    dismissSetPiece();
    if (!ctxRef || kind === RestartKind.NONE) return;
    // [QF-12] Nobody takes a set piece in a replay playback: no card, and no use counted off the player's hints.
    if (isReplayPlayback(sessionSetup(ctxRef))) return;
    hintTarget(s, kind, team, target);
    if (target.human < 0) return;
    let seen: Readonly<Record<string, number>> | undefined;
    try {
      seen = ctxRef.settings.get().setPieceHintsSeen;
    } catch {
      seen = undefined;
    }
    if (!shouldShowHint(seen, kind)) return;
    const n = hintUses(seen, kind) + 1;
    try {
      ctxRef.settings.update((st) => {
        const rec = st.setPieceHintsSeen ?? (st.setPieceHintsSeen = {});
        rec[String(kind)] = n;
      });
    } catch {
      /* storage blocked: the hint still shows this time */
    }
    hintKind = kind;
    hintTaking = target.taking;
    hintHuman = target.human;
    hintDevice = humanDevice(ctxRef, target.human);
  }

  function setPieceKey(): number {
    if (hintKind === RestartKind.NONE || !hintDevice) return KEY_NONE;
    return KEY_SET_PIECE + hintKind * 10 + (hintTaking ? 0 : 1);
  }

  function tutorialKey(): number {
    if (!tracker || !tutDevice) return KEY_NONE;
    if (doneBeat > 0 && doneStep >= 0) return KEY_TUTORIAL_DONE + doneStep;
    if (tracker.complete) return KEY_TUTORIAL_COMPLETE;
    return KEY_TUTORIAL + tracker.index;
  }

  function render(key: number): void {
    if (key === KEY_NONE) return;
    if (key >= KEY_SET_PIECE && key < KEY_TUTORIAL && hintDevice) {
      const spec = hintTaking ? SET_PIECE_HINTS[hintKind] : PENALTY_SAVE_HINT;
      if (!spec) return;
      const who = practice || !ctxRef ? '' : humansInMatch() > 1 ? `P${hintHuman + 1}` : '';
      buildCard('SET PIECE', spec.title, who, hintDevice, spec.lines, '', 'setpiece', false);
      return;
    }
    if (!tutDevice || !tracker) return;
    if (key >= KEY_TUTORIAL_COMPLETE) {
      buildCard('TUTORIAL', 'Complete', `${TUTORIAL_STEP_COUNT}/${TUTORIAL_STEP_COUNT}`, tutDevice, null,
        'Pause and quit to finish, or keep playing.', 'done', false);
      return;
    }
    if (key >= KEY_TUTORIAL_DONE) {
      const st = TUTORIAL_STEPS[key - KEY_TUTORIAL_DONE]!;
      buildCard('DONE', st.title, `${doneCount()}/${TUTORIAL_STEP_COUNT}`, tutDevice, null, '', 'done', false);
      return;
    }
    const idx = key - KEY_TUTORIAL;
    const st = TUTORIAL_STEPS[idx]!;
    buildCard(`STEP ${idx + 1}`, st.title, `${doneCount()}/${TUTORIAL_STEP_COUNT}`, tutDevice, st.lines,
      `${st.goal} Pause to skip or leave.`, 'tutorial', st.id === 'move' || st.id === 'sprint');
  }

  function doneCount(): number {
    if (!tracker) return 0;
    let n = 0;
    for (const d of tracker.done) if (d) n++;
    return n;
  }

  function humansInMatch(): number {
    const setup = ctxRef?.session.getSetup();
    return setup ? setup.bindings.length : 1;
  }

  function onStepDone(i: number): void {
    if (i < 0 || !ctxRef || !tutDevice) return;
    markStepDone(ctxRef.settings, tutDevice.kind, TUTORIAL_STEPS[i]!.id as TutorialStepId);
    doneStep = i;
    doneBeat = HINT_TUNING.doneBeatMs;
  }

  const tutorialHandle = {
    skip(): boolean {
      if (!tracker || tracker.complete) return false;
      onStepDone(tracker.skip());
      return true;
    },
  };

  function syncActiveTutorial(): void {
    const open = !!tracker && !tracker.complete;
    if (open) activeTutorial = tutorialHandle;
    else if (activeTutorial === tutorialHandle) activeTutorial = null;
  }

  function countDirectionHintMatch(s: ReadonlySimState): void {
    if (matchCounted || practice || !ctxRef) return;
    if (s.match.finished !== 1 && s.match.phase !== MatchPhase.POST_MATCH) return;
    matchCounted = true;
    if (!touchBoundToMatch(ctxRef)) return;
    try {
      ctxRef.settings.update((st) => {
        const t = st.controls.touch;
        if (t.hintMatchesLeft > 0) t.hintMatchesLeft = Math.floor(t.hintMatchesLeft) - 1;
      });
    } catch {
      /* ignore */
    }
  }

  return {
    mount(parent: HTMLElement, ctx: AppContext) {
      injectStyle('hud-shared', HUD_SHARED_CSS);
      injectStyle('hud-glyphs', GLYPH_CSS);
      injectStyle('hud-hints', CSS);
      ctxRef = ctx;
      card = h('div', { class: 'hud-hint', testId: 'hud-hint', attrs: { role: 'status' } });
      root = h('div', { class: 'hud-part hud-hints', testId: 'hud-hints', attrs: { 'aria-live': 'polite' } }, card);
      parent.append(root);
      unbindLarge = bindLargerHud(ctx, root);
    },
    setMatch(state: ReadonlySimState, clubs: readonly Club[]) {
      void clubs;
      lastPhase = -1;
      lastKicks = -1;
      dismissSetPiece();
      matchCounted = false;
      practice = state.config.mode === ModeId.PRACTICE || state.config.practice !== PracticeKind.NONE;
      tracker = null;
      tutDevice = null;
      doneBeat = 0;
      doneStep = -1;
      // [QF-12] Not for a replay of a tutorial session: its recorded steps would be saved as the viewer's progress.
      if (state.config.practice === PracticeKind.TUTORIAL && ctxRef && !isReplayPlayback(sessionSetup(ctxRef))) {
        let data: TutorialModeData | undefined;
        try {
          data = ctxRef.session.getSetup()?.modeData as TutorialModeData | undefined;
        } catch {
          data = undefined;
        }
        const dev = humanDevice(ctxRef, 0);
        const kind = isDeviceKind(data?.tutorial?.device) ? data.tutorial.device : isDeviceKind(data?.device) ? data.device : dev.kind;
        tutDevice = { kind, family: dev.family };
        tracker = new TutorialTracker(kind, 0);
        tracker.start(tutorialProgress(ctxRef.settings, kind), data?.tutorial?.startStep ?? 0);
      }
      syncActiveTutorial();
      shownKey = -1;
      setOn(false);
    },
    update(state: ReadonlySimState, frame: FrameInfo, projector: CameraProjector | null) {
      void projector;
      const m = state.match;
      const phase = m.phase;
      // Set-piece cards: a new restart phase, or a new shoot-out kick.
      if (phase !== lastPhase) {
        lastPhase = phase;
        if (isRestartPhase(phase)) startSetPiece(state, restartKindOfPhase(phase), m.restart.team);
        else if (phase === MatchPhase.SHOOT_OUT) lastKicks = -1;
        else dismissSetPiece();
      }
      if (phase === MatchPhase.SHOOT_OUT) {
        const kicks = m.shootout.taken[0]! + m.shootout.taken[1]!;
        if (kicks !== lastKicks) {
          lastKicks = kicks;
          if (m.shootout.winner < 0) startSetPiece(state, RestartKind.PENALTY, m.shootout.team);
          else dismissSetPiece();
        }
      }
      if (hintKind !== RestartKind.NONE && hintHuman >= 0) {
        const c = state.ctrl[hintHuman];
        if (c && (c.buttons & ~c.prevButtons & ACTION_MASK) !== 0) dismissSetPiece();
      }
      // Tutorial.
      if (tracker) {
        if (doneBeat > 0 && !frame.paused) {
          doneBeat -= frame.dtMs > 0 ? frame.dtMs : 0;
          if (doneBeat <= 0) {
            doneBeat = 0;
            doneStep = -1;
          }
        }
        onStepDone(tracker.observeState(state, frame.ticks));
        if (tracker.complete && activeTutorial === tutorialHandle) activeTutorial = null;
      }
      countDirectionHintMatch(state);
      // Card.
      let key = setPieceKey();
      if (key === KEY_NONE) key = tutorialKey();
      if (key !== shownKey) {
        shownKey = key;
        render(key);
      }
      setOn(key !== KEY_NONE);
      if (progressBar && tracker && key >= KEY_TUTORIAL && key < KEY_TUTORIAL_DONE) {
        const p = Math.round(tracker.progress * 20);
        if (p !== shownProgress) {
          shownProgress = p;
          progressBar.style.transform = `scaleX(${p / 20})`;
        }
      }
    },
    onEvents(events: EventBuffer, state: ReadonlySimState) {
      if (tracker) onStepDone(tracker.observeEvents(events, state));
    },
    setVisible(v: boolean) {
      if (root) root.hidden = !v;
      // Hidden between matches: no tutorial to skip from a menu.
      if (!v && activeTutorial === tutorialHandle) activeTutorial = null;
      else if (v) syncActiveTutorial();
    },
    dispose() {
      unbindLarge?.();
      unbindLarge = null;
      root?.remove();
      root = card = progressBar = null;
      ctxRef = null;
      tracker = null;
      if (activeTutorial === tutorialHandle) activeTutorial = null;
    },
  };
}
