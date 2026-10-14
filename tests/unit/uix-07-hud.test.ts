/**
 * UIX-07: radar coordinate mapping both directions, stamina bar steps and levels, power bar fill and placement (pure
 * parts of src/ui/hud/radar.ts, playerInfo.ts and powerBar.ts; Node, no DOM).
 */
import { describe, expect, it } from 'vitest';
import type { SettingsStore } from '../../src/contracts/app';
import { T_PLAYER } from '../../src/contracts/tuning';
import { RADAR_PREF_KEY, onRadarPref, radarEnabled, setRadarEnabled } from '../../src/ui/hud/hudShared';
import { PLAYER_INFO_TUNING, staminaLevel, staminaStep } from '../../src/ui/hud/playerInfo';
import { POWER_BAR_TUNING, powerBarPosition, powerStep } from '../../src/ui/hud/powerBar';
import { RADAR_TUNING, luminance, pitchToRadar, radarCanvasSize, radarLayout, radarToPitch } from '../../src/ui/hud/radar';

describe('UIX-07 radar mapping', () => {
  const L = radarLayout(RADAR_TUNING.width, RADAR_TUNING.height, RADAR_TUNING.pad);

  it('fits the 105 x 68 pitch inside the padded canvas, aspect kept, centred', () => {
    expect(L.cx).toBe(RADAR_TUNING.width / 2);
    expect(L.cy).toBe(RADAR_TUNING.height / 2);
    expect(105 * L.scale).toBeLessThanOrEqual(RADAR_TUNING.width - 2 * RADAR_TUNING.pad + 1e-9);
    expect(68 * L.scale).toBeLessThanOrEqual(RADAR_TUNING.height - 2 * RADAR_TUNING.pad + 1e-9);
    // One side touches its padding (no wasted space).
    const fillsW = Math.abs(105 * L.scale - (RADAR_TUNING.width - 2 * RADAR_TUNING.pad)) < 1e-9;
    const fillsH = Math.abs(68 * L.scale - (RADAR_TUNING.height - 2 * RADAR_TUNING.pad)) < 1e-9;
    expect(fillsW || fillsH).toBe(true);
  });

  it('pitch -> radar keeps the broadcast view: centre spot in the middle, +x right, +z down', () => {
    const o = { x: 0, y: 0 };
    pitchToRadar(L, 0, 0, o);
    expect(o).toEqual({ x: L.cx, y: L.cy });
    pitchToRadar(L, 52.5, 0, o);
    expect(o.x).toBeGreaterThan(L.cx);
    expect(o.y).toBeCloseTo(L.cy, 9);
    pitchToRadar(L, 0, 34, o);
    expect(o.y).toBeGreaterThan(L.cy);
    pitchToRadar(L, -52.5, -34, o);
    expect(o.x).toBeGreaterThanOrEqual(RADAR_TUNING.pad - 1e-9);
    expect(o.y).toBeGreaterThanOrEqual(RADAR_TUNING.pad - 1e-9);
  });

  it('every pitch corner lands inside the canvas', () => {
    const o = { x: 0, y: 0 };
    for (const [x, z] of [[-52.5, -34], [52.5, -34], [-52.5, 34], [52.5, 34]] as const) {
      pitchToRadar(L, x, z, o);
      expect(o.x).toBeGreaterThanOrEqual(0);
      expect(o.x).toBeLessThanOrEqual(L.w);
      expect(o.y).toBeGreaterThanOrEqual(0);
      expect(o.y).toBeLessThanOrEqual(L.h);
    }
  });

  it('radar -> pitch inverts pitch -> radar (round trip both directions)', () => {
    const r = { x: 0, y: 0 };
    const p = { x: 0, z: 0 };
    for (const [x, z] of [[0, 0], [10.5, -3.25], [-40, 20], [52.5, 34], [-52.5, -34], [16.5, 20.16]] as const) {
      pitchToRadar(L, x, z, r);
      radarToPitch(L, r.x, r.y, p);
      expect(p.x).toBeCloseTo(x, 9);
      expect(p.z).toBeCloseTo(z, 9);
    }
    for (const [rx, ry] of [[L.cx, L.cy], [20, 30], [150, 90], [RADAR_TUNING.pad, RADAR_TUNING.pad]] as const) {
      radarToPitch(L, rx, ry, p);
      pitchToRadar(L, p.x, p.z, r);
      expect(r.x).toBeCloseTo(rx, 9);
      expect(r.y).toBeCloseTo(ry, 9);
    }
  });

  it('clamps points outside the canvas (ball beyond the boards) and ignores non-finite input', () => {
    const o = { x: 0, y: 0 };
    pitchToRadar(L, 400, -400, o);
    expect(o).toEqual({ x: L.w, y: 0 });
    pitchToRadar(L, Number.NaN, Number.POSITIVE_INFINITY, o);
    expect(o).toEqual({ x: L.cx, y: L.cy });
  });

  it('scales with the larger-HUD canvas', () => {
    const big = radarLayout(RADAR_TUNING.width * 1.25, RADAR_TUNING.height * 1.25, RADAR_TUNING.pad * 1.25);
    expect(big.scale).toBeCloseTo(L.scale * 1.25, 9);
  });

  it('canvas size follows the HUD scale but never exceeds the viewport-height cap (21:9 keeps the ball region clear)', () => {
    const o = { w: 0, h: 0 };
    expect(radarCanvasSize(1, 820, o)).toEqual({ w: RADAR_TUNING.width, h: RADAR_TUNING.height });
    expect(radarCanvasSize(1.25, 820, o)).toEqual({ w: Math.round(RADAR_TUNING.width * 1.25), h: Math.round(RADAR_TUNING.height * 1.25) });
    radarCanvasSize(1.25, 540, o);
    expect(o.h).toBeLessThanOrEqual(Math.round(RADAR_TUNING.maxVh * 540));
    expect(o.w / o.h).toBeCloseTo(RADAR_TUNING.width / RADAR_TUNING.height, 1);
    expect(radarCanvasSize(1, 0, o).w).toBe(RADAR_TUNING.width);
  });

  it('dark kits get a light outline (luminance)', () => {
    expect(luminance(0x000000)).toBe(0);
    expect(luminance(0xffffff)).toBeCloseTo(1, 9);
    expect(luminance(0x101830)).toBeLessThan(0.09);
    expect(luminance(0xffd700)).toBeGreaterThan(0.5);
  });
});

describe('UIX-07 stamina bar', () => {
  it('steps in whole percent, clamped', () => {
    expect(staminaStep(1)).toBe(PLAYER_INFO_TUNING.steps);
    expect(staminaStep(0.5)).toBe(50);
    expect(staminaStep(0.123)).toBe(12);
    expect(staminaStep(0)).toBe(0);
    expect(staminaStep(-1)).toBe(0);
    expect(staminaStep(2)).toBe(100);
    expect(staminaStep(Number.NaN)).toBe(0);
  });

  it('a tiny drain does not change the step (no DOM write); a percent does', () => {
    expect(staminaStep(0.8)).toBe(staminaStep(0.8 - 0.002));
    expect(staminaStep(0.8)).not.toBe(staminaStep(0.785));
  });

  it('turns amber below the tuning low threshold and red below critical', () => {
    expect(staminaLevel(1)).toBe(0);
    expect(staminaLevel(T_PLAYER.staminaLowThreshold)).toBe(0);
    expect(staminaLevel(T_PLAYER.staminaLowThreshold - 0.01)).toBe(1);
    expect(staminaLevel(PLAYER_INFO_TUNING.staminaCritical - 0.01)).toBe(2);
    expect(staminaLevel(Number.NaN)).toBe(2);
  });
});

describe('UIX-07 power bar', () => {
  it('fills by whole percent of ctrl.power', () => {
    expect(powerStep(0)).toBe(0);
    expect(powerStep(0.333)).toBe(33);
    expect(powerStep(1)).toBe(POWER_BAR_TUNING.steps);
    expect(powerStep(1.5)).toBe(100);
    expect(powerStep(Number.NaN)).toBe(0);
  });

  it('sits centred above the projected anchor, in whole pixels', () => {
    const o = { x: 0, y: 0 };
    powerBarPosition(500.4, 300.6, 1180, 820, 64, 8, 10, 8, o);
    expect(o).toEqual({ x: Math.round(500.4 - 32), y: Math.round(300.6 - 18) });
  });

  it('stays inside the viewport near every edge', () => {
    const o = { x: 0, y: 0 };
    powerBarPosition(-200, -50, 1180, 820, 64, 8, 10, 8, o);
    expect(o).toEqual({ x: 8, y: 8 });
    powerBarPosition(5000, 5000, 1180, 820, 64, 8, 10, 8, o);
    expect(o).toEqual({ x: 1180 - 8 - 64, y: 820 - 8 - 8 });
  });
});

describe('UIX-07 radar toggle preference', () => {
  function progressStore(): SettingsStore {
    const data: Record<string, unknown> = {};
    return {
      persistent: true,
      get: () => { throw new Error('unused'); },
      update: () => undefined,
      subscribe: () => () => undefined,
      reset: () => undefined,
      loadProgress: <T>(k: string) => (k in data ? (data[k] as T) : null),
      saveProgress: <T>(k: string, v: T) => { data[k] = v; },
      clearProgress: () => { for (const k of Object.keys(data)) delete data[k]; },
    };
  }

  it('is on by default, persists off / on, and tells the HUD parts at once', () => {
    const st = progressStore();
    expect(radarEnabled(st)).toBe(true);
    const seen: boolean[] = [];
    const off = onRadarPref((on) => seen.push(on));
    setRadarEnabled(st, false);
    expect(radarEnabled(st)).toBe(false);
    expect(st.loadProgress(RADAR_PREF_KEY)).toEqual({ on: false });
    setRadarEnabled(st, true);
    expect(radarEnabled(st)).toBe(true);
    off();
    setRadarEnabled(st, false);
    expect(seen).toEqual([false, true]);
    st.clearProgress();
    expect(radarEnabled(st)).toBe(true); // data reset brings it back
  });

  it('survives broken storage', () => {
    const broken = { ...progressStore(), loadProgress: () => { throw new Error('blocked'); }, saveProgress: () => { throw new Error('blocked'); } } as SettingsStore;
    expect(radarEnabled(broken)).toBe(true);
    expect(() => setRadarEnabled(broken, false)).not.toThrow();
    expect(radarEnabled(null)).toBe(true);
  });
});
