# DotKick tuning log

Owner: INT-A (Wave 2 gameplay integration). Every gameplay constant change made against soak evidence, with the
reason. Values live in `src/contracts/tuning.ts` (since TUN-1 every sim / AI value, since TUN-2 also the input, modes and
formerly inline values; module blocks are named in the TUN-1 and TUN-2 tables below; older entries name the module's former `LOCAL_TUNING` block). Measurement tool: `npx tsx tools/soak.ts --matches 24 --difficulty 3
--enforce all --halfMinutes 4` (equal teams at Professional, as BRIEF §7 defines the bands).

## Block index (`src/contracts/tuning.ts`, final tree)

95 exported blocks. Non-gameplay modules (render, audio, ui, net, platform, app, data generation, modes/stats) keep
their values in a local block marked `// LOCAL_TUNING (non-gameplay: <reason>)` (TUN-2 below).

**Wave 0 shared tables** (written with the contracts; read by many modules):

| Block | Area | Main readers |
|---|---|---|
| `T_BALL` | ball physics (gravity, drag, bounce, roll, spin) | `sim/ball/*`, kicks, possession, restarts, CPU passing |
| `T_PLAYER` | player movement, sprint, turn, stamina | `sim/players/*`, AI steering and CPU, HUD stamina |
| `T_DRIBBLE` | dribble touches, control and lose radius | `sim/players/possession.ts`, first touch, tackles, skills |
| `T_TOUCH` | first touch and receiving | `sim/players/firstTouch*.ts`, control resolver, AI |
| `T_PASS` | pass speeds, lob angle, assistance, charged release | kicks, restarts, control resolver, CPU passing |
| `T_SHOT` | shot speeds, accuracy, finesse / chip / power | `sim/kicks/shot.ts`, aerial, free kicks, penalties |
| `T_TACKLE` | tackle reach and outcomes | `sim/defend/tackle.ts`, aerial, CPU defending |
| `T_SKILL` | skill-move duration, star gates, vulnerability windows | `sim/kicks/skills.ts`, CPU |
| `T_GK` | keeper reactions, reach, dive speeds, catching, parries | `sim/keeper/*`, CPU xG |
| `T_RULES` | restart set-up and timeouts, advantage, idle ball, dead pass, half end, goal and celebration timing, phase limits | `sim/rules/*`, invariants, AI set pieces |
| `T_FOUL` | foul chances, reckless speed, advantage hold | `sim/rules/fouls.ts` |
| `T_AI` | shape interval, chaser hysteresis, line spacing, press distance, hold and chase speeds, composure noise | `src/ai/*`, `src/data/tactics.ts`, `src/data/formations.ts` |
| `T_AERIAL` | headers and volleys | `sim/kicks/aerial.ts` |
| `T_CPU` | CPU value model and option scoring | `ai/cpu/defending.ts` |
| `T_LEVEL` | per-difficulty AI parameters (never physics) | `ai/cpu/*`, keeper saves and distribution |
| `T_INPUT` | resolver windows: buffer, double tap, tap, switch lock-out, idle stick, flick | `sim/control/*`, set-piece rules |
| `T_PAD` | stick dead zones, trigger threshold, right-stick hold and sequence, D-pad sequence window | `src/input/pad/*` |
| `T_TOUCHUI` | touch button sizes and gaps, system-edge margin, swipe and tap thresholds, stick radius, hint hold, minimum target | `src/input/touch/*`, broadcast camera, HUD |
| `T_CAMERA` | broadcast camera height, distance, FOV, follow and lead, ball margin, blends | `src/render/camera/*` |
| `T_NET` | lockstep delay, redundancy, hash interval, pauses, rejoin | `src/net/*`, `sim/core/hash.ts` |
| `T_PERF` | dynamic resolution scale and frame-time targets | `src/render/*`, settings |

**Module blocks** (one per module, the module imports it): the 52 TUN-1 blocks in the table below (sim ball, players,
kicks, defend, control, keeper, rules, then AI, `T_FLIGHT` ... `T_DEFENDING`); `T_QUERY` (`sim/core/query.ts`) and
`T_SETPIECE_SPOTS` (`ai/setpieces.ts` spot templates) from TUN-2; and the 18 input, modes and formation-remap blocks
moved by TUN-2 (`T_TOUCH_STICK` ... `T_FORMATION_REMAP`). The QF sections further down log value changes against
soak, ladder and balance evidence; each names the block it changed.

## TUN-1: module tuning moved into `src/contracts/tuning.ts` (BRIEF §4 rule 6)

TUN-7S moved every `LOCAL_TUNING` / `*_TUNING` block of `src/sim/**` and `src/ai/**` (the TUNING-CR blocks) into
`src/contracts/tuning.ts`, one block per module at the end of the file (sim ball, players, kicks, defend, control,
keeper, rules, then AI), each entry with its unit and comment unchanged. The modules import the blocks from tuning.ts;
the TUNING-CR markers are gone. Values did not change: the end-of-match `hashState` and a rolling digest of 28 headless
runs (every difficulty, cup rules, every practice kind, shoot-out, human-scripted and hostile-input matches, rule toggles,
the first soak and fuzz jobs; `npx tsx tools/hash-table.ts --compare <before.json>`) are identical before and after.

52 blocks, 2422 constants. A module whose old block name is imported outside the sim / AI (tests, `src/input/touch`,
`src/modes/practice.ts`) keeps it as an alias of the tuning.ts block (`export const LOCAL_TUNING = T_X;`); sim / AI
importers use the tuning.ts names directly. Also moved: `keeper/positioning.ts` `RECEIVE_STEP_S` / `RECEIVE_HORIZON_S`
/ `RECEIVE_REACH` -> `T_GK_POSITION.receiveStepS` / `receiveHorizonS` / `receiveReach`; `keeper/saveKinematics.ts`
`STAND_AXIS_LOW` -> `T_GK_SAVE.standAxisLow` (old export kept as an alias); `players/firstTouchHooks.ts`
`CHEST_REACH_MUL` -> `T_FIRST_TOUCH.chestReachMul` (old export kept as an alias).

| Old location | New name | Constants |
|---|---|---|
| `src/sim/ball/flight.ts` `LOCAL_TUNING` (SIM-01) | `T_FLIGHT` | 6 |
| `src/sim/ball/contact.ts` `LOCAL_TUNING` (SIM-02) | `T_BALL_CONTACT` | 12 |
| `src/sim/players/locomotion.ts` `LOCAL_TUNING` (SIM-04) | `T_LOCOMOTION` | 27 |
| `src/sim/players/bodies.ts` `LOCAL_TUNING` (SIM-05) | `T_BODY` | 37 |
| `src/sim/players/possession.ts` `LOCAL_TUNING` (SIM-06) | `T_POSSESSION` | 48 |
| `src/sim/players/firstTouch.ts` `LOCAL_TUNING` (SIM-07) | `T_FIRST_TOUCH` | 42 |
| `src/sim/kicks/kickCommon.ts` `KICK_TUNING` (QF-10) | `T_KICK` | 6 |
| `src/sim/kicks/pass.ts` `LOCAL_TUNING` (SIM-08) | `T_PASS_KICK` | 71 |
| `src/sim/kicks/lob.ts` `LOCAL_TUNING` (SIM-09) | `T_LOB` | 54 |
| `src/sim/kicks/through.ts` `LOCAL_TUNING` (SIM-10) | `T_THROUGH` | 53 |
| `src/sim/kicks/shot.ts` `LOCAL_TUNING` (SIM-11) | `T_SHOT_KICK` | 96 |
| `src/sim/kicks/aerial.ts` `LOCAL_TUNING` (SIM-12) | `T_AERIAL_PLAY` | 156 |
| `src/sim/kicks/skills.ts` `LOCAL_TUNING` (SIM-13) | `T_SKILL_MOVES` | 50 |
| `src/sim/defend/tackle.ts` `LOCAL_TUNING` (SIM-14) | `T_TACKLE_PLAY` | 135 |
| `src/sim/control/resolveShared.ts` `LOCAL_TUNING` (SIM-15) | `T_RESOLVE` | 43 |
| `src/sim/control/resolveMove.ts` `IDLE_CHASE` (QF-1) | `T_IDLE_CHASE` | 3 |
| `src/sim/control/switching.ts` `LOCAL_TUNING` (SIM-16) | `T_SWITCH` | 27 |
| `src/sim/keeper/positioning.ts` `LOCAL_TUNING` (GKP-01) | `T_GK_POSITION` | 24 |
| `src/sim/keeper/saveKinematics.ts` `LOCAL_TUNING` (GKP-02) | `T_GK_SAVE` | 80 |
| `src/sim/keeper/sweeper.ts` `LOCAL_TUNING` (GKP-03) | `T_GK_SWEEP` | 98 |
| `src/sim/keeper/distribution.ts` `LOCAL_TUNING` (GKP-04) | `T_GK_DISTRIBUTION` | 69 |
| `src/sim/keeper/handling.ts` `LOCAL_TUNING` (GKP-05) | `T_GK_HANDLING` | 81 |
| `src/sim/keeper/setpieces.ts` `LOCAL_TUNING` (GKP-06) | `T_GK_SETPIECE` | 35 |
| `src/sim/rules/machine.ts` `LOCAL_TUNING` (RUL-01) | `T_MATCH_FLOW` | 33 |
| `src/sim/rules/restartCommon.ts` `COMMON_TUNING` (RUL-11) | `T_RESTART_COMMON` | 9 |
| `src/sim/rules/restart.ts` `LOCAL_TUNING` (RUL-11) | `T_RESTART` | 32 |
| `src/sim/rules/throwin.ts` `LOCAL_TUNING` (RUL-02) | `T_THROW_IN` | 54 |
| `src/sim/rules/goalkick.ts` `LOCAL_TUNING` (RUL-03) | `T_GOAL_KICK` | 30 |
| `src/sim/rules/corner.ts` `LOCAL_TUNING` (RUL-04) | `T_CORNER` | 30 |
| `src/sim/rules/freekick.ts` `LOCAL_TUNING` (RUL-05) | `T_FREE_KICK` | 88 |
| `src/sim/rules/penalty.ts` `LOCAL_TUNING` (RUL-06) | `T_PENALTY` | 18 |
| `src/sim/rules/shootout.ts` `LOCAL_TUNING` (RUL-07) | `T_SHOOTOUT` | 37 |
| `src/sim/rules/offside.ts` `LOCAL_TUNING` (RUL-08) | `T_OFFSIDE` | 3 |
| `src/sim/rules/fouls.ts` `LOCAL_TUNING` (RUL-09) | `T_FOUL_CALL` | 21 |
| `src/sim/rules/subs.ts` `LOCAL_TUNING` (RUL-10) | `T_SUBS` | 4 |
| `src/sim/rules/watchdog.ts` `LOCAL_TUNING` (RUL-11) | `T_WATCHDOG` | 8 |
| `src/sim/rules/practice.ts` `LOCAL_TUNING` (MOD-04) | `T_PRACTICE` | 3 |
| `src/ai/steer.ts` `LOCAL_TUNING` (TAI-07) | `T_STEER` | 25 |
| `src/ai/jobs.ts` `LOCAL_TUNING` (TAI-01) | `T_JOBS` | 4 |
| `src/ai/shape.ts` `LOCAL_TUNING` (TAI-01) | `T_SHAPE` | 44 |
| `src/ai/defshape.ts` `LOCAL_TUNING` (TAI-03) | `T_DEF_SHAPE` | 55 |
| `src/ai/support.ts` `LOCAL_TUNING` (TAI-02) | `T_SUPPORT` | 42 |
| `src/ai/runs.ts` `LOCAL_TUNING` (TAI-04) | `T_RUNS` | 47 |
| `src/ai/press.ts` `LOCAL_TUNING` (TAI-05) | `T_PRESS` | 48 |
| `src/ai/transition.ts` `LOCAL_TUNING` (TAI-06) | `T_TRANSITION` | 38 |
| `src/ai/tactics.ts` `LOCAL_TUNING` (TAI-14) | `T_TACTICS` | 6 |
| `src/ai/setpieces.ts` `LOCAL_TUNING` (TAI-13) | `T_SETPIECE_AI` | 112 |
| `src/ai/cpu/levels.ts` `LOCAL_TUNING` (TAI-12) | `T_STYLE` | 1 |
| `src/ai/cpu/carrier.ts` `LOCAL_TUNING` (TAI-08) | `T_CARRIER` | 117 |
| `src/ai/cpu/passing.ts` `LOCAL_TUNING` (TAI-09) | `T_PASSING` | 84 |
| `src/ai/cpu/shooting.ts` `LOCAL_TUNING` (TAI-10) | `T_SHOOTING` | 89 |
| `src/ai/cpu/defending.ts` `LOCAL_TUNING` (TAI-11) | `T_DEFENDING` | 87 |

Stays local on purpose (not gameplay tuning; changing them does not change behaviour, or they are structure):
enum-like indices and flags (`STEP_*`, `MODE_*`, `F_*`, `R_*`, `PLAN_*`, `S_*`, `SH_*`, `OUT_*`, `G_*`, `RES_*`...),
scratch / ring / list sizes (`MAX_OPTIONS`, `MAX_LIST`, `RING_N`, `MAX_SAMPLES`, `PCAP`, `MAX_WALL`, `MAX_IV`, `RK_N`,
`SHEET_COLS`), solver iteration counts and tolerances (`ROLL_NEWTON_ITERS`, `ROLL_TIME_ITERS`, `SOLVE_*`, `EPS`,
`GROUND_EPS`, `CORNER_EPS`, `LEAD_TOL`), sentinels (`BIG`, `NEVER`, `REJECT`, `NONE_U`, `NA`, `OUR_PASS`), maths
constants (`dmath.ts`, `TAN_PI_8`, `SQRT3`, `INV_*`), input quantisation (`STICK_MAX`, `CT`, `POS_MAX`), cost-only
pre-check margins (`bodies.ts` `NEAR_MARGIN`, `contact.ts` `BOARD_NEAR` / `NEAR_Z` / `NEAR_Y`), degenerate-geometry guards
(`AIM_MIN_DIST` 0.25 m in pass / lob / through: below it a target gives no aim direction; `contact.ts`
`MIN_HORIZONTAL_NORMAL`), display constants (`machine.ts` `HALF_DISPLAY_SEC` / `ET_DISPLAY_SEC`), replay format
constants, and constants derived from tuning values (`CR2`, `REACH2`, `CHARGE_WAIT`, `JUMP_TICKS`, `HOLD_INV`...).

## TUN-2: last tuning-in-data pass (BRIEF §4 rule 6)

TUN-2 moved the gameplay numbers TUN-1 left behind into `src/contracts/tuning.ts`, with their units and comments,
without changing any value or any behaviour:

1. **Set-piece spot templates and other inline sim / AI literals.** 356 literal sites (353 single literals and 3 array
   literals) in 26 `src/sim` / `src/ai` files (distances, speeds, times, probabilities, weights) now read tuning.ts. The spot templates and the run-time spot
   offsets of `src/ai/setpieces.ts` form the new block `T_SETPIECE_SPOTS`; `src/sim/core/query.ts` got `T_QUERY`;
   every other literal became a key of its module's TUN-1 block, marked `[TUN-2]` (T_SETPIECE_AI +45, T_GK_SAVE +18,
   T_AERIAL_PLAY +14, T_PRACTICE +12 (the free-kick practice spots), T_FREE_KICK +10, T_CARRIER +5, T_PASSING +5,
   T_GK_SETPIECE +4, T_GK_SWEEP +4, T_MATCH_FLOW +4, T_RESTART +4, T_DEFENDING +2, T_DEF_SHAPE +2, T_GK_POSITION +2,
   T_PENALTY +2, and one each in T_FIRST_TOUCH, T_KICK, T_PRESS, T_RESOLVE, T_SHOOTING, T_SHOOTOUT, T_SKILL_MOVES,
   T_STEER): 322 new tuning.ts leaves (array elements counted).
2. **Input feel and modes.** Every TUNING-CR block of `src/input/**`, the gameplay blocks of `src/modes/**` and the
   formation-remap cost model of `src/data/formations.ts` (used by `ai/tactics` SET_FORMATION, so gameplay, although
   the charter listed `src/data` as non-gameplay) moved whole, one block per module (table below). The module keeps
   its old name as an alias of the tuning.ts object (`export const LOCAL_TUNING = T_TOUCH_STICK;`), so importers and
   tests are unchanged. `T_TOUCH_OVERLAY`, `T_TOUCH_EDITOR`, `T_PAD_RUMBLE` and `T_MENU_INPUT` are menu / device feel
   rather than gameplay; they moved with the input layer because the charter names every `src/input` block.
3. **Non-gameplay markers.** The remaining TUNING-CR markers (render, audio, ui, net, platform, data generation, app,
   modes/stats) keep their values local and now read `// LOCAL_TUNING (non-gameplay: <reason>)` (table below).
   `grep -r TUNING-CR src` is empty (tests/unit/tun-2-tuning-in-data.test.ts keeps it so).

**Proof of identity.** (a) `npx tsx tools/hash-table.ts` (28 runs: every difficulty, cup rules, every practice kind,
shoot-out, human-scripted and hostile-input matches, rule toggles, the first soak and fuzz jobs; end-of-run hashState
plus a rolling digest every 500 ticks) recorded before the first edit and compared after each step (markers, input /
modes blocks, set pieces, the other sim / AI literals) and at the end: IDENTICAL 28 / 28 every time. (b) A deep value
comparison against a pristine `git archive HEAD` copy: every changed `src` file is regenerated from the pristine file
plus a list of edits and must equal the working tree byte for byte; each moved literal is a single token replaced by
an expression whose value is `Object.is`-equal to the literal (aliases bound to the new tuning.ts objects); every
pristine tuning.ts leaf (3262) is `Object.is`-unchanged; every moved block's exported object / value of the pristine
module is `Object.is`-equal leaf by leaf to the new one and to the tuning.ts block, and the block bodies are
text-identical to their pristine source; the 51 marker-only files are token-identical (comments only). Result: PROOF
OK (444 new tuning.ts leaves: 322 from sim / AI literals, `T_CUP_QUICK.penRefRating`, 121 from moved blocks). (c) tsc, eslint and the area tests
(below) are green.

### Moved blocks (input, modes, formation remap)

| Old location | New name | Constants |
|---|---|---|
| `src/input/touch/stick.ts` `LOCAL_TUNING` (TCH-02) | `T_TOUCH_STICK` | 8 |
| `src/input/touch/button.ts` `LOCAL_TUNING` (TCH-03) | `T_TOUCH_BUTTON` | 2 |
| `src/input/touch/attack.ts` `LOCAL_TUNING` (TCH-03) | `T_TOUCH_ATTACK` | 3 |
| `src/input/touch/gestures.ts` `LOCAL_TUNING` (TCH-05) | `T_TOUCH_GESTURES` | 14 |
| `src/input/touch/mapper.ts` `LOCAL_TUNING` (TCH-06) | `T_TOUCH_MAPPER` | 15 |
| `src/input/touch/setpiece.ts` `LOCAL_TUNING` (TCH-07) | `T_TOUCH_SETPIECE` | 5 |
| `src/input/touch/overlay.ts` `LOCAL_TUNING` / `OVERLAY_TUNING` (TCH-08) | `T_TOUCH_OVERLAY` | 16 |
| `src/input/touch/editor.ts` `LOCAL_TUNING` / `EDITOR_TUNING` (TCH-09) | `T_TOUCH_EDITOR` | 11 |
| `src/input/pad/mapper.ts` `LOCAL_TUNING` / `MAPPER_TUNING` (PAD-02) | `T_PAD_MAPPER` | 1 |
| `src/input/pad/rightStick.ts` `LOCAL_TUNING` / `RIGHT_STICK_TUNING` (PAD-03) | `T_PAD_RIGHT_STICK` | 8 |
| `src/input/pad/manager.ts` `LOCAL_TUNING` (`PAD_TRIGGER_RELEASE`) (PAD-01) | `T_PAD_TRIGGER` | 1 |
| `src/input/pad/sequences.ts` `LOCAL_TUNING` / `PAD_SEQUENCE_TUNING` (PAD-04) | `T_PAD_SEQUENCES` | 2 |
| `src/input/pad/rumble.ts` `LOCAL_TUNING` / `RUMBLE_TUNING` (PAD-06) | `T_PAD_RUMBLE` | 10 |
| `src/input/keyboard.ts` `LOCAL_TUNING` / `KEYBOARD_TUNING` (PAD-08) | `T_KEYBOARD` | 2 |
| `src/input/menuInput.ts` `LOCAL_TUNING` / `MENU_TUNING` | `T_MENU_INPUT` | 6 |
| `src/modes/practice.ts` `LOCAL_TUNING` (MOD-04) | `T_PRACTICE_MODE` | 4 |
| `src/modes/cup.ts` `QUICK` (MOD-02), plus the inline rating reference 75 of `penaltyConversion` -> `penRefRating` | `T_CUP_QUICK` | 12 |
| `src/data/formations.ts` `LOCAL_TUNING` (DAT-02 remap cost model) | `T_FORMATION_REMAP` | 2 |

### Formerly inline sim / AI literals (old line numbers are those of HEAD 36361eb)

`src/ai/setpieces.ts` (233 literals):

| Line | Was | Now |
|---|---|---|
| 140 | `10.5`, `0.5` | `T_SETPIECE_SPOTS.cornerPen.{a, z}` |
| 141 | `5.0`, `-4.5` | `T_SETPIECE_SPOTS.cornerFarPost.{a, z}` |
| 142 | `4.5`, `2.8` | `T_SETPIECE_SPOTS.cornerNearPost.{a, z}` |
| 143 | `54`, `-8`, `0.2` | `T_SETPIECE_SPOTS.cornerStay1.{a, z, wd}` |
| 144 | `18.5`, `-2.5`, `0.2` | `T_SETPIECE_SPOTS.cornerEdge.{a, z, wd}` |
| 145 | `4.5`, `27`, `0.2` | `T_SETPIECE_SPOTS.cornerShort.{a, z, wd}` |
| 146 | `56`, `9`, `0.2` | `T_SETPIECE_SPOTS.cornerStay2.{a, z, wd}` |
| 150 | `5.5`, `0.8`, `6.5`, `-6.5`, `17.5`, `0.2` | `T_SETPIECE_SPOTS.cornerX1[0].{a, z}`, `T_SETPIECE_SPOTS.cornerX1[1].{a, z}`, `T_SETPIECE_SPOTS.cornerX1[2].{a, z, wd}` |
| 151 | `1.6`, `-0.6`, `6.0`, `4.5` | `T_SETPIECE_SPOTS.cornerX1[3].{a, z}`, `T_SETPIECE_SPOTS.cornerX1[4].{a, z}` |
| 154 | `8.5`, `-7.5`, `9.5`, `-9`, `20.5`, `0.2` | `T_SETPIECE_SPOTS.cornerX2[0].{a, z}`, `T_SETPIECE_SPOTS.cornerX2[1].{a, z}`, `T_SETPIECE_SPOTS.cornerX2[2].{a, z, wd}` |
| 155 | `2.0`, `1.6`, `8.0`, `1.5` | `T_SETPIECE_SPOTS.cornerX2[3].{a, z}`, `T_SETPIECE_SPOTS.cornerX2[4].{a, z}` |
| 158 | `0.7`, `3.0`, `0.4` | `T_SETPIECE_SPOTS.cornerDefPost.{a, z, wd}` |
| 159 | `5.8`, `1.0`, `0.1` | `T_SETPIECE_SPOTS.cornerDefZonal1.{a, z, wd}` |
| 160 | `6.0`, `-3.5`, `0.1` | `T_SETPIECE_SPOTS.cornerDefZonal2.{a, z, wd}` |
| 161 | `15.5`, `-1.0`, `0.3` | `T_SETPIECE_SPOTS.cornerDefEdge.{a, z, wd}` |
| 162 | `50`, `0`, `0.2` | `T_SETPIECE_SPOTS.cornerDefCounter.{a, z, wd}` |
| 163 | `10`, `4`, `0.2` | `T_SETPIECE_SPOTS.cornerDefZonal3.{a, z, wd}` |
| 164 | `9.5`, `24`, `0.4` | `T_SETPIECE_SPOTS.cornerDefBlock.{a, z, wd}` |
| 165 | `12`, `-6`, `0.2` | `T_SETPIECE_SPOTS.cornerDefZonal4.{a, z, wd}` |
| 167 | `14`, `17`, `0.6` | `T_SETPIECE_SPOTS.goalKickSplit1.{a, z, wd}` |
| 168 | `14`, `-17`, `0.6` | `T_SETPIECE_SPOTS.goalKickSplit2.{a, z, wd}` |
| 169 | `27`, `0`, `0.6` | `T_SETPIECE_SPOTS.goalKickPivot.{a, z, wd}` |
| 170 | `32`, `29`, `0.6` | `T_SETPIECE_SPOTS.goalKickWide1.{a, z, wd}` |
| 171 | `32`, `-29`, `0.6` | `T_SETPIECE_SPOTS.goalKickWide2.{a, z, wd}` |
| 172 | `55`, `6`, `0.3` | `T_SETPIECE_SPOTS.goalKickTarget.{a, z, wd}` |
| 173 | `51`, `-9`, `0.4` | `T_SETPIECE_SPOTS.goalKickTarget2.{a, z, wd}` |
| 174 | `18.5`, `10`, `0.5` | `T_SETPIECE_SPOTS.goalKickPress1.{a, z, wd}` |
| 175 | `18.5`, `-10`, `0.5` | `T_SETPIECE_SPOTS.goalKickPress2.{a, z, wd}` |
| 178 | `17.3`, `8.2`, `0.3`, `-10`, `11.8` | `T_SETPIECE_SPOTS.penAttack[0].{a, z, wd}`, `T_SETPIECE_SPOTS.penAttack[1].{a, z, wd}`, `T_SETPIECE_SPOTS.penAttack[2].{a, z, wd}` |
| 179 | `17.3`, `-13.6`, `0.3`, `56`, `-8`, `0.2`, `58`, `8` | `T_SETPIECE_SPOTS.penAttack[3].{a, z, wd}`, `T_SETPIECE_SPOTS.penAttack[4].{a, z, wd}`, `T_SETPIECE_SPOTS.penAttack[5].{a, z, wd}` |
| 182 | `17.3`, `-8.2`, `0.3`, `10`, `-11.8` | `T_SETPIECE_SPOTS.penDefend[0].{a, z, wd}`, `T_SETPIECE_SPOTS.penDefend[1].{a, z, wd}`, `T_SETPIECE_SPOTS.penDefend[2].{a, z, wd}` |
| 183 | `17.3`, `13.6`, `0.3`, `50`, `0`, `0.2` | `T_SETPIECE_SPOTS.penDefend[3].{a, z, wd}`, `T_SETPIECE_SPOTS.penDefend[4].{a, z, wd}` |
| 186 | `[7, -3, -9]` | `T_SETPIECE_SPOTS.fkLine.shootZ` |
| 187 | `[3, 0, -4, -8]` | `T_SETPIECE_SPOTS.fkLine.wideZ` |
| 188 | `0.3` | `T_SETPIECE_SPOTS.fkDummy.wd` |
| 189 | `0.5` | `T_SETPIECE_SPOTS.fkRebound.wd` |
| 190 | `0.3` | `T_SETPIECE_SPOTS.fkLine.wd` |
| 191 | `0.3` | `T_SETPIECE_SPOTS.fkEdge.wd` |
| 192 | `0.5` | `T_SETPIECE_SPOTS.fkShort.wd` |
| 193 | `56`, `-8`, `0.2` | `T_SETPIECE_SPOTS.fkStay1.{a, z, wd}` |
| 194 | `58`, `8`, `0.2` | `T_SETPIECE_SPOTS.fkStay2.{a, z, wd}` |
| 195 | `0.3` | `T_SETPIECE_SPOTS.fkZonal.wd` |
| 196 | `0.7`, `3`, `0.4` | `T_SETPIECE_SPOTS.fkPost.{a, z, wd}` |
| 197 | `50`, `0`, `0.2` | `T_SETPIECE_SPOTS.fkCounter.{a, z, wd}` |
| 198 | `1.0` | `T_SETPIECE_SPOTS.fkDeepShort.wd` |
| 199 | `1.0` | `T_SETPIECE_SPOTS.throwOption.wd` |
| 522 | `0.5` | `T_SETPIECE_AI.suitHeightW` |
| 525 | `10` | `T_SETPIECE_AI.suitAerialRoleBonus` |
| 526 | `8` | `T_SETPIECE_AI.suitShortWideBonus` |
| 527 | `0.4`, `0.2` | `T_SETPIECE_AI.{suitShooterShotW, suitShooterCurveW}` |
| 528 | `25`, `15`, `0.3`, `0.4` | `T_SETPIECE_AI.{suitStayDef, suitStayCdm, suitStaySpeedW, suitStayAerialW}` |
| 529 | `20`, `10`, `0.4` | `T_SETPIECE_AI.{suitMarkerDef, suitMarkerCdm, suitMarkerHeadingW}` |
| 530 | `0.3` | `T_SETPIECE_AI.{suitMarkerTackleW, suitMarkerHeightW}` |
| 531 | `40`, `20`, `12` | `T_SETPIECE_AI.{suitCbCb, suitCbDef, suitCbCdm}` |
| 532 | `30`, `22`, `10` | `T_SETPIECE_AI.{suitPivotCdm, suitPivotCm, suitPivotCam}` |
| 533 | `0.1` | `T_SETPIECE_AI.suitPivotPassW` |
| 534 | `40`, `20` | `T_SETPIECE_AI.{suitFullbackFb, suitFullbackWide}` |
| 535 | `35` | `T_SETPIECE_AI.suitForwardStriker` |
| 536 | `18`, `0.2` | `T_SETPIECE_AI.{suitForwardWide, suitForwardHeadingW}` |
| 687 | `0.1` | `T_SETPIECE_SPOTS.markerWd` |
| 710 | `11` | `T_SETPIECE_SPOTS.throwFar.ahead` |
| 711 | `4` | `T_SETPIECE_SPOTS.throwFar.inField` |
| 713 | `1.5` | `T_SETPIECE_SPOTS.throwShort.ahead` |
| 714 | `9` | `T_SETPIECE_SPOTS.throwShort.inField` |
| 716 | `8` | `T_SETPIECE_SPOTS.throwBack.behind` |
| 717 | `6` | `T_SETPIECE_SPOTS.throwBack.inField` |
| 719 | `5` | `T_SETPIECE_SPOTS.throwInside.ahead` |
| 720 | `13` | `T_SETPIECE_SPOTS.throwInside.inField` |
| 768 | `1` | `T_SETPIECE_SPOTS.fkDeepShort.ahead` |
| 769 | `-11`, `11` | `-T_SETPIECE_SPOTS.fkDeepShort.across`, `T_SETPIECE_SPOTS.fkDeepShort.across` |
| 773 | `10`, `-10` | `T_SETPIECE_SPOTS.fkDeepShort.back`, `-T_SETPIECE_SPOTS.fkDeepShort.back` |
| 774 | `0.8` | `T_SETPIECE_SPOTS.fkDeepShort.backLateral` |
| 787 | `0.9`, `1.4` | `T_SETPIECE_SPOTS.fkDummy.{back, side}` |
| 788 | `0.9`, `1.4` | `T_SETPIECE_SPOTS.fkDummy.{back, side}` |
| 793 | `3` | `T_SETPIECE_SPOTS.fkRebound.assumedWall` |
| 812 | `6`, `18` | `T_SETPIECE_SPOTS.fkEdge.{beyondLine, minDist}` |
| 813 | `1` | `T_SETPIECE_SPOTS.fkEdge.across` |
| 815 | `3` | `T_SETPIECE_SPOTS.fkShort.back` |
| 816 | `7` | `T_SETPIECE_SPOTS.fkShort.across` |
| 822 | `28` | `T_SETPIECE_SPOTS.fkPost.maxBallDist` |
| 829 | `0.1` | `T_SETPIECE_SPOTS.markerWd` |
| 831 | `0.5` | `T_SETPIECE_SPOTS.fkZonal.behindLine` |
| 832 | `1` | `T_SETPIECE_SPOTS.fkZonal.wideAcross` |
| 835 | `0.5` | `T_SETPIECE_SPOTS.fkZonal.behindLine` |
| 836 | `6` | `T_SETPIECE_SPOTS.fkZonal.shootAcross` |
| 891 | `-1.1`, `1.1` | `-T_SETPIECE_SPOTS.kickOffCircle.x`, `T_SETPIECE_SPOTS.kickOffCircle.x` |
| 892 | `1.0`, `1.3` | `T_SETPIECE_SPOTS.kickOffCircle.{z0, dz}` |
| 1301 | `0.5` | `T_SETPIECE_AI.reticleStopFrac` |
| 1462 | `0.5`, `15` | `T_SETPIECE_AI.{targetHeightW, targetOpenCap}` |
| 1485 | `15`, `0.5`, `8`, `0.1` | `T_SETPIECE_AI.{shortOpenCap, shortLaneW, shortLaneCap, shortDistW}` |
| 1544 | `4` | `T_SETPIECE_AI.crossPrefEdgeExtra` |
| 1547 | `0.5` | `T_SETPIECE_AI.crossHeightW` |
| 1639 | `2` | `T_SETPIECE_AI.longAheadPitchMargin` |
| 1640 | `0.5` | `T_SETPIECE_AI.longAheadLateral` |
| 1713 | `-1.5`, `1.5` | `-T_SETPIECE_AI.fkCentralBand`, `T_SETPIECE_AI.fkCentralBand` |
| 1725 | `60`, `40` | `T_SETPIECE_AI.{fkCurlAttrRef, fkCurlAttrSpan}` |
| 1726 | `18` | `T_SETPIECE_AI.fkPowerRefDist` |
| 1737 | `20`, `26` | `T_SETPIECE_AI.{fkShootBandNear, fkShootBandMid}` |
| 1741 | `65`, `100` | `T_SETPIECE_AI.{fkQualityRef, fkQualityScale}` |

`src/sim/control/resolveMove.ts` (1 literal):

| Line | Was | Now |
|---|---|---|
| 134 | `1.05` | `T_RESOLVE.containPaceMul` |

`src/sim/core/query.ts` (4 literals):

| Line | Was | Now |
|---|---|---|
| 69 | `1` | `T_QUERY.pressureFullDist` |
| 70 | `6` | `T_QUERY.pressureZeroDist` |
| 71 | `1`, `5` | `T_QUERY.pressureFullDist`, `(T_QUERY.pressureZeroDist - T_QUERY.pressureFullDist)` |

`src/sim/init.ts` (4 literals):

| Line | Was | Now |
|---|---|---|
| 75 | `0.95` | `T_MATCH_FLOW.initDepthScale` |
| 76 | `-1`, `1` | `-T_MATCH_FLOW.initOwnHalfMargin`, `T_MATCH_FLOW.initOwnHalfMargin` |
| 78 | `0.9` | `T_MATCH_FLOW.initWidthScale` |

`src/sim/keeper/positioning.ts` (2 literals):

| Line | Was | Now |
|---|---|---|
| 189 | `3` | `T_GK_POSITION.receiveMaxBallYMul` |
| 193 | `0.3` | `T_GK_POSITION.receiveMovingSpeed` |

`src/sim/keeper/saveKinematics.ts` (4 literals):

| Line | Was | Now |
|---|---|---|
| 40 | `1.85` | `T_GK_SAVE.refHeightM` |
| 60 | `1.85` | `T_GK_SAVE.refHeightM` |
| 71 | `0.5` | `T_GK_SAVE.armExtStart`, `(1 - T_GK_SAVE.armExtStart)` |

`src/sim/keeper/saves.ts` (26 literals):

| Line | Was | Now |
|---|---|---|
| 385 | `0.15`, `0.9` | `T_GK_SAVE.{screenSegMin, screenSegMax}` |
| 530 | `0.15` | `T_GK_SAVE.catchDepthMargin` |
| 679 | `0.5`, `-0.5` | `T_GK_SAVE.rollingMaxVy`, `-T_GK_SAVE.rollingMaxVy` |
| 698 | `0.5`, `0.15` | `T_GK_SAVE.{diveFeetBelowHip, diveFeetMinY}` |
| 709 | `0.3` | `T_GK_SAVE.bodyVolFootY` |
| 710 | `0.3` | `T_GK_SAVE.bodyVolHeadInset` |
| 758 | `0.3` | `T_GK_SAVE.bodyVolFootY` |
| 759 | `0.3` | `T_GK_SAVE.bodyVolHeadInset` |
| 841 | `0.5` | `T_KICK.liftVy` |
| 853 | `0.05`, `1.35` | `T_GK_SAVE.{parryAngleMin, parryAngleMax}` |
| 865 | `0.5` | `T_GK_SAVE.{parryPostQualityBase, parryPostQualityGain}` |
| 869 | `0.75` | `T_GK_SAVE.parryPostBackFrac` |
| 890 | `0.3` | `T_GK_SAVE.tipBeyondLine` |
| 892 | `1` | `T_GK_SAVE.tipMinLift` |
| 893 | `0.5` | `T_GK_SAVE.tipLateralKeep` |

`src/sim/keeper/setpieces.ts` (4 literals):

| Line | Was | Now |
|---|---|---|
| 385 | `0.05`, `0.95` | `T_GK_SETPIECE.{aiNaturalMin, aiNaturalMax}` |
| 422 | `1.5`, `0.5` | `T_GK_SETPIECE.{aimHighFrom, aimMidFrom}` |

`src/sim/keeper/sweeper.ts` (7 literals):

| Line | Was | Now |
|---|---|---|
| 710 | `0.5` | `T_KICK.liftVy` |
| 737 | `0.5`, `0.7` | `T_GK_SWEEP.{blockAwayPushW, blockAwaySideW}` |
| 738 | `0.3` | `T_GK_SWEEP.blockAwayMinFwd` |
| 790 | `0.9` | `T_GK_SWEEP.feetPickUpReachFrac` |

`src/sim/kicks/aerial.ts` (20 literals):

| Line | Was | Now |
|---|---|---|
| 926 | `0.5` | `T_AERIAL_PLAY.volleyReachQ` |
| 1096 | `0.36` | `T_AERIAL_PLAY.aiClearSideRatio * T_AERIAL_PLAY.aiClearSideRatio` |
| 1098 | `0.6` | `T_AERIAL_PLAY.aiClearSideRatio` |
| 1228 | `0.75`, `1.1` | `T_AERIAL_PLAY.{receiverMinDistFrac, receiverMaxDistFrac}` |
| 1267 | `0.5` | `T_AERIAL_PLAY.awkFastBallW` |
| 1271 | `0.5`, `0.4` | `T_AERIAL_PLAY.{awkLowBallSpan, awkLowBallW}` |
| 1273 | `0.5` | `T_AERIAL_PLAY.awkHighVolleyW` |
| 1369 | `0.5` | `T_KICK.liftVy` |
| 1559 | `0.3` | `T_AERIAL_PLAY.clearMinForward` |
| 1560 | `0.3` | `T_AERIAL_PLAY.clearMinForward` |
| 1565 | `0.5` | `T_AERIAL_PLAY.{clearPowerMix, clearSkillMix}` |
| 1574 | `1.6` | `T_AERIAL_PLAY.clearAimAheadS` |
| 1575 | `1.6` | `T_AERIAL_PLAY.clearAimAheadS` |
| 1652 | `5`, `20` | `T_AERIAL_PLAY.{headerPassAngleNearD, headerPassAngleSpanD}` |
| 1679 | `5`, `20` | `T_AERIAL_PLAY.{headerPassAngleNearD, headerPassAngleSpanD}` |

`src/sim/kicks/skills.ts` (1 literal):

| Line | Was | Now |
|---|---|---|
| 752 | `0.5` | `T_SKILL_MOVES.knockRelBase` |

`src/sim/rules/freekick.ts` (15 literals):

| Line | Was | Now |
|---|---|---|
| 370 | `1.1` | `T_FREE_KICK.wallBodyMul` |
| 657 | `1.1` | `T_FREE_KICK.wallBodyMul` |
| 692 | `1.1` | `T_FREE_KICK.wallBodyMul` |
| 1037 | `0.5`, `1` | `T_FREE_KICK.{boxRayInset, boxRayGoalLineInset}` |
| 1039 | `0.5` | `T_FREE_KICK.boxRayInset` |
| 1524 | `0.5` | `T_KICK.liftVy` |
| 1676 | `60`, `40`, `0.3`, `0.85` | `T_FREE_KICK.{defaultCurlAttrRef, defaultCurlAttrSpan, defaultCurlMin, defaultCurlMax}` |
| 1682 | `18` | `T_FREE_KICK.defaultPowerRefDist` |
| 1991 | `0.5` | `T_FREE_KICK.previewDipBackspinMul` |
| 1997 | `0.5` | `T_FREE_KICK.previewLobCurlMul` |
| 2067 | `0.5` | `T_KICK.liftVy` |

`src/sim/rules/machine.ts` (1 literal):

| Line | Was | Now |
|---|---|---|
| 905 | `5` | `T_MATCH_FLOW.forcedKickAhead` |

`src/sim/rules/penalty.ts` (2 literals):

| Line | Was | Now |
|---|---|---|
| 202 | `1.5`, `0.5` | `T_PENALTY.{aimHighFrom, aimMidFrom}` |

`src/sim/rules/practice.ts` (1 literal):

| Line | Was | Now |
|---|---|---|
| 42 | `[22, 0, 21, -9, 21, 9, 30, 4, 14, -26, 14, 26]` | `T_PRACTICE.freeKickSpots` |

`src/sim/rules/restart.ts` (4 literals):

| Line | Was | Now |
|---|---|---|
| 1092 | `4`, `0.4` | `T_RESTART.{forcedThrowBase, forcedThrowPerM}` |
| 1095 | `1`, `9` | `T_RESTART.{forcedThrowVyMin, forcedThrowVyMax}` |

`src/sim/rules/shootout.ts` (1 literal):

| Line | Was | Now |
|---|---|---|
| 580 | `1.5` | `T_SHOOTOUT.forcedAimOutside` |

`src/ai/cpu/carrier.ts` (5 literals):

| Line | Was | Now |
|---|---|---|
| 509 | `0.5` | `T_CARRIER.fallbackCentreK` |
| 541 | `0.3`, `0.7` | `T_CARRIER.{dribbleStepMinFrac, dribbleStepScoreFrac}` |
| 549 | `1.2`, `0.4` | `T_CARRIER.{dribbleLossBase, dribbleLossAttrW}` |

`src/ai/cpu/defending.ts` (3 literals):

| Line | Was | Now |
|---|---|---|
| 1087 | `0.5` | `T_DEFENDING.looseCoverFrac` |
| 1114 | `0.5` | `T_DEFENDING.keeperLaneMargin` |

`src/ai/cpu/passing.ts` (10 literals):

| Line | Was | Now |
|---|---|---|
| 633 | `0.005` | `T_PASSING.blockerMinXg` |
| 821 | `14` | `T_PASSING.throughSeedSpeed` |
| 992 | `0.6`, `0.4` | `T_PASSING.{headerDangerBase, headerDangerHeadW}` |
| 1041 | `0.5` | `T_PASSING.styleWeightBase` |
| 1043 | `0.5` | `T_PASSING.styleWeightBase` |
| 1044 | `0.5` | `T_PASSING.styleWeightBase` |
| 1046 | `0.5` | `T_PASSING.styleWeightBase` |
| 1047 | `0.5` | `T_PASSING.styleWeightBase` |
| 1049 | `0.5` | `T_PASSING.styleWeightBase` |

`src/ai/cpu/shooting.ts` (1 literal):

| Line | Was | Now |
|---|---|---|
| 335 | `0.3` | `T_SHOOTING.keeperAheadMin` |

`src/ai/defshape.ts` (2 literals):

| Line | Was | Now |
|---|---|---|
| 704 | `0.15`, `0.9` | `T_DEF_SHAPE.{laneBlockFracMin, laneBlockFracMax}` |

`src/ai/press.ts` (1 literal):

| Line | Was | Now |
|---|---|---|
| 229 | `1.05` | `T_PRESS.lbSpeedMul` |

`src/ai/steer.ts` (1 literal):

| Line | Was | Now |
|---|---|---|
| 575 | `0.5` | `T_STEER.sprintKeepFrac` |

`src/sim/core/kick.ts` (1 literal):

| Line | Was | Now |
|---|---|---|
| 61 | `0.5` | `T_KICK.liftVy` |

`src/sim/players/firstTouch.ts` (2 literals):

| Line | Was | Now |
|---|---|---|
| 574 | `0.5` | `T_FIRST_TOUCH.heavyTouchRandMin`, `(1 - T_FIRST_TOUCH.heavyTouchRandMin)` |

### Kept local: not gameplay (`// LOCAL_TUNING (non-gameplay: <reason>)`)

| Module | Reason |
|---|---|
| `src/render/goals.ts`, `src/render/kit/crest.ts`, `src/render/players/model.ts`, `src/render/players/fk.ts`, `src/render/crowd.ts`, `src/render/stadium.ts`, `src/render/warmScript.ts`, `src/render/quality.ts`, `src/render/markers.ts`, `src/render/replay.ts`, `src/render/ball.ts`, `src/render/anim/locomotion.ts`, `src/render/anim/mapper.ts`, `src/render/anim/reach.ts`, `src/render/effects.ts`, `src/render/pitch.ts`, `src/render/camera/broadcast.ts`, `src/render/camera/cinematic.ts`, `src/render/kits.ts` | Render only (looks, cameras, animation, quality tiers, replay presentation). |
| `src/audio/bank.ts`, `src/audio/eventMap.ts`, `src/audio/crowd.ts`, `src/audio/ui.ts`, `src/audio/whistles.ts`, `src/audio/sfx.ts`, `src/audio/engine.ts`, `src/audio/voices.ts` | Audio mix and timing. |
| `src/ui/screens/remap.ts`, `src/ui/screens/diagnostics.ts`, `src/ui/screens/pause.ts` (and the HUD constants of `src/ui/hud/*` / `tutorialSteps.ts`, which never had a block marker) | Menu / HUD presentation and timing. |
| `src/net/lobby.ts`, `src/net/lockstep.ts`, `src/net/session.ts`, `src/net/adaptive.ts` | Transport / session timing (the sim itself is lockstep-identical). |
| `src/platform/replayRecorder.ts`, `src/platform/storage.ts`, `src/platform/pwa.ts`, `src/platform/recovery.ts`, `src/platform/settingsStore.ts` | Platform plumbing. |
| `src/data/names.ts`, `src/data/playerGen.ts`, `src/data/kits.ts` | Data generation only (re-run `npm run gen:data`). |
| `src/data/tactics.ts` | Shape limits of `tacticalHome`, which no sim / AI path calls. |
| `src/app/session.ts` | App timing. |
| `src/modes/stats.ts` (`RATING`) | Post-match player ratings (presentation). |

### Stays inline on purpose in `src/sim` and `src/ai`

The TUN-1 rule still holds (enum indices and flags, scratch / ring / list sizes and offsets, solver iteration counts,
tolerances and seeds-of-a-bisection, sentinels, maths constants and series, input quantisation, cost-only pre-checks,
degenerate-geometry guards, display constants, derived constants). Also left inline, by category:

- attribute normalisation and references: `(attr - 1) / 98`, `/ 99`, weak foot 1..5 with `/ 4`, `(st - 50) / 50`,
  the 180 cm height reference of every `(height - 180)` term (its weight is tuning; a constant shift does not change
  a ranking), per-30 / per-29 rating-point unit scales (`levels.ts`, `shooting.ts`, part of the slope's unit);
- averages and centring: `(a + b) * 0.5`, `(1 - cos) * 0.5`, `0.5 - q`, `(n - 1) * 0.5` wall centring, coin flips
  `rngFloat < 0.5`, duel centre `0.5 + diff / span`;
- fallbacks for invalid data and unreachable branches (default heights 1.8 / 1.85 m where a reference is not meant,
  default weak foot 3, default composure 50, `HALF_LENGTH * 0.5` dead-branch spots, 1 m pitch-inside guards,
  `+ 5` off-pitch guards), sign dead zones (|component| <= 0.05 / 0.1), epsilons (0.01, 0.02, 0.05 m margins);
- `src/ai/cpu/passing.ts` through-ball power samples 0.2 / 0.4 / 0.6 / 0.8 and cross powers 0.3 / 0.6 / 0.9: the
  code passes them as literal arguments on purpose (a computed or loaded double argument would be boxed per call);
- laws of the game and fixed formats: the awarded 3-0 of an abandoned match, `PERIOD_BASE_MIN`, 60 s / 60 ticks
  conversions, the practice corner / penalty spots (built from pitch constants), `machine.ts` joiner unit offsets;
- presentation inside the sim: `throwin.ts` look-at point (10 m), `init.ts` ball start height (= ball radius).
- `src/modes/practice.ts` `PRACTICE_SPOTS` (menu entries with labels; the sim reads its own copy, now
  `T_PRACTICE.freeKickSpots`), `src/modes/setup.ts` half-length options (settings range, not tuning).

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

INT-A log, written before TUN-1. The blocks named here now live in `src/contracts/tuning.ts`: carrier `T_CARRIER`,
passing `T_PASSING`, xG `T_SHOOTING`, defending `T_DEFENDING`, shape `T_SHAPE`, back line `T_DEF_SHAPE`, jobs `T_JOBS`,
steering `T_STEER`, support `T_SUPPORT`, set pieces `T_SETPIECE_AI`, pass `T_PASS_KICK`, aerial `T_AERIAL_PLAY`, receivers
`T_RESOLVE`, locomotion `T_LOCOMOTION`, lob `T_LOB`, keeper positioning `T_GK_POSITION`.

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
| `kicks/kickCommon.ts` | `takerStep` / `takerLinedUp` / `takerLineUpMaxTicks` (new; the last replaced by FIN-K `takerApproachMaxDeg`) | - | 0.08 m/tick / 0.4 m / 45 ticks | A restart taker whose kick goes another way than his line-up (a CPU free kick passed backwards, a back-pass kick-off) side-steps round the dead ball to behind it before the strike (he kicked it through his own body). |
| RUL-11 (`rules/restart.ts`) | `setupWalkSpeed`, `setupExtendMaxTicks`, `cutFreeKickGoalDist` (new) | - | 4.5 m/s, 180 ticks, 35 m | Walked set-ups (throw-ins; free kicks more than 35 m from the attacked goal, which GFX-15 shows on the main camera): the taker runs to his spot and illegal players walk out from the award, and the set-up waits past restartSetupTicks for them (median ~100 ticks from the award, at most 230), then places any straggler. Was: everyone teleported at restartSetupTicks (throw-in takers up to 18 m, free-kick takers up to 61 m, in view; QF-4 CR, D-008). |
| RUL-11 (`rules/restart.ts`) | `setupStragglerMaxTicks` (new), `setupExtendMaxTicks`, `setupTakerRunMinSpeed` (new) | 180 (one cap) | 180 / 270 ticks, 2 m/s | [QF-10 second pass] Stragglers are placed 180 ticks past restartSetupTicks, but while the taker is still running in (not in place, closing on his spot at 2 m/s or more) the set-up waits up to 270: a throw-in or free-kick taker who started 22-36 m away was teleported 6-25 m at the old cap, in view. 270 keeps ready + the 12 s human timeout + the 2 s Default grace inside the throw-in phase limit (1200 ticks). CPU matches (32 x 4-minute halves): taker distance at a walked award p99 17 m, max 18 m, so this only matters for long balls into touch far from everyone. |
| RUL-05 (`rules/freekick.ts`) | `downClear` placement (no constant) | - | never across a penalty-area line | [QF-10 second pass] The free kick moved 1.3-2.6 m off the fouled player could cross the area line (a foul just outside the box became a free kick inside it); such candidates are skipped. |
| RUL-11 (`rules/restartCommon.ts`) | `approachSpeedFrac`, `approachArrive`, `approachClear`, `faceGain` (new) | - | 0.85 of top speed, 0.25 m, 0.8 m, 0.2 | The walked free-kick taker's run (ARRIVE, round the ball), then he turns to his aim while waiting. |
| RUL-02 (`rules/throwin.ts`) | `approachSpeed`; `approachTopFrac`, `approachAccel` (new) | 5 m/s (instant) | 6.5 m/s, at most 0.85 of top speed, reached at 7 m/s^2 | The throw-in taker runs to the line during the walked set-up (he was teleported there at restartSetupTicks). |
| RUL-05 (`rules/freekick.ts`) | `takerWalkMaxDist`, `downClear` (new) | - | 18 m, 1.3 m | A free kick on the main camera goes to the best taker within 18 m (else the nearest), who can run there; the ball is placed beside the fouled player lying on the foul spot, not under him. |
| RUL-04 / RUL-05 | `cpuGraceTicks` | 60 / 75 | 140 | The CPU corner / free-kick fallback leaves TAI-13 time to wait for its box runners (QF-11 can raise TAI-13 `maxArrivalWait`); the fallback and its first retry stay before RUL-11's 4 s CPU watchdog. |
| RUL-11 | penalty legality | centre outside the area / arc | whole body (SIM-05 radius) outside | Players waited at a penalty with their centre on the area line, half the body inside. |
| RUL-11 | goal-frame rule (no constant) | - | non-keepers kept `T_PLAYER.bodyRadius` in front of the goal line inside the posts' width (+ post radius + body radius) | A player behind the goal line at a goal kick or corner was placed at the nearest legal point on the line, overlapping the post / net (QF-1 goal-frame test). |
| RUL-11 (`rules/restartCommon.ts`) | `swapRunMaxTicks` (new) | - | 240 ticks | "Choose the taker" (SPRINT) at a walked free kick runs the new taker (within 18 m) to the ball and releases the old one where he stands; kick inputs wait until he is there. Was: both teleported (up to 18 m each) on the main camera. Free kicks within 35 m keep the instant swap (set-piece camera). [FIN-K: every free kick runs the new taker in now, see the FIN-K section.] |

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

## QF-13 skeptic (Wave 4 round 3, second pass)

Two skeptic runs: the first was cut off by a container restart (its edits were committed as WIP 23a6a42); the second
reviewed those edits like a first pass's (each fix switched off: its regression test fails; kept) and went on. Same
tools; experiments with a scratch runner that replays the tools' seeded configs match for match (a seed's first n
configs are the tools' first n), probe scripts over `tools/headless.ts runMatch`, and copies of the tree for code
variants. Every fix below changes sim behaviour (state hashes); each has a regression test
`tests/scenario/qf-13-sk-*.test.ts` that fails on the code before it.

### Verification of the first pass (new seeds, nearby inputs)

| Claim | Attacked with | Result |
|---|---|---|
| Header flicks over the goal line gone | restarts by the last kick, 40 short matches (seeds 301 / 521, Beginner, Professional, Legend, Beginner v Amateur) | 0 goal kicks off an AI header pass to no one in the attacking half (1 goal kick off a clearance from the own half); flicks from the other end: first skeptic run's yaw fix (below) |
| Beginner freeze at most one delay | longest run of the CPU defender's reaction delay outside our own pass in flight, 8 Beginner matches (seed 521) | 81 ticks (both teams) |
| Receiver / chasers off the pitch | every player beyond a line by more than 1 m for 20+ ticks in play, 40 matches (5 level pairs) | none |
| Shot reaction 10 ticks | an AI header / volley on an untouched shot within 10 ticks | none in 32 matches |
| Balloon shots | foot shots launched above 0.62 rad | none in 32 matches (491 shots) |
| Parry round the post never into the goal | sweep: keeper 0.3-8 m off his line and 2 m to either side, shots from 6 places 11-25 m out at 6 aim points by the posts, 3 heights, 3 speeds, 2 seeds (2068 parries) | none toward the goal line crosses inside the posts / under the bar |
| Carrier orbiting his ball (latched leash) | CPU carriers with the ball out of SIM-06's reach and not closing on it | incomplete: the latch let go at the edge of his reach and ignored the ball's height (defect 1 below) |
| Section 7 bands | 150-match soaks (soak seed 1, the 500-match soak's first 150 configs): the first pass's tree (its fixes, the first skeptic run's switched off) against the WIP tree | goals 3.28 -> 3.72 (FAIL); see "Goals band" below |

### Defects fixed by the first skeptic run (reviewed: each test fails with its fix switched off; kept)

| Defect | Fix | Test |
|---|---|---|
| Header flicked over the goal line from the other end: the first pass shortened a flick to no one for its aimed line, then drew the aim error, and a weak header's yaw turned it over the line (team 1 / ends changed: 405 of 14,300 grid flicks) | SIM-12 `solveAerial`: the yaw is drawn before the roll check and applied to every relaunch (the same single `s.rng` draw) | `qf-13-sk-flick-mirror` |
| Reaction delay spent before an interception: our pass leaving the foot re-armed the delay, it ran down in flight and the interception found it spent (a Beginner defender reacted after 46-58 of 80 ticks, at once in 1 of 10) | TAI-11 `tickBrain`: our pass in flight is remembered (`OUR_PASS`); an opponent taking it re-arms the delay in full; second run: below Professional only (`T_LEVEL.interceptRearm`) | `qf-13-sk-react-intercept` |
| CPU receiver trapping the ball out of play: the receiver of an overhit pass sprinted onto it at the line (or met it there) and SIM-07's clean settle put it over (1.44 throw-ins a match, 18% of all) | TAI-11 `receiveTurn`: on the tick SIM-07 takes the ball (exact reception check, this tick or the next) the stick's component toward the line turns `T_CPU.defendReceiveInward` into the pitch; narrowed by the second run (goals band, below): only when the predicted clean settle would end less than `defendReceiveSettleMargin` 1.5 m inside the line | `qf-13-sk-receive-line` (its bot-match sample control 10 -> 5 throw-ins: 8 once the traps out are gone) |
| Penalties at the top levels: the careful, well-timed standing tackle in the box with the carrier's body within reach is a foul; World Class / Legend's quick tackles conceded 0.75 / 1.6-2.0 penalties a match | TAI-11 `boxClear`: in the own area a careful tackle also needs the carrier out of body contact and his body off the line to the ball; second run: at World Class and Legend only (`T_LEVEL.boxBodyClear`) | `qf-13-sk-box-tackle` |

Its fresh-seed check of the first pass (seeds 5-6, 200 each): top-bottom 77.3%, equal 61.9% points: both targets missed on
new seeds (over six seeds 81.7% / 58.2%).

### Defects fixed (second skeptic run)

| Defect | Measured before | Fix | After |
|---|---|---|---|
| CPU carrier loses his own ball after a heavy touch and a turn | a scan of owners whose ball is out of SIM-06's reach and not getting closer (seed 411, 8 short Legend matches): after a heavy touch ahead the carrier re-decided 30-40 degrees off the ball's line; a turn means no sprint, so he slowed to his jog while the ball rolled on faster, 2-2.8 m ahead, until it passed the lose radius: 76 releases (9.5 a match at Legend, 0.9 at Professional); the first pass's latched leash let go at the edge of his reach, so he turned away, slowed (his reach shrinks with his speed) and the ball ran out of it again | TAI-08 `runDribble`: the leash, once on, holds until the ball is `T_CPU.carrierLeashInner` 0.3 m inside his reach; in a turn he sprints while the ball, rolling on (SIM-02 roll model) until it slows to his dribbling pace, would get further than `T_DRIBBLE.loseRadius` - `carrierLeashLoseMargin` 0.3 m (other turns keep their jog: sprinting after every escaping turn doubled a Legend carrier's sprinting) | 7 releases in the same 8 Legend matches (0.9 a match; lags of 60+ ticks 3.5 -> 1.3 a match); `qf-13-sk-carrier-lag` |
| CPU carrier orbiting his bouncing ball (glitch list: players orbit a target) | a first touch that popped the ball up: the leash judged it in reach horizontally and let go, so the carrier ran off along the plan and circled his ball by the touchline for 84 ticks without a touch (SIM-06 touches only a ball at most `T_DRIBBLE.controlHeight` high; seed 411 #1, Legend) | the leash holds a ball above control height, aimed at where it comes down to that height (`carrierLeashMaxLead` 1 s at most) | touched after 9 ticks; `qf-13-sk-carrier-lag` |
| A shot through a defender while his keeper goes for it | SIM-14 `interceptContacts` skipped an outfield defender altogether when his keeper "claimed" the ball (GK_RUSH / CATCH / DIVE / PUNCH within `keeperPriorityDist` 2.5 m, the keeper-fights-a-defender rule), body included: a volley went through a defender's chest (0.17 m from his centre at 1.18 m) into the net (1 of 43 goals, seed 801 #4); in a grid of shots at a defender 2.2 m in front of a set keeper, 48 of 54 went through him | the claim calls off a pass interception and the stretched-leg roll only; a body in a fresh shot's path stops it | 0 of 54; `qf-13-sk-shot-body` |
| Passes through opponents | a scan of untouched passes whose path ran within 0.25 m of an upright opponent's centre: 29 in 8 Professional matches, none touched: SIM-14 counted only `isFootPassKind` as a pass, so a header pass (a flick-on dropping at 7-14 m/s) passed through opponents' legs (2.6 a match), and a pass above `interceptMaxHeight` (1.0 m) through chests and heads (1 a match) | header passes count as passes in `interceptContacts`; a body stops a pass up to `shotBlockHeight` (1.8 m; the interception roll stays below 1.0 m) | 0 in the same 8 matches; `qf-13-sk-shot-body` |
| The fouled player slides onto the free-kick ball | the area test `qf-10: the fouled player lying on the foul spot is not under the free-kick ball` failed once this run's changes gave its seed's victim a run at tick 700 (0.68 m); a scan of free kicks in 12 CPU matches: the ball within 0.95 m of a man lying at 8 of 56 with a man down (0.04 m once; 4 of 35 on the WIP tree): RUL-05 put the ball `downClear` 1.3 m beside where he lay at the award, but a man knocked down at a run is LOCKED on SIM-04's `lockedFriction` and slid on up to 2 m. Also: the rounding of the squared distance rejected the spots exactly `downClear` across the pitch, so the documented first choice never happened | `clearOfDown` tests the whole slide (from where he is to v^2 / 2 `lockedFriction` ahead), with a rounding tolerance | 0 of 54-57 (16 matches); `qf-13-sk-fk-slide` |
| Set-up walkers shove a man lying on the ground | the two cases left after that fix: the anchored taker (never pushed in a set-up) walked to the ball through the lying victim, SIM-05 handed the victim the closing speed (3-4 m/s) and his LOCKED slide carried him 1-2 m, onto the ball; a scan of set-ups: 13 shoves of a man down in 16 CPU matches (up to 2.06 m, 6 by the taker), 1 in open play | SIM-05 `resolvePairs`: in a restart set-up a man down (FALLEN / GET_UP) outranks every other body (the walkers, the anchored taker included, go round him); open play unchanged | 0 shoves in 16 matches; `qf-13-sk-fk-slide` |

### Constants (`src/contracts/tuning.ts`)

| Constant | Value | Unit | Where |
|---|---|---|---|
| `T_CPU.carrierLeashMaxLead` (new) | 1 | s | TAI-08 leash aim ahead (a high ball: until it is down to control height) |
| `T_CPU.carrierLeashLoseMargin` (new) | 0.3 | m | TAI-08: in a turn, sprint while the ball would get beyond the lose radius less this |
| `T_CPU.carrierLeashInner` (new) | 0.3 | m | TAI-08: the leash holds until the ball is this far inside his reach |
| `T_CPU.defendReceiveSettleMargin` (new) | 1.5 | m | TAI-11 receiveTurn trigger; replaces `defendReceiveEdge` / `Lead` / `OutSpeed` / `OutStick` (removed); `defendReceiveInward` 0.8 kept |
| `T_LEVEL.boxBodyClear` (new) | 0 / 0 / 0 / 0 / 1 / 1 | on / off | TAI-11 boxClear levels |
| `T_LEVEL.interceptRearm` (new) | 1 / 1 / 1 / 0 / 0 / 0 | on / off | TAI-11 interception re-arm levels |
| `T_LEVEL.carrierEvalTicks` | 3 -> 2 / 4 / 5 / 5 / 6 / 12 | ticks | TAI-08 re-decision period, Beginner only (ladder, below) |

RUL-05 `clearOfDown` reads SIM-04's `lockedFriction` (locomotion LOCAL_TUNING) for the slide and has a 1e-6 m^2
rounding tolerance; SIM-05's set-up rule has no constant.

### Goals band (section 7) and the scope of the first skeptic run's fixes

The 500-match Professional soak on the tree with both skeptic runs' fixes: goals 3.77 a match (band 2-3.6, FAIL;
the first pass measured 3.36 on its tree). 150-match soaks on the same configs (soak seed 1: the 500-match soak's first
150; one soak's standard error is about 0.15 goals, and reordering a single s.rng draw moved it 0.13), unless marked:

| Tree | Goals |
|---|---|
| first pass (the first skeptic run's fixes switched off) | 3.28 |
| WIP 23a6a42 (first skeptic run) | 3.72 |
| WIP + this run's fixes (carrier chase in every escaping turn, superseded) | 3.67 |
| candidate: WIP + this run's fixes as kept | 3.77 (500 matches: FAIL) |
| ... boxClear only at World Class / Legend | 3.70 |
| ... the SIM-14 changes switched off | 3.69 |
| ... receiveTurn switched off | 3.53 |
| ... receiveTurn narrowed (below) | 3.61 |
| ... receiveTurn narrowed, the first pass's order of the flick's yaw draw (a noise check) | 3.74 |
| ... receiveTurn narrowed, no interception re-arm at Professional | 3.51 |
| final: receiveTurn narrowed, interception re-arm below Professional, boxClear at World Class / Legend | 3.57 (500 matches: PASS) |

Kept: receiveTurn now acts only when the predicted clean settle would end less than
`T_CPU.defendReceiveSettleMargin` 1.5 m inside a line (it turned every reception within 3 m of a line with any stick
component toward it, also those that stayed in, and attacking receivers inside); the interception re-arm only below
Professional (`T_LEVEL.interceptRearm` 1 / 1 / 1 / 0 / 0 / 0: the long delays it was about; at Professional and up
the first pass's chain rule stands); boxClear only at World Class and Legend (`T_LEVEL.boxBodyClear`
0 / 0 / 0 / 0 / 1 / 1: their quick careful tackles gave away the penalties; Professional's 0.38 a match was no excess).
Professional keeps the first pass's behaviour wherever a fix was about other levels (the section 7 bands' reference).

Two area tests from other runs were sample tests that this run's (behaviour-changing) fixes moved across their limit and
were refreshed with the measurement: `qf-11-level-scan` (Legend's ground / driven pass control 60 -> 40: 50-65 now that
header passes can be intercepted and a turning carrier keeps his ball; Beginner's QA-13 shots into the man over 12
matches instead of 4: its first 4 gave 8 of 21, 16 matches give 0.19, 0.15 on the WIP tree) and the first skeptic run's
`qf-13-sk-box-tackle` Legend sample (8 matches, at most 8 penalties, instead of 4 / 3: over 16 matches 0.81 a match,
boxClear switched off 1.56; its first eight 5 against 13).

### Ladder: Beginner (item 2 keeps Beginner the weakest)

On the tree with every fix above, Amateur v Beginner came out at 62.5 / 65.5% (seeds 1 / 2, 64.0% over 400; the first
pass's tree 69.8%). A Beginner-only lever (no other pair has Beginner; Professional and the bands are untouched):

| Amateur v Beginner (`tools/ladder.ts --pairs 0`, 200 a seed) | Seed 1 | Seed 2 | Over 400 | Kept |
|---|---|---|---|---|
| none | 62.5% | 65.5% | 64.0% | - |
| `T_LEVEL.interceptRearm` off at every level (a cause check) | 64.5% | - | - | - (not the cause) |
| `T_LEVEL.keeperReactTicks` Beginner 45 -> 60 | 67.5% | 69.5% | 68.5% | - (a keeper a second late to a shot) |
| `T_LEVEL.markGapMul` / `lineRateMul` Beginner 2.0 / 0.5 -> 2.6 / 0.35 | 68.5% | 59.0% | 63.8% | - |
| `T_LEVEL.carrierEvalTicks` Beginner 3 -> 2 | 69.5% | 68.0% | 68.8% | yes (QF-11 / QF-13: re-deciding often is worse) |

### Final measurement (this tree)

`tools/soak.ts --matches 500 --difficulty 3 --enforce all` (Professional; the Beginner lever does not reach it): PASS;
500 finished, 0 exceptions / invariant failures / watchdogs, determinism PASS; goals 3.55, shots 19.02, dominant
possession 56.59%, home possession 50.35%, pass completion 78.48%, fouls 12.44, offsides 0.18, blow-outs 2.60%.

`tools/fuzz.ts --matches 60 --enforce all`: PASS (59 finished + 15 rematches, 0 exceptions / invariant failures /
watchdogs, determinism PASS).

`tools/ladder.ts --matches 200`, seeds 1 and 2 (400 a pair; Amateur v Beginner from the `--pairs 0` runs above, the
other pairs have no Beginner):

| Pair | Seed 1 | Seed 2 | Over 400 | Target 65% |
|---|---|---|---|---|
| Amateur v Beginner | 139 / 37 / 24 = 69.5% | 136 / 30 / 34 = 68.0% | 68.8% | meets |
| Semi-Pro v Amateur | 145 / 28 / 27 = 72.5% | 148 / 33 / 19 = 74.0% | 73.3% | meets |
| Professional v Semi-Pro | 131 / 33 / 36 = 65.5% | 135 / 29 / 36 = 67.5% | 66.5% | meets |
| World Class v Professional | 128 / 42 / 30 = 64.0% | 147 / 33 / 20 = 73.5% | 68.8% | meets (over 400) |
| Legend v World Class | 138 / 30 / 32 = 69.0% | 129 / 35 / 36 = 64.5% | 66.8% | meets (over 400) |

`tools/balance.ts --matches 200`, seeds 1-4 (seed 1 all suites, seeds 2-4 `--suite top-bottom,equal`):

| Matchup | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Over 800 | Target |
|---|---|---|---|---|---|---|
| top-bottom MOS (88) v ROO (62), wins | 165 / 25 / 10 = 82.5% | 164 / 27 / 9 = 82.0% | 167 / 17 / 16 = 83.5% | 173 / 16 / 11 = 86.5% | 83.6% (goals 2.66-0.59) | >= 80%: meets |
| equal SND (76) v GLA (75), points | 60.8% | 52.3% | 55.8% | 58.0% | 56.7% | 40-60%: meets |
| mirror GLA v GLA, home points | 51.7% | - | - | - | - | 40-60%: meets |

The same runs on the tree before the last two fixes and the Beginner lever (free-kick slide, set-up shove): top-bottom
171 / 165 / 159 / 164 = 82.4% over 800, equal 57.9%; soak goals 3.57 (PASS); ladder seed 1 64.5 / 77.0 / 75.5 / 69.0 /
70.0%, seed 2 World Class v Professional 73.0%, Legend v World Class 62.0% (66.0% over 400).

## QF-14 (Wave 4 round 4: goal-band margin and shot quality)

Measured with a scratch runner over `tools/headless.ts` / `tools/ladder.ts` / `tools/balance.ts` that applies tuning
overrides in every worker before the sim loads (with no override it reproduces the tools' seeded configs match for
match) and records every shot (distance, kind, power at the kick, the CPU's priced xG, pressure, outcome). "Soak" rows:
the 500-match soak's first 150 configs (soak seed 1, Professional, 4-minute halves; standard error about 0.13 goals);
"save%" = saves / (saves + goals) of non-penalty shots on target; ladder / balance screens: `--matches 100` a seed
(mirror legs; a 200-match row has a standard error of about 3.4 points). Every change below changes sim behaviour
(state hashes).

### Where the goals and the long shots came from (baseline tree, 150 matches)

Goals 3.47, shots 19.2 (12.9 on target), save% 63.3. CPU carrier shots by power at the kick: beyond 12 m, 5.3 a match
were struck at under 10% power (a 1-tick hold: TAI-08's quick-shot cut under pressure), 17-20 m/s and lofted at up to
35 degrees, 0 goals in 318 (60 matches); 2.0 a match at 10-30% power, 1 goal in 122. About half the shots from 28 m+
were these taps. The "speculative long shots" were rushed shots: the option was priced as a full-power shot while the
execution cut it to a tap.

Refusing them (the rushed-shot gate below) raised goals to 4.8-5.4 a match and dropped save% to 35-47%: each refused tap
left the carrier on the ball, and the taps had been the defence's turnovers. Followed up (13.8 refusals a match): he
dribbled on in 99.5% of cases; 15% scored within 10 s, 23% won a free kick, 6.5% a penalty, 28% still had the ball 10 s
later. The causes, each a defect fixed below: the CPU's defender never challenged a close-control dribbler (escorts),
the keeper was beaten by full-power long shots dipping in behind him, and the carrier priced a carry into a crowd in
the attacking half as safe.

### Defects fixed (each with a regression test `tests/scenario/qf-14-*.test.ts`)

| Defect | Measured before | Fix | After / test |
|---|---|---|---|
| Long shot struck as a tap (TAI-08 decision / execution mismatch) | above | `shotOptionInto`: beyond `quickShotDist` (10 m) no shot is offered when the quick-shot cut would leave less than `T_CPU.carrierShotMinPowerShare` (0.3) of the planned hold (`SHOT_RUSHED`) | no taps beyond 10 m; `qf-14-rushed-shot` |
| CPU defender escorts a close-control dribbler (TAI-11) | TAI-11 tackled only an exposed ball or on a rash lunge (none at Legend, none in the box from Professional up), its guard point led by the carrier's velocity: two defenders escorted one carrier from the halfway line into the six-yard box for 27 s (soak seed 1 #0) and he scored; escorts (5 s+, an opponent within 2.5 m 80% of the time, no tackle) 0.6 a match, 1.35 with the taps gone | patience: once the carrier has had the ball `T_LEVEL.patienceTicks` (90) the controlled defender holds his ground `T_LEVEL.patienceStandoff` (0.9 m from Professional up) goal-side of where the carrier is, no velocity lead: the carrier must turn (an exposure the careful tackle takes), pass or shoot | the goal-side escort is gone: `qf-14-escort` (a Legend defender holds up a jogging close-control carrier within 8 m and wins the ball; before: 24 m in 7 s, every seed); escorts 0.50 a match on the first pass's final tree (40 matches), the longest 17 s (0.55, the longest 14.3 s, on the resume's): a defender pinned alongside the dribbler, below |
| Keeper lobbed off his line by a dipping long shot (GKP-01 / GKP-02) | 10 goals from 80 shots from 28 m+ in 25 Professional matches (real football: about 3%): 24-28 m/s long shots rise to 4-5 m and dip under the bar; the keeper stood `T_GK.depthFar` 4.5 m out, the ball passed over his reach, he shuffled across at the jog jockey cap (2 m/s) and made a hopeless dive where he stood | `T_GK.depthFar` 3 m; GKP-02 `planIntercept` drop back (a ball coming down behind his plane that he can reach backpedalling: GK_CATCH in `CATCH_DROP`); GK_CATCH tracking / dropping back at the sprint jockey cap (`saveKinematics` `dropBack`, `dropSlackTicks` 8, `trackSprint`) | 3 goals from 83 (same 25 matches); a grid of 18 dipping 29-35 m shots 44% -> 0% goals; `qf-14-keeper-long-shot`. Resume review: the far depth alone carries this (the test passes with the drop back or the sprint tracking switched off, fails with depthFar 4.5); in matches the drop back and the sprint tracking made no measurable difference (each soak shot replayed from a copy of the state: 597 shots in 40 matches, 105 goals with both, 106 without the drop back, 107 without the sprint tracking), and the drop back had two planning defects of its own (fixed below) |
| Keeper dives early at a lob and lies down as it floats over him (GKP-02) | a hopeless dive at a ball just over his dive top near him was timed as a full-reach dive while the dive went to the nearer sample: over 7-26 ticks before the ball came (31 of 80 such dives in a grid of lobs) | a hopeless dive's `PLAN.need` is the dive time of the distance he dives (`min(hopeD, reach)`) | 3 of 79 (each at a ball he had touched first); `qf-14-keeper-lob-dive` |
| Carry into a crowd priced as safe in the attacking half (TAI-08) | the dribble's loss chance there ignored the room (TAI-10 dribble score), so a noise-free carrier drove into a defender holding his ground | loss x (1 + `T_CPU.carrierDribbleTightAttackMul` (0.25) x (1 - score)) in the attacking half, as in our own half | `qf-14-tight-dribble` |
| SIM-14 front standing tackle at a close ball too weak | `baseChance` 0.5: a front standing tackle at the ball won about 30% (22% of all tackles), every lost one with the carrier's body in the zone a foul | `baseChance` 0.7 | 28% of all tackles won, fouls 13.5 -> 12.8 a match (DAT-05 standing-tackle rows refreshed); `qf-14-front-tackle` (added on the resume: an equal-rated front tackle at the ball at his feet: win chance 0.51, 0.33 with 0.5) |
| [resume] Keeper set for a standing catch of a lob over his head (GKP-02) | `planIntercept` added the standing step allowance (up to `stepMax` 0.8 m, a horizontal step) to the 3D distance from the standing capsule, so a ball up to 0.8 m above his standing reach (3.1 m for a 1.88 m keeper) counted as a standing catch a second ahead: in a grid of lobs over a 75-rated keeper put 4.5 / 5.5 m off his line, 61 of 172 had him set under a ball he could not reach (`actCurve` over his `standTop`), no dive or drop back while there was time | the step closes the horizontal gap only: reachable standing when (max(0, d - step))^2 + dy^2 <= (standArm + ball radius)^2 | 0 of 172; that grid 87 -> 76 goals with this fix alone; `qf-14-keeper-drop` |
| [resume] Keeper gives up backpedalling under a lob (GKP-02, QF-14's drop back) | the drop back is re-planned every tick, and every re-plan assumed he set off from rest after `dropSlackTicks` again: two ticks in, the spot he was backpedalling to stopped counting as reachable, the target jumped 0.5-0.6 m or he gave the drop up for a track / hopeless dive where he stood | while already dropping (GK_CATCH `CATCH_DROP`): no start-up slack again, and his current speed toward the spot counts | no jumps; that grid 87 -> 82 goals with this fix alone, 69 with both; `qf-14-keeper-drop` |
| [resume] Carrier standing on the ball never challenged (TAI-11) | a human who stops with the ball at his feet exposes nothing (no touch, no turn) and Legend has no decision noise (no rash lunge): its defender stood 1.2 m in front of him for ever (in 48 such scenes, 8 per level, the carrier kept the ball for 10 s in 1 / 1 / 1 / 4 / 5 / 8 from Beginner to Legend) | after the patience, the carrier untouched for `T_CPU.defendStillTouchTicks` 45 + the level's `tackleTimingTicks`, he and the ball slower than `defendStillSpeed` 1 m/s, in no action (not shielding, not winding up or charging a kick), the controlled defender goal-side with the ball in reach challenges | 1 of 48 kept (a Beginner defender), shielding carriers unchanged (44 of 48 keep it); bot carriers never stand that long at Professional (8 soak matches hash-identical); `qf-14-still-carrier` |
| [skeptic] Carrier walking the ball into a patient defender never challenged (TAI-11; the still-carrier fix's nearby input) | a human walking at the goal with the stick part-way (1-2 m/s, the ball 0.5 m ahead, touched every ~10 ticks) is neither exposed (exposeDist 0.7 m) nor still (1 m/s, 45 ticks untouched): the patient guard point (0.9 m in front of him) moved with him, so a Legend defender was pushed back 23 m in 25 s with the ball 0.25 m from his own feet, never challenged; 8 of 8 Legend scenes kept the ball for 10 s (6-11 m gained), World Class 5 of 8 | the still challenge also fires for a carrier who has had the ball `T_CPU.defendHeldTicks` (180), is slower than `defendHeldSpeed` (2.5 m/s), between touches (the last one at least the level's `tackleTimingTicks` ago) with the ball presented to the defender: within his reach and his side of the carrier's body now and at mid-contact (SIM-14 `bodyBlocksBall` geometry: ball-first) | 0 of 16 kept (World Class / Legend, stick 35 / 50), won 12, fouls 12 (a front challenge at a ball at his feet: a fair contest; ~13 fouls from ~35 tackles a Professional match); a strafing carrier is not hacked down (a ball-first test at contact only, the dribbled ball predicted linearly, gave 17 fouls in 8 scenes; 1 now); `qf-14-held-carrier` |
| [skeptic] Still challenge gives a penalty away in the World Class / Legend area (TAI-11 box care) | the resume's still challenge did not ask the QF-13 box care (`T_LEVEL.boxBodyClear`: careful tackles in our own area at World Class / Legend want the carrier's body clear of the ball and out of body contact); a human standing on the ball in the box facing the defender was given a penalty in 2 of 12 scenes at each of World Class and Legend (and Professional, whose careful tackles take no box care either) | the still / held challenge in our own area takes the same care as a careful tackle (`boxClear` at the levels with `boxBodyClear`) | 0 of 24; `qf-14-held-carrier` |

Area tests refreshed for the behaviour change: `gkp-01-positioning` (lateral / step-across thresholds for the 3 m far
depth), `dat-05-attributes` (gkPositioning margin 0.15 -> 0.12 m: 0.16 -> 0.02 m now), `qf-14-tight-dribble`, and
`sim-14-tackle`'s bot-match accounting (a tackle forced on the whistle tick is pending too; the test counted it started
and never resolved). On the resume: `qf-13-sk-react-intercept`'s deflected-pass case counts its ticks from the
Amateur delay (it ran 20 + 20 ticks against Amateur's 42; 36 now). On the skeptic pass: `qf-14-escort`'s foul bound
(<= 1 in 6 scenes, when only an exposed ball was challenged) is now fouls <= balls won: the held jogger is challenged at
his feet as well (4 fouls, 5 won; 12 scenes: 10 won, 6 fouls, the carrier kept the ball in 1 of 12 against 4 before).

### Resume after a container restart: review of the first pass

The first pass had finished its changes (in the tree at 5b262ff, its last experiment, a per-level shoulder challenge,
already backed out) and was re-running its final measurements; the 500-match soak replays bit-identically on that tree
(hash 9214fb55, goals 2.77, shots 15.49) and so do its two ladder runs. Each qf-14 test was run on a copy of the tree
with its fix switched off, and fails: rushed shot (`carrierShotMinPowerShare` 0), tight dribble
(`carrierDribbleTightAttackMul` 0), escort (`patienceTicks` 0), keeper long shot (`depthFar` 4.5; it passes with only
`dropBack` 0 or only `trackSprint` 0, see the row above), lob dive (full-reach timing), and the resume's tests: front
tackle (`baseChance` 0.5, or `attrWeight` 0.55), keeper drop (each of the two planner fixes), still carrier
(`defendStillTouchTicks` 100000). The patience hold was probed for jitter (a still, a walking and a shielding human
carrier, Professional and Legend, 6 seeds each): no velocity reversals of the defender, closest 0.74 m. The resume's
three fixes change sim behaviour (the still-carrier challenge does not reach Professional bot matches; it does reach
Beginner ones, whose carriers stand through their 100-tick reaction delay), so every final number below is from the
tree with them.

### Settings measured (soak, 150 matches)

"gate" = `T_CPU.carrierShotMinPowerShare`, "dss" = `carrierDriveShotShare`, "bc" = SIM-14 `baseChance`, "tight" =
`carrierDribbleTightAttackMul`, "react" = `T_GK.reactBest` / `reactWorst`.

| Row | Goals | Shots | save% | Fouls | Pens | Note |
|---|---|---|---|---|---|---|
| baseline tree | 3.47 | 19.18 | 63.3 | 12.63 | 0.51 | |
| gate 0.3 / 0.4 / 0.5 / 0.7 only | 4.81 / 5.03 / 5.41 / 5.37 | 14.34 / 13.97 / 13.66 / 12.89 | 46.5 / 42.8 / 38.4 / 34.8 | 13.4-13.9 | 1.16 (0.4) | taps gone, the carrier walks in |
| gate 0.4 + react 4 / 15, 2 / 11 | 4.73, 4.39 | 14.5, 14.6 | 48.1, 52.9 | | | |
| gate 0.4 + aim inset 1.0, pressure error x2.5, boxBodyClear at Professional, dive windup 3, error base share 1 | 5.03, 4.64, 5.45, 4.87, 4.75 | 13.7-14.6 | 39-49 | | | none addresses the cause |
| gate 0.4 + patience 90 / 150 / 60 with an at-feet tackle | 4.12 / 4.42 / 4.23 | 14.2-15.2 | 61-63 | 30.6 / 26.6 / 32.2 | 2+ | the at-feet tackle fouls: removed |
| gate 0.4 + patience hold (no tackle), standoff 0.9 / 0.6 | 4.41 / 4.59 | 13.2 / 13.4 | 47.1 / 47.5 | 17.2 / 18.4 | 1.21 / 1.17 | hold kept (0.9) |
| gate 0.4 + bc 0.6 / 0.7 | 5.17 / 4.84 | 14.1 / 13.7 | 42.2 / 41.8 | 13.3 / 12.8 | | 0.7 kept |
| gate 0.4, bc 0.7, hold + dss 0.5 / 0.35 (was 0.7) | 3.83 / 3.39 | 14.5 / 15.0 | 55.5 / 58.9 | 14.8 / 13.4 | 0.59 / 0.32 | dss 0.35 kept |
| same + shotXgMul 25 (dss 0.5) | 4.16 | 12.4 | 47.1 | | | |
| gate 0.4, hold, dss 0.35, bc 0.7 + keeper depthFar 3, drop back, sprint tracking | 2.75 | 14.51 | 67.7 | 13.50 | 0.37 | |
| same, depthFar 3 only | 3.02 | 14.79 | 64.6 | | | |
| same, react 4 / 15 | 2.78 | 15.86 | 69.3 | | | GKP-02 batch save rate 81.5% (band 65-78): not taken |
| same, bc 0.5 | 2.98 | 15.27 | 65.6 | 15.06 | 0.47 | |
| same, gate 0.3 / dss 0.3 / boxShotBonus 0.05 | 2.86 / 3.02 / 2.87 | 15.75 / 14.76 / 14.61 | 67.2 / 62.8 / 66.8 | | | |
| same, patience only within 35 / 25 m of goal | 2.63 / 3.01 | 15.3 / 15.5 | 70.2 / 66.0 | | | |
| same, tight 2.0 | 2.32 | 13.14 | 68.6 | 11.41 | | |
| gate 0.3, tight 1.0, bc 0.7 / 0.5 | 2.51 / 2.51 | 14.69 / 15.59 | 67.9 / 68.8 | 12.47 / 13.42 | 0.27 | |
| gate 0.3, tight 1.0, bc 0.5 + dss 0.5 | 2.85 | 14.57 | 64.6 | 14.55 | 0.59 | |
| ... + long-shot threshold per metre 0.1 / 0.2, no shot beyond 34 m | 2.57 / 2.83 / 2.59 | 13.49 / 12.34 / 13.53 | 68.2 / 62.1 / 67.0 | 14.5 / 14.9 / 15.1 | | long shots, below |
| ... + dss 0.5 + per metre 0.15; + boxShotBonus 0.05 + per metre 0.15 | 3.07; 2.71 | 12.43; 12.05 | 59.4; 62.8 | 16.08; 14.8 | 0.71 | |
| ... + patience standoff 1.2 / 1.5 | 2.83 / 2.95 | 14.25 / 14.57 | 66.1 / 64.8 | | | escorts 0.68 a match at 1.2 (0.38 at 0.9): not taken |
| ... + patience 150 ticks (120) | 2.67 | 15.03 | 69.4 | | | escorts 0.63 (0.55), the longest 19 s: not taken |
| ... + boxShotBonus 0.06 / tight 0.5 / gate 0.25 | 2.53 / 2.66 / 2.51 | 15.49 / 14.87 / 15.33 | 69.5 | | | |
| gate 0.3, tight 0.5, bc 0.7; + react 7 / 21 | 2.59; 2.80 | 14.77; 14.49 | 68.8; 66.3 | 12.80; 12.72 | 0.37 | |
| gate 0.3, tight 0.25, bc 0.7 + react 7 / 20 | 2.87 | 15.37 | 64.8 | 13.56 | 0.33 | save% below the band |
| gate 0.3, tight 0.25, bc 0.7, react 6 / 19; 6 / 20 | 2.59; 2.69 | 15.63; 15.47 | 70.7; 68.9 | 13.26; 12.89 | 0.38 | the keeper range then widened to 4 / 25 for club balance (below) |

### Long shots

On the gate 0.3 / tight 1 / bc 0.5 tree, CPU carrier shots by distance (150 matches): 0-12 m 1.81 a match (58.5%
scored), 12-16.5 m 0.83 (15.2%), 16.5-22 m 1.03 (3.9%), 22-28 m 1.35 (3.0%), 28-34 m 1.91 (4.2%), 34 m+ 3.80 (0.4%,
2 goals in 570; struck at full power under pressure, median nearest opponent 1.4 m). The CPU's priced xG at the kick
ranks the shots the right way (priced under 0.01 -> 1.7% scored, 0.04-0.07 -> 12%, 0.1-0.15 -> 36%, 0.25+ -> 75%),
under-pricing the close ones about 2x. A shot from 34 m+ is chosen because `shotXgMul` (18) puts any priced chance
above the possession value of a midfield ball. Taking them away at every level (long-shot threshold per metre 0.1 /
0.2, or no shot beyond 34 m) cuts 2-3 shots a match and the carrier, kept on the ball, dribbles into the box: shots
12.3-13.5 (below the section 7 band), save% down to 62, fouls up to 16. At Professional they stay: the speculative
shots that were taps are gone (28 m+ shots 9.5 -> 5.8 a match, a third of them from 34 m+ at full power) and the rest
keep shots in the band. World Class and Legend now wait for a better chance (`T_LEVEL.shotThresholdXg` 0.008 / 0.02, Legend 0.03 on
the resume: no pot shot from a priced 0.005), which is also what separates them from the level below (next section).

### Ladder / balance screens (100 a seed; L0 = Amateur v Beginner ... L4 = Legend v World Class, wins %)

| Tree | L0 | L1 | L2 | L3 | L4 | top-bottom | equal points |
|---|---|---|---|---|---|---|---|
| gate 0.4, hold, dss 0.35, bc 0.7, keeper fixes, react 4 / 15 | 69 | 80 | 71.5 | 70 | 53.5 (200) | 78.5 | 59 |
| L4 only (200), on that tree: dss 0.7 / react 6 / 19 / patience off / gate off / bc 0.5 / old keeper | | | | | 56 / 58.5 / 70.5 / 49.5 / 59.5 / 61.5 | | |
| L4: patience Legend 45 / Legend 60 + World Class 120 / within 35 m / within 25 m | | | | 68 (L3, second) | 54 / 56 / 53 / 50.5 | | |
| L4: Legend re-decision 8 / 6 ticks, Legend keeper -12, World Class keeper 0 | | | | 65 (L3, keeper) | 60.5 / 61 / 58 / 63 | | |
| L4: tight 1.0 / 2.0 / 2.0 + Legend re-decision 6 | | | | | 66 / 61.5 / 58.5 | | |
| L4: Legend execution error 0.55 / + re-decision 6 / + tackle timing 2; World Class noise 0.12 | | | | 56 (L3, noise) | 54 / 60 / 56 / 65.5 | | |
| gate 0.3, tight 1.0, bc 0.7 | 69 | 75 | 66 | 59 (200) | 64.5 (200) | 79 | 57 |
| gate 0.3, tight 1.0, bc 0.5 | 58 | 69 | 60.5 (200) | 64.5 (200) | 67 (200) | 79 | 53 |
| ... + dss 0.5 | 65 | 84 | 61.5 | 56 | 67.5 | 80 | 64.5 |
| ... + Legend re-decision 6 | 58 | 69 | 60.5 | 64.5 | 58.5 | 79 | 53 |
| ... + a level-graded room read in the tight-carry price (x 0 / 0.3 / 0.6 / 1 / 1.4 / 1.8) | 61 | 71 | 67 | 59.5 | 59.5 | 79 | 53 |
| gate 0.3, tight 0.5, bc 0.7 (`tools/ladder.ts --matches 200 --seed 1`) | 62.5 | 72 | 66 | 57 | 61.5 | | |
| ... + `patienceStandoff` 1.5 / 1.3 / 1.1 / 0.9 / 0.75 / 0.6 (200 a pair) | 62 | 77.5 | 68 | 65 | 59 | | |
| ... + `patienceStandoff` 1.8 / 1.5 / 1.2 / 0.9 / 0.7 / 0.5 | 62 | 72 | 71 | 62 | 62.5 | | |
| standoff 1.5 ... 0.6 + `shotThresholdXg` World Class / Legend 0.006 / 0.012 | | | | 70 | 67.5 | | |
| ... 0.008 / 0.02 | | | | 69 | 72.5 | | |
| gate 0.3, tight 0.25, bc 0.7, react 7 / 20, standoff 1.5 ... 0.6, thresholds 0.008 / 0.02, Beginner keeper +60 (200 a pair) | 69.5 | 76 | 74 | 70 | 68.5 | 86 (200) | 55.5 |
| react 6 / 19, Beginner keeper +45, top standoffs 0.9 (400) | 64.3 | | | | | | |
| ... + Beginner re-decision 1 tick / Amateur keeper +22 / Beginner reaction 100 / Beginner keeper +52 (400 each) | 64.5 / 63.8 / 68.3 / 66.8 | | | | | | |

Fewer goals compress the ladder (more draws between neighbours): the levers that removed goals at Professional
(patience above all: off, Legend v World Class 70.5% against 53.5%) also brought the top pairs together, and the levels'
other differences (noise, reaction, keeper, re-decision period) moved them by no more than the noise of a 200-match
screen. What separates World Class and Legend again is the shot threshold: they keep the ball rather than shoot from a
priced 0.005, and score more (Legend v World Class goals 1.56-0.70 -> 2.13-0.81). A level-graded room read (top levels
more careful) lowered the top pairs' scoring and was not kept. Below Professional the defenders hold looser
(`patienceStandoff` 1.5 / 1.3 / 1.1 m: escorts at Beginner / Amateur / Semi-Pro 0 / 0 / 0.1 -> 0.27 / 0.17 / 0.2 a match,
the longest 13 s, under Professional's 0.42); closer than 0.9 m at the top was no better and let the qf-14-escort carrier
through at 0.6 m. Amateur v Beginner: Beginner reaction 80 -> 100 ticks (a Beginner keeper +60 measured as well, and
not taken: a keeper a second late, and qf-11-keeper-levels' Beginner scan saw no dive in its 4 matches).

### Escorts: what remains (open)

The escorts left on the final tree (0.50 a match of 5 s+, 0.35 reaching 18 m from goal, the longest 17 s; soak seed 1
#14: 14 s from 19 m out on the wing into the box, then a shot) are a different picture: the controlled defender is
beside the dribbler (cosine to his goal side about 0.3, 0.8 m away) and stays pinned there by the body contact; a
standing tackle needs an exposed ball (never, at a jog with the ball tight) and the shoulder challenge TAI-11 never
asks for without one. Measured fixes:

| Variant (on the final tree) | Escorts 5 s+ a match (40) | Goals (150) | Tackles | World Class v Pro / Legend v World Class (400 a pair, the final ladder's configs) |
|---|---|---|---|---|
| none (final) | 0.50, longest 17 s | 2.62 | 33 | 69.0 / 66.75 (`tools/ladder.ts`) |
| patience holds the ground (no step back toward goal once goal-side) | 0.30, longest 14 s | (40) 2.55 | 34 | - |
| + shoulder challenge without an exposed ball, alongside in our final third after 3 s / 5 s | 0 / 0 | 2.41 / 2.37 | 44 / 40 | 51 / 61 (100, after 5 s + keeper 6 / 28) |
| shoulder only within 20 m after 8 s (no hold) | 0.25, longest 8 s | (40) 2.60 | 39 | 65.8 / 61.0 |
| shoulder only in the box after 10 s (no hold) | 0.35, longest 10 s | (40) 2.70 | 37 | 68.3 / 56.5 |

Every variant that ends the alongside escort takes 4-10 points off Legend v World Class (below the 65% target) and,
the stronger ones, 0.2-0.3 goals off Professional: the top levels' edge had been the long carry that the lower level's
defender does not challenge. Not kept; this needs the top pairs re-separated by other levers first (the shoulder by
level, earlier at the top, 900 / 720 / 600 / 480 / 360 / 240 ticks: Legend v World Class 56%, no better).

Resume, on the final tree (40 matches, soak seed 1): escorts of 5 s+ 0.55 a match, 0.42 reaching 18 m from goal, 5 of
10 s+ (the longest 14.3 s), a goal within 3 s of one 0.17 a match (of 3.13). Traced (#14, ticks 1404-2250): the
controlled defender sits at a cosine of 0.28-0.32 to the carrier's goal side (the goal-side boundary is 0.3) 0.8-1.3 m
away, a second defender 0.8 m behind; the patience guard point (0.9 m in front of the carrier) lies behind the
carrier's body from where he is, so body contact keeps him alongside at the carrier's 4.1 m/s, and `tackleKind` gives
a standing tackle (cosine at the boundary), which waits for an exposed ball that a jogging close-control dribbler never
shows. Tried on the resume, none kept: the patience only once well goal-side (cosine 0.7): escorts 0.82 a match; a
sprint without the jockey cap between cosine 0.3 and 0.6, or a ball-first block tackle when the carrier runs at a
patient defender (`boxClear` safe): the same escorts (0.53). Open for the lead: ending the alongside escort needs the
top pairs re-separated (above) or SIM-14 / RUL-09 to let a ball-first challenge into a carrier's path go unpunished.

Skeptic pass, with a human carrier (`qf-14-held-carrier`'s scene, 8 seeds a level, 10 s): walking straight at the
defender is now challenged (the held challenge, above); walking across him is the same open picture at walking pace.
Stick (30, 15), 1.1-1.4 m/s: the Legend defender is goal-side (cosine 0.84) in body contact, the ball ahead of the
carrier to the defender's side of the line but behind the carrier's body from where the defender is (SIM-14 would meet
the man first), so neither challenge fires: kept 6 / 7 / 6 of 8 at Professional / World Class / Legend, 11-14 m gained
in 10 s (before the skeptic pass 8 / 8 / 8). A stick of 65 straight on (2.8 m/s, faster than `defendHeldSpeed`) slides
the defender alongside (cosine 0.27) and keeps the ball in 4 of 8 Legend scenes (26 m in 10 s). Tried: a held guard
point on the ball instead of the man (the defender steps across): 5 of 8 kept, not kept.

### Ladder on the resume (`tools/ladder.ts` seeds 1 and 2 and the scratch runner on the same configs, 400 a pair)

With the resume's three fixes the ladder moved by more than its noise in two pairs (every match is a different match
once a state hash moves): Amateur v Beginner 69.5 -> 65.5%, Legend v World Class 66.75 -> 63.0% (the others 76.0 ->
75.25, 70.75 -> 71.75, 69.0 -> 71.75%). The still-carrier challenge is not what moved the top pair (it can trigger 1-2
times in 12 Legend or World Class matches; Legend v World Class without it: 64.3%). Screens (400 a pair; the runner
reproduces `tools/ladder.ts` match for match):

| Lever | Amateur v Beginner | Semi-Pro v Amateur | World Class v Professional | Legend v World Class | Kept |
|---|---|---|---|---|---|
| none (the resume's tree) | 65.5 | 75.25 | 71.75 | 63.0 | |
| `T_CPU.defendStillTouchTicks` off | | | | 64.3 | - |
| Legend `shotThresholdXg` 0.02 -> 0.03 | | | | 67.3 | with the next |
| Legend `keeperReactTicks` -8 -> -12 | | | | 67.3 | with the previous |
| both Legend levers | | | | 71.0 | yes |
| World Class `keeperReactTicks` -3 -> 0 | | | 69.3 | 70.5 | - (World Class's keeper no quicker than Professional's; `qf-2-keeper-level` wants the table strictly falling) |
| Amateur `reactionTicks` 42 -> 36 | 67.0 | 74.5 | | | yes |

Both kept levers act at one level each (Legend, Amateur): Professional matches are hash-identical (the 500-match soak,
the balance runs and the save-rate run below are on this tree).

### Club balance (BRIEF section 15)

On the lower-scoring tree the 88-rated club beat the 62-rated one in 72.5-75.5% (200 a seed; target 80%, QF-13 83.6% at
3.5 goals a match): more draws. Screens (`--matches 100`, seeds 1-2 or 1-3; equal = SND v GLA points, target 40-60%):

| Lever | top-bottom wins | equal points |
|---|---|---|
| none | 72.5 (200) | 61.3 |
| `T_AI.composureNoiseSlope` 0.45 -> 0.6 | 82.0 | 65.5 |
| keeper reaction 5 / 21; 4 / 22 | 77.5; 79.0 | 61.5; 57.3 |
| SIM-14 `attrWeight` 0.55 -> 0.8 | 76.5 | 60.3 |
| keeper 4 / 22 + attrWeight 0.8 (300) | 76.0 | 60.0 |
| keeper 7 / 22 + attrWeight 0.8 (300) | 81.3 | 59.2 |
| keeper 4 / 25, dive speed 3.7-7.3 m/s, reach 1.82-3.32 m + attrWeight 0.8 (300): kept | 84.0 | 55.8 |

The keeper ranges widen around the same values at 75 (GKP-02's typical-keeper save-rate batch is unchanged); the
88-rated club's keeper (reflexes 96, diving 90) gets quicker and longer, the 62-rated club's (64 / 56) slower and
shorter; the equal pair's keepers have the same reflexes (77) and GLA's better diving (88 v 79) pulls it toward even.
A 4 / 22 range took the GKP-02 batch's typical keeper to 78.9% saves (band 65-78%) and 6 / 28 made a 20-rated keeper
too slow to parry GKP-02's unit-test shot: not taken.

### Constants (`src/contracts/tuning.ts` unless named)

| Constant | Was | Now |
|---|---|---|
| `T_CPU.carrierShotMinPowerShare` (new, TAI-08 rushed-shot gate) | - | 0.3 |
| `T_CPU.carrierDribbleTightAttackMul` (new, TAI-08) | (0) | 0.25 |
| `T_CPU.carrierDriveShotShare` | 0.7 | 0.35 |
| `T_LEVEL.patienceTicks` (new, TAI-11) | - | 90 at every level |
| `T_LEVEL.patienceStandoff` (new, TAI-11, m) | - | 1.5 / 1.3 / 1.1 / 0.9 / 0.9 / 0.9 |
| `T_LEVEL.shotThresholdXg` | 0.0018 / 0.002 / 0.0025 / 0.003 / 0.0035 / 0.004 | 0.0018 / 0.002 / 0.0025 / 0.003 / 0.008 / 0.03 (Legend 0.02 in the first pass, 0.03 on the resume) |
| `T_LEVEL.reactionTicks` | 80 / 42 / 18 / 11 / 6 / 1 | 100 / 36 / 18 / 11 / 6 / 1 (Amateur 36 on the resume) |
| `T_LEVEL.keeperReactTicks` | 45 / 30 / 10 / 0 / -3 / -8 | 45 / 30 / 10 / 0 / -3 / -12 (resume) |
| `T_GK.depthFar` (GKP-01, m) | 4.5 | 3.0 |
| `T_GK.reactBest` / `reactWorst` (ticks at reflexes 99 / 1) | 6 / 19 | 4 / 25 |
| `T_GK.diveSpeedBest` / `diveSpeedWorst` (m/s) | 7.0 / 4.6 | 7.3 / 3.7 |
| `T_GK.reachBest` / `reachWorst` (m) | 3.2 / 2.2 | 3.32 / 1.82 |
| `sim/keeper/saveKinematics` `dropBack` / `dropSlackTicks` / `trackSprint` (new, GKP-02) | - | 1 / 8 / 1 |
| `sim/defend/tackle` `baseChance` / `attrWeight` (SIM-14) | 0.5 / 0.55 | 0.7 / 0.8 |
| `T_CPU.defendStillTouchTicks` / `defendStillSpeed` (new, TAI-11 still carrier, resume; ticks, m/s) | - | 45 / 1.0 |
| `T_CPU.defendHeldSpeed` / `defendHeldTicks` (new, TAI-11 held carrier, skeptic pass; m/s, ticks) | - | 2.5 / 180 |

### Final measurement of the resume (superseded: the skeptic pass's held challenge changes Professional play; the final numbers are in the last section)

`tools/soak.ts --matches 500 --difficulty 3 --enforce all` (Professional): PASS; 500 finished, 0 exceptions / invariant
failures / watchdogs, determinism PASS (hash 5da3b690); goals 2.82 (QF-13: 3.55; target 2.6-3.2), shots 15.40
(19.02; target 15-22), dominant possession 56.73%, home possession 50.52%, pass completion 78.12%, fouls 13.47,
offsides 0.23, blow-outs 2.80%. The same 500 configs through the scratch runner (identical match for match): shots on
target 10.0 a match, keeper saves 68.0% of the non-penalty shots on target (2541 kept of 3738 saved or scored; BRIEF
section 6: 65-78%), penalties 0.38, corners 1.12. CPU carrier shots by distance (a match): 0-12 m 1.98 (59.8% scored),
12-16.5 m 1.14 (10.0%), 16.5-22 m 1.02 (6.1%), 22-28 m 1.20 (4.8%), 28-34 m 1.76 (2.8%), 34 m+ 3.69 (0.7%): 5.45 a
match from 28 m+ (about 9.5 before, half the shots; now 35%), still scoring about 1.4% (2 of 134 before): the volume
that went is the rushed taps, what is left are full-power strikes the keeper saves (34 m+: 54% on target, 824 saves in
500 matches). By priced xG at the kick: under 0.01 -> 1.5% scored, 0.04-0.07 -> 10%, 0.1-0.15 -> 45%, 0.25-0.4 -> 76%.

`tools/ladder.ts --matches 200`, seeds 1 and 2 (W / D / L; 400 a pair):

| Pair | Seed 1 | Seed 2 | Over 400 | Target 65% (aim 67%) |
|---|---|---|---|---|
| Amateur v Beginner | 142 / 27 / 31 = 71.0% | 125 / 40 / 35 = 62.5% | 66.75% | meets (aim 67: 0.25 short) |
| Semi-Pro v Amateur | 148 / 31 / 21 = 74.0% | 150 / 28 / 22 = 75.0% | 74.5% | meets |
| Professional v Semi-Pro | 137 / 41 / 22 = 68.5% | 150 / 31 / 19 = 75.0% | 71.75% | meets |
| World Class v Professional | 133 / 33 / 34 = 66.5% | 154 / 27 / 19 = 77.0% | 71.75% | meets |
| Legend v World Class | 143 / 42 / 15 = 71.5% | 141 / 33 / 26 = 70.5% | 71.0% | meets |

(The first pass's final tree, the same seeds: 69.5 / 76.0 / 70.75 / 69.0 / 66.75%. The screens above ran before the
still-carrier challenge was limited to a carrier in no action with a known last touch (a CPU clearance being charged
under pressure was challenged in `tai-08-carrier`'s scene); with it a handful of ladder matches below Professional
changed: Amateur v Beginner 67.0 -> 66.75%, the other pairs as screened. Professional matches are unchanged.)

`tools/balance.ts --matches 200`, seeds 1-4 (seed 1 all suites, seeds 2-4 `--suite top-bottom,equal`; Professional, so
the same on this tree):

| Matchup | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Over 800 | Target |
|---|---|---|---|---|---|---|
| top-bottom MOS (88) v ROO (62), wins | 162 / 29 / 9 = 81.0% | 160 / 30 / 10 = 80.0% | 164 / 26 / 10 = 82.0% | 159 / 27 / 14 = 79.5% | 80.6% | >= 80%: meets |
| equal SND (76) v GLA (75), points | 53.0% | 56.0% | 57.3% | 55.5% | 55.5% | 40-60%: meets |
| mirror GLA v GLA, home points | 42.3% | - | - | - | - | 40-60%: meets |

On the tree before the resume's fixes (the first pass's final tree): top-bottom 83.5% on seed 1, equal 53.5%, mirror
45.8%. The top-bottom margin over 800 is thin (0.6 points, a standard error of about 1.4): the lead may want a
balance lever with more margin before the 2,000-match campaign (the keeper ranges and SIM-14 attrWeight above are the
ones measured).

`tools/fuzz.ts --matches 60 --enforce all`: PASS (60 runs + 15 rematches, 59 finished, 0 exceptions / invariant
failures / watchdogs, determinism PASS).

### Skeptic pass (an independent QA+fix agent after the resume)

Verified on the resume's tree: the qf-14 tests pass (`npx vitest run tests/scenario/qf-14-*.test.ts`: 22 + 2 expected
fail), and each of the resume's fixes holds on nearby inputs: the standing-catch reach fix and the drop-back fix on the
resume's lob grid with a 40-rated 1.72 m and a 92-rated 1.96 m keeper at 3 / 4.5 / 5.5 m off his line (0 standing
catches set over his reach, 0 drop-target jumps), and a new grid of 7776 chips / lofted shots (9-20 m out, the keeper
3-7 m off his line, 2 m off centre either side, standing or rushing out at 4 m/s, aimed at both posts and the centre;
invariants `all`): 0 invariant failures, the keeper never behind his line inside the posts, 1 goal with no save action
(a ball out of reach). The still challenge was attacked with a human carrier walking, strafing, circling, nudging the
ball, backing away and standing with his back to the defender, at Professional, World Class and Legend (8 seeds each);
two defects (the `[skeptic]` rows above) and the open walking-across case (Escorts, above). A carrier standing with his
back to the defender (the ball on the far side of his body) is not challenged at any level: like a shielding carrier,
the ball is never presented (unchanged; the first pass's shielding test).

The held challenge reaches Professional bot matches (a carrier on the ball for 3 s, slow, the ball presented), so every
number below is from the tree with it. `T_CPU.defendHeldTicks` screened on the first 150 soak configs (goals / shots;
the resume's tree 2.77 / 15.22): 90 (the patience only) 2.47 / 14.71, 135 2.56 / 15.11, 180 2.63 / 14.79 (kept), 300
2.72 / 15.15; a carrier walking straight at a Legend defender is challenged after about 3 s at 180.

Observations for the lead (no change made): Beginner v Beginner takes 4.6 shots a match (the tree before QF-14: 10.5,
45 matches): within 25 m of goal the Beginner carrier's shot is refused as rushed (`carrierShotMinPowerShare`) about
twice as often as it is offered, because his 100-tick reaction delay lets the defence close in, so the quick-shot cut
always applies; and with `keeperReactTicks` Legend -12 a Legend keeper with gkReflexes 62 or more reacts at 0 ticks
(the delay is floored at 0), so reflexes above 62 make no difference at Legend (-8: above 80).

### Final measurement (this tree)

`tools/soak.ts --matches 500 --difficulty 3 --enforce all --workers 3` (Professional): PASS; 500 finished, 0
exceptions / invariant failures / watchdogs, determinism PASS (hash f8c9489f); goals 2.65 (QF-13: 3.55; target
2.6-3.2), shots 15.31 (19.02; target 15-22), dominant possession 56.69%, home possession 50.60%, pass completion
78.39%, fouls 13.38, offsides 0.22, blow-outs 2.00%. The same 500 configs through the scratch runner (identical match
for match): shots on target 9.92 a match, keeper saves 68.9% of the non-penalty shots on target (2526 kept of 3667
saved or scored; BRIEF section 6: 65-78%), penalties 0.33, corners 1.12, tackles 35.3 (9.5 won). CPU carrier shots by
distance (a match): 0-12 m 1.87 (59.1% scored), 12-16.5 m 1.09 (8.4%), 16.5-22 m 1.05 (6.3%), 22-28 m 1.25 (4.8%),
28-34 m 1.78 (2.6%), 34 m+ 3.64 (0.8%): 5.42 a match from 28 m+ (about 9.5 before QF-14), scoring 1.4%. By priced xG
at the kick: under 0.01 -> 1.5% scored, 0.04-0.07 -> 8.9%, 0.1-0.15 -> 42.8%, 0.25-0.4 -> 73.6%.

`tools/ladder.ts --matches 200 --workers 3`, seeds 1 and 2 (W / D / L; 400 a pair):

| Pair | Seed 1 | Seed 2 | Over 400 | Target 65% (aim 67%) |
|---|---|---|---|---|
| Amateur v Beginner | 142 / 30 / 28 = 71.0% | 125 / 40 / 35 = 62.5% | 66.75% | meets (aim: 0.25 short) |
| Semi-Pro v Amateur | 146 / 33 / 21 = 73.0% | 152 / 30 / 18 = 76.0% | 74.5% | meets |
| Professional v Semi-Pro | 142 / 35 / 23 = 71.0% | 141 / 40 / 19 = 70.5% | 70.75% | meets |
| World Class v Professional | 138 / 37 / 25 = 69.0% | 137 / 39 / 24 = 68.5% | 68.75% | meets |
| Legend v World Class | 139 / 41 / 20 = 69.5% | 140 / 41 / 19 = 70.0% | 69.75% | meets |

(Seed 2's Amateur v Beginner leg is match for match the resume's: no carrier is held 3 s there.)

`tools/balance.ts --matches 200 --workers 3`, seeds 1-4 (seed 1 all suites, seeds 2-4 `--suite top-bottom,equal`):

| Matchup | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Over 800 | Target |
|---|---|---|---|---|---|---|
| top-bottom MOS (88) v ROO (62), wins | 164 / 21 / 15 = 82.0% | 160 / 28 / 12 = 80.0% | 159 / 30 / 11 = 79.5% | 165 / 26 / 9 = 82.5% | 81.0% | >= 80%: meets |
| equal SND (76) v GLA (75), points | 58.0% | 61.3% | 57.5% | 52.0% | 57.2% | 40-60%: meets (seed 2 alone over) |
| mirror GLA v GLA, home points | 42.5% | - | - | - | - | 40-60%: meets |

`tools/fuzz.ts --matches 60 --enforce all --workers 3`: PASS (60 runs + 15 rematches, 59 finished, 0 exceptions /
invariant failures / watchdogs, determinism PASS, hash 8001b817).

## QF-16 (Wave 4 round 5: CPU defending against a human dribbler, low-level shooting, keeper reflexes at Legend)

Three attempts (the first two stopped by account usage limits; their partial work is in b26cdba and c4abab9). Measured
with scripted human carriers (`tests/scenario/qf-16-helpers.ts`: the QF-14 escort / still / held scenes, a human
carrier with the ball at his feet 3 m in front of one CPU defender, everybody else behind the play, 10 s, seeds 1-8;
the carrier starts 33-40 m from goal, or 9.5-16.5 m out for the "box" rows) and a scratch screen runner over
`tools/headless.ts` (the soak / ladder / balance configs match for match; "npSave" = saves / (saves + goals) of
non-penalty shots on target). Every change below changes sim behaviour (state hashes).

The second attempt reviewed the first's edits: its patient block (a guard point in the ball's path, reached round the
carrier's body, the ground held) was kept in reworked form; its blend of the hold direction, its poke prediction (the
tackler's sideways speed carried through a wind-up that plants him) and its block of every carrier up to 6 m/s (escorts
0.50 -> 0.03 a match but fouls 12.3 -> 15.6, penalties 0.42 -> 0.83, Legend v World Class 67 -> 51%) were not.

### Third attempt: review of the second (c4abab9)

Each fix was switched off on a copy of the tree and its test run (`tests/scenario/qf-16-*`, `tests/sim/qf-16-*`,
`tests/unit/qf-16-*`). Kept (each test fails without it): the block (`blockTicks`), its retreat table, the rash-lunge
guard (no lunge at a shielder or at a ball his body hides), SIM-05 `shieldDriveSpeed`, the per-level shot gate, the
Legend keeper scale, and `lungePresented` for the block's poke (with `ballPresented` instead: 47 -> 70 fouls on the
diagonal walkers, fewer balls won). Removed (no test failed without them, and the scenes moved by no more than a foul or
two): `lungePresented` added to the careful tackle, `steadyDribble` (the poke and held challenge; once the poke wanted
the ball first by a margin, below, it changed nothing) and the block's separate hold against a shielding carrier (SIM-05
`shieldDriveSpeed` carries it: 5.3 m in 10 s without it, 4.0 m with it, 10.8 m before either).

The scene set was widened (stick (80, +-40) and (70, 70) jogs, a (25, +-25) zig-zag walk every 20 ticks, walk-and-stop,
the box rows) and found three defects the second attempt's table did not show:
- a human jogging diagonally past the defender (stick (80, 40), 3.9 m/s: faster than `defendBlockWalkSpeed`) kept the
  ball 8 of 8 at every level, 33 m in 10 s: the QF-14 alongside escort (defender pinned at a cosine of 0.30 to the goal
  side, in body contact, ball on the far side of the carrier). On the QF-14 tree he kept it 3-4 of 8 below Legend only
  because rash lunges through his body (7-9 fouls in 8 scenes) ended the run; Legend 8 of 8.
- the walking block's open box case (second attempt, "Remaining"): inside the area, a walker at a Professional / World
  Class / Legend defender kept the ball 5-8 of 8 and walked him back ~10 m into the six-yard box. Traced: the defender
  square in front (cosine 1, 0.75 m, hold on), the walker pushing him back at ~1 m/s (SIM-05 split the overlap by mass;
  the normal damping handed him the walker's speed every tick), the ball 0.03-0.3 m from the defender's centre (under his
  feet) and still the walker's (SIM-06 lets an opponent steal only out of the owner's 0.9 m reach); box care rightly
  holds back every challenge in body contact there (a lost front poke at that ball is a foul about half the time).
- the zig-zag walk kept the ball 6 of 8 at Legend (9.3 m; QF-14 tree 0 of 8): the same push-back in the open field.

### Scripted carriers, kept / gained / won / fouls (8 scenes of 10 s; L0 Beginner ... L5 Legend)

"Won" counts a team-1 tackle won, steal or block (the before columns: tackles only). Final = this tree.

| Script (stick) | QF-14 tree L3 / L4 / L5 | Final L3 / L4 / L5 | Final L0 |
|---|---|---|---|
| straight (35, 0) | 0/3.3/8/2, 0/3.3/7/3, 0/3.7/6/6 | 0/2.8/10/0, 0/2.8/10/0, 0/3.0/13/2 | 0/2.4/8/0 |
| straight (65, 0) | 0/8.1/6/7, 0/7.6/7/5, 1/9.0/7/1 | 0/4.7/7/2, 0/4.3/8/1, 0/4.5/8/0 | 0/6.1/9/0 |
| jog (100, 0) | 0/10.5/7/2, 0/11.1/7/4, 0/10.8/8/2 | 0/9.7/11/0, 0/8.8/11/1, 0/12.2/12/0 | 1/17.1/9/1 |
| diagonal (30, 15) | 6/11.7/2/7, 7/11.8/1/5, 6/11.7/2/0 | 0/4.1/9/0, 0/3.4/8/1, 0/3.2/8/0 | 1/8.5/9/1 |
| diagonal (30, -15) | 7/11.5/0/8, 6/11.4/1/5, 6/10.8/2/1 | 0/4.4/8/2, 0/3.6/9/1, 0/3.1/8/0 | 1/8.1/8/3 |
| diagonal (45, 30) | 7/18.0/0/9, 7/18.0/0/8, 8/19.2/0/0 | 0/7.5/12/4, 0/6.1/10/6, 0/5.1/9/0 | 1/14.5/11/6 |
| across (15, 35) | 8/6.6/0/8, 8/6.6/0/6, 8/6.6/0/0 | 0/2.6/9/2, 0/2.1/9/2, 0/1.6/8/0 | 2/5.2/7/4 |
| jog diagonal (80, 40) [new] | 3/25.2/0/8, 3/25.8/0/7, 8/33.5/0/0 (second attempt: 8/33.5/0/0 at every level) | 0/17.1/15/0, 0/12.6/12/1, 0/13.3/15/3 | 0/23.6/8/2 |
| jog diagonal (80, -40) [new] | 4/27.4/0/8, 4/27.5/0/9, 8/33.6/0/0 (second: 8/33.6/0/0) | 0/16.4/13/2, 0/15.1/13/3, 0/14.5/13/3 | 0/22.6/6/3 |
| jog diagonal (70, 70) [new] | 8/29.4/0/4, 8/29.4/0/3, 8/29.4/0/0 (second: 8/29.4/0/0) | 3/18.6/8/2, 0/10.5/8/0, 0/9.9/9/1 | 7/28.7/1/3 |
| strafe (0, +-50 each 1 s) | 4/0.4/1/10, 6/0.3/1/7, 6/0.5/0/1 | 5/0.2/3/1, 0/0.2/8/0, 0/0.2/8/0 | 7/0.2/0/3 |
| zig-zag (30, +-50 each 0.75 s) | 0/5.5/6/8, 0/5.2/7/5, 0/4.9/7/3 | 0/6.1/11/3, 0/4.5/14/1, 0/3.5/8/0 | 5/13.5/1/10 |
| zig-zag walk (25, +-25 each 1/3 s) [new] | 0/2.6/7/3, 0/2.6/7/4, 0/2.9/8/3 (second: 1/4.1/7/5, 1/3.9/7/3, 6/9.3/2/0) | 1/3.2/7/3, 0/2.3/8/1, 1/3.4/9/2 | 1/5.8/10/8 |
| back to goal, SHIELD + (30, 0) | 8/10.8/0/6, 8/10.8/0/5, 8/10.8/0/0 | 5/5.2/3/0, 6/5.3/2/0, 6/5.3/2/0 | 8/11.2/0/0 |
| SHIELD + strafe | 8/0.2/0/5, 8/0.2/0/4, 8/0.3/0/0 | 7/0.3/1/0, 8/0.3/0/0, 8/0.3/0/0 | 8/0.5/0/0 |

Box (carrier 9.5-16.5 m from the goal line; kept / gained / won / fouls / penalties):

| Script | Second attempt (c4abab9) L3 / L4 / L5 | Final L3 / L4 / L5 | Final L0 |
|---|---|---|---|
| straight (35, 0) | 5/10.2/1/0/0, 7/9.9/0/0/0, 7/9.7/0/0/0 | 0/3.7/8/0/0, 0/3.4/8/0/0, 0/3.1/8/0/0 | 0/2.7/7/1/1 |
| straight (50, 0) | 2/8.1/5/1/1, 5/11.0/0/0/0, 5/11.0/0/0/0 | 0/4.9/9/0/0, 0/4.8/8/0/0, 0/4.4/8/0/0 | 0/4.4/7/1/1 |
| diagonal (30, +-15) | 5-6/10.3-10.6, 5-8/9.6-10.1, 6-8/9.0-9.6 (0-1 fouls) | 0/4.3-4.6/8/0/0, 0/3.6-3.8/8/0/0, 0/3.1-3.2/8/0/0 | 0-1/7.1-8.7, 2 pens |
| diagonal (45, 30) | 0/12.7/0/0/0, 2/12.1/0/0/0, 3/11.4/0/0/0 | 0/8.4/5/0/0, 0/6.5/7/0/0, 0/5.0/8/0/0 | 0/12.7/0/0/0 |
| across (15, 35) | 7/5.9/0/1/1, 8/6.3/0/0/0, 8/6.1/0/0/0 | 5/5.0/2/1/1, 4/4.2/4/0/0, 3/3.4/5/0/0 | 8/6.4/0/0/0 |
| zig-zag walk / walk-and-stop | 8/9.4 and 8/5.3, 8/8.2 and 8/5.4, 8/6.5 and 8/5.8 | 0/2.5-2.8/8/0/0, 0-2/2.6-4.1/6-8/0/0, 0/2.4-2.7/8/0/0 | 1/3.7-4.2, 5 pens |

A human can no longer walk or jog past a World Class / Legend defender, nor walk one back through his own area; against
Professional a 45-degree jog toward the touchline keeps the ball 3 of 8; the lower levels are beaten more (Beginner:
diagonals 8-15 m, jogs 23-29 m, the zig-zag kept 5 of 8, a shielder backing in 11 m; in the box Beginner to Semi-Pro
give penalties, 1-5 in 8 scenes, from their rash lunges). The sideways walk across the box (15, 35) keeps the ball 3-5
of 8 at the top levels for 3-5 m: he goes along the box, not past the man.

### Defects fixed (each with a regression test that fails without its fix)

| Defect | Measured before | Fix | After / test |
|---|---|---|---|
| Human walks diagonally / across a CPU defender and keeps the ball (TAI-11; QF-14 'Escorts: what remains') | table above: 6-8 of 8 kept, 11-19 m, Professional to Legend | the block (`blockPlan`, `T_CPU.defendBlock*`): once a walking carrier (slower than `defendBlockWalkSpeed` 3 m/s) has had the ball `T_LEVEL.blockTicks` (300 / 260 / 220 / 180 / 150 / 120), the controlled defender's guard point is `defendBlockDist` 0.9 m beyond the ball on the carrier -> ball line (at most acos(`defendBlockPathCos` 0.7) off the goal direction), reached round the carrier's body (`defendBlockRound*`), tracked with the carrier's velocity plus `defendBlockGain`; in the ball's or the carrier's line he holds his ground (gives up only `T_LEVEL.blockRetreat` 1 / 0.8 / 0.6 / 0.3 / 0.15 / 0 of the carrier's speed toward goal); he pokes at a ball within `defendBlockPokeDist` presented ball-first from where SIM-14's wind-up and lunge take him (`lungePresented`) | 0 of 8, 2-8 m; `qf-16-escort-block` |
| Block poke met a turning carrier body-first (TAI-11) [third attempt] | the poke's ball-first test had no margin: a carrier changing direction inside the 5-tick wind-up was met body-first: Professional fouled a strafer 5 times in 8 scenes (2 balls won); 34 fouls in the 96 diagonal / across scenes at the top levels | `T_CPU.defendBlockPokeMargin` 0.1 m | strafer 1 foul over the three top levels, 18 fouls in those 96 scenes, carriers still kept 0 of 8; `qf-16-escort-block`, `qf-16-shield-level` |
| Human jogs diagonally past a CPU defender (TAI-11, the QF-14 alongside escort at a human's hands) [third attempt] | 8 of 8 kept at every level, 33 m in 10 s | a human-controlled carrier is blocked up to `T_CPU.defendBlockJogSpeed` 5.5 m/s (a bot dribbler is not: blocking the bot carriers' 3-6 m/s dribbles took the top levels' attacking edge, Legend v World Class 67 -> 51%) | World Class / Legend 0 of 8, 10-15 m (8 of them before the block's time); Professional 0-3 of 8; `qf-16-escort-block` |
| A walker pushes a defender standing his ground back (SIM-05) [third attempt] | the overlap split by mass: a walker at 1-1.5 m/s walked a top-level defender back ~1 m/s (10 m in the box scenes); a velocity test never saw the defender "standing" (the normal damping hands him the pusher's speed) | brace: a walking ball carrier (intended speed below `braceMaxSpeed` 3 m/s) driving into an opponent (faster than `braceDriveSpeed` 0.3 m/s along the normal) who stands his ground (on his feet, his intent giving way slower than `braceGiveSpeed` 0.5 m/s) is the one held off; intents from SIM-04's movement intent; a running dribbler's barge stays a body duel (bracing every carrier cut 1.6 shots a match from the bot game); only in a pair with a human-controlled player (the human walker, or a human defender a CPU walker runs into), see the ladder below | `qf-16-brace`; with the next row, `qf-16-box-walker` |
| A ball under an opponent's feet stays the dribbler's (SIM-06; glitch list "Ball stuck: between two players") [third attempt] | an opponent could steal only out of the owner's 0.9 m reach: the walker kept a ball lying 0.03-0.3 m from the defender's centre for seconds | while the owner walks (slower than `underMaxSpeed` 3 m/s), a ball within `underRadius` 0.3 m of the nearest eligible opponent and nearer him than the owner by `underMargin` 0.2 m is his to steal (or block) as between touches; a shielder's `shieldBlocks` still keeps the challenger off; a running dribble keeps its touches (stealing under every dribbler cut 1.6 shots a match); only when the owner or that opponent is human-controlled | box walkers at Professional to Legend kept 0 of 8, 3-5 m, no penalty (before 5-8 of 8, ~10 m); `qf-16-under-feet`, `qf-16-box-walker`, the zig-zag walk in `qf-16-escort-block` |
| Rash lunge hacks a shielding / strafing carrier (TAI-11) | a carrier shielding in front of a defender for 10 s was fouled 2-7 times in 8 scenes at Beginner to World Class with no ball won; a strafer 10 / 7 times at Professional / World Class | no rash lunge at a shielding carrier, nor at a ball the carrier's body hides from the defender (not ball-first now); the low levels keep their rash lunges at a presented ball | 0 fouls on a shielder at every level; `qf-16-shield-level` |
| A shielder walks a standing defender back (SIM-05) | the shield hold gave the shielder the priority in the body contact even when he backed into the challenger: a standing defender was pushed 2.6 m in 2 s; every CPU level was walked back about 11 m in 10 s | `shieldDriveSpeed` 0.3 m/s: a shielder backing into a held-off challenger faster than that is the one held off (standing, he still holds the challenger off the ball) | 0.1-0.2 m in 2 s; `qf-16-shield-push`; 5.2-5.3 m in 10 s from Professional up (`qf-16-shield-level`) |
| Low levels hardly shoot (TAI-08 rushed-shot gate) | Beginner v Beginner 5.2 shots a match (40 matches; the brief's 4.6), save rate 24%: the gate refused most of their shots | `T_LEVEL.shotRushedGateMul` 0 / 0.3 / 0.6 / 1 / 1 / 1 on `carrierShotMinPowerShare`: the low levels shoot, badly | Beginner v Beginner: final section; Professional unchanged; `qf-16-shot-gate` |
| gkReflexes makes no difference at Legend (GKP-02 / BRIEF section 15) | `keeperReactTicks` Legend -12 floored the delay at 0 for gkReflexes 62+ (all but a handful of club keepers) | `T_LEVEL.keeperReactScale` (new) scales the attribute delay before the level's ticks: Legend 0.25 (ticks 0): 4-25 ticks -> 1-6, every reflex step counts; [third attempt] World Class 0.45 (ticks -3 -> 0; 4-25 -> 2-11, a 77-rated keeper 6 -> 4 ticks) for the ladder's World Class v Professional (below), never floored, never quicker than Legend | `qf-16-keeper-reflexes` (62 > 80 > 99 > 0 ticks at Legend; monotone at every level; Legend <= World Class) |

Tests refreshed for the behaviour change: `qf-2-keeper-level` (the formula with the scale), `qf-14-held-carrier`
(balls won now count a steal or block off the defender's feet, which emits no TACKLE; the strafer's fouls <= balls won,
<= 4), `qf-13-sk-box-tackle`'s Legend sample floor (78 shots in its 8 matches, 2 penalties; floor 80 -> 70).

### Bot matches: what the block must not do (second attempt; first 60 soak configs, Professional)

The QF-14 tree: goals 2.85, shots 14.4, npSave 68.8%, fouls 12.3, penalties 0.42, escorts of 5 s+ 0.50 a match.

| Variant | Goals | Shots | npSave | Fouls | Pens | Escorts | Legend v WC (100) | WC v Pro (100) |
|---|---|---|---|---|---|---|---|---|
| first attempt's block (all carriers to 6 m/s from 1.5 s) | 2.68 | 14.9 | - | 15.6 | 0.83 | 0.03 | - | - |
| block every carrier to 6 m/s, level times (180 at Professional) | 2.47-2.82 | 14.6-15.0 | 64-68 | 9.9 | 0.40-0.45 | 0.30 | 51 | - |
| ... walking carriers from the level time, dribblers after 5 s | 3.27 | 14.4 | - | 9.8 | 0.62 | 0.45 | 66 | - |
| ... dribblers only in our last 35 m (Professional 7 s) | 3.25 | 14.7 | 64.6 | 10.3 | 0.57 | 0.65 | 70 | 67 |
| walking carriers only (kept) | 2.87 | 15.2 | 68.5 | 9.1 | 0.30 | 1.12 | 74 | 77 (no block) |

Third attempt, the SIM-05 / SIM-06 rules on the second attempt's tree (same 60 configs: goals / shots / npSave / fouls /
escorts): second attempt 2.87 / 15.15 / 68.5 / 9.07 / 1.12; brace + under-the-feet for every carrier 2.22 / 12.20 /
71.0 / 9.55 / 0.85; under-the-feet only 2.60 / 13.37 / 64.9 / 8.83 / 1.12; brace only 2.43 / 13.60 / 70.7 / 10.27 /
0.37; both for walking carriers only 2.83 / 15.52 / 68.2 / 8.62 / 1.45. The bot game is built on dribblers running
into contact. Walking-only looked neutral at Professional, but the first final ladder on that tree (seed 1, 200 a pair)
failed the top pairs: Amateur v Beginner 70.5, Semi-Pro v Amateur 72.5, Professional v Semi-Pro 68.0, World Class v
Professional 64.5, Legend v World Class 58.5% (QF-14 seed 1: 69.0 / 69.5). Bisected with the scratch runner (the
ladder's seed-1 configs, 100 a pair, Legend v World Class / World Class v Professional): second attempt's tree 74 / 68;
+ brace and under-the-feet for walking carriers 63 / 68 (Legend's goals 2.38 -> 1.56: its patient, slow carries walk
into set defenders and lose the ball, which the CPU carrier was never built to avoid); this attempt's tree 58 / 65; the
same with the old Legend keeper (scale 1, -12) 56 / 65, with rash lunges at a hidden ball restored 54 / 63 (neither is
the cause). Kept: both rules only in a pair with a human-controlled player, 69 / 72, the box walkers still all stopped
(bot-v-bot contact and possession as before; a human defender standing his ground holds off a CPU walker too). The
ladder on that tree (seed 1, 200 a pair): 70.0 / 70.5 / 74.5 / 63.5 / 70.0%. World Class v Professional, screened on
the same 200 configs: World Class `keeperReactTicks` -3 -> -6 gave 78.0% (Legend v World Class 71.5%), but an additive
-6 floors World Class keepers with gkReflexes 90+ at 0 (the item-3 defect) and makes them quicker than Legend's at 99;
taken as a scale instead, World Class `keeperReactScale` 0.45 with 0 ticks (a 77-rated keeper 6 -> 4 ticks; -6: 3).

Bot escorts of 5 s+ (a CPU dribbler escorted with no tackle) rose from QF-14's 0.50 to 1.1-1.5 a match: the rash lunges
through the carrier's body that ended them were fouls with no chance of the ball (fouls 12.3 -> ~9, inside the 6-16
band). Against a human carrier the block now ends them at a walk and a jog; against a bot dribbler the QF-14 patience
guard stays (every bot-dribbler variant above cost the ladder's top pair or goals). Open for the lead: a fair way to end
bot-v-bot escorts without the ladder cost (QF-14's shoulder variants: Legend v World Class 51-61%).

The low levels keep their rash lunges at a presented ball; keeping them at a hidden ball too at Beginner / Amateur
(Semi-Pro half) measured worse on the ladder (seed 2, 200 a pair: Amateur v Beginner 66.0 v 71.5%, Semi-Pro v Amateur
70.5 v 73.5%, Professional v Semi-Pro 67.0 v 72.5% without them) and is not kept.

### Constants (`src/contracts/tuning.ts` unless named)

| Constant | Was | Now |
|---|---|---|
| `T_CPU.defendBlockWalkSpeed` / `defendBlockDist` / `defendBlockGain` (new, TAI-11 block; m/s, m, 1/s) | - | 3.0 / 0.9 / 2.5 |
| `T_CPU.defendBlockJogSpeed` (new, third attempt; human carriers, m/s) | - | 5.5; skeptic 6.0 |
| `T_CPU.defendBlockPathMinOffset` / `defendBlockPathCos` (new) | - | 0.25 m / 0.7 |
| `T_CPU.defendBlockRoundAhead` / `RoundSpan` / `RoundGap` (new, m) | - | 0.6 / 0.4 / 0.15 |
| `T_CPU.defendBlockAlign` / `HoldSpan` / `AlignBody` (new, m) | - | 0.6 / 0.3 / 0.9 |
| `T_CPU.defendBlockPokeDist` / `PokeMaxRound` / `PokeMargin` (new; margin third attempt) | - | 0.8 m / 0.25 / 0.1 m |
| `T_CPU.defendBlockShieldCos0` (second attempt, removed by the third, restored for human shielders by the skeptic) / `defendBlockFeetDist` (new, skeptic) | - | 0.5 / 0.4 m |
| `T_LEVEL.blockTicks` / `blockRetreat` (new) | - | 300 / 260 / 220 / 180 / 150 / 120; 1 / 0.8 / 0.6 / 0.3 / 0.15 / 0 |
| `T_LEVEL.shotRushedGateMul` (new, TAI-08) | (1) | 0 / 0.3 / 0.6 / 1 / 1 / 1 |
| `T_LEVEL.keeperReactTicks` / `keeperReactScale` (new) | 45 / 30 / 10 / 0 / -3 / -12; (1) | 45 / 30 / 10 / 0 / 0 / 0; 1 / 1 / 1 / 1 / 0.45 / 0.25 (World Class third attempt) |
| `sim/players/bodies` `shieldDriveSpeed` (new, SIM-05, m/s) | - | 0.3 |
| `sim/players/bodies` `braceDriveSpeed` / `braceGiveSpeed` / `braceMaxSpeed` (new, third attempt, m/s) | - | 0.3 / 0.5 / 3.0 |
| `sim/players/possession` `underRadius` / `underMargin` / `underMaxSpeed` (new, third attempt; m, m, m/s) | - | 0.3 / 0.2 / 3.0; skeptic `underMaxSpeed` 6.0 |
| removed: first attempt `T_CPU.defendBlockOn`, `defendBlockMaxSpeed`, `defendBlockPathCos0`; second attempt `defendSteadyMinSpeed` / `FaceCos` / `BallCos` / `RelSpeed` | | |

### Final measurement (this tree)

`tools/ladder.ts --matches 200 --workers 2`, seeds 1 and 2 (W / D / L; 400 a pair):

| Pair | Seed 1 | Seed 2 | Over 400 | Target 65% |
|---|---|---|---|---|
| Amateur v Beginner | 140 / 32 / 28 = 70.0% | 146 / 35 / 19 = 73.0% | 71.5% | meets |
| Semi-Pro v Amateur | 141 / 39 / 20 = 70.5% | 151 / 29 / 20 = 75.5% | 73.0% | meets |
| Professional v Semi-Pro | 149 / 30 / 21 = 74.5% | 134 / 34 / 32 = 67.0% | 70.75% | meets |
| World Class v Professional | 140 / 37 / 23 = 70.0% | 147 / 34 / 19 = 73.5% | 71.75% | meets |
| Legend v World Class | 131 / 35 / 34 = 65.5% | 145 / 36 / 19 = 72.5% | 69.0% | meets |

(QF-14's final: 66.75 / 74.5 / 70.75 / 68.75 / 69.75%.)

`tools/soak.ts --matches 500 --difficulty 3 --enforce all --workers 2` (Professional): PASS; 500 finished, 0 exceptions /
invariant failures / watchdogs, determinism PASS (hash 961d739b); goals 2.96 (QF-14: 2.65; band 2-3.6), shots 14.95
(15.31; band 14-26), dominant possession 56.87%, home possession 50.00%, pass completion 78.56%, fouls 9.68 (13.38: the
rash lunges through a carrier's body are gone; band 6-16), offsides 0.18, blow-outs 1.60%. The first 200 configs through
the scratch runner: keeper saves 67.0% of the non-penalty shots on target (BRIEF section 6: 65-78%), shots on target 9.89,
penalties 0.32, bot escorts of 5 s+ 1.16 a match (longest 21.7 s; QF-14 0.50, see "Bot matches").

`tools/balance.ts --matches 200 --workers 2`, seeds 1-4 (seed 1 all suites, seeds 2-4 `--suite top-bottom,equal`):

| Matchup | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Over 800 | Target |
|---|---|---|---|---|---|---|
| top-bottom MOS (88) v ROO (62), wins | 170 / 23 / 7 = 85.0% | 160 / 33 / 7 = 80.0% | 173 / 22 / 5 = 86.5% | 164 / 29 / 7 = 82.0% | 83.4% | >= 80%: meets |
| equal SND (76) v GLA (75), points | 53.0% | 60.3% | 66.5% | 56.3% | 59.0% | 40-60%: meets (thin; QF-14 57.2%, seeds 2-3 over alone) |
| mirror GLA v GLA, home points | 47.5% | - | - | - | - | 40-60%: meets |

`tools/fuzz.ts --matches 60 --enforce all --workers 2`: PASS (60 runs + 15 rematches, 59 finished, 0 exceptions /
invariant failures / watchdogs, determinism PASS, hash f2dad3d5).

Beginner v Beginner (the soak's first 60 configs at Beginner, scratch runner): 8.67 shots a match (4.6 with the full
gate), goals 1.75, keeper saves 55.7% of the non-penalty shots on target; Professional plays the full gate (unchanged).

Tests: `tests/scenario/qf-16-*.test.ts`, `tests/sim/qf-16-*.test.ts`, `tests/unit/qf-16-*.test.ts` (each fix's test fails
with the fix switched off, checked on a copy of the tree), the refreshed QF-2 / QF-13 / QF-14 tests and the sim / AI area
set (159 files). `tests/perf/tai-08-budget`'s source-allocation check sat at its limit (206-311 B against 200 under load,
on the second attempt's tree too) since the per-level shot gate added a `levelValue` call (a boxed double) to the shot
evaluation; the gate is now read from a typed table indexed by `teamLevel` (same values, no hash change): 3 of 3 runs
pass. `tests/unit/qf-12-session-fuzz` (app area) is timer-dependent: with the second attempt's sim it failed 1 of 2 runs,
with this tree it passed 3 of 3 alone (see the report).

## QF-16 skeptic (Wave 4 round 5, independent second pass)

An independent QA+fix agent re-ran every QF-16 regression test (all pass) and attacked the third attempt's fixes with
inputs it had not used: full-stick jogs (stick magnitude 127, no sprint: what a touch stick gives), other attributes
(a quick carrier, top speed 9.6, against a slow defender, 7.2), shielding forward (L2 facing the defender), the strafe
dribble (MOD_L), sprints and controlled sprints, jog-then-burst timings, the defender starting alongside or behind, the
touchline, box jogs, and a human defender chasing a CPU carrier. Scratch runner: the `qf-16-helpers` scene (8 seeds of
10 s, kept / gained / won / fouls) plus "run to a line" (out of play with no team-1 touch) and the progress toward the
goal centre.

Every fix below applies against a human-controlled carrier only (or, for SIM-06, in a pair with a human), so the bot game
is bit-identical: three soak configs and a ladder config give the same state hashes with and without them, so the third
attempt's ladder / balance / soak measurements stand. `tools/fuzz.ts --matches 60 --enforce all`: PASS (hash f2dad3d5).

### Defects fixed (each test fails with its fix switched off; checked on the tree)

| Defect | Measured before | Fix | After / test |
|---|---|---|---|
| Full-stick diagonal jog keeps the ball (TAI-11): the blocking defender jockeyed (facing the carrier), and SIM-04 caps a sprint jockey moving sideways at 0.55 x top (5.1 m/s), slower than a 5.5 m/s jog, so he ran alongside and never got across | stick (113, +-57): kept or run to the byline 13 / 8 / 6 of 16 at Professional / World Class / Legend, 17-46 m; on the QF-14 tree the same at Legend | blocking a jogging human (faster than `defendBlockWalkSpeed`) he drops the jockey (runs) when the hold needs more than a sprint jockey's speed | 0 of 16 at each, 6-24 m; `qf-16-sk-full-jog` |
| Ball stuck between two players at a jog (SIM-06): once across, the defender was pushed along in front of the jogger at 4-5 m/s for 4 s, the ball 0.2-0.3 m from his centre, and the under-the-feet steal stopped at an owner faster than 3 m/s | (with the row above) Legend 3 of 16, Professional 6 | `underMaxSpeed` 3 -> 6 m/s (above every jog, 9.6 x 0.6 = 5.76; human pairs only, as before) | `qf-16-sk-full-jog`; `qf-16-under-feet` 'glitch: ball stuck between two players — a human jogging the ball into a defender ...' |
| A quick human is never blocked (TAI-11): `defendBlockJogSpeed` 5.5 sat below a quick player's jog (5.76 m/s); and against a slow defender the jockey cap (0.55 x 7.2 = 4.0 m/s) let even the third attempt's own (80, 40) jog through | top speed 9.6 v 7.2: 10 / 14 of 24 diagonal jogs not stopped at World Class / Legend (the (80, 40) jog kept 5-7 of 8, 25-31 m) | `defendBlockJogSpeed` 5.5 -> 6.0 (and the jockey row above) | 0 of 24; `qf-16-sk-quick-carrier` |
| A shielder walks the defender back (TAI-11): the third attempt removed the block's hold against a shielding carrier (no test failed without it), but the patience guard point (0.9 m goal-side of the carrier) walked the defender back at the shielder's pace, so SIM-05's hold never came into play | shielding forward / diagonally: kept 7-8 of 8, 8.1-8.4 m in 10 s at Professional, World Class and Legend alike (second attempt: 3.2-5.5 m); from the edge of the area, about 10 m to the goal line | the second attempt's hold restored for a human shielder: the guard point as before, the ground held from `defendBlockShieldCos0` 0.5 to the goal side (no challenge: the ball is behind the man) | 3.2-5.4 m, Legend least; 0 fouls; in the area he slides along the defender, no nearer the goal; `qf-16-sk-shield-walk` |
| Careful tackle through a blocked strafer's body (TAI-11): since the jog block a human strafing across (MOD_L, 3 m/s, the ball on his far side) is blocked, and the careful tackle on his touches had no ball-first test (the third attempt removed it) | 6 / 7 fouls in 8 scenes at World Class / Legend, 1 ball won (QF-14 and second-attempt trees: 0-2) | blocking a human, a careful tackle wants the ball first from where the lunge takes him (`lungePresented`, `defendBlockPokeMargin`) | 2 / 1 fouls, 6 / 8 balls won; `qf-16-sk-strafer-fouls` |
| Poke pressed at a ball already at the defender's feet (TAI-11 / SIM-14): a lunge from body contact that loses its roll is a foul, and the tackle pre-empts SIM-06's steal (a tackler is not eligible) | MOD_L strafing diagonally into a Legend defender: 5 fouls in 8 scenes, the ball 0.27 m from his centre at the press; straight walk 2, zig-zag 2, (80, 40) jog 3 | no poke at a human's ball nearer than `T_CPU.defendBlockFeetDist` 0.4 m (SIM-06's `underRadius` 0.3 m gives it to him) | 0 fouls in those scenes, balls still won; `qf-16-sk-strafer-fouls` |
| Rash tackle through a strafer's body at the low levels (TAI-11): the rash tackle on an exposure had no hidden-ball test (the rash lunge has had one since the second attempt) | a human strafing across a Semi-Pro / Amateur defender: 9 / 3 fouls in 8 scenes, no ball won (QF-14 tree: 7 / 2) | a rash tackle at a human carrier wants the ball not hidden behind his body (`ballHidden`, the body test of `ballFirstAt` at any range) | 0 / 0; the low levels still win walkers' balls (rash lunges at a presented ball stay); `qf-16-sk-strafer-fouls` |

Tests refreshed: `qf-16-under-feet` (the running dribbler is now a sprinting one, 7 m/s; tuning bounds),
`qf-14-escort` (balls won count SIM-06's steals and blocks, which emit no TACKLE, as `qf-14-held-carrier` already does),
`qf-16-helpers` (scripts `diagJogFull(M)`, `shieldFwd`, `shieldDiag(M)`, `strafeDiag`, `strafeAcross`; an `out` tally;
a `prep` hook for attributes).

### Scripted carriers after the skeptic pass (kept / gained m / won / fouls; L3 / L4 / L5)

| Script | Third attempt | Skeptic |
|---|---|---|
| full-stick jog (113, 57) | 4+4 out / 45.8 / 0 / 0, 2+2 / 24.2 / 8 / 0, 1+2 / 17.2 / 10 / 0 | 0 / 17.1 / 8 / 0, 0 / 8.7 / 11 / 0, 0 / 4.9 / 13 / 0 |
| full-stick jog (113, -57) | 4+1 / 35.7 / 3 / 1, 4+1 / 35.8 / 3 / 1, 3+2 / 28.9 / 6 / 0 | 0 / 16.1 / 9 / 1, 0 / 15.4 / 9 / 1, 0 / 8.5 / 11 / 0 |
| jog (80, 40) | 0 / 17.1 / 15 / 0, 0 / 12.6 / 12 / 1, 0 / 13.3 / 15 / 3 | 0 / 12.4 / 8 / 0, 0 / 11.8 / 8 / 0, 0 / 9.2 / 8 / 0 |
| jog (100, 0) | 0 / 9.7 / 11 / 0, 0 / 8.8 / 11 / 1, 0 / 12.2 / 12 / 0 | 0 / 4.6 / 9 / 0, 0 / 5.7 / 8 / 1, 0 / 3.7 / 8 / 0 |
| shield + (40, 0), facing him | 7 / 8.1 / 1 / 0 at each | 8 / 5.4 / 0 / 0, 7 / 4.5 / 1 / 0, 7 / 4.5 / 1 / 0 |
| MOD_L (30, 110) across | 5 / 6.7 / 3 / 2, 6 / 7.2 / 1 / 6, 6 / 7.3 / 1 / 7 | 4 / 5.6 / 4 / 0, 4 / 6.0 / 6 / 1, 1 / 2.9 / 8 / 1 |
| MOD_L (60, 40) diagonal | 0 / 10.2 / 10 / 1, 0 / 8.3 / 10 / 0, 0 / 7.9 / 10 / 3 | 0 / 9.8 / 8 / 0, 0 / 8.2 / 8 / 0, 0 / 7.0 / 8 / 0 |
| walks (35, 0) / (30, +-15) / (45, 30) / (15, 35), zig-zag | unchanged except fouls: (35, 0) L5 2 -> 0, (30, -15) L3 2 -> 0, (15, 35) L3-L4 2 -> 0, zig-zag L5 2 -> 0, (45, 30) L3 4 -> 2 | |

The lower levels are still beaten more (Beginner: full-stick jog 33 m, (80, 40) 22 m, a shielder 11 m).

### Checked, no defect

- Item 2 (shot gate): Beginner v Beginner on the ladder's configs (seed 1, 30 matches) 5.47 shots a match with the
  per-level gate, 4.13 with the full gate (the soak configs: 8.67, above); Amateur 9.87, Semi-Pro 13.87, Professional
  14.13. The gate is fully off at Beginner, so what remains is chance creation (the 100-tick reaction delay), not the
  gate. Professional unchanged.
- Item 3 (keeper reflexes): `keeperReactionTicks` = round(base x scale) + ticks, floored at 0 only below 0: never floored
  at World Class (0.45) or Legend (0.25) with ticks 0; monotone in gkReflexes at every level; Legend <= World Class.
- A human defender chasing a CPU carrier (no buttons) wins the ball as before (Amateur 11 / Professional 6 / Legend 0 of
  16 chasing; sprinting 14 / 6 / 10), so the jog-speed under-the-feet steal is no defender exploit.
- Sprinting (with or without MOD_R) past a defender: unchanged by QF-16 (the sprint dribble's long touches are tackled
  or stolen between touches; 3-4 of 8 run the ball out).
- Box jogs (9.5-16.5 m out): the carrier reaches the byline in most scenes at every level, before and after (the block's
  `blockTicks` delay is 2-3 s); 0-1 penalties from Professional up. Open for the lead with the bot escorts (above).

## FIN-K (final fixes: KNOWN_ISSUES "Match engine" lines that affected match state or input)

Five lines of the KNOWN_ISSUES "Match engine" section (SGN-06 audit) affected match state or input and are fixed, each
with a regression test in `tests/scenario/fin-k-fixes.test.ts` that fails on the code before the fix.

| Module | Constant | Old | New | Why |
|---|---|---|---|---|
| `rules/freekick.ts` + `keeper/setpieces.ts` | (geometry, no new constant) goal-line wall centre and keeper spot | central wall centred on z = 0, keeper on the weighted open centre (z ~ 0: inside the wall) | central wall shifted half a member spacing (`2 x bodyRadius x wallBodyMul + wallGap`) toward the ball's side; the keeper's spot is in the wall's line at its other end (`lineWallKeeperZ`: end member's contact distance + `wallGap` from it, inside `GOAL_HALF_WIDTH - T_GK_SETPIECE.lineInsidePost`), and he is slid into it like a member (`placeLineKeeper`); the human wall move keeps room for him | A goal-line wall member whose slot was where the keeper stood was pushed a body-width off it (a gap at the end of the wall). |
| `rules/freekick.ts` / `rules/restart.ts` | (logic) "choose the taker" and the restart timeout | instant swap of the two players under the set-piece camera (free kicks within 35 m); the 12 s timeout placed a taker still running in on his spot | the new taker (best `takerChoices` within `takerWalkMaxDist`) always runs in (`SET_PIECE_RUN`, capped at `swapRunMaxTicks` 240); the timeout waits at its last tick while he runs, `prepareTakerKick` never places a running taker, and no new choice is taken once the timeout is due | Teleports in view of the set-piece camera and at the timeout. |
| `kicks/kickCommon.ts` (`T_KICK`) | `takerLineUpMaxTicks` -> `takerApproachMaxDeg` / `takerTurnStepDeg` (new) | 45 ticks of re-line-up after the planned contact | 60 deg / 10 deg a tick: during the wind-up a taker not lined up turns toward the ball (approach angle at most 60 deg off the kick direction) and side-steps only for the rest; at the planned contact he strikes from where he is | The strike was delayed 6-14 ticks in a frozen kick pose; input-to-contact at set pieces is now the normal kick timing. |
| `players/possession.ts` (`T_POSSESSION`) | `holdBodyClear` (new) | - | 0.3 m | The wind-up / shield hold pulls the ball round the holder's body (waypoint beside him) instead of straight through it. |
| `kicks/kickCommon.ts` (`T_KICK`) | `turnKickMaxTicks` (new) | - | 30 ticks | Turn-and-kick: an owned ball whose launch ray passes within `holdBodyClear` of the kicker (behind him for the kick) is not struck; he turns toward the kick (SIM-04 look point) while the ball comes round, the contact moving on a tick at a time, at most 30 ticks (in the regression grid the kick lands 0-2 ticks after the planned contact). |

Measurements on the FIN-K tree (`tools/soak.ts --matches 150 --difficulty 3 --enforce all --halfMinutes 4`, seed 1; the
same 150 configs on the tree before FIN-K in brackets): PASS, 0 exceptions / invariant failures / watchdogs /
unfinished, determinism PASS (hash eb39086b); goals 2.76 (2.95), shots 14.89 (15.22), possession of the side with more
56.7% (56.8%), home 49.5% (50.5%), pass completion 78.2% (78.7%), fouls 10.65 (9.50), offsides 0.17 (0.13), blow-outs
0.67% (1.33%). Turn-and-kick engages in ~40 of ~180 kick / shot actions a match (CPU v CPU, 3 matches: mostly a player
facing his own goal clearing or passing upfield, which launched the ball through him); it delays the contact by 0-5
ticks a whole match (the turn is done within the wind-up). Ladder top pairs (`tools/ladder.ts --pairs 3,4 --matches
100`): seed 1 World Class v Professional 71.0%, Legend v World Class 76.0%; seed 2 73.0% / 72.0% (target 65%, all PASS).
Fuzz (`tools/fuzz.ts --matches 60 --enforce all`): PASS, 60 runs + 15 rematches, 0 exceptions / invariant failures /
watchdogs, determinism PASS.

## FIN-P (final fix: the throttled proxy benchmark gate)

No gameplay constant changed: every FIN-P change is behaviour-identical (`tools/hash-table.ts --compare` against the
tree before FIN-P: IDENTICAL, 28 runs). New load-time constants, all in `T_WARMUP` (src/sim/init.ts warmUpSim, production
builds only: the loading screen plays a scratch CPU v CPU match before the first match's state is built):

| Constant | Value | Why |
|---|---|---|
| `T_WARMUP.openPlayTicks` | 4000 ticks | Open play of the scratch match (9000 measured no better in the gate). |
| `T_WARMUP.sceneTicks` | 300 ticks | Per restart scene (corner, free kick, penalty, throw-in, goal kick, both teams), and at most this many to get back to open play. |
| `T_WARMUP.seed` / `halfMinutes` | 0x5eed / 4 | Scratch match seed (xor the match's) and half length (never reaches half time). |
| `T_WARMUP.hashEvery` | 8 ticks | A `hashState` of the scratch state every 8 ticks, beside a `copyState(prev, s)` every tick (the app loop's and the replay recorder's work), so the generated copier and hasher are optimised before the match. |
| `T_WARMUP.restartTicks` | 600 ticks | A second, fresh scratch match at the end (new state and copy target, as the app builds the coming match), so the copier and hasher meet the maps of a match start. |

`BENCH_DEFAULTS.seed` (src/platform/benchHook.ts) 0xb3ac4 -> 1: the 90 s window of seed 1 holds a crowded penalty
area, a corner, a goal into the net and its replay (`tests/perf/fin-p-bench-coverage.test.ts`).

## FEEL-1 (playtest feedback: receiving, dribbling, passing, shooting feel like EA FC)

The user's report (docs/briefs/FEEL-1.md): sprinting at a pass ran straight past it; a sprint dribble "launched the ball
straight forward"; R1 did nothing different; a slightly-off pass went "to the other side of the pitch"; every shot looked
the same. Decisions D-028..D-031. Measured with scripted pad-input scenarios through the real pipeline
(`tests/scenario/feel-1-helpers.ts`, runner `npx tsx tests/scenario/feel-1-measure.ts [recv|drib|pass|crowd|shot]`; the
"before" column is the same runner on a pristine copy of the tree before FEEL-1).

| Block | Constant | Was | Now | Why |
|---|---|---|---|---|
| `T_FEEL` (new) | `humanTouchAheadJog` / `humanTouchAheadSprint` | (T_DRIBBLE 1.0 / 2.4 m) | 1.0 / 1.45 m | Close control of the human-controlled dribbler (D-029): a sprint touch about a stride ahead (was 2.05 m mean, one touch a second, the ball lost on every 90-degree sprint turn). The jog / walk touch stays the calibrated 1.0 m (0.92 m mean, inside the 0.5-1 m target): 0.8 m let a walker keep the ball from a World Class / Legend defender (qf-16-box-walker shuffle kept 4/8, qf-16-escort-block 7.2 m gained). CPU dribblers keep `T_DRIBBLE`. Also his clean first-touch settle lead (SIM-07). |
| `T_FEEL` | `humanTouchIntervalJog` / `humanTouchIntervalSprint` | (18 / 24 ticks) | 18 / 16 ticks | Quicker, shorter touches at pace (jog unchanged, as above). |
| `T_FEEL` | `humanLeadQualityScale` | (`T_POSSESSION.leadQualityScale` 0.2) | 0.4 at a full sprint (blended from 0.2 by the sprint fraction) | Dribbling / control / agility show in how close the ball stays (sprint mean 1.57 m at 40 v 1.19 m at 90; was 2.07 v 2.02). |
| `T_FEEL` | `pokeReach` | - | 0.9 m | Poke window for a human dribbler (his ball beyond controlRadius, an opponent within this of it and nearer to it). |
| `T_RESOLVE` | `controlledSprintScale` | 0.8 | 0.52 | 0.8 was a full sprint (SIM-04 sprints flat out from `sprintStickFull` 0.6); 0.52 is ~87% of top speed. |
| `T_FEEL` (new) | `touchAheadControlled` / `touchIntervalControlled` | - | 0.8 m / 10 ticks (skeptic: was 0.62 m) | R1 controlled sprint touches (SIM-06 reads MOD_R held without SPRINT on the owner's controller); 0.72 m mean, 0.79 m max. At 0.62 m (max 0.59 m) the ball never left the CPU's exposeDist (0.7 m), so no CPU defender ever made a careful tackle on it: an R1 dribbler with a 22-degree side step beat a Legend centre-back 12 of 12 (0 lost); now 75-83% beat, 17-25% lost, and straight at him still lost every time. |
| `T_FEEL` (skeptic, new) | `leashCos`, `leashInner`, `leashLeadMinSpeed`, `leashMaxLead` | - | 0.9, 0.15 m, 3 m/s, 0.4 s | Human dribble leash (SIM-15 resolveMove): the stick turned more than ~26 degrees from his ball while it is at the edge of his touch reach and leaving him: he runs to where it will be, SIM-06 then takes the turn touch the new way (the CPU carrier has its own leash). A square pass received at a sprint and taken straight up the pitch was kept 44% (the ball rolled off the old way); now 94%. Sprint zig-zag 45 degrees each way: kept 4/4 at 8.3 m/s (was 2/4 at 5.9 m/s); 180-degree reversal at a sprint / R1: 4/4 (was 0/4). |
| `T_FEEL` | `magnetRadiusMin` / `Max`, `magnetAssistMul` | - | 6 / 9 m by ballControl; x 1 / 0.8 / 0.55 (Assisted / Semi / Manual) | Receiving magnet capture radius (human-controlled player only, D-028). |
| `T_FEEL` | `magnetAngleFar` / `Near` | - | 0.7 / 1.2 rad | Capture angle of the stick at the edge of the radius / at the meeting point; [skeptic] the stick may point at the meeting point or at the ball itself (a 20 m/s square pass chased with the stick on the ball was never met). |
| `T_FEEL` | `magnetMaxHeight`, `magnetMinJogFrac`, `magnetEarlySec`, `magnetMinStick`, `magnetThrough` | - | 1.6 m, 0.7, 0.15 s, 0.2, 2.5 m | No magnet for a high ball; a gentle stick still meets the ball; speed matching arrives just before the ball; a pick-up ball is run through at pace. |
| `T_FEEL` | `magnetLinePaceFrac`, `magnetLineStep`, `magnetLineSec` | - | 0.8, 0.1 s, 2 s | A ball travelling his way that reaches him anyway on his own line at his pace (rolling deceleration, sampled) is left to him: a led through ball is run onto in stride (sim-10 THROUGH_GROUND kept its never-slowing runner). The magnet also needs the ball in front of him. |
| `T_FEEL` | `magnetReachBonus` | - | 0.35 m | SIM-07 receive reach of a human-controlled player whose stick points toward a loose ball or a pass to him (not his own knock-on, not a pass for someone else). |
| `T_PASS_KICK` | `assistedConeMul` | 1.3 | 1.45 | 58-degree Assisted cone. |
| `T_PASS_KICK` | `alignWeight` / `alignWeightSemi` | 0.45 / 0.6 | 0.8 / 0.9 | The stick decides; alignment is now linear in the angle (was flat near the stick) and uses his current or led position, whichever the stick points nearer. |
| `T_PASS_KICK` | `distWeight` | 0.3 | 0.15 | A half-held pass aimed at a man 10 m away went to one 20 m away 21 degrees off. |
| `T_FEEL` | `passNearWeight`, `passOpenWeight` | - | 0.35 x (1 - power), 0.45 | Soft passes prefer the nearer of two similar options; a man 15 degrees off with an open lane beats one with an opponent in his lane. |
| `T_SHOT` | `finesseSpin` | 9 | 11 rad/s | Finesse clearly curls (4.6 m of bend from 22 m, was 3.8). |
| `T_SHOT_KICK` | `powerShotMinSpeed` | 22 | 26 m/s | A power shot is much faster than a normal shot at any hold (30 v 24 m/s at a 20-tick hold). |
| `T_FEEL` | `normalNaturalSpin` / `lowDrivenNaturalSpin` | - | 3.5 / 2 rad/s | A slight natural curl (about 1 m from 22 m), the solver aiming with it. |
| `T_FEEL` | `trivelaSpeedMul`, `trivelaSpin`, `trivelaErrMul`, `trivelaGestureCurve` | - | 0.9, 10 rad/s, 1.15 (skeptic: was 0.95), 16 | `KickKind.SHOT_TRIVELA`: always bends the other way to a finesse from the same spot (off-centre aim: starts inside the post and bends out into the corner; central: the outside of his foot's way, a right-footer to the right). |
| `T_FEEL` | `cpuTrivelaMinCurve`, `cpuTrivelaEvery` | - | 75, 3 | The CPU plays one about every third finesse chance from the outside-of-the-foot side. |
| `T_WARMUP` | `seed` | 0x5eed | 0x5eef | The reshaped scratch match reached the carrier decide() in 470 of 3000 forced rounds (fin-p2 needs > 750); 1902 now. |

### FEEL-1 measurements (before -> after, same scripted inputs)

| Scenario (pad input, real pipeline) | Before | After |
|---|---|---|
| Pass sprinted at, stick on the ball: collected / still his 0.5 s later (72 cases: 9-18 m/s, path +-8 deg) | 100% / 67% | 100% / 100% |
| Pass sprinted at, stick fixed 15 deg off | 22% | 100% |
| Pass crossing his run (he leads it) | 100% / 81% kept | 100% / 100% kept |
| Loose ball sprinted at, stick 15 deg off | 17% | 100% |
| Ball from his feet 0.5 s after a sprinting first touch | 1.80 m | 0.81 m |
| Jog dribble, ball from his centre mean / max | 0.92 / 0.99 m | 0.92 / 0.99 m (unchanged on purpose, see humanTouchAheadJog) |
| Sprint dribble mean / max, touches per 4 s | 2.05 / 2.39 m, 4 | 1.24 / 1.36 m, 15.5 |
| Sprint dribble with a 90-degree turn: kept | 0 / 4 | 4 / 4 |
| R1 controlled sprint mean / max, speed | = sprint (2.05 m, 8.9 m/s) | 0.55 / 0.59 m, 7.9 m/s |
| Sprint lead at dribbling 40 v 90 | 2.07 v 2.02 m | 1.57 v 1.19 m |
| Kick-off shape, Assisted, stick straight at an unambiguous teammate: targeted | 33% (Semi 67%) | 83% (Semi 83%) |
| Open play, Assisted, stick 30 / 45 deg off the intended man (decoy 75 deg the other side) | 96% / 96% reached (88% / 71% targeted) | 100% / 100% (100% / 96%) |
| Ground pass to a man 15 m away, hold 3 / 30 / 70 ticks | 12.4 / 15.2 / 16.1 m/s, reached | same |
| Shot from (30, -8) at the far post: normal speed / bend | 24.1 m/s / 0 m | 24.1 m/s / 1.06 m |
| Finesse speed / bend | 18.8 m/s / 3.8 m | 18.8 m/s / 4.6 m |
| Power speed / bend (20-tick hold) | 28.0 m/s / 0 | 30.0 m/s / 0 |
| Trivela (L2 + Circle) speed / bend | (a normal shot) | 21.7 m/s / 3.5 m the other way (from (30, +8) too: finesse +4.7 m, trivela -3.5 m) |

In Chromium (`tests/e2e/feel-1-feel.spec.ts`, simulated pad in a Kick-Off match): sprint dribble mean 1.28 m / max 1.37 m
at 9.1 m/s, 0 frames lost; R1 0.55 / 0.58 m at 7.9 m/s; L2 + Circle struck `SHOT_TRIVELA`; a loose ball sprinted at with
the stick ~20 degrees off its line was collected; a Cross tap with the stick 30 degrees off the only nearby teammate
found him.

Bot game (CPU dribblers keep the calibrated touches, D-029; the shot, CPU trivela and pass-selection changes apply),
re-measured after the resume fixes (trivela bend side, knock-on / reach-bonus gating): `tools/soak.ts --matches 150
--difficulty 3 --enforce all --halfMinutes 4` seed 1, before FEEL-1 -> now: PASS, 0 exceptions / invariant failures /
watchdogs, determinism PASS; goals 2.76 -> 2.87, shots 14.89 -> 15.69, possession of the side with more 56.7% -> 56.9%,
home 49.5% -> 50.6%, pass completion 78.2% -> 78.7%, fouls 10.65 -> 10.93, offsides 0.17 -> 0.18, blow-outs 0.67% ->
0.67%. No retune needed (every band holds with margin). Ladder top pairs (`--pairs 3,4 --matches 400` seed 1): World
Class v Professional 71.3% [66.6-75.5], Legend v World Class 71.0% [66.4-75.2] (target 65%). Fuzz 60 `--enforce all`:
PASS (60 + 15 rematches, 0 exceptions / invariant failures / watchdogs, determinism PASS). Close control for every player was measured first (D-029): goals 3.2-3.6 on the first 100 configs
(2.87 on the tree before FEEL-1) and blow-outs 5.33% over 150 (FAIL); with a wider poke reach 3.54; with the CPU's
exposeDist 0.6 3.19 and fouls 13; with shot error +20% 3.11 and blow-outs 6%. Hence the human-only close control.

### FEEL-1 skeptic (new scripted inputs, fixes, final runs)

New scripted human inputs (before FEEL-1 -> FEEL-1 first pass -> skeptic), real pipeline: a square pass received at a
sprint and then taken straight up the pitch (stick on the ball, then +x; 64 cases, 8-20 m/s, +-4/12 degrees, 16/26 m):
kept 40 ticks later 47% -> 44% -> 94%; the same on keyboard 8-way 53% -> 56% -> 94%; a pass met with the stick on a fixed
keyboard 8-way direction 31% -> 88% -> 100%; pad stick fixed 25 / 35 degrees off 16 / 16% -> 72 / 59% -> 94 / 78%; a
bouncing (0.9 m) pass chased at a sprint kept 69% -> 94% -> 100%. Sprint zig-zag (45 degrees each way every 40 ticks):
kept 0/4 -> 2/4 at 5.9 m/s -> 4/4 at 8.3 m/s (max 1.23 m); 180-degree reversal at a sprint 0/4 -> 0/4 -> 4/4, in R1
0/4 -> 0/4 -> 4/4. Against a real CPU centre-back (12 scenes per row, side step 0 / 0.4 / 0.8 of the stick from 6 m):
straight at him the ball is lost every time at every level (sprint and R1); R1 with a 0.4 side step at Legend lost 100%
-> 0% (never tackled: the 0.62 m touch never left the CPU's exposeDist) -> 25%; sprint with the side step at Legend 100%
-> 58% lost; a poor dribbler (30) at a sprint still loses it 94-100%. Assisted passing with an opponent in the lane: 25%
intercepted (passes can still be cut out). Shots against a Professional keeper from five spots (n = 180 each, seeds
4-12): before FEEL-1 normal 52% / finesse 53% / power 50%; now normal 47%, finesse 56%, power 54%, trivela 62% (the
trivela bends away from the keeper; its error was raised to x1.15 so a poor shooter sprays it more than a normal shot).

Final runs on this tree: soak 500 Professional (`--matches 500 --seed 1 --difficulty 3 --enforce all`): PASS, 0
exceptions / invariant failures / watchdogs, determinism PASS; goals 2.99, shots 15.20, possession (side with more)
56.73%, home 50.73%, pass completion 78.99%, fouls 10.61, offsides 0.18, blow-outs 1.40%. Fuzz 60 `--enforce all`: PASS
(60 + 15 rematches, 0 exceptions / invariant failures / watchdogs). Ladder 2 seeds x 200 (pooled over 400): Amateur v
Beginner 74.3%, Semi-Pro v Amateur 74.0%, Professional v Semi-Pro 67.3% (seed 2 alone 64.5%), World Class v
Professional 68.5%, Legend v World Class 75.8%. Balance 4 seeds x 200 (pooled over 800): top-bottom 81.6% wins (seed 4
alone 77.0%), equal 55.7% points, mirror 50.1% points.
