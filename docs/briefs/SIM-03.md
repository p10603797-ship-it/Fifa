# SIM-03 — Pitch geometry, out of play and goal detection
Owns: `src/sim/pitch/geometry.ts`. Spec: BRIEF §5 ("Out of play and goals need the whole ball over the whole
line. Test them as a swept segment between ticks so a fast ball cannot skip the line."), §4 units, §14 "Goals".
Why: a goal not given, given twice, or given through the side netting destroys trust instantly.

Implement (keep exports; the Wave 0 queries are a baseline — verify/fix them):
- `detectCrossing(s, x0,y0,z0, x1,y1,z1)`: if s.ball.cross is already set this tick, return NONE. A crossing happens
  when the ball CENTRE goes beyond a line by BALL_RADIUS (whole ball over the whole line). Goal lines are x =
  +-HALF_LENGTH: find where the segment crosses the plane x = end*(HALF_LENGTH + BALL_RADIUS); it is a GOAL if at that
  point |z| < GOAL_HALF_WIDTH (between the inner faces of the posts; SIM-02 keeps the ball out of the posts) and
  y < GOAL_HEIGHT (under the bar) and the ball came from the field side; otherwise GOAL_LINE (out). Touchlines: |z|
  beyond HALF_WIDTH + BALL_RADIUS -> TOUCHLINE. Fill ball.cross/crossX/crossZ/crossEnd. A ball already in the net
  (inNet) must not produce a second GOAL; a ball entering the goal volume from the side or top (not through the goal
  mouth plane) is GOAL_LINE, never GOAL. Document the geometry in a comment.
- Queries: inPenaltyArea, inGoalArea, inCrossingZone, onPitch, insideGoal, clampToPitch (+ any helpers you add:
  e.g. `distToGoalMouth`, `isInOwnHalf(x, dir)`, `penaltySpot(end)`), exact to contracts/constants.
Tests (`tests/unit/sim-03-*.test.ts`): table-driven crossings at every speed (up to 40 m/s) and angle, including
grazing the post inside, bouncing on the line, curling back, crossing exactly at the corner flag, a ball resting on
the line (not out), and "goal given through the side netting" (must be out). Determinism; zero allocation.
