# Integration issues (input for Wave 2 INT agents and Wave 3/4)

Collected from Wave 1 reports. Each line: area — symptom — proposed owner/fix.

## Gameplay feel (bot-v-bot evidence)
- Shots — 0-2 shots per 3 game minutes; carriers end near the corner flags, play rarely reaches central shooting zones. Owners: TAI-01 shape, TAI-02/03 support and runs, TAI-09 cross options, TAI-08 carrier weights. Target §7: 14-26 shots/match.
- Possession — about 22/78 split in several seeds. Investigate CPU defending/pressing balance and carrier retention (shield) per team side; target 40-60.
- Head tennis — HEADER_PASS chains for 16-26 s with the ball at 2-6 m (SIM-12 automatic headers). Fix: aim header passes down to feet; chest/foot a dropping ball when no button is pressed.
- Receiver trailing — SIM-15 resolveMove receiver with idle stick ARRIVEs at a moving meet point and trails a ball rolling away (1-1.8 m behind for 150 ticks). TAI-07 CHASE_LOOSE has the same risk. Fix: DIRECT movement at target speed when the ball is ahead and moving away; regression: a 7.5 m/s pass 1.5 m past the receiver is collected within 75 ticks.
- Human receiver slowdown — SIM-15 resolveMove meetPoint uses jog speed for an idle-stick receiver; a sprinting receiver drops from 9 to 5.5 m/s and a led pass goes past him (SIM-08 report). Use top/current speed and prefer ball.passX/passZ.
- PASS_COMPLETE also counts header passes and throw-ins; pass-completion stats are inflated (stats definition, MOD-05/FND-06 report).
- Long shots — threshold lowered (T_LEVEL.shotThresholdXg) so 0.02-0.05 xG long shots can pass the CPU gate.

## Wiring the lead / INT agents must do
- devices.ts createBoundPadSource must pass `settings: opts.settings` (PAD-02 CR 1) so pad remaps apply.
- Session pause: call releaseAll() on every input source synchronously inside onPause; ignore onPause while already paused (PAD-02 CR 2).
- render/index.ts: pass hooks.setTier and lowPowerSuspected to createQuality (GFX-02 CR 1); choose one Low Power detector (GFX-02 vs platform/ipados) (GFX-02 CR 3); MSAA needs context recreation (GFX-02 CR 2).
- render/index.ts: module rebuild after WebGL context restore (GFX-01 CR 1/2); block resume until restore (GFX-01 CR 3).
- TCH-09 overlay must draw per-slot labels from the TCH-04 cluster controller and the TCH-06 preview dots.
- keeperTick order: GKP-03 come-out vs GKP-01 positioning overwrite (GKP-01 risk 2).
- TAI-14 assistedReceiver should require team.chaser === receiver (TAI-07 CR).
- ai/index.ts: pressSlot/coverSlot stale during restarts (TAI-05 CR).
- TAI-01 does not read DAT-04 tactics presets (TAI-01 gap 2): decide which shape source wins.
- Allocation in V8: estimateXg, evalIntercept, ticksToReachAtSpeed, SIM-10 throughLeadPoint allocate 150-1000 B per call (boxing); JSC on iPad likely fine but TAI-09 budget test fails on the runners case.
- Lead applied: model.ts default driver = GFX-12 createAnimDriver; gfx-07 tests updated; boot focus onMove -> UiSound.MOVE; fnd-04 tests updated for crowd ducking and AudioBuffer fakes.
- Router back sound (AUD-05 CR 2, optional) and sfx.setCameraX from the renderer (AUD-03) still to wire.
- tests/unit/fnd-04-review-fixes.test.ts recovery-screen cases fail while PLT-05 rewrites src/ui/screens/recovery.ts — PLT-05 must keep or update those FND-04 expectations.
- Online crowd perspective: crowd backs home side in online 1v1 (AUD-02 risk).
