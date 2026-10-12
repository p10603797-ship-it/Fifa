# SIM-02 — Ball contact
Owns: `src/sim/ball/contact.ts`. Spec: BRIEF §6 Ball, §14 glitch list "Ball stuck", "Goals"; T_BALL.
Why: goals, posts, bar, nets and bounces are the moments players remember; tunnelling or a ball stuck in a net is a
match-breaking glitch.

Implement (keep exports `ballPhysicsStep`, `ballStepTick`, `ballTick`):
- `ballStepTick(b, ev)`: one tick as N equal substeps where N = ceil(|v|*DT / T_BALL.maxStep) (>= 1); each substep:
  airborne -> SIM-01 ballAirStep; ground contact -> bounce with restitution on vy, tangential friction and spin
  friction (spin converts partly into roll); rolling -> rollDecel + rollDamping, come to rest below restSpeed;
  collisions with: posts (vertical cylinders radius POST_RADIUS at z = +-GOAL_HALF_WIDTH on both goal lines,
  height GOAL_HEIGHT) and crossbar (horizontal cylinder), using sphere-vs-cylinder with restitution postRestitution
  (emit POST with a=end, b=0 post / 1 bar); the net volume behind each goal line (depth GOAL_DEPTH, width
  GOAL_WIDTH, height GOAL_HEIGHT): once the ball is inside it is absorbed (netDamping) and kept inside (soft walls),
  set b.inNet = end and emit NET once; from OUTSIDE the side netting and roof deflect the ball
  (netOutsideRestitution) and never let it in; advertising boards at |x| = BOARD_X, |z| = BOARD_Z bounce it back
  (boardRestitution); clamp speed to maxSpeed. Emit BOUNCE (c = impact speed) for bounces > 1 m/s.
- `ballTick(s, ev)`: px/py/pz, skip when heldBy >= 0, ballStepTick, then SIM-03 `detectCrossing(s, px,py,pz, x,y,z)`,
  then clamp inside WORLD bounds.
- Must never leave the ball resting ON TOP of the net roof or wedged against a post/board: if the ball rests on
  the roof, roll it off; if speed ~0 touching a post, nudge it out deterministically.
Tests (`tests/unit/sim-02-*.test.ts`, named after glitch lines): bounce heights roughly halve; posts/bar deflect at
36 m/s without tunnelling (sweep many angles/speeds); a shot into the net stays in and emits NET once; side-netting
shots from outside never enter; "ball stuck on the roof of the net", "wedged against a post or board",
"resting on the goal line" all resolve; determinism.
Budget: ballTick < 0.05 ms.
