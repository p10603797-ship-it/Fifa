# GFX-11 — Animation: tackles, falls, keeper, celebrations
Owns: `src/render/anim/contact.ts`. Spec: BRIEF §8 Look (standing tackle, slide and get-up, stumble, fall, keeper ready, keeper
dives (low, mid, high, each side), catch, parry, throw, kick, three celebrations, dejection), AnimIds STAND_TACKLE, SLIDE,
GET_UP, STUMBLE, FALL, DIVE_*_L/R, CATCH, PARRY, CELEBRATE_1..3, DEJECTION, WALL_JUMP, KEEPER_HOLD. Contracts: src/contracts/app.ts (GameRenderer), render.ts (Pose, PoseIdx, POSE_SIZE, AnimId, PoseFn, RenderStats), state.ts (read-only sim state), events.ts, tuning T_CAMERA/T_PERF, settings.ts. Your stub was created by FND-05: read src/render/types.ts (RenderContext, RenderFrame, InterpState, RenderModule) and src/render/index.ts first; keep the module interface. Budgets (BRIEF §13): whole frame <= 80 draw calls and <= 200k triangles at the default tier, no per-frame allocation, unlit/Lambert materials, one directional light + ambient, no real-time shadow maps or post-processing at the default tier, textures total <= 64 MB. Readability beats realism (§8 Look). Original art only — no real stadiums, sponsors or commercial game visuals. Test pure logic (geometry builders, maths, pose functions) in Node; check visuals with Playwright screenshots (npx vite build && npx playwright test), and LOOK at your screenshots (Read the PNG) before reporting.
Implement PoseFns (phase t 0..1): standing tackle lunge, slide (body low along the ground: use ROOT_Y/ROOT_PITCH/ROOT_FWD),
get-up, stumble, fall to the ground, dives (root roll/side offset + arms extended to the side and height), catch (hands to
chest), parry (palms out), keeper hold, wall jump, three distinct celebrations (knee slide, arms out "aeroplane", jump and
fist pump — original, generic), dejection (hands on head / crouch). The sim's dive direction/height maps to the matching dive
clip. Allocation-free.
Tests: unit — finite/within limits, dive extends hands toward the side, slide keeps the body near the ground; e2e visual check;
look at it.
