# FIN-P — Final fix: the throttled proxy benchmark gate (DoD 6, BRIEF §13 "Proving it")

Area (exclusive for this run): `src/sim/**`, `src/ai/**`, `src/contracts/tuning.ts`, `src/platform/benchHook.ts`,
`tools/bench.ts`, tests/perf for sim/AI and bench, docs/PERF_REPORT.md (sim/AI and bench sections). Runs after FIN-K.
BRIEF §13: "Proxy gate. Run the benchmark headless in Chromium with 4x CPU throttling. Fail the build if the sim, draw-call
or triangle budgets are exceeded." Sim budget: 2.5 ms average, 4 ms worst case per tick. SGN-04 (docs/PERF_REPORT.md
"Final benchmark (SGN-04)") measured on a fresh build: `npx tsx tools/bench.ts --dist <dist> --throttle 4` sim avg 2.97 ms
(FAIL) and p99 of each frame's worst tick 11.9 ms (FAIL); draw calls and triangles pass. At 1x: avg 0.49-0.74 ms, p99
2.1-2.6 ms, single worst tick 5.4-6.9 ms; back-to-back sim cost 0.22-0.32 ms/tick, so paced play costs ~2x more
(JIT/cache/GC interleaving with render). Chromium GC pauses over 4 ms: 5.0-6.2 ms at 1x (early-match major GCs), 11-36
ms throttled. Steady sim+AI allocation ~2.8-4 KB/tick (V8 double boxing at call boundaries; top: steerJob, defendCarrier,
assignPressing, xgKernel, bestReceiver).
Goal: the gate passes honestly on an idle container, repeatably (3 runs), with the measurement unchanged in meaning.
1. Profile paced play under 4x (CPU profile + trace): which ticks are worst and why (GC inside ticks, staggered AI
   evaluations landing together, deopts, first-time paths).
2. Remove steady per-tick allocation in sim+AI to ~0 (so scavenges stop landing in ticks); spread expensive AI evaluations
   evenly across ticks on the fixed deterministic schedule (§13 "AI budgeting"); cut early-match major GCs (allocation at
   match start / codegen / warm-up; prepare during loading).
3. Bench seed: BENCH_DEFAULTS.seed 0xb3ac4 has no corner, goal or replay in its measured window, which §13 requires
   (tests/perf/sgn-04-bench-coverage.ts exits 1; --seed 11 reports ok on the pre-FIN-K tree). Pick a seed whose window
   covers a crowded box, a corner, a goal with net ripple and a replay on the final tree, set it, and turn the coverage
   probe into a vitest test asserting coverage(BENCH_DEFAULTS.seed).ok.
4. Prefer behaviour-identical changes (record the tools/hash-table.ts table first; IDENTICAL after). If a change must
   alter behaviour (e.g. re-staggering), say so and re-run a 150-match soak, the ladder top pairs and a 60-match fuzz.
Report before/after numbers for the gate (3 runs each), GC pauses, allocation per tick, and update docs/PERF_REPORT.md.
