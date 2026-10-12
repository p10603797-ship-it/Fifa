# DAT-01 — Club generator: names, codes, crests, styles
Owns: `tools/gen-data.ts` (orchestrates generation and writes `src/data/clubs.generated.ts`), `src/data/clubs.ts`, `src/data/names.ts`. Spec: BRIEF §15
("20 fictional clubs, each with an invented name, a unique 3-letter code, a simple generated geometric crest, home, away and keeper kits, a preferred
formation and a style. Overall ratings spread from 62 to 88 so there are favourites and underdogs."). Contracts: src/contracts/data.ts (Club, PlayerData, Kit, Crest, Formation, ATTRIBUTE_KEYS), enums (Role, TeamStyle, FormationId, KitPattern, Foot). Data must come from a seeded generator script and be committed so teams stay the same between builds (BRIEF §15). Everything invented: no real clubs, leagues, players, cities-as-club-names that match real clubs, kits or crests (§2).
Implement: a seeded PRNG (any, Node side), invented club names from syllable/word lists (e.g. "Harbour Vale", "Kestrel Athletic"... make sure none match
real clubs: screen against a list of well-known real club names/cities you write into src/data/names.ts as a denylist), unique 3-letter codes (not
real-club codes from the denylist), Crest data (shape/emblem/colours), styles spread across the five TeamStyles, preferred formations across the six,
ratings spread 62..88 (roughly even, a few favourites); kits come from DAT-03 (`src/data/kits.ts` exports a generator — call it), squads from DAT-02
(`src/data/playerGen.ts` exports generateSquad(rng, club params)). gen-data writes clubs.generated.ts deterministically (stable output across runs);
clubs.ts re-exports CLUBS/getClub from the generated file (keep the API used by src/sim/init.ts). npm run gen:data runs it.
Tests: generation is deterministic (two runs identical), 20 clubs, unique codes, ratings span, denylist respected, every club valid (18 players, 2
keepers, formation roles covered).
