/**
 * QF-3 QA-30 (second pass): a HELD direction in menus by controller. The first pass let LEFT / RIGHT move the focus
 * off an adjustable control that had nothing left to change (a toggle already off on LEFT): right for a single press,
 * but the D-pad repeats a held direction (300 ms, then every 120 ms), and every repeat fell through as well. Holding
 * LEFT to switch off a right-column toggle (Match settings: Offside, Fouls, Replays beside Difficulty / Half length)
 * turned it off, jumped to the left column, then the next repeats stepped the Half length slider down: a setting the
 * player never touched. Now a repeat never falls through and never starts adjusting a control the same hold moved
 * onto; a fresh press still moves off, and a held slider still ramps.
 * Real menu input (PAD-08) + mock Standard Gamepad + real focus navigator on the fake DOM.
 */
import { describe, expect, it } from 'vitest';
import { MenuAction } from '../../src/contracts/app';
import { createFocusNavigator } from '../../src/input/focus';
import { createMenuInput, MENU_REPEAT_DELAY_MS, MENU_REPEAT_INTERVAL_MS } from '../../src/input/menuInput';
import { createPadManager, PadButton } from '../../src/input/pad/manager';
import { box, FakeDocument, type FakeElement } from './pad-08-fakedom';

interface MockPad {
  id: string; index: number; connected: boolean; mapping: string; timestamp: number; axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
}

function rig() {
  const doc = new FakeDocument();
  const nav = createFocusNavigator({ doc: doc as unknown as Document });
  const root = box(doc.body, 'div', {}, [0, 0, 1200, 800]);
  // Left column: Difficulty (plain button here) and the Half length slider; right column: two toggles.
  box(root, 'button', { 'data-focus': '', 'data-testid': 'difficulty' }, [50, 300, 500, 60]);
  const slider = box(root, 'input', { 'data-focus': '', 'data-focus-adjust': '', 'data-testid': 'half' }, [50, 400, 500, 60]);
  slider.type = 'range'; slider.min = 2; slider.max = 20; slider.step = 1; slider.value = '6';
  const offside = box(root, 'button', {
    'data-focus': '', 'data-focus-adjust': '', 'data-testid': 'offside', role: 'switch', 'aria-checked': 'true', 'data-focus-default': '',
  }, [600, 400, 500, 60]);
  offside.addEventListener('click', () => offside.setAttribute('aria-checked', offside.getAttribute('aria-checked') === 'true' ? 'false' : 'true'));
  const fouls = box(root, 'input', { 'data-focus': '', 'data-focus-adjust': '', 'data-testid': 'fouls' }, [600, 480, 500, 60]);
  fouls.type = 'checkbox';
  nav.attach(root as unknown as HTMLElement);

  const pad: MockPad = {
    id: 'Mock (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 20 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  const list: (MockPad | null)[] = [pad, null, null, null];
  const pads = createPadManager(() => list as unknown as Gamepad[], { eventTarget: null });
  const mi = createMenuInput({ focus: nav, onPause: () => {}, pads, target: new EventTarget(), settings: null });
  let t = 1000;
  const frame = (ms = 1000 / 60): void => { t += ms; pad.timestamp = t; mi.poll(t); };
  const set = (b: number, on: boolean): void => { pad.buttons[b] = { pressed: on, touched: on, value: on ? 1 : 0 }; };
  /** Hold a D-pad button for ms (frames at 60 Hz), then release it. */
  const hold = (b: number, ms: number): void => {
    set(b, true);
    for (let e = 0; e < ms; e += 1000 / 60) frame();
    set(b, false);
    frame();
  };
  const tap = (b: number): void => { set(b, true); frame(); set(b, false); frame(); frame(); };
  const cur = (): string | null => (nav.current as unknown as FakeElement | null)?.getAttribute('data-testid') ?? null;
  // Activate the pad (L3: no menu action) and reveal the ring (the first direction only reveals it).
  tap(PadButton.L3);
  nav.handle(MenuAction.DOWN);
  return { nav, slider, offside, fouls, hold, tap, cur, mi };
}

const LONG = MENU_REPEAT_DELAY_MS + 6 * MENU_REPEAT_INTERVAL_MS;

describe('QF-3 QA-30 a held D-pad direction never runs past the control it acts on', () => {
  it('holding LEFT on an "on" toggle turns it off and stays there: the left column slider is never stepped', () => {
    const r = rig();
    expect(r.cur()).toBe('offside');
    r.hold(PadButton.DPAD_LEFT, LONG);
    expect(r.offside.getAttribute('aria-checked')).toBe('false');
    expect(r.cur()).toBe('offside');
    expect(r.slider.value).toBe('6');
    // A fresh press then moves off (nothing left to change), and holding it does not step the slider it landed on.
    r.hold(PadButton.DPAD_LEFT, LONG);
    expect(r.cur()).toBe('half');
    expect(r.slider.value).toBe('6');
  });

  it('holding RIGHT on the slider still ramps it (a hold that started adjusting keeps adjusting), and stays at its end', () => {
    const r = rig();
    r.tap(PadButton.DPAD_LEFT); // offside off
    r.tap(PadButton.DPAD_LEFT); // move to the slider
    expect(r.cur()).toBe('half');
    r.hold(PadButton.DPAD_RIGHT, MENU_REPEAT_DELAY_MS + 30 * MENU_REPEAT_INTERVAL_MS);
    expect(r.slider.value).toBe('20');
    expect(r.cur()).toBe('half');
  });

  it('holding RIGHT on an "off" checkbox turns it on and stays; a held UP still walks on past adjustable rows', () => {
    const r = rig();
    r.tap(PadButton.DPAD_DOWN);
    expect(r.cur()).toBe('fouls');
    r.hold(PadButton.DPAD_RIGHT, LONG);
    expect(r.fouls.checked).toBe(true);
    expect(r.cur()).toBe('fouls');
    r.hold(PadButton.DPAD_UP, LONG); // fouls -> offside -> difficulty (UP / DOWN never adjust)
    expect(r.cur()).toBe('difficulty');
    expect(r.offside.getAttribute('aria-checked')).toBe('true');
  });

  it('single presses keep the first-pass behaviour: a toggle with nothing to change lets the press move the focus', () => {
    const r = rig();
    r.tap(PadButton.DPAD_LEFT);
    expect(r.offside.getAttribute('aria-checked')).toBe('false');
    expect(r.cur()).toBe('offside');
    r.tap(PadButton.DPAD_LEFT);
    expect(r.cur()).toBe('half');
  });
});
