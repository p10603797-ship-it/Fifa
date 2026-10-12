# TCH-09 — Touch overlay rendering
Owns: `src/input/touch/overlay.ts`, `src/input/touch/overlay.css`. Spec: BRIEF §9 Layout + quality bar ("Every control responds
on touch-down within one frame, with a visible pressed state. The power bar shows by the player and on the button."; "Touch
controls hide when a controller is driving that side and return on the next screen touch."), §12 visual identity (ink #07070D,
ember #FF6B35, thin hairlines, plain-word labels — no commercial game look), §3 safe areas. Contracts: src/contracts/touch.ts (TouchIntentState, TouchButtonId, ClusterSlot/CLUSTER_SLOT, ClusterMode, TouchEdge, SwipeDir, TouchControl, push helpers), input.ts (InputFrame, Btn, BtnAlias, GestureFlag, quantAxis/quantUnit/quantPos), settings.ts (TouchSettings), tuning.ts T_TOUCHUI/T_INPUT. Your stub was created by FND-05 (read it and src/input/touch/index.ts first; keep the wiring working). Touch quality bar (BRIEF §9): every control responds on touch-down within one frame with a visible pressed state; five simultaneous touches work; stick, buttons and gestures never steal each other's touches; a thumb that slides off a held button keeps the hold until it lifts; pointercancel / lost capture / blur / visibilitychange release every held input (a stuck sprint or stick afterwards is a bug). Unit-test pure logic in Node with synthetic pointer sequences (no DOM); verify DOM behaviour with Playwright e2e (hasTouch, page.touchscreen or dispatched PointerEvents with pointerType 'touch').
Implement the DOM overlay: stick (base ring + thumb, shown at the floating origin), the four cluster buttons with plain-word
labels per mode (PASS, THROUGH, SHOOT, SPRINT & SKILL / SPRINT & TACKLE, SLIDE or CLEAR, SWITCH, 2ND DEF), pause button top
right; pressed state applied synchronously in the pointerdown path (class toggle) and verified within one frame; power ring
on the pressed button from intent.power; swipe direction hints (arrows) during the first matches; opacity/size from settings;
hide when intent.hiddenByPad; animate only transform/opacity; write the DOM only on change; positions respect
env(safe-area-inset-*) and the 24 pt margins, never overlapping the HUD regions (scoreboard top-left, radar bottom-centre).
Tests: e2e — pressed state within one frame of pointerdown (rAF timestamp), labels swap with possession, hides when a mocked
pad drives the side and returns on touch, layout inside the safe area at 4:3, 16:10 (iPad), 21:9 viewports; no layout thrash
(count style recalcs via Performance API if possible).
