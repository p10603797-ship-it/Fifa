/**
 * FND-05: touch stick maths, button events, cluster layout geometry and the touch -> InputFrame mapper
 * (pure logic, no DOM: controls are driven through the TouchControl interface).
 */
import { describe, expect, it } from 'vitest';
import { AXIS_SCALE, Btn, createInputFrame, type InputSampleContext } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import {
  ClusterMode, ClusterSlot, createTouchIntentState, SwipeDir, TouchButtonId, TouchEdge,
} from '../../src/contracts/touch';
import { T_TOUCHUI } from '../../src/contracts/tuning';
import { computeStick, createStick, followOrigin, STICK_DEAD_ZONE } from '../../src/input/touch/stick';
import { createTouchButton, swipeDir, TAP_MS } from '../../src/input/touch/button';
import { computeClusterLayout, PAUSE_SIZE, type ClusterLayout } from '../../src/input/touch/attack';
import { createTouchMapper, heldToButtons } from '../../src/input/touch/mapper';
import { chooseClusterMode } from '../../src/input/touch/cluster';
import { initMatch } from '../../src/sim/init';

function ctx(): InputSampleContext {
  const s = initMatch(createMatchConfig()) as SimState;
  return { tick: 1, human: 0, side: 0, state: s, projector: null };
}

describe('FND-05 stick maths', () => {
  it('dead zone, analogue deflection and clamping', () => {
    const o = { x: 0, y: 0 };
    const r = 70;
    computeStick(100, 100, 100 + r * STICK_DEAD_ZONE * 0.9, 100, r, STICK_DEAD_ZONE, o);
    expect(o.x).toBe(0);
    computeStick(100, 100, 100 + r * 0.56, 100, r, STICK_DEAD_ZONE, o); // partial tilt
    expect(o.x).toBeCloseTo((0.56 - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE), 6);
    expect(o.y).toBe(0);
    computeStick(100, 100, 100, 100 + r * 3, r, STICK_DEAD_ZONE, o); // beyond the rim
    expect(o.x).toBeCloseTo(0, 9);
    expect(o.y).toBeCloseTo(1, 9);
    computeStick(0, 0, -50, -50, r, STICK_DEAD_ZONE, o);
    expect(o.x).toBeCloseTo(o.y, 9);
    expect(Math.hypot(o.x, o.y)).toBeLessThanOrEqual(1);
  });

  it('floating origin follows the thumb past the radius', () => {
    const o = { x: 0, y: 0 };
    followOrigin(0, 0, 50, 0, 70, o);
    expect(o).toEqual({ x: 0, y: 0 });
    followOrigin(0, 0, 100, 0, 70, o);
    expect(o.x).toBeCloseTo(30, 9);
  });

  it('stick control: appears where the thumb lands, follows, releases on up / cancel / releaseAll', () => {
    const st = createTouchIntentState();
    const stick = createStick({ state: st, zone: (x) => x < 500, radius: 70 });
    expect(stick.hit(100, 400)).toBe(true);
    expect(stick.hit(800, 400)).toBe(false);
    stick.down(7, 100, 400, 0);
    expect(st.stickActive).toBe(true);
    expect(st.stickOriginX).toBe(100);
    stick.move(7, 170, 400, 16);
    expect(st.stickX).toBeCloseTo(1, 6);
    stick.move(99, 0, 0, 20); // another pointer is ignored
    expect(st.stickX).toBeCloseTo(1, 6);
    stick.move(7, 250, 400, 32); // drags the origin
    expect(st.stickOriginX).toBeCloseTo(180, 6);
    stick.move(7, 110, 400, 48); // instant reverse
    expect(st.stickX).toBeCloseTo(-1, 6);
    stick.up(7, 110, 400, 64);
    expect(st.stickActive).toBe(false);
    expect(st.stickX).toBe(0);
    stick.down(8, 100, 400, 80);
    stick.move(8, 100, 300, 96);
    stick.cancel(8, 100);
    expect(st.stickActive).toBe(false);
    expect(st.stickY).toBe(0);
    stick.down(9, 100, 400, 120);
    stick.move(9, 160, 400, 130);
    stick.releaseAll(140);
    expect(st.stickActive).toBe(false);
    expect(st.stickX).toBe(0);
  });
});

describe('FND-05 touch buttons', () => {
  it('DOWN / UP / TAP / DOUBLE_TAP / SWIPE / CANCEL events and the held mask', () => {
    const st = createTouchIntentState();
    const b = createTouchButton({ state: st, id: TouchButtonId.PASS, geom: { cx: 1000, cy: 700, r: 38 } });
    expect(b.hit(1000 + 38 + 7, 700)).toBe(true); // slop
    expect(b.hit(1000 + 60, 700)).toBe(false);
    b.down(1, 1000, 700, 0);
    expect(st.held & (1 << TouchButtonId.PASS)).not.toBe(0);
    b.up(1, 1000, 700, 50);
    expect(st.held).toBe(0);
    b.down(1, 1000, 700, 120);
    b.up(1, 1000, 700, 150);
    const edges = Array.from({ length: st.buttonEventCount }, (_, i) => st.buttonEvents[i]!.edge);
    expect(edges).toEqual([TouchEdge.DOWN, TouchEdge.UP, TouchEdge.TAP, TouchEdge.DOWN, TouchEdge.UP, TouchEdge.DOUBLE_TAP]);
    st.buttonEventCount = 0;
    // Slow press: no tap. Swipe up from the button (finger may slide off and keep the hold).
    b.down(2, 1000, 700, 1000);
    b.move(2, 1000, 700 - T_TOUCHUI.buttonSwipePt - 1, 1010);
    expect(st.buttonEvents[1]!.edge).toBe(TouchEdge.SWIPE);
    expect(st.buttonEvents[1]!.dir).toBe(SwipeDir.UP);
    b.move(2, 1000, 300, 1020); // far off the button: still held
    expect(st.held & (1 << TouchButtonId.PASS)).not.toBe(0);
    b.up(2, 1000, 300, 1000 + TAP_MS + 100);
    expect(st.buttonEventCount).toBe(3);
    st.buttonEventCount = 0;
    b.down(3, 1000, 700, 2000);
    b.cancel(3, 2010);
    expect(st.held).toBe(0);
    expect(st.buttonEvents[1]!.edge).toBe(TouchEdge.CANCEL);
    expect(swipeDir(30, 5, 24)).toBe(SwipeDir.RIGHT);
    expect(swipeDir(-5, 30, 24)).toBe(SwipeDir.DOWN);
    expect(swipeDir(10, 10, 24)).toBe(SwipeDir.NONE);
  });
});

describe('FND-05 attack cluster layout', () => {
  const dist = (a: { cx: number; cy: number }, b: { cx: number; cy: number }): number => Math.hypot(a.cx - b.cx, a.cy - b.cy);

  function checkLayout(l: ClusterLayout, w: number, h: number, safe: { top: number; right: number; bottom: number; left: number }): void {
    const big = l.slots[ClusterSlot.BIG];
    expect(big.r * 2).toBeCloseTo(T_TOUCHUI.bigButton, 6);
    for (const s of [ClusterSlot.LOW, ClusterSlot.MID, ClusterSlot.HIGH]) expect(l.slots[s].r * 2).toBeCloseTo(T_TOUCHUI.smallButton, 6);
    // >= 12 pt between every pair of buttons.
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const a = l.slots[i]!, b = l.slots[j]!;
        expect(dist(a, b) - a.r - b.r).toBeGreaterThanOrEqual(T_TOUCHUI.buttonGap - 1e-6);
      }
    }
    // Inside the safe area; 24 pt clear of the bottom edge.
    for (const g of [...l.slots, l.pause]) {
      expect(g.cx - g.r).toBeGreaterThanOrEqual(safe.left);
      expect(g.cx + g.r).toBeLessThanOrEqual(w - safe.right);
      expect(g.cy - g.r).toBeGreaterThanOrEqual(safe.top);
      expect(g.cy + g.r).toBeLessThanOrEqual(h - safe.bottom - T_TOUCHUI.systemEdgeMargin + 1e-6);
    }
    // Fan: LOW left of BIG, HIGH above BIG, MID up-left.
    expect(l.slots[ClusterSlot.LOW].cx).toBeLessThan(big.cx);
    expect(l.slots[ClusterSlot.LOW].cy).toBeCloseTo(big.cy, 6);
    expect(l.slots[ClusterSlot.HIGH].cy).toBeLessThan(big.cy);
    expect(l.slots[ClusterSlot.HIGH].cx).toBeCloseTo(big.cx, 6);
    expect(l.slots[ClusterSlot.MID].cx).toBeLessThan(big.cx);
    expect(l.slots[ClusterSlot.MID].cy).toBeLessThan(big.cy);
    // Pause: top right, a full 60 pt target, 24 pt clear of the corner.
    expect(l.pause.r * 2).toBe(PAUSE_SIZE);
    expect(l.pause.cx).toBeGreaterThan(w / 2);
    expect(l.pause.cy - l.pause.r).toBeGreaterThanOrEqual(safe.top + T_TOUCHUI.systemEdgeMargin - 1e-6);
    expect(w - safe.right - (l.pause.cx + l.pause.r)).toBeGreaterThanOrEqual(T_TOUCHUI.systemEdgeMargin - 1e-6);
  }

  it('iPad landscape, no insets and with home-indicator insets', () => {
    checkLayout(computeClusterLayout(1180, 820, { top: 0, right: 0, bottom: 0, left: 0 }), 1180, 820, { top: 0, right: 0, bottom: 0, left: 0 });
    const safe = { top: 24, right: 0, bottom: 20, left: 0 };
    checkLayout(computeClusterLayout(1180, 820, safe), 1180, 820, safe);
    const notch = { top: 0, right: 47, bottom: 21, left: 47 };
    checkLayout(computeClusterLayout(2048 / 2, 1536 / 2, notch), 1024, 768, notch);
  });

  it('spacing widens the gaps; mirror moves the cluster to the left', () => {
    const z = { top: 0, right: 0, bottom: 0, left: 0 };
    const a = computeClusterLayout(1180, 820, z);
    const b = computeClusterLayout(1180, 820, z, { spacing: 1.5 });
    expect(dist(b.slots[ClusterSlot.BIG], b.slots[ClusterSlot.LOW])).toBeGreaterThan(dist(a.slots[ClusterSlot.BIG], a.slots[ClusterSlot.LOW]));
    const m = computeClusterLayout(1180, 820, z, { mirror: true });
    expect(m.slots[ClusterSlot.BIG].cx).toBeLessThan(590);
    expect(m.slots[ClusterSlot.LOW].cx).toBeGreaterThan(m.slots[ClusterSlot.BIG].cx);
  });
});

describe('FND-05 touch mapper', () => {
  it('stick -> mx/mz (screen x -> +x, screen y -> +z), radial, rotated by the projector', () => {
    const st = createTouchIntentState();
    const m = createTouchMapper(st);
    const f = createInputFrame();
    const c = ctx();
    st.stickActive = true;
    st.stickX = 1; st.stickY = 0;
    m.sample(f, c);
    expect(f.mx).toBe(AXIS_SCALE);
    expect(f.mz).toBe(0);
    st.stickX = 0; st.stickY = -0.5;
    m.sample(f, c);
    expect(f.mx).toBe(0);
    expect(f.mz).toBe(Math.round(-0.5 * AXIS_SCALE)); // same rounding as contracts quantAxis
    st.stickX = Math.SQRT1_2; st.stickY = Math.SQRT1_2;
    m.sample(f, c);
    expect(f.mx * f.mx + f.mz * f.mz).toBeLessThanOrEqual(AXIS_SCALE * AXIS_SCALE);
    // A camera rotated by +90 degrees maps screen right to pitch +z.
    const rotated: InputSampleContext = { ...c, projector: { screenToPitch: () => false, pitchToScreen: () => false, stickRotation: () => Math.PI / 2 } };
    st.stickX = 1; st.stickY = 0;
    m.sample(f, rotated);
    expect(f.mx).toBe(0);
    expect(f.mz).toBe(AXIS_SCALE);
    st.stickActive = false;
    m.sample(f, c);
    expect(f.mx).toBe(0);
    expect(f.mz).toBe(0);
  });

  it('SPRINT held -> Btn.SPRINT; PASS/THROUGH/SHOOT held while down; a sub-tick tap is latched once', () => {
    const st = createTouchIntentState();
    const m = createTouchMapper(st);
    const f = createInputFrame();
    const c = ctx();
    const sprint = createTouchButton({ state: st, id: TouchButtonId.SPRINT_SKILL, geom: { cx: 0, cy: 0, r: 48 } });
    const pass = createTouchButton({ state: st, id: TouchButtonId.PASS, geom: { cx: 0, cy: 0, r: 38 } });
    const shoot = createTouchButton({ state: st, id: TouchButtonId.SHOOT, geom: { cx: 0, cy: 0, r: 38 } });
    sprint.down(1, 0, 0, 0);
    m.sample(f, c);
    expect(f.buttons).toBe(Btn.SPRINT);
    shoot.down(2, 0, 0, 5);
    m.sample(f, c);
    expect(f.buttons).toBe(Btn.SPRINT | Btn.SHOOT);
    m.sample(f, c);
    expect(f.buttons).toBe(Btn.SPRINT | Btn.SHOOT);
    shoot.up(2, 0, 0, 300);
    sprint.up(1, 0, 0, 300);
    m.sample(f, c);
    expect(f.buttons).toBe(0);
    pass.down(3, 0, 0, 400);
    pass.up(3, 0, 0, 410);
    m.sample(f, c);
    expect(f.buttons).toBe(Btn.PASS);
    m.sample(f, c);
    expect(f.buttons).toBe(0);
    expect(st.buttonEventCount).toBe(0);
    expect(heldToButtons(1 << TouchButtonId.THROUGH)).toBe(Btn.THROUGH);
    expect(heldToButtons(1 << TouchButtonId.PAUSE)).toBe(0);
  });

  it('cluster mode follows possession', () => {
    const s = initMatch(createMatchConfig()) as SimState;
    expect(chooseClusterMode(s, 0)).toBe(ClusterMode.ATTACK);
    s.ball.owner = 15;
    expect(chooseClusterMode(s, 0)).toBe(ClusterMode.DEFENCE);
    expect(chooseClusterMode(s, 1)).toBe(ClusterMode.ATTACK);
    s.ball.owner = 0; s.ball.heldBy = 0;
    expect(chooseClusterMode(s, 0)).toBe(ClusterMode.KEEPER);
    expect(chooseClusterMode(null, 0)).toBe(ClusterMode.ATTACK);
  });
});
