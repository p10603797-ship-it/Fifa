# RUL-07 — Penalty shoot-out
Owns: `src/sim/rules/shootout.ts`. Spec: BRIEF §5 ("five each, then sudden death, with every player taking one
before anyone repeats"), §11 Shoot-out mode (straight to penalties), §9/§10 penalty controls (same as RUL-06).
Implement shootoutStart/Tick/Input with match.shootout state:
- Start: active = 1, team to kick first by rng, kick order per team from active players (best takers first, keeper
  last), keepers on their lines at one end (choose the end with dir handling), others in the centre circle.
- Per kick sub-states (sub/subT): SETUP (place kicker on the spot, keeper on the line) -> AIM (inputs like RUL-06:
  kicker aims/shoots; defending keeper can choose a dive) -> FLIGHT (ball live until it stops, goes out, is saved
  and held, or enters the net; no rebounds count) -> RESULT (record 1 scored / 2 missed in kicks[], goals++, emit
  SHOOTOUT_KICK) -> next team. After 5 each, decide early when unreachable; then sudden death pairs. Every eligible
  player kicks once before anyone repeats (order/order2 + next). Winner -> setPhase POST_MATCH via RUL-01's
  setPhase, match.winner. CPU kickers act through their InputFrames (TAI-13 cpuSetPiece handles SHOOT_OUT);
  humans time out to a default kick after 12 s.
Tests: alternation, early decision (3-0 after 3 each), sudden death, rotation order, no rebound goals, CPU vs CPU
shoot-out completes, human timeout, POST_MATCH reached with a winner.
