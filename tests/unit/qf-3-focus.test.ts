/**
 * QF-3 QA-30: menus by controller alone. In a two-column screen (Settings: Controls) a toggle in the right column
 * consumed LEFT / RIGHT as "change the value" even when there was nothing to change, so a controller could never
 * leave the right column sideways from a toggle (focus engine, src/input/focus.ts). Now a direction that changes
 * nothing (a toggle already in that state, a disabled stepper arrow) moves the focus; one that changes the value
 * still only changes it.
 */
import { describe, expect, it } from 'vitest';
import { MenuAction } from '../../src/contracts/app';
import { createFocusNavigator } from '../../src/input/focus';
import { box, FakeDocument, type FakeElement } from './pad-08-fakedom';

const { LEFT, RIGHT, DOWN } = MenuAction;

function twoColumns() {
  const doc = new FakeDocument();
  const nav = createFocusNavigator({ doc: doc as unknown as Document });
  const root = box(doc.body, 'div', {}, [0, 0, 1200, 800]);
  box(root, 'button', { 'data-focus': '', 'data-testid': 'left' }, [50, 400, 500, 60]);
  const cb = box(root, 'input', { 'data-focus': '', 'data-focus-adjust': '', 'data-testid': 'toggle', 'data-focus-default': '' }, [600, 400, 500, 60]);
  cb.type = 'checkbox';
  const sw = box(root, 'button', { 'data-focus': '', 'data-testid': 'switch', role: 'switch', 'aria-checked': 'true', 'data-focus-adjust': '' }, [600, 480, 500, 60]);
  sw.addEventListener('click', () => sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true'));
  const sel = box(root, 'div', { 'data-focus': '', 'data-focus-adjust': '', 'data-testid': 'selector' }, [600, 560, 500, 60]);
  const dec = box(sel, 'button', { 'data-adjust': 'dec', 'data-focus-skip': '', disabled: '' }, [600, 560, 40, 60]);
  (dec as unknown as { disabled: boolean }).disabled = true;
  box(sel, 'button', { 'data-adjust': 'inc', 'data-focus-skip': '' }, [1060, 560, 40, 60]);
  nav.attach(root as unknown as HTMLElement);
  nav.handle(DOWN); // the first direction only reveals the ring
  const cur = (): string | null => (nav.current as unknown as FakeElement | null)?.getAttribute('data-testid') ?? null;
  return { nav, cb, sw, cur };
}

describe('QF-3 focus: adjustable controls never trap a direction', () => {
  it('LEFT on a toggle that is already off moves to the left column; on an "on" toggle it turns it off first', () => {
    const t = twoColumns();
    expect(t.cur()).toBe('toggle');
    expect(t.cb.checked).toBe(false);
    t.nav.handle(LEFT);
    expect(t.cur()).toBe('left');
    expect(t.cb.checked).toBe(false);
    t.nav.handle(RIGHT);
    expect(t.cur()).toBe('toggle');
    t.nav.handle(RIGHT); // turns it on, focus stays
    expect(t.cb.checked).toBe(true);
    expect(t.cur()).toBe('toggle');
    t.nav.handle(LEFT); // turns it off, focus stays
    expect(t.cb.checked).toBe(false);
    expect(t.cur()).toBe('toggle');
    t.nav.handle(LEFT); // nothing left to change: moves
    expect(t.cur()).toBe('left');
  });

  it('a role="switch" already on lets RIGHT through; a selector at its first entry (dec disabled) lets LEFT through', () => {
    const t = twoColumns();
    t.nav.handle(DOWN);
    expect(t.cur()).toBe('switch');
    t.nav.handle(RIGHT); // already on, nothing to the right: stays, nothing changes
    expect(t.sw.getAttribute('aria-checked')).toBe('true');
    expect(t.cur()).toBe('switch');
    t.nav.handle(LEFT); // turns it off
    expect(t.sw.getAttribute('aria-checked')).toBe('false');
    t.nav.handle(DOWN);
    expect(t.cur()).toBe('selector');
    t.nav.handle(LEFT); // dec disabled: move left
    expect(t.cur()).toBe('left');
  });
});
