# GFX-13 — Ball, shadows, on-pitch markers and indicators
Owns: `src/render/ball.ts`, `src/render/markers.ts`. Spec: BRIEF §8 Look ("On-pitch aids: a marker above each controlled player
(one colour per human), a ring under the intended receiver, a faint marker on the next switch target, a landing marker for high
balls, and edge-of-screen arrows for the ball when it is off screen." "Shadows are blobs or cheap projections."), §11 (player 1
ember #FF6B35, player 2 cyan), §12 accessibility (colour-blind-safe markers: add shapes, not only colours). Contracts: src/contracts/app.ts (GameRenderer), render.ts (Pose, PoseIdx, POSE_SIZE, AnimId, PoseFn, RenderStats), state.ts (read-only sim state), events.ts, tuning T_CAMERA/T_PERF, settings.ts. Your stub was created by FND-05: read src/render/types.ts (RenderContext, RenderFrame, InterpState, RenderModule) and src/render/index.ts first; keep the module interface. Budgets (BRIEF §13): whole frame <= 80 draw calls and <= 200k triangles at the default tier, no per-frame allocation, unlit/Lambert materials, one directional light + ambient, no real-time shadow maps or post-processing at the default tier, textures total <= 64 MB. Readability beats realism (§8 Look). Original art only — no real stadiums, sponsors or commercial game visuals. Test pure logic (geometry builders, maths, pose functions) in Node; check visuals with Playwright screenshots (npx vite build && npx playwright test), and LOOK at your screenshots (Read the PNG) before reporting.
Implement: ball mesh (generated panel texture or vertex colours, spin rotation from sim spin/velocity), ball blob shadow scaled by
height, player blob shadows (one instanced quad mesh), controlled-player markers (P1 ember chevron, P2 cyan diamond; colour-blind
mode adds distinct shapes/labels "1"/"2"), receiver ring (ball.passTarget), next-switch faint marker (ctrl.nextSwitch), landing
marker for high balls (SIM-01 predictBall landIndex — the render may call predictBall on a copy, read-only), off-screen ball
arrow at the screen edge (DOM or sprite) using the projector; power bar near the controlled player (world-anchored small bar)
from ctrl.power when charging. <= 8 draw calls.
Tests: unit — landing point and off-screen arrow maths; e2e screenshots with markers; look at them.
