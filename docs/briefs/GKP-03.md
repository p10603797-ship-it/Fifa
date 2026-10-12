# GKP-03 — Coming out: rushes, one-on-ones, crosses, punches
Owns: `src/sim/keeper/sweeper.ts`. Spec: BRIEF §6 Goalkeepers ("He comes out for through balls and one-on-ones, and
claims or punches crosses in the goal area."; "User control: rush out on hold"), §9 2ND DEF swipe down / tap own
keeper = keeper rushes out; §10 Rush the keeper out (Triangle/Y hold); glitch "fights a defender for the same ball".
Implement `keeperComeOut`, `startKeeperRush`, GK_RUSH and GK_PUNCH handlers:
- AI: through balls / loose balls the keeper reaches first (SIM-04 ticksToReach vs the nearest attacker, inside or
  near his area) -> rush and collect (pick up inside the area via GKP-05 keeperPickUp, else clear/kick); one-on-ones:
  advance to narrow the angle and smother when close; crosses into the goal area: claim (catch above heads,
  gkHandling) or punch (contested, wet... no weather) away; stay home if a defender will clearly get there first
  (never fight a defender for the same ball — check team.chaser and teammates' arrival times).
- User rush: the resolver calls startKeeperRush when the human holds THROUGH/KEEPER_RUSH in defence; while held, the
  keeper sprints toward the ball/carrier; release returns him toward his line.
Tests: rushes for through balls he can win, stays home when the defender is closer, claims vs punches crosses,
smothers one-on-ones, user rush, never leaves the goal empty for nothing (returns), deterministic.
