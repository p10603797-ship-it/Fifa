/**
 * [FND-04] In-match screen: shows the HUD and touch layers over the game canvas and the pause menu overlay
 * (pause.ts) whenever the session is paused. Back / Escape pauses; Back again resumes (only the pauser can).
 * The touch overlay owns the top-right PAUSE button (brief section 9); this screen adds its own pause button only
 * when no touch device is bound to the match (mouse / desktop play). The canvas is shown by the session.
 *
 * [QF-17] The router keeps this screen mounted under the half-time overlay (ui/index.ts SCREEN_OVERLAYS). Covered, it
 * hides a stale pause menu, hands the queued team orders over (as an unmount used to) and hides the HUD and touch
 * layers (body.match-covered: the look of before, when half time unmounted this screen and body.in-match went; by
 * opacity, which restyles two elements instead of both layers' whole trees; the overlay above takes every touch);
 * uncovered, it re-syncs. [QF-17 skeptic] Its own pause button (keyboard / pad / mouse play) hides under the overlay
 * too (visibility, no layout): through the half-time scrim it showed as a dimmed pause icon in the corner.
 */
import type { AppContext, FrameInfo } from '../../contracts/app';
import { ANY_DEVICE } from '../../app/localInput';
import { uiHumanOf } from '../../app/session';
import type { LayeredScreen } from '../../app/types';
import { createButton, injectStyle } from '../components';
import { createPauseMenu, type PauseMenu } from './pause';

const CSS = `
.screen--match .match-pause { position:absolute; top: calc(var(--safe-top, 0px) + var(--gesture-margin, 24px));
  right: calc(var(--safe-right, 0px) + var(--gesture-margin, 24px)); min-width: var(--target); width: var(--target);
  padding:0; background: rgba(7,7,13,.45); font-size: 0; }
.screen--match .match-pause::before, .screen--match .match-pause::after { content:''; display:inline-block; width:6px;
  height:22px; margin: 0 4px; border-radius:2px; background: var(--text-1); }
.screen--match .match-pause[hidden] { display:none; }
body.in-match.match-covered #hud, body.in-match.match-covered #touch { opacity: 0; }
body.match-covered .screen--match .match-pause { visibility: hidden; }
`;

/** Body class while an overlay (half time) covers the mounted match screen: HUD and touch layers hidden. */
export const MATCH_COVERED_CLASS = 'match-covered';

/**
 * Ignore Back within this time of a pause change: one physical press can reach the app through several paths
 * (router Escape, keyboard source onPause, menu input BACK) and must never toggle twice.
 */
const TOGGLE_GUARD_MS = 250;

/** True when a touch device is bound to the current match (its overlay then shows the PAUSE button). */
export function touchBound(c: AppContext): boolean {
  const setup = c.session.getSetup();
  if (!setup) return false;
  let touchIds: string[] = [];
  try {
    touchIds = c.devices.list().filter((d) => d.kind === 'touch' && d.connected).map((d) => d.id);
  } catch {
    touchIds = [];
  }
  if (touchIds.length === 0) return false;
  return setup.bindings.some((b) => b.deviceIds.some((id) => id === ANY_DEVICE || touchIds.includes(id)));
}

export function createMatchScreen(): LayeredScreen {
  let ctx: AppContext | null = null;
  let pause: PauseMenu | null = null;
  let pauseBtn: HTMLButtonElement | null = null;
  let shownPaused = false;
  let lastFlipAt = -Infinity;
  let ownPauseButton = true;

  function sync(c: AppContext, nowMs: number): void {
    const p = c.session.paused;
    if (p === shownPaused) return;
    shownPaused = p;
    lastFlipAt = nowMs;
    document.body.classList.toggle('match-paused', p);
    if (pauseBtn) pauseBtn.hidden = p || !ownPauseButton;
    if (p) pause?.show();
    else pause?.hide();
  }

  return {
    id: 'match',
    mount(root: HTMLElement, c: AppContext) {
      injectStyle('match', CSS);
      ctx = c;
      root.classList.add('screen--transparent', 'screen--match');
      document.body.classList.add('in-match');
      pauseBtn = createButton('Pause', () => c.session.pause(uiHumanOf(c)), {
        testId: 'match-pause', variant: 'icon', extraClass: 'match-pause', ariaLabel: 'Pause',
      });
      ownPauseButton = !touchBound(c);
      pauseBtn.hidden = !ownPauseButton;
      root.append(pauseBtn);
      pause = createPauseMenu();
      pause.mount(root, c);
      shownPaused = false;
      lastFlipAt = -Infinity;
      sync(c, performance.now());
    },
    unmount() {
      document.body.classList.remove('in-match', 'match-paused', MATCH_COVERED_CLASS);
      pause?.dispose();
      pause = null;
      pauseBtn = null;
      ctx = null;
      shownPaused = false;
    },
    onFrame(frame: FrameInfo) {
      if (!ctx) return;
      sync(ctx, frame.nowMs);
      pause?.update(frame.nowMs);
    },
    onCovered() {
      document.body.classList.add(MATCH_COVERED_CLASS);
      const c = ctx;
      if (!c) return;
      // The session covers this screen only while play runs (half time): a pause menu still shown from before the
      // resume that led here hides now (its key listener and focus root must not sit under the overlay).
      if (!c.session.paused) sync(c, performance.now());
      pause?.flushOrders();
    },
    onUncovered() {
      document.body.classList.remove(MATCH_COVERED_CLASS);
      const c = ctx;
      if (!c) return;
      // What a remount at the second-half kick-off used to recompute: a touch device may have been bound meanwhile.
      ownPauseButton = !touchBound(c);
      if (pauseBtn) pauseBtn.hidden = shownPaused || !ownPauseButton;
      sync(c, performance.now());
    },
    onBack() {
      const c = ctx;
      if (!c) return false;
      const now = performance.now();
      sync(c, now);
      if (now - lastFlipAt < TOGGLE_GUARD_MS) return true;
      if (!c.session.paused) {
        c.session.pause(uiHumanOf(c));
        // Refused (the match has finished, so it can never pause): re-sync instead, which moves a finished match
        // to its final full-time screen. Back must never be a dead key on this screen.
        if (!c.session.paused) c.session.resume(-1);
      } else {
        c.session.resume(uiHumanOf(c));
      }
      sync(c, now);
      return true;
    },
  };
}
