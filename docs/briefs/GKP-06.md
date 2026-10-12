# GKP-06 — Keeper at set pieces
Owns: `src/sim/keeper/setpieces.ts`. Spec: BRIEF §6 Goalkeepers, §7 set pieces, §9 penalties ("To save one, tap or swipe
the way the keeper should dive"), §10 saving a penalty.
Implement `keeperSetPiece(s, team, ev)` (called for both keepers during restart phases and the shoot-out):
- Free kicks: stand on the side the wall does not cover, depth by distance; corners: on the line toward the far
  post with claim readiness; goal kicks (own): take position for the kick (RUL-03 makes him the taker); throw-ins:
  normal positioning (GKP-01 spot); kick-offs: in goal.
- Penalties (RUL-06) and shoot-out kicks (RUL-07): on the line centre; AI keeper picks a dive (side/height) with a
  deterministic rng weighted by the kicker's history/foot and starts GK_DIVE at the kick contact tick (ball.lastKickTick
  === tick); a human keeper's chosen dive (restart.side / restart.aimPower per RUL-06 documentation) triggers the dive
  at contact; the save itself is decided physically by GKP-02 contacts.
Tests: positions per set-piece kind, penalty dives at the contact tick, human dive choice honoured, saves only when
physically reached, both ends.
