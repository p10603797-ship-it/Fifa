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
`src/ai/index.ts`, `src/ai/jobs.ts`, `src/ai/cpu/index.ts`, `src/sim/keeper/index.ts`, `package.json`,
`tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.js`, `docs/*.md`
except where listed below.

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

Waves 2-5 (INT, QA, FIX, SGN) own the files named in their briefs; fixes go to the owner area's FIX agent.
