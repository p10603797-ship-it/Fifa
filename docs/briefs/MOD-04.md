# MOD-04 — Practice arena and set-piece practice
Owns: `src/modes/practice.ts`. Spec: BRIEF §11 ("Practice: Free play against a keeper with no clock, set-piece practice, and a guided tutorial for whichever
input device is in use"). Contracts: src/contracts/app.ts (MatchSetup, SessionControl, StatsTracker, MatchSummary, AppContext), state.ts (MatchConfig via createMatchConfig), enums ModeId/PracticeKind. Stubs by FND-04 (read src/modes/* and src/app/session.ts).
Implement practice session setups: Free play (config.practice = FREE_PLAY: your team vs an opponent keeper only (other opponents inactive? — they must stay
legal for invariants: use a scenario where the opponent fields only a keeper by marking outfielders off-pitch through a supported mechanism; if the sim needs
support, request a contract change: e.g. PracticeKind handling in sim/init), no clock), Free kicks / Corners / Penalties (repeatable set pieces: after each
attempt the same restart is re-awarded at a chosen spot — request a sim hook (e.g. Command or practice rule in RUL-11) via change request), and a
tutorial driver API for UIX-12 (steps with completion checks over state/events).
Tests: setups valid; restart repetition works once the hooks exist (it.todo otherwise).
