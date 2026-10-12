# SIM-09 — Lobs and crosses
Owns: `src/sim/kicks/lob.ts`. Spec: BRIEF §6 Passing ("In the crossing zone, a lob becomes a cross aimed at the near
post, far post or penalty spot from power and stick."), §9 PASS swipe up/left/right in the crossing zone, §10 LOB
(Square/X), High lob (L1+X), Driven lob/cross (L1+R1+X), Ground cross (X,X); corner tactics (team.cornerTactic).
Implement `startLob` (LOB_PASS, HIGH_LOB, DRIVEN_LOB, CROSS, GROUND_CROSS, LOW_CROSS; inside the crossing zone
(geometry.inCrossingZone) LOB_PASS -> CROSS, DRIVEN_LOB -> LOW_CROSS), `solveLob`, `solveCross`, `crossTarget`:
- Lob: receiver via SIM-08 selectReceiver(lofted=1) or explicit target; landing point = receiver's predicted
  position (lead runners); launch via SIM-01 solveLaunch with T_PASS lob/highLob/drivenLob angles; error from
  longPassing, pressure, facing, weak foot (SIM-08 kickError).
- Cross: aim point near post / penalty spot / far post chosen from power (low/mid/high) and stick; whipped with
  curl away from the keeper (spin sy) using the crossing attribute; ground cross along the floor to the near post /
  penalty spot; low (driven) cross fast and flat. Corner tactics bias the target (near post, far post, edge of the
  box, crowd the keeper). Set launch.target to the best attacker near the aim point (or -1).
Tests: crosses land within 2.5 m of the chosen zone for a 75-rated crosser; lobs clear a defender and drop to the
receiver; crossing zone conversion; curl direction away from goal; determinism.
