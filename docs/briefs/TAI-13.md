# TAI-13 — Set-piece AI (positions and CPU execution)
Owns: `src/ai/setpieces.ts`. Spec: BRIEF §7 ("Set pieces: scripted attacking and defending positions for corners, free
kicks (a wall of 2-5 by distance and angle), throw-ins, goal kicks and kick-offs."), §5 restart distances, §11 shoot-out.
Implement `setPiecePositions(s, team, ev)` and `cpuSetPiece(s, team, out, ev)`:
- Positions (SET_PIECE jobs, legal by construction so RUL-11 rarely teleports): kick-off (own half, outside the circle
  for the defending team), throw-in (short options 5-15 m from the thrower, markers), goal kick (spread for short/long),
  corners (attackers: near post, far post, penalty spot, edge of the box, short option; tactics from team.cornerTactic;
  defenders: zonal + man marking, a player on the near post), free kicks (wall members chosen by RUL-05 stand at
  restart.wall positions — you only place others; attackers in the box for wide free kicks), penalties (outside the
  area/arc), shoot-out (centre circle).
- cpuSetPiece: the CPU taker's frame after restart.ready + T_RULES.cpuRestartDelay: choose short/long/cross/shot like a
  human would (stick aim, button hold for power, curl via ax/az for free kicks, gesture tap for exact targets), CPU
  defending set pieces (wall jump on a shooting free kick: THROUGH at the kick moment), CPU penalties/shoot-out kicks
  (aim corners with execution error), CPU keeper dive choice is GKP-06's.
Tests: every restart kind gets legal positions for both teams (distances), CPU completes every restart kind within a few
seconds, corner tactics move players, determinism.
