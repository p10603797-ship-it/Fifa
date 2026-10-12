# RUL-10 — Substitutions, sending off, playing short, forfeit
Owns: `src/sim/rules/subs.ts`. Spec: BRIEF §5 ("Sending off: the team plays short and the AI reshapes. If the keeper is
sent off, the bench keeper replaces an outfield player; with no substitutions left, an outfield player goes in goal.
A team reduced below 7 players forfeits 3-0. Substitutions: up to 5, at any stoppage, from the pause menu or the
quick-sub prompt. A substituted player cannot return."), invariants (7-11 players, exactly one keeper; substituted
and sent-off players never act), glitch list ("12 players after a substitution", "a team below 7 players not ending
the match", "lands on a sent-off or substituted player").
Implement `subsTick`, `requestSub`, `sendOff`, `checkForfeit`:
- requestSub(team, outSlot, inRoster): validate (slot active on that team, roster BENCH, subsUsed + pending < MAX_SUBS,
  not already queued); queue in team.subOut/subIn. Applied by subsTick at the next stoppage (any restart phase or
  cut-scene, never IN_PLAY): the slot keeps its formation position; copyAttrs from src/sim/init.ts; stamina 1; roster
  statuses (out -> SUBBED_OFF, in -> PLAYING); rosterIdx updated; role/isKeeper updated if a keeper comes on; release
  ctrl if a human controlled the slot (SIM-16 picks a new one); clear any action; emit SUBSTITUTION. A keeper can only
  replace a keeper unless the keeper was sent off.
- sendOff(slot): p.active = 0, act cleared, ctrl released, moved off the pitch (x outside board area or a parking
  spot), roster SENT_OFF, onPitch--; if he was the keeper: bench keeper replaces an outfield player (uses a
  substitution if available; that outfield player is removed) else the outfield player with the best gk attributes
  becomes keeper (isKeeper = 1, keeperSlot updated); team AI reshapes (TAI-01 handles fewer players). Then
  checkForfeit.
- checkForfeit: onPitch < MIN_PLAYERS -> FORFEIT event, match.forfeitTeam; RUL-01 ends the match.
Tests: subs only at stoppages, max 5, cannot return, never 12 players, keeper sub rules, keeper sent off with and
without subs left, forfeit at 6 players, attributes copied, controlled player released.
