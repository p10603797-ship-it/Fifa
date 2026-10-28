# FEEL-1 — Playtest feedback: make receiving, dribbling, passing and shooting feel like EA FC (user request)

The user played the preview build and reported, in their words:
- "If someone passes it to me and I sprint at the ball, the character just pretends like it's not there and just sprints
  past it. In FIFA it's almost like a magnet: the ball attracts the person to it and he takes a touch."
- "If I'm sprinting, it's just launching the ball straight forward. I want to dribble like in FIFA with the ball pretty
  much almost stuck to my feet (but not actually stuck), sprinting, and I can R1 dribble [controlled sprint]."
- "The passing is pretty off. I want assisted passing like in FIFA: if you pass a little bit off, it still goes to the
  person instead of launching it to the other side of the pitch."
- "The shooting's all the same. I want a little bit of curve: curve for a trivela, for finesse, and power shots."
The dribbling is their top priority. This overrides earlier tuning where they conflict (record decisions D-028+).

Area (exclusive): src/sim/** (control, players: possession/dribble/firstTouch/locomotion, kicks: pass/shot/aerial),
src/ai/** only where the CPU must use the same new mechanics, src/input/** (pad/touch/keyboard mapping for new inputs),
src/contracts/tuning.ts (+ enums/input only for a new shot kind; you may add it, documenting it in docs/CONTRACTS.md),
docs/TUNING.md, docs/DECISIONS.md, README.md + docs/KEYBOARD.md + docs/CONTROLS_AUDIT.md control rows, tests.
Goals, each proven by scripted human-input scenario tests through the real pipeline (pad, keyboard and touch where
relevant) and checked in a real Chromium match:
1. Receiving magnet (BRIEF §6 first touch, §10 Assisted): a human controlled player running/sprinting at an incoming pass
   or a loose ball in front of him is drawn to it (small automatic path correction and speed matching within a capture
   radius that grows with ball control/assist level) and takes a controlled first touch; he never runs through or past a
   ball he is running at. A sprinting first touch may be heavier but stays playable.
2. Close control: jog dribble keeps the ball ~0.5-1 m ahead with frequent touches; sprint dribble ~1-1.8 m (not launched
   several metres ahead); R1 controlled sprint keeps it tight (~0.4-0.8 m) at a bit lower speed; dribbling/agility
   attributes still matter; turns keep the ball close. The ball stays a physics object that can be poked away between
   touches (§6), just with shorter, quicker touches.
3. Assisted passing (default "Assisted"): the pass snaps to the best teammate in a generous cone around the stick
   direction (~±40-60°, weighted by angle, distance and openness); assisted power: a tap or short hold reaches that
   receiver at a sensible pace regardless of exact hold time (hold adds pace, never sends it the length of the pitch to
   nobody); through balls lead the runner. Semi narrows the cone and adds power error; Manual keeps today's behaviour.
4. Shooting variety you can see: normal shots get natural slight curve from foot and angle; finesse (R1+Circle) clearly
   curls into the far corner, slower, more accurate; power shot (L1+R1+Circle) longer wind-up, much faster and straighter,
   less assistance; NEW trivela (outside-of-the-foot curler, bending the other way): add it — pad L2 + Circle (L2 held is
   otherwise shield; resolve the combo at the face press per §10 rule), keyboard and touch equivalents (e.g. SHOOT swipe
   with a curve gesture), CPU may use it rarely. Chip and low driven stay. Make the differences visible in ball flight.
Keep: determinism, invariants, no allocation per tick, the §7 bands at Professional (500-match soak), ladder >= 65% per
pair (top pairs over >= 400) and balance >= 80% / 50+-10 (800), fuzz clean, all existing tests green or updated with a
reason. Work economically (account usage limits).
