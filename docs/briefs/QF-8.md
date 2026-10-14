# QF-8 — Determinism, soak and fuzz campaign: QA-43, QA-44

Area: `tools/soak.ts`, `tools/fuzz.ts`, `tools/replay-inspect.ts`, `tests/soak/**`, `tests/fuzz/**`, docs/TEST_REPORT.md
draft sections (lead merges). No src edits: triage every failure to the owning QF agent or the lead with a minimal
reproduction (seed, tick, inputs, replay file under reports/).
Charter (BRIEF §14 items 2-4): QA-43 same seed + inputs give the same hash across three runs (Node; Chromium in the
built app via the debug overlay hash; Firefox/WebKit not installed here — note it), saved replay plays back identically
after reload; QA-44 run the campaign: 2,000 bot-v-bot matches across seeds, clubs, formations, difficulties and rule
toggles, and 500 fuzz matches (mashing, flips every tick, all buttons, pause spam, subs at every stoppage, quit and
rematch) in parallel workers within the CPU limits; zero exceptions, zero invariant failures, zero watchdog triggers,
§7 bands met. Record counts, durations, band results.
