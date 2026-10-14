/**
 * TCH-03 attack cluster (src/input/touch/attack.ts): section 9 "Layout" geometry (96 / 76 pt, >= 12 pt apart, inside
 * the safe area, 24 pt system-gesture margins, fan above and to the left of the big button), editor placements and
 * mirror, the live-set rule per cluster mode, Gestures Only, nearest-button hit testing in overlapping slop, the
 * swipe-hint table and relayout.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../../src/contracts/settings';
import {
  ClusterMode, ClusterSlot, createTouchIntentState, SwipeDir, TouchButtonId, TouchEdge,
} from '../../src/contracts/touch';
import { T_TOUCHUI } from '../../src/contracts/tuning';
import {
  ATTACK_BUTTONS, ATTACK_SWIPE_HINTS, attackDoubleTap, attackSetActive, computeClusterLayout, createAttackCluster,
  createClusterLayout, LOCAL_TUNING, PAUSE_SIZE, SLOT_LAYOUT_KEYS, slotPlacement, swipeHintMask, type ClusterLayout,
  type SafeInsets,
} from '../../src/input/touch/attack';
import { BUTTON_SLOP } from '../../src/input/touch/button';

const Z: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const { PASS, THROUGH, SHOOT, SPRINT_SKILL } = TouchButtonId;
const dist = (a: { cx: number; cy: number }, b: { cx: number; cy: number }): number => Math.hypot(a.cx - b.cx, a.cy - b.cy);
const bit = (d: SwipeDir): number => 1 << d;

/** Section 9 layout rules for every slot and the pause button. */
function checkLayout(l: ClusterLayout, w: number, h: number, safe: SafeInsets, gap: number = T_TOUCHUI.buttonGap): void {
  const all = [...l.slots, l.pause];
  for (const g of all) {
    for (const v of [g.cx, g.cy, g.r]) expect(Number.isFinite(v)).toBe(true);
    expect(g.r * 2).toBeGreaterThanOrEqual(T_TOUCHUI.minTarget - 1e-9);
    expect(g.cx - g.r).toBeGreaterThanOrEqual(safe.left - 1e-6);
    expect(g.cx + g.r).toBeLessThanOrEqual(w - safe.right + 1e-6);
    expect(g.cy - g.r).toBeGreaterThanOrEqual(safe.top + T_TOUCHUI.systemEdgeMargin - 1e-6);
    expect(g.cy + g.r).toBeLessThanOrEqual(h - safe.bottom - T_TOUCHUI.systemEdgeMargin + 1e-6);
  }
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const a = l.slots[i]!, b = l.slots[j]!;
      expect(dist(a, b) - a.r - b.r).toBeGreaterThanOrEqual(gap - 1e-6);
    }
  }
}

describe('TCH-03 cluster layout (section 9 Layout)', () => {
  it('default iPad layout: big 96 pt bottom right, three 76 pt buttons fanned in an arc above and to its left', () => {
    const l = computeClusterLayout(1180, 820, Z);
    checkLayout(l, 1180, 820, Z);
    const big = l.slots[ClusterSlot.BIG];
    expect(big.r * 2).toBe(T_TOUCHUI.bigButton);
    for (const s of [ClusterSlot.LOW, ClusterSlot.MID, ClusterSlot.HIGH]) expect(l.slots[s].r * 2).toBe(T_TOUCHUI.smallButton);
    expect(1180 - (big.cx + big.r)).toBeCloseTo(T_TOUCHUI.systemEdgeMargin, 9);
    expect(820 - (big.cy + big.r)).toBeCloseTo(T_TOUCHUI.systemEdgeMargin, 9);
    // The arc: equal distance from BIG at 180, 135 and 90 degrees.
    const d = [ClusterSlot.LOW, ClusterSlot.MID, ClusterSlot.HIGH].map((s) => dist(l.slots[s], big));
    expect(d[1]).toBeCloseTo(d[0]!, 6);
    expect(d[2]).toBeCloseTo(d[0]!, 6);
    expect(l.slots[ClusterSlot.LOW].cy).toBeCloseTo(big.cy, 6);
    expect(l.slots[ClusterSlot.LOW].cx).toBeLessThan(big.cx);
    expect(l.slots[ClusterSlot.HIGH].cx).toBeCloseTo(big.cx, 6);
    expect(l.slots[ClusterSlot.HIGH].cy).toBeLessThan(big.cy);
    const mid = l.slots[ClusterSlot.MID];
    expect(big.cx - mid.cx).toBeCloseTo(big.cy - mid.cy, 6);
    // Pause top right, clear of the corner.
    expect(l.pause.r * 2).toBe(PAUSE_SIZE);
    expect(l.pause.cx).toBeGreaterThan(1180 / 2);
    expect(l.pause.cy - l.pause.r).toBeCloseTo(T_TOUCHUI.systemEdgeMargin, 9);
  });

  it('sweep: 4:3, 16:10 and 21:9 viewports, insets, mirror, spacing 1..2 and size 0.7..1.4 keep every rule', () => {
    const views: [number, number][] = [[1024, 768], [1180, 820], [1366, 1024], [1194, 834], [1210, 520], [1440, 617]];
    const insets: SafeInsets[] = [Z, { top: 24, right: 0, bottom: 20, left: 0 }, { top: 0, right: 47, bottom: 21, left: 47 }, { top: 0, right: 0, bottom: 21, left: 59 }];
    let n = 0;
    for (const [w, h] of views) {
      for (const safe of insets) {
        for (const mirror of [false, true]) {
          for (const spacing of [1, 1.5, 2]) {
            for (const scale of [0.7, 1, 1.4]) {
              const l = computeClusterLayout(w, h, safe, { mirror, spacing, scale });
              checkLayout(l, w, h, safe, T_TOUCHUI.buttonGap * spacing);
              const big = l.slots[ClusterSlot.BIG];
              // Fan away from the anchored side: left of BIG normally, right of it when mirrored.
              expect(mirror ? l.slots[ClusterSlot.LOW].cx > big.cx : l.slots[ClusterSlot.LOW].cx < big.cx).toBe(true);
              expect(mirror ? big.cx < w / 2 : big.cx > w / 2).toBe(true);
              // INT-B: the pause stays top right in both layouts (mirrored, the top left is the scoreboard's).
              expect(l.pause.cx > w / 2).toBe(true);
              n++;
            }
          }
        }
      }
    }
    expect(n).toBe(6 * 4 * 2 * 3 * 3);
  });

  it('mirror with a one-sided inset keeps the cluster inside the left safe edge; the pause stays top right', () => {
    const safe = { top: 0, right: 0, bottom: 21, left: 59 };
    const l = computeClusterLayout(1180, 820, safe, { mirror: true });
    const big = l.slots[ClusterSlot.BIG];
    expect(big.cx - big.r).toBeCloseTo(59 + T_TOUCHUI.systemEdgeMargin, 9);
    // INT-B (TCH-09 CR): the pause no longer mirrors onto the scoreboard; it keeps the right-edge margin.
    expect(l.pause.cx + l.pause.r).toBeCloseTo(1180 - T_TOUCHUI.systemEdgeMargin, 9);
    checkLayout(l, 1180, 820, safe);
  });

  it('spacing below 1 never closes the 12 pt gap; size never goes under the 60 pt minimum target', () => {
    checkLayout(computeClusterLayout(1180, 820, Z, { spacing: 0.2 }), 1180, 820, Z);
    const small = computeClusterLayout(1180, 820, Z, { scale: 0.1 });
    expect(small.slots[ClusterSlot.BIG].r * 2).toBeCloseTo(T_TOUCHUI.bigButton * LOCAL_TUNING.scaleMin, 9);
    expect(small.slots[ClusterSlot.LOW].r * 2).toBe(T_TOUCHUI.minTarget); // 76 x 0.7 = 53 < 60
    checkLayout(small, 1180, 820, Z);
    const big = computeClusterLayout(1180, 820, Z, { scale: 9 });
    expect(big.slots[ClusterSlot.BIG].r * 2).toBeCloseTo(T_TOUCHUI.bigButton * LOCAL_TUNING.scaleMax, 9);
  });

  it('hostile numbers (NaN, Infinity, negative insets) give a finite layout', () => {
    const l = computeClusterLayout(NaN, Infinity, { top: -5, right: NaN, bottom: Infinity, left: -1 }, { spacing: NaN, scale: NaN });
    for (const g of [...l.slots, l.pause]) for (const v of [g.cx, g.cy, g.r]) expect(Number.isFinite(v)).toBe(true);
  });

  it('writes into `out` without allocating a new layout', () => {
    const out = createClusterLayout();
    const slot0 = out.slots[0];
    expect(computeClusterLayout(1180, 820, Z, {}, out)).toBe(out);
    expect(out.slots[0]).toBe(slot0);
  });
});

describe('TCH-03 editor placements (TouchSettings.layout)', () => {
  it('a placement moves its slot: dx from the safe right edge, dy from the safe bottom edge, both to the centre', () => {
    const safe = { top: 0, right: 10, bottom: 20, left: 0 };
    const l = computeClusterLayout(1180, 820, safe, { placements: { [String(PASS)]: { dx: 300, dy: 120, scale: 1.2 } } });
    const pass = l.slots[ClusterSlot.LOW];
    expect(pass.cx).toBeCloseTo(1180 - 10 - 300, 9);
    expect(pass.cy).toBeCloseTo(820 - 20 - 120, 9);
    expect(pass.r).toBeCloseTo((T_TOUCHUI.smallButton / 2) * 1.2, 9);
    // The other slots keep the default arc.
    const d = computeClusterLayout(1180, 820, safe);
    expect(l.slots[ClusterSlot.BIG]).toEqual(d.slots[ClusterSlot.BIG]);
    // Mirrored: dx counts from the safe left edge.
    const m = computeClusterLayout(1180, 820, { ...safe, left: 30 }, { mirror: true, placements: { [String(PASS)]: { dx: 300, dy: 120, scale: 1 } } });
    expect(m.slots[ClusterSlot.LOW].cx).toBeCloseTo(30 + 300, 9);
  });

  it('placements are clamped inside the safe area and the system-gesture margins', () => {
    const safe = { top: 20, right: 0, bottom: 20, left: 0 };
    const l = computeClusterLayout(1180, 820, safe, {
      placements: {
        [String(SHOOT)]: { dx: -100, dy: 5000, scale: 1 },
        [String(SPRINT_SKILL)]: { dx: 5000, dy: -50, scale: 1.4 },
      },
    });
    const shoot = l.slots[ClusterSlot.HIGH], big = l.slots[ClusterSlot.BIG];
    expect(shoot.cx + shoot.r).toBeCloseTo(1180, 9);
    expect(shoot.cy - shoot.r).toBeCloseTo(20 + T_TOUCHUI.systemEdgeMargin, 9);
    expect(big.cx - big.r).toBeCloseTo(0, 9);
    expect(big.cy + big.r).toBeCloseTo(820 - 20 - T_TOUCHUI.systemEdgeMargin, 9);
  });

  it('a slot falls back to the defence button sharing it; bad entries are ignored', () => {
    expect(SLOT_LAYOUT_KEYS[ClusterSlot.LOW]).toEqual([String(PASS), String(TouchButtonId.SWITCH)]);
    expect(SLOT_LAYOUT_KEYS[ClusterSlot.BIG]).toEqual([String(SPRINT_SKILL), String(TouchButtonId.SPRINT_TACKLE)]);
    expect(SLOT_LAYOUT_KEYS[ClusterSlot.HIGH]).toEqual([String(SHOOT), String(TouchButtonId.SLIDE)]);
    expect(SLOT_LAYOUT_KEYS[ClusterSlot.MID]).toEqual([String(THROUGH), String(TouchButtonId.SECOND_DEF)]);
    const sw = { dx: 400, dy: 100, scale: 1 };
    expect(slotPlacement({ [String(TouchButtonId.SWITCH)]: sw }, ClusterSlot.LOW)).toBe(sw);
    expect(slotPlacement({ [String(PASS)]: { dx: NaN, dy: 1, scale: 1 }, [String(TouchButtonId.SWITCH)]: sw }, ClusterSlot.LOW)).toBe(sw);
    expect(slotPlacement({ [String(PASS)]: { dx: NaN, dy: 1, scale: 1 } }, ClusterSlot.LOW)).toBeNull();
    expect(slotPlacement(undefined, ClusterSlot.LOW)).toBeNull();
    // The default settings (empty layout) give the default arc.
    const d = computeClusterLayout(1180, 820, Z);
    expect(computeClusterLayout(1180, 820, Z, { placements: createDefaultSettings().controls.touch.layout })).toEqual(d);
  });
});

describe('TCH-03 attack set: live modes, Gestures Only, hit testing, relayout', () => {
  function make(enabled?: () => boolean, gesturesOnly = false) {
    const st = createTouchIntentState();
    const layout = computeClusterLayout(1180, 820, Z);
    const cluster = createAttackCluster(st, layout, enabled, { gesturesOnly: () => gesturesOnly });
    const claim = (x: number, y: number): TouchButtonId | -1 => {
      for (const c of cluster.controls) if (c.hit(x, y)) return c.id;
      return -1;
    };
    const centre = (s: ClusterSlot) => layout.slots[s];
    return { st, layout, cluster, claim, centre };
  }

  it('four buttons in hit-test order HIGH, MID, LOW, BIG with the section 9 ids', () => {
    const { cluster } = make();
    expect(cluster.controls.map((c) => c.id)).toEqual([SHOOT, THROUGH, PASS, SPRINT_SKILL]);
    expect(cluster.slot(ClusterSlot.LOW).id).toBe(PASS);
    expect(ATTACK_BUTTONS.map((b) => b[1])).toEqual([SPRINT_SKILL, PASS, THROUGH, SHOOT]);
  });

  it('live in ATTACK, KEEPER and SET_PIECE; claims nothing in DEFENCE or HIDDEN (the defence set owns the slots)', () => {
    const { st, claim, centre, cluster } = make();
    const big = centre(ClusterSlot.BIG);
    for (const [mode, want] of [
      [ClusterMode.ATTACK, SPRINT_SKILL], [ClusterMode.KEEPER, SPRINT_SKILL], [ClusterMode.SET_PIECE, SPRINT_SKILL],
      [ClusterMode.DEFENCE, -1], [ClusterMode.HIDDEN, -1],
    ] as const) {
      st.mode = mode;
      expect(claim(big.cx, big.cy)).toBe(want);
      expect(cluster.live(PASS)).toBe(want !== -1);
      expect(attackSetActive(mode)).toBe(want !== -1);
    }
  });

  it('a caller-supplied enabled() replaces the mode rule', () => {
    let on = false;
    const { st, claim, centre } = make(() => on);
    const low = centre(ClusterSlot.LOW);
    expect(claim(low.cx, low.cy)).toBe(-1);
    on = true;
    st.mode = ClusterMode.DEFENCE;
    expect(claim(low.cx, low.cy)).toBe(PASS);
  });

  it('Gestures Only hides PASS, THROUGH and SHOOT; SPRINT & SKILL stays', () => {
    const { claim, centre } = make(undefined, true);
    for (const s of [ClusterSlot.LOW, ClusterSlot.MID, ClusterSlot.HIGH]) expect(claim(centre(s).cx, centre(s).cy)).toBe(-1);
    expect(claim(centre(ClusterSlot.BIG).cx, centre(ClusterSlot.BIG).cy)).toBe(SPRINT_SKILL);
  });

  it('inside overlapping slop the nearest button wins, whatever the hit-test order', () => {
    // Spacing 1 puts LOW and MID 12+ pt apart: their 8 pt slop rings overlap on the line between the centres.
    const { claim, centre } = make();
    const a = centre(ClusterSlot.LOW), b = centre(ClusterSlot.MID);
    const gap = dist(a, b) - a.r - b.r;
    expect(gap).toBeLessThan(2 * BUTTON_SLOP);
    const ux = (b.cx - a.cx) / dist(a, b), uy = (b.cy - a.cy) / dist(a, b);
    const at = (fromA: number) => ({ x: a.cx + ux * (a.r + fromA), y: a.cy + uy * (a.r + fromA) });
    let p = at(gap / 2 - 1); // nearer LOW (MID comes first in hit order)
    expect(claim(p.x, p.y)).toBe(PASS);
    p = at(gap / 2 + 1);
    expect(claim(p.x, p.y)).toBe(THROUGH);
    // Each button's own circle always belongs to it.
    expect(claim(a.cx, a.cy)).toBe(PASS);
    expect(claim(b.cx, b.cy)).toBe(THROUGH);
  });

  it('a hidden neighbour does not shrink a live button\'s slop', () => {
    const { claim, centre } = make(undefined, true);
    const big = centre(ClusterSlot.BIG), low = centre(ClusterSlot.LOW);
    // A point in BIG's slop ring on the side facing PASS.
    const d = dist(big, low);
    const x = big.cx + ((low.cx - big.cx) / d) * (big.r + BUTTON_SLOP - 0.5);
    expect(claim(x, big.cy)).toBe(SPRINT_SKILL);
  });

  it('relayout moves every button (and its hit area) to the new slots', () => {
    const { cluster, claim } = make();
    const l2 = computeClusterLayout(1180, 820, Z, { mirror: true });
    cluster.relayout(l2);
    for (const c of cluster.controls) {
      const s = ATTACK_BUTTONS.find((b) => b[1] === c.id)![0];
      expect(c.geom).toEqual(l2.slots[s]);
    }
    expect(claim(l2.slots[ClusterSlot.BIG].cx, l2.slots[ClusterSlot.BIG].cy)).toBe(SPRINT_SKILL);
  });

  it('a press records the cluster mode: a KEEPER-mode PASS is a throw (mode KEEPER in every event)', () => {
    const { st, cluster, centre } = make();
    st.mode = ClusterMode.KEEPER;
    const pass = cluster.slot(ClusterSlot.LOW);
    const c = centre(ClusterSlot.LOW);
    pass.down(1, c.cx, c.cy, 0);
    st.mode = ClusterMode.ATTACK; // keeper released the ball meanwhile
    pass.up(1, c.cx, c.cy, 40);
    const evs = Array.from({ length: st.buttonEventCount }, (_, i) => [st.buttonEvents[i]!.edge, st.buttonEvents[i]!.mode]);
    expect(evs).toEqual([[TouchEdge.DOWN, ClusterMode.KEEPER], [TouchEdge.UP, ClusterMode.KEEPER], [TouchEdge.TAP, ClusterMode.KEEPER]]);
  });
});

describe('TCH-03 swipe hint table (section 9 attack table columns)', () => {
  it('arrows per button match the filled cells of the table', () => {
    const all = bit(SwipeDir.UP) | bit(SwipeDir.DOWN) | bit(SwipeDir.LEFT) | bit(SwipeDir.RIGHT);
    expect(swipeHintMask(PASS, ClusterMode.ATTACK)).toBe(all);
    expect(swipeHintMask(THROUGH, ClusterMode.ATTACK)).toBe(bit(SwipeDir.UP) | bit(SwipeDir.DOWN));
    expect(swipeHintMask(SHOOT, ClusterMode.ATTACK)).toBe(all);
    expect(swipeHintMask(SPRINT_SKILL, ClusterMode.ATTACK)).toBe(all);
    expect(swipeHintMask(TouchButtonId.SWITCH, ClusterMode.ATTACK)).toBe(0);
    for (const m of [ClusterMode.KEEPER, ClusterMode.DEFENCE, ClusterMode.SET_PIECE, ClusterMode.HIDDEN]) expect(swipeHintMask(PASS, m)).toBe(0);
    expect(ATTACK_SWIPE_HINTS[PASS]![SwipeDir.UP]).toBe('Lob');
    expect(ATTACK_SWIPE_HINTS[SHOOT]![SwipeDir.LEFT]).toBe('Fake shot');
    expect(ATTACK_SWIPE_HINTS[SPRINT_SKILL]![SwipeDir.DOWN]).toBe('Knock-on');
    expect(ATTACK_SWIPE_HINTS[SPRINT_SKILL]![SwipeDir.LEFT]).toBe('Hard stop');
  });

  it('double tap only where the table has one (PASS, THROUGH in open play)', () => {
    expect(attackDoubleTap(PASS, ClusterMode.ATTACK)).toBe(true);
    expect(attackDoubleTap(THROUGH, ClusterMode.ATTACK)).toBe(true);
    expect(attackDoubleTap(SHOOT, ClusterMode.ATTACK)).toBe(false);
    expect(attackDoubleTap(SPRINT_SKILL, ClusterMode.ATTACK)).toBe(false);
    expect(attackDoubleTap(PASS, ClusterMode.KEEPER)).toBe(false);
  });
});
