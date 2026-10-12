# SIM-15 — Action input resolution
Owns: `src/sim/control/resolve.ts` (+ optional helpers `src/sim/control/resolve*.ts`). Replace the Wave 0 baseline.
Spec: BRIEF §4 rule 2, §9 (all attack/defence/keeper/gesture/set-piece rows), §10 (all tables), §10 controller
quality bar ("A modifier combo resolves when the face button is pressed, never when the modifier is."; "Input
buffering: a press up to 6 ticks before the player can act still fires."); T_INPUT; contracts/input.ts (Btn,
BtnAlias, InputFrame fields), contracts/systems.ts (ActionRequest, ReqFlag).
Why: this is control feel. Every row of the touch and controller tables must work, through ONE deterministic path
used by touch, pads, keyboard, network and CPU.
Implement `resolveControllers(s, humanFrames, ev)` for controllers 0..3 (humans from frames, CPU from
teams[t].cpu.out):
1. Edge tracking: buttons/prevButtons, holdT[0..7], pressTick, releaseTick; stick mx/mz floats and stickIdleT.
2. Commands: cmd -> TAI-14 applyCommand (tactics/focus/formation), Command.SUBSTITUTE -> RUL-10 requestSub,
   Command.SKIP -> OR Btn.SKIP into ctrl.buttons for this tick (RUL-01 reads SKIP press edges of HUMAN
   controllers during cut-scenes and set-piece hints).
3. Restart phases: route the frame to SETPIECE_INPUT[restart.kind] (src/sim/rules/restart.ts) for both teams'
   controllers (taker side and defending side) and RUL-07 shootoutInput in SHOOT_OUT; nothing else.
4. Switching: call SIM-16 `switchTick(s, c, ev)` every tick (manual L1 in defence, RS flick directional, auto rules).
5. Movement intent for the controlled player when not locked by an action: DIRECT from the stick, sprint from SPRINT
   (R2), controlled sprint MOD_R held in attack (slower, tighter touches), strafe dribble (MOD_L held in attack or
   touch stickStrafe via ... the touch maps strafe to MOD_L hold), shield (SHIELD in attack with the ball -> SIM-05
   shielding/lookAt), jockey (SHIELD in defence -> lookAt the carrier), sprint jockey (SHIELD + SPRINT), contain (PASS
   held in defence -> move to shadow the carrier at ~2 m), teammate contain (MOD_R held -> ctrl.secondDef = best
   helper, TAI-05 reads it), keeper rush (THROUGH held -> GKP-03 startKeeperRush on own keeper), "Moving the stick near
   the carrier without sprinting contains him automatically (jockey)" (touch rule — apply for all).
6. Attack actions (owner or about to receive; buffered up to bufferTicks): PASS -> SIM-08 startPass (GROUND_PASS;
   MOD_R+PASS driven; PASS,PASS double-tap within doubleTapTicks dinked; MOD_L+PASS pass and go), LOB -> SIM-09
   startLob (MOD_L+LOB high lob; MOD_L+MOD_R+LOB driven lob/cross; LOB,LOB ground cross), THROUGH -> SIM-10
   (MOD_L+THROUGH lobbed; THROUGH,THROUGH dinked), SHOOT -> SIM-11 (MOD_R finesse, MOD_L chip, MOD_L+MOD_R power
   shot, second SHOOT tap while charging -> low driven), fake: SHOOT or LOB then PASS during wind-up -> SIM-13
   startFake; skills from frame.skill or RS patterns -> SIM-13 startSkill; knock-on SPRINT + RS_FLICK; stop ball:
   stick released + SPRINT; stop and face goal: stick released + MOD_L; trigger run MOD_L tap (no face button) ->
   TAI-03 triggerRun; call for support MOD_R tap -> TAI-02 callSupport. Modifiers are read at the FACE-button press
   edge. Aerial ball near the controlled player -> SIM-12 startHeader/startVolley (aerialChance). Ball arriving
   with a pass/shot press already held -> first-time (ReqFlag.FIRST_TIME).
   Power: while the initiating button stays held set p.actCharging = 1 and raise p.actPower by 1/powerFillTicks
   (fast power bar: powerFillTicksFast) per tick to 1; on release p.actCharging = 0. Explicit frame.power (touch
   swipes, gestures) sets power directly with charging 0. ctrl.powerBtn/power mirror it for the HUD.
7. Defence actions: SHOOT -> SIM-14 tackle (standing when goal-side; push/pull when chasing; shoulder alongside;
   clearance when a loose/high ball arrives in own third), MOD_R+SHOOT hard tackle, LOB -> slide (quick get-up on a
   second LOB press while fallen), touch swipe left on SPRINT&TACKLE = hard tackle arrives as MOD_R+SHOOT.
8. Keeper with the ball in hands (controlled keeper, ball.heldBy === slot): PASS throw, MOD_R+PASS driven throw,
   SHOOT or LOB drop kick, MOD_R+LOB driven kick, THROUGH drop at feet, MOD_R pick up (when the ball is at his feet
   inside the area) -> GKP-05 startKeeperRelease / keeperPickUp.
9. Gestures (frame.gesture with gx/gz decimetres, gSlot, gdx/gdz, gPower, gCurve, gFlags) per §9 Pitch gestures:
   attack: tap teammate/behind him -> ground pass to feet (targetSlot), tap space in front of a teammate -> through
   ball to that point, double-tap -> lobbed versions, crossing zone double-tap toward a post -> cross to near/far post,
   swipe toward goal -> shot (gPower = power/height), curved swipe -> finesse with curve, tap on goal (ON_GOAL) ->
   chip, back-and-forth swipe -> power shot, swipe in own half with the ball -> clearance; defence: tap the opposing
   carrier -> press him (contain/second defender), swipe in own half without the ball -> slide tackle, double-tap
   pitch -> second defender, tap own keeper (ON_OWN_KEEPER) -> keeper rush, tap a teammate -> switch to him (SIM-16
   switchTo).
Tests: one table-driven test per row of §9 attack/defence buttons and gestures and §10 movement/attacking/shooting/
defending/keeper tables (drive InputFrames into the real step pipeline and assert the started action kind/flags —
where the target module is still a stub, assert the starter was called with the right kind/request via a spy
on the module namespace or by checking p.act/p.actKick after the start); combo resolves at face press; buffering
within 6 ticks; power fill/release; double-tap windows; no stuck sprint after buttons drop; determinism.
Budget < 0.1 ms per tick.
