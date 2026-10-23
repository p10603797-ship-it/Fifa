# TUN-2 — Tuning in data, last pass (BRIEF §4 rule 6), behaviour-identical

Area (exclusive): every `src/**` file for constant moves only, `src/contracts/tuning.ts`, docs/TUNING.md, tests that import
moved names. No behaviour change anywhere.
TUN-7S moved the 52 LOCAL_TUNING blocks of src/sim and src/ai. Remaining:
1. Gameplay numbers that were never in a block: the set-piece spot templates in src/ai/setpieces.ts (~60 values) and
   other inline gameplay literals in src/sim/** and src/ai/** (distances, speeds, times, probabilities, weights). Move them
   into tuning.ts with unit + comment. Leave maths constants, array sizes, enum indices, epsilons and guards local.
2. Input feel is gameplay (BRIEF §9/§10 thresholds): move the TUNING-CR blocks of src/input/** (touch and pad timing,
   dead zones, swipe thresholds) and any gameplay constants in src/modes/** into tuning.ts (e.g. T_TOUCH_INPUT, T_PAD_INPUT).
3. The remaining TUNING-CR markers (src/render, src/audio, src/ui, src/net, src/platform, src/data, src/app) are not
   gameplay: keep the values local, replace the marker with `// LOCAL_TUNING (non-gameplay: <reason>)`, and list them in
   docs/TUNING.md. After this pass `grep -r TUNING-CR src` must be empty.
Proof of identity: tools/hash-table.ts (28 runs) IDENTICAL before/after; a deep value comparison of every moved constant
(old vs new, Object.is); input tests (tests/controls, tch-*, pad-*, qf-3-*) and sim/AI area tests green; tsc and eslint clean.
Update docs/TUNING.md (old location -> new name table). Work economically.
