# GKP-01 — Keeper positioning
Owns: `src/sim/keeper/positioning.ts`. Spec: BRIEF §6 Goalkeepers ("Positioning: on the arc between ball and goal
centre, with depth adjusted for distance and angle."); T_GK.depthFar/depthNear; glitch "Keeper carries it over his
own line".
Implement `keeperPositioning(s, team, ev)` and `idealKeeperSpot`:
- Ideal spot: on the line from the goal centre toward the ball (or the predicted ball position a few ticks ahead),
  at a depth that grows with ball distance (depthNear close, depthFar far) and shrinks at tight angles (stay near the
  near post), clamped inside the goal area/penalty area, never behind the goal line (x stays >= 0.3 m inside the
  field from the line). Positioning attribute adds accuracy (low = small deterministic offset/lag). React to the ball
  carrier's shooting angle; step across with the ball.
- Movement via ai/steer.ts arrive() (TAI-07; if still a stub set p.moveMode = ARRIVE + tgtX/tgtZ/tgtSpeed directly),
  face the ball (lookAt), shuffle sideways (jockey-like) rather than turning his back.
- Only when the keeper is free (no action), not human-controlled, ball not in his hands.
Tests: spot geometry for central/wide/close/far balls, never behind the line, near-post coverage at tight angles,
smooth movement (no jitter), both ends and both attack directions.
