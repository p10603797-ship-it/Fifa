# TAI-07 — Loose-ball chaser and arrival steering
Owns: `src/ai/steer.ts`. Spec: BRIEF §7 ("Loose balls: exactly one player per team is assigned to chase, chosen by
arrival time and re-evaluated with hysteresis. Never two teammates colliding over it, and never nobody." "Steering uses
arrival behaviour, slowing into the target, so players stop on a spot instead of orbiting or jittering around it."),
invariant "Exactly one loose-ball chaser per team while the ball is free", glitch list Players lines.
Implement `assignChaser`, `executeJobs`, `arrive`:
- assignChaser: while the ball is loose (owner === -1, not held, IN_PLAY): compute for each active outfield player (and
  the keeper only if GKP says he is going) the earliest interception tick with the ball (SIM-01 predictBall once per
  tick (scratch), SIM-04 ticksToReach to each sample point; pick the first sample a player can reach in time) and choose
  the fastest; keep the current chaser unless the new one is faster by chaserHysteresisTicks and the current one held it
  >= chaserMinTicks; a human-controlled player near the ball counts as his team's chaser (no AI teammate also chases);
  set team.chaser and CHASE_LOOSE job at the interception point (speed: sprint). When the ball is owned, team.chaser = -1.
  Exactly one chaser per team while loose — always valid.
- executeJobs(s, team): for every job-driven player (ai/jobs isJobDriven), unless his action locks movement
  (moveMode LOCKED or act in a non-moving action), set the intent: ARRIVE at (tgtX, tgtZ) with tgtSpeed (sprint when far
  from target and the job is urgent: CHASE_LOOSE, PRESS, RECOVER, RUN_IN_BEHIND, RECEIVE), lookAt the ball when holding
  position/marking (so players face play), wantSprint accordingly; small dead zone so stationary targets do not cause
  micro-movement; then jobs.finalizeJobT.
- arrive(s, slot, x, z, speed): helper used by keepers and others.
Tests: exactly one chaser per team for many random loose-ball scenarios, hysteresis prevents flip-flop, human counts as
chaser, players stop on spots (no orbit/jitter over 10 s), moving targets followed smoothly, deterministic, budget
(< 0.1 ms/tick including predictBall).
