/**
 * [UIX-08] Pause menu (overlay inside the match screen). WAVE 0 version by FND-04: Resume / Restart / Quit.
 * UIX-08 adds team management (formation, substitutions, stamina), tactics, camera, controls and sound.
 * Only the human who paused (or anyone after a system pause) can resume; others see who paused. A refused Resume
 * shows why (refusalMessage) for REFUSAL_NOTE_MS, then the line returns to who paused; it is also reset on show().
 */
import type { AppContext } from '../../contracts/app';
import { UiSound } from '../../contracts/app';
import { uiHumanOf } from '../../app/session';
import { createButton, h, injectStyle } from '../components';

const CSS = `
.pause-overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  background: var(--scrim); pointer-events:auto; }
.pause-overlay[hidden] { display:none; }
.pause-who { margin:0; color: var(--text-2); font-size: var(--fs-sm); }
.pause-who.p1 { color: var(--p1); } .pause-who.p2 { color: var(--p2); }
`;

/** How long a refused-resume note stays before the line returns to who paused, ms. */
export const REFUSAL_NOTE_MS = 2500;

/**
 * Why Resume was refused. A human pause (pausedBy >= 0) can be lifted only by that human; a system pause
 * (pausedBy -1) is refused only while the page is hidden or the window is in portrait / too small. Pure.
 */
export function refusalMessage(pausedBy: number): string {
  if (pausedBy >= 0) return `Only Player ${pausedBy + 1} can resume`;
  return 'Turn to landscape or enlarge the window to resume';
}

export interface PauseMenu {
  mount(root: HTMLElement, ctx: AppContext): void;
  show(): void;
  hide(): void;
  /** Every frame from the match screen (rAF time, ms): expires the refusal note. Writes the DOM only on change. */
  update(nowMs: number): void;
  readonly visible: boolean;
  dispose(): void;
}

export function createPauseMenu(): PauseMenu {
  let ctx: AppContext | null = null;
  let el: HTMLElement | null = null;
  let who: HTMLElement | null = null;
  let resumeBtn: HTMLButtonElement | null = null;
  let visible = false;
  /** performance.now() time at which the refusal note expires; 0 = no note shown. */
  let noteUntil = 0;

  function describePauser(c: AppContext): void {
    noteUntil = 0;
    if (!who) return;
    const by = c.session.pausedBy;
    who.className = 'pause-who' + (by === 0 ? ' p1' : by === 1 ? ' p2' : '');
    who.textContent = by >= 0 ? `Paused by Player ${by + 1}` : 'Game paused';
  }

  function showRefusal(c: AppContext): void {
    if (!who) return;
    who.textContent = refusalMessage(c.session.pausedBy);
    noteUntil = performance.now() + REFUSAL_NOTE_MS;
  }

  return {
    mount(root, c) {
      injectStyle('pause', CSS);
      ctx = c;
      resumeBtn = createButton('Resume', () => {
        if (!c.session.resume(uiHumanOf(c))) {
          c.audio.playUi(UiSound.ERROR);
          showRefusal(c);
        }
      }, { testId: 'pause-resume', variant: 'primary', autofocus: true, ctx: c });
      who = h('p', { class: 'pause-who', text: '' });
      el = h(
        'div',
        { class: 'pause-overlay', testId: 'pause-menu', attrs: { role: 'dialog', 'aria-label': 'Paused' } },
        h(
          'div',
          { class: 'ui-panel' },
          h('h2', { class: 'ui-title', text: 'Paused' }),
          who,
          h(
            'div',
            { class: 'ui-col' },
            resumeBtn,
            createButton('Restart match', () => c.session.restart(), { testId: 'pause-restart', ctx: c }),
            createButton('Quit to menu', () => c.session.quit(), { testId: 'pause-quit', ctx: c }),
          ),
        ),
      );
      el.hidden = true;
      root.append(el);
    },
    show() {
      if (!ctx || !el || visible) return;
      visible = true;
      el.hidden = false;
      describePauser(ctx);
      try {
        ctx.focus.attach(el);
        if (resumeBtn) ctx.focus.focus(resumeBtn);
      } catch {
        /* focus navigator not ready */
      }
    },
    hide() {
      if (!ctx || !el || !visible) return;
      visible = false;
      el.hidden = true;
      try {
        ctx.focus.detach(el);
      } catch {
        /* ignore */
      }
    },
    update(nowMs) {
      if (noteUntil !== 0 && nowMs >= noteUntil && ctx) describePauser(ctx);
    },
    get visible() {
      return visible;
    },
    dispose() {
      if (visible && ctx && el) {
        try {
          ctx.focus.detach(el);
        } catch {
          /* ignore */
        }
      }
      el?.remove();
      el = null;
      ctx = null;
      visible = false;
      noteUntil = 0;
    },
  };
}
