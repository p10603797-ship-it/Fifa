# DAT-05 — Rating balance and the attribute-effect audit
Owns: tests `tests/sim/dat-05-*.test.ts`, `tools/balance.ts`, `docs/ATTRIBUTE_AUDIT.md`. Spec: BRIEF §15 ("Every attribute must visibly change play.
Delete any that does not." "Balance check by simulation over 200 matches: an 88-rated club beats a 62-rated club at least 80% of the time, and equal
clubs split close to evenly."). Contracts: src/contracts/data.ts (Club, PlayerData, Kit, Crest, Formation, ATTRIBUTE_KEYS), enums (Role, TeamStyle, FormationId, KitPattern, Foot). Data must come from a seeded generator script and be committed so teams stay the same between builds (BRIEF §15). Everything invented: no real clubs, leagues, players, cities-as-club-names that match real clubs, kits or crests (§2).
Implement: tools/balance.ts using tools/headless.ts runMatch (FND-06) running N matches (default 200) of the top vs bottom club and equal clubs,
CPU vs CPU at Professional, reporting win/draw/loss rates and a PASS/FAIL against the targets; an attribute audit: for each attribute, grep which sim/ai
modules read it (static audit) AND a dynamic micro-test (scenario where only that attribute changes from 40 to 90 and a measurable outcome moves:
e.g. sprintSpeed -> top speed, shortPassing -> pass error, finishing -> on-target rate, gkReflexes -> reaction ticks...) — write the dynamic tests in
tests/sim/dat-05-attributes.test.ts as it.todo where the consuming module is still a stub; docs/ATTRIBUTE_AUDIT.md records each attribute, consumer,
measured effect, verdict. Run the balance tool now (it will be meaningless until the sim is real — report the current numbers anyway) and design it
to be re-run by QA.
