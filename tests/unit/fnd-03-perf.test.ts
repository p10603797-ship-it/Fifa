/**
 * FND-03: performance budgets in Node (assignment): hashState of a full state < 0.3 ms, copyState < 0.05 ms.
 * Measured as the best of several batches so a busy test runner does not make the check flaky.
 */
import { describe, expect, it } from 'vitest';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { cloneState, copyState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

function bestBatchMs(fn: () => void, iterations: number, batches: number): number {
  for (let i = 0; i < iterations; i++) fn(); // warm-up / JIT
  let best = Infinity;
  for (let b = 0; b < batches; b++) {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    best = Math.min(best, (performance.now() - t0) / iterations);
  }
  return best;
}

function playedState(): SimState {
  const s = initMatch(createMatchConfig());
  const ev = createEventBuffer();
  const f = [createInputFrame(), createInputFrame()];
  for (let i = 0; i < 300; i++) step(s, f, ev);
  return s;
}

describe('FND-03 performance budgets', () => {
  it('hashState of a full state < 0.3 ms', () => {
    const s = playedState();
    let sink = 0;
    const ms = bestBatchMs(() => { sink ^= hashState(s); }, 2000, 7);
    console.log(`hashState: ${(ms * 1000).toFixed(1)} us`);
    expect(sink).toBeTypeOf('number');
    expect(ms).toBeLessThan(0.3);
  });

  it('copyState < 0.05 ms', () => {
    const s = playedState();
    const dst = cloneState(s);
    const ms = bestBatchMs(() => copyState(dst, s), 2000, 7);
    console.log(`copyState: ${(ms * 1000).toFixed(1)} us`);
    expect(ms).toBeLessThan(0.05);
  });
});
