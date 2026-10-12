# GFX-01 — Renderer setup and context loss
Owns: `src/render/renderer.ts`. Spec: BRIEF §13 ("powerPreference: 'high-performance', an opaque canvas, no stencil buffer, no
preserved drawing buffer. Use anti-aliasing only if the budget holds."; resolution 0.75 of device pixels to start), §3 ("WebGL
context loss. Pause, restore, rebuild GPU resources, then resume from the pause menu.", windowing 4:3..21:9, minimum size). Contracts: src/contracts/app.ts (GameRenderer), render.ts (Pose, PoseIdx, POSE_SIZE, AnimId, PoseFn, RenderStats), state.ts (read-only sim state), events.ts, tuning T_CAMERA/T_PERF, settings.ts. Your stub was created by FND-05: read src/render/types.ts (RenderContext, RenderFrame, InterpState, RenderModule) and src/render/index.ts first; keep the module interface. Budgets (BRIEF §13): whole frame <= 80 draw calls and <= 200k triangles at the default tier, no per-frame allocation, unlit/Lambert materials, one directional light + ambient, no real-time shadow maps or post-processing at the default tier, textures total <= 64 MB. Readability beats realism (§8 Look). Original art only — no real stadiums, sponsors or commercial game visuals. Test pure logic (geometry builders, maths, pose functions) in Node; check visuals with Playwright screenshots (npx vite build && npx playwright test), and LOOK at your screenshots (Read the PNG) before reporting.
Implement: WebGL2 renderer creation (fallback message if unavailable), sRGB output, pixel ratio = devicePixelRatio x
resolution scale (from GFX-02), resize handling for any aspect ratio (camera aspect updated; vertical framing kept on narrow
windows, more pitch on wide ones — expose aspect to GFX-14), stats collection (renderer.info: calls, triangles, textures,
geometries) for RenderStats, webglcontextlost (preventDefault, notify the session to pause) and webglcontextrestored (rebuild:
call every module's rebuild/setMatch again via an exported hook in render/index.ts — coordinate with a change request if the
orchestrator needs one), dispose. Expose window.__dotkickRendererStats.
Tests: e2e — resize across 4:3/16:10/21:9 keeps rendering; simulated context loss via WEBGL_lose_context -> pause -> restore
-> rendering resumes with all objects; stats readable.
