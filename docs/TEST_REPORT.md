# Test report

<!-- sgn-01:start (SGN-01 definition-of-done audit; BRIEF §19 DoD 1-11 and the hard requirements of §2-§15) -->
## Definition of done (SGN-01)

Audit of the final tree: HEAD 0477504 (6839cd4 "STATUS: FEEL-2 done" plus the campaign's `reports/sgn-03/**`), after
the FEEL-1 / FEEL-2 / FEEL-2C / FEEL-2D rework (D-028..D-042). `git diff HEAD -- src` is empty: every `src/**` byte the
SGN-03 campaign tested is the byte audited here. The only tracked changes since that commit are the three
`tests/e2e/**` harness fixes and regenerated report files listed in the campaign section below. BRIEF wins over every
other document.

Method: each DoD item and each hard requirement ("must", a table of targets, a rule) of BRIEF §2-§15 is mapped to
evidence: a file in `src/`, a named test (which passed in the campaign's `npm run verify` or e2e run on this tree), or a
report with its number. Where it was cheap, the claim was re-checked independently instead of copied (marked
**[SGN-01]**): source greps, data checks, a fresh balance run, a fresh ladder run, a keeper save-rate measurement,
eslint on the post-verify spec changes and a rerun of the glitch audit. §9 and §10 have 171 rows; SGN-02 mapped each
one to tests in `docs/CONTROLS_AUDIT.md`, so they appear here as one row per sub-table with SGN-02's counts.

Verdicts: **PASS**; **FAIL**; **RE-SCOPED** (with the reason); **NOT VERIFIABLE HERE** (NVH: needs the iPad, WebKit /
Safari, Firefox or real hardware; only Chromium exists in this container, D-003 / D-023; covered by
`docs/DEVICE_CHECKLIST.md`). A row that passes in Chromium but also needs the device says so in its evidence.

### Independent checks run by SGN-01 (2026-11-05, idle container, one job at a time)

| Check | Command | Result |
|---|---|---|
| Club balance, 88 v 62, a seed nobody had used | `npx tsx tools/balance.ts --matches 200 --suite top-bottom --workers 3 --seed 5` | MOS (88) v ROO (62): W 162 D 25 L 13 of 200, **wins 81.0 %** [75.0-85.8] against 80 %: PASS (148 s) |
| Ladder, the narrowest pair (Professional v Semi-Pro), new seed | `npx tsx tools/ladder.ts --matches 200 --pairs 2 --workers 3 --seed 3` | W 139 D 37 L 24 of 200, **wins 69.5 %** [62.8-75.5] against 65 %: PASS (135 s) |
| Keeper save rate with equal teams (BRIEF §6, 65-78 %) | a scratch script over `tools/headless.ts` `runMatch` with an `onTick` event counter (not committed; easy to redo): `soakConfig(i, 2026, { halfMinutes: 4, difficulty: Professional })`, i = 0..119, with the away club set to the home club; each on-target `SHOT` event followed by a `SAVE` or a `GOAL` before the next touch (a parry's own kick in the same tick counts as the save); penalties and shoot-outs left out | **68.5 %** (571 saves, 263 goals; 40-match thirds 70.5 / 65.5 / 69.1 %): PASS. The same 120 configs with their mixed clubs (ratings 62-88): 62.7 % (591 / 352); counting the 83 keeper saves of shots judged off target at contact as well: 65.3 % |
| Raw keeper save share in the campaign's soaks | `saves / (saves + goals)` over the Professional matches in `reports/sgn-03/soak.json` (n = 326) and `soak-pro500.json` (n = 500) | 65.1 % and 64.3 % (goals here include penalty goals and goals that are not from a shot on target, so this is a floor for the §6 measure) |
| Glitch audit | `npm run glitch-audit` | **55/55** glitch-list items have a named regression test |
| Lint of the three e2e specs changed after verify | `npx eslint tests/e2e/fnd-int-skeleton.spec.ts tests/e2e/int-c-live.spec.ts tests/e2e/review-fnd-05-adversarial.spec.ts` | 0 problems |
| Typecheck after those changes | `npx tsc --noEmit -p tsconfig.json` (tsconfig includes `tests/`) | exit 0 (27 s) |
| Determinism rule in `src/sim` and `src/ai` | grep for `Math.random/sin/cos/tan/asin/acos/atan/atan2/pow/exp/log/hypot`, `Date.`, `performance.`, `new Map`, `new Set`, `document.`, `window.` | 0 hits (one comment in `dmath.ts`) |
| No runtime network outside online 1v1, no keys or analytics | grep `src/` for `fetch(`, `XMLHttpRequest`, `sendBeacon`, `new WebSocket`, `EventSource`, `api key`, `analytics`, `gtag` | 0 hits (PeerJS is the only network code; SGN-05's proxy and NetLog runs pass in the campaign) |
| Invariant checker not in the release build | `src/sim/debug/invariants.ts` is imported only by `tools/` and `tests/`; `dist/index.html` has none of its invariant names | PASS |
| Data (BRIEF §15) | `CLUBS` from `src/data/clubs.ts` | 20 clubs, 20 unique names and 3-letter codes, ratings 62..88, 18 players each, 20 outfield + 5 keeper attributes plus height, foot, weak foot, skill moves, position, shirt |

### DoD (BRIEF §19)

| # | Requirement | Evidence | Verdict |
|---|---|---|---|
| DoD 1 | `npm run verify` green; 2,000-match soak and 500-match fuzz clean | `reports/sgn-03/verify.log`: typecheck 0, eslint 0, vitest **543 files, 7,473 passed, 1 skipped** (NETSIM_LONG only), soak:short 10/10, exit 0. `soak.json`: **2,000/2,000**, 62.5 M ticks, 0 exceptions / 0 invariant failures (`--enforce all`) / 0 watchdogs / 0 unfinished. `fuzz.json`: **500 + 122 rematches**, 0 exceptions / invariant failures / watchdogs / failures; the 136 "unfinished" are planned quits and Practice runs (campaign section). [SGN-01] after verify only `tests/e2e/**` changed: eslint 0 problems, `tsc --noEmit` exit 0 | PASS |
| DoD 2 | Every row of the touch and controller tables works and has a test | `docs/CONTROLS_AUDIT.md`: 171 rows of §9 and §10, each mapped to tests through the real pipeline, **0 FAIL**; updated for FEEL-1 (R1 controlled sprint row cites `scenario/feel-1-feel.test.ts`); every cited vitest file passed in this tree's verify; e2e tch-*, pad-*, qf-3-input, int-b-setpieces passed in the campaign. Real iPad touch and real pads in Safari: NVH (device checklist steps 3-5) | PASS (Chromium) |
| DoD 3a | A full match in each mode on touch alone and on controller alone, Chromium at iPad size, zero console errors | Campaign e2e: int-b-touch-match, int-b-pad-match 3/3, qf-12-menu-paths "touch alone" / "controller alone" (cup tie, practice, tutorial, shoot-out), int-b-modes 3/3, uix-05, uix-11, pad-08; online int-08-online, int-08-webrtc, net-07, qf-6-online, qf-6-s2-rejoin; every spec fails on a console error. Full matches use 2-minute halves with the clock fast-forwarded (SwiftShader) | PASS |
| DoD 3b | The same in WebKit | WebKit not installed (D-023) | NOT VERIFIABLE HERE |
| DoD 4 | Same-iPad 1v1: controller v controller and touch v controller | int-b-modes "same-iPad 1v1: pad vs pad and touch vs pad, no crosstalk, only the pauser resumes, full time, Change Teams"; uix-04-side-select 3/3 | PASS |
| DoD 5 | Online 1v1 full match in the two-instance harness, 80 ms, 20 ms jitter, 5 % loss, no desync | `tools/netsim.ts --halves 2 --latency 80 --jitter 20 --loss 0.05`, seeds 7 and 2026: finished, hashes and frames equal, **0 desyncs, 0 resyncs**; re-run with the command recorded: identical | PASS |
| DoD 6a | Performance budgets hold in the throttled proxy benchmark | `tools/bench.ts --throttle 4`, three idle runs on the final build: sim + AI avg **0.747 / 0.739 / 0.761 ms** (2.5: PASS), draw calls max **22** (80: PASS), triangles max **46,924** (200,000: PASS); the 4 ms worst case, judged as the p99 of each frame's worst tick: **4.5 / 3.9 / 4.5 ms**, exit 1 / 0 / 1 (single worst tick 9.6 / 6.2 / 9.6 ms). D-027 records this as measured; no budget was loosened | FAIL (sim worst case, 2 of 3 runs; D-027: the iPad benchmark is the final gate) |
| DoD 6b | The on-device benchmark is built and documented | `?bench=1` and Settings > Diagnostics > Run benchmark (`src/platform/benchHook.ts`, `src/ui/screens/diagnostics.ts`): fps avg, 1 % / 0.1 % lows, longest frame, sim avg / p99 / worst, render ms, draw calls, triangles, scale, tier, device, PASS / FAIL, Copy Results; README §9, DEVICE_CHECKLIST step 2; seed 42 window holds a goal with net ripple, its replay, a corner, a free kick and a crowded box (`tests/perf/fin-p-bench-coverage.test.ts` 2/2) | PASS |
| DoD 7 | Every line of the glitch list has a passing, named test | `npm run glitch-audit`: **55/55** items have a named test (campaign and [SGN-01] rerun); every one passed in verify | PASS |
| DoD 8 | `KNOWN_ISSUES.md` holds nothing that affects match state, input or performance | Read line by line: 15 items, all presentation (two audio / update-toast items, five online presentation items after a rejoin or resync with score, winner and goals identical on both devices per D-024, six rendering items, one 4 cm visual post overlap, one "not verified here" note). None changes sim state, input or frame budget | PASS |
| DoD 9 | Originality and licence audit passed; no runtime network except online 1v1 | SGN-05 done (names screened against ~1,700 famous names and Wikidata: 98k footballers, 37k clubs; 6 renames; visuals, audio, fonts, dependencies, licence notices in dist PASS); campaign e2e sgn-05-network 2/2 and sgn-05-proxylog 1/1; [SGN-01] source grep clean. Open, user decision: the repository is named "Fifa"; rename before any public deploy (SGN-05) | PASS |
| DoD 10 | `dist/index.html` runs from a plain static server with nothing beside it | sgn-03-static 1/1: index.html alone in an empty folder under Python `http.server`, boots, Kick-Off runs through the rAF loop to tick 102, quits; only `/` and the optional absent `/sw.js` requested; zero console errors (not a full match: SwiftShader speed) | PASS |
| DoD 11 | `STATUS.md` shows all assignments closed or re-scoped with a reason | `docs/STATUS.md` after this audit: **201** roster rows (BRIEF's 200 plus the SIM-15 / SIM-16 split, D-006), **201 done**, 0 queued or running; every charter row of "Wave 4 round 2" and the FEEL rows closed (QF-7 re-scoped into QF-7R + TUN-7S, FIN-P closed by FIN-P2) | PASS |

### §2 Ground rules

| Requirement | Evidence | Verdict |
|---|---|---|
| Working title in one constant | `GAME_NAME = 'DotKick'`, `src/contracts/constants.ts:10` | PASS |
| Original: no names, logos, fonts, UI layouts, audio or art of FIFA / EA SPORTS FC or any commercial game | SGN-05 audit (visuals, audio, fonts, UI) PASS; uix-01-design e2e | PASS |
| No real clubs, leagues, players, kits, crests, stadiums, sponsors, broadcasters | SGN-05 name screening (6 renames), `src/data/screen.ts`; generated crests and boards | PASS |
| On-screen button labels are plain words | CONTROLS_AUDIT layout rows; tch-09-overlay e2e | PASS |
| Everything visible / audible generated in code or CC0 / OFL recorded in `ASSETS.md` | `docs/ASSETS.md` (fonts OFL, everything else generated); SGN-05; licence notices in dist (qf-5-verify) | PASS |
| No accounts, ads, analytics, tracking, API keys | [SGN-01] grep clean; README §10 Privacy | PASS |
| No network requests at runtime except online 1v1 | sgn-05-network, sgn-05-proxylog (campaign); [SGN-01] grep | PASS |

### §3 Target device and hard limits

| Requirement | Evidence | Verdict |
|---|---|---|
| Primary device iPad (A16), Safari | WebKit / iPad not available | NOT VERIFIABLE HERE |
| Also runs on desktop Chrome, Safari, Firefox | Chromium: the whole campaign; Safari and Firefox not installed | PASS (Chromium); Safari / Firefox NVH |
| Landscape either way; portrait pauses with a rotate screen | plt-02-ipados e2e "portrait pauses behind the rotate screen" | PASS (Chromium) |
| 60 fps target, never below 50 fps on the device | main-thread proxy at 1x 59.95 fps, 1 % low 55.0 (PERF_REPORT, first SGN-04 run); GPU frame rate needs the iPad | NOT VERIFIABLE HERE |
| Multi-touch, up to two controllers, keyboard | tch-01-pointers (five touches), uix-04-side-select (two pads), pad-03-reconnect, fnd-05 keyboard tests | PASS (Chromium) |
| Safari tab and Home Screen app (standalone, full screen) | `manifest.webmanifest` standalone; plt-01-pwa; real install NVH (device checklist step 1) | PASS (Chromium); install on iPad NVH |
| Fully playable offline after the first load | plt-01-pwa "after the first load the game reloads and boots offline from the cache"; qf-5-lifecycle offline boot | PASS (Chromium) |
| Download 4 MB or less compressed | **824.9 KB gzip** (20.1 %), `tools/size-check.ts` exit 0 | PASS |
| Main menu within 3 s on Wi-Fi | plt-04-build startup, three idle runs: **2.15-2.17 s** (20 Mbit/s, 20 ms) | PASS (container) |
| 300 MB or less in a match | JS heap 13-16 MB at kick-off, 20.5 MB after 19 minutes (first SGN-04 run); the Safari process needs the device | PASS (heap); process NVH |
| 64 MB or less of textures | 6.03 MB (Performance / Balanced), 14.0 MB (Quality, incl. the uncounted 4 MB shadow depth texture) | PASS |
| No backend; static files over HTTPS | dist = index.html, manifest, sw.js, icons; sgn-03-static | PASS |
| Secure context: README explains HTTPS from the iPad | README §3 B (mkcert) and C (tunnel) | PASS |
| `viewport-fit=cover`, no user scaling, safe-area insets, controls 24 pt clear of bottom edge and top corners | `index.html` viewport meta; `src/platform/viewport.css`; plt-02 "safe-area and viewport variables are applied"; CONTROLS_AUDIT layout rows | PASS (Chromium) |
| Browser gestures off on the game surface | `touch-action: none` (`src/ui/components.css`); plt-02 "a synthetic pinch never zooms" | PASS (Chromium); real Safari gestures NVH |
| Pointer Events with capture, own pointer id per control; cancel / lost capture / blur / visibilitychange release every hold | qf-3-input e2e, review-fnd-05-adversarial 9/9, tch-01, 20 test files on `pointercancel`; glitch "stuck sprint or stick after pointercancel" | PASS (Chromium); iPadOS multitasking gesture NVH (checklist step 4) |
| Any aspect 4:3 to 21:9; below a minimum size pause and say so | uix-06-hud at 1024x768 and 1260x540; plt-02 "a window below the minimum playable size says so and pauses" | PASS |
| Audio only after a gesture; resume after interruption and on visible | aud-01-engine, qf-5-lifecycle "quick hide/show comes back without a tap"; glitch "silent after returning from the background" | PASS (Chromium); iPad NVH |
| Hidden: pause, stop loop, mute; return: pause menu; never fast-forward | `src/app/loop.ts` (accumulator reset on resume); glitch "game runs fast after a pause, a tab switch"; uix-08-pause | PASS |
| Low Power Mode: detect steady 30 fps and hint once | `src/platform/ipados.ts`; `tests/unit/plt-02-ipados.test.ts` | PASS (logic); real Low Power Mode NVH |
| WebGL context loss: pause, restore, rebuild, resume from pause menu | gfx-01-renderer, fnd-05-skeleton and int-c-live e2e (`WEBGL_lose_context`) | PASS (Chromium) |
| Gamepad API standard mapping; pad appears after a press; nothing on Home / Share | pad-01-devices, `tests/controls/*`; CONTROLS_AUDIT quality bar | PASS (Chromium); Safari pads NVH |
| Storage with schema version and migrations; memory fallback | `src/platform/settingsStore.ts` (SETTINGS_MIGRATIONS); qf-5-lifecycle "storage blocked ... boots, plays, pauses and quits" | PASS |
| Full-screen button in a tab where the API exists | `src/ui/screens/splash.ts` / `src/platform/ipados.ts`; uix-02-menus, qf-5-platform tests | PASS (Chromium) |

### §4 Tech stack and architecture

| Requirement | Evidence | Verdict |
|---|---|---|
| TypeScript strict, Vite, Three.js on WebGL2, no engine or physics library | `tsconfig.json` `"strict": true`; dependencies: three, peerjs, two fonts only | PASS |
| DOM / CSS menus and HUD, no UI framework; Web Audio synthesis; PeerJS | `package.json`; `src/ui`, `src/audio`, `src/net` | PASS |
| Vitest and Playwright in WebKit and Chromium with iPad touch emulation | Chromium iPad project only; the WebKit project enables itself when a WebKit build exists | RE-SCOPED (D-003 / D-023: WebKit cannot be installed here) |
| Runtime dependencies pinned | exact versions in `package.json` (D-002) | PASS |
| One self-contained `index.html`; manifest, sw.js, icons beside it; HTML runs without them | `dist/` listing; vite-plugin-singlefile; sgn-03-static | PASS |
| Source layout | `src/{contracts,sim,ai,input,render,ui,audio,net,modes,data,platform,app}`, `tests/`, `tools/`, `docs/` | PASS |
| Rule 1: deterministic fixed step; no forbidden Math / clocks / DOM / Map-Set order in sim and ai | [SGN-01] grep clean; hash table 28 configs x3 IDENTICAL; Chromium 10 configs x3 identical; V8 v JavaScriptCore (Bun) bit-for-bit test passes | PASS (Node, Chromium, JSC engine); WebKit / Firefox browsers NVH |
| Rule 2: one InputFrame for every device | `src/contracts/input.ts`, D-004; CPU, network and replay use it (tai-13-cpu-contract) | PASS |
| Rule 3: sim owns timing; animation never feeds back | ARCHITECTURE.md; render reads state only (render has no sim writes, glitch-audit / ownership) | PASS |
| Rule 4: events out, nothing back in | `src/contracts/events.ts`; consumers in audio / HUD / render / rumble | PASS |
| Rule 5: rAF loop, 100 ms clamp, 0-3 ticks, interpolation, same speed at 60 / 120 Hz | `src/app/loop.ts`, `MAX_FRAME_MS`; glitch "game runs fast ... on a 120 Hz display" test | PASS |
| Rule 6: every gameplay constant in `contracts/tuning.ts` with unit and comment | TUN-2 / TUN-7S (2,422 + 444 constants moved, values deep-compared); FEEL blocks T_FEEL / T_FEEL2 in tuning.ts; every `LOCAL_TUNING` in `src/sim` and `src/ai` is an alias of a tuning.ts block (remaining literal blocks are render / audio / net / UI presentation) | PASS |
| Rule 7: debug tools in the build behind a hidden toggle | `src/ui/debugOverlay.ts` (backquote or 5 corner taps); Diagnostics replay save / load; plt-05-recovery e2e 4/4 | PASS |
| Units and pitch dimensions | `src/contracts/constants.ts`: 105 x 68, goal 7.32 x 2.44, spot 11, etc. | PASS |

### §5 Match rules and flow

| Requirement | Evidence | Verdict |
|---|---|---|
| 11 v 11, halves 2-10 minutes (default 4), clock scaled to 45:00 with added time | `clampHalf` in `src/ui/screens/matchSettings.ts`, default 4 (`settings.ts`); rul-01-clock | PASS |
| Home attacks left to right first; swap at half time | rul-01-kickoff; glitch "kick-off with players in the wrong half" | PASS |
| Every restart a state with taker, positions, 9.15 m / 2 m distance, 12 s human timeout with a default | `T_RULES.restartTimeoutTicks 720`; rul-02 .. rul-06, rul-11-restart; glitch restart lines | PASS |
| Whole ball over the whole line, swept between ticks | sim-03-goals, rul-01-goals; glitch "not given when the ball crosses and bounces out" | PASS |
| Offside: switchable, moment of the pass, margin, not from goal kicks / throw-ins / corners, only when involved, free kick where he was | rul-08-offside, rul-08-pipeline; glitch offside lines | PASS |
| Fouls switchable; classification; clean / foul / yellow / red / penalty | rul-09-fouls, rul-09-classify, rul-09-pipeline | PASS |
| Advantage up to 3 s; second yellow is red | rul-09 advantage tests; glitch "advantage that never resolves" | PASS |
| Sending off reshapes; keeper replacement; below 7 forfeits 3-0 | rul-10-subs, rul-09; glitch "a team below 7 players not ending the match" | PASS |
| Up to 5 subs at stoppages; no return | rul-10-subs; glitch "12 players after a substitution" | PASS |
| Keeper handles only in his area, no back-pass pick-up, releases within 6 s | gkp-05-catch-release, gkp-05-keeper-hands; `T_GK.maxHoldTicks 360`; glitch keeper lines | PASS |
| Friendlies can end level; cup extra time (a third of a half) then shoot-out with every player before repeats | rul-07-shootout ("rotation: every eligible player kicks once before anyone repeats", sudden death); mod-03-shootout | PASS |
| Half ends only with the ball dead or neutral, cap 20 s | rul-01-clock; glitch "half ends during a shot in flight" | PASS |
| Goal: celebration, replay, kick-off; skippable; 12 s at most | `T_RULES.goalSequenceMaxTicks 720`; gfx-16-replay, uix-10-breaks | PASS |
| One table-driven state machine; illegal transition fails | `LEGAL_TRANSITIONS` in `src/contracts/transitions.ts`; rul-01-transitions; `phase` invariant in every soak / fuzz | PASS |
| Watchdog; a trigger fails the soak | rul-11-watchdog; soak 2,000 and fuzz 500: **0 watchdogs** | PASS |

### §6 Gameplay systems

| Requirement | Evidence | Verdict |
|---|---|---|
| Ball: gravity, quadratic drag, Magnus, bounce restitution and spin friction, rolling resistance | sim-01-flight, sim-02-ground, sim-02-tick | PASS |
| No tunnelling at 36 m/s | sim-02-goals "posts / crossbar deflect at up to 40 m/s without tunnelling" | PASS |
| Rigid posts and bar; soft net holds the ball; side netting and roof deflect | sim-02-net; glitch "given through the side netting", "on the roof of the net" | PASS |
| Reference feel (pass 9-22 m/s, 15 m/s rolls ~30 m, shot 25-36, goal kick 45-60 m, bounce halves) | sim-01-flight "a 15 m/s ground pass rolls about 30 m", "a 45-60 m goal kick", "hard shots at 25-36 m/s", "bounce height roughly halves" | PASS |
| Players: 360 movement, accel / decel, turn rate; top speed 7.0-9.6, jog ~60 % | sim-04-locomotion "top speeds span 7.0-9.6", "jog is 60 % of top speed", "turn radius is larger when sprinting" | PASS |
| Sprint makes touches heavier and turns wider | sim-06-possession; FEEL-1 keeps sprint touches longer than jog (1.45 m v 1.0 m for the human, D-029) | PASS |
| Soft-circle bodies weighted by strength; shielding | sim-05-bodies | PASS |
| Stamina drains / recovers; low stamina cuts speed, accel, accuracy; on HUD and team sheet | sim-04, dat-05-attributes (stamina); uix-06-hud, uix-08-pause | PASS |
| Dribble touches ahead, closer at a jog, further at a sprint, can be poked away | sim-06-possession; FEEL-1 poke window (D-029) and feel-1-skeptic | PASS |
| First touch from ball speed, height, control, pressure, sprint | sim-07-first-touch | PASS |
| Eight skill moves with duration, exit, win window, star gating | sim-13-skills, sim-13-solver | PASS |
| Pass power bar; target blends stick, power distance, openness; Assisted / Semi / Manual | sim-08-pass; FEEL-1 direction-first assisted passing (D-030) | PASS |
| Nine pass types; through ball meets the runner in stride; crossing-zone lob becomes a cross | sim-08, sim-09-cross, sim-09-lob, sim-10-through | PASS |
| Receiver collects on his own until steered | tai-07-receiver, tai-14-receiver; FEEL-1 receiving magnet (D-028) | PASS |
| Pass error from attributes, body angle, pressure, sprint, weak foot, power | sim-08-pass error tests; dat-05-attributes | PASS |
| Shot power and aim; assisted aim; eight shot types; error model; fake shot | sim-11-shot, sim-11-shot-solver, sim-12-aerial; FEEL-1/2 finesse, power, trivela (D-031, D-036, D-040) | PASS |
| Defending: jockey, contain, second defender, standing / slide / hard tackle, shoulder, push or pull, clearance, interceptions | sim-14-tackle, sim-14-intercept, sim-15-defence, tai-11-defending; FEEL-2 duel (D-035, D-038, D-042) | PASS |
| Switching with lock-out, directional, auto-switch setting, faint next-target marker | sim-16-switching, sim-16-pipeline; gfx-13-markers; glitch switching lines | PASS |
| Keeper positioning, coming out, crosses | gkp-01-positioning, gkp-03-come-out, gkp-03-sweeper | PASS |
| Saves decided by physical reach; catch / parry / tip / beaten | gkp-02-saves, gkp-02-registry | PASS |
| Distribution: throw, roll, drop kick, driven kick, quick release | gkp-04-distribution | PASS |
| User control: rush out on hold, throws and kicks | CONTROLS_AUDIT "Goalkeeper with the ball" (6 rows) | PASS |
| 65-78 % of shots on target saved with equal teams | [SGN-01] equal clubs, Professional, 120 matches: **68.5 %** of non-penalty shots on target saved (last measured before FEEL-1 at 67.0 %, QF-16); gkp-02-save-rate scripted batch in verify. With mixed clubs the rate drops to 62.7 % (weaker keepers face stronger attacks), which the band does not cover | PASS |

### §7 AI

| Requirement | Evidence | Verdict |
|---|---|---|
| Six formations; role home positions shift with ball, phase, focus | `src/data/formations.ts`; tai-01-shape | PASS |
| In possession: triangles, width, runs in behind onside, overlaps, late arrivals; trigger-run / call-for-support override | tai-02-support, tai-03-runs, tai-14-commands | PASS |
| Out of possession: compact, back line together, press, cover, zones, lanes, tracking, recovery runs | tai-04-defshape, tai-05-press, tai-06-transitions | PASS |
| Exactly one loose-ball chaser per team, with hysteresis | tai-07-chaser, tai-07-loose-ball; `chaser` invariant enforced in soak 2,000 / fuzz 500: 0 failures | PASS |
| Arrival steering, no orbit or jitter | tai-07-steer; glitch "orbit or jitter around a target" | PASS |
| Scripted set pieces; wall of 2-5 by distance and angle | tai-13-setpieces, gkp-06-setpieces, rul-05-freekick | PASS |
| CPU uses the same InputFrame and models, no boosts, never reads human input | tai-13-cpu-contract | PASS |
| CPU option scoring on the ball; off-ball defender choice, jockey, tackle timing, second defender, occasional fouls | tai-08-carrier, tai-09-passing, tai-10-shooting, tai-11-defending | PASS |
| Team styles weight choices | tai-12-levels-styles | PASS |
| Six levels differ only in decision parameters, never physics | tai-12-levels, D-022 | PASS |
| Each level beats the one below in 65 % or more | FEEL final runs (bot v bot bit-identical since): pooled 400 a pair **74.3 / 74.0 / 67.3 / 68.5 / 75.8 %** (seed 2 alone 64.5 % on Professional v Semi-Pro); [SGN-01] seed 3, 200: Professional v Semi-Pro **69.5 %** | PASS (narrowest pair close to the line) |
| Goals 2.0-3.6 | soak 2,000 Professional 2.92; soak 500 Professional 3.08 | PASS |
| Shots 14-26 | 15.24 / 15.24 | PASS (little margin) |
| Possession 40-60 % each side | side with more 57.18 % / 57.26 % (D-016 reading); home 49.81 % / 49.02 % | PASS |
| Pass completion 70-88 % | 78.84 % / 78.73 % | PASS |
| Fouls 6-16 | 10.64 / 10.64 | PASS |
| Offsides 0-6 | 0.17 / 0.18 | PASS |
| Blow-outs under 5 % | 4.29 % / 4.40 % | PASS (little margin) |

### §8 Camera and presentation

| Requirement | Evidence | Verdict |
|---|---|---|
| Broadcast side camera, 24 m high, 40 m back, 22 deg FOV, tuning data | `T_CAMERA` (height 24, fovDeg 22, followFraction 0.7, smoothTime 0.4) in `src/contracts/tuning.ts`; gfx-14-camera | PASS |
| Player at the centre spot ~6 % of screen height, ~45 m visible | 5.7 % and 43.6 m at the iPad aspect (D-014: the two targets pull against each other) | PASS ("about" / "roughly", D-014) |
| Follow 70 % of ball x, clamp 32 m, look-at lead 3-6 m, ball never in the bottom 15 % or under controls, critically damped ~0.4 s, FOV widen up to 4 deg, no shake or bob | gfx-14-camera, qf-4-look e2e; glitch camera lines (jitter, snapping, high ball, below ground, hidden under controls) | PASS |
| Camera settings (Broadcast, Wide, Close, End to End; height and zoom 0-20); wider screens show more pitch | uix-09-settings, gfx-14 tests | PASS |
| Set-piece cameras, cuts or blends under 0.3 s, never a fly-across | gfx-15-cameras e2e, qf-4 tests | PASS |
| Goal replays: two angles, 8 s ring buffer, skippable; establishing shots; shared camera in same-iPad 1v1 | gfx-16-replay e2e; int-b-modes same-iPad | PASS |
| Low-poly players built in code, procedural animation set, run cycle by distance, foot meets ball on contact | gfx-07-players, gfx-12-anim e2e; KNOWN_ISSUES lists cosmetic foot-lock items only | PASS |
| Kits with patterns and an automatic clash check | gfx-08-kits e2e 2/2; qf-12-hud-kits | PASS |
| Pitch, rippling nets, one stadium, reacting instanced crowd, original boards, day / night | gfx-03 .. gfx-06 e2e | PASS |
| On-pitch aids (controlled marker per human, receiver ring, switch marker, landing marker, off-screen arrows) | gfx-13-markers e2e | PASS |
| Cheap shadows | gfx-02-quality; PERF_REPORT (shadow map only at Quality) | PASS |
| Sound synthesised; crowd bed follows the match; kicks, posts, net, tackles, whistles, menu sounds; four volume sliders; no commentary | aud-01-engine, aud-02-match-audio, aud-05-menus e2e; ASSETS.md | PASS |

### §9 Touch controls and §10 Controller controls (DoD 2)

| Sub-table | Evidence (`docs/CONTROLS_AUDIT.md`) | Verdict |
|---|---|---|
| §9 Layout | 6 rows PASS | PASS |
| §9 Attack buttons (one row per cell) | 28 rows PASS | PASS |
| §9 Defence buttons | 11 rows PASS | PASS |
| §9 Pitch gestures | 17 rows PASS | PASS |
| §9 Set pieces on touch | 10 rows PASS | PASS |
| §9 Touch quality bar | 16 rows PASS (latency on a real iPad NVH) | PASS (Chromium) |
| §10 header (bind by position, family labels) | 2 rows PASS (Safari `gamepad.id` strings NVH) | PASS (Chromium) |
| §10 Movement and dribbling | 14 rows PASS (R1 controlled sprint re-mapped after FEEL-1) | PASS |
| §10 Attacking | 16 rows PASS | PASS |
| §10 Shooting | 6 rows PASS | PASS |
| §10 Defending | 14 rows PASS | PASS |
| §10 Goalkeeper with the ball | 6 rows PASS | PASS |
| §10 Tactics, set pieces and menus | 15 rows PASS | PASS |
| §10 Controller quality bar | 10 rows PASS (physical rumble NVH) | PASS (Chromium) |

### §11 Modes and playing a friend

| Requirement | Evidence | Verdict |
|---|---|---|
| Kick-Off with teams, kits, difficulty, half length, friendly / cup, day / night, rule toggles | mod-01-setup, uix-03-team-select, int-b-touch-match, int-b-settings | PASS |
| Play a Friend (same iPad, online) | int-b-modes, int-08-online, int-08-webrtc | PASS |
| Cup: 8 or 16 teams, one or two humans, ratings-based other ties, progress saves | mod tests, uix-11-cup-practice, qf-12-sk-cup-back | PASS |
| Shoot-out; Practice (free play v keeper, set pieces, guided tutorial per device) | mod-03-shootout, uix-11, uix-12-tutorial e2e | PASS |
| Side select with an icon per input; ember P1 and cyan P2 | uix-04-side-select 3/3 | PASS |
| Same iPad: pad v pad, touch v pad; no split touch; one camera and pause menu; only the pauser resumes or quits | int-b-modes same-iPad test | PASS |
| Online built last; local play works with network code removed | `src/net` imported only by the online screens and mode (D-021); NET briefs | PASS |
| Flow: Create Room, 6-character code and link, ready up, host owns settings | net-07-online, qf-6-online e2e; tests/net | PASS |
| PeerJS, public broker and default ICE, one config object | `NET_CONFIG` in `src/net/config.ts` | PASS |
| Lockstep with input delay; start 3, adapt 2-8 | `T_NET.delayInitial 3`, `delayMin 2`, `delayMax 8`; net-04-adaptive | PASS |
| Unordered input channel with the last 10 frames; reliable second channel | `T_NET.redundancy 10`; `src/net/lockstep.ts`, `adaptive.ts` | PASS |
| Late input holds the sim with a waiting indicator; never guess | lockstep tests; DoD 5 harness | PASS |
| Desync guard every 30 ticks, host snapshot, guest hard-sync, logs | `T_NET.hashInterval 30`; qf-6 / qf-15 tests | PASS |
| 3 pauses each, 30 s cap; 20 s rejoin then Finish against CPU or End Match | `T_NET.pausesPerPlayer 3`, `pauseMaxMs 30000`, `rejoinWaitMs 20000`; qf-6-s2-rejoin e2e | PASS |
| Plain-language failure screens (broker, code, room full, version, blocked) | net-07 / qf-6 tests | PASS |
| Privacy: nickname and inputs only; README notes IP visibility | README §10 (line 653) | PASS |
| Real WebRTC between two devices | needs two devices (checklist step 7) | NOT VERIFIABLE HERE |

### §12 Menus, HUD and the Dot design system

| Requirement | Evidence | Verdict |
|---|---|---|
| Ink `#07070D`, ember `#FF6B35`; palette derived, every token a CSS variable in one file | `src/ui/tokens.css` | PASS |
| Space Grotesk UI, JetBrains Mono tabular numbers, Latin subsets inlined | uix-01 "fonts are inlined as data URIs, loaded, and used by the UI"; `src/ui/fonts.ts` | PASS |
| Animated dot field behind menus; stops completely in a match | uix-01 "dot field ... stops completely in a match" | PASS |
| Screen flow splash to full time (stats, player of the match, Rematch, Change Teams, Quit) | uix-02-menus, uix-05-match-flow, uix-10-breaks | PASS |
| Pause menu and Settings contents | uix-08-pause, uix-09-settings, int-b-settings | PASS |
| HUD: scoreboard, radar with toggle, names and stamina, power bar, toasts, set-piece hints, no overlap with controls / safe areas / ball region | uix-06-hud, uix-07-hud, qf-7r-hud e2e | PASS |
| Every screen by touch alone and controller alone, focus ring, Back works | uix-01 "components work by touch alone / by keyboard (controller) alone"; qf-12-menu-paths; pad-08-menus | PASS |
| Touch targets 60 pt or larger | `--target: 60px` (`tokens.css`); uix-01 | PASS |
| HUD writes only on change, transform / opacity animation, radar 2D canvas at 20 Hz | `src/ui/hud/radar.ts` (20 Hz); qf-7r HUD tests (no redundant DOM writes); FEEL-2D (D-041) | PASS |

### §13 Performance plan

| Requirement | Evidence | Verdict |
|---|---|---|
| Average 58 fps, 1 % low 50 fps, longest frame 33 ms on the iPad | main-thread proxy at 1x 59.95 fps / 55.0 / 33.3 ms; GPU needs the device | NOT VERIFIABLE HERE |
| Sim + AI 2.5 ms average per tick | proxy 4x: 0.747 / 0.739 / 0.761 ms | PASS |
| Sim + AI 4 ms worst case | proxy 4x p99 of the frame worst tick 4.5 / 3.9 / 4.5 ms (single worst 9.6 / 6.2 / 9.6) | FAIL in the proxy (D-027; iPad decides) |
| Draw calls 80 or fewer | 22 (Performance), 24 (Balanced), 33 (Quality) | PASS |
| Triangles 200,000 or fewer | 46,924 / 56,502 / 95,742 | PASS |
| No steady heap growth | +0.03 MB in 20 s after 19 minutes (first SGN-04 run) | PASS |
| No garbage-collection pause over 4 ms | Re-measured on the final tree (`tests/perf/sgn-04-bench.ts --mode cpu --throttle 1 --nodraw`, 20 s): 108 minor GCs (41 ms total), 2 early-match major GCs of 4.8-5.0 ms (max 4.99 ms; earlier tree 5.0-6.2 ms); no frame interval over 16.8 ms, 1% low 59.5 fps, heap 13.4 -> 15.3 MB; JavaScriptCore needs the device | FAIL in Chromium (V8); iPad NVH |
| All targets still met after a 20-minute match | 19 minutes fast-forwarded, then 60.0 fps, 1 % low 59.5, heap flat (proxy) | PASS (proxy) |
| Instancing; one atlas; cheap shading; no shadow maps or post at default | draw calls 20-22; gfx-02-quality | PASS |
| Render at 0.75, dynamic 0.6-1.0 with hysteresis | `T_QUALITY.resScaleInitial 0.75`; scale test 0.60 floor to 1.00 in 8 steps, no oscillation | PASS |
| Context flags (high-performance, opaque, no stencil, no preserve) | gfx-01-renderer | PASS |
| No allocation in hot paths | renderer 0.061 B/frame, HUD 1.86 B/frame; sim + AI no literals / closures (V8 boxing remains); 26 allocation tests pass | PASS |
| Warm-up: shaders, textures, animations; first slide or replay does not hitch | QF-7R warm-up; qf-7r-kickoff-cut tests | PASS |
| AI budgeting on a fixed deterministic schedule | TAI staggering; determinism checks | PASS |
| Quality tiers from a 2-second startup test, then adapt | `T_QUALITY.testDurationMs 2000`; gfx-02-quality | PASS |
| One rAF loop, no timers for visuals | `src/app/loop.ts` | PASS |
| Benchmark mode at `?bench=1` and in Diagnostics through the worst cases, with the full report and Copy Results | DoD 6b row | PASS |
| Proxy gate: headless Chromium at 4x fails the build on sim, draw-call or triangle budget | `tools/bench.ts --throttle 4` exits 1 on a breach (exit 1 / 0 / 1 in the three final runs) | PASS (gate built); its result is DoD 6a |
| Final gate on the iPad | user's run (DEVICE_CHECKLIST step 2) | NOT VERIFIABLE HERE |

### §14 Quality plan

| Requirement | Evidence | Verdict |
|---|---|---|
| Zero known bugs; only cosmetic issues in KNOWN_ISSUES | DoD 8; campaign found 0 product defects; this audit found 0 | PASS |
| Invariants every tick in test / soak builds, compiled out of release | `src/sim/debug/invariants.ts` (14 checks: finite, bounds, phase, owner, players, controllers, score, clock, action, overlap, keeperArea, chaser, phaseMax, clockStop); [SGN-01] absent from `dist/index.html` | PASS |
| Soak: 2,000 matches across seeds, teams, formations, difficulties, toggles; zero failures; §7 bands | DoD 1 and §7 rows | PASS |
| Fuzz: 500 matches of hostile input, quit and rematch; zero failures | DoD 1 | PASS |
| Determinism: three runs each in Chromium, WebKit and Firefox | Chromium 10 configs x 3 identical; Node 28 x 3 identical | PASS (Chromium); WebKit / Firefox RE-SCOPED (D-023) |
| A saved replay plays back identically after a reload | campaign: "replay matched: 1500 ticks", Node IDENTICAL | PASS |
| Table-driven rules tests (offside, lines, fouls, advantage, restarts, cards, extra time, shoot-out order) | rul-01 .. rul-11 test files | PASS |
| Input tests: multi-touch, pointercancel mid-hold, leaving the screen, rotation / backgrounding / resize mid-hold, pads connect / disconnect / new index / two / non-standard | qf-3-input, tch-01, review-fnd-05-adversarial, plt-02, pad-02 / pad-03 / pad-07 e2e | PASS (Chromium) |
| End to end in WebKit and Chromium at iPad size, zero console errors | Chromium: 87 specs, 210 tests pass; WebKit not installed | PASS (Chromium); WebKit RE-SCOPED (D-023) |
| Runtime safety net: error handler to a recovery screen, watchdog, context-loss recovery | plt-05-recovery "a thrown error during a match pauses to the recovery screen"; rul-11-watchdog; context-loss e2e | PASS |
| Glitch list: each line a named regression test | DoD 7 | PASS |

### §15 Teams and data

| Requirement | Evidence | Verdict |
|---|---|---|
| 20 fictional clubs, unique codes, generated crests, three kits, formation and style, ratings 62-88 | [SGN-01] data check (20 / 20 unique codes / 62..88); gfx-08-kits | PASS |
| 18 players per club with 2 keepers; names screened against real footballers | [SGN-01] 18 each; `src/data/screen.ts`; SGN-05 Wikidata screen | PASS |
| Outfield attributes (20) and keeper attributes (5); height, foot, weak foot, skill moves, position, shirt | [SGN-01] field list of `PlayerData` | PASS |
| Every attribute visibly changes play | `docs/ATTRIBUTE_AUDIT.md`: 29 of 29 fields change play (`tests/sim/dat-05-attributes.test.ts`, passed in verify) | PASS |
| Seeded generator, committed | `tools/gen-data.ts`, `src/data/clubs.generated.ts` | PASS |
| 88 beats 62 at least 80 % over 200; equal clubs split close to evenly | FEEL final runs: seeds 1-4, 800 pooled **81.6 %** (seed 4 alone 77.0 %), equal 55.6 % points, mirror 50.1 %; [SGN-01] seed 5: **81.0 %** over 200 | PASS (4 of 5 200-match seeds at or above 80 %; pooled 81.5 % over 1,000) |

### Totals

| Section | Rows | PASS | FAIL | RE-SCOPED | NOT VERIFIABLE HERE |
|---|---:|---:|---:|---:|---:|
| DoD 1-11 (DoD 3 and 6 split in two) | 13 | 11 | 1 | 0 | 1 |
| §2 Ground rules | 7 | 7 | 0 | 0 | 0 |
| §3 Target device and hard limits | 24 | 22 | 0 | 0 | 2 |
| §4 Tech stack and architecture | 14 | 13 | 0 | 1 | 0 |
| §5 Match rules and flow | 15 | 15 | 0 | 0 | 0 |
| §6 Gameplay systems | 23 | 23 | 0 | 0 | 0 |
| §7 AI (incl. the targets table) | 18 | 18 | 0 | 0 | 0 |
| §8 Camera and presentation | 12 | 12 | 0 | 0 | 0 |
| §9 / §10 controls (14 sub-tables, 171 rows in CONTROLS_AUDIT) | 14 | 14 | 0 | 0 | 0 |
| §11 Modes and playing a friend | 17 | 16 | 0 | 0 | 1 |
| §12 Menus, HUD, design system | 9 | 9 | 0 | 0 | 0 |
| §13 Performance plan | 19 | 15 | 2 | 0 | 2 |
| §14 Quality plan | 11 | 11 | 0 | 0 | 0 |
| §15 Teams and data | 6 | 6 | 0 | 0 | 0 |
| **Total** | **202** | **192** | **3** | **1** | **6** |

- **DoD: 11 of 13 rows PASS; DoD 3b (WebKit) NOT VERIFIABLE HERE; DoD 6a FAIL** on one measurement: the throttled proxy's
  4 ms worst-case tick, judged as the p99 of each frame's worst tick, is 4.5 / 3.9 / 4.5 ms (1 of 3 runs passes;
  average, draw-call and triangle budgets pass with wide margins). D-027 records it as measured; BRIEF §13's final gate
  is the iPad benchmark, so DoD 6 closes only with the user's device result.
- **The 3 FAIL rows are 2 findings**: DoD 6a and §13 "4 ms worst case" are the same proxy measurement; §13 "no GC pause
  over 4 ms" fails in Chromium by under 1 ms (two early-match V8 major GCs, max 4.99 ms at 1x, re-measured on the final
  tree; no frame interval over 16.8 ms, so no visible hitch), and only JavaScriptCore on the iPad can settle it. Neither is a match-state, input
  or stability defect, and the campaign and this audit found **0 product defects**.
- **24 of the PASS rows pass in Chromium or the container** with a device half still open (Safari gestures, real
  pads, install, Low Power Mode, real WebRTC, process memory); together with the 6 NVH rows and the RE-SCOPED WebKit
  test project (D-003 / D-023) they are exactly the items of `docs/DEVICE_CHECKLIST.md` (benchmark, five-finger touch,
  multitasking swipe mid-sprint, pad pairing and disconnect, install and offline, one online match).
- **Thin margins worth watching** (all PASS): shots 15.24 against 14 and blow-outs 4.3-4.4 % against 5 % (§7);
  ladder Professional v Semi-Pro 67.3 % pooled (seed 2 alone 64.5 %, SGN-01 seed 3 69.5 %); club balance 81.5 % pooled
  over 1,000 (seed 4 alone 77.0 % over 200); keeper save rate 68.5 % with equal teams.
- **User decision outside the DoD**: SGN-05's note that the repository is named "Fifa"; rename it before any public
  deploy.

<!-- sgn-01:end -->

<!-- sgn-03:start (SGN-03 final campaign; QA-43 / QA-44 from docs/briefs/QF-8.md) -->
## Campaign (SGN-03)

Final campaign on the current tree: HEAD 6839cd4 ("STATUS: FEEL-2 done", after the FEEL-1 / FEEL-2 / FEEL-2C /
FEEL-2D rework, D-028..D-042) plus the campaign's own WIP commit 0477504, which adds only `reports/sgn-03/**`. No
`src/**` file changed during the campaign. Container: 4 shared CPUs, Node 22, Bun 1.4.2 (JavaScriptCore), Chromium 141
headless shell (Playwright 1.56.1), software WebGL (SwiftShader). WebKit and Firefox are not installed (D-023):
everything that needs them is **NOT VERIFIABLE HERE**. Raw evidence: `reports/sgn-03/` (logs are git-ignored `*.log`
files beside the JSON).

A container restart killed the first campaign agent during the e2e step. Steps 1-5 and the build had finished; their
logs and JSON are the evidence below and were not re-run. The build was redone and byte-compared with the first one:
identical (`dist/index.html`, `sw.js` build id `0.1.0-d5415ec8ff`), so every e2e spec ran on the same bytes.

### Verdicts

| Item | Result | Verdict |
|---|---|---|
| `npm run verify` (DoD 1) | typecheck 0 errors, `eslint .` 0 problems, vitest **543 files, 7,473 passed, 1 skipped** (net-08 long netsim, `NETSIM_LONG=1` only), soak:short 10/10; exit 0; 23 min 48 s wall (vitest 1,329.5 s) | PASS |
| Soak 2,000, `--enforce all` (DoD 1, BRIEF §14.2) | 2,000/2,000 finished, 62,490,355 ticks; **0 exceptions, 0 invariant failures, 0 watchdogs, 0 unfinished, 0 events dropped**; determinism PASS; §7 bands all PASS (Professional subset, n = 326) | PASS |
| Soak 500 at Professional (BRIEF §7 band definition) | 500/500, 15,677,872 ticks; 0 / 0 / 0 / 0 / 0; determinism PASS; bands all PASS | PASS |
| Fuzz 500, `--enforce all` (DoD 1, §14.3) | 500 runs + 122 rematches, 8,648,542 ticks; **0 exceptions, 0 invariant failures, 0 watchdogs, 0 failures**; determinism PASS; "unfinished 136" all expected (below) | PASS |
| Determinism in Node (§14.4, QA-43) | `tools/hash-table.ts` x3: **28 configs, IDENTICAL** in all three runs; vitest's V8 v JavaScriptCore (Bun) bit-for-bit test passes in verify | PASS |
| Determinism in Chromium, built app (§14.4, QA-43) | **10 configs x 3 runs**: every 60-tick hash to tick 2,400 identical, and each Chromium recording plays back identically in Node | PASS |
| Saved replay after a page reload (§14.4) | keyboard-driven replay (1,500 ticks, 3,720 non-zero input ints) saved by Settings > Diagnostics, page reloaded, loaded from the file: "replay matched: 1500 ticks"; Node playback IDENTICAL (final 8a3bbbdc) | PASS |
| Determinism in WebKit / Firefox | browsers not installed | NOT VERIFIABLE HERE (re-scoped, D-023) |
| Glitch audit (DoD 7) | `npm run glitch-audit`: **55/55** glitch-list items have a named regression test (the tests themselves pass in verify) | PASS |
| Online harness (DoD 5) | `tools/netsim.ts --halves 2 --latency 80 --jitter 20 --loss 0.05`, seeds 7 and 2026: finished, hashes and frames equal, **0 desyncs, 0 resyncs** both sides (details below) | PASS |
| Whole Playwright suite on the build (DoD 3, 4, 10 Chromium half) | **87 specs, 210 tests**: 84 specs pass first time; 3 specs failed twice on test-harness problems, fixed in `tests/e2e/**`, and pass whole after the fix (below); 0 skipped, 0 flaky; no product defect found | PASS (after harness fixes) |
| DoD 3 in WebKit | browser not installed | NOT VERIFIABLE HERE (re-scoped, D-023) |
| SGN-04 refresh on the build (DoD 6) | `tools/bench.ts --throttle 4` x3 on an idle container: sim avg 0.747 / 0.739 / 0.761 ms (PASS), p99 of frame worst tick 4.5 / 3.9 / 4.5 ms (1 of 3 PASS: D-027), draw calls max 22, triangles max 46,924 (PASS); bench coverage test 2/2; bundle 824.9 KB gzip (20.1 %); main menu 2.15-2.17 s. Details: docs/PERF_REPORT.md "Final benchmark (SGN-04)" | proxy gate 1 of 3 (D-027); on-device benchmark decides |
| Static server (DoD 10) | `dist/index.html` copied alone into an empty folder, Python `http.server`: boots, Kick-Off match runs through the rAF loop to tick 102, quits to the menu; only `/` and the absent optional `/sw.js` requested; zero console errors | PASS |

### Soak and fuzz (QA-44)

| Run | Command | Matches | Ticks | Wall | Exceptions / invariants / watchdogs / unfinished / dropped | Determinism |
|---|---|---:|---:|---:|---|---|
| soak | `npm run soak -- --workers 3 --enforce all --json reports/sgn-03/soak.json` (seed 1, 4-min halves, every difficulty, clubs, formations, rule toggles) | 2,000 | 62,490,355 | 1,680 s | 0 / 0 / 0 / 0 / 0 | PASS: 18af1f31 == 18af1f31 (same seed twice, again after another match in the worker), replay JSON round trip identical over 31,864 ticks |
| soak Professional | `npx tsx tools/soak.ts --matches 500 --workers 3 --seed 2026 --difficulty 3 --enforce all` | 500 | 15,677,872 | 410 s | 0 / 0 / 0 / 0 / 0 | PASS: 349a9873 x3 over 41,412 ticks |
| fuzz | `npm run fuzz -- --workers 3 --enforce all --json reports/sgn-03/fuzz.json` (seed 1, up to 2-min halves) | 500 + 122 rematches | 8,648,542 | 301 s | 0 / 0 / 0 / 136 expected / 0 | PASS: ff10cdd4 x3 over 15,500 ticks |

Sim cost in the soak: 0.0600 ms a tick on average (Node, 3 workers; invariant checks 0.0171 ms a tick on top).

**§7 bands** (equal teams, Professional, 4-minute halves):

| Band | Target | Soak 2,000 (Professional, n = 326) | Soak 500 Professional (n = 500) |
|---|---|---|---|
| Goals per match | 2.0-3.6 | 2.92 PASS | 3.08 PASS |
| Shots per match | 14-26 | 15.24 PASS | 15.24 PASS |
| Possession, side with more of the ball | 40-60% | 57.18% PASS (234/326 inside) | 57.26% PASS (362/500 inside) |
| Possession, home side | 40-60% | 49.81% PASS | 49.02% PASS |
| Pass completion | 70-88% | 78.84% PASS | 78.73% PASS |
| Fouls per match (fouls on) | 6-16 | 10.64 PASS (n = 277) | 10.64 PASS (n = 433) |
| Offsides per match (offside on) | 0-6 | 0.17 PASS (n = 281) | 0.18 PASS (n = 428) |
| Blow-outs (5+ goal margin) | under 5% | 4.29% PASS (14 matches) | 4.40% PASS (22 matches) |

The shots band sits near its lower edge (15.24 against 14) and blow-outs near their upper edge (4.4% against 5%), as
recorded since QF-14. The 10-match `soak:short` inside verify reports bands only for information (2-minute halves,
n = 10): goals 1.60, shots 5.80 and fouls 5.00 miss there by design of the short run and are not enforced.

**Fuzz "unfinished 136"** (`reports/sgn-03/fuzz-unfinished.txt`): the total counts every run, primaries and rematches
(622), that did not reach full time. 112 are primaries with a planned `quit@<tick>` (the quit-and-rematch jobs stop
there on purpose; 10 more quit jobs finished before their quit tick); 21 are Practice primaries without a quit
(practice has no full time: `expectFinish` false, they run to the 10,800-tick cap); 3 are the rematches of Practice
quit jobs (#236, #309, #419). None is a job expected to finish: 0 "unfinished" failure reasons, `failures: none`.

### Determinism (QA-43)

- Node: `tools/hash-table.ts` three times (`reports/sgn-03/hash-run1..3.json`, `hash-compare.log`): 28 runs each
  (bot matches at every difficulty, a full 4-minute-halves match, cup seeds, rule toggles off, bot and scripted
  shoot-outs, every practice kind and the tutorial, a scripted human v Legend, hostile p1 v p2 input, soak #0-#2 and
  fuzz #0-#5 including a quit): **IDENTICAL**.
- Chromium, built app (`tests/e2e/sgn-03-determinism.spec.ts`, `reports/sgn-03/replays/chromium-hash-table.txt`):
  ten configs covering seeds 1 to 4,000,000,000, 20 clubs, all six formations, all six difficulties, offside and
  fouls off, cup rules and night; three runs each in one page through the app's own loop and recorder; 40 checkpoint
  hashes per run identical across the three runs, e.g. config 0 (seed 1, Professional) 7547e8e7, config 7 (seed
  4,000,000,000, Legend) 3d174ac3; each first run's recording replayed by `tools/replay-inspect.ts` in Node: final
  hash IDENTICAL for all ten.
- Replay after reload: as in the table above (`reports/sgn-03/replays/chromium-keyboard-reload.json`).

### Online (DoD 5)

`npx tsx tools/netsim.ts --halves 2 --latency 80 --jitter 20 --loss 0.05 --seed <s>`:

| Seed | Result | Ticks | Desyncs / resyncs | Stalls after warm-up (max) | RTT host / guest | Inputs dropped by the link |
|---|---|---:|---|---|---|---|
| 7 | finished, hashesEqual, framesEqual, 0-1 | 16,168 | 0 / 0 | host 0, guest 11 (33 ms) | 204 ± 52 / 192 ± 38 ms | 1,649 of 32,363 |
| 2026 | finished, hashesEqual, framesEqual, 0-0 | 16,352 | 0 / 0 | host 1 (17 ms), guest 8 (17 ms) | 212 ± 54 / 253 ± 106 ms | 1,665 of 32,731 |

The campaign's netsim logs carry no command line, so both seeds were run once more with the command above recorded
(`reports/sgn-03/netsim-seed{7,2026}-confirm.log`, 4 s each): output identical to the campaign logs apart from wall
time. The browser side of online play passed too: int-08-online, int-08-webrtc (real WebRTC through a local PeerServer),
net-07-online, qf-6-online and qf-6-s2-rejoin (rejoin) in the e2e table.

### End to end on the build

`npm run build` (postbuild PASS, 824.9 KB gzip), copied to `dist-e2e/sgn-03`; every spec run alone with
`PW_DIST=dist-e2e/sgn-03 PW_PORT=4503 npx playwright test tests/e2e/<spec>.spec.ts --project=chromium-ipad`
(`reports/sgn-03/e2e/run-e2e.sh`; JSON and log per spec in `reports/sgn-03/e2e/`, one line per run in
`summary.tsv`), one worker, a failed spec re-run once at once. 87 specs, 210 tests, 5,185 s of first runs; the
container's 1-minute load during the runs was 0.9-10.3 (SwiftShader's own threads).

DoD coverage in this run (Chromium at iPad size, every spec asserting zero console errors):
- **DoD 3, touch alone**: int-b-touch-match (full Kick-Off match by touch: menus, play, pause, half time, full time,
  rematch, quit; clock fast-forwarded), qf-12-menu-paths "touch alone" (cup tie, every pause page, practice restart
  and quit, tutorial, shoot-out flow), int-b-modes (cup tie, practice and tutorial to their end screens by touch;
  shoot-out by touch swipe to the final screen), uix-05-match-flow, uix-11-cup-practice.
- **DoD 3, controller alone**: int-b-pad-match (full Kick-Off match by pad, Options pause, half time, full time,
  quit), qf-12-menu-paths "controller alone" (cup tie and every pause page, practice, tutorial, shoot-out flow,
  diagnostics; Play now to full time), qf-12-sk-cup-back, uix-05-match-flow "controller alone", pad-08-menus.
- **DoD 4**: int-b-modes "same-iPad 1v1: pad vs pad and touch vs pad, no crosstalk, only the pauser resumes, full
  time, Change Teams"; uix-04-side-select (touch + pad and two pads).
- **DoD 10**: sgn-03-static.
- **FEEL**: feel-1-feel (1/1). It is the only `tests/e2e/feel-1-*.spec.ts`; the other FEEL tests are vitest files and
  passed in verify.

Not covered: an online match in WebKit, and any spec in WebKit or Firefox (NOT VERIFIABLE HERE). The full matches are
2-minute halves with the clock fast-forwarded (SwiftShader draws a frame in 100-500 ms).

**Harness fixes** (`tests/e2e/**` only; each spec failed twice with identical symptoms before the fix):

1. `fnd-int-skeleton.spec.ts`: (a) the quit steps never tapped the UIX-08 quit confirmation that INT-B added
   (`pause-quit-confirm`, as fnd-04-boot does); (b) the input checks ("holding D moves the player toward +x", "an
   upward drag moves him toward -z", "the pad's left stick moves him toward -x", "release stops him", and the two
   after the restart / second Kick-Off) ran in a live match against the CPU and measured the ball or the restart
   instead of the input: traced samples showed the controlled player on the ball (a teammate's pass, the FEEL-1
   receiving magnet), control moving to the keeper or a teammate who won the ball, a body contact pushing him
   (0.7 m away), and PRE_MATCH / kick-off set-ups where the stick does not drive him. Each check now presses, holds,
   releases and samples in up to 8 attempts and asserts the first clean sample (same player, open play, off the
   ball, no action, nobody within 1.5 m); no clean sample fails the test. Re-runs after the final version: 4 of 4
   pass (`fnd-int-skeleton.fixed-v4-1..4`); earlier stricter or looser versions are kept in the log (v1-v3).
2. `int-c-live.spec.ts`: the scripted goal is poked into the ball after a 6-second lead-in; on this tree the lead-in
   of that fixed-seed match ends at a free kick (traced: phase 6 at the poke), so the sim resets the ball for the
   restart and no goal follows (deterministic: 1/2 twice). The lead-in is now taken again until it ends in open play.
   After: 2/2.
3. `review-fnd-05-adversarial.spec.ts` "pad: disconnect mid-hold ...": the button press that wakes the mocked pad is
   also a game press (button 2 = PASS); the controlled player was next to the ball after the kick-off and passed, and
   the kick action held him 33 ticks (traced), so the 45-tick window measured 0.25 m (identical in both runs). The stick
   now starts once the player is free in open play. After: 9/9.

Some tracked files are rewritten by specs on every run: `reports/skeleton.png` (fnd-int-skeleton),
`reports/plt-04-startup.json` (plt-04-build; last written by the idle SGN-04 load-time run) and the screenshots
`reports/uix-06-hud-*.png`, `reports/uix-07-power*.png` and `reports/uix-12-*.png` (uix-06, uix-07, uix-12); their new
content is from this campaign's build.

| Spec | Tests | First run (passed/total, time) | Re-run | After harness fix | Verdict |
|---|---:|---|---|---|---|
| aud-01-engine | 2 | 2/2 (21 s) | - | - | PASS |
| aud-02-match-audio | 1 | 1/1 (20 s) | - | - | PASS |
| aud-05-menus | 1 | 1/1 (4 s) | - | - | PASS |
| feel-1-feel | 1 | 1/1 (90 s) | - | - | PASS |
| fin-a-menu-frames | 1 | 1/1 (5 s) | - | - | PASS |
| fnd-04-boot | 6 | 6/6 (68 s) | - | - | PASS |
| fnd-04-review-fixes | 5 | 5/5 (54 s) | - | - | PASS |
| fnd-05-fixes | 3 | 3/3 (58 s) | - | - | PASS |
| fnd-05-skeleton | 7 | 7/7 (157 s) | - | - | PASS |
| fnd-int-skeleton | 1 | 0/1 (68 s) | 0/1 | final version 4/4 runs pass (v1 0/1, v2 2/3, v3 2/3 kept in summary.tsv) | PASS after harness fix (failed x2 before) |
| gfx-01-renderer | 2 | 2/2 (66 s) | - | - | PASS |
| gfx-02-quality | 1 | 1/1 (46 s) | - | - | PASS |
| gfx-03-pitch | 1 | 1/1 (35 s) | - | - | PASS |
| gfx-04-goals | 1 | 1/1 (29 s) | - | - | PASS |
| gfx-05-stadium | 1 | 1/1 (34 s) | - | - | PASS |
| gfx-06-crowd | 1 | 1/1 (35 s) | - | - | PASS |
| gfx-07-players | 1 | 1/1 (23 s) | - | - | PASS |
| gfx-08-kits | 2 | 2/2 (23 s) | - | - | PASS |
| gfx-12-anim | 2 | 2/2 (79 s) | - | - | PASS |
| gfx-13-markers | 1 | 1/1 (38 s) | - | - | PASS |
| gfx-14-camera | 1 | 1/1 (40 s) | - | - | PASS |
| gfx-15-cameras | 1 | 1/1 (29 s) | - | - | PASS |
| gfx-16-replay | 1 | 1/1 (37 s) | - | - | PASS |
| int-08-online | 1 | 1/1 (102 s) | - | - | PASS |
| int-08-webrtc | 1 | 1/1 (46 s) | - | - | PASS |
| int-b-modes | 3 | 3/3 (314 s) | - | - | PASS |
| int-b-pad-match | 3 | 3/3 (216 s) | - | - | PASS |
| int-b-setpieces | 2 | 2/2 (254 s) | - | - | PASS |
| int-b-settings | 1 | 1/1 (40 s) | - | - | PASS |
| int-b-touch-match | 1 | 1/1 (137 s) | - | - | PASS |
| int-c-live | 2 | 1/2 (199 s) | 1/2 | 2/2 | PASS after harness fix (failed x2 before) |
| net-07-online | 3 | 3/3 (50 s) | - | - | PASS |
| pad-01-devices | 1 | 1/1 (5 s) | - | - | PASS |
| pad-02-mapper | 2 | 2/2 (9 s) | - | - | PASS |
| pad-03-reconnect | 2 | 2/2 (7 s) | - | - | PASS |
| pad-04-sequences | 1 | 1/1 (8 s) | - | - | PASS |
| pad-05-rightstick | 1 | 1/1 (9 s) | - | - | PASS |
| pad-07-remap | 1 | 1/1 (8 s) | - | - | PASS |
| pad-08-menus | 3 | 3/3 (11 s) | - | - | PASS |
| plt-01-pwa | 2 | 2/2 (9 s) | - | - | PASS |
| plt-02-ipados | 3 | 3/3 (41 s) | - | - | PASS |
| plt-03-storage | 2 | 2/2 (7 s) | - | - | PASS |
| plt-04-build | 3 | 3/3 (14 s) | - | - | PASS |
| plt-05-recovery | 4 | 4/4 (68 s) | - | - | PASS |
| qf-12-hud-kits | 1 | 1/1 (21 s) | - | - | PASS |
| qf-12-match-guard | 1 | 1/1 (22 s) | - | - | PASS |
| qf-12-menu-paths | 3 | 3/3 (149 s) | - | - | PASS |
| qf-12-monkey | 2 | 2/2 (70 s) | - | - | PASS |
| qf-12-sk-cup-back | 1 | 1/1 (13 s) | - | - | PASS |
| qf-17-halftime | 1 | 1/1 (31 s) | - | - | PASS |
| qf-17-skeptic-halftime | 1 | 1/1 (29 s) | - | - | PASS |
| qf-3-input | 4 | 4/4 (61 s) | - | - | PASS |
| qf-4-look | 2 | 2/2 (143 s) | - | - | PASS |
| qf-4-skeptic | 2 | 2/2 (175 s) | - | - | PASS |
| qf-5-lifecycle | 3 | 3/3 (37 s) | - | - | PASS |
| qf-5-verify | 2 | 2/2 (23 s) | - | - | PASS |
| qf-6-online | 2 | 2/2 (159 s) | - | - | PASS |
| qf-6-s2-rejoin | 1 | 1/1 (64 s) | - | - | PASS |
| qf-7r-hud | 1 | 1/1 (44 s) | - | - | PASS |
| review-fnd-04-adversarial | 16 | 16/16 (214 s) | - | - | PASS |
| review-fnd-05-adversarial | 9 | 8/9 (202 s) | 8/9 | 9/9 | PASS after harness fix (failed x2 before) |
| sgn-03-determinism | 2 | 2/2 (68 s) | - | - | PASS |
| sgn-03-static | 1 | 1/1 (21 s) | - | - | PASS |
| sgn-05-network | 2 | 2/2 (109 s) | - | - | PASS |
| sgn-05-proxylog | 1 | 1/1 (184 s) | - | - | PASS |
| tch-01-pointers | 2 | 2/2 (84 s) | - | - | PASS |
| tch-02-stick | 3 | 3/3 (87 s) | - | - | PASS |
| tch-03-buttons | 4 | 4/4 (52 s) | - | - | PASS |
| tch-04-swap | 2 | 2/2 (5 s) | - | - | PASS |
| tch-05-gestures | 3 | 3/3 (22 s) | - | - | PASS |
| tch-06-setpiece | 2 | 2/2 (6 s) | - | - | PASS |
| tch-07-touch-input | 4 | 4/4 (5 s) | - | - | PASS |
| tch-08-editor | 2 | 2/2 (8 s) | - | - | PASS |
| tch-09-overlay | 5 | 5/5 (9 s) | - | - | PASS |
| tun-7s-live-copy | 1 | 1/1 (26 s) | - | - | PASS |
| uix-01-design | 8 | 8/8 (44 s) | - | - | PASS |
| uix-02-menus | 9 | 9/9 (37 s) | - | - | PASS |
| uix-03-team-select | 3 | 3/3 (13 s) | - | - | PASS |
| uix-04-side-select | 3 | 3/3 (12 s) | - | - | PASS |
| uix-05-match-flow | 3 | 3/3 (38 s) | - | - | PASS |
| uix-06-hud | 1 | 1/1 (29 s) | - | - | PASS |
| uix-07-hud | 1 | 1/1 (57 s) | - | - | PASS |
| uix-08-pause | 2 | 2/2 (34 s) | - | - | PASS |
| uix-09-settings | 2 | 2/2 (13 s) | - | - | PASS |
| uix-10-breaks | 2 | 2/2 (63 s) | - | - | PASS |
| uix-11-cup-practice | 3 | 3/3 (38 s) | - | - | PASS |
| uix-12-tutorial | 1 | 1/1 (51 s) | - | - | PASS |

### Reproduce

```sh
npm run verify
npx tsx tools/soak.ts --matches 2000 --workers 3 --enforce all --json reports/sgn-03/soak.json
npx tsx tools/soak.ts --matches 500 --workers 3 --seed 2026 --difficulty 3 --enforce all --json reports/sgn-03/soak-pro500.json
npx tsx tools/fuzz.ts --matches 500 --workers 3 --enforce all --json reports/sgn-03/fuzz.json
npx tsx tools/hash-table.ts --out reports/sgn-03/hash-run1.json && npx tsx tools/hash-table.ts --compare reports/sgn-03/hash-run1.json   # x3
npm run glitch-audit
npx tsx tools/netsim.ts --halves 2 --latency 80 --jitter 20 --loss 0.05 --seed 7     # and --seed 2026
npm run build && rm -rf dist-e2e/sgn-03 && cp -r dist dist-e2e/sgn-03
reports/sgn-03/e2e/run-e2e.sh            # every spec alone, resumable; re-runs a failure once
PW_DIST=dist-e2e/sgn-03 PW_PORT=4503 npx playwright test tests/e2e/sgn-03-determinism.spec.ts tests/e2e/sgn-03-static.spec.ts
```
<!-- sgn-03:end -->
