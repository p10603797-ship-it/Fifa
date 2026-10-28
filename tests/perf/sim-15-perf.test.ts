/**
 * SIM-15 — resolver budget (< 0.1 ms per tick) and zero allocation per tick. The stage is measured as step() calls
 * it (resolveControllers incl. the SIM-16 switchTick it calls). SIM-04 ticksToReach is replaced by a pure arithmetic
 * stand-in (as in tests/unit/sim-16-alloc.test.ts) so the numbers cover this stage, not the locomotion estimator;
 * starters are silent refusing fakes so presses exercise the buffer every tick.
 * Heap growth is measured after a long warm-up as the minimum over several windows: a single window can contain an
 * optimizing compile (code objects live on the heap, ~1-2 MB), which is JIT noise, not per-tick allocation.
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { SimState } from '../../src/contracts/state';

vi.mock('../../src/sim/players/locomotion', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/sim/players/locomotion')>();
  return {
    ...orig,
    ticksToReach: (s: SimState, slot: number, x: number, z: number): number => {
      const p = s.players[slot]!;
      const dx = x - p.x, dz = z - p.z;
      return Math.ceil((Math.sqrt(dx * dx + dz * dz) / 8) * 60);
    },
  };
});
vi.mock('../../src/sim/kicks/pass', async (o) => (await import('../scenario/sim-15-fakes')).mockPass((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/lob', async (o) => (await import('../scenario/sim-15-fakes')).mockLob((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/through', async (o) => (await import('../scenario/sim-15-fakes')).mockThrough((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/shot', async (o) => (await import('../scenario/sim-15-fakes')).mockShot((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/aerial', async (o) => (await import('../scenario/sim-15-fakes')).mockAerial((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/skills', async (o) => (await import('../scenario/sim-15-fakes')).mockSkills((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/defend/tackle', async (o) => (await import('../scenario/sim-15-fakes')).mockTackle((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/keeper/sweeper', async (o) => (await import('../scenario/sim-15-fakes')).mockSweeper((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/keeper/handling', async (o) => (await import('../scenario/sim-15-fakes')).mockHandling((await o()) as Record<string, unknown>));
vi.mock('../../src/ai/runs', async (o) => (await import('../scenario/sim-15-fakes')).mockRuns((await o()) as Record<string, unknown>));
vi.mock('../../src/ai/support', async (o) => (await import('../scenario/sim-15-fakes')).mockSupport((await o()) as Record<string, unknown>));

import { GestureKind, SkillMove } from '../../src/contracts/enums';
import { Btn, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { createEventBuffer } from '../../src/sim/core/events';
import { resolveControllers } from '../../src/sim/control/resolve';
import { FAKE } from '../scenario/sim-15-fakes';
import { scene } from '../scenario/sim-15-setup';

function busyState(): { s: SimState; frames: InputFrame[] } {
  FAKE.log = false;
  FAKE.accept = false;
  const s = scene({ p2Slot: 20 });
  const helper = s.players[16]!; helper.x = 12; helper.z = 6;
  return { s, frames: [createInputFrame(), createInputFrame()] };
}

/** Two humans: P1 attacks (holds, presses, modifiers, gestures, skills), P2 defends (contain, 2nd def, rush, jockey). */
function drive(s: SimState, frames: InputFrame[], n: number): void {
  const ev = createEventBuffer();
  const f = frames[0]!;
  const g = frames[1]!;
  for (let i = 0; i < n; i++) {
    s.tick++;
    const k = i % 120;
    f.buttons = k < 30 ? Btn.PASS | Btn.SPRINT : k < 40 ? Btn.MOD_R : k < 60 ? Btn.SHIELD : k < 70 ? Btn.SHOOT : k < 75 ? Btn.MOD_L : 0;
    f.mx = k < 90 ? 100 : 0;
    f.mz = (k & 7) * 10;
    // Gestures while P1 attacks (a defending tap on a teammate is a SIM-16 manual switch, measured by SIM-16).
    const att = s.ball.owner === 9;
    f.gesture = att && k === 100 ? GestureKind.TAP : att && k === 105 ? GestureKind.SWIPE : GestureKind.NONE;
    f.gx = 250; f.gz = 50; f.gSlot = 10; f.gdx = 127; f.gPower = 90;
    f.skill = k === 110 ? SkillMove.STEP_OVER : SkillMove.NONE;
    g.buttons = k < 50 ? Btn.PASS : k < 80 ? Btn.MOD_R | Btn.THROUGH : k < 90 ? Btn.SHIELD : k < 100 ? Btn.SHOOT : k < 110 ? Btn.LOB : Btn.SPRINT;
    g.mx = k < 90 ? -80 : 0;
    if (k === 0) {
      const b = s.ball;
      b.owner = i % 240 === 0 ? 9 : 20; b.heldBy = -1;
      const o = s.players[b.owner]!;
      b.x = o.x + 0.5; b.z = o.z; b.y = 0.11; b.vx = 0; b.vz = 0;
    }
    resolveControllers(s, frames, ev);
  }
}

describe('SIM-15 budget and allocation', () => {
  it('resolveControllers costs < 0.1 ms per tick (two humans: presses, holds, buffers, gestures)', () => {
    const { s, frames } = busyState();
    drive(s, frames, 20000);
    // Best of several windows: other processes on a shared machine only ever add time.
    const n = 4800;
    let ms = 1e9;
    for (let w = 0; w < 6; w++) {
      const t0 = performance.now();
      drive(s, frames, n);
      const m = (performance.now() - t0) / n;
      if (m < ms) ms = m;
    }
    console.log(`SIM-15 resolveControllers: ${(ms * 1000).toFixed(2)} us per tick (best window)`);
    expect(ms, `${(ms * 1000).toFixed(2)} us per tick`).toBeLessThan(0.1);
  });
  it('resolveControllers allocates nothing per tick', () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const { s, frames } = busyState();
    drive(s, frames, 30000);
    const n = 24000;
    let bytes = 1e9;
    for (let w = 0; w < 4; w++) {
      gc();
      const h0 = process.memoryUsage().heapUsed;
      drive(s, frames, n);
      const b = (process.memoryUsage().heapUsed - h0) / n;
      if (b < bytes) bytes = b;
    }
    // A real per-tick allocation is >= 16 bytes per tick; allow GC/JIT noise below that.
    console.log(`SIM-15 resolveControllers: ${bytes.toFixed(2)} bytes per tick (best window)`);
    expect(bytes, `${bytes.toFixed(1)} bytes/tick`).toBeLessThan(8);
  }, 120_000);
});
