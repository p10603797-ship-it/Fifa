# QF-1 — Sim core and rules: QA-01..QA-10, QA-11 (possession hand-over), FIX-01, FIX-02

Area (exclusive for this wave): `src/sim/**` except `src/sim/keeper/**` and `src/sim/kicks/**` (QF-2) — `src/sim/control/**` is shared with QF-3 for input-resolution defects (small Edit-tool edits only, re-read before editing); `src/contracts/tuning.ts` T_BALL, T_PHYS,
T_RULES, T_DRIBBLE blocks only (document in docs/TUNING.md under your id).
Charter (BRIEF §5, §6 Ball/Possession, §14 rules tests and glitch list: ball stuck, goals, players overlap / through the
frame, restarts, offside, discipline, clock):
- QA-01 ball-stuck scenarios (between two players, under a slider, on the net roof, behind the goal, against post or
  board, resting on the goal line) — each must resolve within a bounded time.
- QA-02 goal-line and touchline detection at every speed and angle (swept tests, bounce-out goals, side netting).
- QA-03 post/bar/net collisions and tunnelling at max shot speed.
- QA-04 offside table (throw-in, goal kick, corner, own half, level, second-last defender, keeper out, rebounds).
- QA-05 fouls, advantage (always resolves), cards to the right player; QA-06 every restart (positions, timeouts, wrong
  team, queued restarts, ball out during restart, kick-off halves); QA-07 penalties and shoot-out order/sudden death;
  QA-08 subs, send-offs, playing short, keeper sent off, below 7 ends the match, never 12 players; QA-09 clock, half
  end with a shot in flight, extra time, no drift; QA-10 player overlap and goal-frame penetration;
  QA-11 dribbling first touch and possession hand-over (one owner, no ping-pong).
Run the invariant-enforced soak on your fixes (`tools/soak.ts --enforce all`, a few hundred matches) and fuzz (100).
From INT-A / INT-C (Wave 2): fouls 5.5 per match below the 6-16 band — RUL-09 per-kind foul bands limit baseFoulChance;
refit them so fouls reach the band. T_BALL.bounceFriction 0.12 makes long balls skip too far (INT-A proposes ~0.2 and a
refit of SIM-08's dinked-shot model test). A foot kick (GROUND_PASS) sometimes starts with the ball 1.95 m away and
0.76 m high (1-2 per 1500 ticks, seed 20261014, tests/scenario/int-c-anim-live.test.ts outOfReach): require the ball
within reach at contact or retarget. Practice hooks run in the app tick: move preparePracticeState into sim/init and
practiceRulesTick into sim/step after rulesTick (then tell QF-5 / the lead to make app stepWithModes a plain step).
Pre-existing failing tests in your area (fix the code or, where the test is wrong, the test, and say which): see
reports/suite-wave2-failures.md (lead) — rul-01/02/03/04/11, sim-05 and others.
(If reports/suite-wave2-failures.md is not there yet, the lead's full-suite run is still going: run your area's test
files yourself to list failures.)
