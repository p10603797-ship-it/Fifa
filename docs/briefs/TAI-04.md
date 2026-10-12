# TAI-04 — Defensive shape and back-line control
Owns: `src/ai/defshape.ts`. Spec: BRIEF §7 ("Out of possession: stay compact, hold and step the back line together,
... mark zones and passing lanes"), quick tactic offside trap (team.offsideTrap).
Implement `assignDefensiveShape`: when not in possession (or ball loose and the opponent is closer), compute the back
line height team.lineX (step up when the ball goes back/sideways, drop when the carrier faces forward unpressured or a
runner is in behind, never deeper than the 6-yard box edge when the ball is far), keep the back line level (all
defenders' x close to lineX, small stagger toward the ball side), compact midfield line 8-14 m ahead, zonal MARK jobs
on attackers entering a defender's zone, cover passing lanes into the box, offside trap: step up together on a
backward pass. Jobs: use ai/jobs.ts assignJob(s, slot, job, x, z, speedMps, targetSlot) — it only overrides lower-or-equal priority jobs (AiJob order); TAI-07 executeJobs turns the final job into arrival steering. Read team.phase (TAI-06), player.homeX/homeZ (TAI-01), ball, query helpers. Mirror everything by team.dir.
Tests: line flatness (std dev of defender x < 1.5 m in settled defence), steps up/drops correctly, compactness,
offside trap catches a scripted runner, marks attackers in zones, both directions. Budget < 0.05 ms/tick.
