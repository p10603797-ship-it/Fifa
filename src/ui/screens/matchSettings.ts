/**
 * [UIX-05] Match settings (BRIEF §11 Kick-Off options: difficulty, half length 2-10 min, friendly or cup rules, day or
 * night, rule toggles offside / fouls; §12 Screens; settings.match defaults).
 *
 * Layout (original): the fixture strip (crests, codes, who plays each side: P1 / P2 markers or CPU) above two columns
 * of controls: difficulty (only when a side is CPU), half length, friendly / cup rules, time of day | offside,
 * fouls, goal replays, camera quick choice. Shoot-out shows only difficulty, time of day and camera (no clock, no
 * open play). Start (top right, [settings-start]) builds the MatchSetup from the flow (clubs and kits from team
 * select, humans and bindings from side select, these options), remembers the choices (settings.match, the camera
 * in settings.camera, the cup-rules choice in the progress store) and calls ctx.session.start, which shows the
 * loading screen.
 *
 * Touch: tap the controls. Controller / keyboard: Up / Down move between rows, Left / Right change the focused
 * value (selector, slider, toggle) or move along a segmented row, Confirm on Start starts; Back goes back.
 */
import type { AppContext, MatchSetup, Screen, ScreenParams } from '../../contracts/app';
import { MenuAction, UiSound } from '../../contracts/app';
import { CameraType, ControllerKind, Difficulty, ModeId } from '../../contracts/enums';
import type { Settings } from '../../contracts/settings';
import type { MatchConfig } from '../../contracts/state';
import { withRecords } from '../../modes/records';
import { crestDataUrl } from '../../render/kits';
import { createButton, createSegmented, createSelector, createSlider, createToggle, h, injectStyle } from '../components';
import { attachDotField, sharedDotField } from '../dotfield';
import {
  DEFAULT_REPLAY_SECONDS, MODE_LABELS, cloneSetup, createFlowTop, createStepDots, injectFlowStyle, readFlow, rememberFlowMode,
  type FlowMode,
} from './matchFlow';

export const HALF_MIN = 2;
export const HALF_MAX = 10;
/** Progress-store key of the last friendly / cup rules choice (MatchDefaults has no field for it). */
export const CUP_RULES_KEY = 'uix05.cupRules';

export const DIFFICULTY_OPTIONS: readonly { value: Difficulty; label: string }[] = [
  { value: Difficulty.BEGINNER, label: 'Beginner' },
  { value: Difficulty.AMATEUR, label: 'Amateur' },
  { value: Difficulty.SEMI_PRO, label: 'Semi-Pro' },
  { value: Difficulty.PROFESSIONAL, label: 'Professional' },
  { value: Difficulty.WORLD_CLASS, label: 'World Class' },
  { value: Difficulty.LEGEND, label: 'Legend' },
];

export const CAMERA_OPTIONS: readonly { value: CameraType; label: string }[] = [
  { value: CameraType.BROADCAST, label: 'Broadcast' },
  { value: CameraType.WIDE, label: 'Wide' },
  { value: CameraType.CLOSE, label: 'Close' },
  { value: CameraType.END_TO_END, label: 'End to end' },
];

/** The choices on this screen. */
export interface MatchOptions {
  difficulty: Difficulty;
  halfMinutes: number;
  cupRules: boolean;
  night: boolean;
  offside: boolean;
  fouls: boolean;
  replays: boolean;
  camera: CameraType;
}

function clampHalf(v: number): number {
  const r = Math.round(Number.isFinite(v) ? v : 4);
  return r < HALF_MIN ? HALF_MIN : r > HALF_MAX ? HALF_MAX : r;
}

function validDifficulty(d: number): Difficulty {
  return DIFFICULTY_OPTIONS.some((o) => o.value === d) ? (d as Difficulty) : Difficulty.PROFESSIONAL;
}

function validCamera(c: number): CameraType {
  return CAMERA_OPTIONS.some((o) => o.value === c) ? (c as CameraType) : CameraType.BROADCAST;
}

/** Initial options: the saved match defaults and camera, plus the remembered rules choice. Pure. */
export function optionsFromSettings(s: Readonly<Settings>, cupRules = false): MatchOptions {
  const m = s.match;
  return {
    difficulty: validDifficulty(m.difficulty),
    halfMinutes: clampHalf(m.halfMinutes),
    cupRules: !!cupRules,
    night: !!m.night,
    offside: !!m.offside,
    fouls: !!m.fouls,
    replays: !!m.replays,
    camera: validCamera(s.camera?.type),
  };
}

/** Write the options into a match config (Shoot-out keeps its own phase and cup rules). Pure. */
export function applyMatchOptions(c: MatchConfig, o: MatchOptions, mode: FlowMode): void {
  c.difficulty = validDifficulty(o.difficulty);
  c.night = o.night ? 1 : 0;
  c.replaySeconds = o.replays ? DEFAULT_REPLAY_SECONDS : 0;
  if (mode === ModeId.SHOOT_OUT) {
    c.cupRules = 1;
    return;
  }
  c.halfMinutes = clampHalf(o.halfMinutes);
  c.cupRules = o.cupRules ? 1 : 0;
  c.offside = o.offside ? 1 : 0;
  c.fouls = o.fouls ? 1 : 0;
}

/** Remember the choices in the settings (call inside settings.update). Shoot-out leaves the open-play rules alone. */
export function persistOptions(s: Settings, o: MatchOptions, c: MatchConfig, mode: FlowMode): void {
  const m = s.match;
  m.difficulty = validDifficulty(o.difficulty);
  m.night = !!o.night;
  m.replays = !!o.replays;
  m.homeClub = c.homeClub;
  m.awayClub = c.awayClub;
  m.homeKit = c.homeKit;
  m.awayKit = c.awayKit;
  if (mode !== ModeId.SHOOT_OUT) {
    m.halfMinutes = clampHalf(o.halfMinutes);
    m.offside = !!o.offside;
    m.fouls = !!o.fouls;
  }
  s.camera.type = validCamera(o.camera);
}

/** True when at least one side has no human (difficulty matters). */
export function hasCpuSide(c: MatchConfig): boolean {
  let home = false, away = false;
  for (const hc of c.humans) {
    if (hc.kind !== ControllerKind.HUMAN) continue;
    if (hc.side === 0) home = true;
    else if (hc.side === 1) away = true;
  }
  return !(home && away);
}

/** The setup to start: a copy of the flow's setup with the options applied. Pure. */
export function buildMatchSetup(flowSetup: MatchSetup, o: MatchOptions, mode: FlowMode): MatchSetup {
  const s = cloneSetup(flowSetup);
  applyMatchOptions(s.config, o, mode);
  return s;
}

/**
 * [QF-12] The setup Start hands to the session: buildMatchSetup with the lifetime records hooked to onFinish (MOD-05
 * withRecords, as modes/kickoff buildKickOffSetup and modes/shootout buildShootoutSetup do). Kick-Off, Play a Friend
 * and Shoot-out matches started through this flow used to finish unrecorded: only Play now and cup ties counted.
 */
export function startSetup(ctx: Pick<AppContext, 'settings'>, flowSetup: MatchSetup, o: MatchOptions, mode: FlowMode): MatchSetup {
  return withRecords(ctx.settings, buildMatchSetup(flowSetup, o, mode));
}

const CSS = `
.mset-fixture { flex: 0 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center;
  gap: var(--space-5); width: 100%; max-width: 980px; margin: 0 auto; padding: var(--space-3) var(--space-5); border-radius: var(--radius-lg);
  background: var(--surface-1); border: 1px solid var(--hairline); box-sizing: border-box; }
.mset-team { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.mset-team--away { flex-direction: row-reverse; text-align: right; }
.mset-team img { width: 44px; height: 44px; flex: 0 0 auto; }
.mset-team-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.mset-code { font: 600 var(--fs-lg) / 1 var(--font-num); letter-spacing: 0.04em; }
.mset-name { font-size: var(--fs-xs); color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mset-who { font: 700 var(--fs-xs) / 1 var(--font-ui); letter-spacing: 0.06em; color: var(--text-2); }
.mset-who .p1 { color: var(--p1); }
.mset-who .p2 { color: var(--p2); }
.mset-vs { font-size: var(--fs-sm); color: var(--text-3); }
.mset-grid { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3) var(--space-6); align-content: start; width: 100%; max-width: 980px; margin: 0 auto; padding: 4px; box-sizing: border-box; }
.mset-col { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
.mset-col .seg { width: 100%; }
.mset-note { margin: -4px 0 0; font-size: var(--fs-xs); color: var(--text-3); }
@media (max-height: 640px) {
  .mset-fixture { padding: var(--space-2) var(--space-4); }
  .mset-team img { width: 32px; height: 32px; }
  .mset-name { display: none; }
  .mset-team-text { flex-direction: row; align-items: baseline; gap: var(--space-3); }
  .mset-grid { gap: var(--space-2) var(--space-5); }
  .mset-col { gap: var(--space-2); }
  .mset-note { display: none; }
}
`;

function whoPlays(c: MatchConfig, side: number): HTMLElement {
  const el = h('span', { class: 'mset-who', testId: `mset-who-${side === 0 ? 'home' : 'away'}` });
  const parts: HTMLElement[] = [];
  c.humans.forEach((hc, i) => {
    if (hc.kind === ControllerKind.HUMAN && hc.side === side) parts.push(h('span', { class: i === 0 ? 'p1' : 'p2', text: `P${i + 1}` }));
  });
  if (parts.length === 0) el.textContent = 'CPU';
  else parts.forEach((p, i) => el.append(...(i > 0 ? [' + ', p] : [p])));
  return el;
}

export function createMatchSettingsScreen(): Screen {
  let detachDots: (() => void) | null = null;
  let cleanup: (() => void) | null = null;
  return {
    id: 'match-settings',
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      injectFlowStyle();
      injectStyle('match-settings', CSS);
      root.classList.add('flow');
      detachDots = attachDotField(root);
      const flow = readFlow(ctx, params);
      const mode = flow.mode;
      const config = flow.setup.config;
      let cupSaved = false;
      try {
        cupSaved = ctx.settings.loadProgress<boolean>(CUP_RULES_KEY) === true;
      } catch {
        /* storage blocked */
      }
      // Back to this screen shows the choices made here: they live in params.options.
      const saved = params?.options as MatchOptions | undefined;
      const opts: MatchOptions = saved && typeof saved === 'object' ? saved : optionsFromSettings(ctx.settings.get(), cupSaved);
      try {
        if (params) params.options = opts;
      } catch {
        /* frozen params */
      }
      const shootout = mode === ModeId.SHOOT_OUT;

      // ---- fixture strip
      const team = (side: 0 | 1): HTMLElement => {
        const club = ctx.clubs[side === 0 ? config.homeClub : config.awayClub];
        return h(
          'div',
          { class: `mset-team mset-team--${side === 0 ? 'home' : 'away'}` },
          club ? h('img', { attrs: { src: crestDataUrl(club), alt: '', draggable: 'false' } }) : null,
          h('div', { class: 'mset-team-text' },
            h('span', { class: 'mset-code', text: club ? club.code : side === 0 ? 'HOME' : 'AWAY' }),
            h('span', { class: 'mset-name', text: club ? club.name : '' }),
            whoPlays(config, side)),
        );
      };
      const fixture = h('section', { class: 'mset-fixture', testId: 'mset-fixture', attrs: { 'aria-label': 'Fixture' } }, team(0), h('span', { class: 'mset-vs', text: 'v' }), team(1));

      // ---- controls (rows in reading order: left column, then right column)
      const left = h('div', { class: 'mset-col' });
      const right = h('div', { class: 'mset-col' });
      const rows: HTMLElement[] = [];
      const addRow = (col: HTMLElement, el: HTMLElement): void => {
        rows.push(el);
        col.append(el);
      };
      if (hasCpuSide(config)) {
        addRow(left, createSelector('Difficulty', DIFFICULTY_OPTIONS.map((o) => ({ value: o.value, label: o.label })), opts.difficulty, (v) => {
          opts.difficulty = v;
        }, { testId: 'mset-difficulty', ctx, hint: 'How good the CPU is' }).el);
      }
      if (!shootout) {
        addRow(left, createSlider('Half length', opts.halfMinutes, (v) => {
          opts.halfMinutes = v;
        }, { min: HALF_MIN, max: HALF_MAX, step: 1, testId: 'mset-half', ctx, format: (v) => `${v} min` }).el);
        addRow(left, createSegmented('Rules', [
          { value: 'friendly', label: 'Friendly', testId: 'mset-rules-friendly' },
          { value: 'cup', label: 'Cup', testId: 'mset-rules-cup' },
        ], opts.cupRules ? 'cup' : 'friendly', (v) => {
          opts.cupRules = v === 'cup';
        }, { testId: 'mset-rules', ctx }).el);
        left.append(h('p', { class: 'mset-note', text: 'Cup: extra time, then penalties if still level.' }));
      }
      addRow(left, createSegmented('Time of day', [
        { value: 'day', label: 'Day', testId: 'mset-day' },
        { value: 'night', label: 'Night', testId: 'mset-night' },
      ], opts.night ? 'night' : 'day', (v) => {
        opts.night = v === 'night';
      }, { testId: 'mset-time', ctx }).el);
      if (!shootout) {
        addRow(right, createToggle('Offside', opts.offside, (v) => {
          opts.offside = v;
        }, { testId: 'mset-offside', ctx }).el);
        addRow(right, createToggle('Fouls and cards', opts.fouls, (v) => {
          opts.fouls = v;
        }, { testId: 'mset-fouls', ctx }).el);
        addRow(right, createToggle('Goal replays', opts.replays, (v) => {
          opts.replays = v;
        }, { testId: 'mset-replays', ctx }).el);
      }
      addRow(right, createSegmented('Camera', CAMERA_OPTIONS.map((o) => ({ value: o.value, label: o.label, testId: `mset-camera-${o.value}` })), opts.camera, (v) => {
        opts.camera = v;
      }, { testId: 'mset-camera', ctx }).el);

      // ---- start
      let started = false;
      const start = (): void => {
        if (started) return;
        started = true;
        const setup = startSetup(ctx, flow.setup, opts, mode);
        try {
          ctx.settings.update((s) => persistOptions(s, opts, setup.config, mode));
          if (!shootout) ctx.settings.saveProgress(CUP_RULES_KEY, opts.cupRules);
        } catch {
          /* storage problems never block a match */
        }
        rememberFlowMode(mode);
        // Inside the tap: (re)unlock audio; a controller confirm is not a gesture and the engine retries later.
        ctx.audio.unlock().catch(() => undefined);
        ctx.session.start(setup);
      };
      const startBtn = createButton(shootout ? 'Start shoot-out' : 'Kick off', start, {
        testId: 'settings-start', variant: 'primary', ctx, sound: UiSound.START, autofocus: true,
      });

      // Controller / keyboard: Up / Down walk the rows in reading order (left column, then right column), since
      // Left / Right belong to the controls (adjust a value, move along a segmented row). Start sits above row 1.
      const nav = ctx.focus as unknown as { current?: HTMLElement | null; ringVisible?: boolean };
      const target = (row: HTMLElement): HTMLElement =>
        row.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? row.querySelector<HTMLElement>('[data-focus]') ?? row;
      const offAction = ctx.focus.onAction((a) => {
        if ((a !== MenuAction.UP && a !== MenuAction.DOWN) || nav.ringVisible !== true) return false;
        const cur = nav.current;
        if (!cur || !root.contains(cur)) return false;
        const i = rows.findIndex((r) => r === cur || r.contains(cur));
        let next: HTMLElement | null;
        if (i < 0) {
          if (cur !== startBtn || a !== MenuAction.DOWN || rows.length === 0) return false;
          next = target(rows[0]!);
        } else if (a === MenuAction.DOWN) {
          next = i + 1 < rows.length ? target(rows[i + 1]!) : null;
        } else {
          next = i > 0 ? target(rows[i - 1]!) : startBtn;
        }
        if (next) ctx.focus.focus(next);
        return true;
      });
      cleanup = offAction;

      root.append(
        createFlowTop({
          ctx, title: 'Match settings', eyebrow: MODE_LABELS[mode], testId: 'match-settings-title',
          steps: createStepDots(mode, 'match-settings'), actions: [startBtn],
        }),
        fixture,
        h('div', { class: 'mset-grid' }, left, right),
      );
    },
    unmount() {
      cleanup?.();
      cleanup = null;
      detachDots?.();
      detachDots = null;
    },
    onFrame(frame) {
      if (detachDots) sharedDotField().frame(frame.nowMs);
    },
  };
}
