# TAI-10 — CPU shooting, dribbling and skill choices
Owns: `src/ai/cpu/shooting.ts`. Spec: BRIEF §7 CPU opponent ("shoot (an expected-goal estimate from distance, angle,
pressure and keeper position)", dribble into space, skill move), team styles, shot targets 14-26 per match and goals
2.0-3.6.
Implement `estimateXg(s, slot, x, z)` (distance and visible goal angle, defenders blocking the lane, pressure, keeper
off his line, weak foot/attributes mildly; calibrated so typical box shots 0.08-0.35, long shots 0.02-0.05, one-on-ones
0.35-0.6), `bestDribble(s, slot, out)` (sample 8-12 directions, score space ahead, progress, distance from opponents,
staying on the pitch), `chooseSkill(s, slot)` (only with skillMoves stars allowing it, when a defender is close in front
and space exists beside/behind him).
Tests: xG monotonic with distance/angle, blocked shots lower, dribble avoids defenders and touchlines, skill choice gated
by stars, determinism, budget (< 0.05 ms).
