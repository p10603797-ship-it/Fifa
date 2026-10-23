/**
 * [UIX-01] Base DOM components of the Dot design system (brief section 12). Every screen builds on these.
 *
 * Rules (brief section 12 "UI rules"): every control is focusable by the FocusNavigator ([data-focus], src/input/
 * focus.ts) and at least 60 pt tall; every screen works by touch alone and by controller alone; Back always works.
 * Styles: tokens.css (variables, base, focus ring) and components.css (these components).
 *
 * Builders (each returns plain DOM; controls return { el, value, set }):
 *  - h(tag, props, ...children)            element helper
 *  - createButton(label, onSelect, opts)   button: primary / secondary / ghost / icon / danger, optional hint line
 *  - createBackButton(ctx, onBack?)        the standard top-left Back
 *  - createToggle(label, value, onChange)  role="switch" row; LEFT / RIGHT on a pad switch off / on
 *  - createSlider(label, value, onChange)  role="slider" row; drag by touch, LEFT / RIGHT step on a pad
 *  - createSelector(label, options, ...)   one focus stop that cycles options (< value >); LEFT / RIGHT on a pad
 *  - createSegmented(label, options, ...)  radio group of buttons (each a focus stop)
 *  - createTabs(tabs, selected, onChange)  role="tablist" [data-tabs]; L1 / R1 (Q / E) switch tabs
 *  - createList(items)                     rows (focusable when selectable) with label, detail and value
 *  - createCard(opts)                      a surface; selectable cards are buttons
 *  - createSection(title, ...children)     titled group
 *  - openModal(ctx, opts) / closeTopModal() dialog with focus trap; Back (pad B, Escape) closes it
 *  - showToast(message, opts)              menu toast; fades out by CSS animation (no timers)
 *  - createPlaceholderScreen(id, title)    Wave 0 stub screens (with the dot field behind)
 *  - injectStyle(id, css), copyText(text)
 * Pure helpers for tests: snapValue, stepValue, valueAtFraction, fractionOf, cycleOption.
 *
 * Importing this module installs the inlined fonts (fonts.ts) once. window.__dotkickUi exposes the builders for e2e
 * tests and the debug overlay.
 */
import type { AppContext, Screen, ScreenId, ScreenParams } from '../contracts/app';
import { MenuAction, UiSound } from '../contracts/app';
import { FOCUS_ADJUST_EVENT } from '../input/focus';
import { attachDotField, sharedDotField } from './dotfield';
import { installFonts } from './fonts';

installFonts();

export interface ElementProps {
  class?: string;
  text?: string;
  testId?: string;
  attrs?: Record<string, string>;
}

/** Create an element with optional class, text, data-testid and attributes, appending children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.testId) el.dataset.testid = props.testId;
  if (props.attrs) for (const k of Object.keys(props.attrs)) el.setAttribute(k, props.attrs[k]!);
  for (const c of children) {
    if (c === null || c === undefined) continue;
    el.append(c);
  }
  return el;
}

function playUi(ctx: AppContext | null | undefined, sound: UiSound): void {
  if (!ctx) return;
  try {
    ctx.audio.playUi(sound);
  } catch {
    /* audio problems never break a menu */
  }
}

/** Mark an element selected (cards, buttons in a picker): [data-selected] + aria-current. */
export function setSelected(el: HTMLElement, on: boolean): void {
  if (on) {
    el.dataset.selected = '';
    el.setAttribute('aria-current', 'true');
  } else {
    delete el.dataset.selected;
    el.removeAttribute('aria-current');
  }
}

// ============================================================ pure helpers

function decimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = String(step);
  const e = s.indexOf('e-');
  if (e >= 0) return Number(s.slice(e + 2));
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Clamp v to [min, max] and snap it to the step grid starting at min (no floating-point dust). */
export function snapValue(v: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(v)) v = min;
  const lo = Math.min(min, max), hi = Math.max(min, max);
  let x = v < lo ? lo : v > hi ? hi : v;
  if (step > 0) {
    x = lo + Math.round((x - lo) / step) * step;
    if (x > hi + 1e-9) x -= step;
    x = Number(x.toFixed(Math.min(10, decimals(step) + decimals(lo))));
  }
  return x < lo ? lo : x > hi ? hi : x;
}

/** v moved by delta steps (delta -1 / +1 from a pad), clamped and snapped. */
export function stepValue(v: number, delta: number, min: number, max: number, step: number): number {
  return snapValue(snapValue(v, min, max, step) + delta * (step > 0 ? step : (max - min) / 10), min, max, step);
}

/** Position 0..1 along a track to a snapped value. */
export function valueAtFraction(f: number, min: number, max: number, step: number): number {
  const c = !Number.isFinite(f) ? 0 : f < 0 ? 0 : f > 1 ? 1 : f;
  return snapValue(min + c * (max - min), min, max, step);
}

/** Value to its position 0..1 along the track. */
export function fractionOf(v: number, min: number, max: number): number {
  if (max === min) return 0;
  const f = (v - min) / (max - min);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** Index moved by delta over n options; wraps when wrap is true, else clamps. -1 when n is 0. */
export function cycleOption(index: number, n: number, delta: number, wrap = true): number {
  if (n <= 0) return -1;
  const i = index < 0 || index >= n ? 0 : index;
  const j = i + delta;
  if (wrap) return ((j % n) + n) % n;
  return j < 0 ? 0 : j >= n ? n - 1 : j;
}

// ============================================================ buttons

export interface ButtonOptions {
  testId?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'icon' | 'danger';
  /** Mark as the preferred initial focus of its screen. */
  autofocus?: boolean;
  /** Plays a UI sound on select when given. */
  ctx?: AppContext;
  sound?: UiSound;
  extraClass?: string;
  ariaLabel?: string;
  /** A smaller second line under the label. */
  hint?: string;
  /** A short leading glyph (text symbol). */
  glyph?: string;
  /** 'lg' = 76 pt tall hero action. */
  size?: 'md' | 'lg';
  disabled?: boolean;
  selected?: boolean;
}

/** A focusable button (>= 60 pt) that calls onSelect on click/tap/controller confirm. */
export function createButton(label: string, onSelect: () => void, opts: ButtonOptions = {}): HTMLButtonElement {
  const variant = opts.variant ?? 'secondary';
  const cls = ['btn', `btn--${variant}`];
  if (opts.size === 'lg') cls.push('btn--lg');
  if (opts.extraClass) cls.push(opts.extraClass);
  const rich = opts.hint !== undefined || opts.glyph !== undefined;
  const b = h('button', { class: cls.join(' '), text: rich ? undefined : label, testId: opts.testId });
  if (rich) {
    if (opts.glyph !== undefined) b.append(h('span', { class: 'btn__glyph', text: opts.glyph, attrs: { 'aria-hidden': 'true' } }));
    const text = h('span', { class: 'btn__text' }, h('span', { class: 'btn__label', text: label }));
    if (opts.hint !== undefined) text.append(h('span', { class: 'btn__hint', text: opts.hint }));
    b.append(text);
  }
  b.type = 'button';
  b.dataset.focus = '';
  if (opts.autofocus) b.dataset.focusDefault = '';
  if (opts.ariaLabel) b.setAttribute('aria-label', opts.ariaLabel);
  if (opts.disabled) b.disabled = true;
  if (opts.selected) setSelected(b, true);
  b.addEventListener('click', (e) => {
    e.preventDefault();
    if (b.disabled) return;
    if (opts.ctx) playUi(opts.ctx, opts.sound ?? UiSound.CONFIRM);
    onSelect();
  });
  return b;
}

/** Inject a stylesheet once (each UI file keeps its own CSS next to its code). */
export function injectStyle(id: string, css: string): void {
  if (typeof document === 'undefined') return;
  const domId = `style-${id}`;
  if (document.getElementById(domId)) return;
  const s = document.createElement('style');
  s.id = domId;
  s.textContent = css;
  document.head.appendChild(s);
}

/** Standard Back button (top-left). */
export function createBackButton(ctx: AppContext, onBack?: () => void): HTMLButtonElement {
  return createButton('Back', onBack ?? (() => ctx.router.back()), {
    testId: 'back', variant: 'ghost', ctx, sound: UiSound.BACK, extraClass: 'ui-back', ariaLabel: 'Back',
  });
}

// ============================================================ value controls

/** A control with a value: its root element, the current value and a setter (notify: call onChange). */
export interface Control<T> {
  readonly el: HTMLElement;
  readonly value: T;
  set(v: T, notify?: boolean): void;
}

export interface ToggleOptions {
  testId?: string;
  ctx?: AppContext;
  hint?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

export interface Toggle extends Control<boolean> {
  readonly el: HTMLButtonElement;
}

/** On / off switch row (role="switch"): tap or Confirm flips it; LEFT / RIGHT on a pad switch off / on. */
export function createToggle(label: string, value: boolean, onChange: (v: boolean) => void, opts: ToggleOptions = {}): Toggle {
  let cur = !!value;
  const text = h('span', { class: 'ctl__text' }, h('span', { class: 'ctl__label', text: label }));
  if (opts.hint) text.append(h('span', { class: 'ctl__hint', text: opts.hint }));
  const state = h('span', { class: 'tgl__state', attrs: { 'aria-hidden': 'true' } });
  const track = h('span', { class: 'tgl__track', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'tgl__knob' }));
  const el = h('button', { class: 'ctl tgl', testId: opts.testId, attrs: { role: 'switch' } }, text, state, track);
  el.type = 'button';
  el.dataset.focus = '';
  el.dataset.focusAdjust = '';
  if (opts.ariaLabel) el.setAttribute('aria-label', opts.ariaLabel);
  if (opts.disabled) el.disabled = true;
  const render = (): void => {
    el.setAttribute('aria-checked', cur ? 'true' : 'false');
    state.textContent = cur ? 'On' : 'Off';
  };
  render();
  const api: Toggle = {
    el,
    get value() {
      return cur;
    },
    set(v, notify = false) {
      const nv = !!v;
      if (nv === cur) return;
      cur = nv;
      render();
      if (notify) onChange(cur);
    },
  };
  el.addEventListener('click', (e) => {
    e.preventDefault();
    if (el.disabled) return;
    playUi(opts.ctx, UiSound.TOGGLE);
    api.set(!cur, true);
  });
  return api;
}

export interface SliderOptions {
  min?: number;
  max?: number;
  step?: number;
  testId?: string;
  ctx?: AppContext;
  ariaLabel?: string;
  /** Displayed value text (also aria-valuetext). Default: the number, or a percentage for a 0..1 range. */
  format?: (v: number) => string;
  /** Called once when a drag ends or after a pad step (live changes go to onChange). */
  onCommit?: (v: number) => void;
  disabled?: boolean;
}

export interface Slider extends Control<number> {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** Value slider row (role="slider"): drag along the track by touch; LEFT / RIGHT on a pad step it. */
export function createSlider(label: string, value: number, onChange: (v: number) => void, opts: SliderOptions = {}): Slider {
  const min = opts.min ?? 0;
  const max = opts.max ?? 1;
  const step = opts.step ?? (max - min > 1 ? 1 : 0.05);
  const fmt = opts.format ?? ((v: number) => (min === 0 && max === 1 ? `${Math.round(v * 100)}%` : String(v)));
  let cur = snapValue(value, min, max, step);
  const valueEl = h('span', { class: 'sld__value num' });
  const fill = h('span', { class: 'sld__fill' });
  const thumb = h('span', { class: 'sld__thumb' });
  const track = h('span', { class: 'sld__track' }, fill, thumb);
  const hit = h('span', { class: 'sld__hit', attrs: { 'aria-hidden': 'true' } }, track);
  const head = h('span', { class: 'sld__head' }, h('span', { class: 'ctl__label', text: label }), valueEl);
  const el = h('div', { class: 'ctl sld', testId: opts.testId, attrs: { role: 'slider', tabindex: '0' } }, head, hit);
  el.dataset.focus = '';
  el.dataset.focusAdjust = '';
  el.setAttribute('aria-label', opts.ariaLabel ?? label);
  el.setAttribute('aria-valuemin', String(min));
  el.setAttribute('aria-valuemax', String(max));
  if (opts.disabled) el.setAttribute('aria-disabled', 'true');
  const render = (): void => {
    const f = fractionOf(cur, min, max);
    el.style.setProperty('--f', f.toFixed(4));
    const txt = fmt(cur);
    valueEl.textContent = txt;
    el.setAttribute('aria-valuenow', String(cur));
    el.setAttribute('aria-valuetext', txt);
  };
  render();
  const api: Slider = {
    el, min, max, step,
    get value() {
      return cur;
    },
    set(v, notify = false) {
      const nv = snapValue(v, min, max, step);
      if (nv === cur) return;
      cur = nv;
      render();
      if (notify) onChange(cur);
    },
  };
  const disabled = (): boolean => el.getAttribute('aria-disabled') === 'true';

  // Pad / keyboard: the FocusNavigator sends LEFT / RIGHT as a focusadjust event to [data-focus-adjust] elements.
  el.addEventListener(FOCUS_ADJUST_EVENT, (e) => {
    const d = (e as CustomEvent<{ delta: number }>).detail?.delta ?? 0;
    if (!d || disabled()) return;
    const before = cur;
    api.set(stepValue(cur, d, min, max, step), true);
    if (cur !== before) {
      playUi(opts.ctx, UiSound.MOVE);
      opts.onCommit?.(cur);
    }
  });

  // Touch / mouse: press anywhere on the track zone, drag with pointer capture; cancel keeps the last value.
  let dragId = -1;
  let startValue = cur;
  const fromPointer = (clientX: number): void => {
    const r = track.getBoundingClientRect();
    if (r.width <= 0) return;
    api.set(valueAtFraction((clientX - r.left) / r.width, min, max, step), true);
  };
  const end = (e: PointerEvent): void => {
    if (e.pointerId !== dragId) return;
    dragId = -1;
    el.classList.remove('is-dragging');
    try {
      if (hit.hasPointerCapture?.(e.pointerId)) hit.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (cur !== startValue) opts.onCommit?.(cur);
  };
  hit.addEventListener('pointerdown', (e) => {
    if (disabled() || dragId !== -1 || (e.pointerType === 'mouse' && e.button !== 0)) return;
    dragId = e.pointerId;
    startValue = cur;
    el.classList.add('is-dragging');
    try {
      hit.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best effort */
    }
    fromPointer(e.clientX);
  });
  hit.addEventListener('pointermove', (e) => {
    if (e.pointerId === dragId) fromPointer(e.clientX);
  });
  hit.addEventListener('pointerup', end);
  hit.addEventListener('pointercancel', end);
  hit.addEventListener('lostpointercapture', end);
  return api;
}

export interface ChoiceOption<T extends string | number> {
  value: T;
  label: string;
  testId?: string;
}

export interface SelectorOptions {
  testId?: string;
  ctx?: AppContext;
  hint?: string;
  /** Wrap from the last option to the first (default true). */
  wrap?: boolean;
  ariaLabel?: string;
}

export interface Selector<T extends string | number> extends Control<T> {
  readonly options: readonly ChoiceOption<T>[];
}

/**
 * Option cycler row: one focus stop showing "< value >". Tap the arrows (each >= 60 pt) or the row (next); on a pad
 * LEFT / RIGHT change it (the arrows are [data-adjust] steppers the FocusNavigator clicks) and Confirm goes to the next.
 */
export function createSelector<T extends string | number>(
  label: string,
  options: readonly ChoiceOption<T>[],
  value: T,
  onChange: (v: T) => void,
  opts: SelectorOptions = {},
): Selector<T> {
  const wrap = opts.wrap ?? true;
  let idx = Math.max(0, options.findIndex((o) => o.value === value));
  const valueEl = h('span', { class: 'sel__value' });
  const prev = h('span', { class: 'sel__arrow', attrs: { 'data-adjust': 'dec', 'data-focus-skip': '', 'aria-hidden': 'true' } });
  const next = h('span', { class: 'sel__arrow', attrs: { 'data-adjust': 'inc', 'data-focus-skip': '', 'aria-hidden': 'true' } });
  const text = h('span', { class: 'ctl__text' }, h('span', { class: 'ctl__label', text: label }));
  if (opts.hint) text.append(h('span', { class: 'ctl__hint', text: opts.hint }));
  const el = h('div', { class: 'ctl sel', testId: opts.testId, attrs: { role: 'button', tabindex: '0' } }, text, h('span', { class: 'sel__box' }, prev, valueEl, next));
  el.dataset.focus = '';
  el.dataset.focusAdjust = '';
  el.setAttribute('aria-roledescription', 'option selector');
  const render = (): void => {
    const o = options[idx];
    valueEl.textContent = o ? o.label : '';
    el.setAttribute('aria-label', `${opts.ariaLabel ?? label}: ${o ? o.label : ''}`);
    if (o?.testId) valueEl.dataset.testid = o.testId;
    if (!wrap) {
      prev.classList.toggle('is-off', idx <= 0);
      next.classList.toggle('is-off', idx >= options.length - 1);
    }
  };
  render();
  const move = (delta: number): void => {
    const j = cycleOption(idx, options.length, delta, wrap);
    if (j < 0 || j === idx) return;
    idx = j;
    render();
    playUi(opts.ctx, UiSound.MOVE);
    onChange(options[idx]!.value);
  };
  prev.addEventListener('click', (e) => {
    e.stopPropagation();
    move(-1);
  });
  next.addEventListener('click', (e) => {
    e.stopPropagation();
    move(1);
  });
  el.addEventListener('click', () => move(1));
  return {
    el, options,
    get value() {
      return options[idx]!.value;
    },
    set(v, notify = false) {
      const j = options.findIndex((o) => o.value === v);
      if (j < 0 || j === idx) return;
      idx = j;
      render();
      if (notify) onChange(options[idx]!.value);
    },
  };
}

export interface SegmentedOptions {
  testId?: string;
  ctx?: AppContext;
  ariaLabel?: string;
}

/** Segmented control: a radio group of buttons (each a focus stop; LEFT / RIGHT move along it, Confirm picks). */
export function createSegmented<T extends string | number>(
  label: string,
  options: readonly ChoiceOption<T>[],
  value: T,
  onChange: (v: T) => void,
  opts: SegmentedOptions = {},
): Selector<T> {
  let cur = options.some((o) => o.value === value) || options.length === 0 ? value : options[0]!.value;
  const row = h('div', { class: 'seg__track', attrs: { 'data-focus-group': 'x' } });
  const buttons: HTMLButtonElement[] = [];
  const el = h('div', { class: 'seg', testId: opts.testId, attrs: { role: 'radiogroup', 'aria-label': opts.ariaLabel ?? label } });
  if (label) el.append(h('div', { class: 'seg__label eyebrow', text: label }));
  el.append(row);
  const render = (): void => {
    for (let i = 0; i < options.length; i++) {
      const on = options[i]!.value === cur;
      buttons[i]!.setAttribute('aria-checked', on ? 'true' : 'false');
      buttons[i]!.tabIndex = on ? 0 : -1;
    }
  };
  for (const o of options) {
    const b = h('button', { class: 'seg__opt', text: o.label, testId: o.testId, attrs: { role: 'radio' } });
    b.type = 'button';
    b.dataset.focus = '';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      if (o.value === cur) return;
      cur = o.value;
      render();
      playUi(opts.ctx, UiSound.TOGGLE);
      onChange(cur);
    });
    buttons.push(b);
    row.append(b);
  }
  render();
  return {
    el, options,
    get value() {
      return cur;
    },
    set(v, notify = false) {
      if (v === cur || !options.some((o) => o.value === v)) return;
      cur = v;
      render();
      if (notify) onChange(cur);
    },
  };
}

// ============================================================ tabs, lists, cards

export interface TabSpec {
  id: string;
  label: string;
  testId?: string;
}

export interface TabsOptions {
  testId?: string;
  ctx?: AppContext;
  ariaLabel?: string;
}

export interface Tabs {
  /** The tab bar (role="tablist", [data-tabs]). */
  readonly el: HTMLElement;
  readonly selected: string;
  select(id: string, notify?: boolean): void;
}

/** Tab bar: tap a tab, or L1 / R1 (Q / E) anywhere on the screen (FocusNavigator TAB_PREV / TAB_NEXT). */
export function createTabs(tabs: readonly TabSpec[], selected: string, onChange: (id: string) => void, opts: TabsOptions = {}): Tabs {
  let cur = tabs.some((t) => t.id === selected) ? selected : (tabs[0]?.id ?? '');
  const el = h('div', { class: 'tabs', testId: opts.testId, attrs: { role: 'tablist', 'data-tabs': '', 'data-focus-group': 'x' } });
  if (opts.ariaLabel) el.setAttribute('aria-label', opts.ariaLabel);
  const buttons: HTMLButtonElement[] = [];
  const render = (): void => {
    for (let i = 0; i < tabs.length; i++) buttons[i]!.setAttribute('aria-selected', tabs[i]!.id === cur ? 'true' : 'false');
  };
  for (const t of tabs) {
    const b = h('button', { class: 'tab', testId: t.testId, attrs: { role: 'tab' } }, h('span', { class: 'tab__label', text: t.label }), h('span', { class: 'tab__dot', attrs: { 'aria-hidden': 'true' } }));
    b.type = 'button';
    b.dataset.focus = '';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      if (t.id === cur) return;
      cur = t.id;
      render();
      playUi(opts.ctx, UiSound.MOVE);
      onChange(cur);
    });
    buttons.push(b);
    el.append(b);
  }
  render();
  return {
    el,
    get selected() {
      return cur;
    },
    select(id, notify = false) {
      if (id === cur || !tabs.some((t) => t.id === id)) return;
      cur = id;
      render();
      if (notify) onChange(cur);
    },
  };
}

export interface ListItem {
  label: string;
  /** Smaller line under the label. */
  detail?: string;
  /** Right-aligned value (numbers use the mono face). */
  value?: string;
  testId?: string;
  /** Makes the row a focusable button. */
  onSelect?: () => void;
  disabled?: boolean;
  selected?: boolean;
}

export interface ListOptions {
  testId?: string;
  ctx?: AppContext;
  ariaLabel?: string;
}

/** A vertical list of rows separated by hairlines; selectable rows are >= 60 pt buttons. */
export function createList(items: readonly ListItem[], opts: ListOptions = {}): HTMLElement {
  const el = h('div', { class: 'lst', testId: opts.testId, attrs: { role: 'list', 'data-focus-group': 'none' } });
  if (opts.ariaLabel) el.setAttribute('aria-label', opts.ariaLabel);
  for (const it of items) {
    const text = h('span', { class: 'lst__text' }, h('span', { class: 'lst__label', text: it.label }));
    if (it.detail) text.append(h('span', { class: 'lst__detail', text: it.detail }));
    const parts: Node[] = [text];
    if (it.value !== undefined) parts.push(h('span', { class: 'lst__value num', text: it.value }));
    let row: HTMLElement;
    if (it.onSelect) {
      const sel = it.onSelect;
      const b = h('button', { class: 'lst__row lst__row--action', testId: it.testId }, ...parts);
      b.type = 'button';
      b.dataset.focus = '';
      if (it.disabled) b.disabled = true;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        if (b.disabled) return;
        playUi(opts.ctx, UiSound.CONFIRM);
        sel();
      });
      row = b;
    } else {
      row = h('div', { class: 'lst__row', testId: it.testId }, ...parts);
    }
    if (it.selected) setSelected(row, true);
    el.append(h('div', { class: 'lst__item', attrs: { role: 'listitem' } }, row));
  }
  return el;
}

export interface CardOptions {
  title?: string;
  /** Small caps line above the title. */
  eyebrow?: string;
  body?: string | Node;
  children?: readonly Node[];
  testId?: string;
  /** Makes the card a focusable button. */
  onSelect?: () => void;
  selected?: boolean;
  /** Player colour accent (selection by player 1 / player 2). */
  accent?: 'p1' | 'p2';
  ctx?: AppContext;
  ariaLabel?: string;
  autofocus?: boolean;
}

/** A surface card; with onSelect it is a button (focusable, >= 60 pt). */
export function createCard(opts: CardOptions = {}): HTMLElement {
  const parts: Node[] = [];
  if (opts.eyebrow) parts.push(h('span', { class: 'card__eyebrow eyebrow', text: opts.eyebrow }));
  if (opts.title) parts.push(h('span', { class: 'card__title', text: opts.title }));
  if (opts.body !== undefined) {
    parts.push(typeof opts.body === 'string' ? h('span', { class: 'card__body', text: opts.body }) : h('div', { class: 'card__body' }, opts.body));
  }
  if (opts.children) parts.push(...opts.children);
  let el: HTMLElement;
  if (opts.onSelect) {
    const sel = opts.onSelect;
    const b = h('button', { class: 'card card--action', testId: opts.testId }, ...parts);
    b.type = 'button';
    b.dataset.focus = '';
    if (opts.autofocus) b.dataset.focusDefault = '';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      playUi(opts.ctx, UiSound.CONFIRM);
      sel();
    });
    el = b;
  } else {
    el = h('div', { class: 'card', testId: opts.testId }, ...parts);
  }
  if (opts.accent) el.classList.add(`card--${opts.accent}`);
  if (opts.ariaLabel) el.setAttribute('aria-label', opts.ariaLabel);
  if (opts.selected) setSelected(el, true);
  return el;
}

/** A titled group of controls. */
export function createSection(title: string, ...children: (Node | null | undefined)[]): HTMLElement {
  return h('section', { class: 'ui-section' }, h('h2', { class: 'ui-section__title eyebrow', text: title }), ...children);
}

// ============================================================ modal

export interface ModalAction {
  label: string;
  onSelect?: () => void;
  primary?: boolean;
  variant?: ButtonOptions['variant'];
  testId?: string;
  /** Do not close the modal after onSelect. */
  keepOpen?: boolean;
}

export interface ModalOptions {
  title: string;
  body?: string | Node;
  actions?: readonly ModalAction[];
  /** Back, Escape and a scrim tap close it (default true). Non-dismissible modals swallow Back. */
  dismissible?: boolean;
  onClose?: () => void;
  testId?: string;
  /** Where to put it (default: the top screen in #ui, else #ui, else body). */
  host?: HTMLElement;
}

export interface ModalHandle {
  readonly el: HTMLElement;
  readonly open: boolean;
  close(): void;
}

interface OpenModal {
  handle: ModalHandle;
  dismissible: boolean;
}

const modalStack: OpenModal[] = [];
let modalSeq = 0;

function topModal(): OpenModal | null {
  for (let i = modalStack.length - 1; i >= 0; i--) {
    const m = modalStack[i]!;
    if (m.handle.el.isConnected) return m;
    // Its screen went away without closing it: clean up.
    m.handle.close();
  }
  return null;
}

/** Close the top modal (screens call this first in onBack: the browser back gesture reaches only the router). */
export function closeTopModal(): boolean {
  const m = topModal();
  if (!m) return false;
  if (m.dismissible) m.handle.close();
  return true;
}

/** Number of open modals (tests). */
export function openModalCount(): number {
  topModal();
  return modalStack.length;
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

/**
 * Open a dialog over the current screen. Focus is trapped in it (FocusNavigator root on top of the screen's); Back
 * from a pad, Escape / Backspace and a scrim tap close it when dismissible; closing returns focus where it was.
 */
export function openModal(ctx: AppContext | null, opts: ModalOptions): ModalHandle {
  const dismissible = opts.dismissible ?? true;
  const titleId = `dk-modal-title-${++modalSeq}`;
  const panel = h('div', { class: 'modal', testId: opts.testId, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } });
  panel.append(h('h2', { class: 'modal__title', text: opts.title, attrs: { id: titleId } }));
  if (opts.body !== undefined) {
    panel.append(typeof opts.body === 'string' ? h('p', { class: 'modal__body', text: opts.body }) : h('div', { class: 'modal__body' }, opts.body));
  }
  const scrim = h('div', { class: 'modal-scrim' }, panel);
  let open = true;
  let unsub: (() => void) | null = null;
  const view = typeof window !== 'undefined' ? window : null;

  const onKey = (e: KeyboardEvent): void => {
    if (!open || (e.key !== 'Escape' && e.key !== 'Backspace')) return;
    if (topModal()?.handle !== handle) return;
    if (e.key === 'Backspace' && isEditable(e.target)) return;
    // Keep the router (and the menu input) from also treating this key as Back for the screen underneath.
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
    if (e.repeat) return;
    if (dismissible) {
      playUi(ctx, UiSound.BACK);
      handle.close();
    }
  };

  const handle: ModalHandle = {
    el: scrim,
    get open() {
      return open;
    },
    close() {
      if (!open) return;
      open = false;
      const i = modalStack.findIndex((m) => m.handle === handle);
      if (i >= 0) modalStack.splice(i, 1);
      unsub?.();
      unsub = null;
      view?.removeEventListener('keydown', onKey, true);
      try {
        ctx?.focus.detach(panel);
      } catch {
        /* navigator gone */
      }
      scrim.remove();
      opts.onClose?.();
    },
  };

  const actions = opts.actions ?? [{ label: 'OK', primary: true }];
  if (actions.length > 0) {
    const row = h('div', { class: 'modal__actions' });
    actions.forEach((a) => {
      row.append(
        createButton(a.label, () => {
          a.onSelect?.();
          if (!a.keepOpen) handle.close();
        }, { testId: a.testId, variant: a.variant ?? (a.primary ? 'primary' : 'secondary'), autofocus: !!a.primary, ctx: ctx ?? undefined }),
      );
    });
    panel.append(row);
  }
  scrim.addEventListener('click', (e) => {
    if (e.target !== scrim || !dismissible) return;
    playUi(ctx, UiSound.BACK);
    handle.close();
  });

  let host: HTMLElement | null = opts.host ?? null;
  if (!host && typeof document !== 'undefined') {
    // [QF-17] Not a screen the router built ahead and keeps hidden ([data-prepared]): the modal would be invisible.
    const screens = document.querySelectorAll<HTMLElement>('#ui > .screen');
    let last: HTMLElement | null = null;
    for (let i = screens.length - 1; i >= 0 && !last; i--) if (!screens[i]!.hasAttribute('data-prepared')) last = screens[i]!;
    host = last ?? document.getElementById('ui') ?? document.body;
  }
  host?.append(scrim);
  modalStack.push({ handle, dismissible });
  view?.addEventListener('keydown', onKey, true);
  if (ctx) {
    try {
      unsub = ctx.focus.onAction((a) => {
        if (!open) return false;
        if (!scrim.isConnected) {
          handle.close();
          return false;
        }
        if (topModal()?.handle !== handle) return false;
        if (a === MenuAction.BACK) {
          if (dismissible) {
            playUi(ctx, UiSound.BACK);
            handle.close();
          }
          return true;
        }
        // Tabs and pause belong to the screen underneath: keep them away while the dialog is open.
        return a === MenuAction.TAB_PREV || a === MenuAction.TAB_NEXT;
      });
      ctx.focus.attach(panel);
    } catch {
      /* no navigator: touch still works */
    }
  }
  return handle;
}

// ============================================================ toasts

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  kind?: ToastKind;
  testId?: string;
  /** Time on screen before the fade-out, ms (default the --toast-life token). */
  lifeMs?: number;
  host?: HTMLElement;
}

/** At most this many menu toasts at once (the oldest goes first). */
export const MAX_TOASTS = 3;

/**
 * Show a short message at the top of the screen (menus; the HUD has its own toasts). It slides in, waits and fades
 * out by CSS animation (transform and opacity), then removes itself on animationend: no timers.
 */
export function showToast(message: string, opts: ToastOptions = {}): HTMLElement {
  const kind = opts.kind ?? 'info';
  const el = h('div', { class: `toast toast--${kind}`, testId: opts.testId }, h('span', { class: 'toast__dot', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'toast__text', text: message }));
  if (opts.lifeMs !== undefined) el.style.setProperty('--toast-life', `${Math.max(0, Math.round(opts.lifeMs))}ms`);
  el.addEventListener('animationend', (e) => {
    if ((e as AnimationEvent).animationName === 'dk-toast-out') el.remove();
  });
  if (typeof document === 'undefined') return el;
  const host = opts.host ?? document.getElementById('ui') ?? document.body;
  let stack = host.querySelector<HTMLElement>(':scope > .toasts');
  if (!stack) {
    stack = h('div', { class: 'toasts', attrs: { role: 'status', 'aria-live': 'polite' } });
    host.append(stack);
  }
  stack.append(el);
  while (stack.children.length > MAX_TOASTS) stack.firstElementChild?.remove();
  return el;
}

// ============================================================ placeholder screens

export interface PlaceholderAction {
  label: string;
  testId?: string;
  primary?: boolean;
  onSelect(ctx: AppContext): void;
}

export interface PlaceholderOptions {
  subtitle?: string;
  note?: string;
  actions?: PlaceholderAction[];
  /** Screen-specific Back behaviour; return true when handled. */
  onBack?(ctx: AppContext): boolean;
  /** Hide the Back button (root screens). */
  noBack?: boolean;
}

/** A titled placeholder screen with optional actions, a Back button and the dot field behind (Wave 0 stubs). */
export function createPlaceholderScreen(id: ScreenId, title: string, opts: PlaceholderOptions = {}): Screen {
  let ctxRef: AppContext | null = null;
  let detachField: (() => void) | null = null;
  return {
    id,
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      void params;
      ctxRef = ctx;
      detachField = attachDotField(root);
      root.append(h('h1', { class: 'ui-title', text: title, testId: `${id}-title` }));
      if (opts.subtitle) root.append(h('p', { class: 'ui-subtitle', text: opts.subtitle }));
      if (opts.actions && opts.actions.length > 0) {
        const col = h('div', { class: 'ui-col' });
        opts.actions.forEach((a, i) => {
          col.append(
            createButton(a.label, () => a.onSelect(ctx), {
              testId: a.testId, variant: a.primary ? 'primary' : 'secondary', autofocus: i === 0, ctx,
            }),
          );
        });
        root.append(col);
      }
      if (opts.note) root.append(h('p', { class: 'ui-note', text: opts.note }));
      if (!opts.noBack) root.append(createBackButton(ctx));
    },
    unmount() {
      ctxRef = null;
      detachField?.();
      detachField = null;
    },
    onBack() {
      if (closeTopModal()) return true;
      return ctxRef && opts.onBack ? opts.onBack(ctxRef) : false;
    },
    onFrame(frame) {
      if (detachField) sharedDotField().frame(frame.nowMs);
    },
  };
}

/** Copy text to the clipboard (Clipboard API with a textarea fallback). Resolves true on success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// ============================================================ test / debug hook

declare global {
  interface Window {
    /** The component builders and the shared dot field (e2e tests, debug overlay). */
    __dotkickUi?: Record<string, unknown>;
  }
}

if (typeof window !== 'undefined') {
  window.__dotkickUi = {
    h, createButton, createBackButton, createToggle, createSlider, createSelector, createSegmented, createTabs,
    createList, createCard, createSection, openModal, closeTopModal, showToast, setSelected, sharedDotField,
  };
}
