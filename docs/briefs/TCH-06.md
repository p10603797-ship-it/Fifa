# TCH-06 — Set-piece touch controls and flight preview
Owns: `src/input/touch/setpiece.ts`. Spec: BRIEF §9 Set pieces on touch:
- Kick-off: PASS.
- Corners and wide free kicks: tap a teammate or a spot in the box, or swipe from the ball. Swipe speed sets height and a
  curved swipe adds curl. PASS plays it short.
- Free kicks at goal: swipe from the ball toward the goal. Speed sets power and height; curve sets curl. Show a dotted preview
  of the first part of the flight.
- Penalties: swipe toward the part of the goal you want. Faster is harder to save and less accurate. To save one, tap or swipe
  the way the keeper should dive.
- Throw-ins and goal kicks: tap a teammate, or use the buttons.
Contracts: src/contracts/touch.ts (TouchIntentState, TouchButtonId, ClusterSlot/CLUSTER_SLOT, ClusterMode, TouchEdge, SwipeDir, TouchControl, push helpers), input.ts (InputFrame, Btn, BtnAlias, GestureFlag, quantAxis/quantUnit/quantPos), settings.ts (TouchSettings), tuning.ts T_TOUCHUI/T_INPUT. Your stub was created by FND-05 (read it and src/input/touch/index.ts first; keep the wiring working). Touch quality bar (BRIEF §9): every control responds on touch-down within one frame with a visible pressed state; five simultaneous touches work; stick, buttons and gestures never steal each other's touches; a thumb that slides off a held button keeps the hold until it lifts; pointercancel / lost capture / blur / visibilitychange release every held input (a stuck sprint or stick afterwards is a bug). Unit-test pure logic in Node with synthetic pointer sequences (no DOM); verify DOM behaviour with Playwright e2e (hasTouch, page.touchscreen or dispatched PointerEvents with pointerType 'touch').
Implement the set-piece swipe control (active when the mapper sets mode SET_PIECE): swipes starting on/near the ball's screen
position (projector.pitchToScreen of the ball) produce gestures with fromBall = true; while dragging, fill
TouchIntentState.preview* with the projected dotted path of the first ~1 s of flight — obtain it from RUL-05
`previewFlight` if it exists (else predict with SIM-01 predictBall from a launch estimated from the swipe), throttled to
every 2nd frame without allocation; taps on teammates/spots pass through as TAP gestures.
Tests: unit — swipe-from-ball detection, power/curve mapping monotonic, preview point count; e2e — a free-kick swipe
shoots and the preview appears during the drag.
