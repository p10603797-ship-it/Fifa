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

## QF-11 (Wave 4 round 2: difficulty ladder and club balance)

Measured on the tree with QF-9 / QF-10's sim changes. Tools: `tools/ladder.ts` / `tools/balance.ts` (4-minute halves,
mirror legs) and, for experiments, a scratch runner that overrides `T_*` entries per run (40-60 matches a variant,
every variant against the same seeded configs, so unchanged pairs replay identically).

### What separates the levels (one lever at a time, Legend side vs Beginner side, 40 matches, goal difference)

Every other table at Professional; "GD" = the first side's goals minus the second's per match (+-1 standard error).

| Lever (old table) | Extremes | GD | Reading |
|---|---|---|---|
| decisionNoise | 0.05 vs 0.45 | +1.62 +-0.29 | The strongest. 0 vs Professional's 0.16: +1.60; 0.05 vs 0.16: +0.85; 0.16 vs 0.6: +0.88 (steep near none, flattening). The carrier's option noise is almost all of it (without rash lunges +1.35; with only the carrier noiseless +0.35): a noisy carrier takes the best of many noisy utilities, and the many near-equal safe square passes win that lottery, so attacks die. |
| reactionTicks | 5 vs 26 | +1.27 +-0.29 | 11 vs 40: +2.02 (the slow side keeps running head-down after every reception); faster than 11 adds little (2 vs 11: +0.23). |
| keeperReactTicks | -3 vs +10 | +0.05 | Small until large: +20 ticks: +0.72. |
| executionError, lookAheadTicks, tackleTimingTicks, shotThresholdXg | full range | -0.20 .. +0.05 | No measurable effect (the CPU's inputs go through assisted passing / shooting; the controlled defender's timing matters little). |
| pressIntensity | 0.95 vs 0.35 | -0.40 +-0.27 | Pressing harder is not better here (0.95 vs 0.75: +0.03). |
| re-decision period (new) | 3 vs 15 ticks | -0.60 +-0.22 | Re-deciding often is worse: with noise more draws of the lottery, without noise the first pass that edges ahead is taken (noise 0: every 3 ticks +0.88, every 5 +1.60). |
| marking gap x2.2, back line x0.4 speed, shape updates every 24 ticks, loose-ball chase delay 40, pass risk / loss cost perception (new, tried) | | -0.40 .. +0.15 | Alone, none measurable; marking and line together with a slow keeper decide the bottom pairs (below). The perception, shape and chase levers were removed again. |

### Pair-by-pair follow-up (100 matches a variant, ladder seeds; "s2" = a second seed)

| Pair | Variant | Wins (GD) | Kept |
|---|---|---|---|
| Amateur v Beginner | tables as below but Beginner reaction 60 | 56% (+0.65); s2 61% (+1.02) | - |
| | Beginner marking x2.6, line x0.35 | 63% (+1.09) | - |
| | Beginner keeper +40 | 60% (+0.98) | - |
| | Beginner reaction 80 | 78% (+1.71); s2 75% (+1.52) | yes |
| | Amateur reaction 36 | 61% (+1.24) | - (also lifts Amateur against Semi-Pro) |
| World Class v Pro / Legend v World Class | as below, driven factor 1 | 67% / 74% (+1.14 / +1.33); s2 60% / 60% (+1.07 / +0.80) | - |
| | World Class noise 0.072 | 73% / 51% | - |
| | Legend re-decision every 16 ticks / Legend keeper -14 | - / 69%, 69% | - |
| | driven-pass calibration (TAI-09 below) | 64% / 73% (+1.40 / +1.23); s2 67% / 63% (+1.23 / +1.09) | yes |
| | + World Class / Legend marking x0.85 / x0.7, line x1.15 / x1.3 | 70% / 63%; s2 67% / 64% | - |
| | + Professional noise 0.18, World Class 0.09 | 70% / 61%; s2 59% / 68% (Pro v Semi-Pro 73% / 69%) | - |
| | + World Class re-decision every 8 ticks | 73% / 67%; s2 72% / 57% | - |

Every World Class variant moves win share between its two pairs (the sum of the two goal differences stays at about
2.4-2.5 goals): Legend decides without noise already and its other levers (patience, keeper, reaction) are saturated,
and a noisier Professional does not widen the World Class v Professional gap measurably. The kept split is the most
even one.

### Tables (`T_LEVEL`, Professional unchanged, so the section 7 bands keep their reference)

| Table | Was | Now |
|---|---|---|
| reactionTicks | 26 / 20 / 15 / 11 / 8 / 5 | 80 / 42 / 24 / 11 / 6 / 1 |
| decisionNoise | 0.45 / 0.33 / 0.24 / 0.16 / 0.1 / 0.05 | 0.5 / 0.38 / 0.275 / 0.16 / 0.085 / 0 |
| pressIntensity | 0.35 .. 0.95 | 0.6 / 0.65 / 0.7 / 0.75 / 0.78 / 0.8 |
| keeperReactTicks | 10 / 6 / 3 / 0 / -2 / -3 | 30 / 21 / 10 / 0 / -3 / -8 |
| carrierEvalTicks (new; T_AI.carrierEvalInterval 5 before) | - | 5 / 5 / 5 / 5 / 6 / 12 |
| markGapMul (new, TAI-04) | - | 2.0 / 1.6 / 1.26 / 1 / 1 / 1 |
| lineRateMul (new, TAI-04) | - | 0.5 / 0.65 / 0.8 / 1 / 1 / 1 |
| composureNoiseWeight (new) | - | 0 / 0 / 0.5 / 1 / 0 / 0 |

lookAheadTicks, executionError, tackleTimingTicks and shotThresholdXg keep their values (monotonic, no measurable
effect). What a player sees: a Beginner carrier runs on head-down for over a second after he gets the ball and then
plays the safe square pass; his defenders keep their runs as long after a turnover; his team marks loose, its back
line steps late, its keeper reacts half a second late. Both runs turn along a touchline or goal line instead of over
it (`carrier.ts edgeMargin`, `T_CPU.defendMomentumEdgeMargin`). A Legend carrier decides without noise and carries
the ball patiently to the better option; his keeper is sharp. None of it touches physics, attributes or stamina.
Beginner v Beginner is a low-event match (40-match soak: 1.9 goals, 8.9 shots, 81.7% passing; the section 7 bands
are Professional's).

### Club balance (`T_AI.composureNoise*`)

The player's composure scales the CPU's decision noise on him (`composureNoiseMul`: x clamp(1 + 0.65 x (72 -
composure) / 30, 0.4, 1.8); the 88-rated MOS starters average 87, the 62-rated ROO 57), weighted by level
(`composureNoiseWeight`). Top-bottom at Professional (40 matches each): slope 0 57.5% wins (GD +0.88), 0.5 72.5%,
0.7 90%, 0.75 90%, 1.0 92.5%; kept 0.65 (100 matches: 80.0%; final 200: 82.5%). Weighted at every level it narrowed
the ladder at the top by 10-15 points (the cost of noise is concave, so a spread of noise round a level's noise
shrinks the average gap to the next level), hence the weights.

### Final measurement (this tree, `tools/ladder.ts --matches 200`, `tools/balance.ts --matches 200`, seed 1)

| Pair | n | W / D / L | Wins (95% CI) | Goals | Target 65% |
|---|---|---|---|---|---|
| Amateur v Beginner | 200 | 142 / 35 / 23 | 71.0% (64.4-76.8) | 2.18-0.76 | meets |
| Semi-Pro v Amateur | 200 | 153 / 28 / 19 | 76.5% (70.2-81.8) | 2.50-0.81 | meets |
| Professional v Semi-Pro | 200 | 147 / 34 / 19 | 73.5% (67.0-79.1) | 2.81-0.88 | meets |
| World Class v Professional | 200 | 129 / 40 / 31 | 64.5% (57.7-70.8) | 2.35-1.15 | one win short |
| Legend v World Class | 200 | 132 / 33 / 35 | 66.0% (59.2-72.2) | 2.21-1.13 | meets |

Before QF-11 (40 a pair): 37.5 / 55 / 42.5 / 42.5 / 52.5%. The two top pairs share a fixed Legend-Professional gap
(see the follow-up table). A second, independent run of the top pairs (`--pairs 3,4 --seed 2 --matches 200`): World
Class v Professional 132 / 39 / 29 = 66.0% (59.2-72.2), Legend v World Class 131 / 42 / 27 = 65.5% (58.7-71.7); over
both seeds (400 matches each) 65.3% and 65.8%.

| Balance (Professional) | n | W / D / L | Result | Target |
|---|---|---|---|---|
| top-bottom MOS (88) v ROO (62) | 200 | 165 / 22 / 13 | 82.5% wins (76.6-87.1); goals 2.35-0.56, shots 11.2-3.5 | wins >= 80%: meets |
| equal SND (76) v GLA (75) | 200 | 99 / 42 / 59 | 60.0% points (53.1-66.5) | 40-60%: meets (at the edge) |
| mirror GLA v GLA | 200 | 66 / 46 / 88 | 44.5% home points (37.8-51.4) | 40-60%: meets |

The "equal" pair is the closest by club rating, not by strength where it counts: SND's striker is 84-rated (finishing
85, composure 83) against GLA's 70 (79 / 68), and SND out-shoot GLA 8.4 to 6.7 (on target 5.8 to 4.4) with even
possession (49.9%) and pass completion (79-80%); before QF-11 the same pair measured 53.3% over 60 matches.

### Section 7 bands across clubs and styles (QA-20; `tools/soak.ts --matches 500 --difficulty 3 --enforce all`)

All 500 finished, 0 exceptions / invariant failures / watchdogs, determinism PASS. Bands: goals 3.39 (2-3.6), shots
17.75 (14-26), dominant possession 56.6% (40-60), home possession 50.8%, pass completion 77.8% (70-88), fouls 13.55
(6-16), offsides 0.16 (0-6), blow-outs 2.8% (< 5%). Split by the clubs in the match (random clubs and formations):

| Matches with | n | Goals | Shots | Pass % | Fouls | Dominant possession |
|---|---|---|---|---|---|---|
| a COUNTER side | 187 | 3.34 | 17.9 | 77.1 | 12.8 | 57.3% |
| a DIRECT side | 186 | 3.48 | 18.2 | 77.4 | 13.1 | 56.5% |
| a HIGH_PRESS side | 168 | 3.05 | 17.7 | 78.2 | 13.5 | 56.4% |
| a POSSESSION side | 177 | 3.56 | 17.2 | 78.7 | 13.5 | 57.2% |
| a WING_PLAY side | 209 | 3.46 | 17.6 | 77.8 | 14.3 | 56.1% |
| both clubs rated < 75 | 108 | 3.06 | 17.0 | 78.1 | 14.5 | 56.7% |
| both >= 75 | 154 | 3.53 | 17.6 | 78.1 | 12.9 | 56.6% |
| one of each | 238 | 3.45 | 18.2 | 77.5 | 13.5 | 56.6% |

Per side: POSSESSION keeps 53.4% of the ball at 79.8% passing, COUNTER 47.3% at 76.0%, DIRECT shoots most (10.1 a
match). The stronger club by rating wins 41.6% (gap < 6, 21% draws), 53.8% (6-11), 61.7% (12-17) and 74.6% (18+;
goal difference +0.14 / +0.72 / +1.09 / +1.69).

### Corners (round-2 question: does corner frequency feel low?)

Yes. Professional bot matches (16, 4-minute halves) see 0.75 corners a match (soak: 0.6-0.9 by style) against 5.25
goal kicks; of the corners 0.31 come off the keeper (parry / tip), the rest off defenders' blocks and deflections.
The largest single cause of goal kicks (2.0 a match) is an attacker's contested header 10-35 m out flicked straight
on over the goal line (SIM-12 aiChoose heads it at `dir` with no target): a CR to the kicks owner
(`tests/scenario/qf-11-cr-header-flick-out.test.ts`). More corners would come from keepers parrying wide of the post
(GKP-02 parry angles) and blocked crosses; neither was changed this round (they move the goal bands and rebound goals).
At the corner kick the CPU now has 3-6 attackers in the box in 31 of 34 real corners (seeds 1-44); the other 3 went at
the end of the wait (cpuRestartDelay + maxArrivalWait, just before RUL-04's CPU fallback) with the third runner still
8-33 m away (`tests/scenario/qf-4-cr-corner-box.test.ts`).

### TAI-09 completion calibration (`T_CPU`, Professional, 56 matches with the lofted factors at 1)

| Kind | Estimated | Completed (next touch by a teammate) | Change |
|---|---|---|---|
| Ground pass | 0.92 | 0.94 (4904) | - |
| Driven pass | 0.80 | 0.70 (2016) | round 2: `passDrivenCompletionMul` 0.87 (to the intended receiver 0.52) |
| Lob pass (chosen) | 0.72 raw | 0.76 (41) | `passAerialMin/Max` 0.4 / 0.6 -> 0.85 / 1.0 (QF-9's lofted receiver) |
| Lofted through ball | 0.21 raw | 0.16 (172) | `passThroughLobCompletionMul` 0.25 -> 0.75 |
| Ground through ball | 0.77 | 0.40 (143) | `passThroughGroundCompletionMul` 1 -> 0.52 |
| Cross | 0.24 | 0.06 (67) | `passCrossCompletionMul` 1.6 -> 0.4, `passCrossCompletionAdd` 0.12 -> 0 |
| Driven pass (round 2) | 0.80 (Professional) / 0.84 (Legend, 40 matches) | 0.70 / 0.73 (529 at Legend) | `passDrivenCompletionMul` (new) 0.87 |

With the CPU's own 12-match run at the old factors, lobs were never chosen (0 in 12 matches).

## QF-11 skeptic (Wave 4 round 2, second pass)

Defects found from new angles and fixed (each with a regression test in `tests/scenario/qf-11-sk-*.test.ts`); all
change sim behaviour (hashes). Each fix is kept to where the glitch lives: the first, broader versions (gather anywhere
in the box, tip lift re-planned, a larger momentum margin, the chase penalty at every level) cost the top-bottom
balance about 6 points (MOS v ROO 76.5% / 74.5% on seeds 1 / 2 against 82.5% / 80.5% with all five off: the weaker
side's keeper, under far more pressure, profits most from a keeper who gathers everything).

| Defect | Measured before | Fix | After |
|---|---|---|---|
| Loose ball at a low level: the chase was left to the CPU's controlled player still keeping his old run (reaction delay, TAI-11 branch 2) the other way | Beginner, 4 short matches: 34 stretches of 20-74 ticks (up to 1.2 s) with nobody going for the ball while a teammate would have got there sooner | TAI-07 `assignChaser` (`reactionLeft`): while more of his delay remains than the chaser hysteresis (so only below Professional), such a player is later by the remaining ticks and makes no near claim (`T_AI.chaserReactNearDist` 1.2 m: on the point counts as going); our own pass in flight has no delay | 0 stretches over 16 ticks |
| Sprinting CPU defender in his reaction delay ran off the pitch (the first pass's fixed 2 m edge margin is shorter than his braking distance) | 9 m/s straight at a line: 2.2-2.4 m past it | `defending.ts momentum`: margin = max(2 m, v^2 / (2 x `T_PLAYER.decel`) + `T_CPU.defendMomentumBrakeSlack` 0.5 m) | stops on the pitch |
| Idle AI keeper left a loose ball in his goal area (post rebound, ball dropping on his line) to SIM-07's outfield first touch, which follows his run back to his line into his own net | 2 own goals in 30 Professional matches (4-minute halves); constructed rebound: 12 own goals in 24 | GKP-02 gather (`saves.ts`, goal area only): hands within `T_GK.gatherReach` 1.15 m (>= SIM-07 receive reach) when he may handle it, it is catchable and he has reacted; else the reflex body block or nothing | 24 of 24 rebounds held |
| A shot already past an unreacted keeper: the save decision freed him and SIM-07 gave him a heavy first touch on it from behind | it went in off him as an own goal (scorer lost) or was stopped by a keeper who never saw it: 12-18 touches, 4 own goals in 36 constructed shots | GKP-02 `passedHim`: he stays put (running GK_CATCH kept, idle keeper plants) while it is on its way in | 0 touches, 0 own goals |
| Tip over from under the bar's footprint (contact closer to the line than ball radius + bar): the ball rose into the underside of the bar and dropped in | an own goal in a match; 12 of 72 constructed tips / parries at the line went in | `keeperContact`: no tip from closer than `T_GK.tipBarFront` 0.25 m; he parries it out | 0 of 72 |
| A rushing keeper (GKP-03) taken into a set catch (GKP-02) for a slow ball at the edge of reaching his line dropped it 1-3 ticks later when the prediction flickered and rushed again (start / abort flip-flop; caught by the QF-2 keeper scan on a new trajectory) | 6 of 160 constructed slow balls | GKP-02: a set GK_CATCH is kept up to `T_GK.catchKeepTicks` 12 while the ball still comes at him (actB counts the ticks without a threat) | 0 of 160 |

### Verification of the first pass's numbers (same tools, more seeds)

The first pass's balance PASS rested on seed 1. On its own tree (the five fixes above switched off, which reproduces
its seed-1 run hash for hash: 165 / 22 / 13) MOS (88) v ROO (62) wins 82.5 / 80.5 / 77.0 / 75.0% on seeds 1-4:
**78.8% over 800, below the 80% target**. Its ladder top pairs were 65.3% / 65.8% over two seeds; Legend v World
Class over three seeds on the fixed tree 57 / 66 / 62.5% (500 matches: 62.8%).

### Club balance and the ladder's top pair (QA-19 / QA-20 trade-off)

`T_AI.composureNoise*` alone could not move the top-bottom pair without moving the closest-rated pair (SND v GLA)
with it: SND's striker is the composure gap (83 v 68), so slope 0.8 gave 80.5 / 77.5% top-bottom and 59.5 / 63.5%
equal. Wider keeper ranges (`T_GK` react 4-24, reach 1.9-3.3, dive speed 4.0-7.2) helped the equal pair (GLA's
keeper is better) but not top-bottom (77.5 / 79.5%): reverted. Vision is where MOS and ROO differ (78 v 52) and SND v
GLA do not (63 v 66): `visionNoiseMul` (TAI-08 carrier option noise, weighted like composure). Its bonus side is what
moves top-bottom (noise is cheapest to cut near none), but at Professional only it also brings a strong club's
Professional towards World Class:

| Levers (Professional; 200 a seed, mirror legs) | MOS v ROO wins (4 seeds, 800) | SND v GLA points (800) | World Class v Pro (2 seeds, 400) | Legend v WC (400) |
|---|---|---|---|---|
| composure 0.65 (first pass; with the five fixes) | 76.5% | ~59% (seed 1: 58.8) | 68.0% (300) | 62.8% (500) |
| composure 0.45, vision +-0.7 (symmetric), WC noise 0.085 | 82.0% | 55.4% | 62% (seed 1, 100) | 63% (seed 1, 100) |
| composure 0.45, vision penalty 1.2 / bonus 0.45, WC 0.095 | 81.5% | 54.3% | 62.8% | 65.5% |
| composure 0.45, vision penalty 1.2 / bonus 0.25, WC 0.095 | 76.6% | - | 65.5% | 65.5% |
| **kept: composure 0.45, vision penalty 1.2 / bonus 0, WC 0.095** | **76.9%** | **55.3%** | **69.3%** | **65.5%** |

Kept: the ladder (what a player feels choosing a difficulty) over the last 3 points of top-bottom; the lead can trade
with `T_AI.visionNoiseBonusSlope` (0.45 meets top-bottom and costs World Class v Professional, as the table shows).
`T_LEVEL.decisionNoise` World Class 0.085 -> 0.095 splits the top two pairs.

### Final measurement (this tree, seed 1)

- `tools/ladder.ts --matches 100`: Amateur v Beginner 68%, Semi-Pro v Amateur 68%, Professional v Semi-Pro 81%,
  World Class v Professional 66%, Legend v World Class 66% (5 of 5); the top pairs over seeds 2-3 (200 each, before
  the catch hysteresis): 69.3% and 65.5%.
- `tools/balance.ts --matches 200`: top-bottom MOS v ROO 80.5% wins (161 / 21 / 18), equal SND v GLA 60.0% points
  (96 / 48 / 56), mirror GLA v GLA 51.5% home points. Seed 1 meets all three, but over seeds 1-4 (before the catch
  hysteresis) top-bottom is 76.9% and equal 55.3%: the top-bottom target is not met robustly (see the table above).
- `tools/soak.ts --matches 500 --difficulty 3 --enforce all`: PASS; goals 3.27, shots 17.30, dominant possession
  56.98%, home possession 50.94%, pass completion 78.31%, fouls 12.71, offsides 0.13, blow-outs 3.4%; 0 exceptions,
  invariant failures or watchdogs; determinism PASS.

## QF-13 (Wave 4 round 3: balance robustness and the last gameplay CRs)

Measured with `tools/ladder.ts` / `tools/balance.ts` / `tools/soak.ts` (4-minute halves, mirror legs, Professional
unless stated) and, for experiments, a scratch runner that overrides `T_*` entries per run on the same seeded configs
(it reproduces the tools' numbers match for match). Every change below changes sim behaviour (state hashes).

### Defects fixed (each with a regression test `tests/scenario/qf-13-*.test.ts`)

| Defect | Measured before | Fix | After |
|---|---|---|---|
| Header flicked over the goal line (QF-11 CR) | an AI attacker's contested header 10-35 m out was aimed straight up the pitch with no target: 2.0 goal kicks a match, the largest single cause | SIM-12 `aiChoose` / `solveAerial`: with nobody in the forward cone the header goes back across the box (a teammate that way, else toward the spot `T_AERIAL.aiFlickSpotDepth` 11 m out); every AI header pass lands `aiFlickLineMargin` 5 m inside the goal line and `aiFlickTouchMargin` 2 m inside the touchlines; a flick to no one is shortened (up to `aiFlickTries` 3 launches, `aiFlickShrink` 0.92) until its predicted roll (`aiFlickPredictTicks` 240) slows below `aiFlickSlowSpeed` 3 m/s inside them. The clearance branch (F_CLEAR) is unchanged | goal kicks off an AI header pass 1.67 -> 0 a match, all goal kicks 4.10 -> 2.60 (the same 30 matches, seed 7); `qf-13-header-flick`, `qf-11-cr-header-flick-out` now `it()` |
| Reaction delay chained through passes | every change of ball owner re-armed TAI-11's delay: a Beginner defender kept his old run (often standing) for up to 29 s with gaps under 0.25 s (6 short Beginner matches: 129 near-continuous freezes over 2.5 s, merged up to 1746 ticks) | `defending.ts tickBrain`: no re-arm while a delay runs; after it, a change re-arms only once he has been awake `T_AI.reactRearmGapFrac` 0.25 x the delay; a turnover (our ball before) always re-arms | longest merged freeze at most one delay (81 ticks, 2 Beginner matches); `qf-13-react-chain` |
| Lofted pass receiver off the pitch | the receiver of an overhit lofted pass ran to its landing point and stood 3.9-4.75 m beyond the touchline for 85 ticks (Beginner, soak seed 21 #0) | SIM-15 `meetPoint` and the overshoot target: within the pitch + `T_TOUCH.meetPitchMargin` 0.5 m (where the ball's track leaves it) | `qf-13-meet-on-pitch` |
| Penalties | every CPU tackle in its own box was as free as in midfield: 0.92 penalties a match at Professional (12 matches, soak seed 5; real football ~0.3), 1.2 in MOS v ROO | TAI-11: the rash / noisy lunges x `T_LEVEL.boxRashMul`, slides x `boxSlideMul` (1 / 1 / 0.5 / 0 / 0 / 0) when the carrier is in our area; the careful, well-timed tackle stays | 0.38 a match (24 matches, seed 5; 1.43 -> 0.43 on the 30 seed-7 matches); `qf-13-box-care` (`tai-11-defending`'s slide scene moved outside the box) |
| Carrier orbiting his ball at the corner flag | the CPU carrier turned away 0.2 m short of a ball rolling into the corner and back after it: 5 s without a touch, the ball on the goal line, the carrier 1.3 m beyond it (seed 33 #17) | TAI-08 dribble turn: he runs to the ball until it is in reach judged `T_CPU.carrierLeashLeadTicks` 2 ahead (lead speed at least `carrierLeashLeadMinSpeed` 4 m/s), latched until the touch | `qf-13-off-pitch` |
| Chasers over the touchline | TAI-11's loose-ball chase at full stick ran 2.34 m over the touchline for 36 ticks; TAI-07 ball jobs aimed up to 6 m beyond the line | TAI-11: within his braking distance of a line the stick's component toward it is let go; TAI-07 chase / overshoot targets and TAI-14 `receiverAssist`'s reception point within the pitch + `meetPitchMargin` | 0 episodes over 0.6 m off in 30 matches (seed 55, every level); `qf-13-off-pitch` |
| Defending shape flipping under a long ball | TAI-04 `isDefending` for a loose ball read only the nearest player: under an opponent's clearance the back line's targets jumped 3 m every 0.5 s (14 jumps over 1.5 m in 2.5 s, World Class, seed 61 #16) | an untouched deliberate kick belongs to the kicking team (TAI-06's model) | `qf-13-shape-flip` |
| Superhuman shot clearances | AI defenders 0.4-1.4 m from the shooter started a volley / header on the next scan tick and cleared 17-27 m/s shots as aimed 24 m/s passes 2-6 ticks after the strike (about 1 a match) | SIM-12 `aiStarts`: no AI header / volley on a fresh shot before `T_AERIAL.aiShotReactTicks` 10 (1/6 s); inside that only a body in the path (TAC-02 block) stops it | `qf-13-shot-react` (54 early starts in its grid before, 0 after) |
| Balloon shots | SIM-11's solver climbed to 1.3 rad for a soft long shot that could not carry to its aim point lower: 25 of 363 Professional shots launched above 45 degrees (max 74), 72 above 30 (20 matches) | `T_SHOT.maxAimedElevation` 0.61 rad for every aimed kind (not the chip): such a shot lands short and bounces on | 0 above 35 degrees; `qf-13-shot-elevation` |
| Parries never went round the post | GKP-02's parry angle is capped at 1.35 rad off the outward axis: every parry went back into play (0 corners from 0.4 parries a match) | a parry met more than `T_GK.parryPostBand` 2 m off the goal centre is pushed round the post with chance `parryPostChance` 0.7 x nearness to the post x (0.5 + half the parry quality), turned back at most `parryPostBackMax` 0.7 rad past square and only so far that it crosses the line `parryPostClear` 0.45 m outside the post (none when that leaves under `parryPostBackMin` 0.1 rad) | corners 0.65 -> 0.72 a match with it (60 soak-config matches, everything else equal); 4 of 22 corners off parries (30 matches, seed 7); `qf-13-parry-post` |

### Ladder (QA-19; item 2 keeps Beginner the weakest)

The reaction-delay fix gave the low levels' defenders most of their reactions back: in an opponent's passing chain
every level below Legend had been frozen most of the time (Amateur's 42 and Semi-Pro's 24 ticks re-armed on every
change of owner just as Beginner's 80). On the tree with the fix (and box care at every level, 200 a seed, mirror legs):
Amateur v Beginner 60.0% (400), Semi-Pro v Amateur 59.3% (400), World Class v Professional 68.0% (400), Legend v World
Class 62.8% (400); QF-11 had measured 71.0 / 76.5 / 64.5 / 66.0% (200, seed 1).

| Bottom-pair lever (seed 1, 200 a pair; base about 63% / 62%) | Amateur v Beginner | Semi-Pro v Amateur | Kept |
|---|---|---|---|
| `T_AI.reactRearmGapFrac` 0.12 (a shorter awake gap) | 62.0% | 67.0% | - (the gap is what stops the chain; 15 ticks awake is the least that reads as a reaction) |
| `T_LEVEL.carrierEvalTicks` Beginner / Amateur 5 -> 3 / 4 | 68.0% | 72.0% | yes |
| `T_LEVEL.keeperReactTicks` Beginner / Amateur 30 / 21 -> 45 / 30 | 67.0% | 72.5% | yes |
| `markGapMul` 2.6 / 2.0, `lineRateMul` 0.35 / 0.5 | 59.0% | 78.0% | - (costs Amateur v Beginner) |
| `reactionTicks` 100 / 55 | 57.5% | 65.0% | - |
| `pressIntensity` 0.95 / 0.9 | 58.0% | 63.0% | - |
| Earlier, 400 each: Beginner `reactionTicks` 100 / `decisionNoise` 0.6 / keeper +40 | 61.8 / 60.5 / 63.3% | - | - |

Re-deciding often is worse (QF-11's finding), and a slow keeper costs goals: both separate the bottom levels without
touching physics or Professional. On the final tree (with the shot-reaction, balloon and parry fixes) Semi-Pro v
Amateur still came out at 66.5 / 61.5% (seeds 1 / 2, 64.0% over 400), so the middle step got one more lever:

| Semi-Pro v Amateur lever (seeds 1-2, 400; Professional v Semi-Pro seed 1, 200) | Semi-Pro v Amateur | Pro v Semi-Pro | Kept |
|---|---|---|---|
| none | 64.0% | 75.5% | - |
| `reactionTicks` Semi-Pro 24 -> 18 | 76.5% | 72.0% | yes |
| `decisionNoise` Semi-Pro 0.275 -> 0.24 | 71.0% | 71.0% | - |

### Club balance (QA-20, item 4; 88-rated MOS v 62-rated ROO, 76 SND v 75 GLA; Professional, mirror legs)

Every setting measured (top-bottom wins, equal SND points share; "old" = the tree before the shot-reaction, balloon and
parry fixes above, with the reaction-delay fix and box care):

| Setting | Top-bottom wins | Equal points | Notes |
|---|---|---|---|
| old: base | 75.6% (800) | 60.4% (400) | the charter's ~77% / 55.3% start |
| old: `T_SHOT` shot power spread (`shotPowerMulMin` 0.6) | 77.0% (400) | 54.8% (200) | |
| old: shot error base share 0.9 (finishing / long shots weigh more) | 74.5% (400) | 53.3% (200) | |
| old: pass `errorMax` 0.26 (passing weighs more) | 78.8% (400) | 67.5% (200) | breaks the equal pair |
| old: wider keeper ranges | 76.5% (400) | 59.8% (200) | |
| old: box care by composure (rash in the box below composure 80, weighted 0 / 0 / 0.5 / 1 / 1 / 1) | 79.0% (400) | 55.5% (200) | 0.75 penalties a match |
| old: no box care (pre-QF-13 penalties) | 78.5% (400) | 57.5% (200) | 0.92 penalties a match |
| old: fatigue `staminaDrainSprint` 0.008, `staminaFloorMul` 0.75 | 82.5% (400) | 54.5% (200) | |
| old: fatigue 0.0065 / 0.78 | 80.0% (400) | 60.5% (200) | |
| old: stamina attribute pivot 70 (rates x 0.8 / x 1.2 of the attribute scale) | 79.5 / 79.0% (400) | 59.8 / 57.3% (200) | |
| **new tree (kept, no balance lever)** | **84.0% (800)** | **56.1% (800)** | seeds 1-4: 83.5 / 86.5 / 84.5 / 81.5%; 53.5 / 56.5 / 60.0 / 54.3% (before game management; final tree below: 83.9% / 56.3%) |
| new tree + fatigue 0.008 / 0.75 | 88.0% (800) | 56.9% (800) | blow-outs 5.3% (150-match soak), end-of-match stamina 0.22 (0.61 now), 32% of outfield ticks below the low-stamina threshold: not kept |
| new tree + fatigue + a leading CPU side managing the game (3 goals up: loss cost x1.6, shot threshold x4) | - | - | blow-outs 6.0% (150): no effect, removed |

What moved the balance: AI defenders no longer clear shots before they could have reacted (`aiShotReactTicks`), so the
side that shoots three times as often scores more of them (top-bottom goals 2.14-0.53 -> 2.75-0.53 a match). On the
final tree (100 a seed, seeds 1-4, the same configs) top-bottom is 81.5% with it and 76.0% with `aiShotReactTicks` 0.
No attribute or level table was changed for the balance.

### Blow-outs and game management (section 7 band, 500-match Professional soak, seed 1)

Before QF-13 3.4% (QF-11 skeptic). With the fixes above 5.0% (25 of 500: FAIL, the band is under 5%), goals 3.44: the
shots no longer cleared at once count in mismatched pairs too. A carrier-level ease-off (3 goals up: loss cost x1.6,
shot threshold x4) changed nothing measurable (150 matches with stronger fatigue: 6.0% v 5.3%). Kept: TAI-14 game
management, a CPU side on its default focus that leads by `T_AI.gameManageLead` 3 goals plays it as DEFENDING (deeper
block, at most 2 runners, `data/tactics` FOCUS_MODIFIERS; `ai/cpu/levels effectiveFocus`, read by every focus reader;
a human side's focus and an explicitly set focus are untouched): 3.2% (16 of 500), goals 3.36, every other band
unchanged; `qf-13-game-manage`.

### Corners (item 5)

Professional, 30 matches (seed 7, 4-minute halves), the tree before QF-13 -> after: corners 0.47 -> 0.73 a match, goal
kicks 4.10 -> 2.60 (1.67 -> 0 off AI header passes; missed shots 2.2 a match both), penalties 1.43 -> 0.43, goals 3.53
-> 3.70. Where corners come from and why there are few:

- Keeper tips over the bar: 7 of 15 corners. Every tip goes behind (by design).
- Keeper parries: 0 before (always back into play; 0.4 parries a match, the CPU's shots are mostly soft enough to be
  caught: 3.6 held a match), 4 of 22 after the round-the-post push (`T_GK.parryPost*`, defect table above).
- Shots blocked by defenders: about 6.9 a match (2.8 headed, 2.5 off the body, 1.4 volleyed away), 2 corners in 30
  matches. A body block (TAC-02 `blockBall`) sends the ball straight back (normal restitution 0.3) or on along its line
  (half the tangential speed), so it rarely goes behind; headed / volleyed blocks are aimed clearances (upfield, toward
  the near touchline). A gaussian scatter of the block direction (0.35 rad) was tried: +0.1 corners a match, no corner
  from a blocked cross in 20 matches; not kept (it changes every block for little).
- Blocked crosses: 15 of 68 crosses were blocked within 4 m of the crosser (20 matches), none went behind (they come
  back off the blocker toward the crosser or stay with a nearby player).
- Defenders never clear behind under pressure (TAI clearances always go upfield).

So corners stay well below real football's ratio to shots (about 10 to 25; here 0.7 to 18): the missing source is a
defender conceding a corner (clearing or deflecting behind under pressure), which needs new defending behaviour, not a
constant. The section 7 bands stay inside with the parry change (60-match soak: goals 3.28, blow-outs 1.7%).

### Observation for the lead: long shots

CPU ground shots by distance (Professional, 20 matches): 3.1 a match from inside 12 m (32 of the 36 goals), 1.2 from
12-16.5 m, 1.3 from 16.5-22, 2.0 from 22-28, 2.2 from 28-34 and 4.2 from 34-40 m (QF-2 widened `carrierShotMaxDist` to
40 m to reach the shots band): about half the CPU's shots come from 28 m or more and score 2 of 134. TAI-08's quick-shot
cut (strike before an opponent steps onto the line) takes their power to a tap (about 20 m/s), which the solver used to
loft at up to 74 degrees (balloon, fixed above). Giving such long shots a power floor (0.7 x the distance factor) made
them real shots and broke the bands (goals 4.12, blow-outs 15%, 60 matches): not kept. Fewer, better long shots need a
chance-creation pass that keeps the shots band (14-26) without them.

### Tables changed (`T_LEVEL`; Professional untouched)

| Table | Was (QF-11) | Now |
|---|---|---|
| reactionTicks | 80 / 42 / 24 / 11 / 6 / 1 | 80 / 42 / 18 / 11 / 6 / 1 |
| keeperReactTicks | 30 / 21 / 10 / 0 / -3 / -8 | 45 / 30 / 10 / 0 / -3 / -8 |
| carrierEvalTicks | 5 / 5 / 5 / 5 / 6 / 12 | 3 / 4 / 5 / 5 / 6 / 12 |
| boxRashMul / boxSlideMul (new) | - | 1 / 1 / 0.5 / 0 / 0 / 0 |

### Final measurement (this tree)

`tools/ladder.ts --matches 200`, seeds 1 and 2 (400 a pair, mirror legs, same club both sides):

| Pair | Seed 1 | Seed 2 | Over 400 | Target 65% |
|---|---|---|---|---|
| Amateur v Beginner | 141 / 31 / 28 = 70.5% | 138 / 23 / 39 = 69.0% | 69.8% | meets |
| Semi-Pro v Amateur | 154 / 27 / 19 = 77.0% | 155 / 21 / 24 = 77.5% | 77.3% | meets |
| Professional v Semi-Pro | 144 / 33 / 23 = 72.0% | 139 / 35 / 26 = 69.5% | 70.8% | meets |
| World Class v Professional | 128 / 29 / 43 = 64.0% | 139 / 33 / 28 = 69.5% | 66.8% | meets (over 400) |
| Legend v World Class | 131 / 45 / 24 = 65.5% | 138 / 37 / 25 = 69.0% | 67.3% | meets |

`tools/balance.ts --matches 200`, seeds 1-4 (seed 1 all suites, seeds 2-4 `--suite top-bottom,equal`):

| Matchup | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Over 800 | Target |
|---|---|---|---|---|---|---|
| top-bottom MOS (88) v ROO (62), wins | 166 / 20 / 14 = 83.0% | 173 / 15 / 12 = 86.5% | 169 / 19 / 12 = 84.5% | 163 / 22 / 15 = 81.5% | 83.9% (goals 2.65-0.55) | >= 80%: meets |
| equal SND (76) v GLA (75), points | 53.5% | 57.3% | 60.0% | 54.3% | 56.3% | 40-60%: meets |
| mirror GLA v GLA, home points | 54.3% | - | - | - | - | 40-60%: meets |

`tools/soak.ts --matches 500 --difficulty 3 --enforce all`: PASS; 500 finished, 0 exceptions / invariant failures /
watchdogs, determinism PASS; goals 3.36, shots 18.66, dominant possession 56.3%, home possession 50.5%, pass completion
78.4%, fouls 12.19, offsides 0.18, blow-outs 3.6% (18). `tools/fuzz.ts --matches 60 --enforce all`: PASS (0 exceptions,
invariant failures or watchdogs; determinism PASS).
