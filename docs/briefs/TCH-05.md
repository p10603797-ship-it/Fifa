# TCH-05 — Pitch gestures
Owns: `src/input/touch/gestures.ts`. Spec: BRIEF §9 Pitch gestures (on by default, each can be turned off, Gestures Only hides
PASS/THROUGH/SHOOT; a gesture counts only when it starts outside the stick zone and the button cluster):
| Gesture | Result |
| Tap a teammate, or just behind him | Ground pass to feet |
| Tap the space in front of a teammate | Through ball into that space |
| Double-tap either of those | The lobbed version |
| In the crossing zone, double-tap toward a post | Cross to the near or far post |
| Swipe toward goal | Shot; a faster swipe is harder and higher |
| Curved swipe toward goal | Finesse shot that bends with the swipe |
| Tap on the goal | Chip shot |
| Quick back-and-forth swipe toward goal | Power shot |
| Tap the opposing ball carrier | Press him |
| Swipe in your own half without the ball | Slide tackle |
| Swipe in your own half with the ball | Clearance |
| Double-tap the pitch when defending | Second defender |
| Tap your keeper when defending | Keeper rushes out |
| Tap a teammate when defending | Switch to him |
Contracts: src/contracts/touch.ts (TouchIntentState, TouchButtonId, ClusterSlot/CLUSTER_SLOT, ClusterMode, TouchEdge, SwipeDir, TouchControl, push helpers), input.ts (InputFrame, Btn, BtnAlias, GestureFlag, quantAxis/quantUnit/quantPos), settings.ts (TouchSettings), tuning.ts T_TOUCHUI/T_INPUT. Your stub was created by FND-05 (read it and src/input/touch/index.ts first; keep the wiring working). Touch quality bar (BRIEF §9): every control responds on touch-down within one frame with a visible pressed state; five simultaneous touches work; stick, buttons and gestures never steal each other's touches; a thumb that slides off a held button keeps the hold until it lifts; pointercancel / lost capture / blur / visibilitychange release every held input (a stuck sprint or stick afterwards is a bug). Unit-test pure logic in Node with synthetic pointer sequences (no DOM); verify DOM behaviour with Playwright e2e (hasTouch, page.touchscreen or dispatched PointerEvents with pointerType 'touch').
Implement the pitch gesture recogniser TouchControl: classify each pointer path into GestureKind TAP, DOUBLE_TAP, SWIPE,
CURVED_SWIPE, BACK_FORTH_SWIPE with start/end, end velocity and signed curvature (fit over the path samples kept in a
fixed ring buffer), and push TouchGestureEvents (screen space). Thresholds from T_TOUCHUI (tapMaxPt, tapMaxMs, doubleTapMs).
Respect settings.touch.gestures / gestureEnabled per rule. Semantic resolution (which player/point, own half...) happens in
the mapper (TCH-07) + sim (SIM-15); you produce clean geometric gestures.
Tests: unit — classification of synthetic paths (taps, double taps, straight/curved/back-and-forth swipes, slow drags ignored),
curvature sign, velocity; e2e — a swipe on the pitch produces a gesture event and does not move the stick.
