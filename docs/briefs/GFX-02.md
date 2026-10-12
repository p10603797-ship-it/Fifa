# GFX-02 — Dynamic resolution and quality tiers
Owns: `src/render/quality.ts`. Spec: BRIEF §13 ("Scale dynamically between 0.6 and 1.0 from a smoothed frame-time signal with
hysteresis. The DOM HUD stays at native resolution." "Quality tiers. Auto picks Performance, Balanced or Quality from a 2-second
startup test, then adapts. Quality may add one shadow map and multisampling, and steps down if it cannot hold 50 fps."), §3 Low
Power Mode ("Detect a steady 30 fps with idle frame time and show a one-time hint to turn it off."), settings.graphics, T_PERF. Contracts: src/contracts/app.ts (GameRenderer), render.ts (Pose, PoseIdx, POSE_SIZE, AnimId, PoseFn, RenderStats), state.ts (read-only sim state), events.ts, tuning T_CAMERA/T_PERF, settings.ts. Your stub was created by FND-05: read src/render/types.ts (RenderContext, RenderFrame, InterpState, RenderModule) and src/render/index.ts first; keep the module interface. Budgets (BRIEF §13): whole frame <= 80 draw calls and <= 200k triangles at the default tier, no per-frame allocation, unlit/Lambert materials, one directional light + ambient, no real-time shadow maps or post-processing at the default tier, textures total <= 64 MB. Readability beats realism (§8 Look). Original art only — no real stadiums, sponsors or commercial game visuals. Test pure logic (geometry builders, maths, pose functions) in Node; check visuals with Playwright screenshots (npx vite build && npx playwright test), and LOOK at your screenshots (Read the PNG) before reporting.
Implement: frame-time smoothing (EMA of CPU frame time measured around render plus rAF interval), dynamic resolution controller
with hysteresis (resUpMs/resDownMs, step 0.05, cooldown ~1 s) honouring a fixed scale from settings, tier selection (2-second
startup test during warm-up/loading), tier parameters other modules read (export getTierParams(): shadows on/off, msaa, crowd
density, net detail...), step-down when < 50 fps sustained; Low Power Mode detector: rAF interval steady ~33 ms while the frame
work is small -> callback once (settings.lowPowerHintShown).
Tests: unit — controller behaviour on synthetic frame-time series (no oscillation, bounds 0.6-1.0, hysteresis), tier choice,
low-power detection; e2e — changing settings tier applies.
