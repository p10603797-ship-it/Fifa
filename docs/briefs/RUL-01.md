# RUL-01 — Match state machine, clock, periods, kick-off, goals, celebrations
Owns: `src/sim/rules/machine.ts`. Spec: BRIEF §5 (all of it), contracts/transitions.ts, T_RULES.
Why: stability is priority 1; the match flow must never get stuck or reach a nonsensical state.
Implement `rulesTick`, `setPhase`, `setupKickOff`, `kickOffInput`, `displayClock`, CELEBRATE/DEJECTED handlers:
- setPhase(s, to, ev): legal only per LEGAL_TRANSITIONS; illegal -> `throw` when __DEV_BUILD__ (declared global
  boolean; true in tests) else ignore + WATCHDOG event. Sets prevPhase, phaseT = 0, emits PHASE_CHANGE (a=from,b=to).
- rulesTick order: (1) offsideTick (RUL-08), foulsTick (RUL-09); (2) IN_PLAY ball crossing (ball.cross): GOAL ->
  scoring team = team whose dir === crossEnd; own goal if lastTouchTeam is the other team; teams[t].goals++;
  scorer = ball.lastTouch; assist = the scorer's teammate with the latest lastTouchTick before the scorer's touch
  within 600 ticks (or -1); fill match.goal*; emit GOAL + WHISTLE(SHORT); setPhase GOAL. TOUCHLINE -> RUL-11
  awardRestart(THROW_IN, other team of lastTouchTeam, x clamped to +-HALF_LENGTH, z = sign*HALF_WIDTH). GOAL_LINE ->
  CORNER for the attackers if the defending team (team defending that end) touched it last (spot at the corner arc on
  the side of crossZ), else GOAL_KICK for the defenders; (3) restart phases: RUL-11 restartTick then the kind's tick
  (kickOffTick is yours, throwInTick RUL-02, goalKickTick RUL-03, cornerTick RUL-04, freeKickTick RUL-05, penaltyTick
  RUL-06); when restart.taken -> setPhase IN_PLAY (restart.kind = NONE); (4) SHOOT_OUT -> RUL-07 shootoutTick;
  (5) RUL-10 subsTick and checkForfeit (forfeit -> setPhase FULL_TIME with forfeitTeam; final result 3-0 unless the
  winner already leads by more); (6) clock and periods.
- Clock: runs in CLOCK_PHASES only (not in practice mode); periodT++; restart-phase ticks add stoppage to addedT
  (scaled by addedTimeScale, capped at addedTimeMaxMinutes displayed). Period end when periodT >= periodLen + addedT
  AND the ball is out of play or in a neutral area: not during a shot in flight (ball.shotBy >= 0), a cross in flight
  (ball airborne after CROSS/LOW_CROSS/GROUND_CROSS within its flight), an attack in the final 25 m (ball within
  halfEndAttackZone of either goal line with the attacking team in possession or ball loose there), and never in a
  PENALTY phase; extension capped at halfEndExtensionTicks then end anyway (during IN_PLAY or a restart other than
  PENALTY). Emit PERIOD_END + WHISTLE(LONG; FINAL at the end of the match). Period 1 -> HALF_TIME; period 2 ->
  FULL_TIME; ET1 -> HALF_TIME (short break) -> ET2; ET2 -> FULL_TIME.
- PRE_MATCH: lasts 120 ticks (or a human SKIP press edge) then -> config.startPhase (KICK_OFF via setupKickOff(
  firstKickoffTeam) or SHOOT_OUT via RUL-07 shootoutStart).
- Kick-off: setupKickOff(team): both teams in their own halves in formation shape (TAI-01 homePosition or the
  formation data), opponents outside the centre circle, taker on the centre spot facing his attacking direction with a
  teammate beside him, ball on the spot, restart.kind = KICK_OFF via RUL-11 awardRestart-equivalent (fill restart
  yourself or call awardRestart(KICK_OFF,...)); kickOffInput: taker's controller pressing PASS -> SIM-08 startPass
  (KickKind.KICK_OFF, short pass to the nearest teammate); default after timeout. Kick-off with players in the wrong
  half is a glitch: enforce via RUL-11 legalizePositions.
- Cut-scenes: GOAL (goalPhaseTicks) -> CELEBRATION (celebrationTicks; scorer + nearby teammates CELEBRATE with actA =
  variant 0..2 chosen by rng, conceding team DEJECTED) -> REPLAY (config.replaySeconds*60 capped by replayTicks; 0 ->
  skip immediately) -> KICK_OFF by the conceding team, or HALF_TIME/FULL_TIME if the period's time is up. The whole
  sequence never exceeds goalSequenceMaxTicks (12 s). Any HUMAN controller's SKIP press edge (ctrl.buttons & Btn.SKIP,
  not in prevButtons) skips the current cut-scene phase. HALF_TIME (halfTimeTicks or skip) -> swap team.dir, next
  period, period length, kick-off by the team that did not kick off the first half (ET: re-toss via rng). FULL_TIME
  (fullTimeTicks or skip) -> cupRules and level after period 2 -> EXTRA_TIME (break, extraTimeBreakTicks) -> KICK_OFF
  of ET1 (periodLen = a third of a half); level after ET2 -> SHOOT_OUT (RUL-07 shootoutStart); else POST_MATCH
  (finished = 1, winner = higher score or -1 for a friendly draw).
- After a goal or at half time players stay/return on the pitch (celebrations end with players inside the pitch;
  kick-off setup teleports anyone left outside — glitch "stay off the pitch after a throw-in or celebration").
- displayClock: minutes:seconds scaled so periodLen maps to 45:00 (ET periods to 15:00) with period base 0, 45, 90, 105;
  after periodLen show base+45 (or +15) and `added` = added minutes (ceil of addedT scaled), sec continues.
Tests (`tests/scenario/rul-01-*.test.ts`, use tests/harness/scenario.ts): every legal transition reachable, illegal
throws; goal flow timings and skip; own goals; half-end deferral during a shot/cross/final-25-m attack and the 20 s
cap; half time swaps directions; cup ET + shoot-out entry; friendly draw ends; forfeit 3-0; displayClock values;
clock never runs backwards; practice mode never ends; glitch "half ends during a shot in flight", "timer drift".
