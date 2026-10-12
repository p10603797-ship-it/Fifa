/**
 * [PLT-05] Runtime safety net (Wave 0 version by FND-04): a global error handler that logs to diagnostics, pauses
 * the match and shows the 'recovery' screen (resume, restart match, copy diagnostics).
 *
 * Also used directly by the app loop and router (reportError) so an exception in a frame never kills the loop.
 * Benign browser noise (ResizeObserver loop notices, cross-origin "Script error.") is logged but does not navigate.
 * Error storms are rate-limited: at most one navigation per second, and none while already on 'recovery'.
 */
import type { AppContext } from '../contracts/app';

export interface Recovery {
  /** Report an error from app code (loop frame, router, session loading). */
  reportError(err: unknown, where: string): void;
  /** Number of non-benign errors seen. */
  readonly errors: number;
  dispose(): void;
}

const BENIGN = [/ResizeObserver loop/i, /^Script error\.?$/i];

/** Message text for any thrown value. Pure. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** True for browser noise that must not interrupt play. Pure. */
export function isBenignError(message: string): boolean {
  return BENIGN.some((re) => re.test(message));
}

export function installRecovery(ctx: AppContext, opts: { now?: () => number } = {}): Recovery {
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  let handling = false;
  let lastNavAt = -Infinity;
  let errors = 0;

  function reportError(err: unknown, where: string): void {
    const message = describeError(err);
    ctx.diagnostics.log(isBenignError(message) ? 'warn' : 'error', `${where}: ${message}`, err instanceof Error ? err : undefined);
    if (isBenignError(message)) return;
    errors++;
    if (handling) return;
    handling = true;
    try {
      if (ctx.session.active && !ctx.session.paused) ctx.session.pause(-1);
      const t = now();
      if (ctx.router.current !== 'recovery' && t - lastNavAt > 1000) {
        lastNavAt = t;
        ctx.router.go('recovery', { message, where });
      }
    } catch (inner) {
      ctx.diagnostics.log('error', 'recovery failed', inner instanceof Error ? inner : String(inner));
    } finally {
      handling = false;
    }
  }

  const onError = (e: ErrorEvent): void => {
    reportError(e.error ?? e.message, 'window.onerror');
  };
  const onRejection = (e: PromiseRejectionEvent): void => {
    reportError(e.reason, 'unhandledrejection');
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
  }

  return {
    reportError,
    get errors() {
      return errors;
    },
    dispose() {
      if (typeof window !== 'undefined') {
        window.removeEventListener('error', onError);
        window.removeEventListener('unhandledrejection', onRejection);
      }
    },
  };
}
