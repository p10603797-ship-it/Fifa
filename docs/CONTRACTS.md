# Contracts

The shared types, constants and interfaces every module codes against live in `src/contracts/` (BRIEF §4, §16).
They were written by the lead in Wave 0 (FND-02, DECISIONS D-010) and are lead-owned. This page says what each file
defines, the rule that keeps them frozen, and every change the lead made to them, with the decision id where
`docs/DECISIONS.md` records one. Layers, the tick pipeline and the determinism rules are in `docs/ARCHITECTURE.md`;
who owns which file is in `docs/OWNERSHIP.md`; tuning values and their history are in `docs/TUNING.md`.

Import from the file (`../contracts/state`) or from the barrel `src/contracts/index.ts`, which re-exports all of them.

## The frozen-contract rule

1. **Only the lead edits `src/contracts/**`** (OWNERSHIP.md, `docs/briefs/_COMMON.md`). An agent that needs a change
   puts an exact change request (a proposed diff) in its report; the lead applies it between batches and records the
   decision in `docs/DECISIONS.md` when it changes behaviour or a cross-module interface.
2. **After Wave 0, exported names and signatures never change in place.** A change adds: a new optional interface
   member, a new enum member or event type, a new state field with its factory default. Nothing is renamed or
   removed. (During Wave 0 the lead still adjusted meanings, see changes 2-5 below.)
3. **Numeric values are part of the replay and network format.** Enum members (`enums.ts`) and event types
   (`events.ts`) are appended at the end and never renumbered. The field order of the factory functions in
   `state.ts` is the hash and serialise order (`sim/core/hash.ts`, `sim/core/serialize.ts`).
4. **State stays plain data** (`state.ts` header): finite numbers, booleans as 0/1, fixed-length arrays, no Map/Set,
   class instances, closures or strings in mutable state. `config` and `squads` are immutable for a match and shared
   by reference between clones (`IMMUTABLE_STATE_KEYS`).
5. **`SIM_VERSION`** (`constants.ts`) is bumped when sim behaviour changes in a way that breaks saved replays or online
   compatibility with a build already in players' hands. It travels in replays (`sim/replay.ts`,
   `platform/replayRecorder.ts`), the online hello (`net/lobby.ts`) and the net protocol id (`net/packet.ts`). No build
   has shipped yet, so it is still 1; online peers also compare `GAME_VERSION` and `NET_PROTOCOL_VERSION`.
6. **`tuning.ts` is the one contract file that keeps growing.** Agents add constants in a local block marked with the
   change-request marker of `_COMMON.md`; the lead moves them into `tuning.ts` between waves. Since TUN-1 and TUN-2
   every sim, AI, input and modes gameplay constant lives there (TUNING.md "Block index").

## What each file defines

| File | Defines |
|---|---|
| `constants.ts` | `GAME_NAME`, `GAME_VERSION`, `SIM_VERSION`; timing (`TICK_HZ` 60, `DT`, `secToTicks`, `MAX_FRAME_MS`, `MAX_TICKS_PER_FRAME`); squads and slots (`PLAYERS_PER_TEAM`, `SQUAD_SIZE` 18, `NUM_SLOTS` 22, `MAX_SUBS`, `MIN_PLAYERS` 7, `MAX_HUMANS` 2, `NUM_CONTROLLERS` 4, `CPU_CONTROLLER_BASE`, `teamFirstSlot`, `slotTeam`); pitch, goal, area and ball geometry in metres; world bounds and board positions; restart distances; `ownGoalX` / `oppGoalX`; the crossing zone. Units and axes: metres, seconds, origin at the centre spot, +z toward the broadcast camera. |
| `enums.ts` | Every shared enum: `MatchPhase`, `RestartKind`, `Period`, `ActionKind`, `KickKind` (+ `isFootPassKind`, `isShotKind`), `SkillMove`, `GestureKind`, `Command`, `TeamPhase`, `TacticalFocus`, `AiJob`, `Role`, `FormationId`, `TeamStyle`, `Difficulty`, `AssistLevel`, `AutoSwitch`, `ControllerKind`, `CardKind`, `ChallengeOutcome`, `ChallengeKind`, `SaveKind`, `CrossKind`, `ModeId`, `PracticeKind`, `KitPattern`, `KitSlot`, `Foot`, `CameraType`, `QualityTier`, `PadFamily`, `WatchdogReason`. |
| `input.ts` | `InputFrame`, the one input format of every device (D-004, D-011): quantised pitch-space stick axes (`mx`/`mz`, `ax`/`az`), positional-semantic button bits (`Btn`, aliases `BtnAlias`), `power`, `curve`, `skill`, `cmd`/`cmdArg`, pitch-gesture fields (`gesture`, `gx`/`gz`, `gSlot`, `gdx`/`gdz`, `gPower`, `gCurve`, `gFlags`/`GestureFlag`); quantisation (`AXIS_SCALE`, `UNIT_SCALE`, `GESTURE_POS_SCALE`, `quantAxis`, `quantUnit`, `quantPos`); `INPUT_FIELDS`, `createInputFrame` / `clearInputFrame` / `copyInputFrame`; the device side: `InputSource`, `InputSampleContext`, `CameraProjector`. |
| `state.ts` | The sim state layout and its factories: `MatchConfig` / `ControllerConfig` (immutable per match), `RngState`, `BallState`, `PlayerState` + `PlayerAttrs` + `MoveMode`, `ControllerState`, `CpuBrainState` + `CpuPlan`, `TeamState` + `RosterStatus`, `MatchState` with `RestartState`, `AdvantageState`, `OffsideState`, `ChallengeRecord`, `ShootoutState`; the root `SimState` (22 fixed slots, D-007; controllers 0-1 humans, 2-3 CPU brains), `createSimState`, `IMMUTABLE_STATE_KEYS`, `DeepReadonly` / `ReadonlySimState` for consumers outside the sim. Each field names its writer in [brackets]. |
| `events.ts` | `EventType` (flat numeric sim events, 33 types: kicks, bounces, posts, nets, whistles, fouls, cards, offside, saves, goals, substitutions, phase changes, tackles, interceptions, shots, restarts, advantage, forfeit, possession (D-012), watchdog, period end, near misses, skills, aerials, completed passes, switches, keeper hands, attack build-up, body contact, tactics, walls, shoot-out kicks...), `WhistleKind`, `SimEvent`, `EventSink` (what the sim writes into), `EventBuffer` (preallocated, `MAX_EVENTS_PER_TICK` 64). Consumers (audio, HUD, effects, camera, stats, rumble, net, replay) never change sim state. |
| `systems.ts` | The interfaces between sim and AI modules: `SimSystem` / `TeamSystem` stages, `ActionHandler` (per `ActionKind`, registered in `sim/actions/registry.ts`), `ReqFlag` + `ActionRequest`, `KickLaunch` + `KickSolver`, `ActionStarter`, `KickStarter`, `SetPieceInputFn`, `BallPrediction` (`MAX_PREDICT_TICKS` 180), `LevelParams` and `StyleWeights` for the CPU levels (TAI-12). |
| `transitions.ts` | The match state machine's legal transitions (`LEGAL_TRANSITIONS`, `isLegalTransition`), `CLOCK_PHASES` (where the match clock runs, D-013), `RESTART_PHASES`, `CUTSCENE_PHASES`. RUL-01's `setPhase` refuses anything else. |
| `tuning.ts` | Every gameplay constant with its unit (ARCHITECTURE rule 6): the Wave 0 shared tables (`T_BALL` ... `T_PERF`) and one block per module since TUN-1 / TUN-2 (`T_FLIGHT` ... `T_FORMATION_REMAP`), 93 blocks in all. TUNING.md lists them. |
| `data.ts` | Static game data types: `PlayerData` (attributes 1-99, `ATTRIBUTE_KEYS`, `AttributeKey`), `Rgb`, `Kit`, `Crest`, `Club`, `FormationSlot`, `Formation`. Values are generated by `tools/gen-data.ts` and committed in `src/data/`. |
| `render.ts` | The procedural pose layout shared by the animation modules and the player model: `PoseIdx`, `POSE_SIZE`, `Pose`, `createPose`, `AnimId`, `PoseFn`, and `RenderStats` (draw calls, triangles, textures, geometries, resolution scale, quality tier). Animation never feeds back into the sim. |
| `settings.ts` | The persistent settings schema: `SETTINGS_SCHEMA_VERSION`, `ControlPlacement`, `TouchSettings`, `PadSettings`, `ControlSettings`, `CameraSettings`, `MatchDefaults`, `AudioSettings`, `GraphicsSettings`, `AccessibilitySettings`, `Settings`, `createDefaultSettings`. Stored with migrations by `platform/settingsStore.ts`. |
| `app.ts` | The app-level interfaces: `FrameInfo`; screens and router (`ScreenId`, `ScreenParams`, `Screen`, `ScreenFactory`, `Router`); `SettingsStore`; audio (`UiSound`, `AudioEngine`); `GameRenderer` and `HudPart`; stats (`TeamMatchStats`, `PlayerMatchStats`, `GoalRecord`, `MatchSummary`, `StatsTracker`); input plumbing (`TickInputProvider`, `DeviceInfo`, `DeviceRegistry`, `MenuAction`, `FocusNavigator`, `HumanBinding`); the session (`MatchHooks`, `MatchSetup`, `SessionControl`); `PlatformInfo`, `Diagnostics`, and `AppContext`, the object every screen receives. |
| `touch.ts` | The touch layer's internal contract (TCH squad): `TouchButtonId` (`TOUCH_BUTTON_COUNT` 9), cluster slots (`ClusterSlot`, `CLUSTER_SLOT`, `ClusterMode`), `TouchEdge`, `SwipeDir`, button and gesture events with their queues (`TouchButtonEvent`, `TouchGestureEvent`, `TOUCH_QUEUE_SIZE`, `pushButtonEvent`, `pushGestureEvent`), the shared `TouchIntentState` and `TouchControl`. Coordinates are CSS pixels, y down. |
| `index.ts` | Barrel: re-exports every file above. |

Wave 0 design decisions that shaped the contracts as first written: D-004 (positional-semantic buttons), D-007 (22
fixed slots; substitutions swap the roster index into the slot), D-011 (pitch-space stick directions).

## Contract changes after the first commit

The first version is commit `2a74edd` ("Wave 0: toolchain, frozen contracts, sim/ai skeleton"). Every later change to
a contract file other than `tuning.ts`, from `git log -- src/contracts`:

| # | Commit | File | Change | Decision |
|---|---|---|---|---|
| 1 | `790facc` (Wave 0) | `state.ts` | `TeamState` gains `supportCallT` / `supportSlot`, `runCallT` / `runSlot`, `passGoT` / `passGoSlot` (call for support, trigger a run, pass and go: human / CPU requests with a duration) | none recorded |
| 2 | `790facc` (Wave 0) | `transitions.ts` | `CLOCK_PHASES` from `IN_PLAY` only to play and restarts (added time accumulates in restart phases) | D-013 |
| 3 | `b3d8b6e` (Wave 0) | `events.ts` | `POSSESSION`: `a` = team that gained possession, `b` = slot; emitted only on a change of team | D-012 |
| 4 | `b3d8b6e` (Wave 0) | `state.ts` | `createSimState` writes `version: SIM_VERSION` instead of the literal 1 | none recorded |
| 5 | `dc67751` (Wave 0) | `transitions.ts` | `PRE_MATCH -> IN_PLAY` becomes legal (practice free play, test setups, `config.startPhase`); `KICK_OFF` leaves `CLOCK_PHASES` (the clock does not run before the kick-off is taken) | D-013 |
| 6 | `dc67751` (Wave 0) | `app.ts` | `GameRenderer.setSettings`, `onContextLost`, `onContextRestored`; optional `TickInputProvider.queueCommand`; `HumanBinding.devices` documents `'*'` (devices that appear later) | none recorded |
| 7 | `e22d56d` (Wave 1) | `enums.ts`, `app.ts` | `Command.HAND_TO_CPU = 17` (cmdArg = human; applied in `sim/control/handoff.ts` before the frame is resolved); `SessionControl.setHumanDevice(human, devices or 'cpu')` | D-019 |
| 8 | `f7d206c` (Wave 1/2) | `app.ts` | `MatchHooks` (`allowPause`, `onPauseChange`, `onQuit`) and optional `MatchSetup.hooks`, for online pause rules and quit | D-021 |
| 9 | `416e7ce` (Wave 2) | `app.ts` | optional `GameRenderer.cameraX()` (stereo panning of sim events, AUD-03); NET-B app-side change requests, `docs/INTEGRATION_ISSUES.md` | none recorded |
| 10 | `bec6205` (Wave 2) | `app.ts` | optional `GameRenderer.contextLost` (the session refuses resume while the WebGL context is lost) | none recorded |

Changes 1-6 landed before Wave 0 closed (the freeze starts with Wave 1); 7-10 are the lead's changes under the
frozen-contract rule, all additive. Changes 9 and 10 are optional members, so no implementation broke. Items marked
"none recorded" have no entry in `docs/DECISIONS.md`.

`tuning.ts` changes in nearly every wave (moves of local tuning blocks, values tuned against soak evidence). Those
changes and their reasons are logged in `docs/TUNING.md`: the TUN-1 move of every sim / AI block (52 blocks), the TUN-2
move of the inline sim / AI literals and the input, modes and formation-remap blocks, and each QF agent's tuning
section. The TUN-1 and TUN-2 moves left every value and the behaviour unchanged (same `hashState` over 28 reference
runs, `tools/hash-table.ts`).

## Checking a contract change

- `npm run typecheck` compiles every implementation against the contracts.
- `tests/unit/fnd-03-*.test.ts` cover hashing, cloning and serialising the state layout, and replay determinism.
- `tests/unit/tun-2-tuning-in-data.test.ts` keeps gameplay constants in `tuning.ts`.
- `tools/hash-table.ts --compare <before.json>` proves a refactor leaves sim behaviour identical.
