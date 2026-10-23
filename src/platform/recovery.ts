/**
 * [PLT-05] Runtime safety net (brief section 14 point 8): a global error handler that logs to diagnostics, pauses
 * the match and shows the 'recovery' screen (Resume if the state is sane, Restart match, Copy diagnostics, Main menu).
 *
 * - window 'error' and 'unhandledrejection' plus reportError (the app loop, router and session call it directly, so
 *   an exception in a frame never kills the loop) all end here.
 * - Benign browser noise (ResizeObserver loop notices, cross-origin "Script error.") is logged as a warning and never
 *   navigates.
 * - Loop guard: a re-entrant report is only counted; at most one navigation per LOCAL_TUNING.navIntervalMs (unless
 *   the player resumed since the last one) and none while 'recovery' is already shown. If the recovery screen itself fails (its mount / onBack / unmount throws, or
 *   the router could not show it), or recovery was shown LOCAL_TUNING.stormCount times within
 *   LOCAL_TUNING.stormWindowMs, a static DOM fallback (no router, no screens) replaces it: Reload and Copy
 *   diagnostics. Nothing navigates after that.
 * - Resume is offered only when the session has a state that passes isStateSane (finite numbers, ball and players
 *   inside the world bounds) and the same error has not come straight back after the last resume
 *   (LOCAL_TUNING.repeatWindowMs, LOCAL_TUNING.maxRepeats): an error that fires every frame offers Restart and Main
 *   menu instead of a Resume that can only fail again.
 * - Also installs the app-wide replay recorder (platform/replayRecorder.ts) and adds the Device, Match (seed, tick,
 *   phase, state hash) and Replay sections to the diagnostics report. With `attach: false` (the app, INT-B) the
 *   recorder is fed by the caller (SessionDeps.onTick) instead of a wrapped session afterTick.
 */
import type { AppContext } from '../contracts/app';
import { WORLD_MAX_X, WORLD_MAX_Y, WORLD_MAX_Z, WORLD_MIN_X, WORLD_MIN_Z } from '../contracts/constants';
import type { ReadonlySimState, SimState } from '../contracts/state';
import { hashHex, hashState } from '../sim/core/hash';
import type { DiagnosticsImpl } from './diagnostics';
import {
  appReplayRecorder, attachReplayRecorder, createLiveReplayRecorder, setAppReplayRecorder, type LiveReplayRecorder,
} from './replayRecorder';

const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: platform, crash recovery)
  /** Shortest time between two navigations to the recovery screen, ms. */
  navIntervalMs: 1000,
  /** Recovery shown this many times ... */
  stormCount: 5,
  /** ... within this window switches to the static fallback, ms. */
  stormWindowMs: 20_000,
  /** An error this soon after a Resume counts as the same error coming back, ms. */
  repeatWindowMs: 3000,
  /** After this many errors straight after a Resume, Resume is no longer offered. */
  maxRepeats: 2,
  /** Slack around the world bounds for the sanity check (bodies may overlap the boards a little), m. */
  boundsSlackM: 2,
} as const;

export interface Recovery {
  /** Report an error from app code (loop frame, router, session loading). */
  reportError(err: unknown, where: string): void;
  /** Number of non-benign errors seen. */
  readonly errors: number;
  dispose(): void;
}

export interface RecoveryImpl extends Recovery {
  /** Message and location of the latest non-benign error, or null. */
  readonly lastError: { message: string; where: string } | null;
  /** True when Resume may be offered: a sane match state and no error loop after resuming. */
  canResume(): boolean;
  /** The recovery screen calls this when the player resumes (starts the repeat window). */
  noteResume(): void;
  /** True once the static fallback is shown (nothing navigates any more). */
  readonly fatal: boolean;
  /** The app-wide replay recorder. */
  readonly replay: LiveReplayRecorder;
}

export interface RecoveryOptions {
  now?: () => number;
  /** Install window listeners (default true when a window exists). */
  listen?: boolean;
  /** Where the static fallback goes (default document.body). */
  fallbackHost?: () => HTMLElement | null;
  /** Reload for the fallback button (default location.reload). */
  reload?: () => void;
  /** Recorder to use (tests); default a new live recorder. */
  recorder?: LiveReplayRecorder;
  /**
   * Wrap the session's afterTick to feed the recorder (default true). The app passes false and feeds the recorder from
   * its own per-tick hook (SessionDeps.onTick), so recovery never patches the session.
   */
  attach?: boolean;
}

const BENIGN = [/ResizeObserver loop/i, /^Script error\.?$/i];

/** Message text for any thrown value. Pure. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  if (err === undefined) return 'undefined';
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    try {
      return String(err);
    } catch {
      return 'unprintable error';
    }
  }
}

/** True for browser noise that must not interrupt play. Pure. */
export function isBenignError(message: string): boolean {
  return BENIGN.some((re) => re.test(message));
}

/** True when an error came from the recovery screen itself. Pure. */
export function isRecoveryScreenError(where: string): boolean {
  return /\brecovery\b/.test(where);
}

function finiteFields(o: unknown): boolean {
  if (typeof o !== 'object' || o === null) return true;
  const rec = o as Record<string, unknown>;
  for (const k in rec) {
    const v = rec[k];
    if (typeof v === 'number' && !Number.isFinite(v)) return false;
  }
  return true;
}

function inWorld(x: unknown, z: unknown, y?: unknown): boolean {
  const s = LOCAL_TUNING.boundsSlackM;
  if (typeof x !== 'number' || typeof z !== 'number') return true;
  if (x < WORLD_MIN_X - s || x > WORLD_MAX_X + s || z < WORLD_MIN_Z - s || z > WORLD_MAX_Z + s) return false;
  return typeof y !== 'number' || (y > -s && y < WORLD_MAX_Y + s);
}

/**
 * Cheap sanity check before Resume is offered: every number of the match, ball, teams, controllers and players is
 * finite and the ball and every player are inside the world bounds. Pure; allocation-free.
 */
export function isStateSane(s: ReadonlySimState | null): boolean {
  if (!s || typeof s !== 'object') return false;
  if (!Number.isFinite(s.tick) || s.tick < 0) return false;
  if (!finiteFields(s.match) || !finiteFields(s.ball)) return false;
  if (!inWorld(s.ball.x, s.ball.z, s.ball.y)) return false;
  for (let i = 0; i < s.teams.length; i++) if (!finiteFields(s.teams[i])) return false;
  for (let i = 0; i < s.ctrl.length; i++) if (!finiteFields(s.ctrl[i])) return false;
  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i] as unknown as Record<string, unknown>;
    if (!finiteFields(p)) return false;
    if (!inWorld(p.x, p.z)) return false;
  }
  return true;
}

let current: RecoveryImpl | null = null;

/** The installed recovery (the recovery screen reads canResume / noteResume), or null. */
export function currentRecovery(): RecoveryImpl | null {
  return current;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function installRecovery(ctx: AppContext, opts: RecoveryOptions = {}): RecoveryImpl {
  const now = opts.now ?? defaultNow;
  const T = LOCAL_TUNING;
  let handling = false;
  let lastNavAt = -Infinity;
  let errors = 0;
  let lastError: { message: string; where: string } | null = null;
  let resumedAt = -Infinity;
  let repeats = 0;
  const navTimes: number[] = [];
  let fatal = false;
  let fallbackEl: HTMLElement | null = null;
  const diag = ctx.diagnostics as Partial<DiagnosticsImpl> & AppContext['diagnostics'];

  const recorder = opts.recorder ?? createLiveReplayRecorder();
  setAppReplayRecorder(recorder);
  const attach = opts.attach !== false;
  const detachRecorder = attach
    ? attachReplayRecorder(ctx.session, recorder, (err) => {
      diag.log('error', `replay recorder stopped: ${describeError(err)}`);
    })
    : null;

  if (typeof diag.addSection === 'function') {
    diag.addSection('Device', () => {
      const p = ctx.platform;
      const sa = p.safeArea();
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
      return `iPad ${p.isIPad ? 'yes' : 'no'}, touch ${p.isTouch ? 'yes' : 'no'}, standalone ${p.isStandalone ? 'yes' : 'no'}, ` +
        `fullscreen API ${p.supportsFullscreen ? 'yes' : 'no'}, DPR ${dpr}, safe area ${sa.top}/${sa.right}/${sa.bottom}/${sa.left}`;
    });
    diag.addSection('Match', () => {
      const s = ctx.session.getState();
      if (!s) return 'none';
      let hash = 'n/a';
      try {
        hash = hashHex(hashState(s as unknown as SimState));
      } catch {
        /* hash unavailable */
      }
      return `seed ${s.config.seed >>> 0}, tick ${s.tick}, phase ${s.match.phase}, score ${s.teams[0]?.goals ?? '?'}-${s.teams[1]?.goals ?? '?'}, ` +
        `hash ${hash}, paused ${ctx.session.paused ? `yes (by ${ctx.session.pausedBy})` : 'no'}, sane ${isStateSane(s) ? 'yes' : 'NO'}`;
    });
    diag.addSection('Replay', () => (detachRecorder || !attach ? recorder.summary() : 'recorder unavailable (no session tick hook)'));
    diag.addSection('Recovery', () => `${errors} error(s)${lastError ? `, last at ${lastError.where}` : ''}${fatal ? ', fallback shown' : ''}`);
  }

  function showFallback(message: string): void {
    if (fatal) return;
    fatal = true;
    diag.log('error', 'recovery: showing the static fallback', message);
    if (typeof document === 'undefined') return;
    try {
      const host = opts.fallbackHost?.() ?? document.body;
      if (!host) return;
      const box = document.createElement('div');
      box.setAttribute('role', 'alert');
      box.setAttribute('data-testid', 'recovery-fallback');
      box.style.cssText =
        'position:fixed;inset:0;z-index:2147483600;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'gap:14px;padding:24px;background:#07070D;color:#F4F1EC;font:16px system-ui,sans-serif;text-align:center;pointer-events:auto;';
      const title = document.createElement('strong');
      title.textContent = 'DotKick hit an error it cannot recover from.';
      const msg = document.createElement('code');
      msg.textContent = message;
      msg.style.cssText = 'max-width:80vw;overflow-wrap:anywhere;opacity:.8;';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:12px;';
      const btnCss = 'min-height:60px;min-width:180px;padding:0 24px;border-radius:14px;border:0;font:600 16px system-ui,sans-serif;';
      const reload = document.createElement('button');
      reload.type = 'button';
      reload.textContent = 'Reload';
      reload.setAttribute('data-testid', 'recovery-fallback-reload');
      reload.style.cssText = btnCss + 'background:#FF6B35;color:#12080a;';
      reload.addEventListener('click', () => (opts.reload ?? (() => location.reload()))());
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy diagnostics';
      copy.style.cssText = btnCss + 'background:#2a2a35;color:#F4F1EC;';
      copy.addEventListener('click', () => {
        const text = ctx.diagnostics.report();
        const done = (ok: boolean): void => { copy.textContent = ok ? 'Copied' : 'Copy failed'; };
        try {
          if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
          else done(false);
        } catch {
          done(false);
        }
      });
      row.append(reload, copy);
      box.append(title, msg, row);
      host.appendChild(box);
      fallbackEl = box;
    } catch {
      /* nothing more we can do */
    }
  }

  function reportError(err: unknown, where: string): void {
    const message = describeError(err);
    const benign = isBenignError(message);
    try {
      diag.log(benign ? 'warn' : 'error', `${where}: ${message}`, err instanceof Error ? err : undefined);
    } catch {
      /* diagnostics must never take recovery down */
    }
    if (benign) return;
    errors++;
    lastError = { message, where };
    if (handling || fatal) return;
    handling = true;
    try {
      const t = now();
      if (t - resumedAt < T.repeatWindowMs) repeats++;
      try {
        if (ctx.session.active && !ctx.session.paused) ctx.session.pause(-1);
      } catch (inner) {
        diag.log('error', 'recovery: pause failed', inner instanceof Error ? inner : String(inner));
      }
      const onRecovery = ctx.router.current === 'recovery';
      if (onRecovery && isRecoveryScreenError(where)) {
        showFallback(message);
        return;
      }
      // Rate limit, except right after a deliberate Resume (the player must see an error that comes back).
      if (!onRecovery && (t - lastNavAt > T.navIntervalMs || resumedAt > lastNavAt)) {
        while (navTimes.length > 0 && t - navTimes[0]! > T.stormWindowMs) navTimes.shift();
        if (navTimes.length >= T.stormCount - 1) {
          showFallback(message);
          return;
        }
        navTimes.push(t);
        lastNavAt = t;
        ctx.router.go('recovery', { message, where });
      }
    } catch (inner) {
      try {
        diag.log('error', 'recovery failed', inner instanceof Error ? inner : String(inner));
      } catch {
        /* ignore */
      }
      showFallback(message);
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

  const listen = (opts.listen ?? true) && typeof window !== 'undefined';
  if (listen) {
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
  }

  const rec: RecoveryImpl = {
    reportError,
    get errors() {
      return errors;
    },
    get lastError() {
      return lastError;
    },
    get fatal() {
      return fatal;
    },
    get replay() {
      return recorder;
    },
    canResume() {
      if (fatal || repeats >= T.maxRepeats) return false;
      const s = ctx.session;
      return s.active && isStateSane(s.getState());
    },
    noteResume() {
      const t = now();
      if (t - resumedAt >= T.repeatWindowMs * 4) repeats = 0;
      resumedAt = t;
    },
    dispose() {
      if (listen) {
        window.removeEventListener('error', onError);
        window.removeEventListener('unhandledrejection', onRejection);
      }
      detachRecorder?.();
      if (appReplayRecorder() === recorder) setAppReplayRecorder(null);
      if (current === rec) current = null;
      fallbackEl?.remove();
      fallbackEl = null;
      for (const name of ['Device', 'Match', 'Replay', 'Recovery']) diag.removeSection?.(name);
    },
  };
  current = rec;
  return rec;
}
