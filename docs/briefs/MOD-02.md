# MOD-02 — Cup: draw, bracket, quick results, save
Owns: `src/modes/cup.ts`. Spec: BRIEF §11 ("Cup: An 8- or 16-team knockout against bots, for one or two humans. Other ties use a quick ratings-based result.
Progress saves."), §5 cup rules (extra time + shoot-out). Contracts: src/contracts/app.ts (MatchSetup, SessionControl, StatsTracker, MatchSummary, AppContext), state.ts (MatchConfig via createMatchConfig), enums ModeId/PracticeKind. Stubs by FND-04 (read src/modes/* and src/app/session.ts).
Implement: createCup(size, humanClubs, seed) (seeded draw), bracket model (rounds, ties, results incl. extra time/penalties), quick result for CPU-only ties
(deterministic from ratings + seeded noise: goals Poisson-ish via table, penalties if level), next human tie -> MatchSetup with cupRules = 1 and onFinish
recording the result, two humans (same team co-op or opposing paths), save/load via ctx.settings.saveProgress('cup') with a schema version, champion
detection.
Tests: draw determinism, bracket progression, quick results favour stronger clubs (statistically over seeds), no draws in cup results, save/load round
trip.
