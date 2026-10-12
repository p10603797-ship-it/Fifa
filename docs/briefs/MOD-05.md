# MOD-05 — Stats tracking, match summary, records
Owns: `src/modes/stats.ts`, `src/modes/records.ts`. Spec: BRIEF §12 full time (stats, player of the match), §7 statistics bands (goals, shots, possession, pass
completion, fouls, offsides), app.ts StatsTracker/MatchSummary. Contracts: src/contracts/app.ts (MatchSetup, SessionControl, StatsTracker, MatchSummary, AppContext), state.ts (MatchConfig via createMatchConfig), enums ModeId/PracticeKind. Stubs by FND-04 (read src/modes/* and src/app/session.ts).
Implement createStatsTracker(): reset/onTick/summary from events + state: goals (GOAL events with scorer/assist rosterIdx, minute from displayClock), shots
and on target (SHOT events), possession by ticks of team ownership during IN_PLAY, passes (KICK events of pass kinds) and completed (PASS_COMPLETE), tackles
and won (TACKLE), fouls, cards, offsides, corners (RESTART_AWARDED CORNER), saves, interceptions; per-player stats and a 0-10 rating; player of the match;
shootout tallies; forfeit. records.ts: lifetime records in progress storage (matches, wins, goals, biggest win).
Tests: synthetic event streams -> exact summaries; possession sums to 1; player of the match picks the top rating; this tracker is also used by QA bands so
keep definitions documented in the file header.
