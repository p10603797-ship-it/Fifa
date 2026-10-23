/**
 * [QF-7R] Node / V8 flags for precise, load-independent allocation measurements in child processes (render, HUD,
 * audio and input allocation tests).
 *
 * Why: V8 compiles optimised code on background threads. Under CPU load (many agents, a busy CI box) the optimised
 * code arrives later, so the measured window runs more frames in the interpreter / baseline tiers, which box every
 * intermediate double (HeapNumbers): the same code measured 0 B per frame on an idle machine and 0.6 B (or 4 KB in
 * the full renderer) under load. That is what made gfx-07 / gfx-05 / aud-05 / pad-08 / tch-06 / int-c "load
 * sensitive".
 *  --single-threaded: every compile job runs synchronously on the main thread. When a function gets optimised then
 *    depends only on what has run (call counts, feedback), never on wall-clock time or CPU load: the measured bytes
 *    are the same on every run.
 *  --sampling-heap-profiler-suppress-randomness: constant sampling interval, so a heap profile of the same run is the
 *    same profile (the default Poisson interval made a few-hundred-byte one-off show up in some runs only).
 *    ONLY with EXACT_INTERVAL (below): a constant interval larger than the objects samples whichever allocation
 *    happens to cross each 64-byte step, so a loop that allocates the same objects in the same order every frame is
 *    sampled at the same object every time and the others are never seen (tests/perf/qf-7r-alloc-method.test.ts:
 *    a heap number allocated every iteration read as 0 bytes at a constant 64-byte interval).
 * With both, an allocation test reports an exact, reproducible number, and its threshold can be "nothing" instead of
 * a budget that absorbs noise. Neither flag changes what the measured code allocates once it is optimised.
 */
export const ALLOC_FLAGS: readonly string[] = ['--single-threaded', '--sampling-heap-profiler-suppress-randomness'];

/**
 * [QF-7R] Sampling interval (bytes) of V8's sampling heap profiler for exact counts: smaller than the smallest heap
 * object (8 bytes), so with ALLOC_FLAGS every allocation is sampled exactly once and reported at its exact size (a
 * sample's `size`; a node's `selfSize` is the same within 2%: V8 scales it by 1 / (1 - exp(-size / interval))). Every
 * allocation then goes through V8's slow allocation path: slower, so measured windows stay a few thousand frames.
 */
export const EXACT_INTERVAL = 4;

/**
 * [QF-7R] Steady-state tiering for whole-match measurements (tests/perf/int-c-render-alloc.test.ts). Chromium's Maglev
 * takes a function out of the interpreter after ~400 calls; Node 22 runs without Maglev and leaves it there until
 * TurboFan's 3000, so a one-minute window would still measure the interpreter on paths met a few times a second (a
 * kick's reach, a post wobble). Lowering TurboFan's threshold to Maglev's measures what Chromium runs in steady play.
 * Allocation in optimised code (objects, arrays, closures, a double crossing a call V8 did not inline) is unchanged.
 */
export const STEADY_FLAGS: readonly string[] = ['--invocation-count-for-turbofan=400'];
