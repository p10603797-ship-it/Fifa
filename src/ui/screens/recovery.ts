/**
 * [PLT-05] Recovery screen, shown by the global error handler (platform/recovery.ts) after it paused the match:
 * Resume, Restart match, Copy diagnostics, Main menu. WAVE 0 version by FND-04.
 *
 * Resume (button or Back) first leaves recovery the way the player came in: the router pops back to the screen
 * underneath with its own params (match, half-time, the final full-time screen, or a mode's post-match screen).
 * Only then is the system pause lifted, so the session re-syncs the router to the match state while a match
 * screen is current (half-time comes back if the sim is still in HALF_TIME; a finished match lands on the final
 * full-time screen with Rematch / Change teams / Quit, never on a dead 'match' screen). A human pause stays in
 * place: the match screen then shows the pause menu.
 */
import type { AppContext, Screen, ScreenId, ScreenParams } from '../../contracts/app';
import { MatchPhase } from '../../contracts/enums';
import { createButton, copyText, h } from '../components';

function canResume(ctx: AppContext): boolean {
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

export function createRecoveryScreen(): Screen {
  let ctxRef: AppContext | null = null;
  /** True while Resume pops this screen: onBack then lets the router pop instead of resuming again. */
  let leaving = false;

  function resume(ctx: AppContext): void {
    if (leaving) return;
    leaving = true;
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
      root.classList.add('screen--overlay');
      const message = typeof params.message === 'string' ? params.message : 'Unknown error';
      const col = h('div', { class: 'ui-col' });
      if (canResume(ctx)) col.append(createButton('Resume', () => resume(ctx), { testId: 'recovery-resume', variant: 'primary', autofocus: true, ctx }));
      if (ctx.session.active || ctx.session.getSetup()) {
        col.append(createButton('Restart match', () => ctx.session.restart(), { testId: 'recovery-restart', ctx }));
      }
      const copyBtn = createButton('Copy diagnostics', () => {
        void copyText(ctx.diagnostics.report()).then((ok) => {
          copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
        });
      }, { testId: 'recovery-copy', ctx });
      col.append(copyBtn, createButton('Main menu', () => ctx.session.quit(), { testId: 'recovery-main', ctx }));
      root.append(
        h('h1', { class: 'ui-title', text: 'Something went wrong', testId: 'recovery-title' }),
        h('p', { class: 'ui-subtitle', text: 'The game paused to keep your match safe.' }),
        h('p', { class: 'ui-note', text: message, testId: 'recovery-message' }),
        col,
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
