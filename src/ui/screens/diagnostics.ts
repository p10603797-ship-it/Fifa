/**
 * [PLT-05] Settings > Diagnostics (brief section 12): version, benchmark, input tester, replay save and load, the
 * copy-able diagnostics report and the debug overlay toggle.
 *
 * - Version: game, sim and storage mode at the top.
 * - Run benchmark: starts the FND-06 benchmark in place (platform/benchHook.ts startBench: fixed-seed bot match,
 *   results panel with Copy Results at the end). The same benchmark runs at ?bench=1.
 * - Input tester (view): a touch area that draws every active pointer with its id, one row per connected pad
 *   (buttons lit while pressed with analog values, axes as bars and numbers) and the keys held on a keyboard.
 *   While it is open every menu action is consumed (so pad and keyboard presses are only shown, never navigate);
 *   leave with Close (touch), Escape (keyboard: the router's Back reaches onBack) or by holding pad button 1 (B /
 *   Circle) for LOCAL_TUNING.padHoldCloseMs.
 * - Save replay: the app-wide recorder's replay of the current or last match (platform/replayRecorder.ts) downloads
 *   as JSON through a Blob link. Load replay: a file input; a valid replay plays in a match session
 *   (replaySetup: recorded inputs only) and the verdict (matched / diverged at tick N) is logged to diagnostics,
 *   shown as a toast and kept in lastReplayCheck().
 */
import type { AppContext, FrameInfo, Screen } from '../../contracts/app';
import { GAME_NAME, GAME_VERSION, SIM_VERSION } from '../../contracts/constants';
import { startBench } from '../../platform/benchHook';
import {
  appReplayRecorder, describeReplayCheck, replayFileName, replayPlaybackProblem, replaySetup, type ReplayCheck,
} from '../../platform/replayRecorder';
import type { Replay } from '../../sim/replay';
import { createButton, copyText, createBackButton, h, injectStyle, showToast } from '../components';
import { createCreditsView } from '../../platform/licences';
import { createPointerTracker, readPads, type PadLike } from '../debugOverlay';

const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: diagnostics UI)
  /** Holding pad button 1 (B / Circle) this long closes the input tester, ms. */
  padHoldCloseMs: 1000,
} as const;

let lastCheck: Readonly<ReplayCheck> | null = null;

/** Verdict of the last replay loaded from this screen (null until one finished or diverged). */
export function lastReplayCheck(): Readonly<ReplayCheck> | null {
  return lastCheck;
}

function matchActive(ctx: Pick<AppContext, 'session'>): boolean {
  try {
    return ctx.session.active === true;
  } catch {
    return false;
  }
}

/** Note shown when a screen reachable from the pause menu would start a new session over a match in progress. */
export const MATCH_IN_PROGRESS_NOTE = 'A match is in progress: quit it from the pause menu first.';

/**
 * [QF-12] Settings (and so Diagnostics and the Tutorial) can be opened from the pause menu. Starting the benchmark, a
 * replay or the tutorial from there used to end the paused match without a word (session.start tears it down) or, for
 * the tutorial, do nothing at all. Returns true (and says why) when a match is in progress, so the caller does not
 * start anything.
 */
export function refuseWhileMatch(ctx: Pick<AppContext, 'session'>): boolean {
  if (!matchActive(ctx)) return false;
  showToast(MATCH_IN_PROGRESS_NOTE, { kind: 'warning', testId: 'match-in-progress' });
  return true;
}

/** Parse and validate a replay file's text: the replay, or the problem in words. Pure. */
export function readReplayText(text: string): { replay: Replay } | { problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problem: 'not a JSON file' };
  }
  const problem = replayPlaybackProblem(raw);
  return problem === null ? { replay: raw as Replay } : { problem };
}

/** Start playing `replay` in the app session; the verdict is logged and toasted. */
export function playReplayInSession(ctx: AppContext, replay: Replay): void {
  lastCheck = null;
  const { setup } = replaySetup(replay, {
    onResult(c) {
      lastCheck = { ...c };
      const line = describeReplayCheck(c);
      ctx.diagnostics.log(c.verdict === 'match' ? 'replay' : 'warn', line);
      showToast(line, { kind: c.verdict === 'match' ? 'success' : 'warning', testId: 'replay-verdict' });
    },
  });
  ctx.diagnostics.log('replay', `playing replay: seed ${replay.seed >>> 0}, ${replay.ticks} ticks`);
  ctx.session.start(setup);
}

/** Offer `text` as a file download (Blob link). Returns false when the browser has no Blob URLs. */
export function downloadText(fileName: string, text: string, type = 'application/json'): boolean {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') return false;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

const CSS = `
.diag { width: min(980px, 100%); max-height: 100%; display: flex; flex-direction: column; align-items: center;
  gap: var(--space-4, 16px); }
.diag-version { margin: 0; font: 13px/1.3 var(--font-num, monospace); color: var(--text-2, #c9c6c0); }
.diag-actions { max-width: 100%; }
.diag-status { min-height: 1.3em; margin: 0; font-size: 14px; color: var(--text-2, #c9c6c0); }
.diag-tester { width: 100%; display: flex; flex-direction: column; gap: var(--space-3, 12px); min-height: 0; flex: 1; }
.diag-touch { position: relative; flex: 1; min-height: 160px; border-radius: var(--radius-lg, 16px);
  border: 1px dashed var(--hairline-strong, rgba(244,241,236,.25)); background: var(--surface-1, #12121a);
  touch-action: none; overflow: hidden; color: var(--text-3, #8d8a86); display: flex; align-items: center;
  justify-content: center; font-size: 14px; }
.diag-dot { position: absolute; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%;
  background: rgba(255,107,53,.35); border: 2px solid var(--ember, #ff6b35); pointer-events: none;
  display: flex; align-items: center; justify-content: center; font: 600 12px var(--font-num, monospace); color: #fff; }
.diag-pads { display: flex; flex-direction: column; gap: var(--space-2, 8px); font: 12px/1.3 var(--font-num, monospace); }
.diag-pad { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.diag-pad-id { width: 100%; color: var(--text-2, #c9c6c0); }
.diag-btn { min-width: 26px; height: 22px; padding: 0 3px; box-sizing: border-box; border-radius: 5px; display: inline-flex;
  align-items: center; justify-content: center; border: 1px solid var(--hairline-strong, rgba(244,241,236,.25));
  color: var(--text-3, #8d8a86); }
.diag-btn[data-pressed] { background: var(--ember, #ff6b35); color: #12080a; border-color: transparent; }
.diag-axis { width: 64px; height: 22px; position: relative; border-radius: 5px; background: var(--surface-2, #1c1c26);
  overflow: hidden; }
.diag-axis > i { position: absolute; top: 0; bottom: 0; left: 50%; background: var(--cyan, #2ee6d6); }
.diag-axis > b { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-weight: 400; color: #fff; }
.diag-keys { font: 12px/1.3 var(--font-num, monospace); color: var(--text-2, #c9c6c0); min-height: 1.3em; }
`;

/** Hold detector: step(down, now) is true once `down` has been held for holdMs after being seen up. Pure. */
export function createHoldDetector(holdMs: number): { step(down: boolean, nowMs: number): boolean; reset(): void } {
  let armed = false;
  let since = -1;
  return {
    step(down, nowMs) {
      if (!armed) {
        if (!down) armed = true;
        return false;
      }
      if (!down) {
        since = -1;
        return false;
      }
      if (since < 0) since = nowMs;
      if (nowMs - since >= holdMs) {
        armed = false;
        since = -1;
        return true;
      }
      return false;
    },
    reset() {
      armed = false;
      since = -1;
    },
  };
}

interface PadView { root: HTMLElement; btns: HTMLElement[]; axes: { bar: HTMLElement; label: HTMLElement }[]; key: string }

export function createDiagnosticsScreen(): Screen {
  let ctxRef: AppContext | null = null;
  const cleanups: (() => void)[] = [];
  let testerOpen = false;
  let closeTester: (() => void) | null = null;
  let frameHook: ((f: FrameInfo) => void) | null = null;

  return {
    id: 'diagnostics',
    mount(root: HTMLElement, ctx: AppContext) {
      ctxRef = ctx;
      injectStyle('diagnostics', CSS);
      const wrap = h('div', { class: 'diag' });
      const storage = ctx.settings.persistent ? 'storage persistent' : 'storage memory only';
      const version = h('p', { class: 'diag-version', text: `${GAME_NAME} ${GAME_VERSION} · sim ${SIM_VERSION} · ${storage}`, testId: 'diagnostics-version' });
      const status = h('p', { class: 'diag-status', testId: 'diagnostics-status', attrs: { role: 'status' } });
      const pre = h('pre', { class: 'ui-pre', text: ctx.diagnostics.report(), testId: 'diagnostics-report', attrs: { 'data-scroll': '' } });
      const refresh = (): void => {
        pre.textContent = ctx.diagnostics.report();
      };
      const say = (msg: string): void => {
        status.textContent = msg;
      };

      // ---------------------------------------------------------------- actions
      const benchBtn = createButton('Run benchmark', () => {
        if (refuseWhileMatch(ctx)) return;
        ctx.diagnostics.log('bench', 'benchmark started from Diagnostics');
        startBench(ctx);
      }, { testId: 'diagnostics-bench', ctx, hint: '90 s bot match' });

      const saveBtn = createButton('Save replay', () => {
        const rec = appReplayRecorder();
        const replay = rec?.snapshot() ?? null;
        if (!replay) {
          say('No replay yet: play a match first.');
          return;
        }
        const name = replayFileName(replay, new Date().toISOString().slice(0, 19));
        const ok = downloadText(name, JSON.stringify(replay));
        say(ok ? `Saved ${name} (${replay.ticks} ticks).` : 'This browser cannot save files.');
        ctx.diagnostics.log('replay', ok ? `saved ${name}` : 'replay save failed: no Blob URLs');
        refresh();
      }, { testId: 'diagnostics-replay-save', ctx });

      const fileInput = h('input', { testId: 'diagnostics-replay-file' });
      fileInput.type = 'file';
      fileInput.accept = '.json,application/json';
      fileInput.hidden = true;
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        void file.text().then((text) => {
          const res = readReplayText(text);
          if ('problem' in res) {
            say(`Cannot play this replay: ${res.problem}.`);
            ctx.diagnostics.log('warn', `replay load refused: ${res.problem}`);
            return;
          }
          if (refuseWhileMatch(ctx)) return;
          playReplayInSession(ctx, res.replay);
        }, (err: unknown) => say(`Cannot read the file: ${String(err)}`));
      });
      const loadBtn = createButton('Load replay', () => {
        if (refuseWhileMatch(ctx)) return;
        fileInput.click();
      }, { testId: 'diagnostics-replay-load', ctx });

      const copyBtn = createButton('Copy report', () => {
        refresh();
        void copyText(ctx.diagnostics.report()).then((ok) => {
          copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
        });
      }, { testId: 'diagnostics-copy', variant: 'primary', autofocus: true, ctx });
      const debugLabel = (): string => `Debug overlay: ${ctx.diagnostics.debug ? 'on' : 'off'}`;
      const debugBtn = createButton(debugLabel(), () => {
        ctx.diagnostics.setDebug(!ctx.diagnostics.debug);
        debugBtn.textContent = debugLabel();
      }, { testId: 'diagnostics-debug', ctx });
      // Third-party notices (postbuild writes them into dist/index.html; PLT-06 CR 2, SGN-05).
      const creditsBtn = createButton('Credits and licences', () => {
        const v = wrap.querySelector('[data-testid="credits-view"]');
        if (v) v.remove();
        else wrap.append(createCreditsView());
      }, { testId: 'diagnostics-credits', ctx });

      // ---------------------------------------------------------------- input tester
      const tester = h('div', { class: 'diag-tester', testId: 'diagnostics-tester' });
      tester.hidden = true;
      const touchArea = h('div', { class: 'diag-touch', testId: 'diagnostics-touch-area', text: 'Touch here with any number of fingers' });
      const padsBox = h('div', { class: 'diag-pads', testId: 'diagnostics-pads' });
      const keysLine = h('div', { class: 'diag-keys', testId: 'diagnostics-keys' });
      const closeBtn = createButton('Close tester', () => closeTester?.(), { testId: 'diagnostics-tester-close', ctx, hint: 'or hold B / Esc' });
      tester.append(touchArea, padsBox, keysLine, closeBtn);

      const tracker = createPointerTracker();
      const dots = new Map<number, HTMLElement>();
      const drawDots = (): void => {
        const rect = touchArea.getBoundingClientRect();
        const live = new Set<number>();
        for (const p of tracker.points()) {
          live.add(p.id);
          let d = dots.get(p.id);
          if (!d) {
            d = h('div', { class: 'diag-dot', text: String(p.id), attrs: { 'data-pointer': String(p.id) } });
            dots.set(p.id, d);
            touchArea.append(d);
          }
          d.style.left = `${p.x - rect.left}px`;
          d.style.top = `${p.y - rect.top}px`;
        }
        for (const [id, d] of dots) {
          if (!live.has(id)) {
            d.remove();
            dots.delete(id);
          }
        }
        touchArea.dataset.touches = String(live.size);
      };
      const onTouchPointer = (e: PointerEvent): void => {
        if (e.type === 'pointerdown') {
          try {
            touchArea.setPointerCapture(e.pointerId);
          } catch {
            /* synthetic pointers cannot be captured */
          }
        }
        if (e.cancelable) e.preventDefault();
        tracker.handle(e);
        drawDots();
      };
      for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'] as const) {
        touchArea.addEventListener(t, onTouchPointer);
      }

      const held = new Set<string>();
      const drawKeys = (): void => {
        keysLine.textContent = held.size > 0 ? `keys: ${[...held].join(' ')}` : 'keys: none held';
      };
      const onKey = (e: KeyboardEvent): void => {
        if (!testerOpen) return;
        const name = e.code || e.key;
        if (e.type === 'keydown') held.add(name);
        else held.delete(name);
        drawKeys();
      };
      const onBlur = (): void => {
        held.clear();
        tracker.clear();
        drawKeys();
        drawDots();
      };
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('keyup', onKey, true);
      window.addEventListener('blur', onBlur);
      cleanups.push(() => {
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('keyup', onKey, true);
        window.removeEventListener('blur', onBlur);
      });

      const padViews = new Map<number, PadView>();
      const renderPads = (pads: readonly PadLike[]): void => {
        const seen = new Set<number>();
        for (const p of pads) {
          seen.add(p.index);
          const key = `${p.id}|${p.buttons.length}|${p.axes.length}`;
          let v = padViews.get(p.index);
          if (!v || v.key !== key) {
            v?.root.remove();
            const rootEl = h('div', { class: 'diag-pad', attrs: { 'data-pad': String(p.index) } });
            rootEl.append(h('div', { class: 'diag-pad-id', text: `Pad ${p.index}: ${p.id}${p.mapping === 'standard' ? '' : ' (non-standard mapping)'}` }));
            const btns: HTMLElement[] = [];
            for (let i = 0; i < p.buttons.length; i++) {
              const b = h('span', { class: 'diag-btn', text: String(i), attrs: { 'data-button': String(i) } });
              btns.push(b);
              rootEl.append(b);
            }
            const axes: PadView['axes'] = [];
            for (let i = 0; i < p.axes.length; i++) {
              const bar = h('i');
              const label = h('b');
              const ax = h('span', { class: 'diag-axis', attrs: { 'data-axis': String(i) } }, bar, label);
              axes.push({ bar, label });
              rootEl.append(ax);
            }
            v = { root: rootEl, btns, axes, key };
            padViews.set(p.index, v);
            padsBox.append(rootEl);
          }
          for (let i = 0; i < p.buttons.length; i++) {
            const b = p.buttons[i]!;
            const el = v.btns[i]!;
            if (b.pressed !== el.hasAttribute('data-pressed')) el.toggleAttribute('data-pressed', b.pressed);
            const label = b.value > 0 && b.value < 1 ? b.value.toFixed(2) : String(i);
            if (el.textContent !== label) el.textContent = label;
          }
          for (let i = 0; i < p.axes.length; i++) {
            const a = Math.max(-1, Math.min(1, p.axes[i] ?? 0));
            const { bar, label } = v.axes[i]!;
            bar.style.left = a >= 0 ? '50%' : `${50 + a * 50}%`;
            bar.style.width = `${Math.abs(a) * 50}%`;
            const t = a.toFixed(2);
            if (label.textContent !== t) label.textContent = t;
          }
        }
        for (const [idx, v] of padViews) {
          if (!seen.has(idx)) {
            v.root.remove();
            padViews.delete(idx);
          }
        }
        padsBox.dataset.count = String(pads.length);
      };
      /** Hold-to-close on pad button 1; armed only once it was seen released (the opening press never counts). */
      const holdClose = createHoldDetector(LOCAL_TUNING.padHoldCloseMs);
      const emptyNote = h('div', { text: 'No controller yet: press a button on it to connect.', testId: 'diagnostics-no-pads' });

      // Shown in the tester, never navigates.
      const unsubscribeMenu = ctx.focus.onAction(() => testerOpen);
      cleanups.push(unsubscribeMenu);

      const openTester = (): void => {
        if (testerOpen) return;
        testerOpen = true;
        holdClose.reset();
        pre.hidden = true;
        tester.hidden = false;
        held.clear();
        drawKeys();
        frameHook = (f) => {
          const pads = readPads();
          renderPads(pads);
          if (pads.length === 0 && !emptyNote.isConnected) padsBox.append(emptyNote);
          else if (pads.length > 0 && emptyNote.isConnected) emptyNote.remove();
          if (holdClose.step(pads.some((p) => p.buttons[1]?.pressed === true), f.nowMs)) closeTester?.();
        };
        frameHook({ nowMs: 0, dtMs: 0, frame: 0, ticks: 0, paused: false });
        ctx.focus.focus(closeBtn);
        ctx.diagnostics.log('diagnostics', 'input tester opened');
      };
      closeTester = (): void => {
        if (!testerOpen) return;
        testerOpen = false;
        frameHook = null;
        tester.hidden = true;
        pre.hidden = false;
        tracker.clear();
        drawDots();
        refresh();
        ctx.focus.focus(testerBtn);
      };
      const testerBtn = createButton('Input tester', openTester, { testId: 'diagnostics-input', ctx, hint: 'touch, pads, keys' });

      wrap.append(
        h('h1', { class: 'ui-title', text: 'Diagnostics', testId: 'diagnostics-title' }),
        version,
        h('div', { class: 'ui-row diag-actions' }, benchBtn, testerBtn, saveBtn, loadBtn, copyBtn, debugBtn, creditsBtn),
        status,
        pre,
        tester,
        fileInput,
      );
      root.append(wrap, createBackButton(ctx));
    },
    unmount() {
      for (const c of cleanups.splice(0)) {
        try {
          c();
        } catch {
          /* keep cleaning */
        }
      }
      testerOpen = false;
      frameHook = null;
      closeTester = null;
      ctxRef = null;
    },
    onBack() {
      if (testerOpen && ctxRef) {
        closeTester?.();
        return true;
      }
      return false;
    },
    onFrame(frame) {
      frameHook?.(frame);
    },
  };
}
