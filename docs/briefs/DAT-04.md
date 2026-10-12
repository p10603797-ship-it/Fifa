# DAT-04 — Formation, role and tactic preset data
Owns: `src/data/formations.ts`, `src/data/tactics.ts`. Spec: BRIEF §7 Team shape (six formations; each role's home position shifts with ball, phase and
focus), §10 tactics (quick tactics, focus), contracts/data.ts Formation/FormationSlot. Wave 0 left a baseline formations.ts — refine it. Contracts: src/contracts/data.ts (Club, PlayerData, Kit, Crest, Formation, ATTRIBUTE_KEYS), enums (Role, TeamStyle, FormationId, KitPattern, Foot). Data must come from a seeded generator script and be committed so teams stay the same between builds (BRIEF §15). Everything invented: no real clubs, leagues, players, cities-as-club-names that match real clubs, kits or crests (§2).
Implement: accurate neutral-phase home positions for 4-4-2, 4-3-3, 4-2-3-1, 3-5-2, 5-3-2, 4-1-2-1-2 (index 0 GK then defenders right-to-left, mids,
forwards; +nz = right flank for a team attacking +x), plus per-role behaviour presets in tactics.ts used by TAI agents: per Role {width, depth range in
attack/defence, freedom to roam, attack runs, defensive duties}, phase offsets (attack/defend push), quick-tactic and focus modifiers (numbers TAI-01/04/05
read), and formation change mapping helpers (which slot maps to which role when switching formation in-match).
Tests: 11 slots each, one GK, symmetric where expected, positions inside the pitch, mirrored use (x = -nx*52.5 for dir -1) stays valid, presets for every
Role.
