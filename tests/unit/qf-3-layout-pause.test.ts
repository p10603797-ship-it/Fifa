/**
 * QF-3 QA-23 (second pass): controls-editor placements keep their corner distances on another viewport (Stage Manager /
 * Split View window sizes). A button placed high on the right of a tall window was clamped onto the pause button in a
 * shorter one, and PAUSE wins every touch it covers (routing priority): a SHOOT tap there paused the match instead.
 * Now the touch source's layout (keepClearOfPause after computeClusterLayout) pushes such a button down until it is
 * T_TOUCHUI.buttonGap clear of PAUSE.
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
import { ClusterSlot, TouchButtonId } from '../../src/contracts/touch';
import { T_TOUCHUI } from '../../src/contracts/tuning';
import { computeClusterLayout, createClusterLayout, keepClearOfPause } from '../../src/input/touch/attack';
import { makeScenario } from '../harness/scenario';
import { createTouchRig, H, W } from './qf-3-touch-rig';

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

function clearOfPause(l: ReturnType<typeof createClusterLayout>, gap: number): boolean {
  for (const g of l.slots) {
    if (Math.hypot(g.cx - l.pause.cx, g.cy - l.pause.cy) < g.r + l.pause.r + gap - 1e-6) return false;
  }
  return true;
}

describe('QF-3 QA-23 cluster buttons never sit on the pause button', () => {
  it('placements from a taller window, laid out in shorter ones (iPad sizes, mirrored or not, with insets)', () => {
    const sizes: [number, number][] = [[1133, 744], [1180, 820], [1024, 700], [1366, 1024], [980, 640]];
    const insets = [NO_INSETS, { top: 24, right: 0, bottom: 20, left: 0 }];
    for (const [w, h] of sizes) {
      for (const safe of insets) {
        for (const mirror of [false, true]) {
          for (const slot of [ClusterSlot.HIGH, ClusterSlot.MID, ClusterSlot.LOW, ClusterSlot.BIG]) {
            for (const dx of [0, 10, 40, 80]) {
              for (const dy of [h - 40, h, h + 200, 2000]) {
                const id = [TouchButtonId.SPRINT_SKILL, TouchButtonId.PASS, TouchButtonId.THROUGH, TouchButtonId.SHOOT][slot]!;
                const l = computeClusterLayout(w, h, safe, { mirror, placements: { [String(id)]: { dx, dy, scale: 1.2 } } }, createClusterLayout());
                keepClearOfPause(l, h, safe);
                expect(clearOfPause(l, T_TOUCHUI.buttonGap), `${w}x${h} slot ${slot} dx ${dx} dy ${dy} mirror ${mirror}`).toBe(true);
                for (const g of l.slots) expect(g.cy + g.r).toBeLessThanOrEqual(h - safe.bottom + 1e-6);
              }
            }
          }
        }
      }
    }
  });

  it('a SHOOT tap on a button placed under the pause corner shoots; it never pauses the match', () => {
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }], players: [{ slot: 9, x: 30, z: 0 }],
      ball: { owner: 9, x: 30.4, y: 0.11, z: 0, lastTouchTeam: 0 },
    });
    for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
    // Placed by the editor in a 1366 x 1024 window: 10 pt from the right edge, 900 pt above the bottom.
    const r = createTouchRig(s, { settings: { layout: { [String(TouchButtonId.SHOOT)]: { dx: 10, dy: 900, scale: 1 } } } });
    expect(W).toBe(1180);
    expect(H).toBe(820);
    r.tick(2);
    const p = r.slot(ClusterSlot.HIGH);
    r.down(2, p.x, p.y); r.wait(60); r.up(2, p.x, p.y);
    r.tick(6);
    expect(r.pauses).toBe(0);
    expect(r.frames.some((f) => (f.buttons & Btn.SHOOT) !== 0)).toBe(true);
  });
});
