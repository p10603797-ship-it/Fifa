# TAI-14 — Tactics, focus, commands and receiver assist
Owns: `src/ai/tactics.ts`. Spec: BRIEF §10 Tactics (quick tactics: offside trap, team press, extra striker, get in the box;
tactical focus default/defending/attacking; quick substitution; corner tactics), §11/§12 pause menu tactics, §6 Passing
("The intended receiver moves to collect on his own until the user steers him.").
Implement `applyCommand(s, team, cmd, arg, ev)` (toggle quick tactics, set focus, set formation (re-map formIdx/roles
for the 11 slots sensibly, keeping the keeper), corner tactics -> team.cornerTactic, emit TACTIC), `tacticsTick` (expire
temporary tactics if any; adjust team-level parameters other modules read — prefer state fields that exist; document
what each tactic changes for TAI-01/04/05 (they read team.offsideTrap/teamPress/extraStriker/getInBox/focus)), and
`receiverAssist(s, team, ev)`: when ball.passTarget is our player and he is job-driven, give him a RECEIVE job to meet
the ball at the best interception point (SIM-01 predictBall + SIM-04 ticksToReach), moving toward the ball to receive
rather than waiting; stop when a human controls him and moves the stick (SIM-16/SIM-15 will have switched).
Tests: each command changes state, formation change keeps one keeper and valid roles, receiver meets passes earlier than
standing still, determinism.
