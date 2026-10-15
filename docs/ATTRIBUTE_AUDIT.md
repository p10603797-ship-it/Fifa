# Attribute audit (DAT-05)

BRIEF section 15: "Every attribute must visibly change play. Delete any that does not." This document records, for
each of the 25 attributes in `ATTRIBUTE_KEYS` plus the other per-player fields the sim uses (height, preferred foot,
weak foot, skill moves), which sim / AI modules consume it, what a micro-test measured when only that attribute moved
from 40 to 90, and the verdict.

Two halves, both re-runnable by QA:

- **Static audit**: `npx tsx tools/balance.ts --audit [--verbose] [--write-doc docs/ATTRIBUTE_AUDIT.md]`. Type-aware
  (TypeScript compiler API, not a text grep): every read of a `PlayerAttrs` / `PlayerData` property in `src/sim` and
  `src/ai` (property access, literal element access, destructuring). Writes and the copy / hash / serialise plumbing
  (`sim/init.ts`, `core/hash.ts`, `core/serialize.ts`, `core/clone.ts`, `replay.ts`, `debug/invariants.ts`) do not
  count; `PlayerState.stamina` (the condition) is not the `stamina` attribute. Reads of the derived `topSpeed` / `accel`
  count for sprintSpeed / acceleration. `--write-doc` regenerates the table between the static-audit markers below.
- **Dynamic audit**: `tests/sim/dat-05-attributes.test.ts`, one micro-test per attribute. The same scenario is played
  with only that attribute at 40 and 90 (height 170 vs 195 cm, weak foot and skill moves 1 vs 5, preferred foot right vs
  left) and the outcome must move the right way by a visible margin. `DAT05_REPORT=1 npx vitest run
  tests/sim/dat-05-attributes.test.ts --disableConsoleIntercept` prints the measured table (copied below). Levels: **pipeline** = the real
  `step()` pipeline (or the sim's stage functions in pipeline order); **solver** = the real kick solver at contact over
  160-200 rng seeds, flown with the sim's ball physics; **model** = the sim's own decision function evaluated on a
  scenario state (the chance it rolls against).

## Verdict

- **29 of 29 audited fields are read by `src/sim` or `src/ai`, and 29 of 29 visibly change play in their micro-test.
  Nothing is deleted.** No consumer is a stub any more, so the dynamic test file has no `it.todo` entries.
- **Weak effects flagged for Wave 4 tuning** (they move play, but less than the others):
  - **shotPower**: shot speed moves about 12% from 40 to 90 (25.7 to 28.7 m/s at 80% power; was 4% before Wave 4).
  - **composure**: in the sim it relieves the pressure part of the shot error (0.59 to 0.45 m under a 1 m press) and
    feeds penalties. [QF-11] It now also scales the CPU's decision noise on the player (`T_AI.composureNoise*`,
    `ai/cpu/levels composureNoiseMul`: the carrier's option noise and a defender's rash / noisy tackles; x0.78 at 87,
    x1.23 at 57 with slope 0.45 [QF-11 skeptic; 0.65 before], weighted by level: full at Professional, half at
    Semi-Pro, none elsewhere; a carrier short of vision is penalised the same way, below). That is
    how a rating gap shows through decisions as well as the body: the 88-rated club beat the 62-rated one in 57.5% of
    40 Professional matches without it, 78.8% of 800 (4 seeds) with composure 0.65 alone and 76.9% of 800 with the
    kept composure 0.45 + vision penalty 1.2, the closest-rated pair splitting 55.3% of points (a vision bonus for
    good carriers, `visionNoiseBonusSlope` 0.45, gives 81.5% but costs World Class v Professional 6.5 points of the
    ladder; see docs/TUNING.md, QF-11 skeptic) (`tools/balance.ts`;
    `tests/scenario/qf-11-defects.test.ts` pins that a calm carrier makes the clean choice more often than a nervous
    one).
  - **finishing at close range**: with the Assisted aim a 40-finishing striker still puts 99% of 14 m shots on target;
    finishing moves placement (0.65 to 0.18 m from the aim point), so it shows as corners hit versus shots near the
    keeper rather than misses. Tuning is for SIM-11 / Wave 4.
  - **dribbling on the ball**: the sprint-dribble touch barely changes (mean ball distance 2.04 to 2.01 m: dribbling is
    45% of the touch quality and the touch lead moves only +-10%). Its visible effect is tackle resistance (standing
    tackles against the carrier win 44% vs 28%) and the skill-move steal window.
  - **gkPositioning**: the keeper stands 0.23 m off his ideal spot at 40 vs 0.03 m at 90: visible in replays, small
    in save rate.
  - **skillMoves 3, 4 and 5 give the same human move set** (`T_SKILL.minStars` tops out at 3 stars); 4 and 5 stars
    differ only in the CPU's skill-move success estimate (`ai/cpu/carrier` skillPerStar). Suggest a 4-star tier (e.g.
    roulette / heel flick at 4) in Wave 4.

## Attributes, consumers, measured effect

Consumers are the modules that read the attribute (the static table below has the full list). "40 -> 90" is the
dynamic micro-test (table further down has the exact numbers and levels).

| Attribute | Sim consumers (what it drives) | AI consumers | Measured effect, 40 -> 90 | Verdict |
|---|---|---|---|---|
| acceleration | locomotion `accelFor` (m/s^2) and 30% of `topSpeedFor`; derived `accel` in keeper step reach | every reach / intercept-time estimate via `topSpeed` / `accel` | 65 -> 50 ticks from standstill to 6 m/s | keep |
| sprintSpeed | locomotion `topSpeedFor` (7.0-9.6 m/s) | reach / run timing via `topSpeed`; set-piece "stay back" choice | peak sprint 8.15 -> 9.28 m/s | keep |
| agility | locomotion turn rate; 20% of dribble touch quality; skill-move exit speed; aerial jump (with heading) and turn; 1 - interceptAttrW of interception chance | (via derived speeds) | 18 -> 14 ticks to turn a sprint 75 deg | keep |
| ballControl | first-touch quality (clean / heavy / miss); 35% of dribble touch quality; tackle resistance; skill-move steal radius; volley skill | CPU passing (receiver touch) | clean first-touch chance on a 14 m/s pass 33% -> 100% (20 m/s: 0% -> 82%) | keep |
| dribbling | 45% of dribble touch quality; tackle resistance (largest weight); skill-move steal radius | CPU carrier dribble / skill success; set-piece short option | standing tackles against him win 44% -> 28%; sprint-dribble ball distance 2.04 -> 2.01 m | keep (touch effect weak) |
| shortPassing | pass accuracy up to 12 m (`passAccuracy`); volley / header passes; free-kick taker choice | CPU pass choice; set-piece short taker | 15 m ground pass direction spread 4.1 -> 1.3 deg | keep |
| longPassing | pass accuracy from 35 m; lob error; clearance quality; free-kick taker choice | CPU pass choice | 38 m lob spread 4.5 -> 1.3 deg | keep |
| crossing | cross error; corner taker choice; free-kick taker choice | CPU cross choice | cross spread 4.5 -> 1.3 deg | keep |
| vision | through-ball accuracy (`visionShare`) | CPU pass option search (sees more runs); [QF-11 skeptic] CPU carrier option noise when short of vision (`T_AI.visionNoise*`, weighted like composure) | through-ball spread 3.1 -> 1.6 deg; CPU option noise x1.52 -> x1.0 (52 -> 65+) | keep |
| finishing | shot accuracy up to 16 m; volley duel / shot accuracy; penalty accuracy; penalty-taker choice | CPU shot decision | 14 m shot placement error 0.65 -> 0.18 m (on target 99% -> 100%) | keep (see weak list) |
| shotPower | shot speed (x0.92-1.0); header / volley shot speed; clearance speed; free-kick / penalty power and taker choice | set-piece shooter choice | launch speed at 80% power 27.8 -> 29.0 m/s | keep, **weak: tune** |
| longShots | shot accuracy from 20 m; free-kick shot accuracy; free-kick taker choice | CPU shot range; set-piece shooter | 28 m shot on target 84% -> 100%, placement 1.29 -> 0.37 m | keep |
| curve | finesse-shot accuracy and curl spin; free-kick curl; corner taker choice | CPU finesse choice; set-piece shooter | finesse side spin 8.4 -> 10.4 rad/s | keep |
| heading | header jump, duel score, header accuracy and AI timing; corner / free-kick / goal-kick aerial target choice | CPU aerial pass targets; set-piece aerial / marker roles | aerial duel win rate 17% -> 90% | keep |
| standingTackle | standing / hard tackle win chance and keep-the-ball chance | set-piece marker choice | standing-tackle win rate 19% -> 47% | keep |
| slidingTackle | slide tackle win chance | - | sliding-tackle win rate 31% -> 60% | keep |
| interceptions | interception chance (`interceptChance`) | - | passes cut out 0.75 m off the line 43% -> 58% | keep |
| strength | body mass in collisions, shielding; shoulder / push duels; tackle resistance; clearance; aerial duel and the beaten jumper's stumble; keeper punch | CPU shielding | shoulder-challenge win rate 21% -> 81% | keep |
| stamina | drain and recovery rate of the condition (which scales speed, acceleration and kick accuracy when low) | - | condition drained per minute of sprinting 0.51 -> 0.32 | keep |
| composure | shot pressure relief; 40% of penalty accuracy; penalty-taker choice; penalty keeper's read | CPU shot decision; [QF-11] CPU decision noise (carrier options, rash / noisy tackles) | 14 m shot under a 1 m press: placement error 0.59 -> 0.45 m; CPU option noise x1.23 -> x0.78 (57 -> 87) | keep |
| gkDiving | dive speed, max reach, get-up time; claim jump height; best keeper for a sub | CPU shot placement against the keeper | save rate, hard corner shots 16-22 m: 36% -> 78% | keep |
| gkHandling | catch-speed limit (catch vs parry), parry quality; throw accuracy; claim catch limit; punch speed | - | share of saves held 58% -> 92% | keep |
| gkReflexes | reaction delay (`keeperReactTicks`); parry quality | CPU shot placement against the keeper | save rate, close-range shots 8-11 m: 67% -> 89% | keep |
| gkPositioning | positioning accuracy (`idealKeeperSpot` error); free-kick spot | - | distance from the ideal spot 0.23 -> 0.03 m | keep (moderate) |
| gkKicking | drop-kick / kick accuracy and distance error; sweeper clearance speed | - | drop-kick direction spread 1.95 -> 0.83 deg | keep |
| height | body radius; standing head height in aerials; keeper reach heights; throw-in release height; wall blocking height; aerial target choice | set-piece aerial / marker roles | aerial duel win rate 23% (170 cm) -> 93% (195 cm) | keep |
| foot | which side is the weak foot for passes, shots, volleys and skills; natural finesse curl side; penalty keeper's read | CPU shot foot / angle; set-piece taker side | 15 m pass off the left side: spread 3.6 (right-footed) -> 2.0 deg (left-footed) | keep |
| weakFoot | weak-foot error multiplier (passes, shots, volleys) | CPU weak-foot shot avoidance | weak-foot 15 m pass spread 3.6 (1) -> 2.0 deg (5) | keep |
| skillMoves | star gate of skill moves and the fake shot | CPU skill success estimate and choice | stick skill moves available 2 (1 star) -> 7 (5 stars) | keep (3-5 stars identical for humans) |

Position and shirt number (BRIEF section 15 "also per player") are not attributes: the position sets the formation
role and the shirt is shown on the kit; neither is audited here.

## Dynamic audit: measured values

From `DAT05_REPORT=1 npx vitest run tests/sim/dat-05-attributes.test.ts --disableConsoleIntercept` (seeded, deterministic; numbers move when
the consuming modules are retuned, the assertions only require the direction and a visible margin). Refreshed by QF-11
(Wave 4 round 2) on the tree with QF-9 / QF-10's sim changes: stamina, ballControl, shotPower, composure, heading,
height and gkDiving rows moved; every row still moves the right way.

| Attribute | Level | Measured outcome | Low | High |
|---|---|---|---|---|
| sprintSpeed | pipeline | peak sprint speed, m/s | 8.15 (40) | 9.28 (90) |
| acceleration | pipeline | ticks from standstill to 6 m/s | 65.0 (40) | 50.0 (90) |
| agility | pipeline | ticks to turn a sprint 75 deg | 18.0 (40) | 14.0 (90) |
| stamina | pipeline | condition (0..1) drained per minute of sprinting | 0.32 (40) | 0.20 (90) |
| ballControl | model | clean first-touch chance, 14 m/s pass | 0.50 (40) | 1.00 (90) |
| dribbling | pipeline | standing-tackle win rate against him | 0.44 (40) | 0.28 (90) |
| dribbling | pipeline | mean ball-to-feet distance, sprint dribble, m | 2.04 (40) | 2.01 (90) |
| skillMoves | model | skill moves available (of 7 stick moves) | 2.00 (1 star) | 7.00 (5 stars) |
| shortPassing | solver | direction spread, 15 m ground pass, deg | 4.12 (40) | 1.34 (90) |
| longPassing | solver | direction spread, 38 m lob, deg | 4.47 (40) | 1.30 (90) |
| crossing | solver | direction spread, cross from the wing, deg | 4.48 (40) | 1.30 (90) |
| vision | solver | direction spread, through ball, deg | 3.06 (40) | 1.57 (90) |
| weakFoot | solver | direction spread, weak-foot 15 m pass, deg | 3.61 (1) | 2.01 (5) |
| foot | solver | direction spread, 15 m pass off the left side, deg | 3.61 (right-footed) | 2.01 (left-footed) |
| finishing | solver | placement error at the line, 14 m shot, m | 0.65 (40) | 0.18 (90) |
| finishing | solver | on-target rate, 14 m shot | 0.99 (40) | 1.00 (90) |
| longShots | solver | on-target rate, 28 m shot | 0.84 (40) | 1.00 (90) |
| longShots | solver | placement error at the line, 28 m shot, m | 1.29 (40) | 0.37 (90) |
| shotPower | solver | launch speed at 80% power, m/s | 25.7 (40) | 28.7 (90) |
| curve | solver | side spin of a curled finesse shot, rad/s | 8.36 (40) | 10.4 (90) |
| composure | solver | placement error at the line, 14 m shot under pressure, m | 0.59 (40) | 0.45 (90) |
| heading | pipeline | aerial duel win rate | 0.17 (40) | 0.83 (90) |
| height | pipeline | aerial duel win rate | 0.17 (170 cm) | 0.83 (195 cm) |
| strength | pipeline | shoulder-challenge win rate | 0.21 (40) | 0.81 (90) |
| standingTackle | pipeline | standing-tackle win rate | 0.19 (40) | 0.47 (90) |
| slidingTackle | pipeline | sliding-tackle win rate | 0.31 (40) | 0.60 (90) |
| interceptions | pipeline | passes cut out by a defender 0.75 m off the line | 0.43 (40) | 0.58 (90) |
| gkDiving | pipeline | save rate, hard corner shots 16-22 m | 0.31 (40) | 0.72 (90) |
| gkReflexes | pipeline | save rate, close-range shots 8-11 m | 0.67 (40) | 0.89 (90) |
| gkHandling | pipeline | share of saves held | 0.58 (40) | 0.92 (90) |
| gkPositioning | model | distance from the ideal spot, m | 0.23 (40) | 0.03 (90) |
| gkKicking | solver | direction spread, drop kick, deg | 1.95 (40) | 0.83 (90) |

## Static audit: readers in src/sim and src/ai

<!-- static-audit:begin (generated by `npx tsx tools/balance.ts --audit --write-doc docs/ATTRIBUTE_AUDIT.md`) -->
| Attribute | Static readers in src/sim, src/ai | Status |
|---|---|---|
| acceleration | sim/players/locomotion, ai/cpu/carrier (via topSpeed / accel), ai/cpu/defending (via topSpeed / accel), ai/cpu/passing (via topSpeed / accel), ai/cpu/shooting (via topSpeed / accel), ai/defshape (via topSpeed / accel), ai/jobs (via topSpeed / accel), ai/press (via topSpeed / accel), ai/runs (via topSpeed / accel), ai/setpieces (via topSpeed / accel), ai/steer (via topSpeed / accel), ai/support (via topSpeed / accel), ai/tactics (via topSpeed / accel), ai/transition (via topSpeed / accel), sim/control/resolveMove (via topSpeed / accel), sim/control/resolveShared (via topSpeed / accel), sim/control/switching (via topSpeed / accel), sim/defend/tackle (via topSpeed / accel), sim/keeper/positioning (via topSpeed / accel), sim/keeper/saveKinematics (via topSpeed / accel), sim/keeper/setpieces (via topSpeed / accel), sim/keeper/sweeper (via topSpeed / accel), sim/kicks/aerial (via topSpeed / accel), sim/kicks/pass (via topSpeed / accel), sim/kicks/shot (via topSpeed / accel), sim/kicks/skills (via topSpeed / accel), sim/kicks/through (via topSpeed / accel), sim/players/bodies (via topSpeed / accel), sim/players/firstTouch (via topSpeed / accel), sim/players/possession (via topSpeed / accel), sim/rules/penalty (via topSpeed / accel), sim/rules/restartCommon (via topSpeed / accel), sim/rules/throwin (via topSpeed / accel) | read (122 site(s)) |
| sprintSpeed | ai/setpieces, sim/players/locomotion, ai/cpu/carrier (via topSpeed / accel), ai/cpu/defending (via topSpeed / accel), ai/cpu/passing (via topSpeed / accel), ai/cpu/shooting (via topSpeed / accel), ai/defshape (via topSpeed / accel), ai/jobs (via topSpeed / accel), ai/press (via topSpeed / accel), ai/runs (via topSpeed / accel), ai/steer (via topSpeed / accel), ai/support (via topSpeed / accel), ai/tactics (via topSpeed / accel), ai/transition (via topSpeed / accel), sim/control/resolveMove (via topSpeed / accel), sim/control/resolveShared (via topSpeed / accel), sim/control/switching (via topSpeed / accel), sim/defend/tackle (via topSpeed / accel), sim/keeper/positioning (via topSpeed / accel), sim/keeper/setpieces (via topSpeed / accel), sim/keeper/sweeper (via topSpeed / accel), sim/kicks/aerial (via topSpeed / accel), sim/kicks/pass (via topSpeed / accel), sim/kicks/shot (via topSpeed / accel), sim/kicks/skills (via topSpeed / accel), sim/kicks/through (via topSpeed / accel), sim/players/bodies (via topSpeed / accel), sim/players/possession (via topSpeed / accel), sim/rules/penalty (via topSpeed / accel), sim/rules/restartCommon (via topSpeed / accel), sim/rules/throwin (via topSpeed / accel) | read (87 site(s)) |
| agility | sim/defend/tackle, sim/kicks/aerial, sim/kicks/skills, sim/kicks/through, sim/players/locomotion, sim/players/possession | read (9 site(s)) |
| ballControl | ai/cpu/passing, sim/defend/tackle, sim/kicks/aerial, sim/kicks/skills, sim/players/firstTouch, sim/players/possession | read (10 site(s)) |
| dribbling | ai/cpu/carrier, ai/setpieces, sim/defend/tackle, sim/kicks/skills, sim/players/possession | read (7 site(s)) |
| shortPassing | ai/cpu/passing, ai/setpieces, sim/kicks/aerial, sim/kicks/pass, sim/rules/freekick | read (7 site(s)) |
| longPassing | ai/cpu/passing, sim/defend/tackle, sim/kicks/lob, sim/kicks/pass, sim/rules/freekick | read (5 site(s)) |
| crossing | ai/cpu/passing, sim/kicks/lob, sim/rules/corner, sim/rules/freekick | read (5 site(s)) |
| vision | ai/cpu/carrier, ai/cpu/passing, sim/kicks/through | read (3 site(s)) |
| finishing | ai/cpu/shooting, sim/kicks/aerial, sim/kicks/shot, sim/rules/penalty, sim/rules/restart, sim/rules/shootout | read (11 site(s)) |
| shotPower | ai/setpieces, sim/defend/tackle, sim/kicks/aerial, sim/kicks/shot, sim/rules/freekick, sim/rules/penalty, sim/rules/shootout | read (9 site(s)) |
| longShots | ai/cpu/shooting, ai/setpieces, sim/kicks/shot, sim/rules/freekick | read (8 site(s)) |
| curve | ai/cpu/carrier, ai/setpieces, sim/kicks/shot, sim/rules/corner, sim/rules/freekick | read (10 site(s)) |
| heading | ai/cpu/passing, ai/setpieces, sim/kicks/aerial, sim/rules/corner, sim/rules/freekick, sim/rules/goalkick | read (16 site(s)) |
| standingTackle | ai/setpieces, sim/defend/tackle | read (3 site(s)) |
| slidingTackle | sim/defend/tackle | read (1 site(s)) |
| interceptions | sim/defend/tackle | read (1 site(s)) |
| strength | ai/cpu/carrier, sim/defend/tackle, sim/keeper/sweeper, sim/kicks/aerial, sim/players/bodies | read (16 site(s)) |
| stamina | sim/players/locomotion | read (1 site(s)) |
| composure | ai/cpu/carrier, ai/cpu/defending, ai/cpu/shooting, sim/keeper/setpieces, sim/kicks/shot, sim/rules/penalty, sim/rules/restart, sim/rules/shootout | read (9 site(s)) |
| gkDiving | ai/cpu/shooting, sim/keeper/saveKinematics, sim/keeper/sweeper, sim/rules/subs | read (6 site(s)) |
| gkHandling | sim/keeper/handling, sim/keeper/saves, sim/keeper/sweeper, sim/rules/subs | read (7 site(s)) |
| gkReflexes | ai/cpu/shooting, sim/keeper/saveKinematics, sim/keeper/saves, sim/rules/subs | read (4 site(s)) |
| gkPositioning | sim/keeper/positioning, sim/keeper/setpieces, sim/rules/subs | read (4 site(s)) |
| gkKicking | sim/keeper/handling, sim/keeper/sweeper, sim/rules/subs | read (3 site(s)) |
| height | ai/setpieces, sim/keeper/saveKinematics, sim/kicks/aerial, sim/players/bodies, sim/rules/corner, sim/rules/freekick, sim/rules/goalkick, sim/rules/subs, sim/rules/throwin | read (17 site(s)) |
| foot | ai/cpu/shooting, ai/setpieces, sim/keeper/setpieces, sim/kicks/aerial, sim/kicks/pass, sim/kicks/shot, sim/kicks/skills | read (9 site(s)) |
| weakFoot | ai/cpu/shooting, sim/kicks/aerial, sim/kicks/pass, sim/kicks/shot | read (7 site(s)) |
| skillMoves | ai/cpu/carrier, ai/cpu/shooting, sim/kicks/skills | read (5 site(s)) |
<!-- static-audit:end -->

## Rating balance (BRIEF section 15)

"Balance check by simulation over 200 matches: an 88-rated club beats a 62-rated club at least 80% of the time, and
equal clubs split close to evenly." Tool: `npx tsx tools/balance.ts` (CPU v CPU at Professional, 200 matches per
matchup, preferred formations, offside and fouls on; top-bottom and equal play every seed twice with the home side
swapped). Exit code 0 = every target met. Useful flags: `--matches N`, `--suite top-bottom,equal,mirror`,
`--workers W`, `--seed S`, `--halfMinutes M`, `--difficulty D`, `--cup`, `--json out.json`, `--max-ticks T` (smoke).

Current numbers (2026-10-14, `npx tsx tools/balance.ts --workers 2`, seed 1, 4-minute halves, 600 matches, 873 s,
no failed match). **RESULT: FAIL (2/3 matchups meet the target).**

| Matchup | n | A W / D / L | Judged value (95% CI) | Target | Verdict | Goals A-B | Shots A-B | On target A-B |
|---|---|---|---|---|---|---|---|---|
| top-bottom: MOS (88) v ROO (62) | 200 | 40 / 159 / 1 | wins 20.0% (15.0-26.1) | wins >= 80% | FAIL | 0.23-0.01 | 0.9-0.1 | 0.5-0.1 |
| equal: SND (76) v GLA (75) | 200 | 15 / 172 / 13 | points 50.5% (43.6-57.4) | points 40-60% | PASS | 0.09-0.09 | 0.6-0.4 | 0.4-0.2 |
| mirror: GLA (75) v GLA (75) | 200 | 9 / 175 / 16 | home points 48.3% (41.4-55.1) | points 40-60% | PASS | 0.06-0.09 | 0.5-0.5 | 0.3-0.3 |

Reading: the stronger club is clearly stronger (40 wins to 1 loss, 52.5% possession, 9x the shots), but 80-88% of
CPU-v-CPU matches end 0-0, with under one shot per side per match. The equal and mirror passes say little for the same
reason (the tool now prints a WARN line for matchups with more than 50% draws or under one goal per match). The
balance target cannot be judged until CPU attacks create and finish chances; that is Wave 4 tuning (AI attacking
play, shot decision thresholds, keeper save rates), after which QA re-runs the tool unchanged.
