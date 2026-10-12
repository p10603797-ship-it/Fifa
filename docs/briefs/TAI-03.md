# TAI-03 — Attacking runs and onside timing
Owns: `src/ai/runs.ts`. Spec: BRIEF §7 ("run in behind while staying onside, overlap from full-back when there is
cover, and arrive late in the box from midfield"), §9 THROUGH swipe down / §10 L1 tap = trigger a teammate's run;
pass and go (SIM-08 sets team.passGoSlot/passGoT after a PASS_AND_GO pass; you execute the run). Trigger run state: team.runSlot/runCallT.
Implement `assignRuns` and `triggerRun`:
- Forwards make RUN_IN_BEHIND jobs when the carrier can play a through ball: hold on the offside line
  (query.secondLastDefenderX of the opponents) and time the run to start when the carrier looks up (carrier facing
  forward, not pressed) so they stay onside at the pass moment; curved runs between centre-backs and full-backs.
  Full-backs OVERLAP when a teammate covers behind them and the ball is in the wide channel ahead. Midfielders LATE_RUN
  into the box when the ball is in the crossing zone. Max 2-3 runners at once; others hold.
- triggerRun: the best-placed forward starts a run in behind immediately (overrides holding).
Jobs: use ai/jobs.ts assignJob(s, slot, job, x, z, speedMps, targetSlot) — it only overrides lower-or-equal priority jobs (AiJob order); TAI-07 executeJobs turns the final job into arrival steering. Read team.phase (TAI-06), player.homeX/homeZ (TAI-01), ball, query helpers. Mirror everything by team.dir.
Tests: runners stay onside until the pass (measure with RUL-08 isOffsidePosition or your own check), overlaps only with
cover, late runs into the box on crosses, trigger run works, deterministic. Budget < 0.05 ms/tick.
