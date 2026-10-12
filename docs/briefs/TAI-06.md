# TAI-06 — Team phase and transitions
Owns: `src/ai/transition.ts`. Spec: BRIEF §7 (team phase build-up/attack/defend/transition; "make recovery runs after
losing the ball"; counter-attack style).
Implement `updateTeamPhase` (team.phase/phaseT, possT/lostT from possession changes: in possession in own third ->
BUILD_UP, further -> ATTACK, just won the ball -> TRANSITION_ATTACK for T_AI.transitionTicks if space ahead, just lost ->
TRANSITION_DEFEND, without the ball -> DEFEND; restart phases -> SET_PIECE) and `assignTransition` (TRANSITION_ATTACK:
2-3 forwards break forward at sprint into space (RUN_IN_BEHIND/SUPPORT jobs ahead of the ball), TRANSITION_DEFEND:
players behind the ball sprint back (RECOVER jobs) to goal-side positions on the ball-goal line). Counter style teams
transition faster. Jobs: use ai/jobs.ts assignJob(s, slot, job, x, z, speedMps, targetSlot) — it only overrides lower-or-equal priority jobs (AiJob order); TAI-07 executeJobs turns the final job into arrival steering. Read team.phase (TAI-06), player.homeX/homeZ (TAI-01), ball, query helpers. Mirror everything by team.dir.
Tests: phase classification table, counters after interceptions, recovery runs get goal-side within N s, deterministic.
