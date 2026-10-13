/**
 * TCH-02 floating virtual stick (BRIEF section 9 "Layout", strafe note, "Touch quality bar"; brief TCH-02):
 * vector maths, radial dead zone, radial clamp, drag-along at 1.4 x radius, fixed stick, double-tap-and-hold strafe,
 * release / cancel / releaseAll zeroing, the stick zone (mirror, safe area, system-gesture margins), multi-touch
 * through the real pointer manager, the glitch-list line "stuck stick after pointercancel", a sim scenario (the stick
 * drives the controlled player, release / cancel stops him) and a no-allocation probe.
 * Pure Node: controls are driven through the TouchControl interface or synthetic PointerEvents on a fake element.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoSwitch, MatchPhase } from '../../src/contracts/enums';
import { createInputFrame, type InputFrame, type InputSampleContext } from '../../src/contracts/input';
import { createDefaultSettings, type TouchSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createTouchIntentState, type TouchControl, type TouchIntentState } from '../../src/contracts/touch';
import { T_TOUCHUI } from '../../src/contracts/tuning';
import { createTouchMapper } from '../../src/input/touch/mapper';
import { createPointerManager } from '../../src/input/touch/pointers';
import {
  clearOfSystemEdges, computeStick, computeStickConfig, createStick, createStickConfig, followOrigin, inStickZone,
  LOCAL_TUNING, STICK_DEAD_ZONE, STICK_LAYOUT_KEY, type StickConfig,
} from '../../src/input/touch/stick';
import { initMatch } from '../../src/sim/init';
import { makeScenario, runTicks } from '../harness/scenario';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const R = 70;
const DEAD = STICK_DEAD_ZONE;
const LEASH = LOCAL_TUNING.followMul * R;
const W = 1180;
const H = 820;
const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** Expected magnitude for a thumb `d` px from the origin (dead zone rescaled, clamped). */
const mag = (d: number, r = R): number => (d / r <= DEAD ? 0 : Math.min(1, (d / r - DEAD) / (1 - DEAD)));
const len = (x: number, y: number): number => Math.sqrt(x * x + y * y);

function touchSettings(over: Partial<TouchSettings> = {}): TouchSettings {
  return { ...createDefaultSettings().controls.touch, ...over };
}

function floatingStick(state: TouchIntentState = createTouchIntentState()) {
  return { st: state, stick: createStick({ state, zone: (x) => x < W / 2, radius: R }) };
}

function configuredStick(cfg: StickConfig, state: TouchIntentState = createTouchIntentState()) {
  return { st: state, cfg, stick: createStick({ state, zone: () => true, config: () => cfg }) };
}

function expectZeroed(st: TouchIntentState): void {
  expect(st.stickActive).toBe(false);
  expect(st.stickX).toBe(0);
  expect(st.stickY).toBe(0);
  expect(st.stickStrafe).toBe(false);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------------- vector maths

describe('TCH-02 vector maths', () => {
  const v = { x: 0, y: 0 };

  it('radial dead zone: a thumb inside it gives exactly zero in every direction', () => {
    for (let a = 0; a < 360; a += 15) {
      const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
      for (const f of [0, 0.02, 0.06, DEAD * 0.999]) {
        computeStick(300, 400, 300 + c * f * R, 400 + s * f * R, R, DEAD, v);
        expect(v.x).toBe(0);
        expect(v.y).toBe(0);
      }
    }
  });

  it('analogue deflection: starts at 0 just past the dead zone, grows with tilt, full at the rim (partial tilt jogs, full tilt runs)', () => {
    let prev = -1;
    for (let d = 0; d <= R * 1.2; d += 2) {
      computeStick(100, 100, 100 + d, 100, R, DEAD, v);
      expect(v.x).toBeCloseTo(mag(d), 9);
      expect(v.y).toBe(0);
      expect(v.x).toBeGreaterThanOrEqual(prev);
      prev = v.x;
    }
    computeStick(100, 100, 100 + R * (DEAD + 0.001), 100, R, DEAD, v);
    expect(v.x).toBeGreaterThan(0);
    expect(v.x).toBeLessThan(0.01);
    computeStick(100, 100, 100, 100 - R * 0.5, R, DEAD, v); // partial tilt up (screen y down)
    expect(v.y).toBeCloseTo(-(0.5 - DEAD) / (1 - DEAD), 9);
    computeStick(100, 100, 100 + R, 100, R, DEAD, v);
    expect(v.x).toBeCloseTo(1, 9);
  });

  it('radial clamp: magnitude never exceeds 1 and the vector points at the thumb', () => {
    for (let a = 0; a < 360; a += 7.5) {
      const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
      for (const f of [0.3, 0.7, 1, 1.01, 1.4, 3, 20]) {
        computeStick(500, 500, 500 + c * f * R, 500 + s * f * R, R, DEAD, v);
        const m = len(v.x, v.y);
        expect(m).toBeLessThanOrEqual(1 + 1e-12);
        expect(m).toBeCloseTo(mag(f * R), 9);
        expect(v.x * c + v.y * s).toBeCloseTo(m, 9); // same direction as the thumb
      }
    }
  });

  it('degenerate inputs stay finite: zero radius, NaN or infinite thumb', () => {
    computeStick(0, 0, 0.5, 0, 0, DEAD, v); // radius floored at 1 px
    expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true);
    computeStick(0, 0, Number.NaN, 0, R, DEAD, v);
    expect(v).toEqual({ x: 0, y: 0 });
    computeStick(0, 0, Number.POSITIVE_INFINITY, 0, R, DEAD, v);
    expect(v).toEqual({ x: 0, y: 0 });
  });

  it('followOrigin keeps the origin within the leash and on the line to the thumb', () => {
    followOrigin(0, 0, LEASH - 1, 0, LEASH, v);
    expect(v).toEqual({ x: 0, y: 0 });
    followOrigin(0, 0, 300, 400, LEASH, v); // 500 px away on a 3-4-5 line
    expect(len(300 - v.x, 400 - v.y)).toBeCloseTo(LEASH, 9);
    expect(v.x / 300).toBeCloseTo(v.y / 400, 9);
    followOrigin(0, 0, Number.NaN, 0, LEASH, v);
    expect(v).toEqual({ x: 0, y: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------- floating

describe('TCH-02 floating stick', () => {
  it('appears where the thumb lands and writes origin, thumb and vector on touch-down and every move', () => {
    const { st, stick } = floatingStick();
    expect(stick.hit(200, 500)).toBe(true);
    expect(stick.hit(800, 500)).toBe(false);
    stick.down(3, 200, 500, 0);
    expect(stick.pointerId).toBe(3);
    expect(st.stickActive).toBe(true);
    expect([st.stickOriginX, st.stickOriginY, st.stickThumbX, st.stickThumbY]).toEqual([200, 500, 200, 500]);
    expect([st.stickX, st.stickY]).toEqual([0, 0]);
    stick.move(3, 200 + R * 0.5, 500, 16);
    expect(st.stickX).toBeCloseTo(mag(R * 0.5), 9);
    expect(st.stickThumbX).toBe(200 + R * 0.5);
    stick.move(3, 200, 500 + R * 0.25, 32);
    expect(st.stickX).toBe(0);
    expect(st.stickY).toBeCloseTo(mag(R * 0.25), 9);
    stick.move(3, 200, 500 + R * 0.05, 48); // back inside the dead zone: still active, no movement
    expect(st.stickActive).toBe(true);
    expect([st.stickX, st.stickY]).toEqual([0, 0]);
  });

  it('drag-along: the origin stays put up to 1.4 x radius, then follows exactly 1.4 x radius behind the thumb', () => {
    const { st, stick } = floatingStick();
    stick.down(1, 200, 500, 0);
    stick.move(1, 200 + R * 1.3, 500, 16);
    expect(st.stickOriginX).toBe(200);
    expect(st.stickX).toBeCloseTo(1, 9);
    stick.move(1, 200 + R * 1.4, 500, 32);
    expect(st.stickOriginX).toBe(200);
    stick.move(1, 200 + R * 2, 500, 48);
    expect(st.stickOriginX).toBeCloseTo(200 + R * 0.6, 9);
    expect(len(st.stickThumbX - st.stickOriginX, st.stickThumbY - st.stickOriginY)).toBeCloseTo(LEASH, 9);
    expect(st.stickX).toBeCloseTo(1, 9);
    // Coming back inside the leash does not move the origin back.
    stick.move(1, 200 + R * 0.6 + R * 0.5, 500, 64);
    expect(st.stickOriginX).toBeCloseTo(200 + R * 0.6, 9);
    expect(st.stickX).toBeCloseTo(mag(R * 0.5), 9);
  });

  it('long pushes keep working: a 1000 px curved push stays at full tilt toward the thumb; reversing needs at most 2.4 radii', () => {
    const { st, stick } = floatingStick();
    let x = 100, y = 600;
    stick.down(1, x, y, 0);
    for (let i = 1; i <= 100; i++) {
      const a = (i / 100) * (Math.PI / 2); // heading turns from right to up over the push
      const hx = Math.cos(a), hy = -Math.sin(a);
      x += hx * 10; y += hy * 10;
      stick.move(1, x, y, i * 8);
      expect(Number.isFinite(st.stickOriginX) && Number.isFinite(st.stickOriginY)).toBe(true);
      expect(len(x - st.stickOriginX, y - st.stickOriginY)).toBeLessThanOrEqual(LEASH + 1e-9);
      if (i > 20) {
        expect(len(st.stickX, st.stickY)).toBeCloseTo(1, 9);
        expect(st.stickX * hx + st.stickY * hy).toBeGreaterThan(0.9); // points (almost) where the thumb is heading
      }
    }
    // Reverse: (1.4 + 1) radii of travel back through the origin is full tilt the other way.
    const d = len(x - st.stickOriginX, y - st.stickOriginY);
    expect(d).toBeCloseTo(LEASH, 9);
    const ux = (x - st.stickOriginX) / d, uy = (y - st.stickOriginY) / d;
    stick.move(1, x - ux * (LEASH + R), y - uy * (LEASH + R), 900);
    expect(st.stickX * -ux + st.stickY * -uy).toBeCloseTo(1, 9);
    expect(len(st.stickX, st.stickY)).toBeCloseTo(1, 9);
  });

  it('release zeroes: up, pointercancel and releaseAll each stop the stick at once', () => {
    const { st, stick } = floatingStick();
    stick.down(1, 200, 500, 0);
    stick.move(1, 260, 470, 16);
    expect(st.stickX).toBeGreaterThan(0);
    stick.up(1, 260, 470, 400);
    expectZeroed(st);
    expect(stick.pointerId).toBe(-1);
    stick.down(2, 200, 500, 1000);
    stick.move(2, 200, 420, 1016);
    stick.cancel(2, 1020);
    expectZeroed(st);
    stick.down(3, 200, 500, 2000);
    stick.move(3, 120, 500, 2016);
    stick.releaseAll(2020);
    expectZeroed(st);
    // After a release the next touch starts a fresh stick where it lands.
    stick.down(4, 330, 610, 3000);
    expect(st.stickActive).toBe(true);
    expect([st.stickOriginX, st.stickOriginY]).toEqual([330, 610]);
    expect([st.stickX, st.stickY]).toEqual([0, 0]);
  });

  it('one pointer drives the stick: other pointers never steal it and their up / cancel do not release it', () => {
    const { st, stick } = floatingStick();
    stick.down(1, 200, 500, 0);
    stick.move(1, 270, 500, 10);
    stick.down(2, 300, 300, 20); // second finger in the zone: claimed and ignored
    stick.move(2, 0, 0, 30);
    expect(stick.pointerId).toBe(1);
    expect([st.stickOriginX, st.stickOriginY]).toEqual([200, 500]);
    expect(st.stickX).toBeCloseTo(1, 9);
    stick.up(2, 0, 0, 40);
    stick.cancel(2, 50);
    expect(st.stickActive).toBe(true);
    expect(st.stickX).toBeCloseTo(1, 9);
    stick.up(1, 270, 500, 60);
    expectZeroed(st);
  });

  it('non-finite coordinates are ignored and the state stays finite', () => {
    const { st, stick } = floatingStick();
    stick.down(1, Number.NaN, 500, 0);
    expect(st.stickActive).toBe(false);
    stick.down(1, 200, 500, 0);
    stick.move(1, 240, 500, 10);
    const x = st.stickX;
    stick.move(1, Number.NaN, 500, 20);
    stick.move(1, 240, Number.POSITIVE_INFINITY, 30);
    expect(st.stickX).toBe(x);
    for (const k of ['stickX', 'stickY', 'stickOriginX', 'stickOriginY', 'stickThumbX', 'stickThumbY'] as const) {
      expect(Number.isFinite(st[k])).toBe(true);
    }
    stick.up(1, Number.NaN, Number.NaN, 40);
    expectZeroed(st);
  });
});

// ---------------------------------------------------------------------------------------------------- strafe

describe('TCH-02 double-tap and hold the stick: face-up strafe dribble', () => {
  const DT = T_TOUCHUI.doubleTapMs;

  function tap(stick: ReturnType<typeof floatingStick>['stick'], id: number, x: number, y: number, t: number, ms = 60): void {
    stick.down(id, x, y, t);
    stick.move(id, x + 3, y - 2, t + ms / 2);
    stick.up(id, x + 3, y - 2, t + ms);
  }

  it('tap, then a touch-down within doubleTapMs sets stickStrafe while it is held; the stick still steers; release clears it', () => {
    const { st, stick } = floatingStick();
    tap(stick, 1, 200, 500, 0);
    expect(st.stickStrafe).toBe(false);
    stick.down(2, 206, 497, DT - 10);
    expect(st.stickStrafe).toBe(true);
    expect(st.stickActive).toBe(true);
    stick.move(2, 206 + R, 497, DT + 100);
    expect(st.stickStrafe).toBe(true);
    expect(st.stickX).toBeCloseTo(1, 9);
    stick.move(2, 206 - R, 497, DT + 600); // long hold, any direction: still strafing
    expect(st.stickStrafe).toBe(true);
    expect(st.stickX).toBeCloseTo(-1, 9);
    stick.up(2, 206 - R, 497, DT + 900);
    expectZeroed(st);
  });

  it('the window is measured down to down and is inclusive of doubleTapMs', () => {
    const { st, stick } = floatingStick();
    tap(stick, 1, 200, 500, 1000);
    stick.down(2, 200, 500, 1000 + DT);
    expect(st.stickStrafe).toBe(true);
    stick.up(2, 200, 500, 1000 + DT + 400);
    tap(stick, 3, 200, 500, 5000);
    stick.down(4, 200, 500, 5000 + DT + 1);
    expect(st.stickStrafe).toBe(false);
  });

  it('no strafe when the first touch was a push (travel > tapMaxPt): a quick lift-and-replant while dribbling', () => {
    const { st, stick } = floatingStick();
    stick.down(1, 200, 500, 0);
    stick.move(1, 200 + T_TOUCHUI.tapMaxPt + 2, 500, 40);
    stick.up(1, 200 + T_TOUCHUI.tapMaxPt + 2, 500, 80);
    stick.down(2, 200, 500, 150);
    expect(st.stickStrafe).toBe(false);
  });

  it('no strafe when the first touch was held longer than tapMaxMs', () => {
    const { st, stick } = floatingStick();
    stick.down(1, 200, 500, 0);
    stick.up(1, 200, 500, T_TOUCHUI.tapMaxMs + 1);
    stick.down(2, 200, 500, T_TOUCHUI.tapMaxMs + 20);
    expect(st.stickStrafe).toBe(false);
  });

  it('no strafe when the second touch lands more than doubleTapSlopMul radii from the tap', () => {
    const { st, stick } = floatingStick();
    tap(stick, 1, 200, 500, 0);
    stick.down(2, 200 + LOCAL_TUNING.doubleTapSlopMul * R + 5, 500, 120);
    expect(st.stickStrafe).toBe(false);
  });

  it('a cancelled touch is not a tap, and releaseAll forgets a pending tap', () => {
    const { st, stick } = floatingStick();
    stick.down(1, 200, 500, 0);
    stick.cancel(1, 40);
    stick.down(2, 200, 500, 100);
    expect(st.stickStrafe).toBe(false);
    stick.up(2, 200, 500, 150); // this one was a tap ...
    stick.releaseAll(160); // ... but a pause / blur in between forgets it
    stick.down(3, 200, 500, 200);
    expect(st.stickStrafe).toBe(false);
  });

  it('a triple tap strafes once: the strafe touch itself never counts as the first tap of the next double tap', () => {
    const { st, stick } = floatingStick();
    tap(stick, 1, 200, 500, 0);
    stick.down(2, 200, 500, 100);
    expect(st.stickStrafe).toBe(true);
    stick.up(2, 200, 500, 140);
    stick.down(3, 200, 500, 200);
    expect(st.stickStrafe).toBe(false);
  });

  it('pointercancel and releaseAll mid-strafe clear stickStrafe with the stick', () => {
    const { st, stick } = floatingStick();
    tap(stick, 1, 200, 500, 0);
    stick.down(2, 200, 500, 100);
    stick.move(2, 260, 500, 120);
    stick.cancel(2, 200);
    expectZeroed(st);
    tap(stick, 3, 200, 500, 1000);
    stick.down(4, 200, 500, 1100);
    expect(st.stickStrafe).toBe(true);
    stick.releaseAll(1200);
    expectZeroed(st);
  });

  it('a second finger landing in the zone while the stick is held never starts a double tap', () => {
    const { st, stick } = floatingStick();
    stick.down(1, 200, 500, 0);
    stick.down(2, 205, 500, 50); // ignored: the stick is busy
    stick.up(2, 205, 500, 80);
    stick.up(1, 200, 500, 100); // stick tap
    stick.down(3, 200, 500, 120);
    expect(st.stickStrafe).toBe(true); // only the real stick tap counted
  });
});

// ---------------------------------------------------------------------------------------------------- zone

describe('TCH-02 stick zone: half, mirror, safe area and system-gesture margins', () => {
  const M = T_TOUCHUI.systemEdgeMargin;

  it('the stick can start anywhere in its half except the 24 pt system-gesture margins (iPad 1180 x 820)', () => {
    const cfg = computeStickConfig(W, H, NO_INSETS, touchSettings());
    for (let x = 0; x <= W; x += 10) {
      for (let y = 0; y <= H; y += 4) {
        const expected = x < W / 2 && y >= M && y <= H - M;
        expect(inStickZone(cfg, x, y), `(${x}, ${y})`).toBe(expected);
      }
    }
  });

  it('never starts within 24 pt of the bottom edge of the safe area (home indicator), nor above the top margin', () => {
    const safe = { top: 24, right: 0, bottom: 20, left: 0 };
    const cfg = computeStickConfig(W, H, safe, touchSettings());
    expect(inStickZone(cfg, 200, H - 20 - M)).toBe(true);
    expect(inStickZone(cfg, 200, H - 20 - M + 0.5)).toBe(false);
    expect(inStickZone(cfg, 200, H - 1)).toBe(false);
    expect(inStickZone(cfg, 200, 24 + M)).toBe(true);
    expect(inStickZone(cfg, 200, 24 + M - 0.5)).toBe(false);
    expect(clearOfSystemEdges(H - 10, H, 0, 0)).toBe(false);
    expect(clearOfSystemEdges(H / 2, H, 0, 0)).toBe(true);
  });

  it('respects left / right safe-area insets (landscape notch)', () => {
    const safe = { top: 0, right: 47, bottom: 21, left: 47 };
    const cfg = computeStickConfig(1024, 768, safe, touchSettings());
    expect(inStickZone(cfg, 30, 400)).toBe(false);
    expect(inStickZone(cfg, 50, 400)).toBe(true);
    const m = computeStickConfig(1024, 768, safe, touchSettings({ mirror: true }));
    expect(inStickZone(m, 1024 - 30, 400)).toBe(false);
    expect(inStickZone(m, 1024 - 50, 400)).toBe(true);
  });

  it('mirror (left-handed): the stick zone is the right half', () => {
    const cfg = computeStickConfig(W, H, NO_INSETS, touchSettings({ mirror: true }));
    expect(inStickZone(cfg, 200, 400)).toBe(false);
    expect(inStickZone(cfg, W / 2 - 1, 400)).toBe(false);
    expect(inStickZone(cfg, W / 2, 400)).toBe(true);
    expect(inStickZone(cfg, 1000, 400)).toBe(true);
    expect(inStickZone(cfg, 1000, H - 5)).toBe(false);
  });

  it('createStick with a live config: hit() follows the zone; a mirror change applies to the next touch, never mid-touch', () => {
    const cfg = computeStickConfig(W, H, NO_INSETS, touchSettings());
    const { st, stick } = configuredStick(cfg);
    expect(stick.hit(200, 400)).toBe(true);
    expect(stick.hit(900, 400)).toBe(false);
    expect(stick.hit(200, H - 10)).toBe(false);
    stick.down(1, 200, 400, 0);
    computeStickConfig(W, H, NO_INSETS, touchSettings({ mirror: true }), cfg);
    stick.move(1, 260, 400, 16);
    expect(st.stickX).toBeCloseTo(mag(60), 9); // the held touch keeps working
    stick.up(1, 260, 400, 300);
    expect(stick.hit(200, 400)).toBe(false);
    expect(stick.hit(900, 400)).toBe(true);
  });

  it('the `zone` callback still vetoes (other controls may carve space out of the half)', () => {
    const cfg = computeStickConfig(W, H, NO_INSETS, touchSettings());
    const st = createTouchIntentState();
    const stick = createStick({ state: st, zone: (x, y) => !(x < 100 && y < 200), config: () => cfg });
    expect(stick.hit(50, 100)).toBe(false);
    expect(stick.hit(50, 300)).toBe(true);
  });

  it('without a config (current index.ts wiring) the window height still keeps the stick out of the bottom and top margins', () => {
    const { stick } = floatingStick();
    expect(stick.hit(200, H - 5)).toBe(true); // Node: no window, `zone` alone decides
    vi.stubGlobal('innerHeight', H);
    expect(stick.hit(200, H - 5)).toBe(false);
    expect(stick.hit(200, H - M)).toBe(true);
    expect(stick.hit(200, 5)).toBe(false);
    expect(stick.hit(200, 400)).toBe(true);
    expect(stick.hit(800, 400)).toBe(false);
  });

  it('an unknown viewport (config not computed yet) never blocks the stick', () => {
    const cfg = createStickConfig();
    expect(inStickZone(cfg, 5, 5)).toBe(true);
    expect(inStickZone(cfg, Number.NaN, 5)).toBe(false);
    const { st, stick } = configuredStick({ ...cfg, floating: false });
    expect(stick.hit(300, 300)).toBe(true);
    stick.down(1, 300, 300, 0); // fixed with no geometry: behaves as floating
    expect([st.stickOriginX, st.stickOriginY]).toEqual([300, 300]);
  });
});

// ---------------------------------------------------------------------------------------------------- fixed

describe('TCH-02 fixed stick (controls editor: fixed or floating)', () => {
  it('default placement: bottom left of the safe area, ring inside its half and clear of the margins; mirrored to the right', () => {
    const safe = { top: 24, right: 0, bottom: 20, left: 0 };
    const cfg = computeStickConfig(W, H, safe, touchSettings({ floatingStick: false }));
    expect(cfg.floating).toBe(false);
    expect(cfg.radius).toBe(T_TOUCHUI.stickRadius);
    expect(cfg.fixedX).toBe(LOCAL_TUNING.fixedDx);
    expect(cfg.fixedY).toBe(H - 20 - LOCAL_TUNING.fixedDy);
    expect(cfg.fixedY + cfg.radius).toBeLessThanOrEqual(H - 20 - T_TOUCHUI.systemEdgeMargin);
    const m = computeStickConfig(W, H, safe, touchSettings({ floatingStick: false, mirror: true }));
    expect(m.fixedX).toBe(W - LOCAL_TUNING.fixedDx);
    expect(m.fixedY).toBe(cfg.fixedY);
  });

  it('editor placement (layout.stick dx / dy / scale) sets the origin and radius; out-of-range values are clamped', () => {
    const layout = { [STICK_LAYOUT_KEY]: { dx: 220, dy: 180, scale: 1.2 } };
    const cfg = computeStickConfig(W, H, NO_INSETS, touchSettings({ floatingStick: false, layout }));
    expect(cfg.fixedX).toBe(220);
    expect(cfg.fixedY).toBe(H - 180);
    expect(cfg.radius).toBeCloseTo(T_TOUCHUI.stickRadius * 1.2, 9);
    const wild = { [STICK_LAYOUT_KEY]: { dx: -500, dy: 99999, scale: 9 } };
    const c2 = computeStickConfig(W, H, NO_INSETS, touchSettings({ floatingStick: false, layout: wild }));
    expect(c2.radius).toBeCloseTo(T_TOUCHUI.stickRadius * LOCAL_TUNING.scaleMax, 9);
    expect(c2.fixedX).toBeCloseTo(c2.radius, 9);
    expect(c2.fixedY).toBeCloseTo(T_TOUCHUI.systemEdgeMargin + c2.radius, 9);
    const far = { [STICK_LAYOUT_KEY]: { dx: 2000, dy: -50, scale: Number.NaN } };
    const c3 = computeStickConfig(W, H, NO_INSETS, touchSettings({ floatingStick: false, layout: far }));
    expect(c3.radius).toBe(T_TOUCHUI.stickRadius);
    expect(c3.fixedX + c3.radius).toBeLessThanOrEqual(W / 2 + 1e-9);
    expect(c3.fixedY + c3.radius).toBeLessThanOrEqual(H - T_TOUCHUI.systemEdgeMargin + 1e-9);
  });

  it('the origin is the fixed point, the vector points from it to the thumb, and it never drags along', () => {
    const cfg = computeStickConfig(W, H, NO_INSETS, touchSettings({ floatingStick: false }));
    const { st, stick } = configuredStick(cfg);
    const fx = cfg.fixedX, fy = cfg.fixedY;
    stick.down(1, fx + R * 0.5, fy, 0); // lands half a radius right of the centre: immediate partial tilt
    expect([st.stickOriginX, st.stickOriginY]).toEqual([fx, fy]);
    expect(st.stickX).toBeCloseTo(mag(R * 0.5), 9);
    stick.move(1, fx + R * 5, fy, 16); // far beyond the rim
    expect([st.stickOriginX, st.stickOriginY]).toEqual([fx, fy]);
    expect(st.stickX).toBeCloseTo(1, 9);
    stick.move(1, fx - R, fy, 32); // reversal is relative to the fixed centre
    expect(st.stickX).toBeCloseTo(-1, 9);
    stick.up(1, fx - R, fy, 48);
    expectZeroed(st);
    expect([st.stickThumbX, st.stickThumbY]).toEqual([fx, fy]); // knob recentred for an idle fixed base
  });

  it('claims only touches within fixedCatchMul radii of the fixed origin; the rest of the half stays free for gestures', () => {
    const cfg = computeStickConfig(W, H, NO_INSETS, touchSettings({ floatingStick: false }));
    const { stick } = configuredStick(cfg);
    const c = LOCAL_TUNING.fixedCatchMul * cfg.radius;
    expect(stick.hit(cfg.fixedX, cfg.fixedY)).toBe(true);
    expect(stick.hit(cfg.fixedX + c - 1, cfg.fixedY)).toBe(true);
    expect(stick.hit(cfg.fixedX + c + 1, cfg.fixedY)).toBe(false);
    expect(stick.hit(cfg.fixedX, 100)).toBe(false);
  });

  it('the scaled radius is used for the vector and kept for the whole touch', () => {
    const layout = { [STICK_LAYOUT_KEY]: { dx: 200, dy: 200, scale: 1.4 } };
    const cfg = computeStickConfig(W, H, NO_INSETS, touchSettings({ layout }));
    const { st, stick } = configuredStick(cfg);
    const r = cfg.radius;
    expect(stick.radius).toBeCloseTo(r, 9);
    stick.down(1, 300, 400, 0);
    computeStickConfig(W, H, NO_INSETS, touchSettings(), cfg); // size changes mid-touch
    stick.move(1, 300 + r * 0.5, 400, 16);
    expect(st.stickX).toBeCloseTo(mag(r * 0.5, r), 9);
    expect(stick.radius).toBeCloseTo(r, 9);
    stick.up(1, 300 + r * 0.5, 400, 400);
    expect(stick.radius).toBe(T_TOUCHUI.stickRadius);
  });
});

// ---------------------------------------------------------------------------------------------------- pointer manager

class FakeEl extends EventTarget {
  readonly captured = new Set<number>();
  setPointerCapture(id: number): void { this.captured.add(id); }
  hasPointerCapture(id: number): boolean { return this.captured.has(id); }
  releasePointerCapture(id: number): void { this.captured.delete(id); }
}
class FakeDoc extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
}

function pev(type: string, id: number, x = 0, y = 0): Event {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { pointerId: id, clientX: x, clientY: y, pointerType: 'touch', button: 0 });
  return e;
}

/** A minimal round button (not TCH-03's) so the routing test depends only on the stick and the pointer manager. */
function fakeButton(cx: number, cy: number, r: number) {
  const held = new Set<number>();
  const c: TouchControl & { held: Set<number> } = {
    held,
    hit: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r,
    down: (id) => { held.add(id); },
    move: () => {},
    up: (id) => { held.delete(id); },
    cancel: (id) => { held.delete(id); },
    releaseAll: () => { held.clear(); },
  };
  return c;
}

function rig() {
  const el = new FakeEl();
  const win = new EventTarget();
  const doc = new FakeDoc();
  const state = createTouchIntentState();
  let t = 0;
  const cfg = computeStickConfig(W, H, NO_INSETS, touchSettings());
  const stick = createStick({ state, zone: () => true, config: () => cfg });
  const buttons = [fakeButton(1100, 720, 48), fakeButton(990, 740, 38), fakeButton(1020, 640, 38), fakeButton(1100, 610, 38)];
  const pm = createPointerManager({
    el: el as unknown as HTMLElement, controls: [...buttons, stick], now: () => t,
    win: win as unknown as Window, doc: doc as unknown as Document,
  });
  const mapper = createTouchMapper(state);
  const ctx: InputSampleContext = { tick: 1, human: 0, side: 0, state: initMatch(createMatchConfig()) as SimState, projector: null };
  const out = createInputFrame();
  const sample = (): InputFrame => { mapper.sample(out, ctx); return out; };
  const at = (ms: number): void => { t = ms; };
  return { el, win, doc, state, stick, buttons, pm, sample, at };
}

describe('TCH-02 stick behind the real pointer manager and mapper', () => {
  it('glitch: stuck stick after pointercancel — a cancel mid-drag stops movement on the very next tick', () => {
    const r = rig();
    r.el.dispatchEvent(pev('pointerdown', 1, 200, 500));
    r.el.dispatchEvent(pev('pointermove', 1, 270, 500));
    expect(r.sample().mx).toBeGreaterThan(100);
    r.el.dispatchEvent(pev('pointercancel', 1));
    expectZeroed(r.state);
    const f = r.sample();
    expect(f.mx).toBe(0);
    expect(f.mz).toBe(0);
    // Late events for the cancelled pointer change nothing.
    r.el.dispatchEvent(pev('pointermove', 1, 300, 500));
    r.el.dispatchEvent(pev('pointerup', 1, 300, 500));
    expectZeroed(r.state);
    expect(r.sample().mx).toBe(0);
  });

  it('glitch: stuck stick after lostpointercapture, window blur or visibilitychange(hidden)', () => {
    for (const how of ['lostpointercapture', 'blur', 'hidden'] as const) {
      const r = rig();
      r.el.dispatchEvent(pev('pointerdown', 7, 200, 500));
      r.el.dispatchEvent(pev('pointermove', 7, 200, 430));
      expect(r.sample().mz).toBeLessThan(-100);
      if (how === 'lostpointercapture') r.el.dispatchEvent(pev('lostpointercapture', 7));
      else if (how === 'blur') r.win.dispatchEvent(new Event('blur'));
      else { r.doc.visibilityState = 'hidden'; r.doc.dispatchEvent(new Event('visibilitychange')); }
      expectZeroed(r.state);
      expect(r.sample().mz, how).toBe(0);
      expect(r.pm.active, how).toBe(0);
    }
  });

  it('glitch: stuck strafe after pointercancel — a cancelled double-tap hold does not keep stickStrafe', () => {
    const r = rig();
    r.at(0);
    r.el.dispatchEvent(pev('pointerdown', 1, 200, 500));
    r.at(60);
    r.el.dispatchEvent(pev('pointerup', 1, 200, 500));
    r.at(150);
    r.el.dispatchEvent(pev('pointerdown', 2, 202, 500));
    expect(r.state.stickStrafe).toBe(true);
    r.el.dispatchEvent(pev('pointercancel', 2));
    expectZeroed(r.state);
  });

  it('five simultaneous touches: stick + four buttons; none steals another; lifting one leaves the others held', () => {
    const r = rig();
    r.el.dispatchEvent(pev('pointerdown', 1, 200, 500));
    r.el.dispatchEvent(pev('pointerdown', 2, 1100, 720));
    r.el.dispatchEvent(pev('pointerdown', 3, 990, 740));
    r.el.dispatchEvent(pev('pointerdown', 4, 1020, 640));
    r.el.dispatchEvent(pev('pointerdown', 5, 1100, 610));
    expect(r.pm.active).toBe(5);
    expect(r.buttons.map((b) => b.held.size)).toEqual([1, 1, 1, 1]);
    r.el.dispatchEvent(pev('pointermove', 1, 270, 500));
    expect(r.state.stickX).toBeCloseTo(1, 9);
    expect(r.stick.pointerId).toBe(1);
    // A button finger sliding into the stick zone stays with its button.
    r.el.dispatchEvent(pev('pointermove', 3, 300, 500));
    expect(r.stick.pointerId).toBe(1);
    expect(r.state.stickX).toBeCloseTo(1, 9);
    r.el.dispatchEvent(pev('pointerup', 1, 270, 500));
    expectZeroed(r.state);
    expect(r.buttons.map((b) => b.held.size)).toEqual([1, 1, 1, 1]);
    r.el.dispatchEvent(pev('pointerdown', 6, 220, 520)); // stick again while four buttons are held
    r.el.dispatchEvent(pev('pointermove', 6, 220, 450));
    expect(r.state.stickY).toBeCloseTo(-1, 9);
    for (const id of [2, 3, 4, 5]) r.el.dispatchEvent(pev('pointerup', id, 0, 0));
    expect(r.state.stickActive).toBe(true);
    expect(r.state.stickY).toBeCloseTo(-1, 9);
  });

  it('a touch-down in the bottom system-gesture margin never reaches the stick', () => {
    const r = rig();
    r.el.dispatchEvent(pev('pointerdown', 1, 200, H - 10));
    r.el.dispatchEvent(pev('pointermove', 1, 270, H - 10));
    expect(r.state.stickActive).toBe(false);
    expect(r.pm.active).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------- scenario

describe('TCH-02 scenario: the stick drives the controlled player through the mapper and the real sim', () => {
  function setup() {
    // Away keeper holds the ball far away: the controlled midfielder moves freely (defence context, no carrier near).
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY,
      humans: [{ side: 0, slot: 6, autoSwitch: AutoSwitch.OFF }],
      players: [{ slot: 6, x: -10, z: 5 }],
      ball: { owner: 11, heldBy: 11, x: 50, y: 1, z: 0 },
    });
    const st = createTouchIntentState();
    const stick = createStick({ state: st, zone: () => true, radius: R });
    const mapper = createTouchMapper(st);
    let t = 0;
    const run = (n: number): void => {
      runTicks(s, n, (tick, state, out) => {
        t += 1000 / 60;
        mapper.sample(out[0]!, { tick, human: 0, side: 0, state, projector: null });
      });
    };
    const p = () => s.players[s.ctrl[0]!.slot]!;
    const speed = (): number => len(p().vx, p().vz);
    return { s, st, stick, run, p, speed, now: () => t };
  }

  it('drag right moves him toward +x; release stops him', () => {
    const g = setup();
    const x0 = g.p().x, z0 = g.p().z;
    g.stick.down(1, 200, 500, g.now());
    g.stick.move(1, 200 + R, 500, g.now());
    g.run(60);
    expect(g.p().x - x0).toBeGreaterThan(2);
    expect(Math.abs(g.p().z - z0)).toBeLessThan(0.5);
    g.stick.up(1, 200 + R, 500, g.now());
    g.run(45);
    expect(g.speed()).toBeLessThan(0.1);
    const xa = g.p().x;
    g.run(30);
    expect(Math.abs(g.p().x - xa)).toBeLessThan(0.05);
  });

  it('partial tilt is slower than full tilt (analogue)', () => {
    const g = setup();
    g.stick.down(1, 200, 500, g.now());
    g.stick.move(1, 200, 500 - R * 0.5, g.now()); // screen up = pitch -z
    g.run(90);
    const half = g.speed();
    expect(half).toBeGreaterThan(0.5);
    g.stick.move(1, 200, 500 - R, g.now());
    g.run(90);
    expect(g.speed()).toBeGreaterThan(half * 1.3);
  });

  it('pointercancel mid-drag stops him (no stuck stick)', () => {
    const g = setup();
    g.stick.down(1, 200, 500, g.now());
    g.stick.move(1, 200 - R, 500, g.now());
    g.run(60);
    expect(g.speed()).toBeGreaterThan(2);
    g.stick.cancel(1, g.now());
    g.run(45);
    expect(g.speed()).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------------------------------- allocation

describe('TCH-02 no allocation per pointer event', () => {
  it('down / move / up cycles (with drag-along and double taps) allocate nothing (child process with --expose-gc)', () => {
    const script = `
      import { createStick, computeStickConfig } from './src/input/touch/stick.ts';
      import { createTouchIntentState } from './src/contracts/touch.ts';
      import { createDefaultSettings } from './src/contracts/settings.ts';
      const st = createTouchIntentState();
      const cfg = computeStickConfig(1180, 820, { top: 0, right: 0, bottom: 20, left: 0 }, createDefaultSettings().controls.touch);
      const s = createStick({ state: st, zone: () => true, config: () => cfg });
      const run = (n) => {
        for (let i = 0; i < n; i++) {
          const t = i * 400;
          s.hit(100, 400); s.down(1, 100, 400, t); s.up(1, 101, 400, t + 40);
          s.down(2, 100, 400, t + 100);
          for (let k = 0; k < 20; k++) s.move(2, 100 + k * 13, 400 - k * 7, t + 100 + k);
          s.cancel(2, t + 200);
        }
      };
      run(3000); globalThis.gc();
      const h0 = process.memoryUsage().heapUsed;
      run(20000);
      const h1 = process.memoryUsage().heapUsed;
      console.log(JSON.stringify({ bytesPerEvent: (h1 - h0) / (20000 * 25) }));
    `;
    const r = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const { bytesPerEvent } = JSON.parse(r.stdout.trim().split('\n').pop()!) as { bytesPerEvent: number };
    expect(bytesPerEvent).toBeLessThan(1);
  });
});
