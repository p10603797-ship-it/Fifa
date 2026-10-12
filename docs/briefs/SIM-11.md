# SIM-11 — Shooting
Owns: `src/sim/kicks/shot.ts`. Spec: BRIEF §6 Shooting; T_SHOT; §9 SHOOT button (tap/hold power, swipe up chip,
down finesse, left fake, right power shot); §10 Shooting table (B; R1+B finesse; L1+B chip; L1+R1+B power shot;
B then tap B again during power-up = low driven); set pieces: FREE_KICK_SHOT (aim, curl/dip from p.actCurve),
PENALTY.
Implement `startShot` (+ ReqFlag.FIRST_TIME volleys are SIM-12; first-time ground shots are yours), `shotHandler`
(wind-up: T_SHOT.windup, powerShotWindup for power shots; charging like passes; a second SHOOT press during
charging converts to SHOT_LOW_DRIVEN — the resolver calls `markLowDriven(s, slot)` which you export; contact;
recovery), `solveShot`, `shotAimPoint`:
- Aim: the stick aims relative to the goal (pitch-space stick direction mapped onto the goal mouth: stick toward
  the far post aims far post...). Assisted aim biases toward the inside of the posts (assistInset) and away from the
  keeper; Semi/Manual less. Power 0..1 -> speed range; finesse slower with curl (finesseSpin, curling inside the
  far post) and more accurate; chip with backspin over the keeper; power shot fastest, least assistance; low driven
  low and hard.
- Error model (`kickError` of SIM-08 or your own): finishing (inside the box) and longShots (outside ~18 m),
  power above errorPowerKnee, balance (angle between run direction and shot direction), pressure, weak foot, ball
  height at contact, stamina. launch.onTarget = aim point after error lies inside the mouth.
- Fake shot: SIM-13 startFake cancels your wind-up — make shotHandler.end handle interruption cleanly.
Tests: shot speed bands (25-36 m/s for hard shots), on-target rate rises with finishing, finesse curls inside the
post, chips clear an advanced keeper, low driven stays under 1 m, power shot wind-up longer, determinism.
Target interplay: equal teams 2.0-3.6 goals/match with keepers saving 65-78% on target (QA measures).
