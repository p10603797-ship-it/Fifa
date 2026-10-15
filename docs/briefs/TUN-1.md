# TUN-1 — Tuning lives in data: move sim gameplay constants into contracts/tuning.ts (BRIEF §4 rule 6)

BRIEF §4 rule 6: "Every gameplay constant sits in contracts/tuning.ts with its unit and a comment." Wave 1-4 agents
added `LOCAL_TUNING` / `*_TUNING` blocks marked TUNING-CR inside their files. Move every gameplay constant in
`src/sim/**` and `src/ai/**` into `src/contracts/tuning.ts`. Runs after QF-11, with no other agent editing the sim or AI
(QF-12 may still be in the app layer), so hash comparisons are valid.
Area (exclusive for this run): `src/sim/**`, `src/ai/**`, `src/contracts/tuning.ts`.
Rules:
- Values must not change: the move is behaviour-identical. Prove it: before you start, record `hashState` at the end of
  full headless matches for at least 8 seeds/configs (tools/headless.ts runMatch, both difficulty extremes, cup rules,
  practice) and the fuzz determinism hash; after the move all must be identical. Re-run the sim area tests.
- Keep the readability: group by system (T_KICK, T_RESTART, T_BODIES, ...) or extend existing blocks; each entry keeps
  its unit and comment. Files import from tuning.ts; remove the local blocks (or keep a local alias only where a test
  imports the old name — then update the test instead where you own it).
- Non-gameplay constants (debug, allocation scratch sizes, algorithm iteration counts that do not change behaviour
  when equal) may stay local; list what stays and why.
- Update docs/TUNING.md: a table of the moved constants (old location -> new name) and remove TUNING-CR markers.
Report: files changed, constants moved (count per block), the before/after hash table, tests run.
