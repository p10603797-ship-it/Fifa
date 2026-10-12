# RUL-06 — Penalties in play
Owns: `src/sim/rules/penalty.ts`. Spec: BRIEF §5 (fouls inside the area -> penalty), §9 penalties on touch ("swipe
toward the part of the goal you want. Faster is harder to save and less accurate. To save one, tap or swipe the way
the keeper should dive."), §10 Penalty (aim left stick; shoot B; finesse R1+B; chip L1+B), Saving a penalty (move
along the line left stick; dive right stick).
Implement penaltySetup/Tick/Input/Default:
- Setup: ball on the penalty spot of the defending end, taker = best penalty taker (finishing+composure), keeper on the
  line between the posts, everyone else outside the area and the arc behind the ball (legalizePositions).
- Taker input: stick aims at a goal-mouth point; SHOOT/MOD_R/MOD_L + SHOOT -> SIM-11 startShot(PENALTY) with
  aim/power (hold or swipe power); swipe gesture toward the goal (gdx/gdz direction, gPower speed). Keeper input
  (defending human controlling the keeper): stick moves him along the line (limited), right stick flick (RS_FLICK
  with ax/az) or a swipe/tap gesture commits a dive direction (store for GKP-06/GKP-02; export
  `penaltyDiveChoice(s): {dir, height, tick}` storage via restart.aimX/aimZ? — use restart.side = dive dir (-1/0/+1)
  and restart.aimPower = height class, document it). AI keepers choose via GKP-06. After the kick -> IN_PLAY
  (restart.taken) and play continues (rebounds live).
Tests: setup legality, aim maps to goal mouth, faster = less accurate, keeper dive choice consumed, rebound playable,
timeout default, the half cannot end during a penalty (RUL-01 checks).
