/**
 * FND-05: spatial focus geometry (pure; the DOM navigator itself is covered by e2e).
 */
import { describe, expect, it } from 'vitest';
import { MenuAction } from '../../src/contracts/app';
import { pickSpatial, type FocusRect } from '../../src/input/focus';

const rect = (x: number, y: number, w = 100, h = 40): FocusRect => ({ left: x, top: y, right: x + w, bottom: y + h });

describe('FND-05 pickSpatial', () => {
  // 3 x 3 grid, 120 px pitch.
  const grid: FocusRect[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) grid.push(rect(c * 120, r * 60));

  it('moves to the neighbour in each direction of a grid', () => {
    const centre = grid[4]!;
    expect(pickSpatial(centre, grid, MenuAction.UP)).toBe(1);
    expect(pickSpatial(centre, grid, MenuAction.DOWN)).toBe(7);
    expect(pickSpatial(centre, grid, MenuAction.LEFT)).toBe(3);
    expect(pickSpatial(centre, grid, MenuAction.RIGHT)).toBe(5);
  });

  it('returns -1 at the edge and for non-directional actions', () => {
    expect(pickSpatial(grid[0]!, grid, MenuAction.UP)).toBe(-1);
    expect(pickSpatial(grid[0]!, grid, MenuAction.LEFT)).toBe(-1);
    expect(pickSpatial(grid[8]!, grid, MenuAction.RIGHT)).toBe(-1);
    expect(pickSpatial(grid[4]!, grid, MenuAction.CONFIRM)).toBe(-1);
    expect(pickSpatial(grid[4]!, [], MenuAction.UP)).toBe(-1);
  });

  it('prefers an element in the beam over a nearer diagonal one', () => {
    const from = rect(0, 0, 100, 40);
    const diagonalNear = rect(110, 50, 100, 40); // right and below, outside the beam
    const beamFar = rect(400, 10, 100, 40); // right, overlapping vertically
    expect(pickSpatial(from, [diagonalNear, beamFar], MenuAction.RIGHT)).toBe(1);
  });

  it('falls back to the nearest out-of-beam element, favouring small cross offsets', () => {
    const from = rect(0, 0, 100, 40);
    const a = rect(300, 200); // far below-right
    const b = rect(150, 60); // just below-right
    expect(pickSpatial(from, [a, b], MenuAction.RIGHT)).toBe(1);
    expect(pickSpatial(from, [a, b], MenuAction.DOWN)).toBe(1);
  });

  it('vertical menu list: down goes to the next item, wide items keep the column', () => {
    const list = [rect(400, 100, 300, 60), rect(400, 180, 300, 60), rect(400, 260, 300, 60), rect(800, 180, 120, 60)];
    expect(pickSpatial(list[0]!, list, MenuAction.DOWN)).toBe(1);
    expect(pickSpatial(list[1]!, list, MenuAction.DOWN)).toBe(2);
    expect(pickSpatial(list[2]!, list, MenuAction.UP)).toBe(1);
    expect(pickSpatial(list[1]!, list, MenuAction.RIGHT)).toBe(3);
    expect(pickSpatial(list[3]!, list, MenuAction.LEFT)).toBe(1);
  });

  it('skips the element itself (same rect)', () => {
    const r = rect(0, 0);
    expect(pickSpatial(r, [r, rect(0, 100)], MenuAction.DOWN)).toBe(1);
  });
});
