# TAI-01 — Formations and home positions
Owns: `src/ai/shape.ts`. Spec: BRIEF §7 Team shape ("Formations: 4-4-2, 4-3-3, 4-2-3-1, 3-5-2, 5-3-2 and 4-1-2-1-2. Each
role has a home position that shifts with the ball, the team phase (build-up, attack, defend, transition) and the
tactical focus."), data/formations.ts (DAT-04 refines), T_AI.shapeInterval.
Implement `updateShape(s, team, ev)` (staggered: team.shapeT counts down; team 0 and 1 offset by half the interval)
and `homePosition(s, team, formIdx, out)`:
- From the formation slot (nx, nz) compute the base position for the team's attack direction; then shift: the whole
  block slides toward the ball laterally (compactness: width shrinks on the ball side), vertically with ball x and the
  team phase (higher in attack/build-up from the back, deeper when defending), defensive line height from TAI-04's
  team.lineX when set, tactical focus (DEFENDING deeper/narrower, ATTACKING higher), quick tactics (extraStriker pushes
  a midfielder up, getInBox pushes wide players inside the box when crossing), teams playing short (stretch the
  remaining roles; keep exactly one keeper). Clamp inside the pitch, outside own goal area for outfielders.
- Write team.homeX/homeZ[formIdx] and each active player's homeX/homeZ (by p.formIdx). Players' formIdx stays fixed
  through substitutions. Jobs: use ai/jobs.ts assignJob(s, slot, job, x, z, speedMps, targetSlot) — it only overrides lower-or-equal priority jobs (AiJob order); TAI-07 executeJobs turns the final job into arrival steering. Read team.phase (TAI-06), player.homeX/homeZ (TAI-01), ball, query helpers. Mirror everything by team.dir.
Tests: each formation's base shape mirrors correctly for dir = -1, shifts with ball x/z, phase and focus, compact
lines (distance between lines <= lineSpacingMax), short-handed shapes, staggering determinism. Budget < 0.03 ms/tick.
