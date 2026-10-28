# FIN-P2 — Proxy gate, last attempt: worst-tick spikes (DoD 6, BRIEF §13), behaviour-identical

Area (exclusive): `src/sim/**`, `src/ai/**`, `src/contracts/tuning.ts`, `src/platform/benchHook.ts`, `tools/bench.ts`,
tests/perf for sim/AI/bench, tests/unit/rul-05-perf.test.ts, docs/PERF_REPORT.md (sim/AI + gate sections). Nobody else runs.
State after FIN-P (docs/PERF_REPORT.md "Proxy gate: final fix round (FIN-P)"): `npx tsx tools/bench.ts --dist <fresh build>
--throttle 4` (seed 1, window 5400 ticks) — sim average 0.78-0.86 ms (passes 2.5), p99 of each frame's worst tick 4.3-4.8 ms
(FAILS 4), 29-38 of 1800 frames over 4 ms. Causes measured: about half of the over-budget frames have a minor GC inside
the tick (sim+AI allocation in production mode 8-22 KB/tick at ticks 300-900, falling to 8 KB later, because hot
functions deoptimise on branches the warm-up never took, e.g. resolvePairs ~11 deopts, and run unoptimised in between);
the rest are the cold first tick of each frame (1.5 ms vs 0.65 ms) and the CPU carrier's pass scan every 6 ticks
(300-500 us of a 400-800 us tick at 1x; through balls 46%, ground passes 37%). The container itself shows ~2x p99
jitter on a constant workload.
Everything here must keep match behaviour IDENTICAL (tools/hash-table.ts 28 runs, and tests/perf/fin-p-prod-hash.ts in
production mode, before/after). No budget, metric or window may be loosened.
1. Deopts in play: run the production build with --trace-deopt (or the probes in tests/perf/fin-p-*) and remove every
   deopt that recurs during the bench window: type-stable code, and a warm-up that covers the branches play takes
   (corners, free kicks, throw-ins, goals and kick-offs, penalties, tackles and fouls, keeper saves) — e.g. a scripted
   tour of situations in the loading-screen warm-up. Target: production-mode sim+AI allocation ~0-2 KB/tick from tick 300.
2. Carrier decision cost: make the pass/through-ball scan cheaper with identical results (early exits that cannot change
   the chosen option, cached per-tick geometry, cheaper interception estimates with exact equality of outputs).
3. tests/unit/rul-05-perf.test.ts previewFlight is red (1542-1558 B vs ~1016 B; ball/contact.ts `frame` ~800 B per
   preview call even in optimised code): find what boxes and fix it without loosening the limit.
4. Measure the gate with interleaved runs (old build vs new build alternately, >= 4 pairs) on an idle container, plus the
   constant-workload jitter probe, and report honestly. If the gate still fails, say by how much and which share of the
   over-budget frames is GC, cold first tick, carrier, or environment jitter.
Update docs/PERF_REPORT.md. Work economically (usage limits).
