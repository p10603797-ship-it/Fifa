# RUL-09 — Fouls, advantage, cards, send-offs
Owns: `src/sim/rules/fouls.ts`. Spec: BRIEF §5 (fouls can be switched off for arcade mode; classify from who touched
the ball first, contact direction, closing speed and whether it was a slide; outcomes clean / foul / foul+yellow /
foul+red / penalty inside the area; advantage up to 3 s then wave away or bring back; second yellow = red), §7 target
fouls per match 6-16, glitch list Discipline lines ("advantage that never resolves; card shown to the wrong player").
Implement `foulsTick` (consumes match.challenges each tick, clearing records), `classifyChallenge`, `showCard`:
- Classification (deterministic, may use s.rng): ballFirst = 1 and not reckless -> CLEAN; otherwise foul probability
  from kind (slide > hard > stand > push/pull > shoulder (rarely)), fromBehind, closingSpeed vs recklessSpeed, and
  T_FOUL.baseFoulChance; yellow for reckless (high speed / from behind slide), red for serious foul play (very high
  speed from behind with no ball, slideFromBehindRed) or denying an obvious goal-scoring chance (last defender fouls a
  carrier through on goal). config.fouls = 0 -> everything CLEAN (no cards), but body physics still apply.
- Penalty: foul by a defender inside his own penalty area (victim position) -> PENALTY restart (RUL-11 awardRestart).
- Advantage: if the fouled team still has the ball (or a teammate gets it within advantageKeepTicks) in a good
  position (attacking half or promising), set match.advantage (emit ADVANTAGE a=1); if possession is kept for
  advantageTicks -> wave away (a=0); if lost within the window -> bring back: FREE_KICK at the foul spot (a=2). The
  fouled team's human can cancel advantage (SHIELD+SPRINT press edge -> bring back). Cards are shown at the next
  stoppage or immediately when brought back.
- Cards: showCard(slot, YELLOW) -> p.yellow = 1, CARD event; a second yellow -> SECOND_YELLOW event + RUL-10 sendOff;
  RED -> sendOff. Cards always go to the offender recorded in the challenge.
- Emit FOUL (a offender, b victim, c outcome, d in-area). Stunned victim: SIM-14 knockDown(victim, FALLEN) when fouled.
Tests: table of challenges -> outcomes; arcade mode; penalty in area vs free kick outside; advantage wave/bring back
and never unresolved; second yellow; correct player carded; determinism; fouls/match rate sanity over seeds.
