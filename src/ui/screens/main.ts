/**
 * [UIX-02] Main menu (BRIEF §12 Screens, §11 Modes, §1 "be in a match within a minute").
 *
 * Layout (original): a top bar with the wordmark on the left and Settings plus a small Diagnostics entry on the right;
 * below it a Quick match card on the left (the primary action: starts a match against the CPU with the saved match
 * defaults, so splash tap + Play now = a match in two taps) and the numbered list of modes on the right. The dot
 * field (UIX-01) runs behind it.
 *
 * Routes (MAIN_MODE_ENTRIES / MAIN_UTILITY_ENTRIES):
 *   Play now (quick match)  -> ctx.session.start(defaultSetup(ctx))           [data-testid main-kickoff]
 *   Kick-Off                -> 'mode-setup' { mode: ModeId.KICK_OFF }          [main-mode-kickoff]
 *   Play a Friend           -> 'mode-setup' { mode: ModeId.FRIEND_LOCAL }      [main-friend] (Same iPad / Online there)
 *   Cup                     -> 'cup'                                           [main-cup]
 *   Shoot-out               -> 'mode-setup' { mode: ModeId.SHOOT_OUT }         [main-shootout]
 *   Practice                -> 'practice'                                      [main-practice]
 *   Settings                -> 'settings'                                      [main-settings]
 *   Diagnostics             -> 'diagnostics'                                   [main-diagnostics]
 * Back returns here from each (router history); the main menu is the root, so Back on it does nothing.
 *
 * Focus (controller / keyboard): Play now has the initial focus; coming back from a screen, the entry that opened
 * it has it instead. The mode list is a vertical focus group that wraps; Right or Down from Play now enters the list
 * at its first mode (Kick-Off), Left from any mode returns to Play now; Up from Play now goes to Settings in the top
 * bar, Down from the top bar comes back into the content.
 */
import type { AppContext, FrameInfo, Screen, ScreenId, ScreenParams } from '../../contracts/app';
import { MenuAction } from '../../contracts/app';
import { GAME_NAME, GAME_VERSION } from '../../contracts/constants';
import type { Club } from '../../contracts/data';
import { Difficulty, KitSlot, ModeId } from '../../contracts/enums';
import type { Settings } from '../../contracts/settings';
import { defaultSetup } from '../../modes/setup';
import { resolveKits } from '../../render/kits';
import { createButton, h, injectStyle } from '../components';
import { attachDotField, sharedDotField } from '../dotfield';

/** One main menu entry that opens a screen. */
export interface MainMenuEntry {
  readonly testId: string;
  readonly label: string;
  /** One line under the label (mode entries). */
  readonly detail: string;
  readonly route: ScreenId;
  /** Route params (copied for every navigation, never shared). */
  readonly params?: Readonly<ScreenParams>;
}

/** data-testid of the Quick match card (kept from Wave 0: every e2e spec that starts a match taps it). */
export const QUICK_PLAY_TEST_ID = 'main-kickoff';

/** The five modes of BRIEF §11, in menu order. mode-setup reads params.mode (ModeId). */
export const MAIN_MODE_ENTRIES: readonly MainMenuEntry[] = [
  {
    testId: 'main-mode-kickoff', label: 'Kick-Off', detail: 'Your teams and rules, against the CPU.',
    route: 'mode-setup', params: { mode: ModeId.KICK_OFF },
  },
  {
    testId: 'main-friend', label: 'Play a Friend', detail: '1v1 on this iPad, or online with a room code.',
    route: 'mode-setup', params: { mode: ModeId.FRIEND_LOCAL },
  },
  { testId: 'main-cup', label: 'Cup', detail: '8 or 16 team knockout. Progress saves.', route: 'cup' },
  {
    testId: 'main-shootout', label: 'Shoot-out', detail: 'Straight to penalties.',
    route: 'mode-setup', params: { mode: ModeId.SHOOT_OUT },
  },
  { testId: 'main-practice', label: 'Practice', detail: 'Free play, set pieces and a guided tutorial.', route: 'practice' },
];

/** Top-bar entries. */
export const MAIN_UTILITY_ENTRIES: readonly MainMenuEntry[] = [
  { testId: 'main-settings', label: 'Settings', detail: '', route: 'settings' },
  { testId: 'main-diagnostics', label: 'Diagnostics', detail: '', route: 'diagnostics' },
];

export const DIFFICULTY_LABELS: Readonly<Record<Difficulty, string>> = {
  [Difficulty.BEGINNER]: 'Beginner',
  [Difficulty.AMATEUR]: 'Amateur',
  [Difficulty.SEMI_PRO]: 'Semi-Pro',
  [Difficulty.PROFESSIONAL]: 'Professional',
  [Difficulty.WORLD_CLASS]: 'World Class',
  [Difficulty.LEGEND]: 'Legend',
};

/** One side of the quick match. */
export interface QuickPlayTeam {
  code: string;
  name: string;
  /** Shirt colour of the kit it will wear, CSS hex. */
  color: string;
}

/** What Play now will start (from settings.match; the same values defaultSetup uses). */
export interface QuickPlaySummary {
  home: QuickPlayTeam;
  away: QuickPlayTeam;
  halfMinutes: number;
  difficulty: string;
  night: boolean;
  /** "Professional · 2 × 4 min · Day" */
  line: string;
}

/** 0xRRGGBB -> '#rrggbb' (invalid input -> a neutral grey). */
export function rgbToCss(rgb: number): string {
  if (!Number.isFinite(rgb)) return '#8a8a94';
  const v = Math.max(0, Math.min(0xffffff, Math.round(rgb)));
  return `#${v.toString(16).padStart(6, '0')}`;
}

function teamOf(clubs: readonly Club[], idx: number, kit: KitSlot, fallback: string, worn: number | null = null): QuickPlayTeam {
  const c = Number.isInteger(idx) && idx >= 0 ? clubs[idx] : undefined;
  if (!c) return { code: fallback.slice(0, 3).toUpperCase(), name: fallback, color: rgbToCss(NaN) };
  const k = kit === KitSlot.AWAY ? c.away : c.home;
  return { code: c.code, name: c.name, color: rgbToCss(worn ?? (k ? k.shirt : NaN)) };
}

/** [QF-12] Shirts the two clubs will wear for the saved kit slots (the GFX-08 clash check), or null. */
function wornPair(settings: Readonly<Settings>, clubs: readonly Club[]): [number, number] | null {
  const m = settings.match;
  const home = Number.isInteger(m.homeClub) && m.homeClub >= 0 ? clubs[m.homeClub] : undefined;
  const away = Number.isInteger(m.awayClub) && m.awayClub >= 0 ? clubs[m.awayClub] : undefined;
  if (!home || !away) return null;
  try {
    const k = resolveKits(home, away, m.homeKit, m.awayKit, settings.accessibility?.highContrastKits === true);
    return [k.outfield[0].shirt, k.outfield[1].shirt];
  } catch {
    return null;
  }
}

/** Clamp a half length the way modes/setup.ts configFromSettings does (2..10 whole minutes). */
export function clampHalfMinutes(m: number): number {
  if (!Number.isFinite(m)) return 4;
  return Math.max(2, Math.min(10, Math.round(m)));
}

export function quickPlaySummary(settings: Readonly<Settings>, clubs: readonly Club[]): QuickPlaySummary {
  const m = settings.match;
  const halfMinutes = clampHalfMinutes(m.halfMinutes);
  const difficulty = DIFFICULTY_LABELS[m.difficulty] ?? DIFFICULTY_LABELS[Difficulty.PROFESSIONAL];
  const night = m.night === true;
  const worn = wornPair(settings, clubs);
  return {
    home: teamOf(clubs, m.homeClub, m.homeKit, 'Home', worn ? worn[0] : null),
    away: teamOf(clubs, m.awayClub, m.awayKit, 'Away', worn ? worn[1] : null),
    halfMinutes,
    difficulty,
    night,
    line: `${difficulty} · 2 × ${halfMinutes} min · ${night ? 'Night' : 'Day'}`,
  };
}

/** The entry that opened the last screen, so coming back puts the focus where the player left it. */
let lastSelected: string | null = null;

/** Forget the remembered entry (tests; a new session of the app). */
export function resetMainMenuFocus(): void {
  lastSelected = null;
}

/** Which entry gets the initial focus on mount. */
export function initialFocusTestId(): string {
  const known = lastSelected !== null && (lastSelected === QUICK_PLAY_TEST_ID ||
    MAIN_MODE_ENTRIES.some((e) => e.testId === lastSelected) || MAIN_UTILITY_ENTRIES.some((e) => e.testId === lastSelected));
  return known ? lastSelected! : QUICK_PLAY_TEST_ID;
}

/**
 * Directional moves the geometry alone gets wrong (pure). From Play now (a tall card beside the mode list): Right and
 * Down enter the mode list at its first entry (geometry would pick the row level with, or below, the card's centre)
 * and Up goes to Settings in the top bar (geometry would pick a mode row above the card's centre). Returns the target
 * test id, or null to let the FocusNavigator move by geometry.
 */
export function menuFocusOverride(action: MenuAction, currentTestId: string | null | undefined): string | null {
  if (currentTestId !== QUICK_PLAY_TEST_ID) return null;
  if (action === MenuAction.RIGHT || action === MenuAction.DOWN) return MAIN_MODE_ENTRIES[0]!.testId;
  if (action === MenuAction.UP) return MAIN_UTILITY_ENTRIES[0]!.testId;
  return null;
}

const CSS = `
.screen--main { justify-content: center; align-items: stretch; }
.main-layout { width: 100%; max-width: 1180px; margin: 0 auto; display: grid; min-height: 0;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); grid-template-rows: auto auto;
  gap: var(--space-6) var(--space-7); overflow-y: auto; touch-action: pan-y; }
.main-top { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); }
.main-brand { display: flex; align-items: center; gap: var(--space-3); }
.main-dot { width: 22px; height: 22px; border-radius: 50%; background: var(--ember); box-shadow: 0 0 24px rgba(255, 107, 53, 0.35); }
.main-brand .ui-title { font-size: var(--fs-xl); letter-spacing: -0.01em; }
.main-utils { display: flex; align-items: center; gap: var(--space-3); }
.main-utils .btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); }
.main-utils svg { width: 20px; height: 20px; flex: none; }
.btn.main-diag { font-size: var(--fs-sm); font-weight: 500; color: var(--text-3); border-color: transparent; min-width: var(--target); padding: 0 var(--space-4); }
.main-version { font: 400 var(--fs-xs) / 1 var(--font-num); font-variant-numeric: tabular-nums; color: var(--text-3); }

.main-left { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
.btn.main-play { flex: 1 1 auto; display: flex; flex-direction: column; align-items: stretch; justify-content: space-between;
  gap: var(--space-5); text-align: left; white-space: normal; padding: var(--space-6); min-height: 240px; border-radius: var(--radius-lg);
  background: linear-gradient(160deg, var(--surface-2), var(--surface-1) 70%); border: 1px solid var(--hairline-strong);
  line-height: 1.2; }
.main-eyebrow { display: block; margin: 0; font: 600 var(--fs-xs) / 1 var(--font-ui); letter-spacing: 0.16em; text-transform: uppercase; color: var(--text-3); }
.main-fixture { flex: 1 1 auto; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center;
  gap: var(--space-4); }
.main-team { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); min-width: 0; }
.main-team--away { align-items: flex-end; text-align: right; }
.main-team-kit { width: 40px; height: 6px; border-radius: 3px; box-shadow: 0 0 0 1px var(--hairline-strong); }
.main-team-code { font: 600 48px / 1 var(--font-num); letter-spacing: 0.02em; color: var(--text-1); }
.main-team-name { font: 500 var(--fs-sm) / 1.3 var(--font-ui); color: var(--text-2); max-width: 100%; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.main-vs { font: 500 var(--fs-md) / 1 var(--font-ui); color: var(--text-3); }
.main-foot { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-4); }
.main-meta { font: 400 var(--fs-sm) / 1.3 var(--font-num); font-variant-numeric: tabular-nums; color: var(--text-2); }
.main-cta { align-self: flex-start; display: inline-flex; align-items: center; gap: var(--space-3); padding: 0 var(--space-5);
  min-height: 52px; border-radius: 999px; background: var(--ember); color: var(--text-on-ember); font: 700 var(--fs-md) / 1 var(--font-ui);
  letter-spacing: 0.02em; }
.main-cta svg { width: 16px; height: 16px; }

.main-right { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
.main-modes { display: flex; flex-direction: column; gap: var(--space-3); }
.btn.main-mode { display: grid; grid-template-columns: 36px minmax(0, 1fr) 16px; align-items: center; gap: var(--space-4);
  min-width: 0; min-height: 72px; padding: var(--space-3) var(--space-5); text-align: left; white-space: normal; line-height: 1.2;
  background: var(--surface-1); border: 1px solid var(--hairline); }
.main-mode-idx { font: 600 var(--fs-sm) / 1 var(--font-num); font-variant-numeric: tabular-nums; color: var(--text-3); }
.main-mode-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.main-mode-label { font: 600 var(--fs-md) / 1.2 var(--font-ui); color: var(--text-1); }
.main-mode-detail { font: 400 var(--fs-sm) / 1.3 var(--font-ui); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main-mode-chev { width: 9px; height: 9px; border-top: 2px solid var(--text-3); border-right: 2px solid var(--text-3); transform: rotate(45deg); }
[data-focus-visible] .btn.main-mode[data-focused] { background: var(--surface-2); }
[data-focus-visible] .btn.main-mode[data-focused] .main-mode-idx,
[data-focus-visible] .btn.main-mode[data-focused] .main-mode-chev { color: var(--ember); border-color: var(--ember); }
[data-focus-visible] .btn.main-play[data-focused] { border-color: var(--ember); }

@media (max-height: 640px) {
  .main-layout { gap: var(--space-4) var(--space-6); }
  .btn.main-mode { min-height: 60px; padding: var(--space-2) var(--space-4); }
  .main-mode-detail { display: none; }
  .main-modes { gap: var(--space-2); }
  .btn.main-play { min-height: 0; padding: var(--space-5); gap: var(--space-3); }
  .main-team-code { font-size: var(--fs-xl); }
}
@media (max-height: 480px) {
  /* 24 pt stay clear of the top corners and the bottom edge (system gestures, BRIEF section 3). */
  .screen--main { padding-top: calc(var(--safe-top, 0px) + var(--space-5)); padding-bottom: calc(var(--safe-bottom, 0px) + var(--space-5)); }
  .main-modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .btn.main-mode { grid-template-columns: minmax(0, 1fr); padding: var(--space-2) var(--space-3); text-align: center; }
  .main-mode-idx, .main-mode-chev { display: none; }
  .main-left > .main-eyebrow, .main-right > .main-eyebrow { display: none; }
  .main-team-name { display: none; }
  .main-brand .ui-title { font-size: var(--fs-lg); }
}
@media (max-width: 760px) {
  .main-layout { column-gap: var(--space-5); }
  .main-version { display: none; }
  .btn.main-play { padding: var(--space-5); }
  .main-team-code { font-size: var(--fs-lg); }
}
`;

const GEAR_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6' +
  'M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8"/></svg>';

const PLAY_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>';

function svgSpan(svg: string): HTMLSpanElement {
  const s = h('span', { attrs: { 'aria-hidden': 'true' } });
  s.innerHTML = svg;
  s.style.display = 'inline-flex';
  return s;
}

interface NavigatorExtras {
  current?: HTMLElement | null;
  ringVisible?: boolean;
}

export function createMainScreen(): Screen {
  let cleanup: (() => void) | null = null;
  let detachDots: (() => void) | null = null;
  return {
    id: 'main',
    mount(root: HTMLElement, ctx: AppContext) {
      injectStyle('main-menu', CSS);
      root.classList.add('screen--main');
      // The shared menu dot field (UIX-01) behind the content.
      detachDots = attachDotField(root);
      sharedDotField().setActive(true);

      const focusId = initialFocusTestId();
      const open = (e: MainMenuEntry) => (): void => {
        lastSelected = e.testId;
        ctx.router.go(e.route, e.params ? { ...e.params } : {});
      };
      const quickPlay = (): void => {
        if (ctx.session.active) return;
        lastSelected = QUICK_PLAY_TEST_ID;
        // Inside the tap: (re)unlock audio; a controller confirm is not a gesture and the engine retries on the next one.
        ctx.audio.unlock().catch(() => undefined);
        ctx.session.start(defaultSetup(ctx));
      };

      // Top bar.
      const settingsEntry = MAIN_UTILITY_ENTRIES[0]!;
      const diagEntry = MAIN_UTILITY_ENTRIES[1]!;
      const settingsBtn = createButton(settingsEntry.label, open(settingsEntry), {
        testId: settingsEntry.testId, ctx, autofocus: focusId === settingsEntry.testId,
      });
      settingsBtn.replaceChildren(svgSpan(GEAR_SVG), h('span', { text: settingsEntry.label }));
      const diagBtn = createButton(diagEntry.label, open(diagEntry), {
        testId: diagEntry.testId, ctx, variant: 'ghost', extraClass: 'main-diag', autofocus: focusId === diagEntry.testId,
      });
      const top = h(
        'header',
        { class: 'main-top' },
        h('div', { class: 'main-brand' }, h('div', { class: 'main-dot' }), h('h1', { class: 'ui-title', text: GAME_NAME, testId: 'main-title' })),
        h('div', { class: 'main-utils' }, h('span', { class: 'main-version', text: `v${GAME_VERSION}` }), diagBtn, settingsBtn),
      );

      // Quick match card.
      const q = quickPlaySummary(ctx.settings.get(), ctx.clubs);
      const team = (t: QuickPlayTeam, side: 'home' | 'away'): HTMLElement => {
        const kit = h('span', { class: 'main-team-kit' });
        kit.style.background = t.color;
        return h('span', { class: `main-team main-team--${side}`, testId: `main-play-${side}` }, kit,
          h('span', { class: 'main-team-code', text: t.code }), h('span', { class: 'main-team-name', text: t.name }));
      };
      const play = createButton('Play now', quickPlay, {
        testId: QUICK_PLAY_TEST_ID, ctx, extraClass: 'main-play', autofocus: focusId === QUICK_PLAY_TEST_ID,
        ariaLabel: `Play now: ${q.home.name} v ${q.away.name}, ${q.line}`,
      });
      const cta = h('span', { class: 'main-cta' }, svgSpan(PLAY_SVG), h('span', { text: 'Play now' }));
      play.replaceChildren(
        h('span', { class: 'main-fixture' }, team(q.home, 'home'), h('span', { class: 'main-vs', text: 'v' }), team(q.away, 'away')),
        h('span', { class: 'main-foot' }, h('span', { class: 'main-meta', text: q.line, testId: 'main-play-meta' }), cta),
      );

      // Modes.
      const modeBtns: HTMLButtonElement[] = [];
      const list = h('div', { class: 'main-modes', attrs: { 'data-focus-group': 'y' } });
      MAIN_MODE_ENTRIES.forEach((e, i) => {
        const b = createButton(e.label, open(e), { testId: e.testId, ctx, extraClass: 'main-mode', autofocus: focusId === e.testId });
        b.setAttribute('aria-label', `${e.label}. ${e.detail}`);
        b.replaceChildren(
          h('span', { class: 'main-mode-idx', text: String(i + 1).padStart(2, '0') }),
          h('span', { class: 'main-mode-text' }, h('span', { class: 'main-mode-label', text: e.label }), h('span', { class: 'main-mode-detail', text: e.detail })),
          h('span', { class: 'main-mode-chev', attrs: { 'aria-hidden': 'true' } }),
        );
        modeBtns.push(b);
        list.append(b);
      });

      root.append(
        h(
          'div',
          { class: 'main-layout' },
          top,
          h('section', { class: 'main-left', attrs: { 'aria-label': 'Quick match' } }, h('p', { class: 'main-eyebrow', text: 'Quick match' }), play),
          h('section', { class: 'main-right', attrs: { 'aria-label': 'Modes' } }, h('p', { class: 'main-eyebrow', text: 'Modes' }), list),
        ),
      );

      // menuFocusOverride: the moves geometry gets wrong. The first press while the ring is hidden only reveals it
      // (the navigator's rule), so that one is left to the navigator.
      const nav = ctx.focus as unknown as NavigatorExtras;
      const byId = new Map<string, HTMLButtonElement>();
      for (const b of [play, settingsBtn, diagBtn, ...modeBtns]) if (b.dataset.testid) byId.set(b.dataset.testid, b);
      const offAction = ctx.focus.onAction((a) => {
        if (nav.ringVisible !== true || !nav.current || !root.contains(nav.current)) return false;
        const target = byId.get(menuFocusOverride(a, nav.current.dataset.testid) ?? '');
        if (!target || !target.isConnected) return false;
        ctx.focus.focus(target);
        return true;
      });

      cleanup = () => {
        offAction();
      };
    },
    unmount() {
      cleanup?.();
      cleanup = null;
      detachDots?.();
      detachDots = null;
    },
    onBack() {
      return true; // root screen: nothing behind it
    },
    onFrame(frame: FrameInfo) {
      if (detachDots) sharedDotField().frame(frame.nowMs);
    },
  };
}
