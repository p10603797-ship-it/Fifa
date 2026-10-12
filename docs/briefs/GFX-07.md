# GFX-07 — Player model and instancing
Owns: `src/render/players/model.ts`. Spec: BRIEF §8 Look ("Players are built in code from simple parts (head, torso, upper and
lower arms and legs, boots) and animated procedurally."), §13 ("Draw all 22 players with instanced meshes, one per body part,
with per-instance transform and colour. Kits and numbers come from one generated texture atlas."). Poses come from GFX-12
(mapper) as Pose arrays (contracts/render.ts PoseIdx). Contracts: src/contracts/app.ts (GameRenderer), render.ts (Pose, PoseIdx, POSE_SIZE, AnimId, PoseFn, RenderStats), state.ts (read-only sim state), events.ts, tuning T_CAMERA/T_PERF, settings.ts. Your stub was created by FND-05: read src/render/types.ts (RenderContext, RenderFrame, InterpState, RenderModule) and src/render/index.ts first; keep the module interface. Budgets (BRIEF §13): whole frame <= 80 draw calls and <= 200k triangles at the default tier, no per-frame allocation, unlit/Lambert materials, one directional light + ambient, no real-time shadow maps or post-processing at the default tier, textures total <= 64 MB. Readability beats realism (§8 Look). Original art only — no real stadiums, sponsors or commercial game visuals. Test pure logic (geometry builders, maths, pose functions) in Node; check visuals with Playwright screenshots (npx vite build && npx playwright test), and LOOK at your screenshots (Read the PNG) before reporting.
Implement: low-poly body parts (head, neck?, torso with shirt, pelvis/shorts, upper/lower arms, upper/lower legs (socks on
lower), boots, hands optional), one InstancedMesh per part type (22 instances each; left/right limbs can share a mesh with 44
instances), hierarchical transform computation per player per frame from the root (interpolated position + facing from
InterpState) and the Pose (forward kinematics with preallocated matrices; no allocation), per-instance colours or atlas UVs for
kits (GFX-08 provides atlas + per-team kit UV/colour info; shirt numbers on the back via atlas), height scaling per player
(attrs.height), keepers in keeper kits. Expose an API for GFX-12: setPose(slot, pose). Inactive (sent-off) players hidden.
<= 14 draw calls for all players, <= 30k triangles.
Tests: unit — FK maths (a zero pose stands upright; hip pitch swings the leg forward, etc.), allocation-free update; e2e
screenshot close-up via a debug camera hook; look at it (do players read as footballers at broadcast distance?).
