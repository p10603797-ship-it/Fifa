# SIM-01 — Ball flight
Owns: `src/sim/ball/flight.ts`. Spec: BRIEF §6 Ball, §4 rule 1, T_BALL in contracts/tuning.ts.
Why: every pass, cross, shot and keeper decision depends on believable flight and on predictions that match
the sim exactly (AI, keepers and receivers read predictBall).

Implement:
- `ballAirStep(b, dt)`: gravity, quadratic air drag a = -dragK*|v|*v, Magnus a = magnusK*(spin x v) (spin in rad/s,
  world axes; sy = curl about the vertical axis: positive sy with vx > 0 curls toward -z or +z — define it, document
  it, and keep SIM-11 finesse/SIM-09 crosses consistent: state it in your report), spin decay in air. Use a
  stable integrator (semi-implicit Euler or midpoint) — it is called per substep by SIM-02.
- `predictBall(b, ticks, out)`: copy b into a module-level scratch BallState and call SIM-02's
  `ballStepTick(scratch, null)` per tick, so predictions equal the sim bit-for-bit for a free ball; landIndex =
  first sample at or below 0.5 m while descending after having been above it.
- `groundPassSpeed(dist, arriveSpeed)`: launch speed so a rolled ball arrives at dist with ~arriveSpeed; analytic
  from SIM-02's roll model constants (rollDecel, rollDamping) and calibrated by a test against simulation (error < 5%).
- `solveLaunch(dx, dz, angle, out)`: velocity for a lofted ball launched at `angle` that FIRST LANDS at horizontal
  offset (dx, dz) including drag (iterate a few times, fixed iteration count, deterministic). Return speed.
- `ticksToHeight(b, h)`: ticks until an airborne ball descends to height h (simulate with scratch; cap 300).
- Reference feel to verify by tests: 15 m/s ground pass rolls ~30 m; hard shot 25-36 m/s; a 45-60 m goal kick is
  reachable at <= 30 m/s; bounce height roughly halves each bounce (with SIM-02); a 9 rad/s curl bends a 25 m
  free kick 2-4 m sideways; backspin (chip) floats.
Tests: `tests/unit/sim-01-*.test.ts` — physics sanity, the reference feel numbers, predict == actual (run
ballTick on a state and compare with predictBall, bit-exact), solver accuracy (landing within 0.5 m), determinism.
Budget: predictBall(120 ticks) < 0.1 ms; zero allocation.
