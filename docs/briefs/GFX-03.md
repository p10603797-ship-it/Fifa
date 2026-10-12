# GFX-03 — Pitch
Owns: `src/render/pitch.ts`. Spec: BRIEF §8 Look ("Pitch with mowing stripes and lines"), contracts/constants (exact markings:
105x68, centre circle 9.15, penalty areas 40.32x16.5, goal areas 18.32x5.5, spots at 11 m, arcs, corner arcs r=1, line width
0.12). Contracts: src/contracts/app.ts (GameRenderer), render.ts (Pose, PoseIdx, POSE_SIZE, AnimId, PoseFn, RenderStats), state.ts (read-only sim state), events.ts, tuning T_CAMERA/T_PERF, settings.ts. Your stub was created by FND-05: read src/render/types.ts (RenderContext, RenderFrame, InterpState, RenderModule) and src/render/index.ts first; keep the module interface. Budgets (BRIEF §13): whole frame <= 80 draw calls and <= 200k triangles at the default tier, no per-frame allocation, unlit/Lambert materials, one directional light + ambient, no real-time shadow maps or post-processing at the default tier, textures total <= 64 MB. Readability beats realism (§8 Look). Original art only — no real stadiums, sponsors or commercial game visuals. Test pure logic (geometry builders, maths, pose functions) in Node; check visuals with Playwright screenshots (npx vite build && npx playwright test), and LOOK at your screenshots (Read the PNG) before reporting.
Implement the pitch in very few draw calls: grass plane with mowing stripes (vertex colours or a small generated texture,
alternating bands across x), subtle wear near goalmouths and centre (generated), line markings as one merged geometry (or
baked into a generated canvas texture at sufficient resolution — whichever reads crisper at the broadcast distance; avoid
aliasing shimmer: lines >= 2 px wide at default resolution), surrounding run-off grass. Day/night respond to lighting from
GFX-05 (Lambert). <= 3 draw calls, < 5k triangles.
Tests: unit — marking geometry dimensions match constants; e2e screenshot of the pitch from the broadcast camera; look at it.
