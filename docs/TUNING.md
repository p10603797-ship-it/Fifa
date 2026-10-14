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

Measured (18 Professional matches, 4-minute halves, after the refit): fouls 9.3 a match (15/18 inside 6-16), yellows
1.4, reds 0.17 (incl. second yellows), penalties 0.39. RUL-09's synthetic band test now samples the measured challenge
mix (`tests/scenario/rul-09-fouls.test.ts`): 9.2 fouls, 2.2 yellows a match.
