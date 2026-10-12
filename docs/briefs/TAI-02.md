# TAI-02 — Attacking support play and passing angles
Owns: `src/ai/support.ts`. Spec: BRIEF §7 ("In possession: offer passing triangles, stretch the width, ... Trigger-run
and call-for-support inputs override.").
Implement `assignSupport` and `callSupport`: when the team has the ball, 2-3 teammates near the carrier take SUPPORT
jobs at positions forming triangles/open lanes (not behind an opponent relative to the carrier: score candidate
points around their home position by lane openness and distance 8-20 m), wide players hold width (stay near the
touchline in build-up), a holding midfielder offers a safe back option. callSupport (human R1 tap / CPU): the best
midfielder comes toward the carrier for 2 s — store it in team.supportSlot / team.supportCallT (count down each tick).
Jobs: use ai/jobs.ts assignJob(s, slot, job, x, z, speedMps, targetSlot) — it only overrides lower-or-equal priority jobs (AiJob order); TAI-07 executeJobs turns the final job into arrival steering. Read team.phase (TAI-06), player.homeX/homeZ (TAI-01), ball, query helpers. Mirror everything by team.dir.
Tests: support points have open lanes, width kept, call-for-support brings a player within 10 m, no two supporters on
the same spot, staggered evaluation (every 4-8 ticks) deterministic. Budget < 0.05 ms/tick.
