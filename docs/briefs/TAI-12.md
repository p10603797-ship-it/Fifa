# TAI-12 — Difficulty levels and team styles
Owns: `src/ai/cpu/levels.ts`. Spec: BRIEF §7 ("Team styles (possession, counter-attack, direct, high press, wing play)
weight those choices so clubs feel different. Six levels: Beginner, Amateur, Semi-Pro, Professional, World Class,
Legend. They differ in reaction time, decision noise, look-ahead, execution error, pressing and tackle timing. They never
differ in physics."), §7 target "Each level beats the one below in 65% or more of bot-v-bot matches", T_LEVEL.
Implement `levelParams` (from T_LEVEL; you may propose new values via TUNING-CR) and `styleWeights` (distinct weights
per TeamStyle: possession = safety high, directness low; counter = counter/directness high after winning the ball;
direct = long balls/progress; high press = press high; wing play = width/crosses high). Also export
`applyExecutionError(s, team, value, scale)` helper (deterministic noise on aim/power the CPU writes into its frame, scaled
by executionError — the CPU's inputs get noisier; the physics stays the same).
Later (when the sim is real) you will verify the ladder by simulation; now: unit tests that levels are monotonic in every
parameter and styles differ meaningfully; write `tools/ladder.ts` (you own it) that runs N bot-v-bot matches per level
pair via tools/headless.ts runMatch and prints win rates (will be used by QA-19).
