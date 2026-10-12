# SIM-04 — Locomotion and stamina
Owns: `src/sim/players/locomotion.ts`. Spec: BRIEF §6 Players; T_PLAYER. Replace the Wave 0 baseline.
Why: control feel (priority 3). Movement must feel responsive and weighty, with no jitter or orbiting.

Implement:
- `locomotionTick`: for every active player, desired velocity from the intent: DIRECT (ix, iz scaled: partial stick
  = jog proportionally, full stick = jog speed jogFraction*top; wantSprint = top speed), ARRIVE (arrival steering
  to tgtX/tgtZ capped at tgtSpeed, decelerating smoothly so the player STOPS within arriveStop without overshoot or
  oscillation even when the target moves slowly), STOP (brake), LOCKED (friction only). Acceleration from attrs.accel,
  deceleration T_PLAYER.decel; turn rate that tightens at low speed (turnRateSlow..turnRateFast, agility scaling,
  sprint wider turns); facing rotates toward the movement direction at the turn rate (dmath/vec rotateToward2),
  except lookAt = 1 (jockey/strafe/shield/contain): face (lookX, lookZ) and move sideways/backward at
  jockeySpeedFraction with better turning. Set sprinting/jockeying/shielding effective flags.
- Stamina: drain while sprinting (scaled by the stamina attribute), slow drain jogging, slow recovery otherwise;
  below staminaLowThreshold cut speed, acceleration (and expose `staminaFactor` for SIM-08/11 accuracy).
- Never pass the boards; never enter the goal frame/net volume (treat posts/net as obstacles: keep players out of
  the net box behind each goal line, except the keeper may stand on the line).
- `ticksToReach(s, slot, x, z)`: arrival-time estimate including current velocity, turning and acceleration
  (used by chasers, receivers, keepers, AI; must be monotonic in distance and cheap). Also export
  `ticksToReachAtSpeed` if useful.
- `topSpeedFor/accelFor`: keep (init uses them).
Tests (`tests/unit/sim-04-*.test.ts`): top speeds 7.0-9.6 by attribute; jog ~60%; 0->top in a believable time;
turn radius larger when sprinting; arrival stops without orbit/jitter ("Players: orbit or jitter around a target"
regression) for static and slowly moving targets; stamina drains/recovers and slows the player; boards and goal
frame respected ("walk through the goal frame or net"); ticksToReach within 15% of the simulated time.
Budget: < 0.15 ms per tick for 22 players.
