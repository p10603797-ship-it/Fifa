/**
 * [UIX-12] Guided tutorial (brief section 11 Practice: "a guided tutorial for whichever input device is in use").
 *
 * The screen lists the nine steps (move, sprint, pass, through ball, shoot, tackle, switch, skill, set pieces) for the
 * device in use — touch, controller (PAD-07 glyphs for the pad's family) or keyboard — with each step's done state
 * from settings.tutorialDone. The device follows the last used input until the player picks one. Start runs a
 * practice match (MOD-04 buildPracticeSetup, PracticeKind.TUTORIAL) from the selected step; in the match the HUD coach
 * card (hud/hints.ts) shows the current step and TutorialTracker (tutorialSteps.ts) completes each step when the sim
 * shows it performed. Quitting the practice (pause menu) comes back here. Next / Skip: "Skip step" marks the selected
 * step done and selects the next open one; "Skip tutorial" marks every step done; "Reset" clears the progress.
 *
 * Every control is a [data-focus] button of at least 60 pt: the screen works by touch alone and by controller alone
 * (focus ring, list order top to bottom then the actions), and Back always works.
 */
import { MenuAction, type AppContext, type FrameInfo, type Screen, type ScreenParams } from '../../contracts/app';
import { PadFamily, PracticeKind } from '../../contracts/enums';
import { buildPracticeSetup } from '../../modes/practice';
import { effectiveFamily } from '../../input/pad/glyphs';
import { attachDotField, sharedDotField } from '../dotfield';
import { closeTopModal, createBackButton, createButton, createSegmented, h, injectStyle, setSelected, type Selector } from '../components';
import { GLYPH_CSS, chipElement, linesFor, renderHintLines } from '../hud/controlGlyphs';
import { humanDevice, type ControlDevice, type DeviceSpec } from '../hud/hudShared';
import {
  TUTORIAL_STEPS, TUTORIAL_STEP_COUNT, markStepDone, markTutorialDone, nextOpenStep, resetTutorial, tutorialComplete,
  tutorialProgress,
} from './tutorialSteps';

const CSS = `
.screen--tutorial { justify-content: flex-start; align-items: stretch; gap: var(--space-4);
  padding-top: calc(var(--safe-top, 0px) + var(--space-5)); }
.tut-head { display:flex; align-items: center; justify-content: space-between; gap: var(--space-5); min-height: var(--target);
  padding-left: calc(var(--target) * 1.8 + var(--space-4)); }
.tut-head .ui-title { font-size: var(--fs-xl); }
.tut-titles { display:flex; flex-direction:column; min-width: 0; }
.tut-sub { margin: 2px 0 0; color: var(--text-2); font-size: var(--fs-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tut-tools { display:flex; align-items:center; gap: var(--space-4); flex: none; }
.tut-tools .seg__label { display:none; }
.tut-progress { font-family: var(--font-num); font-variant-numeric: tabular-nums; color: var(--text-2); font-size: var(--fs-sm); white-space: nowrap; }
.tut-progress[data-complete] { color: var(--success); }
.tut-body { display:grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: var(--space-5); min-height: 0; flex: 1; }
.tut-list { display:flex; flex-direction:column; gap: var(--space-2); min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  touch-action: pan-y; padding: 4px; margin: -4px; }
.tut-step { appearance:none; -webkit-appearance:none; display:grid; grid-template-columns: 2.4em minmax(0,1fr) auto auto; flex: none;
  align-items:center; gap: var(--space-3); min-height: var(--target); padding: var(--space-2) var(--space-4);
  border-radius: var(--radius); border: var(--line) solid var(--hairline); background: var(--surface-1); color: var(--text-1);
  font: inherit; text-align: left; cursor: pointer; box-sizing: border-box; }
.tut-step[data-selected] { border-color: var(--ember); background: var(--ember-tint); }
.tut-step .ts-idx { font-family: var(--font-num); font-variant-numeric: tabular-nums; color: var(--text-3); font-size: var(--fs-sm); }
.tut-step .ts-title { font-weight: var(--fw-bold); font-size: var(--fs-md); white-space: nowrap; overflow:hidden; text-overflow: ellipsis; }
.tut-step .ts-keys { display:inline-flex; gap: 4px; font-size: var(--fs-sm); }
.tut-step .ts-state { font-size: var(--fs-xs); letter-spacing: var(--tracking-caps); text-transform: uppercase; color: var(--text-3); min-width: 4.2em; text-align: right; }
.tut-step[data-done] .ts-state { color: var(--success); }
.tut-step[data-next] .ts-state { color: var(--ember); }
.tut-detail { display:flex; flex-direction:column; gap: var(--space-4); padding: var(--space-5); border-radius: var(--radius-lg);
  background: var(--surface-1); border: var(--line) solid var(--hairline); min-height: 0; overflow-y: auto; }
.tut-detail-body { display:flex; flex-direction:column; gap: var(--space-3); }
.tut-detail .td-eyebrow { color: var(--ember); }
.tut-detail .td-title { margin: 0; font-size: var(--fs-lg); }
.tut-detail .td-goal { margin: 0; color: var(--text-2); }
.tut-detail .td-lines { display:flex; flex-direction:column; gap: var(--space-3); font-size: var(--fs-md); margin-top: var(--space-2); }
.tut-actions { display:flex; flex-direction:column; gap: var(--space-3); margin-top: auto; }
.tut-actions .tut-row { display:flex; gap: var(--space-3); }
.tut-actions .tut-row > .btn { flex: 1; white-space: nowrap; }
@media (max-width: 900px) {
  .tut-head { flex-wrap: wrap; }
  .tut-body { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-4); }
  .tut-step .ts-keys { display:none; }
}
`;

const DEVICE_LABEL: Readonly<Record<ControlDevice, string>> = { touch: 'Touch', pad: 'Controller', keyboard: 'Keyboard' };

/** Glyph family for the controller option: the last used pad's, else the first connected pad's (settings override applied). */
function padFamilyOf(ctx: AppContext): PadFamily {
  try {
    const override = ctx.settings.get().controls.pad.familyOverride;
    const list = ctx.devices.list();
    const last = ctx.devices.lastActive();
    const lastPad = list.find((d) => d.id === last && d.kind === 'pad');
    const pad = lastPad ?? list.find((d) => d.kind === 'pad' && d.connected);
    return pad ? effectiveFamily(pad.family, override) : effectiveFamily(PadFamily.GENERIC, override);
  } catch {
    return PadFamily.GENERIC;
  }
}

function specFor(ctx: AppContext, kind: ControlDevice): DeviceSpec {
  return { kind, family: kind === 'pad' ? padFamilyOf(ctx) : PadFamily.GENERIC };
}

function isDevice(v: unknown): v is ControlDevice {
  return v === 'touch' || v === 'pad' || v === 'keyboard';
}

/** How often (ms of frame time) the screen re-checks the last used device while the player has not picked one. */
const DEVICE_POLL_MS = 300;

export function createTutorialScreen(): Screen {
  let ctxRef: AppContext | null = null;
  let detachDots: (() => void) | null = null;
  let unsub: (() => void) | null = null;
  let offAction: (() => void) | null = null;
  let device: DeviceSpec = { kind: 'touch', family: PadFamily.GENERIC };
  let picked = false;
  let selected = 0;
  let pollT = 0;
  let lastActive: string | null = null;
  let list: HTMLElement | null = null;
  let detail: HTMLElement | null = null;
  let progressEl: HTMLElement | null = null;
  let subEl: HTMLElement | null = null;
  let startBtn: HTMLButtonElement | null = null;
  let deviceSel: Selector<ControlDevice> | null = null;
  let rows: HTMLButtonElement[] = [];

  function renderAll(): void {
    const ctx = ctxRef;
    if (!ctx || !list || !detail) return;
    const done = tutorialProgress(ctx.settings, device.kind);
    const complete = tutorialComplete(ctx.settings, device.kind) || done.every(Boolean);
    const next = nextOpenStep(done, 0);
    const nDone = done.filter(Boolean).length;
    if (progressEl) {
      progressEl.textContent = complete ? `Complete · ${TUTORIAL_STEP_COUNT}/${TUTORIAL_STEP_COUNT}` : `${nDone}/${TUTORIAL_STEP_COUNT} done`;
      if (complete) progressEl.dataset.complete = '';
      else delete progressEl.dataset.complete;
    }
    if (subEl) subEl.textContent = `${DEVICE_LABEL[device.kind]} controls. Steps finish as you play them in a practice match.`;
    // Keep the focused row focused across re-renders (same index).
    rows = [];
    const items: HTMLElement[] = [];
    TUTORIAL_STEPS.forEach((st, i) => {
      const keys = h('span', { class: 'ts-keys' });
      const first = linesFor(st.lines, device)[0];
      if (first) for (const k of first.keys) keys.append(chipElement(device, k));
      const state = done[i] ? 'Done' : i === next ? 'Next' : '';
      const b = h('button', { class: 'tut-step', testId: `tut-step-${st.id}` },
        h('span', { class: 'ts-idx', text: String(i + 1).padStart(2, '0') }), h('span', { class: 'ts-title', text: st.title }), keys,
        h('span', { class: 'ts-state', text: state }));
      b.type = 'button';
      b.dataset.focus = '';
      if (done[i]) b.dataset.done = '';
      if (i === next) b.dataset.next = '';
      if (i === selected) {
        setSelected(b, true);
        b.dataset.focusDefault = '';
      }
      b.setAttribute('aria-label', `Step ${i + 1}: ${st.title}${done[i] ? ', done' : ''}`);
      b.addEventListener('click', (e) => {
        e.preventDefault();
        if (selected === i) return;
        selected = i;
        for (let j = 0; j < rows.length; j++) setSelected(rows[j]!, j === i);
        renderDetail(done);
      });
      rows.push(b);
      items.push(b);
    });
    list.replaceChildren(...items);
    renderDetail(done);
  }

  function renderDetail(done: readonly boolean[]): void {
    if (!detail) return;
    const st = TUTORIAL_STEPS[selected]!;
    const lines = h('div', { class: 'td-lines', testId: 'tut-lines' });
    renderHintLines(lines, device, linesFor(st.lines, device), 'tl');
    detail.replaceChildren(
      h('span', { class: 'td-eyebrow eyebrow', text: `Step ${selected + 1} of ${TUTORIAL_STEP_COUNT}${done[selected] ? ' · done' : ''}` }),
      h('h2', { class: 'td-title', text: st.title, testId: 'tut-detail-title' }),
      h('p', { class: 'td-goal', text: st.goal }),
      lines,
    );
    if (startBtn) startBtn.textContent = done.every(Boolean) ? 'Practise again' : `Start step ${selected + 1}`;
  }

  function setDevice(kind: ControlDevice, byPlayer: boolean): void {
    if (!ctxRef) return;
    if (byPlayer) picked = true;
    const spec = specFor(ctxRef, kind);
    if (spec.kind === device.kind && spec.family === device.family) return;
    device = spec;
    deviceSel?.set(kind);
    const done = tutorialProgress(ctxRef.settings, kind);
    const open = nextOpenStep(done, 0);
    selected = open >= 0 ? open : 0;
    renderAll();
  }

  function start(): void {
    const ctx = ctxRef;
    if (!ctx || ctx.session.active) return;
    ctx.audio.unlock().catch(() => undefined);
    const setup = buildPracticeSetup(ctx, PracticeKind.TUTORIAL);
    const base = setup.modeData && typeof setup.modeData === 'object' ? (setup.modeData as Record<string, unknown>) : {};
    setup.modeData = { ...base, tutorial: { device: device.kind, startStep: selected } };
    const prevFinish = setup.onFinish;
    const kind = device.kind;
    setup.onFinish = (summary, quit) => {
      try {
        prevFinish?.(summary, quit);
      } finally {
        ctx.router.go('tutorial', { device: kind });
      }
    };
    ctx.session.start(setup);
  }

  return {
    id: 'tutorial',
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      injectStyle('hud-glyphs', GLYPH_CSS);
      injectStyle('screen-tutorial', CSS);
      ctxRef = ctx;
      root.classList.add('screen--tutorial');
      detachDots = attachDotField(root);
      sharedDotField().setActive(true);
      picked = isDevice(params.device);
      const kind: ControlDevice = isDevice(params.device) ? params.device : humanDevice(ctx, 0).kind;
      device = specFor(ctx, kind);
      try {
        lastActive = ctx.devices.lastActive();
      } catch {
        lastActive = null;
      }
      const done = tutorialProgress(ctx.settings, device.kind);
      const open = nextOpenStep(done, 0);
      selected = open >= 0 ? open : 0;

      deviceSel = createSegmented<ControlDevice>('Device', [
        { value: 'touch', label: DEVICE_LABEL.touch, testId: 'tut-device-touch' },
        { value: 'pad', label: DEVICE_LABEL.pad, testId: 'tut-device-pad' },
        { value: 'keyboard', label: DEVICE_LABEL.keyboard, testId: 'tut-device-keyboard' },
      ], device.kind, (v) => setDevice(v, true), { testId: 'tut-device', ctx, ariaLabel: 'Device' });

      progressEl = h('span', { class: 'tut-progress', testId: 'tut-progress' });
      subEl = h('p', { class: 'tut-sub' });
      const head = h('header', { class: 'tut-head' },
        h('div', { class: 'tut-titles' }, h('h1', { class: 'ui-title', text: 'Tutorial', testId: 'tutorial-title' }), subEl),
        h('div', { class: 'tut-tools' }, progressEl, deviceSel.el));

      list = h('div', { class: 'tut-list', testId: 'tut-list', attrs: { 'data-focus-group': 'y', role: 'list' } });
      detail = h('div', { class: 'tut-detail-body' });
      startBtn = createButton('Start', start, { testId: 'tut-start', variant: 'primary', ctx, size: 'lg' });
      const skipStep = createButton('Skip step', () => {
        const c = ctxRef;
        if (!c) return;
        markStepDone(c.settings, device.kind, TUTORIAL_STEPS[selected]!.id);
        const d = tutorialProgress(c.settings, device.kind);
        const open2 = nextOpenStep(d, selected + 1);
        if (open2 >= 0) selected = open2;
        renderAll();
      }, { testId: 'tut-skip-step', ctx });
      const skipAll = createButton('Skip all', () => {
        const c = ctxRef;
        if (!c) return;
        markTutorialDone(c.settings, device.kind);
        c.router.back();
      }, { testId: 'tut-skip-all', ctx, variant: 'ghost', ariaLabel: 'Skip the tutorial' });
      const reset = createButton('Reset', () => {
        const c = ctxRef;
        if (!c) return;
        resetTutorial(c.settings, device.kind);
        selected = 0;
        renderAll();
      }, { testId: 'tut-reset', ctx, variant: 'ghost' });
      const actions = h('div', { class: 'tut-actions' }, startBtn, h('div', { class: 'tut-row' }, skipStep, skipAll, reset));
      const side = h('section', { class: 'tut-detail', testId: 'tut-detail' }, detail, actions);
      root.append(head, h('div', { class: 'tut-body' }, list, side), createBackButton(ctx));
      renderAll();
      // Controller order: RIGHT from a step goes to Start (not the device tabs above), LEFT from the actions comes
      // back to the selected step.
      const nav = ctx.focus as unknown as { current?: HTMLElement | null; ringVisible?: boolean };
      offAction = ctx.focus.onAction((a) => {
        const cur = nav.current;
        if (nav.ringVisible !== true || !cur || !root.contains(cur)) return false;
        if (a === MenuAction.RIGHT && cur.classList.contains('tut-step') && startBtn) {
          ctx.focus.focus(startBtn);
          return true;
        }
        if (a === MenuAction.LEFT && (cur === startBtn || cur === skipStep) && rows[selected]) {
          ctx.focus.focus(rows[selected]!);
          return true;
        }
        return false;
      });
      // Progress written elsewhere (the coach card) or by another control shows at once.
      unsub = ctx.settings.subscribe(() => renderAll());
    },
    unmount() {
      unsub?.();
      unsub = null;
      offAction?.();
      offAction = null;
      detachDots?.();
      detachDots = null;
      ctxRef = null;
      list = detail = progressEl = subEl = startBtn = null;
      deviceSel = null;
      rows = [];
    },
    onBack() {
      return closeTopModal();
    },
    onFrame(frame: FrameInfo) {
      if (detachDots) sharedDotField().frame(frame.nowMs);
      if (picked || !ctxRef) return;
      pollT += frame.dtMs > 0 ? frame.dtMs : 0;
      if (pollT < DEVICE_POLL_MS) return;
      pollT = 0;
      let last: string | null = null;
      try {
        last = ctxRef.devices.lastActive();
      } catch {
        last = null;
      }
      if (last === lastActive) return;
      lastActive = last;
      const info = last ? ctxRef.devices.list().find((d) => d.id === last) : undefined;
      if (info) setDevice(info.kind, false);
    },
  };
}
