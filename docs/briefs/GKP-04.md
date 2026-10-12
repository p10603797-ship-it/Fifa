# GKP-04 — Keeper distribution AI
Owns: `src/sim/keeper/distribution.ts`. Spec: BRIEF §6 ("Distribution: throw, roll, drop kick, driven kick, and a
quick release when a counter-attack is on."), §5 ("release the ball within 6 s"), glitch "holds the ball forever".
Implement `keeperDistributionAi(s, team, ev)` for keepers holding the ball (GK_HOLD) that no human controls (CPU teams,
and human teams when the human is not controlling the keeper — normally SIM-16 gives the human the keeper):
- Wait a short believable time (0.5-2.5 s, shorter on a counter), let teammates spread (TAI handles), then choose:
  quick throw/roll to an open full-back/centre-back (TAI-09 laneSafety when available, else nearest open teammate),
  driven throw to a midfielder, drop kick/driven kick long to a forward when the press is high or the team style is
  direct; start via GKP-05 startKeeperRelease with a target. Always release before T_GK.maxHoldTicks (6 s).
Tests: always releases within 6 s, quick release on counters, short vs long by pressure and style, targets are
teammates, deterministic.
