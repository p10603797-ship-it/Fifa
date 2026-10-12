# TCH-03 — Touch buttons and the attack cluster
Owns: `src/input/touch/button.ts` (generic touch button control), `src/input/touch/attack.ts`. Spec: BRIEF §9 Layout
(large button 96 pt, small 76 pt, >= 12 pt apart, inside the safe area; bottom right big button with three smaller buttons
fanned in an arc above and to its left), Attack buttons table:
| Button | Tap or hold | Swipe up | Swipe down | Swipe left | Swipe right | Double-tap |
| PASS | Ground pass; hold for power | Lob pass; a cross in the crossing zone | Pass and go | Driven lob; a ground cross in the crossing zone | Driven ground pass; a low cross in the crossing zone | Dinked pass |
| THROUGH | Through ball; hold for power | Lobbed through ball | Trigger a teammate's run |  |  | Dinked through ball |
| SHOOT | Shot, volley or header; hold for power | Chip shot | Finesse shot | Fake shot | Power shot |  |
| SPRINT & SKILL (large) | Hold to sprint; tap for a skill move | Skill move | Knock-on | Hard stop | Skill move |  |
Quality bar: "A swipe that starts on a button is a button swipe, recognised at 24 pt of travel. Show direction hints on a
250 ms hold during the first few matches." Contracts: src/contracts/touch.ts (TouchIntentState, TouchButtonId, ClusterSlot/CLUSTER_SLOT, ClusterMode, TouchEdge, SwipeDir, TouchControl, push helpers), input.ts (InputFrame, Btn, BtnAlias, GestureFlag, quantAxis/quantUnit/quantPos), settings.ts (TouchSettings), tuning.ts T_TOUCHUI/T_INPUT. Your stub was created by FND-05 (read it and src/input/touch/index.ts first; keep the wiring working). Touch quality bar (BRIEF §9): every control responds on touch-down within one frame with a visible pressed state; five simultaneous touches work; stick, buttons and gestures never steal each other's touches; a thumb that slides off a held button keeps the hold until it lifts; pointercancel / lost capture / blur / visibilitychange release every held input (a stuck sprint or stick afterwards is a bug). Unit-test pure logic in Node with synthetic pointer sequences (no DOM); verify DOM behaviour with Playwright e2e (hasTouch, page.touchscreen or dispatched PointerEvents with pointerType 'touch').
Implement button.ts `createTouchButton(opts)`: a TouchControl that recognises DOWN (immediately, pressed state), TAP (release
< T_INPUT.tapTicks-equivalent ms and < tap travel), HOLD (past tap time), DOUBLE_TAP (second tap within doubleTapMs), SWIPE
with SwipeDir once travel >= buttonSwipePt (finger may stay down; the hold continues for power), UP, CANCEL; slides off the
button keep the hold; records the ClusterMode at DOWN in each event (a thumb keeps its meaning until it lifts); pushes events
into TouchIntentState (pushButtonEvent) and maintains held/downAt. attack.ts: builds the attack cluster's four buttons with
geometry from layout settings (ClusterSlot positions; defaults per the brief), hint arrows on a 250 ms hold while
settings.touch.hintMatchesLeft > 0 (emit a hint flag the overlay draws).
Tests: unit — recogniser state machine for every row/column of the table (synthetic pointer paths), thresholds, slide-off,
cancel, double-tap window; e2e — pressed state within one frame (measure via rAF), swipes recognised.
