# INT-C — Sim to render integration in a live match (INT-03 + render wiring CRs)

Owns for this wave: `src/render/**` (all GFX owners are finished; you are the single integrator for render), plus new
tests `tests/**/int-c-*.test.ts` / `tests/e2e/int-c-*.spec.ts`.

Goal (BRIEF §8, §13): in a real match (vite build, Playwright Chromium, iPad viewport 1180x820, DPR 1), everything
the render modules built shows up correctly and together: players animated by the GFX-12 driver (no foot sliding,
kicks meeting the ball), kits without clashes, pitch/goals/stadium/crowd, ball and markers, broadcast camera with
correct framing, set-piece/establishing/replay cameras, replays after goals, effects; within budgets (<= 80 draw
calls, <= 200k triangles, no per-frame allocation in steady play).
Wiring to do (docs/INTEGRATION_ISSUES.md render items): createQuality hooks.setTier + lowPowerSuspected (coordinate with
platform: exactly one Low Power hint path — GFX-02's detector; PLT is wiring the toast), MSAA only via context creation
(decide: skip MSAA or recreate on tier change at loading), module rebuild after WebGL context restore and block resume
until restore (GFX-01 CRs), sfx camera x for audio panning (expose the broadcast camera x via a renderer getter; the app
INT agent will connect it to audio), GFX-15 establishing() entry points for kick-off/full time if useful.
Verify with screenshots you LOOK at: kick-off, open play mid-pitch, attack near the box, corner, free kick, goal +
replay, night match. Measure draw calls/triangles in each. Fix visual bugs you see (z-fighting, popping, wrong facing,
markers misplaced, camera clipping into stands, ball hidden under touch controls).
Report: screenshots reviewed (paths), budget numbers per scene, fixes made, remaining issues.
