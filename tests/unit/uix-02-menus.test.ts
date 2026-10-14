/**
 * UIX-02 unit tests (Node, no DOM): the pure parts of the splash and the main menu. The screens themselves (DOM,
 * focus, router, session) are covered end to end by tests/e2e/uix-02-menus.spec.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { MenuAction, type ScreenId } from '../../src/contracts/app';
import type { Club } from '../../src/contracts/data';
import { Difficulty, KitSlot, ModeId } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import {
  DIFFICULTY_LABELS, MAIN_MODE_ENTRIES, MAIN_UTILITY_ENTRIES, QUICK_PLAY_TEST_ID, clampHalfMinutes, initialFocusTestId,
  menuFocusOverride, quickPlaySummary, resetMainMenuFocus, rgbToCss,
} from '../../src/ui/screens/main';
import {
  SPLASH_IGNORED_CODES, canOfferFullscreen, isSplashStartKey, requestAppFullscreen, shouldShowHomeScreenHint,
} from '../../src/ui/screens/splash';
import { SCREEN_FACTORIES } from '../../src/ui/index';

const ALL_SCREENS = Object.keys(SCREEN_FACTORIES) as ScreenId[];

function club(id: number, code: string, name: string, home: number, away: number): Club {
  const kit = (shirt: number) => ({ shirt, shirt2: shirt, pattern: 0, shorts: 0, socks: 0, number: 0xffffff });
  return { id, code, name, home: kit(home), away: kit(away) } as unknown as Club;
}

describe('UIX-02 splash: Add to Home Screen hint', () => {
  it('shows only on an iPad in a Safari tab, until it has been seen once', () => {
    const fresh = { homeScreenHintShown: false };
    const seen = { homeScreenHintShown: true };
    expect(shouldShowHomeScreenHint({ isIPad: true, isStandalone: false }, fresh)).toBe(true);
    expect(shouldShowHomeScreenHint({ isIPad: true, isStandalone: false }, seen)).toBe(false);
    expect(shouldShowHomeScreenHint({ isIPad: true, isStandalone: true }, fresh)).toBe(false); // Home Screen app
    expect(shouldShowHomeScreenHint({ isIPad: false, isStandalone: false }, fresh)).toBe(false); // desktop, phone
  });

  it('default settings have not shown it yet', () => {
    expect(createDefaultSettings().homeScreenHintShown).toBe(false);
  });
});

describe('UIX-02 splash: full screen', () => {
  const tab = { supportsFullscreen: true, isStandalone: false };

  it('is offered in a browser tab where the API exists and the page is not full screen yet', () => {
    expect(canOfferFullscreen(tab, { fullscreenElement: null })).toBe(true);
    expect(canOfferFullscreen(tab, { fullscreenElement: {} as Element })).toBe(false);
    expect(canOfferFullscreen(tab, { webkitFullscreenElement: {} as Element })).toBe(false);
    expect(canOfferFullscreen({ supportsFullscreen: false, isStandalone: false }, {})).toBe(false);
    expect(canOfferFullscreen({ supportsFullscreen: true, isStandalone: true }, {})).toBe(false);
    expect(canOfferFullscreen(tab, null)).toBe(false); // no document (Node)
  });

  it('requests full screen on the document root (standard API first, then the WebKit prefix)', () => {
    const std = { requestFullscreen: vi.fn(() => Promise.resolve()), webkitRequestFullscreen: vi.fn() };
    expect(requestAppFullscreen({ documentElement: std })).toBe(true);
    expect(std.requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' });
    expect(std.webkitRequestFullscreen).not.toHaveBeenCalled();

    const webkit = { webkitRequestFullscreen: vi.fn() };
    expect(requestAppFullscreen({ documentElement: webkit })).toBe(true);
    expect(webkit.webkitRequestFullscreen).toHaveBeenCalledOnce();

    expect(requestAppFullscreen({ documentElement: {} })).toBe(false);
    expect(requestAppFullscreen(null)).toBe(false);
  });

  it('never throws: a refused request (rejected promise or exception) leaves the game in the tab', async () => {
    const rejecting = { requestFullscreen: vi.fn(() => Promise.reject(new Error('not allowed'))) };
    expect(requestAppFullscreen({ documentElement: rejecting })).toBe(true);
    const throwing = { requestFullscreen: vi.fn(() => { throw new Error('blocked'); }) };
    expect(requestAppFullscreen({ documentElement: throwing })).toBe(false);
    await new Promise((r) => setTimeout(r, 0)); // an unhandled rejection would fail the run
  });
});

describe('UIX-02 splash: press any key', () => {
  it('letters, digits, arrows, Enter, Space, Escape and the F key start', () => {
    for (const code of ['KeyA', 'KeyG', 'KeyF', 'Digit1', 'ArrowDown', 'Enter', 'NumpadEnter', 'Space', 'Escape', 'Backspace', 'KeyP']) {
      expect(isSplashStartKey({ code, key: 'x' }), code).toBe(true);
    }
  });

  it('modifiers alone, browser shortcuts, function / media keys, Tab and the debug key do not', () => {
    for (const code of SPLASH_IGNORED_CODES) expect(isSplashStartKey({ code }), code).toBe(false);
    for (const code of ['F1', 'F5', 'F12', 'AudioVolumeUp', 'MediaPlayPause', 'BrowserBack', 'LaunchApp1']) {
      expect(isSplashStartKey({ code }), code).toBe(false);
    }
    expect(isSplashStartKey({ code: 'KeyR', metaKey: true })).toBe(false); // Cmd+R reload
    expect(isSplashStartKey({ code: 'KeyL', ctrlKey: true })).toBe(false);
    expect(isSplashStartKey({ code: 'Tab', altKey: true })).toBe(false);
    expect(isSplashStartKey({ code: 'Backquote', key: '`' })).toBe(false); // debug overlay toggle
  });

  it('auto-repeat and IME composition do not start', () => {
    expect(isSplashStartKey({ code: 'Enter', repeat: true })).toBe(false);
    expect(isSplashStartKey({ code: 'KeyA', isComposing: true })).toBe(false);
  });

  it('a key without a code (some virtual keyboards) starts on a printable key, Enter or Space', () => {
    expect(isSplashStartKey({ code: '', key: 'a' })).toBe(true);
    expect(isSplashStartKey({ code: '', key: 'Enter' })).toBe(true);
    expect(isSplashStartKey({ code: '', key: ' ' })).toBe(true);
    expect(isSplashStartKey({ code: '', key: 'Shift' })).toBe(false);
    expect(isSplashStartKey({ code: '', key: '`' })).toBe(false);
    expect(isSplashStartKey({})).toBe(false);
  });
});

describe('UIX-02 main menu: entries and routes', () => {
  it('lists the five modes of BRIEF section 11 in order', () => {
    expect(MAIN_MODE_ENTRIES.map((e) => e.label)).toEqual(['Kick-Off', 'Play a Friend', 'Cup', 'Shoot-out', 'Practice']);
    expect(MAIN_UTILITY_ENTRIES.map((e) => e.label)).toEqual(['Settings', 'Diagnostics']);
  });

  it('routes each entry to a registered screen, with the mode for mode-setup', () => {
    const routes = Object.fromEntries([...MAIN_MODE_ENTRIES, ...MAIN_UTILITY_ENTRIES].map((e) => [e.testId, [e.route, e.params ?? null]]));
    expect(routes).toEqual({
      'main-mode-kickoff': ['mode-setup', { mode: ModeId.KICK_OFF }],
      'main-friend': ['mode-setup', { mode: ModeId.FRIEND_LOCAL }],
      'main-cup': ['cup', null],
      'main-shootout': ['mode-setup', { mode: ModeId.SHOOT_OUT }],
      'main-practice': ['practice', null],
      'main-settings': ['settings', null],
      'main-diagnostics': ['diagnostics', null],
    });
    for (const e of [...MAIN_MODE_ENTRIES, ...MAIN_UTILITY_ENTRIES]) expect(ALL_SCREENS).toContain(e.route);
  });

  it('test ids are unique and keep the Wave 0 ids other specs use (main-kickoff starts a match)', () => {
    const ids = [QUICK_PLAY_TEST_ID, ...MAIN_MODE_ENTRIES.map((e) => e.testId), ...MAIN_UTILITY_ENTRIES.map((e) => e.testId)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(QUICK_PLAY_TEST_ID).toBe('main-kickoff');
    for (const id of ['main-cup', 'main-practice', 'main-settings', 'main-diagnostics']) expect(ids).toContain(id);
  });

  it('every mode has a one-line description short enough for a 4:3 screen', () => {
    for (const e of MAIN_MODE_ENTRIES) {
      expect(e.detail.length, e.label).toBeGreaterThan(0);
      expect(e.detail.length, e.label).toBeLessThanOrEqual(46);
    }
  });
});

describe('UIX-02 main menu: quick match summary', () => {
  const clubs = [club(0, 'BRH', 'Birchkeld Borough', 0xd02040, 0xffffff), club(1, 'CAS', 'Cascade City', 0x2040d0, 0xf0f0f0)];

  it('shows what Play now starts: saved clubs and kits, difficulty, half length, time of day', () => {
    const s = createDefaultSettings();
    const q = quickPlaySummary(s, clubs);
    expect(q.home).toEqual({ code: 'BRH', name: 'Birchkeld Borough', color: '#d02040' });
    expect(q.away).toEqual({ code: 'CAS', name: 'Cascade City', color: '#f0f0f0' }); // away kit by default
    expect(q.line).toBe('Professional · 2 × 4 min · Day');

    s.match.homeKit = KitSlot.AWAY;
    s.match.awayKit = KitSlot.HOME;
    s.match.difficulty = Difficulty.LEGEND;
    s.match.halfMinutes = 7;
    s.match.night = true;
    const q2 = quickPlaySummary(s, clubs);
    expect(q2.home.color).toBe('#ffffff');
    expect(q2.away.color).toBe('#2040d0');
    expect(q2.line).toBe('Legend · 2 × 7 min · Night');
  });

  it('clamps the half length like the match setup (2..10 whole minutes)', () => {
    expect([clampHalfMinutes(1), clampHalfMinutes(2.4), clampHalfMinutes(12), clampHalfMinutes(NaN)]).toEqual([2, 2, 10, 4]);
    const s = createDefaultSettings();
    s.match.halfMinutes = 99;
    expect(quickPlaySummary(s, clubs).halfMinutes).toBe(10);
  });

  it('missing clubs or bad values never break the card', () => {
    const s = createDefaultSettings();
    s.match.homeClub = 40;
    s.match.awayClub = -1;
    s.match.difficulty = 99 as Difficulty;
    const q = quickPlaySummary(s, []);
    expect(q.home).toEqual({ code: 'HOM', name: 'Home', color: '#8a8a94' });
    expect(q.away.name).toBe('Away');
    expect(q.difficulty).toBe('Professional');
  });

  it('labels every difficulty and formats colours', () => {
    for (const d of [Difficulty.BEGINNER, Difficulty.AMATEUR, Difficulty.SEMI_PRO, Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS, Difficulty.LEGEND]) {
      expect(DIFFICULTY_LABELS[d]).toMatch(/^[A-Z]/);
    }
    expect([rgbToCss(0), rgbToCss(0xff6b35), rgbToCss(0x1ffffff), rgbToCss(NaN)]).toEqual(['#000000', '#ff6b35', '#ffffff', '#8a8a94']);
  });
});

describe('UIX-02 main menu: focus order', () => {
  it('Right or Down from Play now enters the modes at the top; Up from Play now goes to Settings', () => {
    expect(menuFocusOverride(MenuAction.RIGHT, QUICK_PLAY_TEST_ID)).toBe('main-mode-kickoff');
    expect(menuFocusOverride(MenuAction.DOWN, QUICK_PLAY_TEST_ID)).toBe('main-mode-kickoff');
    expect(menuFocusOverride(MenuAction.UP, QUICK_PLAY_TEST_ID)).toBe('main-settings');
  });

  it('everything else moves by geometry', () => {
    expect(menuFocusOverride(MenuAction.LEFT, QUICK_PLAY_TEST_ID)).toBeNull();
    expect(menuFocusOverride(MenuAction.CONFIRM, QUICK_PLAY_TEST_ID)).toBeNull();
    expect(menuFocusOverride(MenuAction.RIGHT, 'main-cup')).toBeNull();
    expect(menuFocusOverride(MenuAction.UP, 'main-mode-kickoff')).toBeNull();
    expect(menuFocusOverride(MenuAction.RIGHT, null)).toBeNull();
  });

  it('initial focus is Play now on a fresh app', () => {
    resetMainMenuFocus();
    expect(initialFocusTestId()).toBe(QUICK_PLAY_TEST_ID);
  });
});
