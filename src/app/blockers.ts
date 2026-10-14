/**
 * [QF-5] Reasons a match may not run, combined into the one session flag (AppSession.setBlocked).
 *
 * A blocked session pauses (system pause) and refuses resume until every reason is gone; the pause menu then resumes
 * as usual (never auto-resume). Reasons:
 *  - 'portrait' and 'tooSmall' (platform/ipados.ts): the rotate card is up;
 *  - 'gpu': the WebGL context is lost (GameRenderer.onContextLost) until it is restored and rebuilt
 *    (onContextRestored). BRIEF section 3: "Pause, restore, rebuild GPU resources, then resume from the pause menu";
 *    render/index.ts: "The session must not resume while contextLost is true". A Resume pressed in between would run
 *    the match with nothing drawn.
 * Allocation-free after creation; not per frame.
 */
export type BlockReason = 'portrait' | 'tooSmall' | 'gpu';

export interface Blockers {
  /** Turn one reason on or off; the combined flag goes to `apply` only when it changes. */
  set(reason: BlockReason, on: boolean): void;
  has(reason: BlockReason): boolean;
  /** True while any reason is on. */
  readonly blocked: boolean;
}

export function createBlockers(apply: (blocked: boolean) => void): Blockers {
  const on: Record<BlockReason, boolean> = { portrait: false, tooSmall: false, gpu: false };
  let blocked = false;
  return {
    set(reason, value) {
      on[reason] = !!value;
      const b = on.portrait || on.tooSmall || on.gpu;
      if (b === blocked) return;
      blocked = b;
      apply(b);
    },
    has: (reason) => on[reason],
    get blocked() {
      return blocked;
    },
  };
}

/**
 * [QF-5] True while a match is being played or is about to start (its loading screen): the update toast waits
 * (platform/pwa.ts RegisterOptions.isBusy), so it never lands on the scoreboard at kick-off and a stray touch never
 * reloads away a match. Paused matches, half-time / full-time screens and the menus are not busy.
 */
export function isPlayBusy(
  session: { readonly loading: boolean; readonly ticking: boolean },
  router: { readonly current: string | null },
): boolean {
  return session.loading || (session.ticking && router.current === 'match');
}
