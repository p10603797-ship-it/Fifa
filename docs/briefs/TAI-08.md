# TAI-08 — CPU ball-carrier decision engine
Owns: `src/ai/cpu/carrier.ts`. Spec: BRIEF §7 CPU opponent ("plays through the same InputFrame as a human and obeys
the same physics, stamina and error models. It gets no hidden stat boosts and never reads the human's inputs. On the
ball it scores its options every few ticks: each pass candidate (completion chance, progress, danger created), through
ball, cross, dribble into space, skill move, shield, clear, and shoot (an expected-goal estimate from distance, angle,
pressure and keeper position)."; "Team styles ... weight those choices"; "Six levels ... reaction time, decision noise,
look-ahead, execution error, pressing and tackle timing"), §7 targets (goals 2.0-3.6, shots 14-26, possession 40-60%,
pass completion 70-88%), contracts CpuBrainState, InputFrame.
Implement `cpuCarrier(s, team, out, ev)`: the CPU controller (ctrl[2+team]) controls the carrier (SIM-16 follows the
ball for CPU). Every carrierEvalInterval ticks (brain.evalT) score options with TAI-09 scorePassOptions, TAI-10
estimateXg/bestDribble/chooseSkill, style weights and level params (TAI-12) + decision noise (s.rng); commit to a plan
(brain.plan/planSlot/planX/planZ/holdTicks) for a few ticks (no dithering); execute by writing `out`: stick mx/mz toward
the dribble direction (sprint in space, not when pressed tightly), face/aim then press PASS/LOB/THROUGH/SHOOT and HOLD it
for the ticks that give the wanted power (powerFillTicks), release; aim via the stick (pitch-space) or a gesture TAP with
gSlot for an exact receiver (allowed: the same frame a human could produce), finesse/chip modifiers, SHIELD when pressed
with no option, clear (LOB long) when in danger in own third. Reaction delay: when the situation changes (brain.seenOwner)
wait reactionTicks before the first decision. Never read human inputs (only state).
Tests: in scripted situations the CPU passes to an open teammate, shoots from good positions, dribbles into space, clears
under pressure; frames only (no direct state writes); evaluation staggering; determinism; bot-v-bot quick runs produce
passes and shots (report rough stats with the current modules).
