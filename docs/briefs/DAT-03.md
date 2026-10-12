# DAT-03 — Kit designs and colours
Owns: `src/data/kits.ts`. Spec: BRIEF §8 Look ("Kits: home, away and keeper kits with a colour and a pattern (plain, stripes, hoops, halves, sash).";
bold kit colours, strong contrast with the grass), §15. Contracts: src/contracts/data.ts (Club, PlayerData, Kit, Crest, Formation, ATTRIBUTE_KEYS), enums (Role, TeamStyle, FormationId, KitPattern, Foot). Data must come from a seeded generator script and be committed so teams stay the same between builds (BRIEF §15). Everything invented: no real clubs, leagues, players, cities-as-club-names that match real clubs, kits or crests (§2).
Implement generateKits(rng, clubIndex) -> {home, away, keeper, keeper2}: bold, distinct palettes across 20 clubs (avoid grass-like greens for
shirts, avoid two clubs with identical home kits), patterns spread across the five, away kits contrasting with home (light vs dark), number colours
readable on the shirt (contrast ratio), keeper kits distinct from both outfield kits (bright/unusual colours) with keeper2 alternate. Provide
`kitContrast(a, b)` helpers used by tests (GFX-08 owns the in-game clash check).
Tests: deterministic, pattern spread, number contrast >= 4.5:1, home/away contrast, no grass-green shirts, keeper kits distinct.
