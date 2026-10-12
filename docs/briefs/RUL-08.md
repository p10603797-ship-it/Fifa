# RUL-08 — Offside
Owns: `src/sim/rules/offside.ts`. Spec: BRIEF §5 ("Offside is on by default and can be switched off. Judge it at the
moment a teammate plays the ball, against the second-last defender, the ball and the halfway line. Give the
attacker the benefit of a small margin. No offside from goal kicks, throw-ins or corners. Flag it only when the
offside player becomes involved. Restart with a free kick where he was."), glitch list Offside lines.
Implement `offsideTick` (runs first in rulesTick) and `isOffsidePosition`:
- When ball.lastKickTick === s.tick and the kick was by a player (lastKickBy >= 0) of team T, and config.offside, and
  the phase AT THIS TICK is IN_PLAY or FREE_KICK (not THROW_IN, GOAL_KICK, CORNER, KICK_OFF, PENALTY) and the kind is a
  pass/shot/header (not a dribble touch): snapshot flags = bitmask of T's players (excluding the kicker) in an offside
  position: in the opponents' half (beyond halfway by the margin), nearer the opponents' goal line than both the ball
  and the second-last defender (query.secondLastDefenderX of the defending team) by more than offsideMargin.
- Involvement: a flagged player touches the ball (ball.lastTouch === flagged slot and lastTouchTick === tick), or
  receives/heads it, or challenges an opponent for it (a ChallengeRecord with tackler flagged), or is the intended
  receiver arriving within 2 m when the ball reaches him -> offside: emit OFFSIDE (a = slot, x/z = his position),
  award a FREE_KICK to the defending team at his position (RUL-11 awardRestart), clear flags.
- Clear flags when the defending team plays the ball deliberately, when any opponent gains possession, when another
  pass is made (new snapshot), or when the ball goes out.
Tests (table-driven, `tests/scenario/rul-08-*.test.ts`): level = onside; margin benefit; own half never offside; behind
the ball onside; no offside from throw-in/goal kick/corner; offside only when involved; restart spot and team;
config.offside = 0 disables; regression names from the glitch list.
