# TAI-09 — CPU pass, cross and through-ball evaluation
Owns: `src/ai/cpu/passing.ts`. Spec: BRIEF §7 CPU opponent (pass candidates scored by completion chance, progress,
danger created; through balls; crosses).
Implement `scorePassOptions(s, slot, out)` and `laneSafety(...)` (+ `createPassOptions`):
- For each active teammate: ground pass option (speed from SIM-01 groundPassSpeed for the distance), completion chance =
  laneSafety along the path (for every opponent: can he reach a point on the lane before the ball? use SIM-04 ticksToReach
  approximations — keep it cheap: closest-approach geometry with reaction time), receiver pressure at arrival,
  distance penalty; progress (metres toward goal), danger (xG-ish of the receiving spot, behind the defensive line bonus).
  Through-ball option for forward runners (SIM-10 throughLeadPoint), lob option over a blocked lane, cross options when
  the carrier is in the crossing zone (SIM-09 crossTarget for near/far/penalty spot with attacker presence).
- Score = weighted sum (weights from the caller's style); write into out[] and return count. Allocation-free, < 0.15 ms
  for a full scan; callers stagger scans.
Tests: blocked lanes score low, open forward passes score high, through balls only to runners, crosses only in the zone,
determinism, budget.
