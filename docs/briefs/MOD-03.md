# MOD-03 — Shoot-out mode
Owns: `src/modes/shootout.ts`. Spec: BRIEF §11 ("Shoot-out: Straight to penalties"), RUL-07 shoot-out rules. Contracts: src/contracts/app.ts (MatchSetup, SessionControl, StatsTracker, MatchSummary, AppContext), state.ts (MatchConfig via createMatchConfig), enums ModeId/PracticeKind. Stubs by FND-04 (read src/modes/* and src/app/session.ts).
Implement: shootout mode setup (config.startPhase = SHOOT_OUT, both teams' kickers, human sides via side select) and the post-match flow (winner banner
via full-time screen, rematch). Tests: setup validity; a CPU vs CPU shoot-out completes to POST_MATCH via runMatch (once RUL-07 is real; it.todo now if it
is a stub).
