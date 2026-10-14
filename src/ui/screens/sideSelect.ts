/**
 * [UIX-04] Side select and device assignment (BRIEF §11 Side select: "each connected input (Touch, Controller 1,
 * Controller 2, Keyboard) shows as an icon that slides left for home, right for away, or stays in the centre to sit
 * out. A side with no humans is played by the CPU. Player 1's marker is ember orange and player 2's is cyan.";
 * §11 same-iPad 1v1; §10 two pads bound by identity).
 *
 * Layout (original): three columns (home crest and code | Sit out | away crest and code, each side labelled CPU or
 * with its players' markers) and one row per input from ctx.devices (live: a controller appears when one of its
 * buttons is pressed, a disconnected one returns to the centre). Each input is a token that slides between the
 * three lanes. Rules and the result are in sideAssign.ts (max two humans, P1 = first assigned, two humans on the
 * same side allowed for co-op, Play a Friend needs two).
 *
 * Moving a token:
 *  - touch: drag any token to a lane, tap a lane of its row, or tap the arrows on the Touch token;
 *  - a controller moves ITS OWN token with its D-pad or left stick (read per pad from the pad manager, by identity);
 *  - the keyboard moves its own token with the arrow keys or A / D.
 * The menu's merged LEFT / RIGHT are consumed here (they never move focus on this screen); Up / Down move focus
 * (touch arrows, Continue, Back). A controller's very first press (the one that makes it appear) never confirms.
 *
 * Continue (when ready) writes MatchConfig.humans (side, assist and auto-switch from settings) and the
 * HumanBinding[] into the flow's MatchSetup and opens the next step (match settings).
 */
import type { AppContext, DeviceInfo, Screen, ScreenParams } from '../../contracts/app';
import { MenuAction, UiSound } from '../../contracts/app';
import { getPadManager, padPressedEdge, PadButton, type PadManager } from '../../input/pad/manager';
import { isEditableTarget } from '../../input/keyboard';
import { MENU_STICK_RELEASE, MENU_STICK_THRESHOLD } from '../../input/menuInput';
import { crestDataUrl } from '../../render/kits';
import { createButton, h, injectStyle, showToast } from '../components';
import { attachDotField, sharedDotField } from '../dotfield';
import { MODE_LABELS, createFlowTop, createStepDots, goNext, injectFlowStyle, readFlow } from './matchFlow';
import {
  applyAssignment, createSideModel, defaultLanes, findToken, humanIndexOf, moveToken, readiness, restoreFromSetup, setLane,
  sideHasHuman, syncDevices, type Lane, type MoveResult, type SideModel, type Token,
} from './sideAssign';

/** Keyboard keys that move the keyboard's own token. */
export const SIDE_KEYS: Readonly<Record<string, number>> = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };

/** Pointer travel (CSS px) before a press on a token becomes a drag. */
const DRAG_SLOP_PX = 8;

/**
 * Left / right step of one pad this poll: D-pad edges, or the left stick crossing MENU_STICK_THRESHOLD on its
 * dominant horizontal axis (held until it falls below MENU_STICK_RELEASE; no repeat). `held` is the stick state
 * (-1, 0, 1) from the previous poll; returns [step, newHeld]. Pure.
 */
export function padStep(pressed: number, prevPressed: number, lx: number, ly: number, held: number): [number, number] {
  const edge = pressed & ~prevPressed;
  let step = 0;
  if (edge & (1 << PadButton.DPAD_LEFT)) step = -1;
  else if (edge & (1 << PadButton.DPAD_RIGHT)) step = 1;
  let h2 = held;
  const ax = Math.abs(lx);
  if (h2 !== 0) {
    if (ax < MENU_STICK_RELEASE || Math.sign(lx) !== h2) h2 = 0;
  }
  if (h2 === 0 && ax >= MENU_STICK_THRESHOLD && ax >= Math.abs(ly)) {
    h2 = lx < 0 ? -1 : 1;
    if (step === 0) step = h2;
  }
  return [step, h2];
}

const ICONS: Readonly<Record<DeviceInfo['kind'], string>> = {
  touch:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 10.5V9a1.5 1.5 0 0 1 3 0v2"/><path d="M15 10.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.6a6 6 0 0 1-4.7-2.3L4.4 16a1.5 1.5 0 0 1 2.3-1.9L9 16.4V11"/></svg>',
  pad:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M7 7h10a5 5 0 0 1 4.9 6l-.8 4a2.5 2.5 0 0 1-4.3 1.1L14.6 16H9.4l-2.2 2.1A2.5 2.5 0 0 1 2.9 17l-.8-4A5 5 0 0 1 7 7z"/>' +
    '<path d="M7 10.5v3M5.5 12h3"/><circle cx="16" cy="11" r=".6" fill="currentColor"/><circle cx="17.8" cy="13" r=".6" fill="currentColor"/></svg>',
  keyboard:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10"/></svg>',
};

const CSS = `
.ss-board { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: var(--space-2); width: 100%; max-width: 1180px;
  margin: 0 auto; }
.ss-cols, .ss-lanes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.ss-cols { gap: 0; align-items: end; }
.ss-col { display: flex; align-items: center; justify-content: center; gap: var(--space-3); min-height: 56px; padding: 0 var(--space-3);
  min-width: 0; }
.ss-col img { width: 44px; height: 44px; display: block; }
.ss-col-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ss-col-side { font: 600 var(--fs-xs) / 1 var(--font-ui); letter-spacing: var(--tracking-caps); text-transform: uppercase; color: var(--text-3); }
.ss-col-code { font: 600 var(--fs-lg) / 1 var(--font-num); letter-spacing: 0.04em; }
.ss-ctrl { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: var(--radius-pill); background: var(--surface-3);
  font: 700 var(--fs-xs) / 1 var(--font-ui); letter-spacing: 0.06em; color: var(--text-2); }
.ss-ctrl .p1 { color: var(--p1); }
.ss-ctrl .p2 { color: var(--p2); }
.ss-col--centre .ss-col-side { color: var(--text-3); }
.ss-rows { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: var(--space-2);
  padding: 4px 0; }
.ss-row { position: relative; flex: 0 0 auto; height: 76px; }
.ss-lanes { position: absolute; inset: 0; border-radius: var(--radius); overflow: hidden; border: 1px solid var(--hairline); }
.ss-lane { background: var(--surface-1); cursor: pointer; }
.ss-lane + .ss-lane { border-left: 1px solid var(--hairline); }
.ss-lane--centre { background: var(--surface-0); }
.ss-slide { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none;
  transform: translateX(calc(var(--lane, 0) * 33.3333%)); transition: transform var(--dur) var(--ease); }
.ss-token { pointer-events: auto; position: relative; box-sizing: border-box; display: flex; align-items: center; gap: var(--space-2);
  width: min(300px, calc(33.3333% - 12px)); min-height: 64px; padding: 2px var(--space-2); border-radius: var(--radius);
  background: var(--surface-3); border: 2px solid var(--hairline-strong); color: var(--text-1); touch-action: none; cursor: grab;
  user-select: none; -webkit-user-select: none; }
.ss-token.is-dragging { cursor: grabbing; box-shadow: var(--shadow-2); }
.ss-token.is-p1 { border-color: var(--p1); }
.ss-token.is-p2 { border-color: var(--p2); }
.ss-token.is-off { opacity: 0.45; }
.ss-token-main { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; justify-content: center; gap: var(--space-2); }
.ss-icon { width: 26px; height: 26px; flex: 0 0 auto; color: var(--text-2); }
.ss-icon svg { width: 100%; height: 100%; display: block; }
.ss-token-text { display: flex; flex-direction: column; min-width: 0; }
.ss-token-label { font: 600 var(--fs-sm) / 1.15 var(--font-ui); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ss-token-sub { font: 400 var(--fs-xs) / 1.2 var(--font-ui); color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ss-marker { flex: 0 0 auto; min-width: 30px; padding: 5px 6px; border-radius: 8px; text-align: center; font: 700 var(--fs-xs) / 1 var(--font-num); }
.ss-token.is-p1 .ss-marker { background: var(--p1); color: var(--text-on-ember); }
.ss-token.is-p2 .ss-marker { background: var(--p2); color: var(--ink); }
.ss-token:not(.is-p1):not(.is-p2) .ss-marker { display: none; }
.btn.ss-arrow { flex: 0 0 auto; min-width: var(--target); width: var(--target); padding: 0; background: var(--surface-2); }
.btn.ss-arrow[aria-disabled='true'] { opacity: 0.35; }
.ss-arrow-glyph { width: 10px; height: 10px; border-left: 2px solid currentColor; border-bottom: 2px solid currentColor; }
.ss-arrow--l .ss-arrow-glyph { transform: translateX(2px) rotate(45deg); }
.ss-arrow--r .ss-arrow-glyph { transform: translateX(-2px) rotate(-135deg); }
.ss-token.is-refused { animation: ss-refuse 320ms var(--ease); }
@keyframes ss-refuse { 20% { transform: translateX(-8px); } 50% { transform: translateX(7px); } 80% { transform: translateX(-4px); } }
.ss-foot { flex: 0 0 auto; display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--space-2) var(--space-5); align-items: center; }
.ss-status { margin: 0; font: 500 var(--fs-sm) / 1.3 var(--font-ui); color: var(--text-1); }
.ss-status.is-warn { color: var(--warning); }
.ss-hint { margin: 0; font-size: var(--fs-xs); color: var(--text-3); }
@media (prefers-reduced-motion: reduce) { .ss-slide { transition: none; } .ss-token.is-refused { animation: none; } }
@media (max-height: 640px) {
  .ss-row { height: 68px; }
  .ss-col { min-height: 44px; }
  .ss-col img { width: 32px; height: 32px; }
  .ss-hint { display: none; }
}
`;

function svgSpan(svg: string, cls: string): HTMLElement {
  const s = h('span', { class: cls, attrs: { 'aria-hidden': 'true' } });
  s.innerHTML = svg;
  return s;
}

interface RowView {
  token: Token;
  row: HTMLElement;
  slide: HTMLElement;
  el: HTMLElement;
  marker: HTMLElement;
  sub: HTMLElement;
  label: HTMLElement;
  arrows: HTMLButtonElement[];
}

export function createSideSelectScreen(): Screen {
  let detachDots: (() => void) | null = null;
  let cleanup: (() => void) | null = null;
  let frameHook: ((nowMs: number) => void) | null = null;
  return {
    id: 'side-select',
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      injectFlowStyle();
      injectStyle('side-select', CSS);
      root.classList.add('flow');
      detachDots = attachDotField(root);
      const flow = readFlow(ctx, params);
      const model: SideModel = createSideModel();
      const pads: PadManager = (ctx.devices as unknown as { pads?: PadManager }).pads ?? getPadManager();
      const sound = (k: UiSound): void => {
        try {
          ctx.audio.playUi(k);
        } catch {
          /* audio never breaks a menu */
        }
      };
      const listDevices = (): DeviceInfo[] => {
        try {
          return ctx.devices.list();
        } catch {
          return [];
        }
      };

      // ---- initial lanes: back to this screen restores the assignment, a fresh visit gets the defaults
      syncDevices(model, listDevices(), Number.NEGATIVE_INFINITY);
      if (!(flow.setup.bindings.length > 0 && restoreFromSetup(model, flow.setup))) {
        let last: string | null = null;
        try {
          last = ctx.devices.lastActive();
        } catch {
          /* registry not ready */
        }
        defaultLanes(model, flow.mode, last);
      }

      // ---- header columns
      const config = flow.setup.config;
      const colCtrl: [HTMLElement, HTMLElement] = [h('span', { class: 'ss-ctrl', testId: 'ss-home-ctrl' }), h('span', { class: 'ss-ctrl', testId: 'ss-away-ctrl' })];
      const sideCol = (side: 0 | 1): HTMLElement => {
        const club = ctx.clubs[side === 0 ? config.homeClub : config.awayClub];
        return h(
          'div',
          { class: `ss-col ss-col--${side === 0 ? 'home' : 'away'}` },
          club ? h('img', { attrs: { src: crestDataUrl(club), alt: '', draggable: 'false' } }) : null,
          h('div', { class: 'ss-col-text' },
            h('span', { class: 'ss-col-side', text: side === 0 ? 'Home' : 'Away' }),
            h('span', { class: 'ss-col-code', text: club ? club.code : side === 0 ? 'HOME' : 'AWAY' })),
          colCtrl[side],
        );
      };
      const cols = h('div', { class: 'ss-cols' }, sideCol(0), h('div', { class: 'ss-col ss-col--centre' }, h('span', { class: 'ss-col-side', text: 'Sit out' })), sideCol(1));
      const rowsEl = h('div', { class: 'ss-rows', testId: 'ss-rows', attrs: { 'data-focus-group': 'none' } });
      const status = h('p', { class: 'ss-status', testId: 'ss-status', attrs: { 'aria-live': 'polite' } });
      const hint = h('p', { class: 'ss-hint', text: 'Slide left for home, right for away; the centre sits out. Controllers: press any button to join, then use the D-pad. Two players at most.' });
      const cont = createButton('Continue', () => onContinue(), { testId: 'side-continue', variant: 'primary', ctx, autofocus: true });

      const views = new Map<string, RowView>();

      const refuse = (t: Token, r: MoveResult): void => {
        sound(UiSound.ERROR);
        const v = views.get(t.id);
        if (v) {
          v.el.classList.remove('is-refused');
          void v.el.offsetWidth;
          v.el.classList.add('is-refused');
        }
        if (r === 'blocked-max') showToast('Two players at most: slide someone back to the centre first.', { kind: 'warning', testId: 'ss-toast' });
        else if (r === 'blocked-disconnected') showToast(`${t.label} is disconnected.`, { kind: 'warning', testId: 'ss-toast' });
      };

      const afterChange = (): void => {
        applyAssignment(flow.setup, model, ctx.settings.get());
        render();
      };

      const tryMove = (id: string, dir: number): void => {
        const t = findToken(model, id);
        if (!t) return;
        const r = moveToken(model, id, dir);
        if (r === 'moved') {
          sound(UiSound.MOVE);
          afterChange();
        } else if (r === 'blocked-max' || r === 'blocked-disconnected') refuse(t, r);
      };

      const tryLane = (id: string, lane: number): void => {
        const t = findToken(model, id);
        if (!t) return;
        const r = setLane(model, id, lane);
        if (r === 'moved') {
          sound(UiSound.MOVE);
          afterChange();
        } else {
          if (r === 'blocked-max' || r === 'blocked-disconnected') refuse(t, r);
          render();
        }
      };

      const buildRow = (t: Token): RowView => {
        const lanes = h('div', { class: 'ss-lanes', attrs: { 'aria-hidden': 'true' } });
        ([-1, 0, 1] as const).forEach((lane) => {
          const cell = h('div', { class: `ss-lane${lane === 0 ? ' ss-lane--centre' : ''}`, testId: `ss-lane-${t.id}-${lane < 0 ? 'home' : lane > 0 ? 'away' : 'centre'}` });
          cell.addEventListener('click', () => tryLane(t.id, lane));
          lanes.append(cell);
        });
        const label = h('span', { class: 'ss-token-label' });
        const sub = h('span', { class: 'ss-token-sub' });
        const marker = h('span', { class: 'ss-marker', testId: `ss-marker-${t.id}` });
        const main = h('span', { class: 'ss-token-main' }, svgSpan(ICONS[t.kind] ?? ICONS.pad, 'ss-icon'), h('span', { class: 'ss-token-text' }, label, sub), marker);
        const el = h('div', { class: 'ss-token', testId: `ss-token-${t.id}`, attrs: { role: 'group' } });
        const arrows: HTMLButtonElement[] = [];
        if (t.kind === 'touch') {
          const mk = (dir: number): HTMLButtonElement => {
            const b = createButton(dir < 0 ? 'Left' : 'Right', () => tryMove(t.id, dir), {
              testId: `ss-touch-${dir < 0 ? 'left' : 'right'}`, extraClass: `ss-arrow ss-arrow--${dir < 0 ? 'l' : 'r'}`,
              ariaLabel: dir < 0 ? 'Move touch toward home' : 'Move touch toward away',
            });
            b.replaceChildren(h('span', { class: 'ss-arrow-glyph', attrs: { 'aria-hidden': 'true' } }));
            b.addEventListener('pointerdown', (e) => e.stopPropagation());
            arrows.push(b);
            return b;
          };
          el.append(mk(-1), main, mk(1));
        } else {
          el.append(main);
        }
        el.addEventListener('animationend', () => el.classList.remove('is-refused'));
        const slide = h('div', { class: 'ss-slide' }, el);
        const row = h('div', { class: 'ss-row', testId: `ss-row-${t.id}` }, lanes, slide);
        const view: RowView = { token: t, row, slide, el, marker, sub, label, arrows };
        attachDrag(view);
        return view;
      };

      // ---- touch drag: press a token, slide it, drop it on the nearest lane
      const attachDrag = (v: RowView): void => {
        let pid = -1;
        let x0 = 0;
        let dragging = false;
        const laneWidth = (): number => v.row.getBoundingClientRect().width / 3;
        const finish = (e: PointerEvent, commitDrop: boolean): void => {
          if (e.pointerId !== pid) return;
          pid = -1;
          try {
            if (v.el.hasPointerCapture?.(e.pointerId)) v.el.releasePointerCapture(e.pointerId);
          } catch {
            /* released */
          }
          const dx = e.clientX - x0;
          const was = dragging;
          dragging = false;
          v.el.classList.remove('is-dragging');
          v.slide.style.transition = '';
          v.slide.style.transform = '';
          if (!was || !commitDrop) return;
          const w = laneWidth();
          const lane = w > 0 ? Math.round(v.token.lane + dx / w) : v.token.lane;
          if (lane !== v.token.lane) tryLane(v.token.id, lane);
        };
        v.el.addEventListener('pointerdown', (e) => {
          if (pid !== -1 || (e.pointerType === 'mouse' && e.button !== 0)) return;
          pid = e.pointerId;
          x0 = e.clientX;
          dragging = false;
          try {
            v.el.setPointerCapture(e.pointerId);
          } catch {
            /* best effort */
          }
        });
        v.el.addEventListener('pointermove', (e) => {
          if (e.pointerId !== pid) return;
          const dx = e.clientX - x0;
          if (!dragging && Math.abs(dx) < DRAG_SLOP_PX) return;
          if (!dragging) {
            dragging = true;
            v.el.classList.add('is-dragging');
            v.slide.style.transition = 'none';
          }
          const w = laneWidth();
          const lane = v.token.lane;
          // Stay within the row (a little overshoot at the ends).
          const cdx = Math.max((-1.1 - lane) * w, Math.min((1.1 - lane) * w, dx));
          v.slide.style.transform = `translateX(calc(${lane} * 33.3333% + ${cdx.toFixed(1)}px))`;
        });
        v.el.addEventListener('pointerup', (e) => finish(e, true));
        v.el.addEventListener('pointercancel', (e) => finish(e, false));
        v.el.addEventListener('lostpointercapture', (e) => finish(e, true));
      };

      const ctrlChip = (side: 0 | 1): void => {
        const chip = colCtrl[side];
        if (!sideHasHuman(model, side)) {
          chip.replaceChildren(h('span', { text: 'CPU' }));
          chip.setAttribute('aria-label', `${side === 0 ? 'Home' : 'Away'}: CPU`);
          return;
        }
        const parts: Node[] = [];
        for (const t of model.tokens) {
          if (t.lane === 0 || (t.lane < 0 ? 0 : 1) !== side) continue;
          const i = humanIndexOf(model, t.id);
          parts.push(h('span', { class: i === 0 ? 'p1' : 'p2', text: `P${i + 1}` }));
        }
        parts.sort((a, b) => (a.textContent ?? '').localeCompare(b.textContent ?? ''));
        chip.replaceChildren(...parts);
        chip.setAttribute('aria-label', `${side === 0 ? 'Home' : 'Away'}: ${parts.map((p) => p.textContent).join(' and ')}`);
      };

      const render = (): void => {
        const keep = new Set<string>();
        for (const t of model.tokens) {
          keep.add(t.id);
          let v = views.get(t.id);
          if (!v) {
            v = buildRow(t);
            views.set(t.id, v);
          }
          v.token = t;
          if (v.row.parentElement !== rowsEl || rowsEl.children[model.tokens.indexOf(t)] !== v.row) {
            rowsEl.insertBefore(v.row, rowsEl.children[model.tokens.indexOf(t)] ?? null);
          }
          v.slide.style.setProperty('--lane', String(t.lane as Lane));
          const hi = humanIndexOf(model, t.id);
          v.el.classList.toggle('is-p1', hi === 0);
          v.el.classList.toggle('is-p2', hi === 1);
          v.el.classList.toggle('is-off', !t.connected);
          v.el.dataset.lane = t.lane < 0 ? 'home' : t.lane > 0 ? 'away' : 'centre';
          v.el.dataset.human = String(hi);
          v.marker.textContent = hi >= 0 ? `P${hi + 1}` : '';
          v.label.textContent = t.label;
          const dev = listDevices().find((d) => d.id === t.id) as (DeviceInfo & { product?: string }) | undefined;
          const product = dev?.product && dev.product !== t.label ? dev.product : '';
          v.sub.textContent = !t.connected ? 'Disconnected' : t.lane === 0 ? (product || 'Sits out') : `${t.lane < 0 ? 'Home' : 'Away'}${product ? ` · ${product}` : ''}`;
          v.el.setAttribute('aria-label', `${t.label}: ${t.lane < 0 ? 'home' : t.lane > 0 ? 'away' : 'sits out'}${hi >= 0 ? `, player ${hi + 1}` : ''}`);
          if (v.arrows.length === 2) {
            v.arrows[0]!.setAttribute('aria-disabled', t.lane <= -1 ? 'true' : 'false');
            v.arrows[1]!.setAttribute('aria-disabled', t.lane >= 1 ? 'true' : 'false');
          }
        }
        for (const [id, v] of views) {
          if (keep.has(id)) continue;
          v.row.remove();
          views.delete(id);
        }
        ctrlChip(0);
        ctrlChip(1);
        const r = readiness(model, flow.mode);
        status.textContent = r.message;
        status.classList.toggle('is-warn', !r.ok);
        cont.classList.toggle('is-blocked', !r.ok);
        cont.setAttribute('aria-disabled', r.ok ? 'false' : 'true');
      };

      const onContinue = (): void => {
        const r = readiness(model, flow.mode);
        if (!r.ok) {
          sound(UiSound.ERROR);
          showToast(r.message, { kind: 'warning', testId: 'ss-toast' });
          return;
        }
        applyAssignment(flow.setup, model, ctx.settings.get());
        goNext(ctx, 'side-select', flow);
      };

      root.append(
        createFlowTop({
          ctx, title: 'Choose sides', eyebrow: MODE_LABELS[flow.mode], testId: 'side-select-title',
          steps: createStepDots(flow.mode, 'side-select'), actions: [cont],
        }),
        h('div', { class: 'ss-board' }, cols, rowsEl, h('div', { class: 'ss-foot' }, status, hint)),
      );
      applyAssignment(flow.setup, model, ctx.settings.get());
      render();

      // ---- live device list (a pad appears when one of its buttons is pressed)
      let unsub: (() => void) | null = null;
      try {
        unsub = ctx.devices.subscribe((list) => {
          if (syncDevices(model, list, pads.lastPollMs)) afterChange();
        });
      } catch {
        /* registry without subscribe */
      }

      // ---- the menu's merged directions never move focus here; a pad's joining press never confirms
      const offAction = ctx.focus.onAction((a) => {
        if (a === MenuAction.LEFT || a === MenuAction.RIGHT) return true;
        if (a === MenuAction.CONFIRM) {
          const slots = pads.slots;
          for (let i = 0; i < slots.length; i++) {
            const s = slots[i]!;
            if (!s.active || !padPressedEdge(s, PadButton.SOUTH)) continue;
            const t = findToken(model, s.key);
            if (!t || t.addedAt === pads.lastPollMs) return true;
          }
        }
        return false;
      });

      // ---- keyboard: arrows / A D move the keyboard's own token
      const onKey = (e: KeyboardEvent): void => {
        const dir = SIDE_KEYS[e.code];
        if (!dir || e.repeat || e.ctrlKey || e.altKey || e.metaKey || isEditableTarget(e.target)) return;
        if (!findToken(model, 'keyboard')) return;
        tryMove('keyboard', dir);
      };
      window.addEventListener('keydown', onKey);

      // ---- pads: each pad moves its own token (per pad, by identity)
      const stickHeld = new Map<string, number>();
      let lastPoll = pads.lastPollMs;
      frameHook = () => {
        if (pads.lastPollMs === lastPoll) return;
        lastPoll = pads.lastPollMs;
        const slots = pads.slots;
        for (let i = 0; i < slots.length; i++) {
          const s = slots[i]!;
          if (!s.active) continue;
          if (!s.connected) {
            stickHeld.delete(s.key);
            continue;
          }
          const [step, held] = padStep(s.pressed, s.prevPressed, s.lx, s.ly, stickHeld.get(s.key) ?? 0);
          stickHeld.set(s.key, held);
          if (step !== 0 && findToken(model, s.key)) tryMove(s.key, step);
        }
      };

      cleanup = () => {
        unsub?.();
        offAction();
        window.removeEventListener('keydown', onKey);
      };
    },
    unmount() {
      cleanup?.();
      cleanup = null;
      frameHook = null;
      detachDots?.();
      detachDots = null;
    },
    onFrame(frame) {
      frameHook?.(frame.nowMs);
      if (detachDots) sharedDotField().frame(frame.nowMs);
    },
  };
}
