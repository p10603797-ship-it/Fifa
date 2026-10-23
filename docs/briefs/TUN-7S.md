# TUN-7S — Behaviour-identical sim/AI work: tuning in data (TUN-1, BRIEF §4 rule 6) and sim/AI performance (QF-7S: QA-36 sim, QA-37, FIX-13 part 2)

Area (exclusive): `src/sim/**`, `src/ai/**`, `src/contracts/tuning.ts`, `tools/**` (perf helpers only), tests/perf for sim/AI,
docs/TUNING.md, docs/PERF_REPORT.md (sim/AI sections). QF-17 works in src/app and src/ui in parallel.
Everything here must be BEHAVIOUR-IDENTICAL: before starting, record end-of-match hashState for >= 12 configs (tools/headless
runMatch: every difficulty, cup rules, practice kinds, shoot-out, a human-scripted match) and the soak/fuzz determinism
hashes; after every step they must be identical. Re-run the sim/AI area tests at the end.
1. TUN-1 (docs/briefs/TUN-1.md): move every gameplay constant in src/sim/** and src/ai/** LOCAL_TUNING / *_TUNING blocks
   (169 TUNING-CR markers in 120 files today, incl. src/sim/keeper) into src/contracts/tuning.ts, grouped by system, each
   with its unit and comment; remove the TUNING-CR markers; list what stays local and why (non-gameplay: scratch sizes,
   debug, iteration counts). docs/TUNING.md gets the old-location -> new-name table.
2. QF-7S performance: (a) src/sim/core/clone.ts copyState allocates ~10.4 KB per tick in live play (V8 boxes every double
   read through the generic for-in walk): specialise the copy per object shape (explicit per-field copies, or a cached
   generated copier where CSP allows; keep the generic fallback); flip tests/unit/qf-7r-cr-copystate-alloc.test.ts to it();
   (b) src/sim/rules/freekick.ts `SCR = cloneState(s)` builds a dictionary-mode scratch state: use createSimState + copyState
   as src/app/liveState.ts does; (c) steady per-tick allocation in sim + AI to ~0 (sampling profiler by site; double boxing at
   call boundaries such as ticksToReachAtSpeed, press helpers, estimateXg, evalIntercept, throughLeadPoint); make the
   allocation tests (tai-05/tai-08/tai-09/sim-05/06/07/14/gkp-03/04 budgets) robust, never loosening a limit to pass;
   (d) worst-case tick time (crowded box, set pieces, 22 chasers, shoot-out) against 2.5 ms average on an iPad (measure here
   and scale; report the method).
Report the hash table before/after, constants moved per block, allocation and tick-time numbers before/after.
