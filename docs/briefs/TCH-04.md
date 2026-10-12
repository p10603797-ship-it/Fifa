# TCH-04 — Defence and keeper buttons, attack-defence swap
Owns: `src/input/touch/cluster.ts`. Spec: BRIEF §9 Defence buttons:
| Button | Tap | Hold | Swipe |
| SPRINT & TACKLE (large) | Standing tackle when goal-side of the carrier; push or pull when chasing | Sprint, and press the carrier when close | Left: hard tackle |
| SLIDE | Slide tackle |  |  |
| SWITCH | Switch to the best-placed defender |  | Any direction: switch that way |
| 2ND DEF | Call a second defender | Keep him pressing | Down: keeper rushes out |
"Moving the stick near the carrier without sprinting contains him automatically (jockey)." "CLEAR replaces SLIDE whenever a
first-time clearance is on: your player is about to reach a loose or high ball in your own third." "The right-hand cluster
swaps the moment possession changes. A thumb already down keeps its old meaning until it lifts." Keeper with the ball: "PASS
throws, THROUGH is a driven throw, SHOOT is a drop kick, and SPRINT & SKILL drops the ball at his feet." Contracts: src/contracts/touch.ts (TouchIntentState, TouchButtonId, ClusterSlot/CLUSTER_SLOT, ClusterMode, TouchEdge, SwipeDir, TouchControl, push helpers), input.ts (InputFrame, Btn, BtnAlias, GestureFlag, quantAxis/quantUnit/quantPos), settings.ts (TouchSettings), tuning.ts T_TOUCHUI/T_INPUT. Your stub was created by FND-05 (read it and src/input/touch/index.ts first; keep the wiring working). Touch quality bar (BRIEF §9): every control responds on touch-down within one frame with a visible pressed state; five simultaneous touches work; stick, buttons and gestures never steal each other's touches; a thumb that slides off a held button keeps the hold until it lifts; pointercancel / lost capture / blur / visibilitychange release every held input (a stuck sprint or stick afterwards is a bug). Unit-test pure logic in Node with synthetic pointer sequences (no DOM); verify DOM behaviour with Playwright e2e (hasTouch, page.touchscreen or dispatched PointerEvents with pointerType 'touch').
Implement the cluster controller: owns the four slot buttons (using TCH-03's createTouchButton) and swaps their identity
(TouchButtonId + label) between ATTACK / DEFENCE / KEEPER / SET_PIECE / HIDDEN modes when TouchIntentState.mode changes
(set by the mapper each frame), without stealing or re-interpreting a pointer already down; CLEAR label when clearOn;
SWITCH swipes carry direction; exposes the current labels for the overlay. Export pure helpers for the swap rule.
Tests: unit — swap rule (thumb down keeps meaning), CLEAR toggle, keeper mode identities, switch swipe directions; e2e —
possession change mid-hold keeps the held meaning until release.
