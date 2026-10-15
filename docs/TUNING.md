# DotKick tuning log

Owner: INT-A (Wave 2 gameplay integration). Every gameplay constant change made against soak evidence, with the
reason. Values live in `src/contracts/tuning.ts` (shared tables) or in a module's `LOCAL_TUNING` block (marked
`TUNING-CR` / `[INT-A]` in the source). Measurement tool: `npx tsx tools/soak.ts --matches 24 --difficulty 3
--enforce all --halfMinutes 4` (equal teams at Professional, as BRIEF §7 defines the bands).

## Shared tables (`src/contracts/tuning.ts`)

| Constant | Was | Now | Why |
|---|---|---|---|
| `T_PLAYER.staminaDrainSprint` | 0.012 /s | 0.005 /s | With 4-minute halves every player hit the stamina floor before half-time (average 0.25 at the break, 0.05 at full time), so the second half was played at 82% speed: chasers could not catch long balls (ball-untouched watchdogs) and the game slowed down. |
| `T_PLAYER.staminaDrainJog` | 0.002 /s | 0.0008 /s | Same. |
| `T_PLAYER.staminaRecover` | 0.004 /s | 0.003 /s | Same; end-of-match average stamina is now about 0.7-0.8, minimum about 0.5. |
| `T_GK.reactBest` / `reactWorst` | 6 / 20 ticks | 8 / 22 ticks | Keepers saved ~90% of on-target shots in full matches. GKP-02's batch now measures 68-70% at gk 75 (band 65-78%), the full pipeline ~77%. |
| `T_GK.diveSpeedBest` / `diveSpeedWorst` | 7.5 / 5.0 m/s | 7.0 / 4.6 m/s | Same. |
| `T_LEVEL.shotThresholdXg` | 0.02 .. 0.045 | 0.0018 .. 0.004 | The xG model (TAI-10) is calibrated to real football, but measured conversion of the CPU's 18-35 m shots in the sim is several times the estimate (blockers rarely block in the physics). With the old gate the CPU almost never shot (2 shots per match). The range gate below keeps shots in shooting range. Higher levels stay more selective. |

Kept on purpose: `T_PASS.lobAngle` (a flatter 0.5 rad lob rolled into the empty half after landing and caused ball-
untouched watchdogs), `T_FOUL.baseFoulChance` (0.85 broke RUL-09's per-kind foul bands; the CPU's rash lunges were
raised instead).

## Module tuning (`LOCAL_TUNING`, TUNING-CR)

### CPU carrier (`src/ai/cpu/carrier.ts`, TAI-08)
- Possession value `PV = pvBase + pvSpan * t^3 * (1 - t * 0.65 * width)`: `pvBase` 0.01 -> 0.004, `pvSpan` 0.07 ->
  0.08, quadratic -> cubic, and a width discount (`pvLatFree` 9 m, `pvLatFull` 30 m, `pvLatMin` 0.35). The flat
  quadratic made a forward pass never worth its risk and a carrier at the corner flag "worth" 0.08 goals, so attacks
  went sideways and wide players kept the ball instead of crossing or cutting back.
- Loss cost = the opponents' PV at the spot (`posValue(-progress, z)` x style safety), replacing the linear
  `lossOwn` 0.07 .. `lossOpp` 0.01 that overcharged a loss in midfield.
- Shot utility `shotXgMul` x xG (new, 3.5) + miss value; gate: threshold x (1 + `longShotThreshPerM` 0.06 per metre
  beyond `longShotDist` 20 m), no shot beyond `shotMaxDist` 35 m (+ `shotMaxLongShotExtra` 4 m x style longShot);
  `longShotThreshMax` 1.5 -> 1.0.
- Shot placement: `shotInset` 0.8 -> 0.5 m, `shotPowerNear` / `Far` 0.55 / 0.8 -> 0.65 / 0.84 (on-target shots were
  easy saves).
- Drive at goal: a dribble in the attacking half is credited with `driveShotShare` 0.8 of the shot it opens.
- Clearance `clearValue` 0.012 -> -0.0015, `clearBoxBonus` 0.008 -> 0.006, `clearPower` 0.7 -> 0.5: against the new
  value scale a clearance beat every pass below ~95% completion (15+ hoofed long balls a match, most lost, several
  rolling 8 s untouched into the far half).
- Counter-attack bonus `counterPerM` 0.0008 -> 0.0003 and multiplied by the pass's completion: a 3% lofted through
  ball got +0.03 and won every counter (11 lofted through balls a match, none arrived).
- Shield: `shieldHoldMul` 0.93 (new) and a rest after any shield of `shieldRestMinTicks` 60+ ticks (new); scale
  changes with the value model: `switchMargin` 0.006 -> 0.003, `settlePenalty` 0.01 -> 0.005,
  `keeperDribblePenalty` 0.02 -> 0.01.

### CPU passing (`src/ai/cpu/passing.ts`, TAI-09)
- `groundArriveMin` / `Max` 3.5 / 8 -> 7 / 12 m/s (mirrors SIM-08).
- `aerialMin` / `Max` 0.72 / 0.95 -> 0.4 / 0.6: lobs were estimated at 30-50% and completed 4-13%.
- Through-ball completion x `throughGroundCompletionMul` 0.6, x `throughLobCompletionMul` 0.25 (estimated 38% / 12%,
  completed 19% / 0%).
- Crosses: completion = min(1, lane safety x `crossCompletionMul` 1.6 + `crossCompletionAdd` 0.12) (estimated
  0.05-0.2, measured about half).

### CPU xG (`src/ai/cpu/shooting.ts`, TAI-10)
- Keeper misposition: the share of the mouth he leaves open beyond what an average keeper leaves on the bisector
  (was: the share of his own coverage lost, which rated a quicker keeper as more open).

### CPU defending (`src/ai/cpu/defending.ts`, TAI-11)
- `rashLungeChance` 0.25 -> 0.5 (fouls per match were at the bottom of the 6-16 band).

### Team shape (`src/ai/shape.ts`, TAI-01) and back line (`src/ai/defshape.ts`, TAI-04)
- In possession the shape is higher and stretched: `lineOffset` BUILD_UP / ATTACK / TRANSITION_ATTACK 6 / 10 / 12 ->
  8 / 14 / 14, `lineMax` ATTACK / TRANSITION_ATTACK 12 / 12 -> 16 / 14, `lineCeil` 14 -> 18, `depthScale` BUILD_UP
  1.15 -> 1.25, TRANSITION_ATTACK 1.3 -> 1.4, `forwardPush` DEFEND 0 -> 3 (forwards stay up as outlets), new
  `lineGapScale` [1.35, 1.5, 1, 1.5, 1, 1] (gaps between lines up to 1.5 x `T_AI.lineSpacingMax` in possession; out of
  possession they stay within 14 m). Exported `lineGapMax(phase)`.
- Out of possession a mid-block instead of a low block: `defendLift` DEFEND / TRANSITION_DEFEND / SET_PIECE 7 / 6 / 7 m
  (TAI-01) and `lineOffset` 7 m (TAI-04), both fading out as the ball nears our box (`defendLiftFrom/To`,
  `lineOffsetFadeFrom/To` -30 / -12 m). The block used to defend ~24 m goal-side of the ball with all ten outfielders
  behind it.
- TAI-01 vs DAT-04: TAI-01's live shape model wins (compactness, TAI-04 line control, get-in-box, onside clamps);
  DAT-04 `tacticalHome` stays a reference helper. Both read the same data/tactics focus / quick-tactic values.

### Jobs and steering (`src/ai/jobs.ts`, `src/ai/steer.ts`, `src/ai/support.ts`)
- HOLD_SHAPE speed: a jog within `holdNearDist` 4 m of home, rising to `holdFarFraction` 0.92 of top speed at
  `holdFarDist` 12 m (was always a jog: players trailed their homes by 10-25 m after a turnover).
- Ball jobs chasing a ball that rolls away aim `overshootSec` 0.6 s x ball speed (`overshootMin` 3.5 m, `overshootMax`
  5 m) beyond the interception point (no arrival braking short of the ball).
- TAI-02 supporters: `wProg` 0.08 -> 0.25 per metre (options ahead of the ball, not square or behind it).
- TAI-07 chaser: a keeper on a user rush (GKP-03 `RushMode` USER_HOLD / USER_TIMED) is a controlled candidate, not
  a claim (an AI rush still claims). A held keeper-rush button sent a keeper 60 m upfield after a ball and, as the
  claiming chaser, kept every outfield teammate off it (fuzz ball-untouched watchdog).

### Set pieces (`src/ai/setpieces.ts`, TAI-13)
- `gkLongMax` 75 -> 40 m: long goal kicks to the far third skipped on into the opponents' empty half and rolled 8 s
  untouched (watchdog); the long option now lands around the halfway line where the forwards contest it.

### Sim
- SIM-08 pass (`src/sim/kicks/pass.ts`): assisted arrival `arriveMin` / `Max` 3.5 / 8 -> 7 / 12 m/s (a 20 m pass took
  over 2 s, closing every forward lane).
- SIM-12 aerial (`src/sim/kicks/aerial.ts`): header pass angles `headerPassAngleNear` / `Far` 0.55 / 0.3 -> 0.3 / 0.18
  rad, aimed `headerShortFrac` 0.25 (max `headerShortMax` 4 m) short of the receiver; header shots 12-18.5 (cap 20) ->
  13.5-19 (cap 19.8) m/s; receiver choice `opennessW` 0.35 -> 0.8; AI: an uncontested high ball is left to drop
  (chest / feet) instead of being headed on; opponents' balls are always cleared within `aiClearAlwaysDepth` 22 m.
- SIM-15 receivers (`src/sim/control/resolveShared.ts`): meet point planned at the receiver's own pace (not jog);
  ball rolling away: target `meetOvershootSec` 0.6 s x ball speed beyond the meet point (3.5-5 m) and top speed while
  more than `meetCatchDist` 1.2 m behind.
- SIM-04 locomotion (`src/sim/players/locomotion.ts`): stamina rates x `staminaRefHalfMinutes` 4 / halfMinutes.
- SIM-09 lob (`src/sim/kicks/lob.ts`): `lobLeadMaxSec` 3.5 -> 2.5 s. A long ball led a sprinting forward by up to
  30 m, landed 60+ m from the kicker and skipped on untouched (watchdog). 2.5 s still leads a runner (SIM-09 tests).
- GKP-01 positioning (`src/sim/keeper/positioning.ts`): an untouched pass from a teammate to the keeper (back pass)
  is met on its path (`receivePass`) instead of being left to roll past him.

## Measured bands (Professional, 4-minute halves, seed 1)

| Band | Before (20 mixed-level matches) | After (100 Professional matches) |
|---|---|---|
| Goals per match (2.0-3.6) | 0.25 | 0.91 |
| Shots per match (14-26) | 2.15 | 8.25 |
| Possession, side with more (<= 60) | 57.4% | 57.0% (72/100 matches inside 40-60) |
| Possession, home side | 50.0% | 50.8% |
| Pass completion (70-88%) | 54.7% | 75.6% |
| Fouls per match (6-16) | 2.5 | 5.5 |
| Offsides per match (0-6) | 0.2 | 0.15 |
| Blow-outs (< 5%) | 0% | 0% |
| Exceptions / invariant failures (`--enforce all`) / determinism | 0 / 0 / PASS | 0 / 0 / PASS |
| BALL_UNTOUCHED watchdogs | 1 in 20 | 0 in 100 |
| Keeper saves of on-target shots (65-78%) | ~90% | 68-70% (GKP-02 batch), ~77% (full pipeline) |

Hostile-input fuzz (`tools/fuzz.ts --matches 20 --halfMinutes 2`): 0 exceptions, 0 invariant failures, 0 watchdogs,
determinism PASS (the baseline had 4 ball-untouched watchdogs in fuzz #11 alone).

24-match runs vary by about +-1.5 shots and +-0.3 goals. Still outside: goals (about 1 a match), shots (about 8) and
fouls (about 5.5). Few possessions get within 25 m of goal against a ten-man block, and the TAI-10 xG model
under-rates conversion in the sim; see the INT-A report (open risks).

## QF-1 (Wave 3-4: sim core and rules)

| Constant | Was | Now | Why |
|---|---|---|---|
| `T_BALL.bounceFriction` | 0.12 | 0.12 (unchanged) | Long balls skip on too far after landing (INT-A proposed ~0.2). Not changed: SIM-08's pass planner (`kicks/pass.ts`, QF-2) models the bounce, and its tests break as soon as the value moves: at 0.15 `sim-08-pass` "lead passes to moving receivers arrive within 1.5 m" misses its plan by 1.65 m; at 0.16-0.2 "the dinked model matches the real ball physics" drifts 0.8-1.4 m/s from the real ball (bounce-boundary sensitivity). Raising it needs QF-2 to refit dinkTrial / the lead model first (CR in the QF-1 report). |
| RUL-09 `kindFoulWeight` (`rules/fouls.ts`) | 0.6 / 0.8 / 1.0 / 0.12 / 0.5 / 0.75 | 0.95 / 0.97 / 1.0 / 0.12 / 0.85 / 0.96 | Refit against real challenges: 18 soak matches (every difficulty) give ~18 challenge records a match, 94% standing tackles, 14% playing the ball first, mostly from the front at 0-5 m/s. The Wave-1 weights gave 5.1 fouls a match (band 6-16). |
| RUL-09 `speedFoulMulLow` | 0.7 | 0.9 | Same refit: a slow standing tackle that misses the ball and takes the man is usually a foul. |
| RUL-09 `allOutSpeedMul` | 1.4 | 0.85 | No yellow card was ever shown in a real match: reckless needed 7.7 m/s closing speed (any direction) or 5.5 m/s from behind; CPU challenges close at 0-6.8 m/s, from behind only slowly. |
| RUL-09 `behindRecklessMul` (new) | (1.0) | 0.6 | From behind, reckless above 3.3 m/s. |
| `T_RULES.ballLieSpeed` (new) | - | 1.0 m/s | RUL-11 BALL_UNTOUCHED counts only the ticks the loose ball lies (below this horizontal speed) or sits in a keeper's hands. Counted from the last touch, a long goal kick still rolling at 5 m/s with both chasers after it fired the 8 s watchdog as it stopped (fuzz seeds 202 #8, 303 #33). |
| `T_RULES.fullTimeMinTicks` (new, QF-6 CR) | - | 90 ticks | The final whistle ignores SKIP for 1.5 s: online, the next hash exchange (<= 30 ticks), the host snapshot and the guest hard-sync fit before POST_MATCH stops both sims. |
| RUL-05 / MOD-04 `spotTolerance` (`rules/practice.ts`, new) | - | 1 m | A pending free kick / penalty of the practised kind within this of the practice spot is the practice one (a foul free kick elsewhere is replaced). |
| `T_RULES.passDeadTicks` / `passDeadReach` (new, QF-1 skeptic) | - | 30 ticks / 0.6 m | sim/step ends a pass whose ball has lain 0.5 s while its receiver is not closing in (not within `T_DRIBBLE.controlRadius` + 0.6 m, not running at it at `ballLieSpeed`): `ball.passTarget` clears. "Our pass in flight" otherwise lasted for ever: SIM-16 kept the user on the receiver with no manual switch and TAI-07's receiver claim kept every AI teammate off the ball (fuzz seed 919 #14, BALL_UNTOUCHED). |
| SIM-15 `IDLE_CHASE` (`control/resolveMove.ts`, new, QF-1 skeptic) | - | 60 ticks / 60 ticks / 0.6 m | The controlled loose-ball chaser whose stick has been released for 1 s walks (jog) to a ball that has lain 1 s (below 0.6 m high); any stick input takes over. An idle user's chaser stood still forever (fuzz seed 2027 #78, BALL_UNTOUCHED). |

Measured (18 Professional matches, 4-minute halves, after the refit): fouls 9.3 a match (15/18 inside 6-16), yellows
1.4, reds 0.17 (incl. second yellows), penalties 0.39. RUL-09's synthetic band test now samples the measured challenge
mix (`tests/scenario/rul-09-fouls.test.ts`): 9.2 fouls, 2.2 yellows a match. Final soak (100 matches, seed 707,
3-minute halves, `--enforce all`): fouls 8.63 a match (PASS), offsides 0.13, 0 exceptions / invariant failures /
watchdogs, determinism PASS; goals 1.69 and shots 9.0 still below their bands (QF-2).

## QF-2 (Wave 3-4: AI, keepers, kicks, game feel)

Measurement: `npx tsx tools/soak.ts --matches 100 --difficulty 3 --enforce all --halfMinutes 4 --workers 2`
(Professional, the §7 population; seed 1). The tuning was searched on the same population (seed 1, 4-minute halves,
48- and 96-match batches with runtime overrides of the tuning objects); a batch replays bit-identically, so two
settings are compared on the same matches. Expect noise: two settings a hair apart send the matches down different
paths, and 96-match goal averages of near-identical settings spread about +-0.25 (shots +-0.6).

### Why the CPU did not shoot (INT-A: 0.91 goals, 8.25 shots)

- TAI-10 xG ignored where blockers would be when the ball arrived and how wide a body is near the shooter, so the CPU
  struck into the man in front of it: 40 of 76 shots in a 4-match sample hit a defender. The real price of a shot
  through a crowd was a lost ball, so INT-A's `shotXgMul` 3.5 (on the old xG) made shooting rarely worth it.
- Shots were aimed by the keeper alone (far post when central) even when that lane was shut; the power hold (0.6 s+)
  gave the closing defender time to step across.
- The possession-value model, the long-shot gate and the drive credit priced shots against the old xG.
- Few runners: with the carrier 20-30 m out centrally, ~1 teammate was in the box (box attack only for crosses).

### Changes (behaviour)

| Where | Change |
|---|---|
| TAI-10 `estimateXg` (`ai/cpu/shooting.ts`) | Blockers judged now and `blockLook` s later (where a closing man will be); body radius / efficiency grow toward the shooter (`blockRadiusNear` 1.0 m, `blockEffNear` 0.95); `lastXgBlock()` returns the lane factor of the last estimate. New `shotLaneClear(s, slot, x, z, aimZ)`: the share of a shot to one post that gets past the outfielders (now and after `blockLook`). |
| TAI-08 shot option (`ai/cpu/carrier.ts`) | Aim at the post whose lane is clear (keeper side preferred, the other x `keeperSideMul` 0.85). Price = clean xG x lane clear x `shotXgMul` + misses x `shotMissValue` + blocked share x (`blockedRecover` x value here - the rest x the opponents' value of the spot). The power hold is cut to the time an opponent ahead needs to reach the aimed line (`quickShotReach` 1.1 m); within `quickShotDist` 10 m the CPU strikes without an aiming turn. Dribble drive credit = clean xG at the carry's end x the best lane. |
| TAI-08 skill moves | A knock-on is never chosen when the 14 m run-out (`knockRun`) would cross a line (`knockEdge` 2 m); TAI-08 plays it straight past the man (SKILL_CHOICE direction). |
| TAI-03 runs (`ai/runs.ts`) | Box attack also with the carrier in the central final third (`boxAttackDepth` 30 m), not only for a cross: forwards and a late midfielder head for the box spots, onside. |
| TAI-09 / SIM-08 lead | A receiver's run is led only until it comes within `T_PASS.leadLineMargin` 4 m of a line (passes led out of play: 23 -> 5 in 4 matches); `leadMaxS` 2.5 -> 1.5 s; `throughGroundCompletionMul` 0.6 -> 1. |
| TAI-09 `loftLaunchSpeed` | GKP-04 judges lofted releases at the launch speed that carries the distance (was the horizontal average, which rated every long kick unsafe). Long releases keep GKP-04's own model. |
| GKP-03 / TAI-11 come-out | No start / abort flip-flop: the race keeps a started rush while the ball is reachable, a rush starts only `startMinDepth` 2 m out, and the CPU holds keeper-rush only when GKP-03 itself would come out (`comeOutWanted`, via `sweeperHooks`). |
| SIM-12 / TAI-07 / TAI-11 | No outfielder takes the ball his keeper is set to catch: AI headers / volleys skip a ball in the keeper's area or aimed at a planted keeper (`keepersBall`); a catching / diving keeper claims the chase (`rushingKeeper`); a CPU-controlled defender stays out of the keeper's lane (`keeperLaneClear` 2 m). |
| TAI-13 set pieces | A spot still too close to another after legalisation is relocated on rings around it (players ran in place against each other at a free kick 6.5 m out). |
| GKP-03 come-out vs shots | No AI come-out starts for an opponent's shot above `shotRushMaxSpeed` 10 m/s: the keeper started a rush at a 17 m/s long shot, aborted it and restarted it the next tick. |
| GKP-02 keeper reaction by level | A CPU side's keeper reacts `T_LEVEL.keeperReactTicks` later / sooner than his gkReflexes alone (`keeperReactionTicks`). |
| TAI-08 dribble risk | The loss chance credited to a dribble is lower (`dribbleLossMax` 0.15) except for a carry into no space in our own half (x 1 + `dribbleTightLossMul` x (1 - space score)). |
| SIM-10 lead search | The runner's arrival times are memoised per runner while his inputs are unchanged (same values; TAI-09 scans allocated 3.4 KB under unbundled V8). |

### Tuning (`src/contracts/tuning.ts` unless noted)

| Constant | Was | Now | Why |
|---|---|---|---|
| `T_CPU.carrierShotXgMul` (TAI-08) | 3.5 | 18 | The shot price is now the clean xG x its lane (blocked shots priced separately), not the old blocker-blind xG; searched 10-20 against goals / shots / saves together. |
| `T_CPU.carrierBlockedRecover` (new) | - | 0.9 | Share of the value of the spot kept after a blocked shot (corner, rebound, recycle). 0.4 made the CPU refuse every half-open lane; 1.0 shoots into the man. |
| `T_CPU.carrierDriveShotShare` | 0.8 | 0.7 | Share of the shot at the carry's end a dribble is credited with: lower shoots earlier instead of carrying into the crowd. |
| `T_CPU.carrierBoxShotBonus` | 0.012 | 0.03 | Urge to shoot inside the box. |
| `T_CPU.carrierLongShotThreshMax` / `PerM` | 1.0 / 0.06 | 0.7 / 0.02 | Long-shot gate on the new price (blocked long shots are priced by their lane). |
| `T_CPU.carrierShotMaxDist` | 35 m | 40 m | Same. |
| `T_CPU.carrierDribbleLossMax` | 0.35 | 0.15 | Carriers in the opponents' half passed sideways instead of driving at the box (0.2 -> 0.15: +0.45 goals a match in the 96-match batch). |
| `T_CPU.carrierDribbleTightLossMul` (new) | - | 1.4 | In our own half a carry into no space keeps the INT-A risk (0.15 x 2.4 ~ 0.35): a pressed carrier with no option shields (TAI-08 test) instead of dribbling into the presser. A flat 0.35 in our own half cost 0.4 goals a match (no counter-attacks out of defence). |
| `T_CPU.carrierPvExp` (new) | (3) | 3 | Possession-value exponent made a constant (a steeper value curve was tried: forward passes rose but completion fell below 70%). |
| `T_CPU.xgBlockLook` (new) | - | 0.25 s | Blockers are judged where they will be this long after the decision. |
| `T_CPU.xgBlockRadiusNear` / `xgBlockEffNear` (new) | - | 1.0 m / 0.95 | Body width / efficiency of a blocker next to the shooter (falling to the far-range values with distance). |
| `T_CPU.xgLaneBallSlack` (new) | - | 0 | Extra lane width for the ball (0: the body radius alone; 0.15 m priced too many lanes as shut). |
| `T_CPU.carrierQuickShot*` (new) | - | reach 1.1 m, dist 10 m | Power hold cut / no aiming turn under pressure (above). |
| `T_CPU.carrierKeeperSideMul` (new) | - | 0.85 | Weight of the lane on the keeper's side vs the open side. |
| `T_CPU.passLeadMaxS` / `passThroughGroundCompletionMul` | 2.5 s / 0.6 | 1.5 s / 1 | Leads past 1.5 s ran out of play; the through-ball completion estimate matches measured completion with the line-capped lead. |
| `T_AI.carrierEvalInterval` | 8 ticks | 5 ticks | The CPU carrier re-scores every 83 ms: shooting windows against a closing man last ~0.3 s. |
| `T_GK.reactBest` / `reactWorst` | 8 / 22 | 6 / 19 | Full matches saved 52-58% of on-target shots after the shot model changes (band 65-78%). 7 / 20 and slower dives were tried late: no measurable change in goals. |
| `T_SKILL.minStars` | 3-star cap | 1-5 stars | DAT-05: 3, 4 and 5 stars gave the same moves. Step-over 3, roulette 4, heel flick 5. |
| SIM-11 `shotPowerMulMin` (`kicks/shot.ts`) | 0.92 | 0.8 | DAT-05: shot speed moved 4% from shotPower 40 to 90; now 25.7 -> 28.7 m/s (12%) at 80% power. |
| SIM-11 `composureRelief` | 0.5 | 0.8 | DAT-05: a 1 m press cut a calm striker's placement error by 14%; now 24% (0.59 -> 0.45 m). |
| `T_PASS.leadLineMargin` (new) | - | 4 m | See the lead change above. |
| TAI-03 `boxAttackDepth` (`ai/runs.ts`, new) | - | 30 m | Box attack from the central final third. |
| GKP-03 `startMinDepth` (`keeper/sweeper.ts`, new) | - | 2 m | No come-out from the goal line (flip-flop fix). |
| GKP-03 `shotRushMaxSpeed` (new) | - | 10 m/s | No AI come-out for an opponent's shot (on target: GKP-02 saves it; off target: it is going out) faster than this; a weak shot rolling in is still walked out to. |
| `T_LEVEL.keeperReactTicks` (new) | - | 10 / 6 / 3 / 0 / -2 / -3 | Extra save-reaction ticks of a CPU side's keeper by level (0 at Professional and for a human side, so the bands and human keepers are unchanged): reaction time is a level difference (§7). Ladder Amateur v Beginner 27.5% -> 50% wins. |
| TAI-11 `keeperLaneClear` (new) | - | 2 m | Defender stays out of a catching keeper's lane. |
| SIM-12 `keepersBallRadius` (`kicks/aerial.ts`, new) | - | 3 m | Keeper's ball for the AI-header rule. |

Moved out of LOCAL_TUNING into `tuning.ts` (values unchanged, the modules alias them): TAI-08 carrier value model,
TAI-09 completion factors, TAI-10 / TAI-11 constants (`T_CPU`); jobs hold speeds and steer overshoot (`T_AI.hold*`,
`T_AI.chaseOvershoot*`); TAI-13 `T_AI.setPieceGkLongMax`; SIM-12 header geometry (`T_AERIAL`); SIM-09
`T_PASS.lobLeadMaxSec`; SIM-08 `T_PASS.assistArriveMin/Max`. Added for QF-1 to switch over (their modules still hold
the local value): SIM-04 `T_PLAYER.staminaRefHalfMinutes`, SIM-15 `T_TOUCH.meet*`.

### Measured (final code)

`npx tsx tools/soak.ts --matches 100 --difficulty 3 --enforce all --halfMinutes 4 --workers 2` (seed 1):

| Band | INT-A (100 Professional matches) | QF-2 |
|---|---|---|
| Goals per match (2.0-3.6) | 0.91 | 2.39 PASS |
| Shots per match (14-26) | 8.25 | 15.02 PASS |
| Possession, side with more (<= 60) | 57.0% | 56.9% PASS (78/100 matches inside 40-60) |
| Possession, home side | 50.8% | 50.2% PASS |
| Pass completion (70-88%) | 75.6% | 74.8% PASS |
| Fouls per match (6-16) | 5.5 | 11.6 PASS (QF-1's RUL-09 refit) |
| Offsides per match (0-6) | 0.15 | 0.26 PASS |
| Blow-outs (< 5%) | 0% | 1% PASS |
| Exceptions / invariant failures (`--enforce all`) / watchdogs / determinism | 0 / 0 / 0 / PASS | 0 / 0 / 0 / PASS |
| Keeper saves of on-target shots (65-78%) | ~77% (full pipeline) | 65.5% (96-match batch, same population; GKP-02's save-rate test passes) |

Shots by distance (96-match batch): < 12 m 3.9, 12-18 m 1.9, 18-25 m 1.3, 25-35 m 2.8, 35 m+ 4.9 a match; goals 1.88 /
0.14 / 0.01 / 0.17 / 0.22. A third of the shots are long shots from 35-44 m (`shotMaxDist` + long-shot style): the
attacks that reach 20 m are still few; the band is met partly by shooting from range.

TAI-10 xG against sim conversion (48 matches, every shot, goal by the shooting team within 4 s): xG < 0.01: 4% (472
shots); 0.01-0.02: 10%; 0.02-0.04: 27%; 0.04-0.07: 9%; 0.07-0.1: 29%; 0.1-0.15: 21%; 0.15-0.25: 50%; 0.25-0.4: 48%;
0.4+: 74% (mean xG 0.70). The estimate (real-football calibrated, now with the blocker lanes) under-rates sim conversion
by 1.4-3x between 0.05 and 0.4 and far more below (rebounds count); the realised possession value by progress is about
3.6x TAI-08's model (0.30 at the edge of the box against 0.084). `shotXgMul` 18 sets the shot / keep trade-off on those
two scales; estimateXg itself is unchanged in level (TAI-10's tests pin it).

### Still outside (QA-19, balance gate)

- Difficulty ladder (`npx tsx tools/ladder.ts --matches 40 --workers 2`): each level beats the one below in 37.5-50% of
  matches (target 65%; decisive share 59-71%, draws 28-38%). Widening every T_LEVEL spread (reaction 40..4 ticks,
  decision noise 1.0..0.02, execution error 3.0..0.5) moved nothing measurable in 40-match pairs (likely because the
  CPU's inputs go through the same assisted passing / shooting as a human's, so a noisier stick barely changes the
  kick, and execution error only touches shot aim / power and through-ball taps). The keeper's level reaction
  (above) lifted Amateur v Beginner from 27.5% to 50%.
- Balance (`npx tsx tools/balance.ts --matches 60 --workers 2`): top-bottom (88 v 62) 43.3% wins (was 20%; target
  80%), equal clubs 64.2% points (target 40-60%), mirror 45.8% PASS. Matches of these two clubs average 1.75 goals.
Both need skill to dominate outcomes far more than now (draws alone cap the win share); see the QF-2 report.

## QF-2 skeptic (Wave 3-4 second pass)

Verification of the first pass on other seeds (`tools/soak.ts --matches 100 --difficulty 3 --enforce all
--halfMinutes 4 --workers 2`): seed 2 (first-pass code) goals 2.22, shots 14.66, saves 69.2% (96-match batch); with
the changes below, seed 1 goals 2.57, shots 15.28, save rate 65.5% (96-match batch, `tmp/qf2/exp.sh`), seed 3 goals
2.38, shots 15.80; every other band, determinism, 0 exceptions / invariant failures / watchdogs on all three. The
shots band sits ~1 shot above its floor and the save rate at 65.5-69%: a faster keeper (reaction 5 / 17) gives 69.6%
saves but 2.02 goals, so the first pass's 6 / 19 stays.

| Where | Constant | Was | Now | Why |
|---|---|---|---|---|
| GKP-03 (`keeper/sweeper.ts`) | `keepReachSlack` (new) | - | 6 ticks | A rush under way whose interception estimate falls out of the horizon keeps the first point he reaches up to 6 ticks late (TAI-07 `estimateInterceptSlack`). His own reach of a ball rolling to the byline flickered "21 ticks" / "never" and the rush started and aborted on alternate ticks. |
| GKP-03 | `mateNearMissSlack` / `mateNearMissJump` (new) | - | 6 / 15 ticks | A start also counts a defender who reaches a much earlier window (the first bounce) up to 6 ticks late: his estimate flipped 25 <-> 137 ticks and the keeper started, aborted and restarted the rush (TAI-07's chaser swapped with it). |
| GKP-03 | `oneOnOneMateStart` / `oneOnOneMateKeep` (new) | (0 / 0) | 3 / 4 ticks | Loose-ball one-on-one: hysteresis between the striker's and the covering defender's arrival (a tie flipped it every other tick). Rush flip-flops in 26 scanned matches: 4 -> 0 (then 0 in 30 more). |
| TAI-07 (`ai/steer.ts`) | `blockedDist` / `blockedCos` (new) | - | 1.0 m / 0.5 | No ball-facing (lookAt) for a positional player while a body touches him on his way to the target: SIM-05's slide-around skips a player holding a facing, so a marker 2-3 m from his spot ran in place against the man on his line for seconds. |
| TAI-13 (`ai/setpieces.ts`) | `maxArrivalWait` | 45 | 58 ticks | The CPU corner / wide free-kick cross waits for its box runners up to just before RUL-04 / RUL-05's own CPU fallback (cpuRestartDelay + 60). |
| TAI-13 | `cornerRunWd` (new; box spots' distance weight) | 0.1 | 1.0 | Box spots went to centre-backs 45 m away by the aerial suitability alone; they also slowed to a jog inside 15 m (now: run until within arriveTol). Attackers in the box at a CPU corner kick: 1.57 -> 2.14 (40 matches); 3.1 once QF-1 raises the fallback (CR). |
| TAI-13 | `penInsetMax` | 1.1 m | 1.7 m | Every CPU penalty went 2.6-3.2 m out, beyond a full dive in time. |
| GKP-06 (`keeper/setpieces.ts`) | `diveMidY` | 1.05 m | 1.2 m | GKP-02's dive capsule slopes from the feet (hip - 0.5 m) to the hands, so a mid dive covered only ~1.1 m near his body; every CPU penalty is struck at 1.1-1.6 m. A right guess saved 1 in 19. |
| GKP-06 | `aiLowChance` / `aiMidChance` | 0.42 / 0.38 | 0.25 / 0.5 | A low dive cannot reach a ball above 0.6 m. Shoot-outs (36 cup matches): 87% -> 81.5% scored, a right guess saves 15%. |

Behaviour fixes without a constant: TAI-11 `maybeClear` presses nothing while a teammate has an open header / volley
attempt on the ball's flight (two defenders went up for the same header ~10 times a match), and SIM-12 `startAerial`
ends an AI teammate's open attempt when a controlled player starts his own on the same flight.

Balance and ladder after these changes (same commands as above, seed 1): balance top-bottom 61.7% wins (target 80%,
FAIL; was 43.3%), equal clubs 53.3% points (PASS; was 64.2%), mirror 56.7% (PASS); ladder 0/5 pairs (52.5 / 62.5 /
50 / 55 / 55% wins, decisive shares 69-81%; was 37.5-50%). Still a design question (QF-2 first-pass CR 7).
Lofted passes: SIM-15 `meetPoint` (QF-1) sends a controlled receiver to the first ground-track point he can reach,
ignoring the ball's height, and the CPU always controls its own receiver: LOB_PASS reached a teammate 2 times in 64,
keeper overarm throws 1 in 10 (8 out for a throw-in). With the one-line fix proposed to QF-1 (skip samples above head
height) the same matches give 38 / 65 and 11 / 11, and a 100-match soak still passes every band (pass completion 77.2%,
shots 14.53, blow-outs 4%): re-check shots and blow-outs, and re-fit TAI-09's aerial completion factors, once it lands.

## QF-9 (Wave 4 round 2: control, bodies, receiving, defending)

Every change alters sim behaviour (hashes move). Measured with `npx tsx tools/soak.ts --matches 60 --enforce all
--halfMinutes 4 --workers 2` (mixed difficulties, with QF-10's in-progress kick / rules changes in the tree). The tree
without the QF-9 files (seed 1): goals 2.22, shots 14.73, pass completion 73.6%, possession 57.1%, fouls 10.6, corners
1.70. Final QF-9 code: seed 1 goals 2.52, shots 15.18, pass completion 75.7%, possession 55.9%, fouls 12.1, offsides
0.14, blow-outs 1.7%, corners 0.55; seed 2 goals 2.58, shots 15.38, pass completion 77.4%, possession 56.2%, fouls 11.5,
blow-outs 0% (every band PASS, 0 exceptions / invariant failures / watchdogs, determinism PASS). `tools/fuzz.ts
--matches 60 --enforce all`: PASS. Lofted passes over 4 Professional matches (seed 515, 4-minute halves): LOB_PASS
reached its target 24 / 48 (most of the rest headed or volleyed by an opponent: contested aerials, TAI-09's choice),
keeper throws 15 / 15. Corners fell from 1.70 to ~0.6 a match (8 minutes): 17 of 24 corners in an 8-match sample came
after a defender's FIRST_TOUCH of a shot, the artefact item 5 removes (the controlled defender "received" every shot
within 1.1 m and his heavy touches ran out); not a section 7 band, for QF-11 to watch.
QF-9 skeptic (contest wait, meeting-point grid, first-time timing and meet run, busy-body shot blocks; same tool, seed
1, final code): goals 2.88, shots 16.92, possession 57.5%, pass completion 75.5%, fouls 11.6, offsides 0.12, blow-outs
1.7%, every band PASS, 0 exceptions / invariant failures / watchdogs, determinism PASS; `tools/fuzz.ts --matches 60
--enforce all`: PASS. First-time kicks that missed a ball nobody else touched (10 CPU matches, seeds 930-939): 8 / 69
(was 12 / 61).

| Where | Constant | Was | Now | Why |
|---|---|---|---|---|
| SIM-15 (`control/resolveShared.ts`) | `meetMaxHeight` (new) | - | `T_TOUCH.trapHeight` (1.6 m) | The receiver's meeting point skips the part of a lofted ball's track above this height and meets it where it comes down through it (exact crossing points, so the target does not jump with the 0.125 s sampling grid). 2.0 m (head height, the CR's value) left a CPU receiver waiting under a keeper throw that passed at 1.9 m with no header started (out for a throw-in), and a dink peaking near 2 m flipped the target 2 m back and forth. |
| SIM-15 (`control/resolveMove.ts`) | `T_TOUCH.meet*` | via `LOCAL_TUNING` | read directly | Charter: the overshoot / catch-up constants live in `T_TOUCH` (values unchanged). |
| SIM-04 (`players/locomotion.ts`) | `T_PLAYER.staminaRefHalfMinutes` | via `LOCAL_TUNING` | read directly | Charter (value unchanged). |
| SIM-16 (`control/switching.ts`) | `receiveMinSpeed`, `selfKickTicks` (new) | - | 3 m/s, 12 ticks | Mirror SIM-07 / SIM-06 for "the ball rolls into him" (no auto-switch away from a man the loose ball passes within SIM-07's receive reach of in the next aboutToReceiveTicks). |
| SIM-16 | `contestTicks` (new) | - | 2 ticks | Loose-ball auto-switching waits while an opponent reaches the ball more than this before our best candidate (16 of 35 flip-flops within 0.5 s in a 4-match scan came from switching to our chaser, then straight back to the goal-side man once the opponent's receiver controlled it; in the same 4 matches: 35 flip-flops -> 17 at 2 ticks (13 at 0, 19 at 4); the rest are mostly a change of possession in between, e.g. our pass intercepted). |
| SIM-05 (`players/bodies.ts`) | `slideBehindSpeed` (new) | - | 1.6 m/s (>= `slideSpeed`) | A pusher gives way behind a body moving across his push faster than this: his speed along its run is capped `slideSpeed` below its own (never negative). Fixes the body lock of a runner beside a man running the same way (80 ticks at 0.75 m, 14 velocity flips). 1.0 alternated with the world-frame slide against a marker drifting across at 1.0-1.3 m/s (6+ flips in 2 s). The cap is reached at most at `T_PLAYER.decel` (cutting 4-5 m/s in one tick changed TAI-07's chaser on a header in front of the box: qf-2-keeper-rush-hysteresis). |
| SIM-07 (`players/firstTouch.ts`) | `qHeavyLo` | 0.25 | 0.1 | Section 6 / DAT-05: a 40-ballControl player got 0% clean first touches of a 20 m/s ball under pressure or from behind. Now (clean %, 40 / 65 / 90 control, 20 m/s): facing 39 / 71 / 100, pressed 13 / 56 / 92, from behind 4 / 47 / 87; soft passes stay 100% clean for everyone. |
| SIM-07 | `settleLatMax`, `settleLatMinTime`, `settleSolve*` (new) | - | 3 m/s, 0.2 s, 2.5 s / 1/30 s / 14 / 8 m/s | Clean settle rewritten: along his intended direction the ball's speed is solved so its lead over him peaks at the trap lead for the speed he will have when the FIRST_TOUCH window ends (planned with the capped run), capped by the speed that reaches the spot at the window's end; sideways it closes onto his line. Was: 14 m/s for a sprinting receiver who braked to 7 m/s, the ball 2.6 m clear in 15 ticks (QF-2 CR first-touch sprint). |
| SIM-14 (`defend/tackle.ts`) | `shotBlockHeight` (new) | - | 1.8 m | Fresh shots go through interceptContacts: an outfield opponent's body in the path blocks them up to this height (a stretched-leg roll only up to `interceptMaxHeight`); SIM-07 no longer lets outfield opponents "receive" a fresh shot (QF-2 CR shot block). |
| SIM-16 (`control/switching.ts`) | `contestInPlayTicks` (new, QF-9 skeptic) | - | 180 ticks | The loose-ball contest wait (`contestTicks`) applies only in AUTO (AIR_AND_LOOSE has no carrier rule to switch later: the human default was never switched for an opponent's lofted pass and stayed on a full-back 30 m from the drop) and only while the current man can get to where the opponent meets the ball within this many ticks from now (about 20 m from a standstill; counted from now so the decision does not change as the ball arrives while he stands). A man farther off is never the one control flips back to. |
| SIM-15 (`control/resolveShared.ts`) | `meetPoint` sample grid (no constant; QF-9 skeptic) | every `meetStepSec` from now | every `meetStepSec` of absolute match time | The samples are the same track points tick after tick, so the idle receiver's target holds still while a firm pass comes (it crept on with the ball by 0.2 m a tick and was thrown back by v x 0.125 s every 7-8 ticks: 61 velocity reversals over an 80-case table of 9-21 m/s passes, 3-11 in a single pass; now 11, at most 1 per pass). |
| SIM-15 (`control/resolveShared.ts` / `resolveActions.ts`) | first-time kick timing (no constant; QF-9 skeptic) | `ballEta`: ticks until the ball reaches his centre, his run ignored | `ballReachEta`: ticks until it enters `reachRadius` (1.2 m, the kick's reach), with his run along its track | The first-time timing read 10-13 ticks while the ball was 1-2 ticks from his reach when he ran onto the pass: the press fired late and the kick whiffed (7 of 12 cases with the stick held toward an 11-17 m/s pass) or SIM-07 trapped the ball first (sim-15 first-time cross once the receiver stopped shuffling). `ballEta` still decides the own-third clearance (launched at once; its kick needs the longer lead to line up: timing it by `ballReachEta` raised the CPU's first-time clearance whiffs) and TCH-04's CLEAR label. |
| SIM-15 (`control/resolveMove.ts`) | idle-stick first-time kicker (no constant; QF-9 skeptic) | coasted on his last run (DIRECT, no intent) | meets the ball's path (`meetPoint`) facing the ball while a KICK / SHOT of an arriving loose ball is wound up | A human's first-time clearance with the stick released (a defender running diagonally onto a 9-20 m/s ball) drifted off the ball's line, the ball passed ~1 m from his kicking spot and the kick whiffed. |
| SIM-14 (`defend/tackle.ts`) | fresh-shot body block (no constant; QF-9 skeptic) | free defenders only | also busy ones (tackle wind-up / glide / recovery, stumble, get-up, header / kick wind-up, shield, stunned, `noTouchT`) | A shot struck while a tackle came in passed straight through the tackler's body; a busy man never traps it (always a DEFLECTION); a man lying FALLEN and RUL-05 wall members (WALL_JUMP blocks free kicks itself) are left out. |

## QF-10 (Wave 4 round 2: kicks, actions, restarts)

Every change alters sim behaviour (hashes move). Measured with `npx tsx tools/soak.ts --matches 60 --enforce all
--halfMinutes 4 --workers 2` (the whole tree with QF-9's changes; every band PASS, 0 exceptions, invariant failures,
watchdogs, determinism PASS): seed 1 goals 2.52, shots 15.18, possession 55.9%, pass completion 75.7%, fouls 12.06,
offsides 0.14, blow-outs 1.7%; seed 2 goals 2.75, shots 16.32. The same tree without QF-10's files: seed 1 goals 3.02,
shots 15.48; seed 2 goals 2.90, shots 15.92 (goals 2.64 vs 2.96 over the 120 matches, ~1.5 standard errors; shots
on target 63% vs 64%). The last run on the final tree (QF-9 skeptic edits included), seed 1: goals 2.87, shots 16.03,
pass completion 75.1%, fouls 10.96, blow-outs 3.3%, every band PASS. `tools/fuzz.ts --matches 60 --enforce all`: PASS
(0 exceptions / invariant failures / watchdogs).
QF-10's files alone on the round-2 baseline (8 CPU matches, 4-minute halves, seeds 100-107): goals 2.9 (baseline
2.5), shots 18.8 (18.6), corners 2.5 (1.1), throw-ins 14.8 (14.6), free kicks 4.6 (4.8); foot kicks started vs struck (6 matches): 2.5% whiffs (baseline 2.6%).

| Where | Constant | Was | Now | Why |
|---|---|---|---|---|
| `T_PASS` | `releaseStrikeTicks` (new) | 0 | 2 ticks | A charged foot kick (pass, lob, cross, through ball, shot; also a tapped kick whose double-tap grace ran out) strikes the ball this long after its power bar is released, the ball held on the kicking spot meanwhile: it was struck on the release tick, so the render (clip held at the backswing top) showed the strike after the ball had gone (QF-4 CR). A first-time kick of an arriving ball keeps its tick. Implemented in `kicks/kickCommon.ts` (`releaseStrike`, marker bit 8 of `actA`). |
| `T_BALL` | `bounceFriction` | 0.12 | 0.18 | Long balls skipped on 37-47 m after their first bounce (20-30 m/s lofted launches), now 31-41 m. 0.18 is as far as SIM-08's dinked-pass model keeps the arrival speed within 0.6 m/s of the plan on a 1 m grid of targets (6-45 m, five powers); at 0.19-0.2 a few short dinks at full power arrive 0.7-0.8 m/s fast (the arrival speed jumps by bounceFriction at every bounce). |
| SIM-08 (`kicks/pass.ts`) | `dinkAngleOffsets`, `dinkBounceMargin`, `dinkNudge` / `dinkNudgeSteps`, `dinkArriveTol`, `dinkMaxTrials` (new) | - | [0, 0.06, -0.06, 0.12, -0.1] rad, 0.04 s, 1% x 4, 0.3 m/s, 40 | The dinked model now integrates every hop (SIM-01 air steps, SIM-02's impact at its substep timing) instead of a closed-form hop with horizontal drag only (it drifted ~0.3 m behind the sim by the fourth bounce), and the bisection, which settles where a bounce meets the target (the sim's tick then shows the ball 1-1.7 m/s off the plan), tries a few launch angles and nudges the speed until the target is reached clear of a bounce. Cost per dinked pass: p50 ~32, max ~54 model trials. |
| SIM-08 / SIM-11 | `ownReachWaitTicks` (new) | - | 14 ticks | His own ball out of a foot's reach at the contact tick (a sprint touch 1.4-2.1 m ahead, a ball still dropping from a chest trap, a ball behind him) waits for SIM-06's hold to bring it onto the kicking spot; it used to be kicked from wherever it was (1 foot kick in 10, QF-1 CR). |
| SIM-11 (`kicks/shot.ts`) | `contactGraceTicks` | 14 | 20 ticks | A first-time shot now strikes at the kicking spot (below), a few ticks after the ball enters his body reach. |
| `kicks/kickCommon.ts` | `KICK_TUNING.spotAhead` / `spotReach` | - | SIM-06 `holdAhead` (0.5 m) / 0.9 m | A foot strikes the ball only within spotReach of the kicking spot (and reachRadius 1.2 m / reachHeight 0.8 m of the body): no more kicks of a ball behind the kicker or beside him through his body. |
| `kicks/kickCommon.ts` | `takerStep` / `takerLinedUp` / `takerLineUpMaxTicks` (new) | - | 0.08 m/tick / 0.4 m / 45 ticks | A restart taker whose kick goes another way than his line-up (a CPU free kick passed backwards, a back-pass kick-off) side-steps round the dead ball to behind it before the strike (he kicked it through his own body). |
| RUL-11 (`rules/restart.ts`) | `setupWalkSpeed`, `setupExtendMaxTicks`, `cutFreeKickGoalDist` (new) | - | 4.5 m/s, 180 ticks, 35 m | Walked set-ups (throw-ins; free kicks more than 35 m from the attacked goal, which GFX-15 shows on the main camera): the taker runs to his spot and illegal players walk out from the award, and the set-up waits past restartSetupTicks for them (median ~100 ticks from the award, at most 230), then places any straggler. Was: everyone teleported at restartSetupTicks (throw-in takers up to 18 m, free-kick takers up to 61 m, in view; QF-4 CR, D-008). |
| RUL-11 (`rules/restart.ts`) | `setupStragglerMaxTicks` (new), `setupExtendMaxTicks`, `setupTakerRunMinSpeed` (new) | 180 (one cap) | 180 / 270 ticks, 2 m/s | [QF-10 second pass] Stragglers are placed 180 ticks past restartSetupTicks, but while the taker is still running in (not in place, closing on his spot at 2 m/s or more) the set-up waits up to 270: a throw-in or free-kick taker who started 22-36 m away was teleported 6-25 m at the old cap, in view. 270 keeps ready + the 12 s human timeout + the 2 s Default grace inside the throw-in phase limit (1200 ticks). CPU matches (32 x 4-minute halves): taker distance at a walked award p99 17 m, max 18 m, so this only matters for long balls into touch far from everyone. |
| RUL-05 (`rules/freekick.ts`) | `downClear` placement (no constant) | - | never across a penalty-area line | [QF-10 second pass] The free kick moved 1.3-2.6 m off the fouled player could cross the area line (a foul just outside the box became a free kick inside it); such candidates are skipped. |
| RUL-11 (`rules/restartCommon.ts`) | `approachSpeedFrac`, `approachArrive`, `approachClear`, `faceGain` (new) | - | 0.85 of top speed, 0.25 m, 0.8 m, 0.2 | The walked free-kick taker's run (ARRIVE, round the ball), then he turns to his aim while waiting. |
| RUL-02 (`rules/throwin.ts`) | `approachSpeed`; `approachTopFrac`, `approachAccel` (new) | 5 m/s (instant) | 6.5 m/s, at most 0.85 of top speed, reached at 7 m/s^2 | The throw-in taker runs to the line during the walked set-up (he was teleported there at restartSetupTicks). |
| RUL-05 (`rules/freekick.ts`) | `takerWalkMaxDist`, `downClear` (new) | - | 18 m, 1.3 m | A free kick on the main camera goes to the best taker within 18 m (else the nearest), who can run there; the ball is placed beside the fouled player lying on the foul spot, not under him. |
| RUL-04 / RUL-05 | `cpuGraceTicks` | 60 / 75 | 140 | The CPU corner / free-kick fallback leaves TAI-13 time to wait for its box runners (QF-11 can raise TAI-13 `maxArrivalWait`); the fallback and its first retry stay before RUL-11's 4 s CPU watchdog. |
| RUL-11 | penalty legality | centre outside the area / arc | whole body (SIM-05 radius) outside | Players waited at a penalty with their centre on the area line, half the body inside. |
| RUL-11 | goal-frame rule (no constant) | - | non-keepers kept `T_PLAYER.bodyRadius` in front of the goal line inside the posts' width (+ post radius + body radius) | A player behind the goal line at a goal kick or corner was placed at the nearest legal point on the line, overlapping the post / net (QF-1 goal-frame test). |
| RUL-11 (`rules/restartCommon.ts`) | `swapRunMaxTicks` (new) | - | 240 ticks | "Choose the taker" (SPRINT) at a walked free kick runs the new taker (within 18 m) to the ball and releases the old one where he stands; kick inputs wait until he is there. Was: both teleported (up to 18 m each) on the main camera. Free kicks within 35 m keep the instant swap (set-piece camera). |
