# TCH-07 — Touch to InputFrame mapping
Owns: `src/input/touch/mapper.ts`, `src/input/touch/index.ts`. Spec: BRIEF §9 (all tables), §4 rule 2, contracts/input.ts
(positional-semantic bits: PASS = A, SHOOT = B, LOB = X, THROUGH = Y, MOD_L = L1, MOD_R = R1, SHIELD = L2, SPRINT = R2;
SIM-15 resolves the meaning from context exactly as for a controller). Contracts: src/contracts/touch.ts (TouchIntentState, TouchButtonId, ClusterSlot/CLUSTER_SLOT, ClusterMode, TouchEdge, SwipeDir, TouchControl, push helpers), input.ts (InputFrame, Btn, BtnAlias, GestureFlag, quantAxis/quantUnit/quantPos), settings.ts (TouchSettings), tuning.ts T_TOUCHUI/T_INPUT. Your stub was created by FND-05 (read it and src/input/touch/index.ts first; keep the wiring working). Touch quality bar (BRIEF §9): every control responds on touch-down within one frame with a visible pressed state; five simultaneous touches work; stick, buttons and gestures never steal each other's touches; a thumb that slides off a held button keeps the hold until it lifts; pointercancel / lost capture / blur / visibilitychange release every held input (a stuck sprint or stick afterwards is a bug). Unit-test pure logic in Node with synthetic pointer sequences (no DOM); verify DOM behaviour with Playwright e2e (hasTouch, page.touchscreen or dispatched PointerEvents with pointerType 'touch').
Implement TouchInputSource.sample(out, ctx): each tick, (1) choose ClusterMode from ctx.state (own team possession ->
ATTACK; opponent possession or loose and opponent closer -> DEFENCE; own keeper holds the ball and this human controls
him -> KEEPER; restart phase where this human takes/defends -> SET_PIECE; cut-scenes -> HIDDEN) and set intent.mode +
clearOn (CLEAR when this human's player is about to reach a loose/high ball in his own third); (2) stick -> mx/mz via
quantAxis with screen x -> +x and screen y -> +z rotated by projector.stickRotation(); stickStrafe -> MOD_L held; (3) drain
button events and translate each table cell into bits held for the right number of ticks (the sim resolves holds/edges):
attack PASS tap/hold -> PASS (held while the finger is down for power); swipe up -> LOB; swipe down -> MOD_L+PASS (pass and
go); swipe left -> MOD_L+MOD_R+LOB (driven lob / ground cross in zone); swipe right -> MOD_R+PASS (driven ground pass / low
cross); double-tap -> two PASS presses (PASS,PASS); THROUGH tap/hold -> THROUGH; swipe up -> MOD_L+THROUGH; swipe down ->
MOD_L tap (trigger run); double-tap -> THROUGH,THROUGH; SHOOT tap/hold -> SHOOT; up -> MOD_L+SHOOT (chip); down ->
MOD_R+SHOOT (finesse); left -> SHOOT then PASS (fake shot); right -> MOD_L+MOD_R+SHOOT (power shot); SPRINT & SKILL hold ->
SPRINT, tap -> frame.skill = settings skillTap, swipe up -> skillUp, swipe right -> skillRight, swipe down -> SkillMove.KNOCK_ON,
swipe left -> SkillMove.HARD_STOP; defence SPRINT & TACKLE tap -> SHOOT (tackle), hold -> SPRINT, swipe left -> MOD_R+SHOOT
(hard tackle); SLIDE -> LOB; CLEAR -> SHOOT? (clearance: SIM-15 maps SHOOT in own third with a loose/high ball to clearance —
use SHOOT); SWITCH tap -> MOD_L; SWITCH swipe -> RS_FLICK with ax/az from the swipe direction (pitch space); 2ND DEF tap/hold
-> MOD_R held; 2ND DEF swipe down -> THROUGH held (keeper rush); keeper mode PASS -> PASS (throw), THROUGH -> MOD_R+PASS
(driven throw), SHOOT -> SHOOT (drop kick), SPRINT & SKILL -> THROUGH (drop at feet); for swipes use frame.power when the
finger lifts immediately (explicit power), else hold; (4) gestures -> frame.gesture with pitch coordinates (projector.
screenToPitch -> quantPos decimetres), gSlot = nearest player to the target point within 1.5 m (teammate or opponent carrier
or own keeper), gdx/gdz (swipe direction in pitch space), gPower (speed), gCurve, gFlags (FROM_BALL, ON_GOAL if the target
is within the goal mouth area, ON_OWN_KEEPER); (5) PAUSE button -> opts.onPause; (6) intent.power/powerButton for the overlay
from ctx.state.ctrl[human].power. releaseAll() clears everything. index.ts createTouchInput composes TCH-01..09 and
returns the InputSource + overlay lifecycle (keep FND-05's API used by src/input/devices.ts).
Tests: table-driven unit tests: synthetic TouchIntentState events -> expected InputFrame bits for EVERY cell of the attack,
defence, keeper and gesture tables (one test per row), mode selection, explicit power, no stuck bits after release/cancel.
