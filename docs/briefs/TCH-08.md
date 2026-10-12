# TCH-08 — Controls editor and touch settings
Owns: `src/input/touch/editor.ts` (Screen 'controls-editor'). Spec: BRIEF §9 quality bar ("Controls editor in settings: drag to
reposition, size, spacing, opacity, mirror for left-handers, fixed or floating stick, gestures on or off, fast power bar,
auto-switch level, and reset."), §12 UI rules (touch alone + controller alone, focus ring, Back always works, 60 pt targets),
contracts/settings.ts TouchSettings + ControlSettings.autoSwitch, ctx.settings (SettingsStore). Contracts: src/contracts/touch.ts (TouchIntentState, TouchButtonId, ClusterSlot/CLUSTER_SLOT, ClusterMode, TouchEdge, SwipeDir, TouchControl, push helpers), input.ts (InputFrame, Btn, BtnAlias, GestureFlag, quantAxis/quantUnit/quantPos), settings.ts (TouchSettings), tuning.ts T_TOUCHUI/T_INPUT. Your stub was created by FND-05 (read it and src/input/touch/index.ts first; keep the wiring working). Touch quality bar (BRIEF §9): every control responds on touch-down within one frame with a visible pressed state; five simultaneous touches work; stick, buttons and gestures never steal each other's touches; a thumb that slides off a held button keeps the hold until it lifts; pointercancel / lost capture / blur / visibilitychange release every held input (a stuck sprint or stick afterwards is a bug). Unit-test pure logic in Node with synthetic pointer sequences (no DOM); verify DOM behaviour with Playwright e2e (hasTouch, page.touchscreen or dispatched PointerEvents with pointerType 'touch').
Implement createControlsEditorScreen(): a full-screen editor showing the cluster and stick in their current positions over a
dimmed pitch; drag any control to reposition (clamped inside safe areas and 24 pt system-gesture margins, buttons never
overlapping, >= 12 pt gaps), per-control size slider (0.7-1.4), spacing, opacity, mirror toggle, fixed/floating stick,
gestures on/off (+ per-gesture toggles, Gestures Only), fast power bar, auto-switch level (Off / Air and loose / Auto),
skill slot pickers (tap / swipe up / swipe right from the eight moves), Reset to defaults; saves to settings.controls.touch
via ctx.settings.update; works with a controller (focus moves between controls; D-pad nudges the focused control).
Tests: pure layout validation helpers (clamping, overlap resolution, mirror) in unit tests; e2e — drag a button, reload,
position persists; reset restores defaults; controller-only navigation works.
