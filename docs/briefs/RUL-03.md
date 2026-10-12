# RUL-03 — Goal kicks
Owns: `src/sim/rules/goalkick.ts`. Spec: BRIEF §5 restarts, §9 ("Throw-ins and goal kicks: tap a teammate, or use the
buttons"), §10 free-kick-style aim/pass/lob mapping applies; §8 set-piece camera (behind the taker) is GFX-15's.
Implement goalKickSetup/Tick/Input/Default:
- Setup: ball on the goal-area line (6-yard box edge) on the side the ball went out (z = sign(crossZ)*4..9 m),
  taker = the keeper (or a defender if none), opponents outside the penalty area until the ball is played.
- Input: aim with the stick; PASS -> short ground pass (SIM-08 startPass, KickKind.GROUND_PASS with ReqFlag.SET_PIECE)
  or LOB -> long kick (SIM-09 startLob LOB_PASS/HIGH_LOB with power); gesture tap a teammate. Default: AI choice (short
  if a defender is open, else long toward a target man) — reuse TAI-09 laneSafety when available.
- No offside from goal kicks (RUL-08 checks the phase at kick time).
Tests: setup legality, correct team, short and long goal kicks, timeout default, opponents kept out of the area.
