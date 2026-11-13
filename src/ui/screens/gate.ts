/**
 * [GATE] Password lock screen (D-047, D-048). Shown by src/app/gateBoot.ts before boot, so it runs without the router,
 * focus navigator, audio or settings: plain DOM in #ui, styled with the Dot tokens like the splash.
 *
 *  - One large field (autocapitalize characters, no autocomplete / autocorrect / spellcheck, enterkeyhint "go") and
 *    a large Unlock button in a <form>: Enter on a keyboard and Go on the iPad keyboard submit.
 *  - Messages: wrong code, a code already used (on any device), the online checker could not be reached (no internet:
 *    "Connect to the internet and try again"), and, after an unlock this browser cannot keep (private browsing), a
 *    plain notice with Continue. Only a submit contacts the checker (src/app/gateOnline.ts).
 *  - On-screen keyboard: the screen follows window.visualViewport (top and height), so the field and the button stay
 *    in the visible part above the iPad keyboard in landscape and portrait; a short viewport switches to a compact
 *    layout, and the column scrolls if it is still too short.
 *  - The CSS-only portrait card (#rotate in index.html) is hidden while the lock is up: the lock works in portrait.
 *  - Another tab of this browser may unlock the device while this one shows the lock: a 'storage' event on the
 *    unlock record, the tab coming back into view or focus, a submit, and a refused submit all check
 *    gate.isUnlocked() first and go straight in, so no second code is spent and a code just redeemed by the other
 *    tab is not shown as "already used".
 */
import type { Gate, UnlockOutcome } from '../../app/gate';
import { CODE_LENGTH, GATE_TEXT, GATE_UNLOCK_KEY } from '../../app/gate';
import { GAME_NAME } from '../../contracts/constants';
import { h, injectStyle } from '../components';

/** Body class while the lock is up. */
export const GATE_BODY_CLASS = 'dk-gated';

/** Below this visible height (CSS px; the iPad keyboard is up) the layout gets compact. */
const COMPACT_HEIGHT_PX = 560;

const CSS = `
body.${GATE_BODY_CLASS} #rotate { display: none !important; }
.screen--gate { inset: auto; top: var(--gate-top, 0px); left: 0; width: 100%; height: var(--gate-h, 100%);
  justify-content: flex-start; overflow-x: hidden; overflow-y: auto; z-index: 10; }
.gate-form { display: flex; flex-direction: column; align-items: center; gap: var(--space-4); width: min(460px, 100%);
  margin: auto 0; flex: none; }
.gate-logo { display: flex; align-items: center; gap: var(--space-4); margin-bottom: var(--space-2); }
.gate-dot { width: 44px; height: 44px; border-radius: 50%; background: var(--ember); flex: none;
  box-shadow: 0 0 40px rgba(255, 107, 53, 0.42); animation: gate-breathe 2.8s var(--ease) infinite; }
.gate-name { margin: 0; font-size: var(--fs-xl); font-weight: var(--fw-bold); letter-spacing: -0.02em; line-height: 1; }
.gate-prompt { margin: 0; color: var(--text-2); font-size: var(--fs-md); text-align: center; line-height: var(--lh); }
.gate-input { width: 100%; min-height: 68px; box-sizing: border-box; padding: 0 var(--space-4); border-radius: var(--radius);
  background: var(--surface-2); color: var(--text-1); border: 2px solid var(--hairline-strong);
  font: var(--fw-num-bold) 26px / 1 var(--font-num); letter-spacing: 0.1em; text-align: center; text-transform: uppercase;
  -webkit-user-select: text; user-select: text; touch-action: manipulation; caret-color: var(--ember); }
.gate-input::placeholder { color: var(--text-3); opacity: 1; letter-spacing: 0.1em; }
.gate-input:focus { outline: none; border-color: var(--ember); box-shadow: 0 0 0 3px var(--ember-soft); }
.gate-input[aria-invalid='true'] { border-color: var(--error); }
.gate-submit { width: 100%; min-height: 68px; font-size: var(--fs-lg); }
.gate-msg { margin: 0; min-height: 1.4em; font-size: var(--fs-sm); line-height: var(--lh); text-align: center;
  color: var(--text-2); }
.gate-msg[data-kind='error'] { color: var(--error); }
.gate-msg[data-kind='warning'] { color: var(--warning); }
.screen--gate.is-compact { gap: var(--space-3); padding-top: var(--space-4); padding-bottom: var(--space-4); }
.screen--gate.is-compact .gate-form { gap: var(--space-3); }
.screen--gate.is-compact .gate-logo { margin-bottom: 0; }
.screen--gate.is-compact .gate-dot { width: 28px; height: 28px; }
.screen--gate.is-compact .gate-name { font-size: var(--fs-lg); }
.screen--gate.is-compact .gate-input, .screen--gate.is-compact .gate-submit { min-height: 56px; }
@keyframes gate-breathe { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.08); opacity: 0.86; } }
@media (prefers-reduced-motion: reduce) { .gate-dot { animation: none; } }
`;

export interface GateScreenOptions {
  gate: Gate;
  /** Called once the game may start (after the lock is gone from the page). */
  onUnlocked(): void;
  /** Called after a successful unlock (navigator.storage.persist). Errors are ignored. */
  onRedeemed?(outcome: UnlockOutcome): void;
}

export interface GateScreen {
  readonly root: HTMLElement;
  dispose(): void;
}

interface VisualViewportLike extends EventTarget {
  readonly height: number;
  readonly offsetTop: number;
}

/** Mount the lock screen into `parent` (#ui). */
export function mountGateScreen(parent: HTMLElement, opts: GateScreenOptions): GateScreen {
  injectStyle('gate', CSS);
  const disposers: (() => void)[] = [];
  let disposed = false;

  const input = h('input', {
    class: 'gate-input',
    testId: 'gate-input',
    attrs: {
      type: 'text',
      name: 'unlock-code',
      inputmode: 'text',
      autocapitalize: 'characters',
      autocomplete: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      enterkeyhint: 'go',
      maxlength: '40',
      placeholder: Array.from({ length: CODE_LENGTH / 4 }, () => 'XXXX').join('-'),
      'aria-label': 'Password',
      'aria-describedby': 'gate-msg',
    },
  });
  const submit = h('button', { class: 'btn btn--primary gate-submit', text: 'Unlock', testId: 'gate-submit' });
  submit.type = 'submit';
  const msg = h('p', { class: 'gate-msg', testId: 'gate-message', attrs: { id: 'gate-msg', role: 'status', 'aria-live': 'polite' } });
  const form = h('form', { class: 'gate-form', attrs: { novalidate: '', autocomplete: 'off', 'aria-labelledby': 'gate-title' } },
    h('div', { class: 'gate-logo' },
      h('span', { class: 'gate-dot', attrs: { 'aria-hidden': 'true' } }),
      h('h1', { class: 'gate-name', text: GAME_NAME, attrs: { id: 'gate-title' } })),
    h('p', { class: 'gate-prompt', text: GATE_TEXT.prompt, testId: 'gate-prompt' }),
    input,
    submit,
    msg,
  );
  const root = h('div', { class: 'screen screen--gate', testId: 'gate', attrs: { 'data-scroll': '' } }, form);

  const say = (text: string, kind: 'info' | 'error' | 'warning' = 'info'): void => {
    msg.textContent = text;
    msg.dataset.kind = kind;
    input.setAttribute('aria-invalid', kind === 'error' ? 'true' : 'false');
  };

  // Keep the screen inside the visible part of the page (the iPad keyboard shrinks the visual viewport).
  const vv = (typeof window !== 'undefined' ? (window as { visualViewport?: VisualViewportLike | null }).visualViewport : null) ?? null;
  const fit = (): void => {
    const height = vv ? vv.height : window.innerHeight;
    const top = vv ? Math.max(0, vv.offsetTop) : 0;
    root.style.setProperty('--gate-top', `${top}px`);
    root.style.setProperty('--gate-h', `${height}px`);
    root.classList.toggle('is-compact', height < COMPACT_HEIGHT_PX);
  };
  const keepFieldVisible = (): void => {
    fit();
    if (document.activeElement !== input) return;
    try {
      submit.scrollIntoView({ block: 'nearest' });
      input.scrollIntoView({ block: 'nearest' });
    } catch {
      /* old engines: the screen still follows the viewport */
    }
  };
  const on = (t: EventTarget, type: string, fn: EventListener): void => {
    t.addEventListener(type, fn);
    disposers.push(() => t.removeEventListener(type, fn));
  };
  if (vv) {
    on(vv, 'resize', keepFieldVisible);
    on(vv, 'scroll', fit);
  }
  on(window, 'resize', keepFieldVisible);
  on(window, 'orientationchange', keepFieldVisible);
  on(input, 'focus', () => {
    // The keyboard animates in after focus; check again once it has settled.
    const t = setTimeout(keepFieldVisible, 350);
    disposers.push(() => clearTimeout(t));
  });
  on(input, 'input', () => {
    if (msg.dataset.kind === 'error') say('');
  });

  let busy = false;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    dispose();
    opts.onUnlocked();
  };

  const showNotRemembered = (): void => {
    say(GATE_TEXT.notRemembered, 'warning');
    input.disabled = true;
    submit.textContent = 'Continue';
    submit.dataset.testid = 'gate-continue';
    submit.disabled = false;
  };

  let notRemembered = false;

  /** True (and the game starts) when the device is already unlocked, e.g. by another tab of this browser. */
  const enterIfUnlockedElsewhere = (): boolean => {
    if (finished || disposed || notRemembered) return false;
    let unlocked: boolean;
    try {
      unlocked = opts.gate.isUnlocked();
    } catch {
      unlocked = false;
    }
    if (!unlocked) return false;
    input.blur();
    finish();
    return true;
  };
  on(window, 'storage', (e) => {
    const key = (e as StorageEvent).key;
    if (key === null || key === GATE_UNLOCK_KEY) enterIfUnlockedElsewhere();
  });
  on(window, 'focus', () => {
    enterIfUnlockedElsewhere();
  });
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible') enterIfUnlockedElsewhere();
  });

  on(form, 'submit', (e) => {
    e.preventDefault();
    if (notRemembered) {
      finish();
      return;
    }
    if (busy) return;
    if (enterIfUnlockedElsewhere()) return; // never spend a code on a device that is already unlocked
    const code = input.value;
    if (code.trim().length === 0) {
      say(GATE_TEXT.empty, 'error');
      input.focus();
      return;
    }
    busy = true;
    submit.disabled = true;
    say(GATE_TEXT.checking);
    void opts.gate.unlock(code).then((outcome) => {
      if (disposed) return;
      busy = false;
      submit.disabled = false;
      if (outcome.result === 'ok') {
        try {
          opts.onRedeemed?.(outcome);
        } catch {
          /* best effort */
        }
        input.blur(); // closes the iPad keyboard before the game starts
        if (outcome.remembered) {
          finish();
        } else {
          notRemembered = true;
          showNotRemembered();
          submit.focus();
        }
        return;
      }
      // Another tab may have unlocked the device meanwhile (possibly with this very code): go in.
      if (enterIfUnlockedElsewhere()) return;
      say(outcome.result === 'used' ? GATE_TEXT.used : outcome.result === 'offline-error' ? GATE_TEXT.offline : GATE_TEXT.wrong, 'error');
      input.select();
    });
  });

  document.body.classList.add(GATE_BODY_CLASS);
  parent.append(root);
  fit();
  try {
    input.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const d of disposers.splice(0).reverse()) d();
    root.remove();
    document.body.classList.remove(GATE_BODY_CLASS);
  }

  return { root, dispose };
}
