# GFX-10 — Animation: kicks, headers, touches, throw-ins
Owns: `src/render/anim/actions.ts`. Spec: BRIEF §8 Look (animation set: pass, shot, power shot, finesse, header, volley, first
touch, throw-in ... "The kicking foot meets the ball on the contact tick."), contracts/render.ts AnimIds PASS, SHOT, POWER_SHOT,
FINESSE, HEADER, VOLLEY, FIRST_TOUCH, THROW_IN, SKILL (generic skill touches), GK_KICK, GK_THROW. Contracts: src/contracts/app.ts (GameRenderer), render.ts (Pose, PoseIdx, POSE_SIZE, AnimId, PoseFn, RenderStats), state.ts (read-only sim state), events.ts, tuning T_CAMERA/T_PERF, settings.ts. Your stub was created by FND-05: read src/render/types.ts (RenderContext, RenderFrame, InterpState, RenderModule) and src/render/index.ts first; keep the module interface. Budgets (BRIEF §13): whole frame <= 80 draw calls and <= 200k triangles at the default tier, no per-frame allocation, unlit/Lambert materials, one directional light + ambient, no real-time shadow maps or post-processing at the default tier, textures total <= 64 MB. Readability beats realism (§8 Look). Original art only — no real stadiums, sponsors or commercial game visuals. Test pure logic (geometry builders, maths, pose functions) in Node; check visuals with Playwright screenshots (npx vite build && npx playwright test), and LOOK at your screenshots (Read the PNG) before reporting.
Implement PoseFns with normalised phase t in [0,1] where t = contactFraction is the moment of contact (the mapper passes the
action's wind-up/contact timing so that the foot reaches the ball exactly at the sim contact tick): backswing, strike, follow-
through; right/left foot (foot arg), power shot longer backswing, finesse with an open body, header jump with neck snap, volley
side-on, first touch cushion, throw-in two-handed overhead, skill touch generic. Export contact fractions per AnimId so GFX-12
can time them. Allocation-free.
Tests: unit — kicking foot reaches its max forward extension at contactFraction (FK), poses finite/within limits; e2e visual
check of a shot via the debug pose viewer if available; look at it.
