# TAI-05 — Pressing, cover, marking, tracking runners
Owns: `src/ai/press.ts`. Spec: BRIEF §7 ("press with the nearest man, cover with the next, mark zones and passing
lanes, track runners, and make recovery runs after losing the ball"), team press tactic, second defender (ctrl.secondDef
set by SIM-15 when a human holds MOD_R / 2ND DEF).
Implement `assignPressing`: when the opponent has the ball: team.pressSlot = best presser (arrival time to the carrier,
not the human-controlled player — if the human controls the nearest, the AI presser is the next, as a support), PRESS
job at a point goal-side of the carrier (not diving in: stop ~1.5-2.5 m away; jockey facing), team.coverSlot = cover
behind the presser on the carrier's path to goal; the called second defender (ctrl.secondDef) presses hard; TRACK_RUNNER
jobs on opponents making forward runs into the defensive third; intensity from team style and difficulty
(TAI-12 levelParams(level).pressIntensity for CPU teams, a default for human teams) and team.teamPress (higher press).
Jobs: use ai/jobs.ts assignJob(s, slot, job, x, z, speedMps, targetSlot) — it only overrides lower-or-equal priority jobs (AiJob order); TAI-07 executeJobs turns the final job into arrival steering. Read team.phase (TAI-06), player.homeX/homeZ (TAI-01), ball, query helpers. Mirror everything by team.dir.
Tests: exactly one primary presser, cover goal-side, runners tracked, second defender honoured, no two pressers on the
carrier unless team press, deterministic. Budget < 0.05 ms/tick.
