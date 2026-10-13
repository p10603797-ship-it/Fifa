/**
 * PAD-08: menu focus engine (src/input/focus.ts). Pure geometry (pickSpatial, pickWrap, group axes, tab cycling) and
 * the navigator on a fake DOM (tests/unit/pad-08-fakedom.ts): initial focus, ring, spatial moves, focus groups with
 * wrap, adjustable controls, tabs, Back, modal stack, recovery when the focused element disappears, pointer handoff.
 */
import { describe, expect, it, vi } from 'vitest';
import { MenuAction } from '../../src/contracts/app';
import {
  adjustDelta, createFocusNavigator, cycleIndex, FOCUS_ADJUST_EVENT, FOCUS_CLASS, FOCUS_VISIBLE_CLASS, groupWrapAxes,
  pickSpatial, pickWrap, wrapsFor, type DotkickFocusNavigator, type FocusNavigatorOptions, type FocusRect,
} from '../../src/input/focus';
import { box, FakeDocument, type FakeElement } from './pad-08-fakedom';

const R = (x: number, y: number, w = 100, h = 40): FocusRect => ({ left: x, top: y, right: x + w, bottom: y + h });
const { UP, DOWN, LEFT, RIGHT, CONFIRM, BACK, TAB_PREV, TAB_NEXT, START } = MenuAction;

describe('PAD-08 focus geometry (pure)', () => {
  it('pickSpatial: 2-column menu under a wide primary button (main-menu layout)', () => {
    const rects = [R(0, 0, 420, 76), R(0, 100, 200), R(220, 100, 200), R(0, 160, 200), R(220, 160, 200), R(0, 220, 200), R(220, 220, 200)];
    expect(pickSpatial(rects[0]!, rects, DOWN)).toBe(1); // tie between the columns: document order
    expect(pickSpatial(rects[1]!, rects, DOWN)).toBe(3);
    expect(pickSpatial(rects[3]!, rects, DOWN)).toBe(5);
    expect(pickSpatial(rects[5]!, rects, DOWN)).toBe(-1);
    expect(pickSpatial(rects[5]!, rects, RIGHT)).toBe(6);
    expect(pickSpatial(rects[6]!, rects, UP)).toBe(4);
    expect(pickSpatial(rects[2]!, rects, UP)).toBe(0);
    expect(pickSpatial(rects[2]!, rects, RIGHT)).toBe(-1);
  });

  it('pickWrap: the far end the other way, same column / row first', () => {
    const col = [R(0, 0), R(0, 50), R(0, 100), R(200, 0)];
    expect(pickWrap(col[2]!, col, DOWN)).toBe(0); // top of the same column (in beam) beats the other column
    expect(pickWrap(col[0]!, col, UP)).toBe(2);
    const row = [R(0, 0), R(120, 0), R(240, 0)];
    expect(pickWrap(row[2]!, row, RIGHT)).toBe(0);
    expect(pickWrap(row[0]!, row, LEFT)).toBe(2);
    expect(pickWrap(row[0]!, [row[0]!], LEFT)).toBe(-1);
    expect(pickWrap(row[1]!, row, DOWN)).toBe(-1); // a single row never wraps vertically
    expect(pickWrap(row[0]!, row, CONFIRM)).toBe(-1);
  });

  it('group wrap axes, cycleIndex, adjustDelta', () => {
    expect([groupWrapAxes(''), groupWrapAxes('both'), groupWrapAxes('x'), groupWrapAxes('row'), groupWrapAxes('y'),
      groupWrapAxes('column'), groupWrapAxes('none'), groupWrapAxes(null)]).toEqual([3, 3, 1, 1, 2, 2, 0, 3]);
    expect([wrapsFor(1, LEFT), wrapsFor(1, UP), wrapsFor(2, DOWN), wrapsFor(2, RIGHT), wrapsFor(3, CONFIRM)]).toEqual([true, false, true, false, false]);
    expect([cycleIndex(2, 3, 1), cycleIndex(0, 3, -1), cycleIndex(-1, 3, 1), cycleIndex(-1, 3, -1), cycleIndex(0, 0, 1)]).toEqual([0, 2, 0, 2, -1]);
    expect([adjustDelta(LEFT), adjustDelta(RIGHT), adjustDelta(UP), adjustDelta(START)]).toEqual([-1, 1, 0, 0]);
  });
});

function setup(opts: FocusNavigatorOptions = {}) {
  const doc = new FakeDocument();
  const nav = createFocusNavigator({ ...opts, doc: doc as unknown as Document });
  const root = box(doc.body, 'div', {}, [0, 0, 1000, 800]);
  const btn = (parent: FakeElement, id: string, r: [number, number, number, number], attrs: Record<string, string> = {}) =>
    box(parent, 'button', { 'data-focus': '', 'data-testid': id, ...attrs }, r);
  const attach = (el: FakeElement = root): void => nav.attach(el as unknown as HTMLElement);
  const cur = (): string | null => (nav.current as unknown as FakeElement | null)?.getAttribute('data-testid') ?? null;
  const press = (...as: MenuAction[]): void => { for (const a of as) nav.handle(a); };
  return { doc, nav, root, btn, attach, cur, press };
}

/** Reveal the ring so the next direction moves. */
function reveal(nav: DotkickFocusNavigator): void { nav.showRing(); }

describe('PAD-08 focus navigator: initial focus, ring, spatial moves', () => {
  it('attach focuses [data-focus-default] (else the first candidate) and marks it with the attribute and class', () => {
    const t = setup();
    const a = t.btn(t.root, 'a', [0, 0, 100, 40]);
    const b = t.btn(t.root, 'b', [0, 60, 100, 40], { 'data-focus-default': '' });
    t.attach();
    expect(t.cur()).toBe('b');
    expect(b.hasAttribute('data-focused')).toBe(true);
    expect(b.classList.contains(FOCUS_CLASS)).toBe(true);
    expect(b.focusCalls).toBe(1);
    const t2 = setup();
    t2.btn(t2.root, 'x', [0, 0, 100, 40]);
    t2.attach();
    expect(t2.cur()).toBe('x');
    void a;
  });

  it('the first direction press only reveals the ring; later presses move by geometry; a pointer press hides it', () => {
    const onMove = vi.fn();
    const t = setup({ onMove });
    const a = t.btn(t.root, 'a', [0, 0, 100, 40]);
    t.btn(t.root, 'b', [0, 60, 100, 40]);
    t.btn(t.root, 'c', [200, 60, 100, 40]);
    t.attach();
    expect(t.nav.ringVisible).toBe(false);
    t.press(DOWN);
    expect(t.cur()).toBe('a');
    expect(t.nav.ringVisible).toBe(true);
    expect(t.doc.documentElement.hasAttribute('data-focus-visible')).toBe(true);
    expect(t.doc.documentElement.classList.contains(FOCUS_VISIBLE_CLASS)).toBe(true);
    expect(onMove).not.toHaveBeenCalled();
    t.press(DOWN);
    expect(t.cur()).toBe('b');
    t.press(RIGHT);
    expect(t.cur()).toBe('c');
    expect(onMove).toHaveBeenCalledTimes(2);
    t.press(RIGHT); // nothing further right, no wrap outside a group
    expect(t.cur()).toBe('c');
    // A tap on 'a' hides the ring and hands focus to the tapped control (no native focus call from the navigator).
    const calls = a.focusCalls;
    const ev = new Event('pointerdown');
    Object.defineProperty(ev, 'target', { value: a });
    t.doc.defaultView.dispatchEvent(ev);
    expect(t.nav.ringVisible).toBe(false);
    expect(t.cur()).toBe('a');
    expect(a.focusCalls).toBe(calls);
  });

  it('hidden, disabled, aria-disabled, inert, aria-hidden and data-focus-skip elements are never candidates', () => {
    const t = setup();
    t.btn(t.root, 'top', [0, 0, 100, 40]);
    t.btn(t.root, 'none', [0, 50, 100, 40]).rect = null; // display: none
    t.btn(t.root, 'hid', [0, 100, 100, 40], { hidden: '' });
    t.btn(t.root, 'dis', [0, 150, 100, 40]).disabled = true;
    t.btn(t.root, 'aria', [0, 200, 100, 40], { 'aria-disabled': 'true' });
    const inert = box(t.root, 'div', { inert: '' }, [0, 250, 100, 40]);
    t.btn(inert, 'inert', [0, 250, 100, 40]);
    const ah = box(t.root, 'div', { 'aria-hidden': 'true' }, [0, 300, 100, 40]);
    t.btn(ah, 'ah', [0, 300, 100, 40]);
    t.btn(t.root, 'skip', [0, 350, 100, 40], { 'data-focus-skip': '' });
    t.btn(t.root, 'bottom', [0, 400, 100, 40]);
    t.attach();
    reveal(t.nav);
    t.press(DOWN);
    expect(t.cur()).toBe('bottom');
  });

  it('CONFIRM clicks the focused control (and shows the ring); a text field is focused instead of clicked', () => {
    const t = setup();
    const go = t.btn(t.root, 'go', [0, 0, 100, 40]);
    const field = box(t.root, 'input', { 'data-focus': '', 'data-testid': 'name' }, [0, 60, 300, 40]);
    field.type = 'text';
    t.attach();
    t.press(CONFIRM);
    expect(go.clicks).toBe(1);
    expect(t.nav.ringVisible).toBe(true);
    t.press(DOWN);
    expect(t.cur()).toBe('name');
    expect(field.focusCalls).toBe(0); // navigating onto a text field never opens the on-screen keyboard
    t.press(CONFIRM);
    expect(field.clicks).toBe(0);
    expect(field.focusCalls).toBe(1);
  });
});

describe('PAD-08 focus navigator: data-focus-group', () => {
  function list(axes: string) {
    const t = setup();
    const back = t.btn(t.root, 'back', [0, 0, 80, 40]);
    const g = box(t.root, 'div', { 'data-focus-group': axes }, [100, 0, 300, 300]);
    t.btn(g, 'i0', [100, 0, 300, 60], { 'data-focus-default': '' });
    t.btn(g, 'i1', [100, 80, 300, 60]);
    t.btn(g, 'i2', [100, 160, 300, 60]);
    t.btn(t.root, 'side', [500, 160, 100, 60]);
    t.attach();
    reveal(t.nav);
    void back;
    return t;
  }

  it('"y": up / down wrap inside the list; left / right leave it', () => {
    const t = list('y');
    t.press(DOWN, DOWN);
    expect(t.cur()).toBe('i2');
    t.press(DOWN);
    expect(t.cur()).toBe('i0'); // wrapped
    t.press(UP);
    expect(t.cur()).toBe('i2'); // wrapped back
    t.press(RIGHT);
    expect(t.cur()).toBe('side');
    t.press(LEFT);
    expect(t.cur()).toBe('i2');
    t.press(DOWN, LEFT);
    expect(t.cur()).toBe('back'); // left from i0 leaves the group
  });

  it('"none": no wrap, the edge leads outside or nowhere; "" (both axes) wraps both ways', () => {
    const t = list('none');
    t.press(DOWN, DOWN, DOWN);
    expect(t.cur()).toBe('i2'); // no wrap and nothing below outside: stays
    t.press(UP, UP, UP);
    expect(t.cur()).toBe('back'); // past the top of the list: the Back button up-left
    const row = setup();
    const g = box(row.root, 'div', { 'data-focus-group': '' }, [0, 0, 400, 40]);
    row.btn(g, 'r0', [0, 0, 100, 40]);
    row.btn(g, 'r1', [120, 0, 100, 40]);
    row.btn(g, 'r2', [240, 0, 100, 40]);
    row.attach();
    reveal(row.nav);
    row.press(LEFT);
    expect(row.cur()).toBe('r2');
    row.press(RIGHT);
    expect(row.cur()).toBe('r0');
    row.press(DOWN); // single row: the vertical wrap finds the row's own column only (itself): stays
    expect(row.cur()).toBe('r0');
  });

  it('nested groups: a row ("x") inside a column ("y"): down from the last row wraps to the first row', () => {
    const t = setup();
    const col = box(t.root, 'div', { 'data-focus-group': 'y' }, [0, 0, 400, 200]);
    const rowA = box(col, 'div', { 'data-focus-group': 'x' }, [0, 0, 400, 40]);
    t.btn(rowA, 'a0', [0, 0, 100, 40]);
    t.btn(rowA, 'a1', [120, 0, 100, 40]);
    const rowB = box(col, 'div', { 'data-focus-group': 'x' }, [0, 100, 400, 40]);
    t.btn(rowB, 'b0', [0, 100, 100, 40]);
    t.btn(rowB, 'b1', [120, 100, 100, 40]);
    t.attach();
    reveal(t.nav);
    t.press(RIGHT, RIGHT);
    expect(t.cur()).toBe('a0'); // row wraps
    t.press(DOWN);
    expect(t.cur()).toBe('b0');
    t.press(DOWN);
    expect(t.cur()).toBe('a0'); // column wraps
    t.press(LEFT);
    expect(t.cur()).toBe('a1');
  });
});

describe('PAD-08 focus navigator: adjustable controls (data-focus-adjust)', () => {
  it('range: LEFT / RIGHT step the value (input + change events) and keep focus; UP / DOWN still navigate', () => {
    const t = setup();
    const slider = box(t.root, 'input', { 'data-focus': '', 'data-focus-adjust': '', 'data-testid': 'vol' }, [0, 0, 300, 40]);
    slider.type = 'range';
    slider.value = '5';
    slider.max = 10;
    t.btn(t.root, 'below', [0, 60, 100, 40]);
    t.btn(t.root, 'right', [400, 0, 100, 40]);
    const events: string[] = [];
    slider.addEventListener('input', () => events.push('input'));
    slider.addEventListener('change', () => events.push('change'));
    t.attach();
    reveal(t.nav);
    t.press(RIGHT, RIGHT);
    expect(slider.value).toBe('7');
    expect(t.cur()).toBe('vol');
    t.press(LEFT);
    expect(slider.value).toBe('6');
    expect(events).toEqual(['input', 'change', 'input', 'change', 'input', 'change']);
    slider.value = '10';
    t.press(RIGHT); // at max: no change, no events
    expect(events.length).toBe(6);
    t.press(DOWN);
    expect(t.cur()).toBe('below');
  });

  it('toggles: checkbox and role="switch" go on with RIGHT and off with LEFT', () => {
    const t = setup();
    const cb = box(t.root, 'input', { 'data-focus': '', 'data-focus-adjust': '' }, [0, 0, 60, 40]);
    cb.type = 'checkbox';
    t.attach();
    reveal(t.nav);
    t.press(RIGHT);
    expect(cb.checked).toBe(true);
    t.press(RIGHT);
    expect(cb.checked).toBe(true);
    t.press(LEFT);
    expect(cb.checked).toBe(false);

    const s = setup();
    const sw = s.btn(s.root, 'sw', [0, 0, 60, 40], { role: 'switch', 'aria-checked': 'false', 'data-focus-adjust': '' });
    sw.addEventListener('click', () => sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true'));
    s.attach();
    reveal(s.nav);
    s.press(LEFT);
    expect(sw.clicks).toBe(0);
    s.press(RIGHT, RIGHT);
    expect([sw.clicks, sw.getAttribute('aria-checked')]).toEqual([1, 'true']);
    s.press(LEFT);
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('a selector with [data-adjust="dec" | "inc"] buttons clicks them; anything else gets a focusadjust event', () => {
    const t = setup();
    const sel = box(t.root, 'div', { 'data-focus': '', 'data-focus-adjust': '', 'data-testid': 'diff' }, [0, 0, 300, 40]);
    const dec = box(sel, 'button', { 'data-adjust': 'dec', 'data-focus-skip': '' }, [0, 0, 40, 40]);
    const inc = box(sel, 'button', { 'data-adjust': 'inc', 'data-focus-skip': '' }, [260, 0, 40, 40]);
    const custom = box(t.root, 'div', { 'data-focus': '', 'data-focus-adjust': '', 'data-testid': 'custom' }, [0, 60, 300, 40]);
    const deltas: number[] = [];
    custom.addEventListener(FOCUS_ADJUST_EVENT, (e) => deltas.push((e as CustomEvent<{ delta: number }>).detail.delta));
    t.attach();
    reveal(t.nav);
    expect(t.cur()).toBe('diff');
    t.press(LEFT, RIGHT, RIGHT);
    expect([dec.clicks, inc.clicks]).toEqual([1, 2]);
    t.press(DOWN);
    expect(t.cur()).toBe('custom');
    t.press(LEFT, RIGHT);
    expect(deltas).toEqual([-1, 1]);
  });
});

describe('PAD-08 focus navigator: tabs, Back, subscribers', () => {
  function tabs() {
    const t = setup();
    const bar = box(t.root, 'div', { 'data-tabs': '' }, [0, 0, 600, 50]);
    const ts = ['t0', 't1', 't2'].map((id, i) => t.btn(bar, id, [i * 200, 0, 180, 50], { role: 'tab', 'aria-selected': i === 1 ? 'true' : 'false' }));
    for (const tab of ts) tab.addEventListener('click', () => { for (const o of ts) o.setAttribute('aria-selected', o === tab ? 'true' : 'false'); });
    const content = t.btn(t.root, 'content', [0, 100, 300, 50], { 'data-focus-default': '' });
    t.attach();
    const selected = (): string | null => ts.find((x) => x.getAttribute('aria-selected') === 'true')?.getAttribute('data-testid') ?? null;
    return { ...t, ts, content, selected };
  }

  it('TAB_NEXT / TAB_PREV click the next / previous tab (wrapping); focus stays in the content', () => {
    const t = tabs();
    t.press(TAB_NEXT);
    expect(t.selected()).toBe('t2');
    expect(t.cur()).toBe('content');
    t.press(TAB_NEXT);
    expect(t.selected()).toBe('t0');
    t.press(TAB_PREV);
    expect(t.selected()).toBe('t2');
  });

  it('focus on the tab bar follows the switched tab; content rebuilt by the switch hands focus to the new tab', () => {
    const t = tabs();
    t.nav.focus(t.ts[1] as unknown as HTMLElement);
    t.press(TAB_PREV);
    expect([t.selected(), t.cur()]).toEqual(['t0', 't0']);
    t.nav.focus(t.content as unknown as HTMLElement);
    t.ts[1]!.addEventListener('click', () => t.content.remove());
    t.press(TAB_NEXT);
    expect([t.selected(), t.cur()]).toEqual(['t1', 't1']);
  });

  it('BACK: subscribers first (latest first, may consume); unconsumed BACK calls onBack (the router)', () => {
    const onBack = vi.fn();
    const t = setup({ onBack });
    t.btn(t.root, 'a', [0, 0, 100, 40]);
    t.attach();
    const order: string[] = [];
    const un1 = t.nav.onAction((a) => { order.push(`first:${a}`); return false; });
    const un2 = t.nav.onAction((a) => { order.push(`second:${a}`); return a === START; });
    t.press(BACK);
    expect(order).toEqual([`second:${BACK}`, `first:${BACK}`]);
    expect(onBack).toHaveBeenCalledTimes(1);
    t.press(START);
    expect(order.slice(2)).toEqual([`second:${START}`]); // consumed: the first subscriber never sees it
    const un3 = t.nav.onAction(() => true);
    t.press(BACK);
    expect(onBack).toHaveBeenCalledTimes(1); // consumed
    un3(); un2(); un1();
    const other = vi.fn();
    t.nav.setBackHandler(other);
    t.press(BACK);
    expect([onBack.mock.calls.length, other.mock.calls.length]).toEqual([1, 1]);
    t.nav.setBackHandler(null);
    t.press(BACK); // nothing to call: no throw
  });
});

describe('PAD-08 focus navigator: modal stack and recovery', () => {
  it('a modal on top takes focus; closing it returns focus to where it was', () => {
    const t = setup();
    t.btn(t.root, 's0', [0, 0, 100, 40]);
    const s1 = t.btn(t.root, 's1', [0, 60, 100, 40]);
    t.attach();
    t.nav.focus(s1 as unknown as HTMLElement);
    const modal = box(t.doc.body, 'div', {}, [300, 300, 300, 200]);
    t.btn(modal, 'm0', [300, 300, 100, 40]);
    t.btn(modal, 'm1', [300, 360, 100, 40], { 'data-focus-default': '' });
    t.attach(modal);
    expect(t.cur()).toBe('m1');
    reveal(t.nav);
    t.press(UP);
    expect(t.cur()).toBe('m0');
    t.press(DOWN, DOWN, DOWN); // the screen below the modal is out of reach
    expect(t.cur()).toBe('m1');
    t.nav.detach(modal as unknown as HTMLElement);
    expect(t.cur()).toBe('s1');
    // Re-attaching the modal restores its own last focus.
    t.attach(modal);
    t.nav.focus(modal.children[0] as unknown as HTMLElement);
    t.attach();
    expect(t.cur()).toBe('s1');
    t.attach(modal);
    expect(t.cur()).toBe('m0');
  });

  it('when the focused element is removed, the next press lands on the default instead of moving from a ghost', () => {
    const t = setup();
    t.btn(t.root, 'def', [0, 0, 100, 40], { 'data-focus-default': '' });
    const gone = t.btn(t.root, 'gone', [0, 60, 100, 40]);
    t.btn(t.root, 'last', [0, 120, 100, 40]);
    t.attach();
    reveal(t.nav);
    t.press(DOWN);
    expect(t.cur()).toBe('gone');
    gone.remove();
    t.press(DOWN);
    expect(t.cur()).toBe('def'); // landed, not moved
    t.press(DOWN);
    expect(t.cur()).toBe('last');
    t.btn(t.root, 'again', [0, 200, 100, 40]);
    (t.nav.current as unknown as FakeElement).remove();
    t.nav.refresh();
    expect(t.cur()).toBe('def');
  });

  it('dispose: ring and marks removed, actions ignored, no throw', () => {
    const t = setup({ onBack: vi.fn() });
    const a = t.btn(t.root, 'a', [0, 0, 100, 40]);
    t.attach();
    t.press(CONFIRM);
    t.nav.dispose();
    expect(t.doc.documentElement.hasAttribute('data-focus-visible')).toBe(false);
    expect(a.hasAttribute('data-focused')).toBe(false);
    t.press(CONFIRM, DOWN, BACK);
    expect(a.clicks).toBe(1);
  });

  it('injects the ring stylesheet once, with the class hooks', () => {
    const t = setup();
    createFocusNavigator({ doc: t.doc as unknown as Document });
    const styles = t.doc.head.children.filter((e) => e.tagName === 'STYLE');
    expect(styles.length).toBe(1);
    expect(styles[0]!.textContent).toContain(`.${FOCUS_VISIBLE_CLASS} .${FOCUS_CLASS}`);
  });
});
