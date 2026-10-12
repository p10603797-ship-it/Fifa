# GFX-12 — Animation mapping and blending from sim state
Owns: `src/render/anim/mapper.ts`. Spec: BRIEF §4 rule 3 ("Animation is derived from sim state and never feeds back into it."),
§8 ("Run cycles advance with distance travelled so feet do not slide. Poses blend. The kicking foot meets the ball on the contact
tick."), GFX-09/10/11 pose tables, GFX-07 setPose. Contracts: src/contracts/app.ts (GameRenderer), render.ts (Pose, PoseIdx, POSE_SIZE, AnimId, PoseFn, RenderStats), state.ts (read-only sim state), events.ts, tuning T_CAMERA/T_PERF, settings.ts. Your stub was created by FND-05: read src/render/types.ts (RenderContext, RenderFrame, InterpState, RenderModule) and src/render/index.ts first; keep the module interface. Budgets (BRIEF §13): whole frame <= 80 draw calls and <= 200k triangles at the default tier, no per-frame allocation, unlit/Lambert materials, one directional light + ambient, no real-time shadow maps or post-processing at the default tier, textures total <= 64 MB. Readability beats realism (§8 Look). Original art only — no real stadiums, sponsors or commercial game visuals. Test pure logic (geometry builders, maths, pose functions) in Node; check visuals with Playwright screenshots (npx vite build && npx playwright test), and LOOK at your screenshots (Read the PNG) before reporting.
Implement the per-frame mapper for 22 players: choose AnimId from (p.act, p.actT, p.actDur, p.actContact, p.actKick, p.actSkill,
p.actA/B for dive side/height, velocity, jockeying/shielding/sprinting, isKeeper, ball in hands, phase cut-scenes); compute the
clip phase t from interpolated action time ((actT + alpha) / actDur) aligned so the contact fraction maps to actContact;
locomotion cycle phase per player advanced by interpolated distance travelled / stride length (persistent per-slot phase,
reset-safe on teleports > 3 m); blend between clips with short cross-fades (pose lerp per joint, 0.1-0.2 s) and layer upper-body
actions over locomotion where sensible; write poses into GFX-07 via setPose. Never write sim state. Allocation-free.
Tests: unit with synthetic sim states — mapping table (each ActionKind -> expected AnimId), contact alignment (t at
actContact == contact fraction), blend continuity across clip changes, teleport reset; e2e — no visible popping (sample poses
across frames).
