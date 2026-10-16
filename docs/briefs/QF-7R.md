# QF-7R — Performance, render and app side (QA-36 render/app, QA-38, FIX-13 part 1)

Area (exclusive): `src/render/**`, `src/app/**`, `src/ui/**`, `src/audio/**`, `src/input/**`, `src/platform/**`,
`index.html`, `vite.config.ts`, tests/perf for those areas, docs/PERF_REPORT.md (render/app sections). QF-16 edits the
sim and AI in parallel: never edit `src/sim/**`, `src/ai/**` or tuning.ts gameplay blocks (sim/AI perf is QF-7S later).
Behaviour must not change (render output, input timing, audio) except to fix a performance defect.
1. Per-frame allocation in a live match: render code allocates 1.3-2.3 KB per frame (INT-C; mapper, broadcast camera,
   markers, crowd; deopts on insufficient type feedback) and tests/perf/int-c-render-alloc.test.ts and gfx-08-atlas fail;
   gfx-05/gfx-07/gfx-04/aud-05/pad-08/tch-06 allocation tests are load-sensitive. Get steady play to ~0 B/frame in
   render/HUD/audio/input and make those tests robust (measure precisely, not with a loose budget).
2. Frame time: build the app, run a CPU-v-CPU match in Chromium at iPad size under CDP CPU throttling (4x and 6x) and
   measure frame time p50/p95/p99, long frames, GC pauses, draw calls, triangles and dynamic-resolution behaviour (steps
   down and back up without oscillation, BRIEF §13). Profile the worst frames and fix the hot spots in your area.
3. Warm-up hitches at match start, goal replay start, half time; HUD DOM writes only on change; radar at 20 Hz.
Report numbers before and after for each item and update docs/PERF_REPORT.md.
