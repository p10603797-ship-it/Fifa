# Wave 5 sign-off assignments (run after QF-8's campaign, on the final tree)

- SGN-01 Definition-of-done audit: walk BRIEF §19 DoD 1-11 and every "must" in §2-§15 line by line against the code,
  tests and reports; produce docs/TEST_REPORT.md sections and a table (requirement -> evidence -> PASS/FAIL/re-scoped).
- SGN-02 Controls audit: every row of §9 and §10 exercised by a test (map each row to a test title; add tests for
  any unmapped row); DoD 2.
- SGN-03 Fresh soak (2,000), fuzz (500) and determinism (3 runs per seed; replay after reload) on the final build; DoD 1.
- SGN-04 Final benchmark and budget report: throttled proxy benchmark (Chromium CDP 4x/6x), bundle size, load time,
  draw calls/triangles/textures per scene, sim/AI tick times; docs/PERF_REPORT.md; DoD 6.
- SGN-05 Originality and licence audit (docs/briefs/SGN-05.md); DoD 9.
- SGN-06 Docs audit: README, controls reference, device checklist, known issues, ARCHITECTURE/CONTRACTS/OWNERSHIP/TUNING
  up to date with the code; every command in README runs.
