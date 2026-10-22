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
 * With both, an allocation test reports an exact, reproducible number, and its threshold can be "nothing" instead of
 * a budget that absorbs noise.
 */
export const ALLOC_FLAGS: readonly string[] = ['--single-threaded', '--sampling-heap-profiler-suppress-randomness'];
