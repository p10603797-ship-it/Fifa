/**
 * [UIX-02] Splash (BRIEF §12 Screens: "tap to start, which also unlocks audio and shows an Add to Home Screen hint").
 *
 *  - Starts on a tap anywhere, any key (keyboard) or any controller button 0..15 (pads). The press goes to the main
 *    menu through router.replace('main'), so Back on the main menu never returns here.
 *  - Audio: ctx.audio.unlock() runs synchronously inside the tap / key gesture (the AudioContext must be created
 *    there on iPadOS). A pad press is not a browser gesture: unlock() is still called and the engine resumes on the
 *    player's next tap or key press.
 *  - One press = one action: a key press is taken in the window capture phase and stopped there, so the same press
 *    never reaches the menu input and confirms on the main menu too; a pad's menu action is consumed by an onAction
 *    subscriber (latest subscriber first), and a pad button outside the menu map (Square, Triangle, triggers,
 *    Options, L3/R3) is read from the shared pad manager in onFrame, which runs after the frame's menu poll. A press
 *    that came from a keyboard or a pad shows the focus ring on the main menu; a tap does not.
 *  - Add to Home Screen hint: on an iPad in a Safari tab (not standalone) until settings.homeScreenHintShown; the
 *    flag is set when the player leaves the splash with the hint on screen, so it is shown on one visit only.
 *  - Full screen: a "Play full screen" button in a browser tab where the Fullscreen API exists (never in the Home
 *    Screen app, which is already full screen). It requests full screen on the document root inside the tap and
 *    starts; the F key does the same from a keyboard.
 *  - Ignored keys: modifiers alone, browser shortcuts (Ctrl / Alt / Cmd), function and media keys, Tab, IME
 *    composition, auto-repeat, and the backquote (the debug overlay's toggle, which must keep working here).
 */
import type { AppContext, FrameInfo, PlatformInfo, Screen } from '../../contracts/app';
import { UiSound } from '../../contracts/app';
import { GAME_NAME, GAME_VERSION } from '../../contracts/constants';
import type { Settings } from '../../contracts/settings';
import { getPadManager, padAnyPressedEdge, type PadManager } from '../../input/pad/manager';
import { createButton, h, injectStyle } from '../components';
import { attachDotField, sharedDotField } from '../dotfield';
import { shareLinkRoom } from './online';

/** How the splash was left (tests and diagnostics). */
export type SplashStartSource = 'pointer' | 'key' | 'pad';

const CSS = `
.screen--splash { cursor: pointer; justify-content: space-between; }
.splash-center { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--space-5); min-height: 0; }
.splash-logo { display: flex; align-items: center; gap: var(--space-4); }
.splash-dot { width: 52px; height: 52px; border-radius: 50%; background: var(--ember);
  box-shadow: 0 0 48px rgba(255, 107, 53, 0.42); animation: splash-breathe 2.8s var(--ease) infinite; }
.splash-name { margin: 0; font-size: var(--fs-hero); font-weight: 700; letter-spacing: -0.02em; line-height: 1; }
.splash-tag { margin: 0; color: var(--text-2); font-size: var(--fs-md); letter-spacing: 0.04em; }
.splash-actions { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); margin-top: var(--space-4); }
.splash-actions .btn--primary { min-width: 280px; min-height: 68px; font-size: var(--fs-lg); }
.splash-or { margin: 0; color: var(--text-3); font-size: var(--fs-sm); }
.splash-fs { display: inline-flex; align-items: center; gap: var(--space-3); }
.splash-fs svg, .splash-hint svg { width: 22px; height: 22px; flex: none; }
.splash-foot { flex: none; width: 100%; display: grid; grid-template-columns: minmax(64px, 1fr) minmax(0, 620px) minmax(64px, 1fr);
  align-items: end; gap: var(--space-4); min-height: var(--space-5); }
.splash-foot > .splash-hint { grid-column: 2; }
.splash-hint { display: flex; align-items: center; gap: var(--space-3); margin: 0; max-width: min(620px, 100%);
  padding: var(--space-3) var(--space-5); border: 1px solid var(--hairline); border-radius: var(--radius);
  background: var(--surface-1); color: var(--text-2); font-size: var(--fs-sm); line-height: 1.4; text-align: left; }
.splash-hint strong { color: var(--text-1); font-weight: 600; }
.splash-version { grid-column: 3; justify-self: end; margin: 0; font: 400 var(--fs-xs) / 1 var(--font-num);
  font-variant-numeric: tabular-nums; color: var(--text-3); }
@keyframes splash-breathe { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.08); opacity: 0.86; } }
@media (prefers-reduced-motion: reduce) { .splash-dot { animation: none; } }
@media (max-height: 560px) {
  .splash-center { gap: var(--space-3); }
  .splash-name { font-size: var(--fs-xl); }
  .splash-dot { width: 36px; height: 36px; }
  .splash-actions { margin-top: 0; flex-direction: row; }
  .splash-or { display: none; }
}
`;

/** Share glyph (a tray with an arrow up) for the Add to Home Screen hint. Drawn here, no asset. */
const SHARE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/>' +
  '<path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';

/** Full-screen glyph (four corners). */
const FULLSCREEN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5"/><path d="M15 4h5v5"/><path d="M20 15v5h-5"/>' +
  '<path d="M9 20H4v-5"/></svg>';

/** The Add to Home Screen hint shows on an iPad in a Safari tab until it has been seen once. */
export function shouldShowHomeScreenHint(
  platform: Pick<PlatformInfo, 'isIPad' | 'isStandalone'>,
  settings: Pick<Settings, 'homeScreenHintShown'>,
): boolean {
  return platform.isIPad && !platform.isStandalone && !settings.homeScreenHintShown;
}

interface FullscreenDoc {
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  documentElement?: unknown;
}

interface FullscreenTarget {
  requestFullscreen?: (opts?: { navigationUI?: 'auto' | 'hide' | 'show' }) => Promise<void> | void;
  webkitRequestFullscreen?: () => Promise<void> | void;
}

function currentDoc(): FullscreenDoc | null {
  return typeof document !== 'undefined' ? (document as unknown as FullscreenDoc) : null;
}

/** Offer the full-screen button: the API exists, we are in a browser tab (not standalone) and not full screen yet. */
export function canOfferFullscreen(
  platform: Pick<PlatformInfo, 'supportsFullscreen' | 'isStandalone'>,
  doc: FullscreenDoc | null = currentDoc(),
): boolean {
  if (!platform.supportsFullscreen || platform.isStandalone || !doc) return false;
  return !doc.fullscreenElement && !doc.webkitFullscreenElement;
}

/**
 * Request full screen on the document root (call inside a user gesture). Uses the standard API, else the WebKit
 * prefix. Never throws; a rejected request is ignored (the game simply stays in the tab). True when a request was made.
 */
export function requestAppFullscreen(doc: FullscreenDoc | null = currentDoc()): boolean {
  const el = (doc?.documentElement ?? null) as FullscreenTarget | null;
  if (!el) return false;
  try {
    let p: Promise<void> | void;
    if (typeof el.requestFullscreen === 'function') p = el.requestFullscreen({ navigationUI: 'hide' });
    else if (typeof el.webkitRequestFullscreen === 'function') p = el.webkitRequestFullscreen();
    else return false;
    if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** KeyboardEvent subset read by isSplashStartKey. */
export interface SplashKeyLike {
  code?: string;
  key?: string;
  repeat?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
}

/** Keys that never start the game (modifiers, focus traversal, lock keys, the debug overlay toggle). */
export const SPLASH_IGNORED_CODES: readonly string[] = [
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  'OSLeft', 'OSRight', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Tab', 'ContextMenu', 'PrintScreen',
  'Backquote', 'Unidentified',
];

/** Function keys (F1..F24) and hardware media / browser / launch keys. */
const SYSTEM_KEY_RE = /^(F\d{1,2}|Audio\w*|Media\w*|Browser\w*|Launch\w*|Volume\w*|Power|Sleep|WakeUp|Eject|Lang\d)$/;

/** True when this keydown should start the game ("press any key"). */
export function isSplashStartKey(e: SplashKeyLike): boolean {
  if (e.repeat === true || e.isComposing === true) return false;
  if (e.ctrlKey === true || e.altKey === true || e.metaKey === true) return false;
  const code = e.code ?? '';
  if (code === '') {
    // Some virtual keyboards send no code: fall back to the key value (a printable character or Enter / Space).
    const key = e.key ?? '';
    return key === 'Enter' || key === ' ' || (key.length === 1 && key !== '`');
  }
  if (SPLASH_IGNORED_CODES.includes(code)) return false;
  return !SYSTEM_KEY_RE.test(code);
}

interface RingNavigator {
  showRing?: () => void;
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

/** Keys of the pads that are connected and active (pressed at least once) right now. */
function activePadKeys(pads: PadManager): string[] {
  const out: string[] = [];
  const slots = pads.slots;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!;
    if (s.connected && s.active) out.push(s.key);
  }
  return out;
}

export function createSplashScreen(): Screen {
  let cleanup: (() => void) | null = null;
  let frameHook: ((frame: FrameInfo) => void) | null = null;
  return {
    id: 'splash',
    mount(root: HTMLElement, ctx: AppContext) {
      injectStyle('splash', CSS);
      root.classList.add('screen--splash');
      root.dataset.testid = 'splash';

      // The shared menu dot field (UIX-01) behind the content; detached again on unmount.
      const detachDots = attachDotField(root);
      sharedDotField().setActive(true);

      const settings = ctx.settings.get();
      const showHint = shouldShowHomeScreenHint(ctx.platform, settings);
      const offerFullscreen = canOfferFullscreen(ctx.platform);
      let started = false;

      const start = (source: SplashStartSource, fullscreen = false): void => {
        if (started) return;
        started = true;
        if (fullscreen) requestAppFullscreen();
        // Must stay synchronous inside the gesture: the AudioContext is created before any await.
        ctx.audio.unlock().catch(() => undefined);
        ctx.audio.playUi(UiSound.START);
        if (showHint) ctx.settings.update((s) => { s.homeScreenHintShown = true; });
        ctx.diagnostics.log('ui', `splash start (${source}${fullscreen ? ', full screen' : ''})`);
        ctx.router.replace('main');
        // A friend's share link (?room=CODE) goes straight to the online lobby after the splash (NET-07).
        const room = shareLinkRoom();
        if (room) ctx.router.go('online-lobby', { room });
        // Keyboard and controller players see where they are on the main menu straight away.
        if (source !== 'pointer') (ctx.focus as RingNavigator).showRing?.();
      };

      const startBtn = createButton('Tap to start', () => start('pointer'), {
        testId: 'splash-start', variant: 'primary', autofocus: true,
      });
      const actions = h('div', { class: 'splash-actions' }, startBtn);
      if (offerFullscreen) {
        const fs = createButton('Play full screen', () => start('pointer', true), {
          testId: 'splash-fullscreen', variant: 'ghost', extraClass: 'splash-fs', ariaLabel: 'Play full screen',
        });
        const icon = h('span', { attrs: { 'aria-hidden': 'true' } });
        icon.innerHTML = FULLSCREEN_SVG;
        fs.replaceChildren(icon, h('span', { text: 'Play full screen' }));
        actions.append(fs);
      }

      const center = h(
        'div',
        { class: 'splash-center' },
        h('div', { class: 'splash-logo' }, h('div', { class: 'splash-dot' }), h('h1', { class: 'splash-name', text: GAME_NAME, testId: 'splash-title' })),
        h('p', { class: 'splash-tag', text: 'Eleven a side. Touch or controller.' }),
        actions,
        h('p', { class: 'splash-or', text: 'or press any key or controller button' }),
      );
      const foot = h('div', { class: 'splash-foot' });
      if (showHint) {
        const icon = h('span', { attrs: { 'aria-hidden': 'true' } });
        icon.innerHTML = SHARE_SVG;
        const text = h('span');
        text.append(
          'For full-screen play, add ', h('strong', { text: GAME_NAME }), ' to your Home Screen: tap ',
          h('strong', { text: 'Share' }), ', then ', h('strong', { text: 'Add to Home Screen' }), '.',
        );
        foot.append(h('p', { class: 'splash-hint', testId: 'splash-a2hs', attrs: { role: 'note' } }, icon, text));
      }
      foot.append(h('p', { class: 'splash-version', text: `v${GAME_VERSION}`, testId: 'splash-version' }));
      root.append(center, foot);

      // Tap anywhere (the buttons' own clicks bubble here too; start() runs once).
      const onTap = (): void => start('pointer');
      root.addEventListener('click', onTap);

      // Any key: taken in the capture phase and stopped, so the menu input never turns the same press into a
      // CONFIRM on the main menu. Listeners registered before this one (device registry, native-activation guard)
      // still see it.
      const onKey = (e: KeyboardEvent): void => {
        if (started || isEditable(e.target) || !isSplashStartKey(e)) return;
        if (e.cancelable) e.preventDefault();
        e.stopImmediatePropagation();
        start('key', offerFullscreen && e.code === 'KeyF');
      };
      window.addEventListener('keydown', onKey, true);

      // Controller menu actions (Cross, Circle, D-pad, stick, L1 / R1) and the keyboard's, if any got through.
      const offAction = ctx.focus.onAction(() => {
        if (!started) start('pad');
        return true;
      });

      // Any other pad button (Square, Triangle, triggers, Options, L3 / R3), and a first press so short that it only
      // activated the pad. onFrame runs after the frame's menu poll, so the press has already missed every menu action.
      let pads: PadManager | null = null;
      try {
        pads = getPadManager();
      } catch {
        pads = null;
      }
      const knownActive = pads ? activePadKeys(pads) : [];
      let seenPoll = pads ? pads.lastPollMs : -1;
      frameHook = (frame: FrameInfo): void => {
        sharedDotField().frame(frame.nowMs);
        if (started || !pads || pads.lastPollMs === seenPoll) return;
        seenPoll = pads.lastPollMs;
        const slots = pads.slots;
        for (let i = 0; i < slots.length; i++) {
          const s = slots[i]!;
          if (!s.connected || !s.active) continue;
          if (padAnyPressedEdge(s) || !knownActive.includes(s.key)) {
            start('pad');
            return;
          }
        }
      };

      cleanup = () => {
        root.removeEventListener('click', onTap);
        window.removeEventListener('keydown', onKey, true);
        offAction();
        detachDots();
      };
    },
    unmount() {
      frameHook = null;
      cleanup?.();
      cleanup = null;
    },
    onBack() {
      return true; // first screen: nothing behind it
    },
    onFrame(frame: FrameInfo) {
      frameHook?.(frame);
    },
  };
}
