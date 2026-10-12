# TCH-01 — Pointer manager
Owns: `src/input/touch/pointers.ts`. Spec: BRIEF §3 Touch lifecycle, §9 Layout + quality bar ("A gesture counts only
when it starts outside the stick zone and the button cluster"). Contracts: src/contracts/touch.ts (TouchIntentState, TouchButtonId, ClusterSlot/CLUSTER_SLOT, ClusterMode, TouchEdge, SwipeDir, TouchControl, push helpers), input.ts (InputFrame, Btn, BtnAlias, GestureFlag, quantAxis/quantUnit/quantPos), settings.ts (TouchSettings), tuning.ts T_TOUCHUI/T_INPUT. Your stub was created by FND-05 (read it and src/input/touch/index.ts first; keep the wiring working). Touch quality bar (BRIEF §9): every control responds on touch-down within one frame with a visible pressed state; five simultaneous touches work; stick, buttons and gestures never steal each other's touches; a thumb that slides off a held button keeps the hold until it lifts; pointercancel / lost capture / blur / visibilitychange release every held input (a stuck sprint or stick afterwards is a bug). Unit-test pure logic in Node with synthetic pointer sequences (no DOM); verify DOM behaviour with Playwright e2e (hasTouch, page.touchscreen or dispatched PointerEvents with pointerType 'touch').
Implement a PointerManager: listens on the touch root with Pointer Events (pointerdown/move/up/cancel, lostpointercapture)
using setPointerCapture; routes each pointer id to exactly one TouchControl chosen at pointerdown by zone priority
(buttons > stick zone (left half) > pitch gestures (everywhere else)); per-pointer bookkeeping in a fixed-size table (10
pointers) with no per-event allocation; releases ALL controls (control.releaseAll) on window blur, visibilitychange
hidden, pagehide, orientation change and resize mid-hold; ignores mouse buttons other than primary; prevents default on
the game surface (no scroll/zoom/selection/callout). Export a pure routing core (testable in Node) plus the DOM binding.
Tests: unit — routing by zone, five simultaneous pointers, cancel releases only that pointer's control, blur releases all,
capture loss; e2e — multi-touch with page.touchscreen / dispatched events, no stuck sprint after pointercancel mid-hold.
