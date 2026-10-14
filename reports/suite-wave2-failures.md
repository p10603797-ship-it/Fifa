# Full suite after Wave 2 (lead run, 2026-10-14)

Total 6750, passed 6658, failed 91, failed files 72/1663. QF agents were editing in parallel, so a few failures may be mid-edit states.

## tests/net/qf-6-packet.test.ts (2)
- QF-6 sparse input packets round-trip 5,000 random packets bit-exactly (zeros, extremes, repeated frames) and never exceed the old worst case by more than the masks :: AssertionError: expected [ 99036, 3, 292, 812, +0 ] to deeply equal [ 99036, 3, 292, 812, -0 ]     at /home/user/Fifa/tests/net/qf-6-packet.test.ts:49:60     at file:///home/user/Fifa/node_modules/vit
- QF-6 sparse input packets a 12 kB/s link at 80 ms each way stays playable (was: a stall on every tick past ~24 kB/s) :: AssertionError: expected 66.66666666666424 to be less than or equal to 50     at /home/user/Fifa/tests/net/qf-6-packet.test.ts:99:39     at async file:///home/user/Fifa/node_modules/vitest/dist/chunks

## tests/perf/gfx-05-alloc.test.ts (1)
- GFX-05 zero allocation per frame update() allocates nothing per frame :: AssertionError: expected 3.77192 to be less than 0.5     at /home/user/Fifa/tests/perf/gfx-05-alloc.test.ts:88:23     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:1632:35 

## tests/perf/sim-07-budget.test.ts (1)
- SIM-07 budget contact path mixed: < 128 bytes and < 20 us per first touch :: AssertionError: mixed bytes/call: expected 134.71392 to be less than 128     at /home/user/Fifa/tests/perf/sim-07-budget.test.ts:101:54     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/ru

## tests/perf/tai-05-budget.test.ts (1)
- TAI-05 budget no source-level allocation per tick: passInFlight :: AssertionError: expected 298.7248 to be less than 256     at /home/user/Fifa/tests/perf/tai-05-budget.test.ts:119:33     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:1632:

## tests/perf/tai-09-budget.test.ts (1)
- TAI-09 budget a full scan allocates nothing: runners :: AssertionError: expected 1308.32 to be less than 4     at /home/user/Fifa/tests/perf/tai-09-budget.test.ts:116:33     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:1632:35 

## tests/perf/tai-10-budget.test.ts (1)
- TAI-10 budget midfield.skill < 0.05 ms per call and allocates nothing :: AssertionError: expected 109.0596 to be less than 2     at /home/user/Fifa/tests/perf/tai-10-budget.test.ts:93:34     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:1632:35 

## tests/scenario/gkp-01-keeper-movement.test.ts (8)
- GKP-01 keeper movement (real pipeline) walks to the ideal spot and settles without jitter: team 0 :: AssertionError: expected 8.971119339044558 to be less than or equal to 0.35     at /home/user/Fifa/tests/scenario/gkp-01-keeper-movement.test.ts:73:50     at file:///home/user/Fifa/node_modules/vitest
- GKP-01 keeper movement (real pipeline) walks to the ideal spot and settles without jitter: team 1 :: AssertionError: expected 9.390134692675877 to be less than or equal to 0.35     at /home/user/Fifa/tests/scenario/gkp-01-keeper-movement.test.ts:73:50     at file:///home/user/Fifa/node_modules/vitest
- GKP-01 keeper movement (real pipeline) walks to the ideal spot and settles without jitter: team 0 (sides swapped) :: AssertionError: expected 2.7678121228573906 to be less than or equal to 0.35     at /home/user/Fifa/tests/scenario/gkp-01-keeper-movement.test.ts:73:50     at file:///home/user/Fifa/node_modules/vites
- GKP-01 keeper movement (real pipeline) steps across with the ball, facing it (shuffles, never turns his back): team 0 (sides swapped) :: AssertionError: expected 2 to be +0 // Object.is equality     at /home/user/Fifa/tests/scenario/gkp-01-keeper-movement.test.ts:128:21     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.
- GKP-01 keeper movement (real pipeline) walks to the ideal spot and settles without jitter: team 1 (sides swapped) :: AssertionError: expected 2.418578462806385 to be less than or equal to 0.35     at /home/user/Fifa/tests/scenario/gkp-01-keeper-movement.test.ts:73:50     at file:///home/user/Fifa/node_modules/vitest
- GKP-01 keeper movement (real pipeline) steps across with the ball, facing it (shuffles, never turns his back): team 1 (sides swapped) :: AssertionError: expected 1 to be +0 // Object.is equality     at /home/user/Fifa/tests/scenario/gkp-01-keeper-movement.test.ts:128:21     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.
- GKP-01 keeper movement (real pipeline) glitch: Keeper carries it over his own line — a keeper behind his goal (beside or behind the net) gets back in front :: AssertionError: expected 12.182248344701899 to be less than or equal to 0.35     at /home/user/Fifa/tests/scenario/gkp-01-keeper-movement.test.ts:165:50     at file:///home/user/Fifa/node_modules/vite
- GKP-01 keeper movement (real pipeline) glitch: Keeper carries it over his own line — a keeper caught high and running back stops in front of it :: AssertionError: expected 1.5189676910350782 to be less than or equal to 0.35     at /home/user/Fifa/tests/scenario/gkp-01-keeper-movement.test.ts:185:50     at file:///home/user/Fifa/node_modules/vite

## tests/scenario/gkp-04-distribution.test.ts (3)
- GKP-04 quick release on counters (pipeline) opponents committed forward: released after 0.5-0.75 s; a normal build-up waits longer :: AssertionError: expected [ 9, 10 ] to include 1     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2093:15)     at Proxy.<anonymous> (file:///home/user/
- GKP-04 short vs long (pipeline) possession team under a high press: drop kick / driven kick to a forward :: AssertionError: expected false to be true // Object.is equality     at /home/user/Fifa/tests/scenario/gkp-04-distribution.test.ts:127:33     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/r
- GKP-04 short vs long (pipeline) direct team, no press: long to a forward :: AssertionError: expected false to be true // Object.is equality     at /home/user/Fifa/tests/scenario/gkp-04-distribution.test.ts:133:33     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/r

## tests/scenario/gkp-05-keeper-hands.test.ts (1)
- GKP-05 determinism a clone taken mid-hold continues bit-identically :: AssertionError: expected undefined to be defined     at /home/user/Fifa/tests/scenario/gkp-05-keeper-hands.test.ts:369:33     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:

## tests/scenario/int-c-anim-live.test.ts (1)
- INT-C animation in live play (sim + GFX-07 model + GFX-12 driver, no WebGL) planted boots stay planted while players run, turn and change speed (60 Hz display) :: AssertionError: expected 0.5299390403855179 to be less than 0.5     at /home/user/Fifa/tests/scenario/int-c-anim-live.test.ts:142:26     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.C

## tests/scenario/mod-04-practice.test.ts (1)
- MOD-04 set-piece repetition (practice hook) FREE_KICKS: the same restart is awarded again after every attempt, at the chosen spot :: AssertionError: expected 21.163399197258855 to be close to 30.5, received difference is 9.336600802741145, but expected 0.5     at /home/user/Fifa/tests/scenario/mod-04-practice.test.ts:147:23     at 

## tests/scenario/qf-3-cr-switch-combo.test.ts (1)
- QF-3 CR switching: L1 + face combo on a loose ball arriving at the controlled player L1 + Circle in one frame chips with #9 (control stays), it does not switch to #10 :: AssertionError: expected 10 to be 9 // Object.is equality     at /home/user/Fifa/tests/scenario/qf-3-cr-switch-combo.test.ts:50:29     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2

## tests/scenario/rul-01-clock.test.ts (2)
- RUL-01 clock glitch "timer drift": the clock advances exactly one tick per clock-phase tick and shows 45:00 at periodLen :: AssertionError: expected 7829 to be 7828 // Object.is equality     at /home/user/Fifa/tests/scenario/rul-01-clock.test.ts:157:29     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd
- RUL-01 clock the kick-off that opens a period adds no stoppage; a kick-off after a goal does :: AssertionError: PRE_MATCH: expected 500 to be 520 // Object.is equality     at /home/user/Fifa/tests/scenario/rul-01-clock.test.ts:228:49     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/

## tests/scenario/rul-01-coverage.test.ts (1)
- RUL-01 every legal transition is reachable through rulesTick covers every legal transition of contracts/transitions.ts (runs last) :: AssertionError: expected [ 'PRE_MATCH->IN_PLAY' ] to deeply equal []     at /home/user/Fifa/tests/scenario/rul-01-coverage.test.ts:194:21     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/

## tests/scenario/rul-01-goals.test.ts (1)
- RUL-01 goals a pending advantage is played on at a goal: ADVANTAGE(0) and the pending card is shown to the offender :: AssertionError: expected [ [ 2, +0 ] ] to deeply equal [ [ +0, +0 ] ]     at /home/user/Fifa/tests/scenario/rul-01-goals.test.ts:248:72     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/ru

## tests/scenario/rul-02-throwin.test.ts (1)
- RUL-02 human taker PASS: short throw to the teammate the stick points at (slot 2); it reaches him; play resumes :: AssertionError: expected 4 to be 2 // Object.is equality     at /home/user/Fifa/tests/scenario/rul-02-throwin.test.ts:336:33     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-x.

## tests/scenario/rul-03-goalkick.test.ts (13)
- RUL-03 input LOB -> long LOB_PASS to the target man (forwards first, best in the air) :: TypeError: Cannot read properties of undefined (reading 'fn')     at /home/user/Fifa/tests/scenario/rul-03-goalkick.test.ts:494:15     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2
- RUL-03 input modifiers: buttons 20 -> lob kind 5 :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-03 input modifiers: buttons 52 -> lob kind 6 :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-03 input the aim never points back toward the own goal line (sideways is allowed) :: TypeError: Cannot read properties of undefined (reading 'dirX')     at /home/user/Fifa/tests/scenario/rul-03-goalkick.test.ts:557:22     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.C
- RUL-03 input gesture TAP on a teammate -> ground pass to his feet; far teammate -> lob; DOUBLE_TAP -> lob :: TypeError: Cannot read properties of undefined (reading 'fn')     at /home/user/Fifa/tests/scenario/rul-03-goalkick.test.ts:577:15     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2
- RUL-03 input gesture TAP on a pitch spot -> kick to that spot (hasTarget); opponents, the taker, the ball and the own goal mouth are ignored :: TypeError: Cannot read properties of undefined (reading 'fn')     at /home/user/Fifa/tests/scenario/rul-03-goalkick.test.ts:592:15     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2
- RUL-03 input a CPU controller kicking marks the request ReqFlag.CPU :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-03 default long LOB_PASS to the target man when no defender is open :: TypeError: Cannot read properties of undefined (reading 'fn')     at /home/user/Fifa/tests/scenario/rul-03-goalkick.test.ts:692:15     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2
- RUL-03 default uses TAI-09 laneSafety when it gives a signal (overrides the geometric preference) :: AssertionError: expected 2 to be 3 // Object.is equality     at /home/user/Fifa/tests/scenario/rul-03-goalkick.test.ts:716:41     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-x
- RUL-03 default nobody open and nobody in long range -> short to the best teammate; nobody at all -> long kick straight ahead :: TypeError: Cannot read properties of undefined (reading 'fn')     at /home/user/Fifa/tests/scenario/rul-03-goalkick.test.ts:745:15     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2
- RUL-03 timeout default and CPU fallback CPU side: takes it cpuRestartDelay + cpuGraceTicks after ready when its brain did not, no watchdog :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-03 opponents kept out of the penalty area until the ball is played an AI intruder and a human defender pushing in stay outside until the kick, then may enter :: AssertionError: expected 4 to be 2 // Object.is equality     at /home/user/Fifa/tests/scenario/rul-03-goalkick.test.ts:872:27     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-x
- ... 1 more

## tests/scenario/rul-04-corner.test.ts (23)
- RUL-04 taker: the best crosser not needed in the box glitch: taker missing or sent off -- a new taker is picked and the human can still take the corner :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-04 input LOB -> cross to the reticle: startLob(CROSS), target point = reticle, charging, SET_PIECE; then IN_PLAY :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-04 input modifiers: buttons 52 -> kind 9 :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-04 input modifiers: buttons 20 -> kind 7 :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-04 input modifiers: buttons 36 -> kind 7 :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-04 input explicit frame power and curl: that power (not charging) and curve; the preview shows the curl :: TypeError: Cannot read properties of undefined (reading 'charging')     at /home/user/Fifa/tests/scenario/rul-04-corner.test.ts:630:14     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run
- RUL-04 input gesture TAP on a teammate in the box -> cross to him (receiver + point); DOUBLE_TAP -> lofted cross :: TypeError: Cannot read properties of undefined (reading 'fn')     at /home/user/Fifa/tests/scenario/rul-04-corner.test.ts:668:15     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd
- RUL-04 input gesture TAP on a teammate at the edge of the box (just outside the line) still crosses to him :: TypeError: Cannot read properties of undefined (reading 'kind')     at /home/user/Fifa/tests/scenario/rul-04-corner.test.ts:684:23     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2
- RUL-04 input gesture TAP on a spot in the box -> cross to that spot; an opponent standing there does not change it :: TypeError: Cannot read properties of undefined (reading 'kind')     at /home/user/Fifa/tests/scenario/rul-04-corner.test.ts:694:15     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2
- RUL-04 input gesture TAP on the short option -> ground pass to his feet; DOUBLE_TAP -> lofted pass :: TypeError: Cannot read properties of undefined (reading 'fn')     at /home/user/Fifa/tests/scenario/rul-04-corner.test.ts:705:23     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd
- RUL-04 input gesture TAP far outside the box -> cross to the nearest point of the box; TAP on the taker / ball is ignored :: TypeError: Cannot read properties of undefined (reading 'kind')     at /home/user/Fifa/tests/scenario/rul-04-corner.test.ts:718:15     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2
- RUL-04 input swipe from the ball: lands on the swipe line where it passes the reticle; speed sets the height band, curve the curl :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- ... 11 more

## tests/scenario/rul-04-integration.test.ts (9)
- RUL-04 integration (real team AI, TAI-13, keepers, contacts) bot v bot: team 0 side 1 seed 3 -> taken from CORNER by the CPU, opponents 9.15 m away, no watchdog :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-04 integration (real team AI, TAI-13, keepers, contacts) bot v bot: team 0 side 1 seed 11 -> taken from CORNER by the CPU, opponents 9.15 m away, no watchdog :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-04 integration (real team AI, TAI-13, keepers, contacts) bot v bot: team 0 side -1 seed 3 -> taken from CORNER by the CPU, opponents 9.15 m away, no watchdog :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-04 integration (real team AI, TAI-13, keepers, contacts) bot v bot: team 0 side -1 seed 11 -> taken from CORNER by the CPU, opponents 9.15 m away, no watchdog :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-04 integration (real team AI, TAI-13, keepers, contacts) bot v bot: team 1 side 1 seed 3 -> taken from CORNER by the CPU, opponents 9.15 m away, no watchdog :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-04 integration (real team AI, TAI-13, keepers, contacts) bot v bot: team 1 side 1 seed 11 -> taken from CORNER by the CPU, opponents 9.15 m away, no watchdog :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-04 integration (real team AI, TAI-13, keepers, contacts) bot v bot: team 1 side -1 seed 3 -> taken from CORNER by the CPU, opponents 9.15 m away, no watchdog :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-04 integration (real team AI, TAI-13, keepers, contacts) bot v bot: team 1 side -1 seed 11 -> taken from CORNER by the CPU, opponents 9.15 m away, no watchdog :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:
- RUL-04 integration (real team AI, TAI-13, keepers, contacts) human v CPU: the human aims with the stick and crosses (LOB); TAI-13 keeps the defenders legal; play resumes :: AssertionError: expected [] to have a length of 1 but got +0     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2163:20)     at Proxy.<anonymous> (file:

## tests/scenario/rul-11-restart.test.ts (3)
- RUL-11 awardRestart fills the restart, places the ball still, interrupts actions (falls finish), emits events, calls Setup, sets the phase :: AssertionError: expected [] to deeply equal [ 'setup:2' ]     at /home/user/Fifa/tests/scenario/rul-11-restart.test.ts:263:19     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-x
- RUL-11 legal positions the push gets anyone out within 1 s from the worst spot (standing on the ball) :: AssertionError: THROW_IN: expected [ '14 within 2 m' ] to deeply equal []     at /home/user/Fifa/tests/scenario/rul-11-restart.test.ts:536:54     at file:///home/user/Fifa/node_modules/vitest/dist/chu
- RUL-11 timeouts a CPU taker that has not acted after 4 s gets the Default (logged); a Default that does nothing is followed by a forced kick :: AssertionError: expected [] to include 'default:2'     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2093:15)     at Proxy.<anonymous> (file:///home/us

## tests/scenario/sim-05-bodies.test.ts (1)
- SIM-05 regression "Ball stuck: between two players" two opponents converging on a loose ball stop with it inside their reach (SIM-06 can pick it up) :: AssertionError: expected 0.7971867748661806 to be less than 0.3     at /home/user/Fifa/tests/scenario/sim-05-bodies.test.ts:284:62     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2

## tests/scenario/tai-05-press.test.ts (2)
- TAI-05 team press, engagement and intensity intensity: difficulty ladder, human default, team press, focus and counter-press :: AssertionError: expected 1 to be greater than 1     at /home/user/Fifa/tests/scenario/tai-05-press.test.ts:632:56     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:1632:35 
- TAI-05 determinism assignPressing is an exact mirror image for the two attack directions :: AssertionError: expected false to be true // Object.is equality     at /home/user/Fifa/tests/scenario/tai-05-press.test.ts:877:62     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2s

## tests/scenario/tai-13-setpieces.test.ts (3)
- TAI-13 positions: legal for every restart kind and both teams free kick 6.5 m from goal :: AssertionError: free kick 6.5 m from goal: expected [ …(2) ] to deeply equal []     at expectLegalLayout (/home/user/Fifa/tests/scenario/tai-13-setpieces.test.ts:175:27)     at /home/user/Fifa/tests/s
- TAI-13 positions: legal for every restart kind and both teams glitch: players run in place against each other — spots are spaced at least minSpacing apart (incl. the taker) :: AssertionError: free kick 6.5 m from goal 1: expected 0.38053358895391676 to be greater than or equal to 0.95     at /home/user/Fifa/tests/scenario/tai-13-setpieces.test.ts:298:103     at file:///home
- TAI-13 positions: legal for every restart kind and both teams setPiecePositions gives every job-driven player a SET_PIECE job at his spot (and nothing outside restarts) :: AssertionError: expected 0.02059353114652139 to be less than 1e-9     at /home/user/Fifa/tests/scenario/tai-13-setpieces.test.ts:339:46     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/ru

## tests/unit/fnd-06-invariants.test.ts (1)
- FND-06 invariant checker: phase and transitions catches an illegal transition reported by PHASE_CHANGE (PRE_MATCH -> IN_PLAY) :: AssertionError: expected '' to contain 'illegal transition PRE_MATCH -> IN_PL…'     at /home/user/Fifa/tests/unit/fnd-06-invariants.test.ts:151:26     at file:///home/user/Fifa/node_modules/vitest/dis

## tests/unit/fnd-06-review-fixes.test.ts (1)
- FND-06 fixes: invariant checker allocation (documented in its header) only the 'finite' scan allocates on the passing path, and only a little :: AssertionError: bounds: expected 273.2028 to be less than 8     at /home/user/Fifa/tests/unit/fnd-06-review-fixes.test.ts:246:28     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd

## tests/unit/gkp-02-saves.test.ts (1)
- GKP-02 glitch list: Keeper Keeper: fights a defender for the same ball — leaves a teammate's back-pass alone and wins contact priority :: AssertionError: expected 'none' to be 'save' // Object.is equality     at /home/user/Fifa/tests/unit/gkp-02-saves.test.ts:365:24     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd

## tests/unit/gkp-04-distribution.test.ts (5)
- GKP-04 quick release on counters counter from the opponents committing forward: short wait, ball forward to a free striker :: AssertionError: expected [ 9, 10 ] to include 4     at Proxy.<anonymous> (file:///home/user/Fifa/node_modules/vitest/dist/chunks/index.uwTEEBsB.js:2093:15)     at Proxy.<anonymous> (file:///home/user/
- GKP-04 short vs long by pressure and style direct style: long to a forward even with open defenders :: AssertionError: expected 2 to be 3 // Object.is equality     at /home/user/Fifa/tests/unit/gkp-04-distribution.test.ts:144:24     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-x
- GKP-04 patience and deadline possession team with only a long option waits for the team to spread, then kicks long after patienceTicks :: AssertionError: expected 150 to be less than 124     at /home/user/Fifa/tests/unit/gkp-04-distribution.test.ts:171:18     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:1632
- GKP-04 patience and deadline a direct team kicks that long ball at once :: AssertionError: expected 150 to be 59 // Object.is equality     at /home/user/Fifa/tests/unit/gkp-04-distribution.test.ts:178:18     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd
- GKP-04 targets never aims at a striker in an offside position (offside on); does with offside off :: AssertionError: expected 6 to be 9 // Object.is equality     at /home/user/Fifa/tests/unit/gkp-04-distribution.test.ts:231:27     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-x

## tests/unit/review-fnd-06-tools.test.ts (2)
- review FND-06 soak CLI the printed reproduction command does not enforce population bands on the single re-run match :: AssertionError: expected null not to be null     at /home/user/Fifa/tests/unit/review-fnd-06-tools.test.ts:73:22     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-x.js:1632:35  
- review FND-06 postbuild fails without dist/index.html, passes a small file, fails a file over 4 MB gzip :: AssertionError: expected 1 to be +0 // Object.is equality     at /home/user/Fifa/tests/unit/review-fnd-06-tools.test.ts:157:21     at file:///home/user/Fifa/node_modules/vitest/dist/chunks/run.Cm2sd7-
