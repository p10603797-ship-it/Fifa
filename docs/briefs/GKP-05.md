# GKP-05 — Keeper ball handling and user keeper control
Owns: `src/sim/keeper/handling.ts`. Spec: BRIEF §5 ("Goalkeepers handle only inside their own area, cannot pick up a
deliberate pass from a teammate's foot, and release the ball within 6 s."), §6 user control ("full control of throws
and kicks when he has the ball"), §9 keeper with the ball on touch (PASS throws, THROUGH driven throw, SHOOT drop kick,
SPRINT & SKILL drops the ball at his feet), §10 Goalkeeper with the ball (A throw/pass; R1+A driven throw; B or X drop
kick; R1+X driven kick; Y drop the ball; R1 pick up), glitch list Keeper lines (holds the ball forever, carries it over
his own line, handles outside the area).
Implement `canHandle`, `keeperPickUp`, `startKeeperRelease`, `solveKeeperRelease`, GK_HOLD / GK_THROW / GK_KICK:
- canHandle: keeper, active, inside his own penalty area (geometry.inPenaltyArea with the team's defended end), not a
  deliberate foot pass by a teammate (isFootPassKind(ball.lastKickKind) && lastKickTeam === team && lastTouch was that
  kick), not after he already released it this possession.
- keeperPickUp: heldBy = owner = keeper, ball velocity zero, emit KEEPER_HANDS(1), start GK_HOLD; GK_HOLD keeps the
  ball at hands height in front of him every tick; he can walk (slowly) but is clamped inside his area so he never
  carries it over his own line or out of the area; holdT tracked by actT; human auto-release at autoReleaseTicks
  (default throw to the nearest open teammate), hard limit maxHoldTicks.
- Releases: GK_THROW (overarm throw 14-22 m/s, roll along the ground 8-14 m/s, driven throw flatter/faster) and
  GK_KICK (drop kick 50-60 m, driven kick lower/flatter) with targets from the stick (selectReceiver) or explicit;
  GK_RELEASE = drop at his feet (ball released, he can then dribble/pass but can't pick it up again). Emit KEEPER_HANDS(0)
  and KICK with the right KickKind via applyKick.
Tests: back-pass rule, area limit, never over his own line, 6-second rule for humans and AI, each release kind
reaches its target band, drop then no re-pick-up, determinism.
