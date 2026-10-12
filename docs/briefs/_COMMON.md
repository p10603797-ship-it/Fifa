# Common rules for every DotKick assignment

You are one sub-agent on DotKick, an original 11-a-side football game for iPad Safari (touch + controllers),
TypeScript strict + Vite + Three.js. Repo: /home/user/Fifa (always use absolute paths). A lead engineer
orchestrates ~200 assignments; you own exactly one. Your assignment brief is the file named in your prompt.

## Read first
1. `docs/ARCHITECTURE.md` (layers, tick pipeline, rules) and `docs/OWNERSHIP.md` (who owns which file).
2. The contracts you implement or call: `src/contracts/*.ts` (state layout, enums, input, events, tuning, systems, app).
3. Your stub file(s): the header comment names your duties; exported names and signatures are the contract.
4. The brief sections your assignment names in `docs/BRIEF.md` (the product spec). Where your brief and
   BRIEF.md disagree, BRIEF.md wins; tell the lead.

## Hard rules
- Shared working tree: many agents edit other files at the same time. Edit ONLY the files you own plus new
  test files `tests/**/<your-id-lowercase>-*.test.ts` (unit/scenario) or `tests/e2e/<your-id-lowercase>-*.spec.ts`.
  You may add helper files inside your own folder if you name them in your report.
- Keep every exported name and signature of your stub(s); you may add exports. Never edit `src/contracts/**`,
  lead-owned files (see OWNERSHIP.md) or other agents' files. Need a change? Put an exact change request in your report.
- Do NOT run git commands that change anything (no add/commit/stash/checkout/reset/restore/clean). The lead commits.
- Errors in files you do not own are not yours (someone may be mid-edit). Filter:
  `cd /home/user/Fifa && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "<your paths>"`.
  If a dependency you call is still a stub, code against its documented contract, test your logic with
  scenario setups, and note the dependency in your report.
- Unit/scenario tests: `npx vitest run <files>` (Node environment; no jsdom). Lint: `npx eslint <files>` must
  report 0 errors. E2E: `npx vite build && npx playwright test <spec>` (preinstalled Chromium; never run
  `playwright install`).
- Tuning: never hard-code gameplay numbers in logic. Use `src/contracts/tuning.ts`; for new constants add a
  `const LOCAL_TUNING = { ... } // TUNING-CR` block at the top of your file (with units in comments) and list it.

## Determinism (src/sim and src/ai)
- No `Math.random/sin/cos/tan/asin/acos/atan/atan2/pow/exp/log/hypot`, no `Date`, `performance`, DOM, Three.js,
  `Map`/`Set`. Use `src/sim/core/dmath.ts` (dsin, dcos, datan2, dsqrt is Math.sqrt which is allowed, dexp, dpow...)
  and `src/sim/core/rng.ts` with `s.rng`. Iterate players by slot index.
- No allocation in per-tick code: no closures, array helpers (map/filter/forEach), object/array literals,
  spreads or string building per tick. Use module-level preallocated scratch objects.
- All ball contacts go through `src/sim/core/kick.ts` (applyKick, takePossession, releasePossession,
  recordTouch). Start actions with `beginAction` from `src/sim/actions/dispatch.ts`; check `isFree(p)`.
- State values must stay finite and inside world bounds. Booleans are 0/1 numbers.
- The sim runs at 60 Hz; budget for the whole sim + AI is 2.5 ms average per tick on an iPad, so keep your
  per-tick cost small (O(22) or O(22^2) with tiny constants; stagger expensive scans across ticks deterministically).

## Quality bar
Zero known bugs at hand-off. Every behaviour named in your brief needs a test; every glitch-list line you own
needs a named regression test (name the test after the glitch). Prefer scenario tests that set up a SimState
(`tests/harness/scenario.ts` if present, or `initMatch` + overrides) and step the real pipeline.

## Report (your final message; it is data for the lead)
1. Built: files and exported API (one line each).
2. Tests: commands run and pass/fail counts (paste the summary lines).
3. Open risks / known gaps / dependencies still stubbed.
4. Contract change requests (exact proposed diff) and TUNING-CR constants, or "none".
