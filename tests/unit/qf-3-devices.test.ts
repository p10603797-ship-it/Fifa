/**
 * QF-3 FIX-07 (INT-B note "Keyboard bound to the same human does not hide touch controls"): section 9 "Touch controls
 * hide when a controller is driving that side and return on the next screen touch". The device registry hid them for
 * a pad of the same human only; a keyboard driving the same human now hides them too. Real registry, real touch source
 * and real keyboard source on the QF-3 fake DOM.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformInfo, SettingsStore } from '../../src/contracts/app';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import { createDeviceRegistry } from '../../src/input/devices';
import type { TouchInputSource } from '../../src/input/touch/index';
import { createPadManager } from '../../src/input/pad/manager';
import { fakePage, type EvEl } from './qf-3-fakedom';

function store(): SettingsStore {
  const s: Settings = createDefaultSettings();
  return {
    get: () => s, update: (m) => m(s), subscribe: () => () => {}, reset: () => {}, persistent: false,
    loadProgress: () => null, saveProgress: () => {}, clearProgress: () => {},
  };
}

function setup() {
  const page = fakePage(1180, 820);
  vi.stubGlobal('window', page.win);
  vi.stubGlobal('document', page.doc);
  const platform: PlatformInfo = { isIPad: true, isTouch: true, isStandalone: false, supportsFullscreen: false, safeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
  const reg = createDeviceRegistry({
    touchRoot: page.root as unknown as HTMLElement, getProjector: () => null, getState: () => null, settings: store(), platform,
    onPause: () => {}, pads: createPadManager(() => [], { eventTarget: null }),
  });
  const key = (code: string, repeat = false): void => { page.win.dispatch('keydown', { code, repeat, target: page.doc }); };
  return { page, reg, key };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('QF-3 FIX-07 keyboard hides the touch controls of the same human', () => {
  it('a game key on the keyboard bound to the same human hides the controls; the next screen touch brings them back', () => {
    const { page, reg, key } = setup();
    const touch = reg.createSource('touch', 0) as TouchInputSource;
    const kb = reg.createSource('keyboard', 0);
    let t = 1000;
    touch.pollFrame!(t += 16);
    expect(touch.state.hiddenByPad).toBe(false);
    key('KeyW');
    touch.pollFrame!(t += 16);
    expect(touch.state.hiddenByPad).toBe(true);
    // Next screen touch: shown again.
    const el = touch.overlay.el as unknown as EvEl;
    el.dispatch('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 800, clientY: 300, button: 0, buttons: 1 });
    expect(touch.state.hiddenByPad).toBe(false);
    // Auto-repeat and an unmapped key do not hide them again; a fresh game key does.
    key('KeyW', true);
    key('KeyZ');
    touch.pollFrame!(t += 16);
    expect(touch.state.hiddenByPad).toBe(false);
    key('KeyJ');
    touch.pollFrame!(t + 16);
    expect(touch.state.hiddenByPad).toBe(true);
    kb.dispose();
    touch.dispose();
    void page;
  });

  it('a keyboard bound to the other human, a key typed before the match, or a disposed keyboard never hides them', () => {
    const { reg, key } = setup();
    const kbOther = reg.createSource('keyboard', 1);
    const touch = reg.createSource('touch', 0) as TouchInputSource;
    let t = 1000;
    key('KeyD');
    touch.pollFrame!(t += 16);
    expect(touch.state.hiddenByPad).toBe(false);
    kbOther.dispose();

    const kb = reg.createSource('keyboard', 0);
    key('KeyA');
    const touch2 = reg.createSource('touch', 0) as TouchInputSource; // created after the key press
    touch2.pollFrame!(t += 16);
    expect(touch2.state.hiddenByPad).toBe(false);
    kb.dispose();
    key('KeyS');
    touch2.pollFrame!(t + 16);
    expect(touch2.state.hiddenByPad).toBe(false);
    touch2.dispose();
    touch.dispose();
  });
});
