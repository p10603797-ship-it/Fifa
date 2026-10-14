# QF-1 — Sim core and rules: QA-01..QA-10, QA-11 (possession hand-over), FIX-01, FIX-02

Area (exclusive for this wave): `src/sim/**` except `src/sim/keeper/**`; `src/contracts/tuning.ts` T_BALL, T_PHYS,
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
