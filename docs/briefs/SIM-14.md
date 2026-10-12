# SIM-14 — Tackles, clearances and interceptions
Owns: `src/sim/defend/tackle.ts`. Spec: BRIEF §6 Defending; T_TACKLE; §9 defence buttons; §10 Defending table
(B tackle / push-pull / shoulder / clearance by context; R1+B hard tackle; X slide; X quick get-up); glitch list
"Ball stuck: under a sliding player", "Keeper fights a defender" (coordinate), "Discipline" (feed RUL-09 correctly).
Implement starters/handlers per the stub:
- Standing tackle: timed lunge toward the carrier: wind-up, contact window, recovery; success from timing (ball within
  reach during the window, ideally while the carrier's ball is between touches or in a skill's vulnerable window),
  angle (from the side/front better than from behind), standingTackle vs dribbling/strength/shielding (SIM-05
  shieldBlocks). Outcomes: win the ball (ball poked to the tackler or loose; TACKLE event c=1; tackler often gains
  possession), miss (stumble briefly), or contact with the player first -> pushChallenge (ballFirst = 0) -> RUL-09
  decides foul. Hard tackle: more reach and force, longer recovery, higher foul risk. Slide: long reach (slideReach),
  long recovery, quick get-up when the human presses X again (export `quickGetUp(s, slot)`), from behind = high foul
  risk. Shoulder challenge when running alongside (strength duel). Push/pull when chasing from behind (slows the
  carrier, foul risk).
- Clearances: `startClearance` when a loose/high ball is about to reach a defender in his own third; `solveClearance`
  hits it long and high away from goal, toward the touchline if under pressure.
- Interceptions (`interceptContacts`): an opponent's pass passing within interceptReach of a defender (ground or low
  ball) is intercepted with a chance from interceptions/reactions/ball speed (deterministic RNG); AI defenders and
  the controlled player. Emit INTERCEPT.
- Every challenge with body contact records a ChallengeRecord (`pushChallenge`) with ballFirst, fromBehind,
  closingSpeed, kind, position. `knockDown` puts a player into STUMBLE/FALLEN/GET_UP (stunT), interrupting actions
  via endAction(…, 1).
Tests: timing windows, from-behind slides record fromBehind ~1, tackles succeed more for high standingTackle,
interception rates by attribute, no ball stuck under a sliding player, quick get-up, determinism.
