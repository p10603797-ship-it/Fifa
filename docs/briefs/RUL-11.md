# RUL-11 — Restart flow, legal positions, watchdog
Owns: `src/sim/rules/restart.ts`, `src/sim/rules/watchdog.ts`. Spec: BRIEF §5 (each restart: a taker, a position for
every player, a minimum distance for opponents (9.15 m; 2 m at throw-ins) and a timeout; if a human does not act
within 12 s the game takes a sensible default), §5 Watchdog, glitch list Restarts lines (taker missing or sent off;
opponents inside the required distance blocking forever; ball out of play during a restart; restart given to the
wrong team; two restarts queued; kick-off with players in the wrong half).
Implement:
- awardRestart(kind, team, x, z): ignore if a restart of any kind is already pending this tick (never two queued);
  clear advantage when appropriate; fill match.restart (t = 0, ready = 0, taken = 0, timeoutT, wall cleared); ball
  placed at (x, BALL_RADIUS, z) still, owner/heldBy cleared, shotBy cleared, passTarget cleared; every player's action
  interrupted (endAction(...,1)) except fallen players finish; emit RESTART_AWARDED + WHISTLE(SHORT); call the kind's
  Setup (RUL-02..06, RUL-01 setupKickOff for KICK_OFF); setPhase(kind phase).
- restartTick: t++; during the setup delay players walk to their set-piece spots (TAI-13 jobs); at restartSetupTicks:
  legalizePositions (teleport anyone illegal: opponents inside the required distance, kick-off halves/centre circle,
  penalty area exclusions, taker on the ball), taker's act = SET_PIECE (or THROW_IN), ready = 1; while ready keep
  opponents out by pushing them (no teleport mid-view unless they stay illegal > 1 s); re-pick the taker if he became
  invalid (sent off/substituted/inactive); human taker timeout -> the kind's Default; CPU taker acts via its frame
  (TAI-13) — if a CPU taker has not acted after 4 s, call Default (safety net, logged).
- SETPIECE_INPUT routing table (keep), SET_PIECE handler (taker waits facing the target; ends when restart.taken).
- Ball out of play during a restart before it is taken: re-place it.
- watchdogTick: phase past T_RULES.phaseMaxTicks (0 = unlimited) -> force the next legal step (e.g. take the restart's
  Default; end a cut-scene); a player in an action longer than actDur + 30 ticks -> end it; IN_PLAY with ball.idleT >=
  ballIdleTicks (8 s untouched) or unreachable (outside the pitch but not crossed, stuck in the net while IN_PLAY,
  resting on the net roof) -> award the nearest sensible restart (throw-in/goal kick/free kick to the team that did not
  touch last, at a legal spot); emit WATCHDOG(reason) and match.watchdogCount++.
Tests (named after glitch lines): taker missing or sent off, opponents blocking forever, ball out of play during a
restart, wrong team, two restarts queued, kick-off wrong half, each watchdog reason fires and recovers to a legal
state, no watchdog in normal flows.
