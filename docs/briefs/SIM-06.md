# SIM-06 — Possession and dribbling
Owns: `src/sim/players/possession.ts`. Spec: BRIEF §6 Possession and dribbling; T_DRIBBLE; glitch list "Ball stuck".
Why: dribbling is the core of control feel; the ball must stay its own physics object that can be poked away.
Implement `dribbleTick` (runs LAST in the contact phase) and `canTouchBall`:
- Owner dribbling: when the owner is free or jogging/sprinting, give the ball touches ahead of his feet in his
  movement direction: touchAheadJog at a jog, touchAheadSprint at a sprint (heavier, so it can be poked away
  between touches), touchAheadClose when strafing/jockey-dribbling or near opponents/standing; touch interval
  from T_DRIBBLE; touch quality from dribbling/ballControl/agility/stamina (SIM-04 staminaFactor). Touches use
  applyKick with KickKind.DRIBBLE_TOUCH? NO — dribble touches must not reset pass/offside data: use recordTouch +
  set ball velocity directly (document why), keep ball.owner. Turning sharply = extra small touch.
- While the owner is in a KICK/SHOT/SKILL wind-up, keep the ball controlled at the kicking spot (~0.5 m ahead of
  the feet, slowing it) so the contact tick finds it in reach.
- Loose ball pick-up: if no contact happened this tick (ballTouchedThisTick false), the ball is loose, slow enough
  (< ~6 m/s) and low (< controlHeight), the nearest eligible player within controlRadius takes possession
  (takePossession). Eligible: active, not stunned/fallen, noTouchT expired, not a keeper holding... Ties broken
  deterministically (closest, then slot).
- Lose possession when the ball is beyond loseRadius from the owner, or the owner is stunned/fallen/in a non-ball
  action, or a keeper takes it into hands (heldBy).
- A ball that sits motionless between two players or under a fallen player must get resolved (someone takes it,
  or it squirts out deterministically) — regression tests "ball stuck between two players" and "under a sliding
  player".
Tests: touches ahead at jog vs sprint, poke-away window exists at sprint, pick-up rules, possession loss, no stuck
ball, deterministic ties. Budget < 0.05 ms/tick.
