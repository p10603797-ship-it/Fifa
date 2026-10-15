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

## Online (NET-B report) — app-side CRs (applied by the lead after INT-B: splash share link, pause hides Restart online, online Rematch label, crowd backs the local online side, GameRenderer.cameraX optional in the contract)
- splash.ts: after `ctx.router.replace('main')`, `const room = shareLinkRoom(); if (room) ctx.router.go('online-lobby', { room });` (import from ./online).
- pause.ts: hide 'Restart match' when online (session.restart() does nothing with a custom provider).
- fullTime.ts: label the online 'Change teams' button 'Rematch' (back to the room; hint 'Back to the room with your friend').
- Audio crowd perspective online: local human = (setup.modeData as {session?: {localHuman: number}}).session?.localHuman; local side = setup.config.humans[localHuman].side.
- Optional: match HUD mounts createNetIndicator().el (online.ts overlay already shows the pill).
- Lead applied: session.load passes getProjector to custom providers (setProjector).
- QF-6: transport.ts rejoin race ($full answer to an early re-dial must stay retryable; host replaces the link when the same peer reconnects); silence timeout 6 s reads long warm-up stalls as disconnects (10 s or pause the check while hidden / during warm-up).

## From INT-B
- Practice hooks run in the app tick (loop stepWithModes / prepareModeState); move preparePracticeState into sim/init and practiceRulesTick into sim/step after rulesTick (INT-A / QF-1), then make stepWithModes a plain step.
- Swipe-hint labels around the bottom-right big button go partly off screen (first matches only) — QF-3/QF-4.
- Keyboard bound to the same human does not hide touch controls (pads only) — QF-3.
- aud-05-alloc, pad-08-alloc, tch-06-alloc allocation tests are load-sensitive (fail at load 16+) — QF-7.

## From QF-3
- int-b-app 'corner practice through the plain sim step never sees a corner' fails once QF-1 moves the practice hooks into src/sim; update that test and make src/app/loop.ts stepWithModes a plain step after QF-1 (lead or QF-5).
- Suggestion: side select could offer the remap screen for a non-standard pad with no saved remap.
- Loose-ball cluster swap waits looseSwapTicks (133 ms) — labels may briefly differ from the sim's context (deliberate anti-flicker).

## From QF-5 / QF-6 (applied by the lead unless noted)
- Diagnostics: Credits and licences button (createCreditsView) — applied.
- review-fnd-06-tools postbuild fixture has an inline module script — applied.
- net-07-online e2e share-link step follows the splash change — applied.
- Pause: refusal while the GPU context restores says 'Graphics are restarting' — applied.
- OPEN for QF-1 (or the lead after QF-1): FULL_TIME SKIP ends the match on its 2nd tick, so a last-second divergence online cannot be repaired. Add T_RULES.fullTimeMinTicks 90 and gate the skip in rules/machine.ts phaseTimers; flip tests/net/qf-6-cr-fulltime-skip.test.ts to it().

## From QF-4 (sim-side CRs, open until QF-1/QF-2 finish; failing it.fails tests attached)
- Charged foot kicks make contact on the release tick (render shows the strike after the ball left): delay contact 2-3 ticks after release and hold the ball at the kicking spot (tests/scenario/qf-4-cr-charged-strike.test.ts). Changes hashes.
- Throw-in / far free-kick set-up teleports (D-008) are visible on the main camera: walk illegal players and the taker to their spots from t = 0, teleport only stragglers (tests/scenario/qf-4-cr-setup-teleport.test.ts). Changes hashes.
- CPU corners are delivered into a nearly empty box (0-3 attackers): hold the take until >= 4 attackers are in the box or place them at the award (tests/scenario/qf-4-cr-corner-box.test.ts).
- Fouled free-kick taker is placed at the ball while still in his fall / get-up (cosmetic).
- Load-sensitive allocation tests: int-c-render-alloc, gfx-04-goals, gfx-05-alloc, gfx-07-alloc (+ aud-05, pad-08, tch-06) -> QF-7.

## From QF-12
- tests/e2e/fnd-int-skeleton.spec.ts live input steps (keyboard, touch, pad) are flaky in a full match (restart set-up moves): run them in Practice FREE_PLAY or only while IN_PLAY — Wave 5 e2e cleanup.
- tch-02-stick beforeAll turns auto-switch off — applied by the lead.
- PRE_MATCH -> KICK_OFF cut moves players up to 11.9 m in one tick: confirm the establishing shot hides it (QF-7/sign-off visual check).
- Lifetime records are saved but no screen shows them (MOD-05 'records'): add a small records view (Wave 5 polish) or drop the claim.
- Monkey seed 103 crashed the Chromium renderer once (memory pressure in the shared container); passed alone.
