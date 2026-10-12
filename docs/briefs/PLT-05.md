# PLT-05 — Recovery screen, diagnostics, input tester, benchmark screen, debug overlay
Owns: `src/platform/recovery.ts`, `src/platform/diagnostics.ts`, `src/ui/screens/diagnostics.ts`, `src/ui/screens/recovery.ts`, `src/ui/debugOverlay.ts`.
Spec: BRIEF §4 rule 7 ("Debug tools ship in the build behind a hidden toggle: frame-time graph, sim and render milliseconds, draw calls, input viewer (touch
points, pad buttons and axes), state hash, and replay save and load (seed plus inputs)."), §14 point 8 ("a global error handler that pauses to a recovery
screen (resume, restart match, copy diagnostics)"), §12 Settings > Diagnostics (benchmark, input tester, replay save and load, version), §13 benchmark
(FND-06 benchHook; your screen launches it). Stubs by FND-04/FND-06 (read src/platform/* and public/*). BRIEF §3 (target device and iPadOS behaviours), §4 build output, §19 deliverables.
Implement: recovery (global error + unhandledrejection -> pause -> recovery screen with Resume (if the state is sane), Restart match, Copy diagnostics, Main
menu; loop guard so an error inside the recovery screen cannot loop), diagnostics (ring buffer log with levels, report(): version, UA, device, settings,
recent log, current seed/tick/hash), diagnostics screen (version, run benchmark (navigates to ?bench=1 or starts it in place), input tester (live view of
touch points, pad buttons/axes per connected pad, keyboard), replay save (download JSON via a Blob link) and load (file input -> play the replay in a match
session)), debug overlay (hidden toggle: backquote key or 5 taps top-left within 2 s; frame-time graph on a small canvas, sim/render ms, draw calls,
triangles, resolution scale, state hash every 30 ticks, current phase/tick; costs nothing when hidden).
Tests: e2e — a thrown error during a match shows the recovery screen and Resume/Restart work; input tester shows a mocked pad; replay save/load round trip;
overlay toggles and shows numbers.
