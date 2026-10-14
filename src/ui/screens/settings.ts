/**
 * [UIX-09] Settings (BRIEF §12 "Settings: Controls, Camera, Match defaults, Audio, Graphics (Auto, Performance,
 * Balanced, Quality; FPS counter; resolution scale), Accessibility (high-contrast kits, larger HUD, reduced camera
 * motion, colour-blind-safe markers), Data reset, and Diagnostics"; contracts/settings.ts).
 *
 * Tabs (tap, or L1 / R1 = Q / E anywhere): Controls (assistance, auto-switch, touch options, skill slots, the touch
 * layout editor 'controls-editor', controller button glyphs, rumble, remap 'remap', tutorial), Camera (type, height
 * and zoom 0-20), Match (the defaults new matches start from), Audio (master, crowd, effects, menus), Graphics
 * (quality tier, FPS counter, automatic or fixed resolution scale), Accessibility (four toggles), Data (storage
 * status, reset with a confirmation: clears settings and progress) and Diagnostics (version, link to 'diagnostics').
 *
 * Every control writes ctx.settings at once (live apply: the renderer and audio follow the store; the store saves,
 * debounced, and survives a reload). A change made elsewhere (reset, another screen) rebuilds the open tab; this
 * screen's own changes do not (a slider keeps its drag). params.tab opens a tab (the pause menu opens 'controls');
 * otherwise the last tab used in this page session. The dot field runs behind the menu only outside a match (a
 * paused match opens settings from its pause menu).
 *
 * Touch: tap tabs and controls. Controller / keyboard: Up / Down move, Left / Right change the focused value, L1 / R1
 * switch tabs, Confirm activates, Back leaves (or closes the reset dialog).
 */
import type { AppContext, Screen, ScreenParams } from '../../contracts/app';
import { GAME_NAME, GAME_VERSION } from '../../contracts/constants';
import {
  AssistLevel, AutoSwitch, CameraType, Difficulty, FormationId, PadFamily, QualityTier, SkillMove,
} from '../../contracts/enums';
import type { Settings } from '../../contracts/settings';
import { T_PERF } from '../../contracts/tuning';
import { FORMATIONS } from '../../data/formations';
import {
  closeTopModal, createBackButton, createButton, createSection, createSegmented, createSelector, createSlider, createTabs,
  createToggle, h, injectStyle, openModal, showToast,
} from '../components';
import { attachDotField, sharedDotField } from '../dotfield';

export type SettingsTab = 'controls' | 'camera' | 'match' | 'audio' | 'graphics' | 'access' | 'data' | 'diagnostics';

export const SETTINGS_TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: 'controls', label: 'Controls' },
  { id: 'camera', label: 'Camera' },
  { id: 'match', label: 'Match' },
  { id: 'audio', label: 'Audio' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'access', label: 'Accessibility' },
  { id: 'data', label: 'Data' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

export function isSettingsTab(v: unknown): v is SettingsTab {
  return typeof v === 'string' && SETTINGS_TABS.some((t) => t.id === v);
}

export const ASSIST_OPTIONS = [
  { value: AssistLevel.ASSISTED, label: 'Assisted', testId: 'set-assist-0' },
  { value: AssistLevel.SEMI, label: 'Semi', testId: 'set-assist-1' },
  { value: AssistLevel.MANUAL, label: 'Manual', testId: 'set-assist-2' },
] as const;

export const AUTO_SWITCH_OPTIONS = [
  { value: AutoSwitch.OFF, label: 'Off' },
  { value: AutoSwitch.AIR_AND_LOOSE, label: 'Air and loose balls' },
  { value: AutoSwitch.AUTO, label: 'Automatic' },
] as const;

export const PAD_FAMILY_OPTIONS = [
  { value: PadFamily.AUTO, label: 'Automatic' },
  { value: PadFamily.PLAYSTATION, label: 'PlayStation' },
  { value: PadFamily.XBOX, label: 'Xbox' },
  { value: PadFamily.SWITCH, label: 'Switch' },
  { value: PadFamily.GENERIC, label: 'Generic' },
] as const;

export const SKILL_OPTIONS = [
  { value: SkillMove.NONE, label: 'None' },
  { value: SkillMove.BALL_ROLL, label: 'Ball roll' },
  { value: SkillMove.STEP_OVER, label: 'Step over' },
  { value: SkillMove.BODY_FEINT, label: 'Body feint' },
  { value: SkillMove.DRAG_BACK, label: 'Drag back' },
  { value: SkillMove.FAKE_SHOT, label: 'Fake shot' },
  { value: SkillMove.ROULETTE, label: 'Roulette' },
  { value: SkillMove.HEEL_FLICK, label: 'Heel flick' },
  { value: SkillMove.KNOCK_ON, label: 'Knock on' },
] as const;

export const CAMERA_TYPE_OPTIONS = [
  { value: CameraType.BROADCAST, label: 'Broadcast' },
  { value: CameraType.WIDE, label: 'Wide' },
  { value: CameraType.CLOSE, label: 'Close' },
  { value: CameraType.END_TO_END, label: 'End to end' },
] as const;

export const DIFFICULTY_LABELS = [
  { value: Difficulty.BEGINNER, label: 'Beginner' },
  { value: Difficulty.AMATEUR, label: 'Amateur' },
  { value: Difficulty.SEMI_PRO, label: 'Semi-Pro' },
  { value: Difficulty.PROFESSIONAL, label: 'Professional' },
  { value: Difficulty.WORLD_CLASS, label: 'World Class' },
  { value: Difficulty.LEGEND, label: 'Legend' },
] as const;

export const QUALITY_OPTIONS = [
  { value: QualityTier.AUTO, label: 'Auto', testId: 'set-gfx-tier-0' },
  { value: QualityTier.PERFORMANCE, label: 'Performance', testId: 'set-gfx-tier-1' },
  { value: QualityTier.BALANCED, label: 'Balanced', testId: 'set-gfx-tier-2' },
  { value: QualityTier.QUALITY, label: 'Quality', testId: 'set-gfx-tier-3' },
] as const;

/** Fixed resolution scale range (0 = automatic dynamic resolution). */
export const RES_SCALE_MIN: number = T_PERF.resScaleMin;
export const RES_SCALE_MAX: number = T_PERF.resScaleMax;

/** Fixed scale to use when automatic resolution is switched off: the last fixed value, else full resolution. Pure. */
export function fixedScaleFor(current: number, lastFixed: number): number {
  const pick = current > 0 ? current : lastFixed > 0 ? lastFixed : RES_SCALE_MAX;
  return pick < RES_SCALE_MIN ? RES_SCALE_MIN : pick > RES_SCALE_MAX ? RES_SCALE_MAX : pick;
}

/** After picking `club` for one side, the other side's club (moved to the next club when both would match). Pure. */
export function distinctOther(club: number, other: number, clubCount: number): number {
  if (clubCount < 2 || other !== club) return other;
  return (club + 1) % clubCount;
}

/** Percent label for a 0..1 value. */
export function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/**
 * Sections into two columns (each section goes to the column with fewer controls so far, in order), so a tall section
 * never leaves a hole beside a short one. Narrow screens stack the columns (CSS). Pure DOM helper.
 */
function intoColumns(sections: readonly Node[]): HTMLElement[] {
  const cols = [h('div', { class: 'set-col' }), h('div', { class: 'set-col' })];
  const load = [0, 0];
  for (const sec of sections) {
    const n = sec instanceof HTMLElement ? Math.max(1, sec.querySelectorAll('[data-focus], .set-note, .set-version').length) : 1;
    const i = load[1]! < load[0]! ? 1 : 0;
    cols[i]!.append(sec);
    load[i]! += n;
  }
  return load[1] === 0 ? [cols[0]!] : cols;
}

let lastTab: SettingsTab = 'controls';
let lastFixedScale: number = RES_SCALE_MAX;

const CSS = `
.screen--settings { justify-content:flex-start; align-items:center; }
.set-wrap { width: min(1080px, 100%); flex: 1 1 auto; min-height:0; display:flex; flex-direction:column; gap: var(--space-4); }
.set-top { display:flex; align-items:center; gap: var(--space-5); flex-wrap:wrap; }
.screen--settings .set-top .ui-back { position:static; }
.set-title { margin:0; font-size: var(--fs-xl); font-weight: var(--fw-bold); line-height: var(--lh-tight); flex: 1 1 auto; }
.set-store { margin:0; font: var(--fw-num) var(--fs-xs) / 1.3 var(--font-num); color: var(--text-3); }
.set-body { flex: 1 1 auto; min-height:0; overflow-y:auto; display:grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-5) var(--space-6); align-items:start; align-content:start; padding: 2px 2px var(--space-6); }
.set-col { display:flex; flex-direction:column; gap: var(--space-6); min-width:0; }
.set-col:only-child { grid-column: 1 / -1; width: min(640px, 100%); }
.screen--settings .tab { padding: 0 var(--space-4); }
.screen--settings .seg__opt { font-size: var(--fs-sm); padding-left: var(--space-2); padding-right: var(--space-2); white-space:nowrap; min-width:0; }
.set-body .ui-section { gap: var(--space-3); }
.set-body .ctl, .set-body .seg { width:100%; }
.set-body .btn { width:100%; justify-content:flex-start; text-align:left; }
.set-note { margin:0; font-size: var(--fs-sm); color: var(--text-3); line-height: var(--lh); }
.set-version { margin:0; font: var(--fw-num-bold) var(--fs-lg) / 1.2 var(--font-num); font-variant-numeric: tabular-nums; }
@media (max-width: 860px) { .set-body { grid-template-columns: minmax(0, 1fr); } }
@media (max-height: 600px) { .set-wrap { gap: var(--space-3); } .set-title { font-size: var(--fs-lg); } }
`;

export function createSettingsScreen(): Screen {
  let ctx: AppContext | null = null;
  let body: HTMLElement | null = null;
  let storeLine: HTMLElement | null = null;
  let tab: SettingsTab = lastTab;
  let selfUpdate = false;
  let unsub: (() => void) | null = null;
  let detachField: (() => void) | null = null;

  /** Write the store (live apply + persist) without rebuilding this screen. */
  function set(mut: (s: Settings) => void): void {
    const c = ctx;
    if (!c) return;
    selfUpdate = true;
    try {
      c.settings.update(mut);
    } finally {
      selfUpdate = false;
    }
  }

  function storeText(c: AppContext): string {
    return c.settings.persistent ? 'Saved on this device' : 'Storage unavailable: changes last until the page closes';
  }

  function buildTab(): Node[] {
    const c = ctx!;
    const s = c.settings.get();
    switch (tab) {
      case 'controls': return controlsTab(c, s);
      case 'camera': return cameraTab(c, s);
      case 'match': return matchTab(c, s);
      case 'audio': return audioTab(c, s);
      case 'graphics': return graphicsTab(c, s);
      case 'access': return accessTab(c, s);
      case 'data': return dataTab(c);
      default: return diagnosticsTab(c);
    }
  }

  function rebuild(focusFirst: boolean): void {
    const c = ctx;
    if (!c || !body) return;
    const prev = body.querySelector<HTMLElement>('[data-focused]')?.dataset.testid ?? null;
    body.dataset.tab = tab;
    body.replaceChildren(...intoColumns(buildTab()));
    if (storeLine) storeLine.textContent = storeText(c);
    const target =
      (!focusFirst && prev ? body.querySelector<HTMLElement>(`[data-testid="${prev}"]`) : null) ??
      (focusFirst ? body.querySelector<HTMLElement>('[data-focus]') : null);
    if (target) {
      try {
        c.focus.focus(target);
      } catch {
        /* navigator not ready */
      }
    }
  }

  // ------------------------------------------------------------ tabs

  function controlsTab(c: AppContext, s: Readonly<Settings>): Node[] {
    const t = s.controls.touch;
    const play = createSection(
      'Play',
      createSegmented('Assistance', ASSIST_OPTIONS, s.controls.assist, (v) => set((m) => {
        m.controls.assist = v;
      }), { ctx: c, testId: 'set-assist' }).el,
      createSelector('Auto-switch', AUTO_SWITCH_OPTIONS, s.controls.autoSwitch, (v) => set((m) => {
        m.controls.autoSwitch = v;
      }), { ctx: c, testId: 'set-autoswitch', hint: 'Which player you control when the ball changes hands' }).el,
      h('p', { class: 'set-note', text: 'Assistance and auto-switch apply from the next match.' }),
    );
    const touch = createSection(
      'Touch',
      createButton('Touch controls layout', () => c.router.go('controls-editor'), {
        testId: 'settings-controls-editor', hint: 'Move, resize and space the touch buttons', ctx: c,
      }),
      createSlider('Control opacity', t.opacity, (v) => set((m) => {
        m.controls.touch.opacity = v;
      }), { min: 0.2, max: 1, step: 0.05, format: pct, ctx: c, testId: 'set-touch-opacity' }).el,
      createToggle('Floating stick', t.floatingStick, (v) => set((m) => {
        m.controls.touch.floatingStick = v;
      }), { ctx: c, testId: 'set-touch-floating', hint: 'The stick appears where your thumb lands' }).el,
      createToggle('Left-handed (mirror)', t.mirror, (v) => set((m) => {
        m.controls.touch.mirror = v;
      }), { ctx: c, testId: 'set-touch-mirror' }).el,
      createToggle('Pitch gestures', t.gestures, (v) => set((m) => {
        m.controls.touch.gestures = v;
      }), { ctx: c, testId: 'set-touch-gestures', hint: 'Tap, swipe and double-tap the pitch' }).el,
      createToggle('Gestures only', t.gesturesOnly, (v) => set((m) => {
        m.controls.touch.gesturesOnly = v;
      }), { ctx: c, testId: 'set-touch-gestures-only', hint: 'Hides Pass, Through and Shoot' }).el,
      createToggle('Fast power bar', t.fastPowerBar, (v) => set((m) => {
        m.controls.touch.fastPowerBar = v;
      }), { ctx: c, testId: 'set-touch-fastpower' }).el,
      createSelector('Skill: tap', SKILL_OPTIONS, t.skillTap, (v) => set((m) => {
        m.controls.touch.skillTap = v;
      }), { ctx: c, testId: 'set-skill-tap' }).el,
      createSelector('Skill: swipe up', SKILL_OPTIONS, t.skillUp, (v) => set((m) => {
        m.controls.touch.skillUp = v;
      }), { ctx: c, testId: 'set-skill-up' }).el,
      createSelector('Skill: swipe right', SKILL_OPTIONS, t.skillRight, (v) => set((m) => {
        m.controls.touch.skillRight = v;
      }), { ctx: c, testId: 'set-skill-right' }).el,
    );
    const pad = createSection(
      'Controller',
      createSelector('Button glyphs', PAD_FAMILY_OPTIONS, s.controls.pad.familyOverride, (v) => set((m) => {
        m.controls.pad.familyOverride = v;
      }), { ctx: c, testId: 'set-pad-family' }).el,
      createToggle('Rumble', s.controls.pad.rumble, (v) => set((m) => {
        m.controls.pad.rumble = v;
      }), { ctx: c, testId: 'set-pad-rumble' }).el,
      createButton('Controller remap', () => c.router.go('remap'), {
        testId: 'settings-remap', hint: 'For controllers without the standard layout', ctx: c,
      }),
      createButton('Tutorial', () => c.router.go('tutorial'), { testId: 'settings-tutorial', hint: 'Learn the controls step by step', ctx: c }),
    );
    return [play, touch, pad];
  }

  function cameraTab(c: AppContext, s: Readonly<Settings>): Node[] {
    return [
      createSection(
        'Camera',
        createSelector('Camera', CAMERA_TYPE_OPTIONS, s.camera.type, (v) => set((m) => {
          m.camera.type = v;
        }), { ctx: c, testId: 'set-camera-type' }).el,
        createSlider('Height', s.camera.height, (v) => set((m) => {
          m.camera.height = v;
        }), { min: 0, max: 20, step: 1, ctx: c, testId: 'set-camera-height' }).el,
        createSlider('Zoom', s.camera.zoom, (v) => set((m) => {
          m.camera.zoom = v;
        }), { min: 0, max: 20, step: 1, ctx: c, testId: 'set-camera-zoom' }).el,
        h('p', { class: 'set-note', text: 'Reduced camera motion is under Accessibility.' }),
      ),
    ];
  }

  function matchTab(c: AppContext, s: Readonly<Settings>): Node[] {
    const m0 = s.match;
    const clubs = c.clubs.map((cl, i) => ({ value: i, label: `${cl.code}  ${cl.name}` }));
    const rules = createSection(
      'Rules',
      createSlider('Half length', m0.halfMinutes, (v) => set((m) => {
        m.match.halfMinutes = v;
      }), { min: 2, max: 10, step: 1, format: (v) => `${v} min`, ctx: c, testId: 'set-match-half' }).el,
      createSelector('Difficulty', DIFFICULTY_LABELS, m0.difficulty, (v) => set((m) => {
        m.match.difficulty = v;
      }), { ctx: c, testId: 'set-match-difficulty', wrap: false }).el,
      createToggle('Offside', m0.offside, (v) => set((m) => {
        m.match.offside = v;
      }), { ctx: c, testId: 'set-match-offside' }).el,
      createToggle('Fouls and cards', m0.fouls, (v) => set((m) => {
        m.match.fouls = v;
      }), { ctx: c, testId: 'set-match-fouls' }).el,
      createToggle('Goal replays', m0.replays, (v) => set((m) => {
        m.match.replays = v;
      }), { ctx: c, testId: 'set-match-replays' }).el,
    );
    const teams = createSection(
      'Teams',
      createSegmented('Time of day', [
        { value: 0, label: 'Day', testId: 'set-match-night-0' },
        { value: 1, label: 'Night', testId: 'set-match-night-1' },
      ], m0.night ? 1 : 0, (v) => set((m) => {
        m.match.night = v === 1;
      }), { ctx: c, testId: 'set-match-night' }).el,
      clubs.length > 0
        ? createSelector('Home team', clubs, m0.homeClub, (v) => {
          set((m) => {
            m.match.homeClub = v;
            m.match.awayClub = distinctOther(v, m.match.awayClub, clubs.length);
          });
          if (ctx && ctx.settings.get().match.awayClub !== m0.awayClub) rebuild(false);
        }, { ctx: c, testId: 'set-match-home' }).el
        : null,
      clubs.length > 0
        ? createSelector('Away team', clubs, m0.awayClub, (v) => {
          set((m) => {
            m.match.awayClub = v;
            m.match.homeClub = distinctOther(v, m.match.homeClub, clubs.length);
          });
          if (ctx && ctx.settings.get().match.homeClub !== m0.homeClub) rebuild(false);
        }, { ctx: c, testId: 'set-match-away' }).el
        : null,
      createSelector('Your formation', FORMATIONS.map((f) => ({ value: f.id, label: f.name })), m0.homeFormation, (v) => set((m) => {
        m.match.homeFormation = v as FormationId;
      }), { ctx: c, testId: 'set-match-formation' }).el,
      h('p', { class: 'set-note', text: 'New matches start from these choices; team select can still change them.' }),
    );
    return [rules, teams];
  }

  function audioTab(c: AppContext, s: Readonly<Settings>): Node[] {
    const vol = (label: string, key: 'master' | 'crowd' | 'effects' | 'menus'): HTMLElement =>
      createSlider(label, s.audio[key], (v) => set((m) => {
        m.audio[key] = v;
      }), { min: 0, max: 1, step: 0.05, format: pct, ctx: c, testId: `set-vol-${key}` }).el;
    return [createSection('Volume', vol('Master', 'master'), vol('Crowd', 'crowd'), vol('Effects', 'effects'), vol('Menus', 'menus'))];
  }

  function graphicsTab(c: AppContext, s: Readonly<Settings>): Node[] {
    const g = s.graphics;
    if (g.resolutionScale > 0) lastFixedScale = g.resolutionScale;
    const auto = g.resolutionScale === 0;
    const slider = createSlider('Resolution scale', fixedScaleFor(g.resolutionScale, lastFixedScale), (v) => {
      lastFixedScale = v;
      set((m) => {
        m.graphics.resolutionScale = v;
      });
    }, { min: RES_SCALE_MIN, max: RES_SCALE_MAX, step: 0.05, format: pct, ctx: c, testId: 'set-gfx-res', disabled: auto });
    const autoToggle = createToggle('Automatic resolution', auto, (v) => {
      set((m) => {
        m.graphics.resolutionScale = v ? 0 : fixedScaleFor(0, lastFixedScale);
      });
      if (v) slider.el.setAttribute('aria-disabled', 'true');
      else slider.el.removeAttribute('aria-disabled');
    }, { ctx: c, testId: 'set-gfx-res-auto', hint: 'Lowers the resolution to hold 60 fps' });
    return [
      createSection(
        'Quality',
        createSegmented('', QUALITY_OPTIONS, g.tier, (v) => set((m) => {
          m.graphics.tier = v;
        }), { ctx: c, testId: 'set-gfx-tier', ariaLabel: 'Quality' }).el,
        h('p', { class: 'set-note', text: 'Auto picks a level for this device and steps down when frames run late.' }),
        createToggle('FPS counter', g.showFps, (v) => set((m) => {
          m.graphics.showFps = v;
        }), { ctx: c, testId: 'set-gfx-fps' }).el,
      ),
      createSection('Resolution', autoToggle.el, slider.el),
    ];
  }

  function accessTab(c: AppContext, s: Readonly<Settings>): Node[] {
    const a = s.accessibility;
    return [
      createSection(
        'Accessibility',
        createToggle('High-contrast kits', a.highContrastKits, (v) => set((m) => {
          m.accessibility.highContrastKits = v;
        }), { ctx: c, testId: 'set-a11y-contrast', hint: 'Kits in strongly contrasting colours' }).el,
        createToggle('Larger HUD', a.largerHud, (v) => set((m) => {
          m.accessibility.largerHud = v;
        }), { ctx: c, testId: 'set-a11y-hud' }).el,
        createToggle('Reduced camera motion', a.reducedCameraMotion, (v) => set((m) => {
          m.accessibility.reducedCameraMotion = v;
        }), { ctx: c, testId: 'set-a11y-motion', hint: 'Calmer camera, no shake' }).el,
        createToggle('Colour-blind-safe markers', a.colourBlindMarkers, (v) => set((m) => {
          m.accessibility.colourBlindMarkers = v;
        }), { ctx: c, testId: 'set-a11y-markers', hint: 'Player markers by shape as well as colour' }).el,
      ),
    ];
  }

  function dataTab(c: AppContext): Node[] {
    return [
      createSection(
        'Data',
        h('p', { class: 'set-note', text: storeText(c), testId: 'settings-storage' }),
        createButton('Reset all data', () => confirmReset(c), {
          testId: 'settings-reset', variant: 'danger', hint: 'Settings, cup progress, records and tutorial progress', ctx: c,
        }),
      ),
    ];
  }

  function diagnosticsTab(c: AppContext): Node[] {
    return [
      createSection(
        'Diagnostics',
        h('p', { class: 'set-version', text: `${GAME_NAME} ${GAME_VERSION}`, testId: 'settings-version' }),
        createButton('Open diagnostics', () => c.router.go('diagnostics'), {
          testId: 'settings-diagnostics', hint: 'Benchmark, input tester, replay save and load, report', ctx: c,
        }),
      ),
    ];
  }

  function confirmReset(c: AppContext): void {
    openModal(c, {
      title: 'Reset all data?',
      body: 'Every setting goes back to its default and cup progress, records and tutorial progress are deleted. This cannot be undone.',
      testId: 'settings-reset-dialog',
      actions: [
        { label: 'Reset', variant: 'danger', testId: 'settings-reset-confirm', onSelect: () => {
          if (!ctx) return;
          ctx.settings.reset();
          ctx.settings.clearProgress();
          lastFixedScale = RES_SCALE_MAX;
          rebuild(false);
          showToast('Settings and progress cleared', { kind: 'success', testId: 'settings-reset-toast' });
        } },
        { label: 'Cancel', primary: true, testId: 'settings-reset-cancel' },
      ],
      onClose: () => {
        // Focus returns to the Reset button (the dialog remembers it); after a reset the tab was rebuilt.
        const b = body?.querySelector<HTMLElement>('[data-testid="settings-reset"]');
        if (b && ctx) {
          try {
            ctx.focus.focus(b);
          } catch {
            /* ignore */
          }
        }
      },
    });
  }

  return {
    id: 'settings',
    mount(root: HTMLElement, c: AppContext, params: ScreenParams) {
      injectStyle('settings', CSS);
      ctx = c;
      tab = isSettingsTab(params?.tab) ? params.tab : lastTab;
      root.classList.add('screen--settings');
      if (!c.session.active) detachField = attachDotField(root);
      const tabs = createTabs(
        SETTINGS_TABS.map((t) => ({ id: t.id, label: t.label, testId: `settings-tab-${t.id}` })),
        tab,
        (id) => {
          if (!isSettingsTab(id)) return;
          const fromBar = !!document.activeElement && tabs.el.contains(document.activeElement);
          tab = id;
          lastTab = id;
          rebuild(!fromBar && !tabs.el.querySelector('[data-focused]'));
        },
        { ctx: c, ariaLabel: 'Settings sections', testId: 'settings-tabs' },
      );
      body = h('div', { class: 'set-body', testId: 'settings-body', attrs: { role: 'tabpanel', 'data-focus-group': 'none' } });
      storeLine = h('p', { class: 'set-store', text: storeText(c) });
      root.append(
        h(
          'div',
          { class: 'set-wrap' },
          h('div', { class: 'set-top' }, createBackButton(c), h('h1', { class: 'set-title', text: 'Settings', testId: 'settings-title' }), storeLine),
          tabs.el,
          body,
        ),
      );
      rebuild(false);
      const first = tabs.el.querySelector<HTMLElement>('[aria-selected="true"]');
      if (first) first.dataset.focusDefault = '';
      unsub = c.settings.subscribe(() => {
        if (!selfUpdate) rebuild(false);
      });
    },
    unmount() {
      unsub?.();
      unsub = null;
      detachField?.();
      detachField = null;
      ctx = null;
      body = null;
      storeLine = null;
    },
    onBack() {
      return closeTopModal();
    },
    onFrame(frame) {
      if (detachField) sharedDotField().frame(frame.nowMs);
    },
  };
}
