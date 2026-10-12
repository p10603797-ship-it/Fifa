# MOD-01 — Kick-Off flow and match configuration
Owns: `src/modes/kickoff.ts`, `src/modes/setup.ts`. Spec: BRIEF §11 Modes (Kick-Off: you against the CPU; pick teams, kits, difficulty, half length,
friendly or cup rules, day or night, and rule toggles), §11 Play a Friend (same iPad), §1 ("be in a match within a minute"). Contracts: src/contracts/app.ts (MatchSetup, SessionControl, StatsTracker, MatchSummary, AppContext), state.ts (MatchConfig via createMatchConfig), enums ModeId/PracticeKind. Stubs by FND-04 (read src/modes/* and src/app/session.ts).
Implement: setup.ts builders: defaultSetup(ctx) (quick play), buildSetup(choices: {mode, homeClub, awayClub, kits, humans bindings from side select,
difficulty, halfMinutes, cupRules, night, offside, fouls, practice?}) -> MatchSetup with a fresh seed (app-side randomness OK), resolved kits (GFX-08 clash
check if available), formations from clubs; kickoff.ts: mode flow helpers (next screen after each step, rematch with a new seed, change teams), remembering
last choices in settings.match.
Tests: unit — builders produce valid configs (humans/sides consistent with bindings, CPU sides, halves 2..10 clamp), rematch changes the seed only.
