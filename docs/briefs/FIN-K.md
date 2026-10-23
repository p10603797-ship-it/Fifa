# FIN-K — Final fixes: KNOWN_ISSUES lines that affect match state or input (DoD 8, BRIEF §14)

Area (exclusive for this run): `src/sim/**`, `src/ai/**`, `src/contracts/tuning.ts`, docs/TUNING.md, docs/KNOWN_ISSUES.md
(the Match engine section only), sim/AI tests. FIN-A works in render/audio/tools/tests in parallel; FIN-P (sim/AI perf)
runs after you on your tree.
BRIEF §14: only cosmetic issues may be listed in KNOWN_ISSUES.md; anything affecting match state or input is fixed with a
regression test. The SGN-06 audit flagged these lines of the "Match engine" section:
1. A goal-line free-kick wall member whose slot is where the keeper stands is pushed a body-width off his slot, leaving a
   gap at the end of the wall (src/sim/rules/freekick.ts): place the wall so no member's slot collides with the keeper
   (shift the wall or the keeper's set position), with no overlap and no gap.
2. At free kicks within 35 m, "choose the taker" swaps the two players instantly (a visible teleport under the set-piece
   camera): the chosen taker walks/runs to the ball (the restart waits, capped, as RUL-11's walked set-up does).
3. If the 12 s restart timeout fires while a newly chosen taker is still running in, he is placed on his spot: the
   timeout must not teleport a taker who is on his way; extend (capped) or take the restart from where he is legally.
4. A taker whose kick goes a different way from his line-up side-steps round the ball in a frozen kick pose for 6-14
   ticks before the strike (src/sim/kicks/kickCommon.ts set-piece line-up, T_KICK.takerLineUpMaxTicks): the strike must not
   be delayed by a re-line-up after the input; strike from the current approach (adjust the approach angle within limits)
   so input-to-contact at set pieces stays within the normal kick timing.
5. A dribbler who turns sharply and passes draws the ball through his own body to the kicking spot
   (src/sim/players/possession.ts / kick reach): a kick must start from where the ball is (turn-and-kick, or the ball moves
   round the body, never through it).
Each fix gets a named regression test that fails without it. Behaviour changes: run the area tests, a 150-match
Professional soak with --enforce all (bands must stay inside §7 with margin), the ladder top pairs (2 seeds x 100) and a
60-match fuzz; report the numbers. Remove the fixed lines from KNOWN_ISSUES.md. Work economically (usage limits).
