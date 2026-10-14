/**
 * QF-3 FIX-06 (INT-B note "Swipe-hint labels around the bottom-right big button go partly off screen"): the overlay
 * slides each direction hint inward so it stays inside the viewport and the safe area (hintShift), for every slot, in
 * the default and the mirrored layout and at several iPad sizes. The real overlay writes the shift as CSS variables.
 */
import { describe, expect, it } from 'vitest';
import { ClusterMode, ClusterSlot, createTouchIntentState, SwipeDir, TouchButtonId } from '../../src/contracts/touch';
import { computeClusterLayout, createClusterLayout } from '../../src/input/touch/attack';
import { createTouchOverlay, hintLabels, hintShift, OVERLAY_TUNING } from '../../src/input/touch/overlay';
import { asHtml, fakeRoot } from './tch-09-fakedom';

const SIZES: [number, number][] = [[1180, 820], [1024, 768], [1366, 1024], [1133, 744]];
const SLOT_BUTTONS: [ClusterSlot, TouchButtonId, ClusterMode][] = [
  [ClusterSlot.BIG, TouchButtonId.SPRINT_SKILL, ClusterMode.ATTACK], [ClusterSlot.LOW, TouchButtonId.PASS, ClusterMode.ATTACK],
  [ClusterSlot.MID, TouchButtonId.THROUGH, ClusterMode.ATTACK], [ClusterSlot.HIGH, TouchButtonId.SHOOT, ClusterMode.ATTACK],
  [ClusterSlot.BIG, TouchButtonId.SPRINT_TACKLE, ClusterMode.DEFENCE], [ClusterSlot.LOW, TouchButtonId.SWITCH, ClusterMode.DEFENCE],
  [ClusterSlot.MID, TouchButtonId.SECOND_DEF, ClusterMode.DEFENCE],
];

/** Hint box (estimated like the overlay) after the shift. */
function box(dir: SwipeDir, label: string, cx: number, cy: number, r: number, sx: number, sy: number): [number, number, number, number] {
  const T = OVERLAY_TUNING;
  const hw = label.length * T.hintCharPx + T.hintExtraW, hh = T.hintH, o = T.hintOffset;
  let x0: number, y0: number;
  switch (dir) {
    case SwipeDir.UP: x0 = cx - hw / 2; y0 = cy - r - o - hh; break;
    case SwipeDir.DOWN: x0 = cx - hw / 2; y0 = cy + r + o; break;
    case SwipeDir.LEFT: x0 = cx - r - o - hw; y0 = cy - hh / 2; break;
    default: x0 = cx + r + o; y0 = cy - hh / 2; break;
  }
  return [x0 + sx, y0 + sy, x0 + sx + hw, y0 + sy + hh];
}

describe('QF-3 swipe hints stay on screen', () => {
  it('every hint of every slot fits inside the viewport and the safe area, default and mirrored, at iPad sizes', () => {
    const out = { x: 0, y: 0 };
    for (const [w, h] of SIZES) {
      for (const mirror of [false, true]) {
        for (const safe of [{ top: 0, right: 0, bottom: 0, left: 0 }, { top: 24, right: 44, bottom: 20, left: 44 }]) {
          const l = computeClusterLayout(w, h, safe, { mirror }, createClusterLayout());
          for (const [slot, id, mode] of SLOT_BUTTONS) {
            const g = l.slots[slot]!;
            const row = hintLabels(id, mode)!;
            for (let d = SwipeDir.UP; d <= SwipeDir.RIGHT; d++) {
              const label = row[d] ?? '';
              if (label === '') continue;
              hintShift(d, label, g.cx, g.cy, g.r, w, h, safe, out);
              const [x0, y0, x1, y1] = box(d, label, g.cx, g.cy, g.r, out.x, out.y);
              const tag = `${w}x${h} mirror ${mirror} slot ${slot} ${label}`;
              expect(x0, tag).toBeGreaterThanOrEqual(safe.left);
              expect(x1, tag).toBeLessThanOrEqual(w - safe.right);
              expect(y0, tag).toBeGreaterThanOrEqual(safe.top);
              expect(y1, tag).toBeLessThanOrEqual(h - safe.bottom);
            }
          }
        }
      }
    }
  });

  it('the BIG button\'s right ("Skill") and down ("Knock-on") hints are the ones that move; a hint with room stays put', () => {
    const l = computeClusterLayout(1180, 820, { top: 0, right: 0, bottom: 0, left: 0 }, {}, createClusterLayout());
    const g = l.slots[ClusterSlot.BIG]!;
    const out = { x: 0, y: 0 };
    hintShift(SwipeDir.RIGHT, 'Skill', g.cx, g.cy, g.r, 1180, 820, { top: 0, right: 0, bottom: 0, left: 0 }, out);
    expect(out.x).toBeLessThan(0);
    hintShift(SwipeDir.DOWN, 'Knock-on', g.cx, g.cy, g.r, 1180, 820, { top: 0, right: 0, bottom: 0, left: 0 }, out);
    expect(out.y).toBeLessThan(0);
    hintShift(SwipeDir.LEFT, 'Hard stop', g.cx, g.cy, g.r, 1180, 820, { top: 0, right: 0, bottom: 0, left: 0 }, out);
    expect(out).toEqual({ x: 0, y: 0 });
    // Unknown viewport: no shift.
    hintShift(SwipeDir.RIGHT, 'Skill', g.cx, g.cy, g.r, 0, 0, { top: 0, right: 0, bottom: 0, left: 0 }, out);
    expect(out).toEqual({ x: 0, y: 0 });
  });

  it('the overlay writes the shift on the hint elements when a held press shows its hints', () => {
    const st = createTouchIntentState();
    const root = fakeRoot();
    const ov = createTouchOverlay(asHtml(root), st);
    const l = computeClusterLayout(1180, 820, { top: 0, right: 0, bottom: 0, left: 0 }, {}, createClusterLayout());
    ov.layout(l, 1180, 820, { top: 0, right: 0, bottom: 0, left: 0 });
    const ids: (TouchButtonId | -1)[] = [TouchButtonId.SPRINT_SKILL, TouchButtonId.PASS, TouchButtonId.THROUGH, TouchButtonId.SHOOT];
    ov.bind({
      cluster: {
        ids, modes: [ClusterMode.ATTACK, ClusterMode.ATTACK, ClusterMode.ATTACK, ClusterMode.ATTACK],
        labels: ['SPRINT', 'PASS', 'THROUGH', 'SHOOT'], pressed: 1 << ClusterSlot.BIG, version: 1,
        hintMask: 1 << TouchButtonId.SPRINT_SKILL,
      } as never,
    });
    ov.sync();
    const big = ov.slotEl(ClusterSlot.BIG) as unknown as { children: { attrs: Record<string, string>; style: { getPropertyValue(k: string): string } }[] };
    const right = big.children.find((c) => c.attrs['data-dir'] === String(SwipeDir.RIGHT))!;
    const down = big.children.find((c) => c.attrs['data-dir'] === String(SwipeDir.DOWN))!;
    expect(parseFloat(right.style.getPropertyValue('--dk-hx'))).toBeLessThan(0);
    expect(parseFloat(down.style.getPropertyValue('--dk-hy'))).toBeLessThan(0);
  });
});
