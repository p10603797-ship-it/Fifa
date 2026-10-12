# GFX-14 — Main broadcast camera
Owns: `src/render/camera/broadcast.ts`. Spec: BRIEF §8 Main camera (all bullets: default broadcast side camera on the near-touchline
side, raised and looking down across the pitch; starting values height 24 m, 40 m behind the near touchline, vertical FOV 22 deg;
readability: a player at the centre spot is about 6% of the screen height and roughly 45 m of the pitch length is visible on an
iPad; follow: slides along the touchline at ~70% of the ball's x clamped to +-32 m and turns to look at the ball, square-on at
midfield, angled toward the goal near either penalty area; framing: look-at leads the ball by 3-6 m in the direction of play; the
ball never sits in the bottom 15% of the screen or under the touch controls; motion: critically damped smoothing ~0.4 s from
interpolated positions, FOV widens up to 4 deg for high or fast balls, no shake/bob; settings camera type Broadcast, Wide, Close,
End to End, plus Height and Zoom sliders 0-20; wider screens show more pitch, narrower windows keep vertical framing and lose
width), §12 accessibility (reduced camera motion), glitch list Camera lines, T_CAMERA. Contracts: src/contracts/app.ts (GameRenderer), render.ts (Pose, PoseIdx, POSE_SIZE, AnimId, PoseFn, RenderStats), state.ts (read-only sim state), events.ts, tuning T_CAMERA/T_PERF, settings.ts. Your stub was created by FND-05: read src/render/types.ts (RenderContext, RenderFrame, InterpState, RenderModule) and src/render/index.ts first; keep the module interface. Budgets (BRIEF §13): whole frame <= 80 draw calls and <= 200k triangles at the default tier, no per-frame allocation, unlit/Lambert materials, one directional light + ambient, no real-time shadow maps or post-processing at the default tier, textures total <= 64 MB. Readability beats realism (§8 Look). Original art only — no real stadiums, sponsors or commercial game visuals. Test pure logic (geometry builders, maths, pose functions) in Node; check visuals with Playwright screenshots (npx vite build && npx playwright test), and LOOK at your screenshots (Read the PNG) before reporting.
Implement the camera + CameraProjector (screenToPitch, pitchToScreen, stickRotation: 0 for Broadcast/Wide/Close, +-pi/2 for End to
End depending on which team the human attacks with), framing constraints solved each frame (if the ball would fall into the bottom
15% or the touch-control region, raise the look-at / adjust), high-ball tracking (keep the ball in view using predicted apex),
deterministic-free smoothing (render side may use Math). Measure readability numerically and report the values.
Tests: unit — readability numbers, follow clamp, lead direction, bottom-margin constraint across ball positions, projector round
trip, settings sliders; e2e screenshots at midfield and near each box; look at them. Regression names from the Camera glitch lines
(jitter, snapping at restarts, losing a high ball, dipping below ground or into the stand, ball hidden under touch controls).
