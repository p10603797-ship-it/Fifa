# Common rules for Wave 3-4 QA+fix agents (in addition to _COMMON.md)

Wave 3 (QA swarm) and Wave 4 (fix loop) are merged per area (D-020): one agent per area hunts defects in its charter,
fixes each one in the files its area owns, and adds a named regression test per defect. Charters keep the brief's QA-xx
and FIX-xx ids; report against each id.

- Ownership for this wave is the area list in your charter (the Wave 1/2 owners are finished). Other QF agents work in
  parallel: never edit their files; send an exact CR in your report for a defect outside your area, with a failing test
  that shows it (name it `tests/**/<your-id>-cr-*.test.ts`, marked `it.fails` so the suite stays green).
- Find defects by attacking the shipped behaviour: table-driven scenarios, adversarial inputs, many seeds, the real
  pipeline (`step`), headless matches (`tools/headless.ts`, `tools/soak.ts`, `tools/fuzz.ts`, `tools/ladder.ts`,
  `tools/balance.ts`) and short Playwright runs. A green existing test proves nothing new — write the test that would
  fail if the glitch were there.
- Glitch list (BRIEF §14): every line in your area must end with a regression test whose name starts with
  `glitch: <the glitch-list words>` so `tools/glitch-audit.ts` (lead) can map lines to tests.
- Zero known bugs: anything that affects match state, input or performance is fixed, not listed. Only cosmetic items
  may go to docs/KNOWN_ISSUES.md (send them in your report; the lead owns that file).
- Keep determinism (hash-stable per seed+inputs); if a fix changes sim behaviour, say so — replays/golden hashes in
  tests may need refresh (update the ones you own; CR the rest).
- Report sections: per QA/FIX id — what you attacked (scenarios, seeds, counts), defects found (symptom, root cause,
  fix, regression test name), what remains; then tests run, CRs, KNOWN_ISSUES candidates.
