# SIM-05 — Body contact and shielding
Owns: `src/sim/players/bodies.ts`. Spec: BRIEF §6 Players ("Player bodies collide as soft circles weighted by
strength. Shielding puts the body between ball and opponent."), §14 invariants (no overlap > tolerance > 1 s),
glitch list "Players: run in place against each other", "Ball stuck: between two players".
Implement:
- `bodyContactTick`: soft circle collisions for all active pairs (radius T_PLAYER.bodyRadius scaled by height):
  positional separation weighted by strength (stronger moves less), velocity damping along the contact normal;
  hard separation if overlap > overlapTolerance; deterministic pair order. Detect two players pushing head-on and
  running in place: slide them around each other (tangential nudge, deterministic side choice).
  Shoulder-to-shoulder contact when running alongside (emit BODY_CONTACT, let SIM-14 shoulder challenges use it).
- SHIELD action handler + shielding behaviour: when the ball owner has p.shielding (L2 held; the resolver sets the
  intent), he keeps his body between the ball and the nearest opponent (lookAt toward the opponent, ball kept on the
  far side by SIM-06), moves at shieldSpeedFraction; strong shielders hold opponents off (opponent pushed back,
  can't reach the ball easily — expose `shieldBlocks(s, owner, challenger): boolean` for SIM-06/SIM-14).
- Keepers inside their goal area get priority (attackers are pushed rather than the keeper).
Tests: separation, strength weighting, no persistent overlap in crowded penalty-area scenarios (20 players in the
box for 10 s), no run-in-place deadlock, shielding keeps the ball away from a challenger. Budget < 0.1 ms/tick.
