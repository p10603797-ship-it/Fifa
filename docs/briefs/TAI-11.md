# TAI-11 — CPU defending
Owns: `src/ai/cpu/defending.ts`. Spec: BRIEF §7 CPU opponent ("Off the ball it picks which defender to control,
jockeys, times tackles after a reaction delay, calls the second defender, and occasionally fouls."), levels
(tackleTimingTicks, reaction), §10 defending inputs.
Implement `cpuDefend(s, team, out, ev)`: choose the controlled defender (the best-placed goal-side defender; switch with a
gesture TAP on that teammate (gSlot) or MOD_L when SIM-16's choice is fine), approach the carrier goal-side (stick),
jockey (SHIELD hold) within ~3 m, contain (PASS hold) when the carrier is dribbling at speed, call the second defender
(MOD_R hold) when the carrier is in the final third, time standing tackles (SHOOT press) when the ball is exposed (between
touches, carrier's skill vulnerable window, or carrier turning) after tackleTimingTicks/reaction delay with brain.tackleCd
cooldown, slide (LOB) only when goal-side and the ball is loose-ish (rarely from behind), intercept by moving into lanes,
rush the keeper (THROUGH hold) on one-on-ones. Occasional fouls emerge from mistimed tackles, not scripted cards. Only
writes `out`.
Tests: goal-side approach, jockey distance, tackle timing improves with level, rare slides from behind, deterministic.
