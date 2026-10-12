# SIM-08 — Passing (ground, driven, dinked) and the generic KICK action
Owns: `src/sim/kicks/pass.ts`. Spec: BRIEF §6 Passing; T_PASS; §9/§10 rows for PASS, driven pass (R1+PASS), lofted
ground pass (PASS,PASS = dinked), pass and go (L1+PASS).
Implement:
- `kickHandler` (ActionKind.KICK, used by passes, lobs, crosses, through balls, clearances, skill touches): phases
  wind-up (>= T_PASS.windup ticks), charging (while p.actCharging the resolver raises p.actPower; cap the wait at
  powerFillTicks + 20), contact (at p.actContact once not charging: check the ball is in reach — owner or within
  ~1.2 m and below 0.8 m — then KICK_SOLVERS[p.actKick] (src/sim/actions/registry.ts) -> applyKick with the launch;
  set actDone), recovery. If the ball is gone at contact (tackled away), whiff and recover. Movement: slowed
  (DIRECT intent scaled ~0.4) during wind-up, LOCKED briefly at contact.
- `startPass(s, slot, kind, req, ev)` for GROUND_PASS, DRIVEN_PASS, DINKED_PASS, KICK_OFF: player free and has (or is
  about to receive) the ball; store dir/target/flags in act fields; contact tick = windup.
- `solveGroundPass`: receiver = req target slot (gesture/receiver lock) or `selectReceiver`; target point = the
  receiver's predicted position when the ball arrives (lead a moving receiver); speed from power and distance
  (groundPassSpeed from SIM-01 with assisted arrival speed; Manual assistance: power alone sets speed, direction from
  the stick only); dinked = small loft (T_PASS.dinkedAngle); driven = faster, flatter. Error (`kickError`): grows
  with low shortPassing/longPassing (range), body facing away from target, pressure, full sprint, weak foot
  (attrs.weakFoot vs foot used), extreme power, low stamina; uses s.rng. Sets launch.target and tx/tz so
  ball.passTarget drives the receiver (TAI-14 RECEIVE job) and auto-switching (SIM-16).
- `selectReceiver(s, slot, dirX, dirZ, power, assist, lofted)`: candidates in a cone around the stick (coneHalfAngle,
  wider when Assisted), score by alignment, distance vs power-implied distance, openness (opponents near the lane and
  the receiver), and progress; Semi narrows the cone; Manual returns -1.
- Pass and go (ReqFlag.PASS_AND_GO): at contact set team.passGoSlot = passer, team.passGoT = 120; TAI-03 makes the run.
Tests: receiver selection (direction, power, openness), lead passes to moving receivers arrive within 1.5 m,
reference speeds (9-22 m/s), error grows with pressure/weak foot, dinked passes clear a defender's legs, kick whiffs
safely, charging/release timing, determinism.
