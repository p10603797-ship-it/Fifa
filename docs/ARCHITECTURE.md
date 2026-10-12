# DotKick architecture

DotKick is an original 11-a-side football game that runs in Safari on iPad (touch + controllers), built with
TypeScript (strict), Vite, Three.js (WebGL2), DOM/CSS menus, Web Audio, and PeerJS for online 1v1.
The full product brief is `docs/BRIEF.md` (sections are referenced as §N below).

## Layers

```
            +-------------------- app/ (boot, router, loop, session) ------------------+
            |                                                                            |
 input/ --> InputFrame[] --> sim/step.ts (deterministic, 60 Hz) --> SimState + events --+--> render/ (Three.js)
 (touch,     (one per human)    ^   uses ai/ (team AI, CPU brains)                       +--> ui/hud (DOM)
  pads,                         |                                                        +--> audio/ (Web Audio)
  keyboard,  net/ (lockstep) ---+                                                        +--> modes/stats
  replay)                                                                                +--> net (hash exchange)
```

* `src/contracts/` — frozen shared types, constants, enums, tuning, state layout and interfaces (lead-owned).
* `src/sim/` — the deterministic match simulation. Pure functions over `SimState`.
* `src/ai/` — team AI and CPU controllers. Runs inside the sim tick, same determinism rules as sim.
* `src/input/` — touch, gamepad, keyboard -> `InputFrame`.
* `src/render/` — Three.js scene, procedural players and animation, cameras, effects, replays.
* `src/ui/` — DOM menus and HUD, the Dot design system.
* `src/audio/` — Web Audio engine with synthesised sounds.
* `src/net/` — lockstep, PeerJS transport, lobby. Nothing else depends on it.
* `src/modes/` — Kick-Off, Cup, Shoot-out, Practice flows and match stats.
* `src/data/` — clubs, players, formations (generated, committed).
* `src/platform/` — PWA, storage, iPadOS hardening, diagnostics, recovery.
* `src/app/` — boot, screen router, game loop, match session.

## Hard rules (§4)

1. **Deterministic fixed-step simulation.** `step(state, humanFrames, events)` advances one 1/60 s tick. The same
   seed and input stream give a bit-identical `hashState` in every engine.
   * Inside `src/sim` and `src/ai`: no `Math.random` (use `sim/core/rng.ts` with `s.rng`), no clocks, no DOM,
     no Three.js, no Map/Set iteration, no `Math.sin/cos/tan/atan2/pow/exp/log` (use `sim/core/dmath.ts`).
     ESLint enforces this (`eslint.config.js`).
   * State is plain data (`contracts/state.ts`): flat objects of finite numbers (booleans as 0/1) and
     fixed-length arrays. `config` and `squads` are immutable and shared by reference.
2. **One input format.** Every device produces an `InputFrame` (`contracts/input.ts`) per tick: quantised axes
   in pitch space, positional-semantic button bits (`Btn`), explicit power/curve, skill, command and gesture
   fields. Holds, double-taps, combos and power bars are resolved inside the sim from button edges.
3. **Sim owns timing, render follows.** Every action is a sim state with fixed wind-up/contact/recovery ticks.
   Animation is derived from sim state and never feeds back.
4. **Events out, nothing back in.** Each tick emits flat numeric events (`contracts/events.ts`) into a
   preallocated buffer. Audio, HUD, effects, camera, stats, rumble consume them.
5. **Loop.** rAF adds real elapsed time (clamped to 100 ms) to an accumulator; run 0-3 ticks; render by
   interpolating between the previous and current state (`copyState` before each tick). Same speed at 60/120 Hz.
6. **Tuning lives in data.** `contracts/tuning.ts` holds every gameplay constant with units.
7. **Debug tools ship** behind a hidden toggle (frame graph, sim/render ms, draw calls, input viewer, state hash,
   replay save/load).

Units: metres, seconds. Origin at the centre spot; x along the length, z across (+z toward the broadcast camera),
y up. Pitch 105 x 68. Home attacks +x in the first half (`team.dir`). Facing +x, a player's right is +z.

## The tick pipeline (`src/sim/step.ts`)

| # | Stage | Owner(s) | What it does |
|---|---|---|---|
| 1 | `cpuThink` | ai/cpu (TAI-08..13) | CPU brains write `teams[t].cpu.out` (an InputFrame) |
| 2 | `resolveControllers` | SIM-15, SIM-16 | edges/holds/power/buffer, context -> actions, switching, commands, set-piece input routing |
| 3 | `teamAiTick` | ai (TAI-01..07, 13, 14), keeper (GKP) | jobs blackboard -> movement intents for every uncontrolled player; keepers |
| 4 | `actionsTick` | registry -> owners | per-action handlers; kicks launch the ball at their contact tick via `KICK_SOLVERS` + `applyKick` |
| 5 | `locomotionTick` | SIM-04 | integrate players from intents (accel, turn rate, sprint, jockey, stamina) |
| 6 | `bodyContactTick` | SIM-05 | soft-circle collisions, shielding |
| 7 | `ballTick` | SIM-01/02/03 | flight, bounce/roll, posts/bar/net/boards, swept line crossing (`ball.cross`) |
| 8 | `contactsTick` | GKP-02, SIM-12, SIM-14, SIM-07, SIM-06 | ball contacts in fixed priority, one per tick |
| 9 | `rulesTick` | RUL-01..10 | offside, fouls/advantage, goals/out -> restarts, restart phases, shoot-out, subs, clock |
| 10 | `watchdogTick` | RUL-11 | safety net: phase timeouts, idle ball, action overruns |

All ball contacts go through `sim/core/kick.ts` (`applyKick`, `takePossession`, `releasePossession`,
`recordTouch`) so last-touch, possession, pass-target, shot and restart-taken bookkeeping stays consistent.

### Actions
`p.act` (ActionKind) + `p.actT/actDur/actContact/actDone` and parameters. `sim/actions/dispatch.ts` increments
`actT`, calls the owner's `ActionHandler.update`, and ends the action when `actT >= actDur` (unless charging).
Starters (`startPass`, `startShot`, `startTackle`, ...) validate and call `beginAction`. Kicks share one KICK
handler (SIM-08) that calls `KICK_SOLVERS[p.actKick]` at contact.

### AI jobs
`ai/jobs.ts`: each tick every uncontrolled outfield player gets `HOLD_SHAPE` at his home position; modules call
`assignJob` which only overrides lower-or-equal priority jobs (`AiJob` order); `ai/steer.ts executeJobs` turns
the final job into arrival steering. Keepers run their own pipeline (`sim/keeper/index.ts`).

### Controllers
`s.ctrl[0..1]` are humans (P1 ember, P2 cyan), `s.ctrl[2..3]` CPU brains for team 0/1. Each controls one
player (`ctrl.slot`, `p.ctrl`). CPU brains produce InputFrames — the same format as humans — and never read
human inputs.

### Restarts
`awardRestart(kind, team, x, z)` (RUL-11) fills `match.restart`, calls the kind's `*Setup`, and sets the
phase. During a restart phase the resolver hands frames to `SETPIECE_INPUT[kind]`; when the taker plays the
ball `applyKick` sets `restart.taken` and the rules return to `IN_PLAY`. Legal transitions:
`contracts/transitions.ts`.

## Outside the sim

* **App loop** (`src/app/loop.ts`): one rAF loop drives everything; accumulator; `TickInputProvider` supplies
  human frames (local devices or online lockstep); after each tick: events -> renderer, HUD, audio, stats;
  render with interpolation. Hidden page: pause, stop the loop, mute; return shows the pause menu.
* **Render** (`src/render/`): `GameRenderer` implementation; instanced body parts for 22 players driven by
  procedural poses (`contracts/render.ts` Pose/AnimId); broadcast camera exposes a `CameraProjector` used by
  touch gestures and HUD anchoring.
* **UI** (`src/ui/`): DOM screens registered with the router (`contracts/app.ts` Screen); HUD parts write to the
  DOM only on change; every screen works by touch alone and by controller alone (FocusNavigator).
* **Net** (`src/net/`): lockstep `TickInputProvider` with input delay, redundancy and hash exchange.

## Build

`npm run build` -> `dist/index.html` (everything inlined via vite-plugin-singlefile) + `manifest.webmanifest`,
`sw.js`, icons from `public/`. The HTML runs without the extras. `npm run verify` = typecheck + lint + unit +
scenario tests + 10-match short soak.
