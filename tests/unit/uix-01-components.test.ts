/**
 * UIX-01 components: pure helpers (value snapping, stepping, cycling) and every builder on a fake DOM: focusability
 * ([data-focus], adjust hooks for the FocusNavigator), ARIA state, touch / pad behaviour, sounds, modal Back handling
 * and focus trap, toasts without timers, the placeholder screen with the dot field, and the fonts module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuAction, UiSound, type AppContext } from '../../src/contracts/app';
import {
  closeTopModal, createBackButton, createButton, createCard, createList, createPlaceholderScreen, createSection,
  createSegmented, createSelector, createSlider, createTabs, createToggle, cycleOption, fractionOf, h, injectStyle,
  MAX_TOASTS, openModal, openModalCount, setSelected, showToast, snapValue, stepValue, valueAtFraction,
} from '../../src/ui/components';
import { faceQuery, FONT_FACES, FONT_LICENCES, fontFaceCss, fontsLoaded, fontsReady, installFonts, LATIN_UNICODE_RANGE } from '../../src/ui/fonts';
import { FakeElement, FakeEvent, makeAppDom, type FakeDocument, type FakeWindow } from './uix-01-fakedom';

let doc: FakeDocument;
let win: FakeWindow;
let screen: FakeElement;

beforeEach(() => {
  const dom = makeAppDom();
  doc = dom.doc;
  win = dom.win;
  screen = dom.screen;
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
});

afterEach(() => {
  while (closeTopModal()) { /* close leftovers */ }
  vi.unstubAllGlobals();
});

function el<T = FakeElement>(x: unknown): T {
  return x as T;
}

type Sub = (a: MenuAction) => boolean | void;

function fakeCtx(): { ctx: AppContext; sounds: UiSound[]; subs: Sub[]; attached: FakeElement[]; detached: FakeElement[]; back: () => void } {
  const sounds: UiSound[] = [];
  const subs: Sub[] = [];
  const attached: FakeElement[] = [];
  const detached: FakeElement[] = [];
  const back = vi.fn();
  const ctx = {
    audio: { playUi: (s: UiSound) => sounds.push(s) },
    router: { back },
    focus: {
      attach: (r: FakeElement) => attached.push(r),
      detach: (r: FakeElement) => detached.push(r),
      onAction: (fn: Sub) => {
        subs.unshift(fn);
        return () => {
          const i = subs.indexOf(fn);
          if (i >= 0) subs.splice(i, 1);
        };
      },
      handle: () => undefined,
      focus: () => undefined,
    },
  } as unknown as AppContext;
  return { ctx, sounds, subs, attached, detached, back };
}

/** Deliver a menu action the way the FocusNavigator does: latest subscriber first, stop when consumed. */
function action(subs: Sub[], a: MenuAction): boolean {
  for (const fn of [...subs]) if (fn(a) === true) return true;
  return false;
}

describe('UIX-01 component helpers (pure)', () => {
  it('snaps values to the step grid inside the range without floating-point dust', () => {
    expect(snapValue(0.3333, 0, 1, 0.05)).toBe(0.35);
    expect(snapValue(0.1 + 0.2, 0, 1, 0.1)).toBe(0.3);
    expect(snapValue(-4, 0, 10, 1)).toBe(0);
    expect(snapValue(42, 0, 10, 1)).toBe(10);
    expect(snapValue(9.9, 0, 10, 3)).toBe(9); // 12 would overshoot: last step inside the range
    expect(snapValue(Number.NaN, 2, 8, 1)).toBe(2);
    expect(snapValue(0.55, 0.5, 1.5, 0.25)).toBe(0.5);
    expect(snapValue(7.3, 0, 10, 0)).toBe(7.3);
  });

  it('steps by delta and clamps at the ends', () => {
    expect(stepValue(0.5, 1, 0, 1, 0.05)).toBe(0.55);
    expect(stepValue(0.5, -1, 0, 1, 0.05)).toBe(0.45);
    expect(stepValue(1, 1, 0, 1, 0.05)).toBe(1);
    expect(stepValue(0, -1, 0, 1, 0.05)).toBe(0);
    expect(stepValue(3, 1, 0, 10, 0)).toBe(4);
  });

  it('maps track fractions and values both ways', () => {
    expect(valueAtFraction(0.5, 0, 100, 1)).toBe(50);
    expect(valueAtFraction(-1, 0, 100, 1)).toBe(0);
    expect(valueAtFraction(2, 0, 100, 1)).toBe(100);
    expect(valueAtFraction(Number.NaN, 0, 100, 1)).toBe(0);
    expect(fractionOf(25, 0, 100)).toBe(0.25);
    expect(fractionOf(-5, 0, 100)).toBe(0);
    expect(fractionOf(5, 5, 5)).toBe(0);
  });

  it('cycles option indices with and without wrapping', () => {
    expect(cycleOption(0, 3, -1)).toBe(2);
    expect(cycleOption(2, 3, 1)).toBe(0);
    expect(cycleOption(0, 3, -1, false)).toBe(0);
    expect(cycleOption(2, 3, 1, false)).toBe(2);
    expect(cycleOption(-1, 3, 1)).toBe(1);
    expect(cycleOption(0, 0, 1)).toBe(-1);
  });
});

describe('UIX-01 buttons', () => {
  it('createButton: a focusable button that selects on click and plays a sound', () => {
    const { ctx, sounds } = fakeCtx();
    const onSelect = vi.fn();
    const b = el(createButton('Play', onSelect, { testId: 'play', variant: 'primary', autofocus: true, ctx }));
    expect(b.tagName).toBe('BUTTON');
    expect(b.type).toBe('button');
    expect(b.hasAttribute('data-focus')).toBe(true);
    expect(b.hasAttribute('data-focus-default')).toBe(true);
    expect(b.getAttribute('data-testid')).toBe('play');
    expect(b.className).toBe('btn btn--primary');
    expect(b.textContent).toBe('Play');
    b.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(sounds).toEqual([UiSound.CONFIRM]);
  });

  it('createButton: hint and glyph lines, size, selected and disabled states', () => {
    const onSelect = vi.fn();
    const b = el(createButton('Kick-Off', onSelect, { hint: 'Quick match', glyph: '>', size: 'lg', selected: true, ariaLabel: 'Kick off' }));
    expect(b.className).toContain('btn--lg');
    expect(b.querySelector('.btn__label')!.textContent).toBe('Kick-Off');
    expect(b.querySelector('.btn__hint')!.textContent).toBe('Quick match');
    expect(b.querySelector('.btn__glyph')!.getAttribute('aria-hidden')).toBe('true');
    expect(b.hasAttribute('data-selected')).toBe(true);
    expect(b.getAttribute('aria-current')).toBe('true');
    expect(b.getAttribute('aria-label')).toBe('Kick off');
    setSelected(el<HTMLElement>(b), false);
    expect(b.hasAttribute('data-selected')).toBe(false);
    const d = el(createButton('Nope', onSelect, { disabled: true }));
    d.click();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('createBackButton goes back through the router with the Back sound; its label stays "Back"', () => {
    const { ctx, sounds, back } = fakeCtx();
    const b = el(createBackButton(ctx));
    expect(b.textContent).toBe('Back');
    expect(b.className).toContain('ui-back');
    b.click();
    expect(back).toHaveBeenCalledTimes(1);
    expect(sounds).toEqual([UiSound.BACK]);
  });

  it('h and injectStyle', () => {
    const p = el(h('p', { class: 'x', text: 'hi', testId: 't', attrs: { title: 'tt' } }, 'more', null, undefined));
    expect(p.textContent).toBe('himore');
    expect(p.getAttribute('title')).toBe('tt');
    injectStyle('uix01', '.a{}');
    injectStyle('uix01', '.b{}');
    expect(doc.head.querySelectorAll('#style-uix01')).toHaveLength(1);
  });
});

describe('UIX-01 value controls', () => {
  it('createToggle: role=switch with aria-checked; tap flips it, LEFT / RIGHT on a pad reach it through data-focus-adjust', () => {
    const { ctx, sounds } = fakeCtx();
    const onChange = vi.fn();
    const t = createToggle('Radar', false, onChange, { testId: 'radar', ctx, hint: 'Show the radar' });
    const e = el(t.el);
    expect(e.getAttribute('role')).toBe('switch');
    expect(e.getAttribute('aria-checked')).toBe('false');
    expect(e.hasAttribute('data-focus')).toBe(true);
    expect(e.hasAttribute('data-focus-adjust')).toBe(true);
    expect(e.querySelector('.tgl__state')!.textContent).toBe('Off');
    e.click();
    expect(t.value).toBe(true);
    expect(e.getAttribute('aria-checked')).toBe('true');
    expect(e.querySelector('.tgl__state')!.textContent).toBe('On');
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(sounds).toEqual([UiSound.TOGGLE]);
    t.set(false);
    expect(onChange).toHaveBeenCalledTimes(1); // set without notify is silent
    expect(e.getAttribute('aria-checked')).toBe('false');
    t.set(true, true);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('createSlider: ARIA values, pad steps via focusadjust, commit once per step', () => {
    const { ctx, sounds } = fakeCtx();
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const s = createSlider('Music', 0.5, onChange, { ctx, onCommit, testId: 'music' });
    const e = el(s.el);
    expect(e.getAttribute('role')).toBe('slider');
    expect(e.hasAttribute('data-focus')).toBe(true);
    expect(e.hasAttribute('data-focus-adjust')).toBe(true);
    expect(e.getAttribute('aria-valuenow')).toBe('0.5');
    expect(e.getAttribute('aria-valuetext')).toBe('50%');
    expect(e.style.getPropertyValue('--f')).toBe('0.5000');
    e.dispatchEvent(new FakeEvent('focusadjust', { detail: { delta: 1 } }));
    expect(s.value).toBe(0.55);
    expect(onChange).toHaveBeenLastCalledWith(0.55);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(sounds).toEqual([UiSound.MOVE]);
    expect(e.querySelector('.sld__value')!.textContent).toBe('55%');
    for (let i = 0; i < 20; i++) e.dispatchEvent(new FakeEvent('focusadjust', { detail: { delta: 1 } }));
    expect(s.value).toBe(1);
    const commits = onCommit.mock.calls.length;
    e.dispatchEvent(new FakeEvent('focusadjust', { detail: { delta: 1 } }));
    expect(onCommit.mock.calls.length).toBe(commits); // at the end: nothing changes, no commit
  });

  it('createSlider: touch drag with pointer capture; cancel keeps the value; one commit per drag', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const s = createSlider('Volume', 0, onChange, { min: 0, max: 100, step: 1, onCommit, format: (v) => `${v} dB` });
    const e = el(s.el);
    const hit = e.querySelector('.sld__hit')!;
    const track = e.querySelector('.sld__track')!;
    track.rect = { left: 100, top: 0, width: 400, height: 6 };
    hit.dispatchEvent(new FakeEvent('pointerdown', { pointerId: 7, clientX: 200 }));
    expect(hit.hasPointerCapture(7)).toBe(true);
    expect(e.classList.contains('is-dragging')).toBe(true);
    expect(s.value).toBe(25);
    hit.dispatchEvent(new FakeEvent('pointermove', { pointerId: 9, clientX: 500 })); // another finger: ignored
    expect(s.value).toBe(25);
    hit.dispatchEvent(new FakeEvent('pointermove', { pointerId: 7, clientX: 600 })); // past the end: clamped
    expect(s.value).toBe(100);
    hit.dispatchEvent(new FakeEvent('pointermove', { pointerId: 7, clientX: 300 }));
    expect(s.value).toBe(50);
    expect(e.getAttribute('aria-valuetext')).toBe('50 dB');
    hit.dispatchEvent(new FakeEvent('pointercancel', { pointerId: 7 }));
    expect(s.value).toBe(50);
    expect(hit.hasPointerCapture(7)).toBe(false);
    expect(e.classList.contains('is-dragging')).toBe(false);
    expect(onCommit).toHaveBeenCalledTimes(1);
    hit.dispatchEvent(new FakeEvent('pointermove', { pointerId: 7, clientX: 100 })); // after release: ignored
    expect(s.value).toBe(50);
  });

  it('createSlider: disabled ignores touch and pad', () => {
    const s = createSlider('X', 0.2, vi.fn(), { disabled: true });
    const e = el(s.el);
    e.querySelector('.sld__track')!.rect = { left: 0, top: 0, width: 100, height: 6 };
    e.querySelector('.sld__hit')!.dispatchEvent(new FakeEvent('pointerdown', { clientX: 90 }));
    e.dispatchEvent(new FakeEvent('focusadjust', { detail: { delta: 1 } }));
    expect(s.value).toBe(0.2);
  });

  it('createSelector: one focus stop; arrows are [data-adjust] steppers the navigator clicks; tapping the row goes next', () => {
    const { ctx } = fakeCtx();
    const onChange = vi.fn();
    const opts = [{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }] as const;
    const s = createSelector('Difficulty', opts, 'normal', onChange, { ctx, testId: 'diff' });
    const e = el(s.el);
    expect(e.hasAttribute('data-focus')).toBe(true);
    expect(e.hasAttribute('data-focus-adjust')).toBe(true);
    const dec = e.querySelector('[data-adjust="dec"]')!;
    const inc = e.querySelector('[data-adjust="inc"]')!;
    expect(dec.hasAttribute('data-focus-skip')).toBe(true);
    expect(e.querySelector('.sel__value')!.textContent).toBe('Normal');
    inc.click();
    expect(s.value).toBe('hard');
    expect(onChange).toHaveBeenCalledTimes(1); // the arrow click does not also reach the row
    inc.click();
    expect(s.value).toBe('easy'); // wraps
    dec.click();
    expect(s.value).toBe('hard');
    e.click();
    expect(s.value).toBe('easy');
    expect(e.getAttribute('aria-label')).toBe('Difficulty: Easy');
    const nw = createSelector('Half length', [{ value: 3, label: '3 min' }, { value: 5, label: '5 min' }], 3, vi.fn(), { wrap: false });
    const ne = el(nw.el);
    expect(ne.querySelector('[data-adjust="dec"]')!.classList.contains('is-off')).toBe(true);
    ne.querySelector('[data-adjust="dec"]')!.click();
    expect(nw.value).toBe(3);
    nw.set(5);
    expect(ne.querySelector('[data-adjust="inc"]')!.classList.contains('is-off')).toBe(true);
  });

  it('createSegmented: a radio group, each option a focus stop in an x-wrapping focus group', () => {
    const onChange = vi.fn();
    const s = createSegmented('Camera', [{ value: 'tele', label: 'Tele', testId: 'cam-tele' }, { value: 'wide', label: 'Wide' }], 'tele', onChange);
    const e = el(s.el);
    expect(e.getAttribute('role')).toBe('radiogroup');
    expect(e.querySelector('.seg__track')!.getAttribute('data-focus-group')).toBe('x');
    const opts = e.querySelectorAll('.seg__opt');
    expect(opts).toHaveLength(2);
    for (const o of opts) {
      expect(o.getAttribute('role')).toBe('radio');
      expect(o.hasAttribute('data-focus')).toBe(true);
      expect(o.hasAttribute('data-focus-adjust')).toBe(false);
    }
    expect(opts[0]!.getAttribute('aria-checked')).toBe('true');
    opts[1]!.click();
    expect(s.value).toBe('wide');
    expect(opts[1]!.getAttribute('aria-checked')).toBe('true');
    expect(opts[0]!.getAttribute('aria-checked')).toBe('false');
    opts[1]!.click();
    expect(onChange).toHaveBeenCalledTimes(1);
    s.set('nope' as 'tele');
    expect(s.value).toBe('wide');
  });
});

describe('UIX-01 tabs, lists, cards, sections', () => {
  it('createTabs: a [data-tabs] tablist the navigator switches with L1 / R1; aria-selected follows', () => {
    const onChange = vi.fn();
    const t = createTabs([{ id: 'a', label: 'Audio' }, { id: 'b', label: 'Graphics', testId: 'tab-gfx' }], 'a', onChange, { ariaLabel: 'Settings' });
    const e = el(t.el);
    expect(e.getAttribute('role')).toBe('tablist');
    expect(e.hasAttribute('data-tabs')).toBe(true);
    const tabs = e.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    tabs[1]!.click(); // what the navigator does on TAB_NEXT
    expect(t.selected).toBe('b');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    t.select('a');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('createList: selectable rows are >= 60 pt buttons; plain rows are not focusable', () => {
    const pick = vi.fn();
    const l = el(createList([
      { label: 'Goals', value: '3' },
      { label: 'Ava Moreno', detail: 'ST', value: '8.4', onSelect: pick, testId: 'row-ava', selected: true },
      { label: 'Off', onSelect: pick, disabled: true },
    ]));
    expect(l.getAttribute('role')).toBe('list');
    expect(l.querySelectorAll('[role="listitem"]')).toHaveLength(3);
    const rows = l.querySelectorAll('.lst__row');
    expect(rows[0]!.tagName).toBe('DIV');
    expect(rows[0]!.hasAttribute('data-focus')).toBe(false);
    expect(rows[1]!.tagName).toBe('BUTTON');
    expect(rows[1]!.hasAttribute('data-focus')).toBe(true);
    expect(rows[1]!.hasAttribute('data-selected')).toBe(true);
    expect(rows[1]!.querySelector('.lst__value')!.classList.contains('num')).toBe(true);
    rows[1]!.click();
    rows[2]!.click();
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it('createCard: static or selectable, with the player accent', () => {
    const c = el(createCard({ title: 'Harbour FC', eyebrow: 'Home', body: 'Rating 84' }));
    expect(c.tagName).toBe('DIV');
    expect(c.hasAttribute('data-focus')).toBe(false);
    const pick = vi.fn();
    const s = el(createCard({ title: 'Pick', onSelect: pick, selected: true, accent: 'p2', autofocus: true }));
    expect(s.tagName).toBe('BUTTON');
    expect(s.hasAttribute('data-focus')).toBe(true);
    expect(s.hasAttribute('data-focus-default')).toBe(true);
    expect(s.classList.contains('card--p2')).toBe(true);
    s.click();
    expect(pick).toHaveBeenCalledTimes(1);
    const sec = el(createSection('Audio', el<HTMLElement>(c)));
    expect(sec.querySelector('.ui-section__title')!.textContent).toBe('Audio');
  });
});

describe('UIX-01 modal', () => {
  it('opens over the top screen, traps focus in the dialog, and pad Back closes it (not the screen)', () => {
    const { ctx, subs, attached, detached, sounds } = fakeCtx();
    const onClose = vi.fn();
    const m = openModal(ctx, { title: 'Quit match?', body: 'Progress is lost.', onClose, testId: 'quit', actions: [{ label: 'Stay' }, { label: 'Quit', primary: true }] });
    const scrim = el(m.el);
    expect(scrim.parentNode).toBe(screen);
    const dialog = scrim.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(doc.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Quit match?');
    expect(attached).toEqual([dialog]);
    const primary = dialog.querySelector('.btn--primary')!;
    expect(primary.hasAttribute('data-focus-default')).toBe(true);
    expect(openModalCount()).toBe(1);
    expect(action(subs, MenuAction.TAB_NEXT)).toBe(true); // tabs of the screen underneath are held back
    expect(action(subs, MenuAction.DOWN)).toBe(false); // navigation goes to the navigator
    expect(action(subs, MenuAction.BACK)).toBe(true);
    expect(m.open).toBe(false);
    expect(scrim.parentNode).toBeNull();
    expect(detached).toEqual([dialog]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sounds).toEqual([UiSound.BACK]);
    expect(subs).toHaveLength(0);
    expect(openModalCount()).toBe(0);
  });

  it('Escape closes the top modal before the router sees it (capture listener stops the key)', () => {
    const { ctx } = fakeCtx();
    const routerKey = vi.fn();
    win.addEventListener('keydown', routerKey); // the router listens on window (bubble)
    const m = openModal(ctx, { title: 'A' });
    const esc = new FakeEvent('keydown', { key: 'Escape' });
    doc.body.dispatchEvent(esc);
    expect(m.open).toBe(false);
    expect(routerKey).not.toHaveBeenCalled();
    expect(esc.defaultPrevented).toBe(true);
    // With no modal the key reaches the router as usual.
    doc.body.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
    expect(routerKey).toHaveBeenCalledTimes(1);
    expect(win.listenerCount('keydown')).toBe(1);
  });

  it('Backspace in a text field inside the modal edits text instead of closing', () => {
    const input = doc.createElement('input');
    const m = openModal(null, { title: 'Name', body: el<HTMLElement>(input) });
    input.dispatchEvent(new FakeEvent('keydown', { key: 'Backspace' }));
    expect(m.open).toBe(true);
    m.close();
  });

  it('a non-dismissible modal swallows Back and Escape and ignores scrim taps; its actions close it', () => {
    const { ctx, subs } = fakeCtx();
    const chosen = vi.fn();
    const m = openModal(ctx, { title: 'Controller disconnected', dismissible: false, actions: [{ label: 'Continue', primary: true, onSelect: chosen }] });
    expect(action(subs, MenuAction.BACK)).toBe(true);
    expect(m.open).toBe(true);
    doc.body.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
    expect(m.open).toBe(true);
    el(m.el).click();
    expect(m.open).toBe(true);
    expect(closeTopModal()).toBe(true); // handled (screen stays), but it stays open
    expect(m.open).toBe(true);
    el(m.el).querySelector('.btn--primary')!.click();
    expect(chosen).toHaveBeenCalledTimes(1);
    expect(m.open).toBe(false);
  });

  it('stacked modals close top first; scrim taps close only from the scrim itself; keepOpen actions stay', () => {
    const a = openModal(null, { title: 'A' });
    const b = openModal(null, { title: 'B', actions: [{ label: 'Again', keepOpen: true, testId: 'again' }] });
    el(b.el).querySelector('[data-testid="again"]')!.click();
    expect(b.open).toBe(true);
    el(b.el).querySelector('.modal__title')!.click(); // inside the panel: not a scrim tap
    expect(b.open).toBe(true);
    el(b.el).click();
    expect(b.open).toBe(false);
    expect(a.open).toBe(true);
    expect(closeTopModal()).toBe(true);
    expect(a.open).toBe(false);
    expect(closeTopModal()).toBe(false);
  });

  it('a modal whose screen went away is cleaned up on the next Back instead of eating it', () => {
    const { ctx, subs } = fakeCtx();
    const m = openModal(ctx, { title: 'Gone' });
    screen.remove(); // router unmounted the screen
    expect(action(subs, MenuAction.BACK)).toBe(false);
    expect(m.open).toBe(false);
    expect(subs).toHaveLength(0);
  });
});

describe('UIX-01 toasts', () => {
  it('stack under #ui (status region), at most MAX_TOASTS, and remove themselves when the fade-out animation ends', () => {
    const t1 = el(showToast('Saved', { kind: 'success', testId: 't1' }));
    const ui = doc.getElementById('ui')!;
    const stack = ui.querySelector('.toasts')!;
    expect(stack.getAttribute('role')).toBe('status');
    expect(stack.getAttribute('aria-live')).toBe('polite');
    expect(t1.classList.contains('toast--success')).toBe(true);
    t1.dispatchEvent(new FakeEvent('animationend', { animationName: 'dk-toast-in' }));
    expect(t1.parentNode).toBe(stack);
    t1.dispatchEvent(new FakeEvent('animationend', { animationName: 'dk-toast-out' }));
    expect(t1.parentNode).toBeNull();
    const all = [];
    for (let i = 0; i < MAX_TOASTS + 2; i++) all.push(el(showToast(`m${i}`, { lifeMs: 1000 })));
    expect(stack.children).toHaveLength(MAX_TOASTS);
    expect(stack.children[0]).toBe(all[2]);
    expect(all[4]!.style.getPropertyValue('--toast-life')).toBe('1000ms');
    expect(ui.querySelectorAll('.toasts')).toHaveLength(1);
  });
});

describe('UIX-01 placeholder screens', () => {
  it('mount the shared dot field behind the content, drive it from onFrame and detach on unmount', () => {
    const { ctx } = fakeCtx();
    const s = createPlaceholderScreen('settings', 'Settings', { subtitle: 'Soon', actions: [{ label: 'Go', onSelect: vi.fn() }] });
    s.mount(el<HTMLElement>(screen), ctx, {});
    const canvas = screen.querySelector('canvas.dotfield');
    expect(canvas).not.toBeNull();
    expect(screen.firstChild).toBe(canvas);
    expect(screen.querySelector('[data-testid="settings-title"]')!.textContent).toBe('Settings');
    expect(screen.querySelector('[data-testid="back"]')).not.toBeNull();
    s.onFrame!({ nowMs: 1000, dtMs: 16, frame: 1, ticks: 0, paused: false });
    s.unmount();
    expect(screen.querySelector('canvas.dotfield')).toBeNull();
  });

  it('Back closes an open modal first (the browser back gesture reaches only the router)', () => {
    const { ctx } = fakeCtx();
    const onBack = vi.fn(() => false);
    const s = createPlaceholderScreen('cup', 'Cup', { onBack });
    s.mount(el<HTMLElement>(screen), ctx, {});
    const m = openModal(ctx, { title: 'Info' });
    expect(s.onBack!()).toBe(true);
    expect(m.open).toBe(false);
    expect(onBack).not.toHaveBeenCalled();
    expect(s.onBack!()).toBe(false);
    expect(onBack).toHaveBeenCalledTimes(1);
    s.unmount();
  });
});

describe('UIX-01 fonts', () => {
  it('declares the five Latin faces with the subset range, swap display and woff2 sources', () => {
    expect(FONT_FACES.map((f) => `${f.family} ${f.weight}`)).toEqual([
      'Space Grotesk 400', 'Space Grotesk 500', 'Space Grotesk 700', 'JetBrains Mono 400', 'JetBrains Mono 600',
    ]);
    for (const f of FONT_FACES) {
      expect(f.file).toMatch(/-latin-\d00-normal\.woff2$/);
      expect(typeof f.url).toBe('string');
      expect(f.url.length).toBeGreaterThan(0);
    }
    const css = fontFaceCss();
    expect(css.match(/@font-face/g)).toHaveLength(5);
    expect(css).toContain(`unicode-range:${LATIN_UNICODE_RANGE}`);
    expect(css).toContain("font-display:swap");
    expect(css).toContain("format('woff2')");
    expect(faceQuery({ family: 'JetBrains Mono', weight: 600 })).toBe('600 16px "JetBrains Mono"');
  });

  it('records the OFL licences of both families for the credits', () => {
    expect(FONT_LICENCES.map((l) => l.family)).toEqual(['Space Grotesk', 'JetBrains Mono']);
    for (const l of FONT_LICENCES) {
      expect(l.licence).toBe('SIL Open Font License 1.1');
      expect(l.copyright).toMatch(/^Copyright 2020 The .* Project Authors/);
      expect(l.files.length).toBeGreaterThan(0);
    }
  });

  it('installFonts injects one style and loads every face; never throws on a fake or missing document', async () => {
    const loads: string[] = [];
    (doc as unknown as { fonts: unknown }).fonts = {
      load: (q: string) => {
        loads.push(q);
        return Promise.resolve([]);
      },
      check: (q: string) => loads.includes(q),
      ready: Promise.resolve(),
    };
    installFonts();
    installFonts();
    expect(doc.head.querySelectorAll('#dk-fonts')).toHaveLength(1);
    expect(loads).toHaveLength(5);
    expect(fontsLoaded()).toBe(true);
    await expect(fontsReady()).resolves.toBeUndefined();
    vi.stubGlobal('document', { createElement: () => ({}), getElementById: () => null, head: {} });
    expect(() => installFonts()).not.toThrow();
    expect(fontsLoaded()).toBe(false);
    vi.stubGlobal('document', undefined);
    expect(() => installFonts()).not.toThrow();
    await expect(fontsReady()).resolves.toBeUndefined();
  });
});
