# SIM-12 — Headers, volleys and aerial duels
Owns: `src/sim/kicks/aerial.ts`. Spec: BRIEF §6 Shooting (header, volley, first-time shot), §10 "Ground pass /
header" (A), "Lob pass / cross / header" (X), "Shoot / volley / header" (B).
Implement `startHeader`, `startVolley`, `aerialChance`, `aerialContacts`, `solveHeader`, `solveVolley`, HEADER and
VOLLEY handlers:
- When the controlled player (or an AI attacker targeted by a cross) is under a dropping ball (SIM-01 predictBall
  landing / height window 1.2-2.6 m for headers, 0.4-1.2 m for volleys), pressing pass/lob/shoot starts a header or
  volley (the resolver calls you when aerialChance > 0). AI players attack crosses aimed at them (you may start
  headers for AI attackers/defenders in aerialContacts when the ball arrives and nobody controls them; defenders
  head clear).
- aerialContacts: contest between players reaching the same ball (jump timing, heading, height, strength, keeper
  priority stays with GKP which runs first). Winner directs the ball: header shot (aim like SIM-11 with heading
  accuracy), header pass/clearance, volley shot/pass; losers stumble if beaten in the air.
Tests: headers from crosses reach goal at believable speeds (10-20 m/s), volleys at 20-30 m/s, duel winner depends
on heading/height/strength deterministically over seeds, no double contact.
