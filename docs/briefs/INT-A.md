# INT-A — Gameplay integration: a full, believable match headless (INT-01 + INT-04 + FIX-14 lead-in)

Owns for this wave: everything under `src/sim/**` and `src/ai/**` (all Wave 1 owners there are finished; you are now
the single integrator for these folders — keep their tests passing or update tests whose expectations the brief no
longer supports, explaining why), plus `src/modes/stats.ts` only for event-definition fixes, plus new tests
`tests/**/int-a-*.test.ts`. Do not edit `src/contracts/**` except `src/contracts/tuning.ts` (you may move TUNING-CR
constants there and retune values, documenting each change in docs/TUNING.md which you own).

Goal (BRIEF §5, §6, §7 targets, §14 invariants): bot-v-bot matches that look and play like football and meet the §7
bands over many seeds: goals 2.0-3.6 per match, shots 14-26, possession 40-60% each side, pass completion 70-88%,
fouls 6-16, offsides 0-6, blow-outs < 5%, keepers saving 65-78% on target, with zero exceptions, zero invariant
failures (`--enforce all`) and zero watchdog triggers.

Start from docs/INTEGRATION_ISSUES.md "Gameplay feel" and "Wiring" items in sim/ai (shots, possession balance, head
tennis, receiver trailing for humans and AI chasers, human receiver slowdown, PASS_COMPLETE definition, keeperTick order
GKP-01 vs GKP-03, TAI-14 assistedReceiver vs chaser, pressSlot/coverSlot stale in restarts, TAI-01 vs DAT-04 tactics).
Tools: `npx tsx tools/soak.ts --matches N --enforce all --halfMinutes 4` (stats bands printed), `tools/fuzz.ts`,
`tools/headless.ts` runMatch for probes, `tools/ladder.ts`, `tools/balance.ts` (DAT-05, may be in progress).
Work in loops: measure (soak 20-40 matches, 4-minute halves) -> find the biggest cause -> fix at the root (shape,
runs, decision weights, physics tuning) -> regression test -> re-measure. Keep per-tick budget: sim + AI <= 2.5 ms
average (measure with a probe; report). Keep determinism (run the determinism check).
Finish when the bands hold over 100 matches or you have exhausted clear root causes; report measured numbers either way.
Also confirm a human-controlled side works headless (scripted human inputs: passes complete to the intended receiver,
shots are taken, switching follows the ball) — add int-a scenario tests.
Report: measured bands before/after, root causes fixed, files changed, remaining gaps.
