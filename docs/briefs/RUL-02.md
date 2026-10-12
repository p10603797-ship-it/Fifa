# RUL-02 — Throw-ins
Owns: `src/sim/rules/throwin.ts`. Spec: BRIEF §5 restarts (2 m distance, 12 s timeout), §9 set pieces on touch
("Throw-ins and goal kicks: tap a teammate, or use the buttons"), §10 throw-in (move along the line: left stick;
short throw: Cross/A; long throw: hold Square/X), glitch list (no offside from throw-ins; no goal direct from a
throw-in; ball out of play during a restart; restart given to the wrong team; players staying off the pitch).
Implement throwInSetup/Tick/Input/Default and `throwInHandler` (ActionKind.THROW_IN):
- Setup: taker = nearest suitable outfield player of the throwing team (not the keeper) to the spot; ball held above
  the taker's head (owner = taker; keep ball at hands height each tick; NOT heldBy, that is keepers only); taker
  stands just outside the touchline facing the pitch; opponents >= THROW_IN_DISTANCE.
- Input (taker's controller, after restart.ready): stick moves the taker a little along the line (limit +-3 m from
  the spot), PASS -> short throw to the selected teammate (selectReceiver of SIM-08 by stick, or gesture tap target);
  LOB held -> long throw (power from hold) — the throw is an applyKick with KickKind.THROW_IN from hands height with
  a throw-speed range 8-18 m/s; set restart.taken. Default: short throw to the best open teammate.
- A goal scored directly from a throw-in without another touch must not count: record the throw (ball.lastKickKind ===
  THROW_IN) — the goal decision belongs to RUL-01: export `noGoalDirectFromThrow(s): boolean` and put a change request
  for RUL-01 to award a goal kick/corner instead. Ensure the CPU and humans both complete throw-ins.
Tests: correct team and spot, taker valid (re-pick if the taker is substituted/sent off — RUL-11 helps), opponents
at 2 m, short/long throws reach teammates, timeout default, no goal direct from a throw-in, no offside flag.
