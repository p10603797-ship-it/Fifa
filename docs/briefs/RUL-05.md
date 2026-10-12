# RUL-05 — Free kicks and walls
Owns: `src/sim/rules/freekick.ts`. Spec: BRIEF §5 (all free kicks direct; 9.15 m), §7 set pieces ("a wall of 2-5 by
distance and angle"), §9 free kicks on touch (wide: tap/swipe like corners; at goal: swipe from the ball toward goal,
speed sets power and height, curve sets curl, dotted preview of the first part of the flight), §10 free kick (aim:
left stick; curl/dip: right stick; shoot/finesse/chip B / R1+B / L1+B; ground pass A; lob or cross X; choose the
taker R2) and defending (wall jump Y, wall charge A, move wall L2/R2).
Implement freeKickSetup/Tick/Input/Default and `wallJumpHandler` (ActionKind.WALL_JUMP):
- Setup: ball at the foul spot (clamped inside the pitch, outside the goal area for attackers), taker = best
  free-kick taker (curve+shotPower+longShots for shooting range; passing otherwise), "choose the taker" cycles
  candidates on SPRINT press. Wall when within ~35 m of goal and central enough: count 2-5 by distance/angle, placed
  9.15 m from the ball on the ball-goal line covering the near post side (restart.wall/wallCount/wallX/wallZ), chosen
  defenders (not the keeper) — TAI-13 positions others; GKP-06 positions the keeper relative to the wall.
- Attacking input: stick aims (restart.aimX/Z on the goal mouth or a pitch point), right stick (ax/az) sets curl
  (restart.aimCurve) and dip; SHOOT -> SIM-11 startShot(FREE_KICK_SHOT) with req.curve and power (hold or
  frame.power from a swipe), MOD_R+SHOOT finesse, MOD_L+SHOOT chip; PASS -> short pass; LOB -> lob/cross. Touch swipe
  from the ball (gesture SWIPE/CURVED_SWIPE with FROM_BALL) -> shot with power/height from gPower and curl from
  gCurve. Expose `previewFlight(s, out: BallPrediction)` for the touch dotted preview (TCH-06/GFX-13) using SIM-01
  predictBall from the current aim.
- Defending input: THROUGH -> wall jumps (WALL_JUMP action on wall members: jump ~0.5 s, blocks higher balls), PASS
  -> wall charge (wall steps toward the ball after the kick), SHIELD/SPRINT -> move the wall sideways.
Tests: wall size by distance/angle, 9.15 m kept, taker choice cycling, shot/curl/chip paths clear or hit the wall as
physics says, wall jump blocks, preview equals actual flight start, default after timeout, correct team.
