# TCH-02 — Floating virtual stick
Owns: `src/input/touch/stick.ts`. Spec: BRIEF §9 Layout ("Left half: a floating virtual stick that appears where the
thumb lands. Stick deflection is analogue: partial tilt jogs, full tilt runs. Releasing it stops the player."), "Double-tap
and hold the stick for a face-up (strafe) dribble", controls editor options fixed or floating stick (TouchSettings.floatingStick),
T_TOUCHUI.stickRadius. Contracts: src/contracts/touch.ts (TouchIntentState, TouchButtonId, ClusterSlot/CLUSTER_SLOT, ClusterMode, TouchEdge, SwipeDir, TouchControl, push helpers), input.ts (InputFrame, Btn, BtnAlias, GestureFlag, quantAxis/quantUnit/quantPos), settings.ts (TouchSettings), tuning.ts T_TOUCHUI/T_INPUT. Your stub was created by FND-05 (read it and src/input/touch/index.ts first; keep the wiring working). Touch quality bar (BRIEF §9): every control responds on touch-down within one frame with a visible pressed state; five simultaneous touches work; stick, buttons and gestures never steal each other's touches; a thumb that slides off a held button keeps the hold until it lifts; pointercancel / lost capture / blur / visibilitychange release every held input (a stuck sprint or stick afterwards is a bug). Unit-test pure logic in Node with synthetic pointer sequences (no DOM); verify DOM behaviour with Playwright e2e (hasTouch, page.touchscreen or dispatched PointerEvents with pointerType 'touch').
Implement the stick TouchControl: origin at touch-down (floating) or fixed origin; vector = (thumb - origin) / radius with a
small radial dead zone and radial clamp; the origin follows when the thumb exceeds 1.4x radius (drag-along) so long pushes
keep working; double-tap (two downs within T_TOUCHUI.doubleTapMs) then hold sets stickStrafe; release -> stickActive false,
stick zero; writes TouchIntentState stick fields every move (no allocation). Respect mirror (left-handed: stick zone on the
right half) and safe areas/system-gesture margins (never start within 24 pt of the bottom edge... the stick can start
anywhere in its zone except the margin).
Tests: unit — vector maths, dead zone, clamp, drag-along, double-tap-hold strafe, release zeroes; e2e — drag moves the
controlled player, release stops him, pointercancel mid-drag stops him.
