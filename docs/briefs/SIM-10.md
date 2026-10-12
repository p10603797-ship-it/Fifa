# SIM-10 — Through balls
Owns: `src/sim/kicks/through.ts`. Spec: BRIEF §6 ("A through ball leads the runner into space, weighted so he
meets it in stride."), §9 THROUGH tap/hold, swipe up = lobbed through, double-tap = dinked through; §10 Triangle/Y,
L1+Y lobbed, Y,Y lofted.
Implement `startThrough`, `solveThrough`, `throughLeadPoint`:
- Pick the runner: explicit target or SIM-08 selectReceiver biased to players running forward / beyond the
  defensive line; lead point = where the runner (at his current velocity, sprinting, via SIM-04 ticksToReach and the
  ball's travel time from SIM-01 groundPassSpeed/solveLaunch) meets the ball in stride, in space away from
  defenders and the keeper, kept onside at the moment of the pass isn't your job (RUL-08 judges), clamped inside the
  pitch; power scales the lead distance. Ground, lobbed (over the line) and dinked variants.
Tests: the runner reaches the ball within 1 m of his stride (no stopping) in open scenarios; the lead avoids the
keeper's claim zone when possible; lobbed through clears a defender; determinism.
