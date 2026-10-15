/**
 * [UIX-06] Scoreboard (top left; brief section 12 "Scoreboard top left: 3-letter team codes, score, clock, added
 * time"): kit-colour chip + code per team, the score, the clock (mm:ss scaled to 45:00 halves by displayClock,
 * JetBrains Mono tabular figures), the +N added-time indicator while it is shown, and a period label: HT / FT at the
 * breaks, ET in extra time, PENS with the shoot-out tally in place of the clock, PRACTICE (no clock) in practice.
 *
 * HUD rules: writes to the DOM only when a displayed value changes (cached per field; every number string comes
 * from a prebuilt table, so update() allocates nothing); no animation; inside the safe area, clear of the touch
 * controls (the touch pause button sits top right). Larger HUD (accessibility) scales it by --hs.
 */
import type { AppContext, FrameInfo, HudPart } from '../../contracts/app';
import type { Club, Kit } from '../../contracts/data';
import { KitSlot, MatchPhase, ModeId, Period, PracticeKind } from '../../contracts/enums';
import type { EventBuffer } from '../../contracts/events';
import type { CameraProjector } from '../../contracts/input';
import type { ReadonlySimState, SimState } from '../../contracts/state';
import { resolveMatchKits } from '../../render/kits';
import { displayClock } from '../../sim/rules/machine';
import { h, injectStyle } from '../components';
import { HUD_SHARED_CSS, bindLargerHud } from './hudShared';

const CSS = `
.hud-scoreboard { position:absolute; left: calc(var(--safe-left, 0px) + var(--gesture-margin, 24px));
  top: calc(var(--safe-top, 0px) + 16px); display:flex; align-items:stretch; height: calc(40px * var(--hs));
  border-radius: calc(10px * var(--hs)); overflow:hidden; background: rgba(7,7,13,.84); border: 1px solid var(--hairline);
  font-family: var(--font-ui); color: var(--text-1); font-size: calc(17px * var(--hs)); font-weight: 700;
  letter-spacing: .04em; line-height: 1; box-shadow: 0 6px 18px rgba(0,0,0,.28); white-space: nowrap; }
.hud-scoreboard[hidden] { display:none; }
.hud-scoreboard > span { display:flex; align-items:center; padding: 0 calc(10px * var(--hs)); }
.hud-scoreboard .sb-kit { width: calc(6px * var(--hs)); padding:0; }
.hud-scoreboard .sb-code { padding: 0 calc(9px * var(--hs)); }
.hud-scoreboard .sb-score { font-family: var(--font-num); font-variant-numeric: tabular-nums; font-weight: 600;
  background: var(--surface-3); gap: calc(5px * var(--hs)); }
.hud-scoreboard .sb-sep { color: var(--text-3); font-weight: 400; }
.hud-scoreboard .sb-period { font-size: .7em; letter-spacing: .12em; color: var(--text-3); padding-right: 0;
  border-left: 1px solid var(--hairline); }
.hud-scoreboard .sb-period:empty { display:none; }
.hud-scoreboard .sb-clock { font-family: var(--font-num); font-variant-numeric: tabular-nums; font-weight: 500;
  color: var(--text-2); border-left: 1px solid var(--hairline); }
.hud-scoreboard .sb-period:not(:empty) + .sb-clock { border-left: 0; }
.hud-scoreboard .sb-tally { font-family: var(--font-num); font-variant-numeric: tabular-nums; font-weight: 600;
  color: var(--text-1); gap: calc(4px * var(--hs)); display:none; }
.hud-scoreboard .sb-added { font-family: var(--font-num); font-variant-numeric: tabular-nums; font-weight: 600;
  color: var(--ember); padding-left: 0; font-size: .82em; }
.hud-scoreboard .sb-added:empty { display:none; }
.hud-scoreboard[data-mode="pens"] .sb-clock, .hud-scoreboard[data-mode="practice"] .sb-clock { display:none; }
.hud-scoreboard[data-mode="pens"] .sb-tally { display:flex; }
.hud-scoreboard[data-mode="pens"] .sb-added, .hud-scoreboard[data-mode="practice"] .sb-added { display:none; }
`;

// ============================================================ pure helpers (unit-tested)

/** Number strings 0..199 (minutes go past 120 only in a broken state; clamp beyond). */
const NUM_STR: readonly string[] = Array.from({ length: 200 }, (_, i) => String(i));
/** Two-digit strings 00..99. */
const PAD2_STR: readonly string[] = Array.from({ length: 100 }, (_, i) => (i < 10 ? '0' + i : String(i)));

/** Cached decimal string of a non-negative integer (clamped to 0..199). */
export function numStr(n: number): string {
  const i = !Number.isFinite(n) || n < 0 ? 0 : n > 199 ? 199 : Math.floor(n);
  return NUM_STR[i]!;
}

/** Cached two-digit minutes (three digits from 100) for the clock. */
export function clockMinStr(min: number): string {
  const i = !Number.isFinite(min) || min < 0 ? 0 : Math.floor(min);
  return i < 100 ? PAD2_STR[i]! : numStr(i);
}

/** Cached two-digit seconds 00..59. */
export function clockSecStr(sec: number): string {
  const i = !Number.isFinite(sec) || sec < 0 ? 0 : sec > 59 ? 59 : Math.floor(sec);
  return PAD2_STR[i]!;
}

/** "mm:ss" (allocates; tests and aria only). */
export function formatClock(min: number, sec: number): string {
  return clockMinStr(min) + ':' + clockSecStr(sec);
}

const ADDED_STR: readonly string[] = Array.from({ length: 31 }, (_, i) => (i === 0 ? '' : '+' + i));

/** Added-time indicator: '' for none, else '+N' (cached up to +30). */
export function addedStr(added: number): string {
  const i = !Number.isFinite(added) || added <= 0 ? 0 : added > 30 ? 30 : Math.floor(added);
  return ADDED_STR[i]!;
}

/** What the clock area shows. */
export enum BoardMode {
  CLOCK = 0,
  PENS = 1,
  PRACTICE = 2,
}

const MODE_ATTR: readonly string[] = ['clock', 'pens', 'practice'];

export interface BoardContext {
  period: number;
  phase: number;
  mode: number;
  practice: number;
  shootoutActive: number;
}

/** Clock, shoot-out tally or practice. Pure. */
export function boardMode(c: BoardContext): BoardMode {
  if (c.mode === ModeId.PRACTICE || c.practice !== PracticeKind.NONE) return BoardMode.PRACTICE;
  if (c.period >= Period.SHOOT_OUT || c.phase === MatchPhase.SHOOT_OUT || c.shootoutActive === 1 || c.mode === ModeId.SHOOT_OUT) {
    return BoardMode.PENS;
  }
  return BoardMode.CLOCK;
}

/** Period label: HT / FT at the breaks, ET in extra time, PENS in a shoot-out, PRACTICE, else ''. Pure. */
export function periodLabel(c: BoardContext): string {
  const bm = boardMode(c);
  if (bm === BoardMode.PRACTICE) return 'PRACTICE';
  if (bm === BoardMode.PENS) return 'PENS';
  if (c.phase === MatchPhase.HALF_TIME) return 'HT';
  if (c.phase === MatchPhase.FULL_TIME || c.phase === MatchPhase.POST_MATCH) return 'FT';
  if (c.phase === MatchPhase.EXTRA_TIME) return 'ET';
  if (c.period === Period.ET_FIRST || c.period === Period.ET_SECOND) return 'ET';
  return '';
}

/** '#rrggbb' of an 0xRRGGBB colour. */
export function kitHex(rgb: number): string {
  return '#' + ((rgb >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}

/** The club kit of a team.kit slot (the REQUESTED kit; keeper kits never apply to the team chip). */
export function teamKit(club: Club | undefined, slot: number): Kit | null {
  if (!club) return null;
  return slot === KitSlot.AWAY ? club.away : club.home;
}

/**
 * [QF-12] The outfield shirt colour each team actually wears on the pitch: the renderer's kits (render/kits
 * resolveMatchKits: the requested slots through the clash check, built-in fallback kits, high-contrast kits), not the
 * requested slot. A config whose requested kits clash (Play now after Settings > Match changed a club, every online
 * match: the lobby requests HOME / AWAY) is drawn with the other kit, and the scoreboard chip, radar dots and toast
 * chip showed the clashing one: 93 of the 380 club pairings. Allocates (call on setMatch / settings change only);
 * null when the kits cannot be resolved.
 */
export function wornShirts(state: ReadonlySimState, clubs: readonly Club[], highContrast = false): [number, number] | null {
  try {
    const k = resolveMatchKits(state, clubs, highContrast);
    return [k.outfield[0].shirt, k.outfield[1].shirt];
  } catch {
    return null;
  }
}

/** The high-contrast kits setting (false without a context or when settings cannot be read). */
export function highContrastOn(ctx: Pick<AppContext, 'settings'> | null): boolean {
  try {
    return ctx?.settings.get().accessibility?.highContrastKits === true;
  } catch {
    return false;
  }
}

// ============================================================ part

export function createScoreboard(): HudPart {
  let root: HTMLElement | null = null;
  let homeCode: HTMLElement | null = null;
  let awayCode: HTMLElement | null = null;
  let homeKit: HTMLElement | null = null;
  let awayKit: HTMLElement | null = null;
  let homeGoals: Text | null = null;
  let awayGoals: Text | null = null;
  let periodEl: HTMLElement | null = null;
  let minText: Text | null = null;
  let secText: Text | null = null;
  let tallyHome: Text | null = null;
  let tallyAway: Text | null = null;
  let addedEl: HTMLElement | null = null;
  let unbindLarge: (() => void) | null = null;
  let ctxRef: AppContext | null = null;
  let unSettings: (() => void) | null = null;
  let matchState: ReadonlySimState | null = null;
  let matchClubs: readonly Club[] = [];
  let paintedHc: boolean | null = null;
  const clock = { min: 0, sec: 0, added: 0, period: 0 };

  /** Kit chips = the shirts worn on the pitch (wornShirts); repainted when the high-contrast setting flips. */
  function paintKits(): void {
    if (!matchState) return;
    const hc = highContrastOn(ctxRef);
    paintedHc = hc;
    const worn = wornShirts(matchState, matchClubs, hc);
    if (homeKit) homeKit.style.background = worn ? kitHex(worn[0]) : 'var(--text-3)';
    if (awayKit) awayKit.style.background = worn ? kitHex(worn[1]) : 'var(--text-3)';
  }
  const bctx: BoardContext = { period: 0, phase: 0, mode: 0, practice: 0, shootoutActive: 0 };
  let shownHome = -1;
  let shownAway = -1;
  let shownMin = -1;
  let shownSec = -1;
  let shownAdded = -1;
  let shownLabel = '\u0000';
  let shownMode = -1;
  let shownTally0 = -1;
  let shownTally1 = -1;

  function resetShown(): void {
    shownHome = shownAway = shownMin = shownSec = shownAdded = shownMode = shownTally0 = shownTally1 = -1;
    shownLabel = '\u0000';
  }

  return {
    mount(parent: HTMLElement, ctx: AppContext) {
      ctxRef = ctx;
      injectStyle('hud-shared', HUD_SHARED_CSS);
      injectStyle('hud-scoreboard', CSS);
      homeKit = h('span', { class: 'sb-kit', testId: 'sb-home-kit' });
      homeCode = h('span', { class: 'sb-code', text: '---', testId: 'sb-home' });
      homeGoals = document.createTextNode('0');
      awayGoals = document.createTextNode('0');
      const score = h('span', { class: 'sb-score', testId: 'sb-score' });
      score.append(homeGoals, h('span', { class: 'sb-sep', text: '-' }), awayGoals);
      awayCode = h('span', { class: 'sb-code', text: '---', testId: 'sb-away' });
      awayKit = h('span', { class: 'sb-kit', testId: 'sb-away-kit' });
      periodEl = h('span', { class: 'sb-period', text: '', testId: 'sb-period' });
      minText = document.createTextNode('00');
      secText = document.createTextNode('00');
      const clockEl = h('span', { class: 'sb-clock', testId: 'sb-clock' });
      clockEl.append(minText, ':', secText);
      tallyHome = document.createTextNode('0');
      tallyAway = document.createTextNode('0');
      const tally = h('span', { class: 'sb-tally', testId: 'sb-tally' });
      tally.append(tallyHome, h('span', { class: 'sb-sep', text: '-' }), tallyAway);
      addedEl = h('span', { class: 'sb-added', text: '', testId: 'sb-added' });
      root = h('div', { class: 'hud-part hud-scoreboard', testId: 'hud-scoreboard', attrs: { 'data-mode': 'clock' } },
        homeKit, homeCode, score, awayCode, awayKit, periodEl, clockEl, tally, addedEl);
      parent.append(root);
      unbindLarge = bindLargerHud(ctx, root);
      try {
        unSettings = ctx.settings.subscribe(() => {
          if (matchState && highContrastOn(ctxRef) !== paintedHc) paintKits();
        });
      } catch {
        unSettings = null;
      }
    },
    setMatch(state: ReadonlySimState, clubs: readonly Club[]) {
      const t0 = state.teams[0]!;
      const t1 = state.teams[1]!;
      const home = clubs[t0.clubIdx];
      const away = clubs[t1.clubIdx];
      if (homeCode) homeCode.textContent = home?.code ?? 'HOM';
      if (awayCode) awayCode.textContent = away?.code ?? 'AWY';
      matchState = state;
      matchClubs = clubs;
      paintKits();
      if (root) root.setAttribute('aria-label', `${home?.name ?? 'Home'} v ${away?.name ?? 'Away'}`);
      resetShown();
    },
    update(state: ReadonlySimState, frame: FrameInfo, projector: CameraProjector | null) {
      void frame;
      void projector;
      const g0 = state.teams[0]!.goals;
      const g1 = state.teams[1]!.goals;
      if (g0 !== shownHome) {
        shownHome = g0;
        if (homeGoals) homeGoals.nodeValue = numStr(g0);
      }
      if (g1 !== shownAway) {
        shownAway = g1;
        if (awayGoals) awayGoals.nodeValue = numStr(g1);
      }
      const m = state.match;
      bctx.period = m.period;
      bctx.phase = m.phase;
      bctx.mode = state.config.mode;
      bctx.practice = state.config.practice;
      bctx.shootoutActive = m.shootout.active;
      const mode = boardMode(bctx);
      if (mode !== shownMode) {
        shownMode = mode;
        root?.setAttribute('data-mode', MODE_ATTR[mode]!);
      }
      const label = periodLabel(bctx);
      if (label !== shownLabel) {
        shownLabel = label;
        if (periodEl) periodEl.textContent = label;
      }
      if (mode === BoardMode.PENS) {
        const p0 = m.shootout.goals[0]!;
        const p1 = m.shootout.goals[1]!;
        if (p0 !== shownTally0) {
          shownTally0 = p0;
          if (tallyHome) tallyHome.nodeValue = numStr(p0);
        }
        if (p1 !== shownTally1) {
          shownTally1 = p1;
          if (tallyAway) tallyAway.nodeValue = numStr(p1);
        }
        return;
      }
      if (mode === BoardMode.PRACTICE) return;
      displayClock(state as unknown as SimState, clock);
      const min = Math.floor(clock.min);
      const sec = Math.floor(clock.sec);
      if (min !== shownMin) {
        shownMin = min;
        if (minText) minText.nodeValue = clockMinStr(min);
      }
      if (sec !== shownSec) {
        shownSec = sec;
        if (secText) secText.nodeValue = clockSecStr(sec);
      }
      const added = Math.floor(clock.added);
      if (added !== shownAdded) {
        shownAdded = added;
        if (addedEl) addedEl.textContent = addedStr(added);
      }
    },
    onEvents(events: EventBuffer, state: ReadonlySimState) {
      void events;
      void state;
    },
    setVisible(v: boolean) {
      if (root) root.hidden = !v;
    },
    dispose() {
      unbindLarge?.();
      unbindLarge = null;
      unSettings?.();
      unSettings = null;
      matchState = null;
      root?.remove();
      root = homeCode = awayCode = homeKit = awayKit = periodEl = addedEl = null;
      homeGoals = awayGoals = minText = secText = tallyHome = tallyAway = null;
    },
  };
}
