# SIM-13 — Skill moves and fake shot
Owns: `src/sim/kicks/skills.ts`. Spec: BRIEF §6 ("Skill moves, eight to start: ball roll, step-over, body feint,
drag-back, fake shot, roulette, heel flick, knock-on. Each has a fixed duration, an exit direction and a window where
the ball can be won. A skill-star rating gates the harder ones."), §9 SPRINT & SKILL (tap/swipes), §10 right-stick
skills, drag-back (L1+R1+flick back), knock-on (R2 + RS flick), stop ball (release stick + R2), stop and face goal
(release stick + L1); T_SKILL.
Implement `startSkill` (validate owner has the ball, stars >= T_SKILL.minStars, free), `startFake`, `skillHandler`,
`fakeHandler`, `inSkillVulnerableWindow`, `solveSkillTouch`:
- Each move scripts ball and body over its duration: positions of the ball relative to the player (ball roll sideways,
  step-over feint then exit, body feint lateral burst, drag-back pulls the ball back and turns, roulette 360 spin,
  heel flick lifts the ball forward over, knock-on pushes it far ahead into space, stop ball / hard stop kills speed,
  stop and face goal turns to face the attacked goal). Exit direction from the request direction relative to facing.
  During the vulnerable window opponents may win the ball (SIM-14 checks inSkillVulnerableWindow); outside it the
  ball is protected (noTouchT for opponents? no — use the window query). Emit SKILL.
- Fake shot/pass: converts a KICK/SHOT wind-up (before contact) into a feint touch.
Tests: each skill completes in its duration with the ball ending near the player in the exit direction; star gating;
vulnerable windows; fake converts a shot wind-up; no ball stuck after skills; determinism.
