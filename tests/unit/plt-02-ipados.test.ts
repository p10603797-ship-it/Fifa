/**
 * [PLT-02] iPadOS hardening, pure parts and the Low Power Mode hint wiring (Node, no DOM): portrait / too-small
 * classification (square counts as portrait, like the CSS rule), aspect bands (4:3 .. 21:9), the double-tap test for
 * the touchend fallback, and the single Low Power hint path (GFX-02's detector -> one-time hint -> app callback).
 */
import { describe, expect, it } from 'vitest';
import {
  aspectBand, classifyViewport, fullscreenAvailable, installIpadHardening, isDoubleTap, isFullscreen, MAX_ASPECT,
  MIN_ASPECT, MIN_PLAY_HEIGHT, MIN_PLAY_WIDTH,
} from '../../src/platform/ipados';

describe('PLT-02 viewport classification', () => {
  it('portrait follows height >= width (square included); too small only in landscape', () => {
    expect(classifyViewport(1180, 820)).toEqual({ portrait: false, tooSmall: false });
    expect(classifyViewport(820, 1180)).toEqual({ portrait: true, tooSmall: false });
    expect(classifyViewport(700, 700)).toEqual({ portrait: true, tooSmall: false });
    expect(classifyViewport(MIN_PLAY_WIDTH - 1, 300)).toEqual({ portrait: false, tooSmall: true });
    expect(classifyViewport(900, MIN_PLAY_HEIGHT - 1)).toEqual({ portrait: false, tooSmall: true });
    expect(classifyViewport(MIN_PLAY_WIDTH, MIN_PLAY_HEIGHT)).toEqual({ portrait: false, tooSmall: false });
    // A small portrait window shows the rotate card, not the "too small" one.
    expect(classifyViewport(300, 500)).toEqual({ portrait: true, tooSmall: false });
    // The live media query result wins (JS and CSS can never disagree).
    expect(classifyViewport(1000, 999, MIN_PLAY_WIDTH, MIN_PLAY_HEIGHT, true).portrait).toBe(true);
  });

  it('aspect bands cover 4:3 to 21:9', () => {
    expect(aspectBand(1024, 768)).toBe('ok'); // 4:3
    expect(aspectBand(2360, 1640)).toBe('ok'); // iPad 11-inch
    expect(aspectBand(2100, 900)).toBe('ok'); // 21:9
    expect(aspectBand(1000, 900)).toBe('narrow');
    expect(aspectBand(2400, 800)).toBe('wide');
    expect(aspectBand(0, 0)).toBe('ok');
    expect(MIN_ASPECT).toBeCloseTo(4 / 3);
    expect(MAX_ASPECT).toBeCloseTo(21 / 9);
  });

  it('double tap: second tap within 350 ms and 40 px', () => {
    const a = { t: 1000, x: 100, y: 100 };
    expect(isDoubleTap(null, a)).toBe(false);
    expect(isDoubleTap(a, { t: 1200, x: 110, y: 120 })).toBe(true);
    expect(isDoubleTap(a, { t: 1400, x: 100, y: 100 })).toBe(false);
    expect(isDoubleTap(a, { t: 1100, x: 200, y: 100 })).toBe(false);
    expect(isDoubleTap(a, { t: 900, x: 100, y: 100 })).toBe(false);
  });

  it('full screen is unavailable without a DOM', () => {
    expect(fullscreenAvailable()).toBe(false);
    expect(isFullscreen()).toBe(false);
  });
});

describe('PLT-02 Low Power Mode hint (one path: GFX-02 detector)', () => {
  it('fires the app callback once per page, however often the detector reports; reportFrame does nothing', () => {
    let fire: (() => void) | null = null;
    let unsubscribed = 0;
    const source = (fn: () => void): (() => void) => {
      fire = fn;
      return () => { unsubscribed++; };
    };
    let calls = 0;
    const hw = installIpadHardening({ lowPowerSource: source, onLowPowerSuspected: () => calls++ });
    expect(hw.lowPowerHinted).toBe(false);
    for (let i = 0; i < 500; i++) hw.reportFrame(33.3, 2); // the old frame detector is gone
    expect(calls).toBe(0);
    fire!();
    fire!();
    expect(calls).toBe(1);
    expect(hw.lowPowerHinted).toBe(true);
    hw.dispose();
    expect(unsubscribed).toBe(1);
  });

  it('subscribes to GFX-02 by default and can be switched off', () => {
    const hw = installIpadHardening();
    expect(hw.portrait).toBe(false);
    hw.dispose();
    let subscribed = false;
    const off = installIpadHardening({ lowPowerSource: null });
    off.dispose();
    const on = installIpadHardening({ lowPowerSource: () => { subscribed = true; return () => undefined; } });
    on.dispose();
    expect(subscribed).toBe(true);
  });
});
