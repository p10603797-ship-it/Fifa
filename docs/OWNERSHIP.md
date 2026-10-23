# File ownership

Rule: exactly one assignment owns each file. Nobody edits a file they do not own. Shared contracts
(`src/contracts/**`, `src/sim/step.ts`, `src/sim/init.ts`, `src/sim/contacts.ts`, `src/sim/actions/**`,
`src/sim/core/kick.ts`, `src/sim/core/query.ts`, `src/ai/index.ts`, `src/ai/jobs.ts`, `src/ai/cpu/index.ts`,
`src/sim/keeper/index.ts`, this file and `docs/BRIEF.md`) change only through the lead: send a change request
in your report. Tests: every assignment owns `tests/**/<ID-lowercase>-*.test.ts` files it creates (e.g.
`tests/unit/sim-04-locomotion.test.ts`, `tests/scenario/rul-08-offside.test.ts`). New helper files are allowed
inside your own folder if named in your report (e.g. `src/sim/control/resolveAttack.ts` for SIM-15).

Tuning: add new constants to a `const LOCAL_TUNING = { ... } // TUNING-CR` block in your own file and list them
in the report; the lead moves them into `contracts/tuning.ts` between waves.

## Lead (orchestrator)
`src/contracts/**`, `src/sim/step.ts`, `src/sim/init.ts`, `src/sim/contacts.ts`, `src/sim/actions/dispatch.ts`,
`src/sim/actions/registry.ts`, `src/sim/core/kick.ts`, `src/sim/core/query.ts`, `src/sim/core/events.ts`,
`src/ai/index.ts`, `src/ai/jobs.ts`, `src/ai/cpu/index.ts`, `src/sim/keeper/index.ts`, `src/sim/control/handoff.ts`
(D-019), `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`,
`eslint.config.js`, `docs/*.md` except where listed below.

## Wave 0 — Foundations

| Id | Owns |
|---|---|
| FND-01 | toolchain (done by lead): package.json scripts, configs |
| FND-02 | contracts (done by lead): `src/contracts/**`, sim/ai skeleton stubs |
| FND-03 | `src/sim/core/{rng,dmath,vec,hash,clone,serialize}.ts`; tests for those + `kick.ts`, `query.ts`, `events.ts` |
| FND-04 | `src/main.ts`, `index.html`, `src/app/**`, `src/ui/**` (screen + HUD stubs, router registration), `src/audio/**` (engine stub), `src/platform/**` (stubs + minimal storage), `src/modes/**` (stubs), `src/net/**` (stubs), `public/**` (placeholder manifest/sw/icons) |
| FND-05 | `src/render/**` (renderer skeleton + per-module stubs + `render/types.ts`), `src/input/**` (minimal touch stick, pad, keyboard sources, device registry, per-module stubs) |
| FND-06 | `tools/**` (headless runner, soak, fuzz, bench, replay inspector, postbuild; helpers `tools/lib/*`), `tests/harness/**` (invariant checker, scenario helpers), `src/sim/replay.ts` (replay record/playback, pure data), `src/sim/debug/invariants.ts` (invariant checker, shared by tests and the debug build), `src/platform/benchHook.ts` |

After Wave 0 every stub file below exists with its exported signatures; Wave 1 owners implement them.
Frozen after Wave 0 (lead-owned): `src/render/types.ts`, `src/render/index.ts` (orchestrator), `src/audio/types.ts`,
`src/input/axes.ts`, `src/input/touch/index.ts` wiring is TCH-07's, `src/app/**` and `src/ui/index.ts`,
`src/ui/hud/index.ts`, `src/ui/screens/match.ts` (owned by the INT wave; change requests to the lead in Wave 1).

## Wave 1 — Build squads

### SIM (sim core)
| Id | Owns |
|---|---|
| SIM-01 | `src/sim/ball/flight.ts` |
| SIM-02 | `src/sim/ball/contact.ts` |
| SIM-03 | `src/sim/pitch/geometry.ts` |
| SIM-04 | `src/sim/players/locomotion.ts` |
| SIM-05 | `src/sim/players/bodies.ts` |
| SIM-06 | `src/sim/players/possession.ts` |
| SIM-07 | `src/sim/players/firstTouch.ts` |
| SIM-08 | `src/sim/kicks/pass.ts` |
| SIM-09 | `src/sim/kicks/lob.ts` |
| SIM-10 | `src/sim/kicks/through.ts` |
| SIM-11 | `src/sim/kicks/shot.ts` |
| SIM-12 | `src/sim/kicks/aerial.ts` |
| SIM-13 | `src/sim/kicks/skills.ts` |
| SIM-14 | `src/sim/defend/tackle.ts` |
| SIM-15 | `src/sim/control/resolve.ts` (+ `src/sim/control/resolve*.ts` helpers) |
| SIM-16 | `src/sim/control/switching.ts` (split from SIM-15, see DECISIONS D-006) |

### RUL (rules)
| Id | Owns |
|---|---|
| RUL-01 | `src/sim/rules/machine.ts` |
| RUL-02 | `src/sim/rules/throwin.ts` |
| RUL-03 | `src/sim/rules/goalkick.ts` |
| RUL-04 | `src/sim/rules/corner.ts` |
| RUL-05 | `src/sim/rules/freekick.ts` |
| RUL-06 | `src/sim/rules/penalty.ts` |
| RUL-07 | `src/sim/rules/shootout.ts` |
| RUL-08 | `src/sim/rules/offside.ts` |
| RUL-09 | `src/sim/rules/fouls.ts` |
| RUL-10 | `src/sim/rules/subs.ts` |
| RUL-11 | `src/sim/rules/restart.ts`, `src/sim/rules/watchdog.ts` |

### GKP (goalkeepers)
| Id | Owns |
|---|---|
| GKP-01 | `src/sim/keeper/positioning.ts` |
| GKP-02 | `src/sim/keeper/saves.ts` |
| GKP-03 | `src/sim/keeper/sweeper.ts` |
| GKP-04 | `src/sim/keeper/distribution.ts` |
| GKP-05 | `src/sim/keeper/handling.ts` |
| GKP-06 | `src/sim/keeper/setpieces.ts` |

### TAI (team AI and CPU)
| Id | Owns |
|---|---|
| TAI-01 | `src/ai/shape.ts` |
| TAI-02 | `src/ai/support.ts` |
| TAI-03 | `src/ai/runs.ts` |
| TAI-04 | `src/ai/defshape.ts` |
| TAI-05 | `src/ai/press.ts` |
| TAI-06 | `src/ai/transition.ts` |
| TAI-07 | `src/ai/steer.ts` |
| TAI-08 | `src/ai/cpu/carrier.ts` |
| TAI-09 | `src/ai/cpu/passing.ts` |
| TAI-10 | `src/ai/cpu/shooting.ts` |
| TAI-11 | `src/ai/cpu/defending.ts` |
| TAI-12 | `src/ai/cpu/levels.ts`, `tools/ladder.ts` |
| TAI-13 | `src/ai/setpieces.ts` |
| TAI-14 | `src/ai/tactics.ts` |

### TCH (touch input) — files created as stubs by FND-05
| Id | Owns |
|---|---|
| TCH-01 | `src/input/touch/pointers.ts` |
| TCH-02 | `src/input/touch/stick.ts` |
| TCH-03 | `src/input/touch/button.ts` (generic touch button), `src/input/touch/attack.ts` |
| TCH-04 | `src/input/touch/cluster.ts` (defence/keeper sets, attack-defence swap, CLEAR) |
| TCH-05 | `src/input/touch/gestures.ts` |
| TCH-06 | `src/input/touch/setpiece.ts` |
| TCH-07 | `src/input/touch/mapper.ts`, `src/input/touch/index.ts` |
| TCH-08 | `src/input/touch/editor.ts` |
| TCH-09 | `src/input/touch/overlay.ts`, `src/input/touch/overlay.css` |

### PAD (controllers, keyboard, menu navigation)
| Id | Owns |
|---|---|
| PAD-01 | `src/input/pad/manager.ts`, `src/input/devices.ts` |
| PAD-02 | `src/input/pad/mapper.ts` (+ attack/shooting/movement row tests) |
| PAD-03 | `src/input/pad/reconnect.ts` (+ defence/keeper row tests) |
| PAD-04 | `src/input/pad/sequences.ts` (D-pad tactics, combos at device level) |
| PAD-05 | `src/input/pad/rightStick.ts` |
| PAD-06 | set-piece row tests (`tests/controls/pad-06-*.test.ts`) |
| PAD-07 | `src/input/pad/glyphs.ts`, `src/input/pad/rumble.ts`, `src/ui/screens/remap.ts` |
| PAD-08 | `src/input/keyboard.ts`, `src/input/focus.ts`, `src/input/menuInput.ts`, `docs/KEYBOARD.md` |

### GFX (rendering) — files created as stubs by FND-05
| Id | Owns |
|---|---|
| GFX-01 | `src/render/renderer.ts` |
| GFX-02 | `src/render/quality.ts` |
| GFX-03 | `src/render/pitch.ts` |
| GFX-04 | `src/render/goals.ts` |
| GFX-05 | `src/render/stadium.ts` |
| GFX-06 | `src/render/crowd.ts` |
| GFX-07 | `src/render/players/model.ts` |
| GFX-08 | `src/render/kits.ts` |
| GFX-09 | `src/render/anim/locomotion.ts` |
| GFX-10 | `src/render/anim/actions.ts` |
| GFX-11 | `src/render/anim/contact.ts` |
| GFX-12 | `src/render/anim/mapper.ts` |
| GFX-13 | `src/render/ball.ts`, `src/render/markers.ts` |
| GFX-14 | `src/render/camera/broadcast.ts`, `src/render/camera/project.ts` |
| GFX-15 | `src/render/camera/cinematic.ts` |
| GFX-16 | `src/render/replay.ts`, `src/render/effects.ts` |

### UIX (menus and HUD) — files created as stubs by FND-04
| Id | Owns |
|---|---|
| UIX-01 | `src/ui/tokens.css`, `src/ui/components.ts`, `src/ui/components.css`, `src/ui/dotfield.ts`, `src/ui/fonts.ts` |
| UIX-02 | `src/ui/screens/splash.ts`, `src/ui/screens/main.ts` |
| UIX-03 | `src/ui/screens/teamSelect.ts` |
| UIX-04 | `src/ui/screens/sideSelect.ts` |
| UIX-05 | `src/ui/screens/matchSettings.ts`, `src/ui/screens/loading.ts`, `src/ui/screens/modeSetup.ts` |
| UIX-06 | `src/ui/hud/scoreboard.ts`, `src/ui/hud/toasts.ts` |
| UIX-07 | `src/ui/hud/radar.ts`, `src/ui/hud/playerInfo.ts`, `src/ui/hud/powerBar.ts` |
| UIX-08 | `src/ui/screens/pause.ts` (pause menu + team management) |
| UIX-09 | `src/ui/screens/settings.ts` |
| UIX-10 | `src/ui/screens/halfTime.ts`, `src/ui/screens/fullTime.ts` |
| UIX-11 | `src/ui/screens/cup.ts`, `src/ui/screens/practice.ts` |
| UIX-12 | `src/ui/screens/tutorial.ts`, `src/ui/hud/hints.ts` |

### AUD (audio) — stubs by FND-04
| Id | Owns |
|---|---|
| AUD-01 | `src/audio/engine.ts` (`src/audio/types.ts` is frozen; change via the lead) |
| AUD-02 | `src/audio/crowd.ts` |
| AUD-03 | `src/audio/sfx.ts` |
| AUD-04 | `src/audio/whistles.ts` |
| AUD-05 | `src/audio/ui.ts`, `src/audio/eventMap.ts` |

### DAT (data)
| Id | Owns |
|---|---|
| DAT-01 | `tools/gen-data.ts`, `src/data/clubs.ts`, `src/data/clubs.generated.ts`, `src/data/names.ts` |
| DAT-02 | `src/data/playerGen.ts` (used by gen-data), name screening list `src/data/screen.ts` |
| DAT-03 | `src/data/kits.ts` |
| DAT-04 | `src/data/formations.ts`, `src/data/tactics.ts` |
| DAT-05 | `tests/sim/dat-05-*.test.ts`, `tools/balance.ts`, `docs/ATTRIBUTE_AUDIT.md` |

### NET (online)
| Id | Owns |
|---|---|
| NET-01 | `src/net/lockstep.ts` |
| NET-02 | `src/net/transport.ts`, `src/net/config.ts`, `src/net/types.ts`, `src/net/memoryTransport.ts` |
| NET-03 | `src/net/lobby.ts`, `src/net/roomCode.ts` |
| NET-04 | `src/net/adaptive.ts` |
| NET-05 | `src/net/desync.ts` |
| NET-06 | `src/net/session.ts` |
| NET-07 | `src/ui/screens/online.ts` |
| NET-08 | `tools/netsim.ts`, `tests/net/**` |

### MOD (modes)
| Id | Owns |
|---|---|
| MOD-01 | `src/modes/kickoff.ts`, `src/modes/setup.ts` |
| MOD-02 | `src/modes/cup.ts` |
| MOD-03 | `src/modes/shootout.ts` |
| MOD-04 | `src/modes/practice.ts` |
| MOD-05 | `src/modes/stats.ts`, `src/modes/records.ts` |

### PLT (platform)
| Id | Owns |
|---|---|
| PLT-01 | `public/manifest.webmanifest`, `public/sw.js`, `public/icons/**`, `src/platform/pwa.ts`, `tools/gen-icons.mjs` |
| PLT-02 | `src/platform/ipados.ts`, `src/platform/viewport.css` |
| PLT-03 | `src/platform/storage.ts`, `src/platform/settingsStore.ts` |
| PLT-04 | `tools/postbuild.mjs`, `tools/size-check.ts`, `src/ui/fonts/**` (subsetted fonts) |
| PLT-05 | `src/platform/recovery.ts`, `src/ui/screens/diagnostics.ts`, `src/ui/screens/recovery.ts`, `src/platform/diagnostics.ts`, `src/ui/debugOverlay.ts`, `src/platform/replayRecorder.ts` |
| PLT-06 | `README.md`, `docs/ASSETS.md`, `docs/DEVICE_CHECKLIST.md`, `docs/DEPLOY.md`, `.github/workflows/pages.yml` |

Waves 2-5 (INT, QA, FIX, SGN) own the files named in their briefs; fixes go to the owner area's FIX agent. From
Wave 3 the merged QA+fix agents QF-1..QF-17 (D-020) fix defects in the files of their charter area, so a file's last
editor may be its area's QF agent; the Wave 1 owner above stays the reference for who answers for it.

## Helper files added after Wave 0

Allowed helper files (named in their authors' reports), with the assignment that owns each. Glob entries above already
cover `src/app/**` (FND-04, then the INT wave; the entry point `src/main.ts` goes with it), `src/sim/core/*` (FND-03), `src/sim/control/resolve*.ts` (SIM-15) and
`tools/**` (FND-06 unless named).

| File | Owner | What it is |
|---|---|---|
| `src/sim/kicks/passHooks.ts`, `lobHooks.ts`, `throughHooks.ts`, `shotHooks.ts`, `aerialHooks.ts`, `skillsHooks.ts` | SIM-08, -09, -10, -11, -12, -13 | import-cycle-safe shells of the module's action handlers and kick solvers (read by `sim/actions/registry.ts`) |
| `src/sim/defend/tackleHooks.ts`, `src/sim/players/firstTouchHooks.ts`, `src/sim/players/bodiesShield.ts` | SIM-14, SIM-07, SIM-05 | the same for tackles / clearances and the first touch; shield starters |
| `src/sim/keeper/saveKinematics.ts`, `sweeperHooks.ts`, `handlingHooks.ts` | GKP-02, GKP-03, GKP-05 | save kinematics and the dive / catch handlers; rush / punch and handling shells |
| `src/sim/rules/restartCommon.ts`, `throwinHooks.ts`, `freekickHooks.ts` | RUL-11, RUL-02, RUL-05 | shared restart helpers and the SET_PIECE handler; throw-in and wall-jump handler shells |
| `src/sim/kicks/kickCommon.ts` | QF-10 | foot-kick contact rules shared by the KICK and SHOT handlers (charged release, reach, set-piece line-up) |
| `src/sim/rules/practice.ts` | QF-1 (from MOD-04) | practice rules inside the sim (`practiceRulesTick`, `preparePracticeState`) |
| `src/audio/bank.ts`, `services.ts`, `voices.ts` | AUD-01 | pre-rendered sound buffers, engine services for the sound modules, voice limiting |
| `src/audio/dsp.ts` | AUD-02..05 | synthesis toolkit for the sound modules |
| `src/net/packet.ts` | NET-02 | wire codecs and `NET_PROTOCOL_VERSION` |
| `src/platform/info.ts` | PLT-02 | platform detection (iPad, standalone, fullscreen, safe areas) |
| `src/platform/licences.ts` | QF-5 | credits and licence notice at run time (reads the comment `tools/postbuild.mjs` writes) |
| `src/render/anim/poseMath.ts` | GFX-09..12 | pose maths shared by the animation modules |
| `src/render/anim/reach.ts`, `src/render/players/drawn.ts` | QF-4 | ball-contact reach for the animator; drawn-position offsets of each player |
| `src/render/kit/colour.ts`, `crest.ts`, `glyphs.ts`, `raster.ts` | GFX-08 | kit colour maths, crests, shirt-number digits, the kit atlas rasteriser |
| `src/render/players/fk.ts`, `parts.ts` | GFX-07 | skeleton / forward kinematics and body-part geometry |
| `src/render/uniformCache.ts`, `src/render/warmScript.ts` | QF-7R | allocation-free uniform uploads; render JIT warm-up script |
| `src/app/blockers.ts` | QF-5 | reasons a match may not run (one session flag) |
| `src/app/liveState.ts` | QF-7R | the second live state the renderer interpolates from |
| `src/ui/palette.ts` | UIX-01 | Dot palette derivation |
| `src/ui/hud/hudShared.ts` | UIX-06 / UIX-07 / UIX-12 | helpers shared by the HUD parts |
| `src/ui/hud/controlGlyphs.ts`, `src/ui/screens/tutorialSteps.ts` | UIX-12 | control glyphs for hints and the tutorial; tutorial steps |
| `src/ui/screens/matchFlow.ts` | UIX-05 (with UIX-03/04) | local pre-match flow shared by the flow screens |
| `src/ui/screens/sideAssign.ts` | UIX-04 | side assignment model behind side select |
| `tools/hash-table.ts` | TUN-7S | behaviour-identity hash table for refactors |

## Documents

| File | Owner |
|---|---|
| `docs/BRIEF.md`, `docs/DECISIONS.md`, `docs/STATUS.md`, `docs/ARCHITECTURE.md`, this file | lead (SGN-06 updated ARCHITECTURE and OWNERSHIP to the final tree) |
| `docs/CONTRACTS.md` | SGN-06 (written in Wave 5; the lead keeps it current with every contract change) |
| `docs/TUNING.md` | INT-A, then each QF agent's tuning section (TUN-1, TUN-2 for the moves) |
| `docs/KEYBOARD.md` | PAD-08 |
| `docs/ATTRIBUTE_AUDIT.md` | DAT-05 (refreshed by QF-11) |
| `docs/ASSETS.md`, `docs/DEVICE_CHECKLIST.md`, `docs/DEPLOY.md`, `README.md` | PLT-06 (the ASSETS originality and licence audit section SGN-05; docs audit SGN-06) |
| `docs/KNOWN_ISSUES.md`, `docs/INTEGRATION_ISSUES.md` | lead (entries from the QF agents) |
| `docs/TEST_REPORT.md` | SGN-01 |
| `docs/CONTROLS_AUDIT.md` | SGN-02 |
| `docs/PERF_REPORT.md` | QF-7 / QF-7R, final numbers SGN-04 |
