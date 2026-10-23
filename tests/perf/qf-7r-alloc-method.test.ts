/**
 * [QF-7R] The allocation tests' measuring method is exact (tests/perf/qf-7r-alloc-flags.ts ALLOC_FLAGS + EXACT_INTERVAL).
 *
 * Defect this guards: the allocation tests sampled with a constant 64-byte interval (ALLOC_FLAGS'
 * --sampling-heap-profiler-suppress-randomness). A frame loop allocates the same objects in the same order every
 * frame, so a constant step lands on the same object every time and never on the others. In the loop below (a heap
 * number every iteration in one function, a 56-byte object every second iteration in another) the constant 64-byte
 * step charged every sample to the object's function and none to the heap numbers' (1.6 MB unseen): a test could pass
 * with a real per-frame allocation in the code it guards.
 *
 * Here a child process runs such a loop and measures it twice: with the young generation's used bytes (exact; a 256 MB
 * young generation, so no GC in between) and with the sampling heap profiler as the allocation tests use it. The
 * profiler must report the same bytes (within 2%) and see every allocation site.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOC_FLAGS, EXACT_INTERVAL } from './qf-7r-alloc-flags';

describe('QF-7R allocation tests: measuring method', () => {
  it('the sampling heap profiler as the allocation tests use it reports every allocation at its exact size', () => {
    const code = `
      const v8 = await import('node:v8');
      const { Session } = await import('node:inspector/promises');
      const session = new Session();
      session.connect();
      let boxed = 0;
      const sink = [null];
      // A double written to a closure variable: one heap number per call. An object literal every second call.
      function num(i) { boxed = i * 1.5; }
      function obj(i) { sink[0] = { a: i, b: i + 1 }; }
      function work(n) { for (let i = 0; i < n; i++) { num(i); if (i % 2) obj(i); } }
      // Interpreted, as a harness and a rarely-run path are: each allocation is its own, in its own function.
      for (const f of [num, obj, work]) %NeverOptimizeFunction(f);
      work(200000);
      const young = () => { for (const x of v8.getHeapSpaceStatistics()) if (x.space_name === 'new_space') return x.space_used_size; return 0; };
      const N = 100000;
      const delta = (n) => { globalThis.gc(); const h0 = young(); work(n); return young() - h0; };
      delta(0);
      const exact = delta(N) - delta(0);
      const measure = async (interval) => {
        globalThis.gc();
        await session.post('HeapProfiler.startSampling', { samplingInterval: interval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
        work(N);
        const { profile } = await session.post('HeapProfiler.stopSampling');
        const names = new Map();
        const index = (nd) => { names.set(nd.id, nd.callFrame.functionName); for (const c of nd.children) index(c); };
        index(profile.head);
        let samples = 0, bytes = 0, self = 0, objSelf = 0;
        const sizes = {};
        for (const s of profile.samples) {
          if (!['work', 'num', 'obj'].includes(names.get(s.nodeId))) continue;
          samples++; bytes += s.size; sizes[s.size] = (sizes[s.size] || 0) + 1;
        }
        const walk = (nd) => {
          const fn = nd.callFrame.functionName;
          if (['work', 'num', 'obj'].includes(fn)) self += nd.selfSize;
          if (fn === 'obj') objSelf += nd.selfSize;
          for (const c of nd.children) walk(c);
        };
        walk(profile.head);
        return { samples, bytes, self, objSelf, sizes };
      };
      const exactRun = await measure(${EXACT_INTERVAL});
      const coarse = await measure(64);
      console.log(JSON.stringify({ exact, exactRun, coarse }));
      process.exit(0);
    `;
    const r = spawnSync(process.execPath, [
      '--allow-natives-syntax', ...ALLOC_FLAGS, '--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', '--input-type=module', '-e', code,
    ], { cwd: resolve(__dirname, '../..'), encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as {
      exact: number;
      exactRun: { samples: number; bytes: number; self: number; objSelf: number; sizes: Record<string, number> };
      coarse: { samples: number; bytes: number; self: number; objSelf: number; sizes: Record<string, number> };
    };
    console.log(`QF-7R alloc method: ${JSON.stringify(res)}`);
    const N = 100000;
    // The loop really allocates (a heap number per iteration, an object every second one).
    expect(res.exact).toBeGreaterThan(N * 16);
    // Every allocation is a sample: the sampled bytes are the young generation's bytes...
    expect(Math.abs(res.exactRun.bytes - res.exact) / res.exact).toBeLessThan(0.02);
    // ...and the per-node selfSize the tests sum is the same within 2%.
    expect(Math.abs(res.exactRun.self - res.exact) / res.exact).toBeLessThan(0.02);
    // Every allocation is its own sample: a heap number per iteration, an object every second iteration.
    expect(res.exactRun.samples).toBeGreaterThanOrEqual(N * 1.5);
    // The object's function is charged its objects (with a constant 64-byte step it was charged nothing at all).
    expect(res.exactRun.objSelf).toBeGreaterThanOrEqual((N / 2) * 16);
  }, 150_000);
});
