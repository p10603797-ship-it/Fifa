# GFX-09 — Animation: locomotion
Owns: `src/render/anim/locomotion.ts`. Spec: BRIEF §8 Look ("Animation set: idle, jog, sprint, turn lean, ... Run cycles advance
with distance travelled so feet do not slide. Poses blend."), contracts/render.ts (Pose, PoseIdx, PoseFn, AnimId IDLE, JOG,
SPRINT, TURN_LEAN, JOCKEY, STRAFE, SHIELD, KEEPER_READY). Contracts: src/contracts/app.ts (GameRenderer), render.ts (Pose, PoseIdx, POSE_SIZE, AnimId, PoseFn, RenderStats), state.ts (read-only sim state), events.ts, tuning T_CAMERA/T_PERF, settings.ts. Your stub was created by FND-05: read src/render/types.ts (RenderContext, RenderFrame, InterpState, RenderModule) and src/render/index.ts first; keep the module interface. Budgets (BRIEF §13): whole frame <= 80 draw calls and <= 200k triangles at the default tier, no per-frame allocation, unlit/Lambert materials, one directional light + ambient, no real-time shadow maps or post-processing at the default tier, textures total <= 64 MB. Readability beats realism (§8 Look). Original art only — no real stadiums, sponsors or commercial game visuals. Test pure logic (geometry builders, maths, pose functions) in Node; check visuals with Playwright screenshots (npx vite build && npx playwright test), and LOOK at your screenshots (Read the PNG) before reporting.
Implement PoseFns for IDLE (breathing sway), JOG, SPRINT (stride length/arm swing scale with speed; cycle phase supplied by the
mapper from distance travelled: phase += distance / stride length), TURN_LEAN (roll into turns from angular velocity), JOCKEY
(crouched side-step), STRAFE (sideways/backward steps), SHIELD (wide stance, arm out), KEEPER_READY (crouched, hands up),
using only arithmetic + Math.sin/cos (render side may use Math). Export a table keyed by AnimId and a stride-length function
(speed -> metres per cycle) used by GFX-12 for foot-slide-free cycles. Allocation-free.
Tests: unit — poses are finite and within joint limits, cycle continuity (phase 0 == 2π), foot contact timing vs stride (feet
planted while the body passes over them: measure foot world velocity ~0 at contact with the FK helper from GFX-07 if available,
else a local FK); e2e — visual check of a jogging and sprinting player; look at it.
