# QF-4 — Camera, animation, look and HUD: QA-31..QA-35, FIX-08, FIX-09, FIX-10

Area (exclusive for this wave): `src/render/**`, `src/ui/hud/**` (or the HUD files under src/ui), `src/ui/tokens.css`,
`src/ui/components.*`, other `src/ui/screens/*` for layout defects only.
Charter (BRIEF §8, §12, §13 budgets, §14 glitch list camera):
- QA-31 camera framing, jitter, high balls, restarts (no snapping, never below ground or into the stand, ball never
  hidden under touch controls); QA-32 animation sync, foot sliding, visible teleports (measure foot slip from the pose
  vs body velocity); QA-33 kit clashes for every club pair, readability, HUD overlap at 4:3, 16:10, 19.5:9 and the
  iPad 1180x820; QA-34 draw calls <= 80, triangles <= 200k, texture memory per scene (kick-off, open play, box, corner,
  goal + replay, night); QA-35 context loss, resize, rotation.
Look at every screenshot you take. Measure, do not guess.
From INT-C (Wave 2): free-kick view shows the ball between the taker's legs (taker on the camera line — fix the camera
or CR the sim taker spot); goal-kick keeper still large in frame; dribble touches and first touches have no boot contact
(KICK events 0.3-1 m from the boot; phase-align the run cycle to the touch schedule where feasible); sharp turns
(> 2 rad/s) still slip; gfx-12-anim e2e "no joint pops" fails (slot 10 ANKLE_R frame 103, 0.55 > 0.45); swipe-hint
labels near the bottom-right big button go off screen (INT-B). Render-side per-frame allocation 1.3-2.3 KB in a live
match is QF-7's, but fix type-feedback deopts you touch anyway.
