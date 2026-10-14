/**
 * [PLT-05] Recovery screen, shown by the global error handler (platform/recovery.ts) after it paused the match:
 * Resume, Restart match, Copy diagnostics, Main menu.
 *
 * - Resume is offered only when platform/recovery.ts says so (currentRecovery().canResume(): the session has a match
 *   whose state passes isStateSane, and the error is not looping straight after resumes). Without an installed
 *   recovery it falls back to "a match is active and has a state".
 * - Resume (button or Back) first leaves recovery the way the player came in: the router pops back to the screen
 *   underneath with its own params (match, half-time, the final full-time screen, or a mode's post-match screen).
 *   Only then is the system pause lifted, so the session re-syncs the router to the match state while a match
 *   screen is current (half-time comes back if the sim is still in HALF_TIME; a finished match lands on the final
 *   full-time screen with Rematch / Change teams / Quit, never on a dead 'match' screen). A human pause stays in
 *   place: the match screen then shows the pause menu.
 * - Back without Resume available goes to the main menu (session.quit()).
 * - Copy diagnostics copies the full diagnostics report (platform/diagnostics.ts) with the Clipboard API and shows
 *   the report in a scrollable box when copying is refused (old Safari, insecure context) so it can be selected.
 */
import type { AppContext, Screen, ScreenId, ScreenParams } from '../../contracts/app';
import { MatchPhase } from '../../contracts/enums';
import { currentRecovery } from '../../platform/recovery';
import { createButton, copyText, h, injectStyle } from '../components';

/** Resume is offered: the installed recovery's verdict, or a match with a state when none is installed. */
export function canResume(ctx: Pick<AppContext, 'session'>): boolean {
  const rec = currentRecovery();
  if (rec) return rec.canResume();
  return ctx.session.active && ctx.session.getState() !== null;
}

/** What Resume does once recovery has been popped. */
export type ResumeNavigation = 'stay' | 'go-match' | 'replace-match';

const isMatchScreen = (id: ScreenId | null): boolean => id === 'match' || id === 'half-time' || id === 'full-time';

/**
 * Navigation for Resume after recovery was popped, given the screen now on top and whether the match has
 * finished. Pure.
 *  - A match screen: stay (the session re-syncs it).
 *  - A finished match on another real screen (a mode's post-match screen put there by setup.onFinish): stay.
 *  - The loading screen: replace it by 'match' (loading never stays in history under a running match).
 *  - Nothing usable (still 'recovery', empty, a menu under a running match): go to 'match'.
 */
export function resumeNavigation(current: ScreenId | null, finished: boolean): ResumeNavigation {
  if (isMatchScreen(current)) return 'stay';
  if (current === 'loading') return 'replace-match';
  if (finished && current !== null && current !== 'recovery') return 'stay';
  return 'go-match';
}

/**
 * Second half of Resume, run once recovery is no longer the top screen (or could not be popped): put a match
 * screen on top if needed, then lift the system pause. session.resume() re-syncs the router to the match state
 * even when nothing was paused (finished match). Uses only the contract API.
 */
export function completeRecoveryResume(ctx: Pick<AppContext, 'router' | 'session'>): void {
  const s = ctx.session;
  if (!s.active) return; // quit or restarted meanwhile
  const state = s.getState();
  if (!state) return;
  const nav = resumeNavigation(ctx.router.current, state.match.phase === MatchPhase.POST_MATCH);
  if (nav === 'go-match') ctx.router.go('match');
  else if (nav === 'replace-match') ctx.router.replace('match');
  s.resume(-1);
}

const CSS = `
.recovery-detail { max-width: min(720px, 86vw); max-height: 28vh; overflow: auto; margin: 0; padding: var(--space-3, 12px);
  border-radius: var(--radius-md, 12px); background: var(--surface-1, #12121a); color: var(--text-2, #c9c6c0);
  font: 12px/1.4 var(--font-num, monospace); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text;
  -webkit-user-select: text; touch-action: pan-y; pointer-events: auto; }
.recovery-where { opacity: .7; }
`;

export function createRecoveryScreen(): Screen {
  let ctxRef: AppContext | null = null;
  /** True while Resume pops this screen: onBack then lets the router pop instead of resuming again. */
  let leaving = false;

  function resume(ctx: AppContext): void {
    if (leaving) return;
    leaving = true;
    currentRecovery()?.noteResume();
    // Runs now from a button; from Back (inside the router's running navigation) it is queued and runs right after.
    ctx.router.back();
    if (ctx.router.current === 'recovery') {
      // The pop is still queued (Back key) or nothing is underneath: finish once the router is idle.
      queueMicrotask(() => completeRecoveryResume(ctx));
    } else {
      completeRecoveryResume(ctx);
    }
  }

  return {
    id: 'recovery',
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      ctxRef = ctx;
      leaving = false;
      injectStyle('recovery', CSS);
      root.classList.add('screen--overlay');
      const message = typeof params.message === 'string' && params.message !== '' ? params.message : 'Unknown error';
      const where = typeof params.where === 'string' ? params.where : '';
      const col = h('div', { class: 'ui-col' });
      const resumable = canResume(ctx);
      if (resumable) col.append(createButton('Resume', () => resume(ctx), { testId: 'recovery-resume', variant: 'primary', autofocus: true, ctx }));
      if (ctx.session.active || ctx.session.getSetup()) {
        col.append(createButton('Restart match', () => ctx.session.restart(), {
          testId: 'recovery-restart', variant: resumable ? 'secondary' : 'primary', autofocus: !resumable, ctx,
        }));
      }
      const detail = h('pre', { class: 'recovery-detail', testId: 'recovery-report', attrs: { 'data-scroll': '' } });
      detail.hidden = true;
      const copyBtn = createButton('Copy diagnostics', () => {
        const report = ctx.diagnostics.report();
        void copyText(report).then((ok) => {
          copyBtn.textContent = ok ? 'Copied' : 'Copy failed - select the text below';
          if (!ok) {
            detail.textContent = report;
            detail.hidden = false;
          }
        });
      }, { testId: 'recovery-copy', ctx });
      col.append(copyBtn, createButton('Main menu', () => ctx.session.quit(), { testId: 'recovery-main', ctx }));
      const note = h('p', { class: 'ui-note', testId: 'recovery-message' }, h('span', { text: message }));
      if (where) note.append(h('span', { class: 'recovery-where', text: ` (${where})` }));
      root.append(
        h('h1', { class: 'ui-title', text: 'Something went wrong', testId: 'recovery-title' }),
        h('p', {
          class: 'ui-subtitle',
          text: resumable ? 'The game paused to keep your match safe.'
            : ctx.session.active ? 'The match cannot continue safely. Restart it or go back to the menu.'
              : 'Copy the diagnostics to report it, then go back to the menu.',
        }),
        note,
        col,
        detail,
      );
    },
    unmount() {
      ctxRef = null;
    },
    onBack() {
      if (leaving) return false; // Resume is popping this screen
      const ctx = ctxRef;
      if (!ctx) return false;
      if (canResume(ctx)) resume(ctx);
      else ctx.session.quit();
      return true;
    },
  };
}
