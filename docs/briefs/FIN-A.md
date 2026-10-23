# FIN-A — Final fixes: app/render/tools items from the sign-off audits

Area (exclusive for this run): `src/render/**`, `src/audio/**`, `src/app/**`, `src/ui/**`, `src/platform/**` (except
benchHook seed, which FIN-P owns), `tools/size-check.ts`, `tests/**` files named below, docs/KNOWN_ISSUES.md (Audio and
platform section only). FIN-K works in src/sim and src/ai in parallel.
1. Menu frame drop: menus drop one frame (10-25 ms) once in the first seconds after the splash tap, while the crowd-bed
   loop's crossfade prefix renders in one audio-bank chunk (QF-5 KNOWN_ISSUES line). Split that work into small chunks
   (or render it during the splash) so no menu frame exceeds the normal frame time; test it; remove the line.
2. textureMemory() in src/render/index.ts does not count a shadow map's DepthTexture (4 MB at QUALITY): count it; keep
   qf-4-texmem / gfx tests green.
3. tools/size-check.ts: the src/contracts group budget (80 KB) predates moving all tuning into contracts/tuning.ts (110.5
   KB now; total bundle 823 KB gzip of 4 MB). Raise that early-warning group budget with a comment (e.g. 160 KB) so
   `npx tsx tools/size-check.ts` passes; the 4 MB total gate is unchanged.
4. tests/unit/sim-01-perf.test.ts:190 'solvers create no objects' failed once under parallel load (groundRollTime 1472
   B/call vs 1024) and passes alone: make the measurement load-independent (child process with --single-threaded, as
   TUN-7S did for the other sim/AI allocation tests) without loosening the limit.
5. Two weak older assertions (SGN-02): tests/unit/qf-3-touch-attack-table.test.ts 'SHOOT swipe left: fake shot' also
   passes on a real SHOT, and tests/controls/qf-3-pad-rows.test.ts 'Low driven shot...' passes on any SHOT: tighten them
   to the strict versions in tests/controls/sgn-02-*.
6. After a final-whistle hard-sync or a mid-match resync online, the late side's statistics panel is counted on its own
   timeline (src/net KNOWN_ISSUES lines): if the stats tracker can be resynced cheaply (e.g. the host sends its summary
   with the final state / snapshot and the guest adopts it), do it in src/app or src/modes with a test; otherwise leave it.
Run your area tests, tsc and eslint. Work economically (usage limits).
