# SIM-07 — First touch, trapping and aerial control
Owns: `src/sim/players/firstTouch.ts`. Spec: BRIEF §6 Possession ("First touch depends on ball speed and height,
the control attribute, pressure, and whether sprint is held."); T_TOUCH.
Implement `receiveContacts`, `touchQuality`, FIRST_TOUCH handler:
- Candidates: the intended receiver (ball.passTarget), the team chaser (team.chaser), human/CPU-controlled players,
  and the keeper only if GKP did not claim. A moving ball (speed > ~3 m/s, or airborne below trapHeight) reaching a
  candidate's reach (receiveRadius, height-aware: feet < 0.6 m, thigh/chest < trapHeight) triggers a first touch,
  unless ballTouchedThisTick. Quality (0..1) from ball speed vs hardBallSpeed, height, ballControl, pressure
  (query.pressureOn), sprint held (worse), facing vs ball. Outcomes: clean (takePossession, ball settled ahead in
  the movement/stick direction), heavy (ball knocked 1..heavyTouchMax m with deterministic error; possession not
  kept), miss (ball passes). Emit PASS_COMPLETE when a teammate of the last kicker controls a pass
  (b = lastKickBy) — this is the pass-completion stat.
- FIRST_TOUCH action: short animation window (firstTouchTicks), movement slowed, no other action.
- First-time actions: if the receiver has a buffered pass/shot (resolver set p.act to KICK/SHOT charging before the
  ball arrived with ReqFlag.FIRST_TIME), do NOT trap: leave the ball for SIM-08/11 contact.
Tests: clean traps of soft passes; hard balls bounce off weak players more often (deterministic RNG over many
seeds); sprinting heavier; aerial chest trap; PASS_COMPLETE emitted once; no double contact per tick.
