# RUL-04 — Corners
Owns: `src/sim/rules/corner.ts`. Spec: BRIEF §5, §9 corners on touch (tap a teammate or a spot in the box, or swipe
from the ball; swipe speed sets height, curved swipe adds curl; PASS plays it short), §10 Corner (lob cross X; short
pass A; aim left stick; target reticle right stick; corner tactics via D-pad -> Command CORNER_* already applied to
team.cornerTactic by TAI-14).
Implement cornerSetup/Tick/Input/Default:
- Setup: ball in the corner arc on the correct side/end, taker = the team's best crosser not needed in the box,
  opponents >= 9.15 m; restart.aimX/aimZ initialised to the penalty spot area; restart.side = sign.
- Input: stick / right stick move the aim reticle inside the box (restart.aimX/Z); LOB -> cross to the aim point via
  SIM-09 startLob(CROSS) with req.hasTarget (power from hold or explicit frame.power), PASS -> short pass to the nearest
  teammate (TAI-13 places one short option), gesture tap teammate/spot or swipe from the ball (FROM_BALL: direction,
  gPower height, gCurve curl). Default: cross to the tactic's zone.
Tests: correct side and team, aim reticle clamped in the box, cross lands near aim, short corner, tactics bias,
timeout default, no offside from corners (RUL-08 reads the phase).
