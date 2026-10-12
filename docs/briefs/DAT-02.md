# DAT-02 — Player generator: names, positions, attributes
Owns: `src/data/playerGen.ts`, `src/data/screen.ts`. Spec: BRIEF §15 ("18 players per club: 11 starters and 7 substitutes, including 2 keepers. Names
come from mixed-origin name lists and must not match real footballers; screen the output against famous names." Outfield attributes 1-99 (list),
keeper attributes, height, preferred foot, weak foot 1-5, skill moves 1-5, position and shirt number; "Every attribute must visibly change play.").
Contracts: src/contracts/data.ts (Club, PlayerData, Kit, Crest, Formation, ATTRIBUTE_KEYS), enums (Role, TeamStyle, FormationId, KitPattern, Foot). Data must come from a seeded generator script and be committed so teams stay the same between builds (BRIEF §15). Everything invented: no real clubs, leagues, players, cities-as-club-names that match real clubs, kits or crests (§2).
Implement generateSquad(rng, {rating, formation, style}): starters matching the formation roles (index 0 GK, then slot order of data/formations.ts),
bench with a keeper + cover positions; position-appropriate attribute profiles (CB: tackling/heading/strength; winger: pace/dribbling/crossing; ST:
finishing/positioning... composure etc.) scaled to the club rating with spread (stars and weaker players), keepers with gk* high and outfield low;
overall computed per position (weighted); heights 165-200 (keepers taller); foot ~75% right; weak foot/skill moves correlated with role; shirt numbers
unique, conventional (1 GK, 2-5 defenders...). Names from mixed-origin first/last name syllable lists generating invented names; screen.ts holds a
denylist of famous real footballers' names (well-known, a few hundred surnames + full names) and rejects collisions (full name match or famous
surname + matching initial).
Tests: deterministic, attribute ranges, position profiles (CB tackling > ST tackling...), overall formula, unique shirts, denylist screening works on
injected collisions.
