/**
 * TCH-08 controls editor: pure layout helpers (clamping into the safe area and 24 pt margins, overlap resolution with
 * >= 12 pt gaps, HUD regions and the pause button, mirror, spacing, size, reset) checked against the touch layer's own
 * layout functions (TCH-03 computeClusterLayout, TCH-02 computeStickConfig), so what the editor stores is exactly what
 * the match draws.
 */
import { describe, expect, it } from 'vitest';
import { AutoSwitch, SkillMove } from '../../src/contracts/enums';
import { createDefaultSettings, type TouchSettings } from '../../src/contracts/settings';
import { ClusterSlot, TouchButtonId } from '../../src/contracts/touch';
import { T_TOUCHUI } from '../../src/contracts/tuning';
import { computeClusterLayout } from '../../src/input/touch/attack';
import {
  arcRadius, clampSpot, cloneTouch, controlScale, EDITOR_KEYS, editorBounds, editorCircles, editorObstacles, fixLayout,
  isValidSpot, keySlot, layoutValid, materializeCluster, moveControl, nearestValidSpot, placementFor, resetTouchDefaults,
  scaleControl, setMirror, setSpacing, SKILL_CHOICES, AUTO_SWITCH_CHOICES, type EditorEnv,
} from '../../src/input/touch/editor';
import { GESTURE_RULES } from '../../src/input/touch/gestures';
import { circleClearOfRect, hudRegions } from '../../src/input/touch/overlay';
import { computeStickConfig, STICK_LAYOUT_KEY } from '../../src/input/touch/stick';

const ENV: EditorEnv = { w: 1180, h: 820, safe: { top: 0, right: 0, bottom: 0, left: 0 } };
const SAFE_ENV: EditorEnv = { w: 1180, h: 820, safe: { top: 24, right: 20, bottom: 20, left: 20 } };
const M = T_TOUCHUI.systemEdgeMargin;
const GAP = T_TOUCHUI.buttonGap;
const PASS = String(TouchButtonId.PASS);
const BIG = String(TouchButtonId.SPRINT_SKILL);
const SHOOT = String(TouchButtonId.SHOOT);
const THROUGH = String(TouchButtonId.THROUGH);

function touch(): TouchSettings {
  return cloneTouch(createDefaultSettings().controls.touch);
}

function circle(t: TouchSettings, key: string, env = ENV) {
  return editorCircles(env, t)[EDITOR_KEYS.indexOf(key)]!;
}

describe('TCH-08 model matches the touch layer', () => {
  it('editor circles are the TCH-03 cluster layout and the TCH-02 fixed stick spot', () => {
    const t = touch();
    const c = editorCircles(SAFE_ENV, t);
    const l = computeClusterLayout(SAFE_ENV.w, SAFE_ENV.h, SAFE_ENV.safe, { spacing: 1 });
    const cfg = computeStickConfig(SAFE_ENV.w, SAFE_ENV.h, SAFE_ENV.safe, { floatingStick: false, mirror: false, layout: {} });
    expect(c.map((x) => x.key)).toEqual(EDITOR_KEYS);
    expect([c[0]!.x, c[0]!.y, c[0]!.r]).toEqual([cfg.fixedX, cfg.fixedY, cfg.radius]);
    for (let s = 0; s < 4; s++) expect([c[s + 1]!.x, c[s + 1]!.y, c[s + 1]!.r]).toEqual([l.slots[s]!.cx, l.slots[s]!.cy, l.slots[s]!.r]);
    expect(keySlot(BIG)).toBe(ClusterSlot.BIG);
    expect(keySlot(SHOOT)).toBe(ClusterSlot.HIGH);
    expect(keySlot(STICK_LAYOUT_KEY)).toBe(-1);
  });

  it('placementFor is the exact inverse of the touch layout (buttons from the right, stick from the left; mirrored too)', () => {
    for (const mirror of [false, true]) {
      const t = touch();
      t.mirror = mirror;
      t.layout[PASS] = placementFor(PASS, 700, 600, 1.2, SAFE_ENV, mirror);
      t.layout[STICK_LAYOUT_KEY] = placementFor(STICK_LAYOUT_KEY, mirror ? 900 : 250, 560, 0.9, SAFE_ENV, mirror);
      const p = circle(t, PASS, SAFE_ENV);
      expect([p.x, p.y]).toEqual([700, 600]);
      expect(p.r).toBeCloseTo((T_TOUCHUI.smallButton / 2) * 1.2, 6);
      const s = circle(t, STICK_LAYOUT_KEY, SAFE_ENV);
      expect([s.x, s.y]).toEqual([mirror ? 900 : 250, 560]);
      expect(s.r).toBeCloseTo(T_TOUCHUI.stickRadius * 0.9, 6);
    }
  });

  it('the default layout is valid at 4:3, 16:10 and 21:9, with and without safe-area insets', () => {
    for (const [w, h] of [[1024, 768], [1180, 820], [1366, 1024], [1680, 720], [1260, 540]] as const) {
      for (const safe of [ENV.safe, SAFE_ENV.safe]) expect(layoutValid(touch(), { w, h, safe })).toBe(true);
    }
  });
});

describe('TCH-08 clamping', () => {
  it('a control dropped off screen is clamped inside the safe area, 24 pt clear of every edge', () => {
    const t = touch();
    const p = moveControl(t, PASS, -500, 5000, SAFE_ENV)!;
    const c = circle(t, PASS, SAFE_ENV);
    expect([c.x, c.y]).toEqual([p.x, p.y]);
    expect(c.x - c.r).toBeGreaterThanOrEqual(SAFE_ENV.safe.left + M - 1e-6);
    expect(c.y + c.r).toBeLessThanOrEqual(SAFE_ENV.h - SAFE_ENV.safe.bottom - M + 1e-6);
  });

  it('the stick stays in its half (the right half when mirrored)', () => {
    const t = touch();
    moveControl(t, STICK_LAYOUT_KEY, 1000, 500, ENV);
    const s = circle(t, STICK_LAYOUT_KEY);
    expect(s.x + s.r).toBeLessThanOrEqual(ENV.w / 2 + 1e-6);
    const b = editorBounds(STICK_LAYOUT_KEY, 70, ENV, true);
    expect(b.minX).toBe(ENV.w / 2 + 70);
    expect(clampSpot(STICK_LAYOUT_KEY, 10, 10, 70, ENV, true)).toEqual({ x: ENV.w / 2 + 70, y: M + 70 });
  });

  it('non-finite drops are ignored safely', () => {
    const t = touch();
    const before = JSON.stringify(t.layout);
    const p = moveControl(t, PASS, Number.NaN, Number.NaN, ENV);
    expect(p).not.toBeNull();
    expect(Number.isFinite(t.layout[PASS]!.dx)).toBe(true);
    expect(moveControl(t, 'nope', 10, 10, ENV)).toBeNull();
    expect(JSON.stringify(t.layout)).not.toBe(before);
  });
});

describe('TCH-08 overlap resolution (>= 12 pt gaps, buttons never overlap)', () => {
  it('a button dropped on another snaps to the nearest spot with a 12 pt gap', () => {
    const t = touch();
    const big = circle(t, BIG);
    moveControl(t, PASS, big.x, big.y, ENV);
    const p = circle(t, PASS);
    const b = circle(t, BIG);
    expect(Math.hypot(p.x - b.x, p.y - b.y)).toBeGreaterThanOrEqual(p.r + b.r + GAP - 1e-6);
    expect(layoutValid(t, ENV)).toBe(true);
    // The snap is the nearest valid spot: within one search step of touching distance.
    expect(Math.hypot(p.x - b.x, p.y - b.y)).toBeLessThan(p.r + b.r + GAP + 8);
  });

  it('controls never land on the pause button or the HUD regions (scoreboard, top lane, radar)', () => {
    const t = touch();
    const obs = editorObstacles(ENV, false);
    moveControl(t, SHOOT, obs.pause.x, obs.pause.y, ENV);
    const s = circle(t, SHOOT);
    expect(Math.hypot(s.x - obs.pause.x, s.y - obs.pause.y)).toBeGreaterThanOrEqual(s.r + obs.pause.r + GAP - 1e-6);
    const radar = hudRegions(ENV.w, ENV.h, ENV.safe)[2]!;
    moveControl(t, THROUGH, radar.x + radar.w / 2, radar.y + radar.h / 2, ENV);
    const th = circle(t, THROUGH);
    expect(circleClearOfRect(th.x, th.y, th.r, radar, GAP - 1e-6)).toBe(true);
    moveControl(t, STICK_LAYOUT_KEY, 60, 40, ENV); // onto the scoreboard
    const st = circle(t, STICK_LAYOUT_KEY);
    expect(circleClearOfRect(st.x, st.y, st.r, hudRegions(ENV.w, ENV.h, ENV.safe)[0]!, GAP - 1e-6)).toBe(true);
    expect(layoutValid(t, ENV)).toBe(true);
  });

  it('isValidSpot / nearestValidSpot agree; a spot with nowhere to go returns null', () => {
    const t = touch();
    const circles = editorCircles(ENV, t);
    const i = EDITOR_KEYS.indexOf(PASS);
    const big = circles[1]!;
    expect(isValidSpot(circles, i, big.x, big.y, ENV, false)).toBe(false);
    const p = nearestValidSpot(circles, i, big.x, big.y, ENV, false)!;
    expect(isValidSpot(circles, i, p.x, p.y, ENV, false)).toBe(true);
    const tiny: EditorEnv = { w: 120, h: 100, safe: ENV.safe };
    expect(nearestValidSpot(editorCircles(tiny, t), i, 50, 50, tiny, false)).toBeNull();
  });

  it('the first cluster edit stores all four cluster placements where they are (the cluster stays put)', () => {
    const t = touch();
    const before = editorCircles(ENV, t);
    moveControl(t, SHOOT, 900, 300, ENV);
    for (const k of [BIG, PASS, THROUGH, SHOOT]) expect(t.layout[k]).toBeDefined();
    const after = editorCircles(ENV, t);
    for (const k of [1, 2, 3]) {
      expect(after[k]!.x).toBeCloseTo(before[k]!.x, 9);
      expect(after[k]!.y).toBeCloseTo(before[k]!.y, 9);
    }
    expect(layoutValid(t, ENV)).toBe(true);
    expect(t.layout[STICK_LAYOUT_KEY]).toBeUndefined();
  });

  it('stale defence keys of a slot are dropped when the slot is placed', () => {
    const t = touch();
    t.layout[String(TouchButtonId.SWITCH)] = { dx: 500, dy: 500, scale: 1 };
    moveControl(t, PASS, 800, 600, ENV);
    expect(t.layout[String(TouchButtonId.SWITCH)]).toBeUndefined();
    expect([circle(t, PASS).x, circle(t, PASS).y]).toEqual([800, 600]);
  });
});

describe('TCH-08 size, spacing, mirror, reset', () => {
  it('size 0.7..1.4 per control; growing into a neighbour moves the grown control clear', () => {
    const t = touch();
    scaleControl(t, PASS, 3, ENV);
    expect(controlScale(t, PASS)).toBe(1.4);
    scaleControl(t, PASS, 0.1, ENV);
    expect(controlScale(t, PASS)).toBe(0.7);
    expect(circle(t, PASS).r).toBeGreaterThanOrEqual(T_TOUCHUI.minTarget / 2);
    // Put PASS right next to BIG, then grow it: still no overlap.
    const big = circle(t, BIG);
    scaleControl(t, PASS, 1, ENV);
    moveControl(t, PASS, big.x - big.r - GAP - 38, big.y, ENV);
    scaleControl(t, PASS, 1.4, ENV);
    expect(layoutValid(t, ENV)).toBe(true);
    scaleControl(t, STICK_LAYOUT_KEY, 1.3, ENV);
    expect(circle(t, STICK_LAYOUT_KEY).r).toBeCloseTo(T_TOUCHUI.stickRadius * 1.3, 6);
  });

  it('spacing widens the cluster on the default arc and re-spreads placed buttons around the big one', () => {
    const t = touch();
    const d = (tt: TouchSettings, k: string): number => {
      const a = circle(tt, k), b = circle(tt, BIG);
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const d1 = d(t, PASS);
    setSpacing(t, 1.5, ENV);
    expect(t.spacing).toBe(1.5);
    expect(d(t, PASS)).toBeGreaterThan(d1);
    expect(layoutValid(t, ENV)).toBe(true);
    const u = touch();
    materializeCluster(u, ENV);
    const before = d(u, THROUGH);
    setSpacing(u, 2, ENV);
    const k = arcRadius(48, 38, 2) / arcRadius(48, 38, 1);
    expect(d(u, THROUGH)).toBeCloseTo(before * k, 0);
    expect(layoutValid(u, ENV)).toBe(true);
    setSpacing(u, 9, ENV);
    expect(u.spacing).toBe(2);
  });

  it('mirror flips the whole layout (symmetric insets) and fixes anything that lands on the HUD', () => {
    const t = touch();
    moveControl(t, PASS, 820, 520, ENV);
    const a = editorCircles(ENV, t);
    setMirror(t, true, ENV);
    const b = editorCircles(ENV, t);
    for (let i = 0; i < a.length; i++) {
      expect(b[i]!.x).toBeCloseTo(ENV.w - a[i]!.x, 6);
      expect(b[i]!.y).toBeCloseTo(a[i]!.y, 6);
    }
    expect(layoutValid(t, ENV)).toBe(true);
    // A button parked top right is mirrored onto the scoreboard: fixLayout moves it off.
    const u = touch();
    moveControl(u, SHOOT, 1180 - 24 - 38 - 80 - 160, 24 + 38 + 30, ENV);
    setMirror(u, true, ENV);
    expect(layoutValid(u, ENV)).toBe(true);
  });

  it('fixLayout repairs a stored layout made for another viewport', () => {
    const t = touch();
    moveControl(t, PASS, 640, 420, { w: 1366, h: 1024, safe: ENV.safe });
    const small: EditorEnv = { w: 1024, h: 600, safe: ENV.safe };
    fixLayout(t, small);
    expect(layoutValid(t, small)).toBe(true);
  });

  it('reset restores every editor setting to the defaults (hint counter kept)', () => {
    const t = touch();
    moveControl(t, PASS, 700, 600, ENV);
    t.spacing = 1.6; t.opacity = 0.3; t.mirror = true; t.floatingStick = false; t.gestures = false; t.gesturesOnly = true;
    t.fastPowerBar = true; t.gestureEnabled[GESTURE_RULES[0]!] = false; t.skillTap = SkillMove.ROULETTE; t.hintMatchesLeft = 1;
    resetTouchDefaults(t);
    const d = createDefaultSettings().controls.touch;
    expect(t).toEqual({ ...d, hintMatchesLeft: 1 });
    expect(t.layout).not.toBe(d.layout);
  });

  it('choices: eight skill moves, three auto-switch levels', () => {
    expect(SKILL_CHOICES.map((c) => c.value)).toEqual([
      SkillMove.BALL_ROLL, SkillMove.STEP_OVER, SkillMove.BODY_FEINT, SkillMove.DRAG_BACK, SkillMove.FAKE_SHOT,
      SkillMove.ROULETTE, SkillMove.HEEL_FLICK, SkillMove.KNOCK_ON,
    ]);
    expect(AUTO_SWITCH_CHOICES.map((c) => c.value)).toEqual([AutoSwitch.OFF, AutoSwitch.AIR_AND_LOOSE, AutoSwitch.AUTO]);
  });

  it('cloneTouch is deep for layout and gesture records', () => {
    const t = touch();
    t.layout[PASS] = { dx: 1, dy: 2, scale: 1 };
    const c = cloneTouch(t);
    c.layout[PASS]!.dx = 9;
    c.gestureEnabled.x = false;
    expect(t.layout[PASS]!.dx).toBe(1);
    expect(t.gestureEnabled.x).toBeUndefined();
  });
});
