# GFX-08 — Kits, numbers, crests, atlas, clash check
Owns: `src/render/kits.ts`. Spec: BRIEF §8 Look ("Kits: home, away and keeper kits with a colour and a pattern (plain, stripes,
hoops, halves, sash). An automatic clash check picks kits by colour distance, including against the grass and the other
keeper."; bold kit colours, clear numbers, strong contrast with the grass), §13 (one generated texture atlas), §12 Accessibility
(high-contrast kits), contracts/data.ts Kit/Crest. Contracts: src/contracts/app.ts (GameRenderer), render.ts (Pose, PoseIdx, POSE_SIZE, AnimId, PoseFn, RenderStats), state.ts (read-only sim state), events.ts, tuning T_CAMERA/T_PERF, settings.ts. Your stub was created by FND-05: read src/render/types.ts (RenderContext, RenderFrame, InterpState, RenderModule) and src/render/index.ts first; keep the module interface. Budgets (BRIEF §13): whole frame <= 80 draw calls and <= 200k triangles at the default tier, no per-frame allocation, unlit/Lambert materials, one directional light + ambient, no real-time shadow maps or post-processing at the default tier, textures total <= 64 MB. Readability beats realism (§8 Look). Original art only — no real stadiums, sponsors or commercial game visuals. Test pure logic (geometry builders, maths, pose functions) in Node; check visuals with Playwright screenshots (npx vite build && npx playwright test), and LOOK at your screenshots (Read the PNG) before reporting.
Implement: atlas generation on a canvas (OffscreenCanvas where available): per team shirt texture with pattern, shorts, socks,
numbers 1-99 in a clear sans (generated digits with a bold stroke/outline for contrast; no external font needed in the atlas
or use the inlined UI font if available), crest images (geometric: shapes/emblems from Crest data) for HUD/menus too (export
crestDataUrl(club) cached); clash check: perceptual colour distance (CIE76/CIEDE2000-lite in Lab) between home/away shirt and
shorts, each vs grass green, keeper vs both outfield kits and the other keeper -> pick away/keeper2 kits as needed and expose
the resolved kits; high-contrast mode boosts saturation/brightness differences. Atlas <= 2048x2048.
Tests: unit — clash check table (same colours clash, complementary pass, grass clash with green kits), colour maths; e2e
screenshot of both teams; look at it.
