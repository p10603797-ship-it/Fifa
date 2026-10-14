# INT-B — Input, app shell, UI, platform, audio and modes integration (INT-02 + INT-05..08 + app wiring CRs)

Owns for this wave: `src/app/**`, `src/input/**`, `src/ui/**` (except `src/ui/screens/online.ts`, which NET owns),
`src/platform/**`, `src/audio/**`, `src/modes/**` (except `src/modes/stats.ts` event definitions, which INT-A may
touch), `public/**`, `index.html`, plus tests `tests/unit/fnd-04-*.test.ts`, `tests/e2e/review-fnd-04-*.spec.ts`, and
new tests `tests/**/int-b-*.test.ts` / `tests/e2e/int-b-*.spec.ts`. All Wave 1 owners of these folders are finished; you
are the single integrator — keep their tests passing or update a test whose expectation an intended change makes
obsolete (say why). Do not edit `src/contracts/**`, `src/sim/**`, `src/ai/**`, `src/render/**` (INT-A and INT-C own
those right now). The renderer exposes the broadcast camera x through a getter INT-C adds; if it is not there yet,
read it defensively (`(renderer as {cameraX?: () => number}).cameraX?.()`) and log a CR.

Goal (BRIEF §3, §9-§12, §15, §16, DoD 1-4, 6-8): the shipped app plays complete matches end to end in every local
mode, by touch alone and by controller alone, with settings applied everywhere and persisted, and installs and runs
offline. Nothing the Wave 1 modules built is left unwired.

Wiring to do (from Wave 1 reports; details in the module files and tests named):
1. Platform (PLT-02/05): in boot `installIpadHardening({...})` add `onViewportChange: () => sess.releaseInputs()`; delete
   the per-frame `ipad.reportFrame(...)` call (GFX-02's detector is the only Low Power path; keep onLowPowerSuspected).
   Add `onTick?(rt: MatchRuntime): void` to SessionDeps, called first in afterTick; in boot create
   `createLiveReplayRecorder()` + `setAppReplayRecorder`, pass `onTick`, call `installRecovery(appCtx, { recorder })`
   and add an `attach: false` option so recovery no longer wraps afterTick. Update tests/unit/fnd-04-platform.test.ts:
   remove the old Low Power detector case; `d.total` 21 -> 22. index.html: `<link rel="icon" type="image/png"
   sizes="32x32" href="icons/icon-32.png" />`. tests/e2e/review-fnd-04-adversarial.spec.ts "blocked localStorage ...
   quits" needs UIX-08's pause quit-confirm step.
2. Controllers (PAD-03/PAD-06/PAD-07): in boot install `installReconnectFlow({ session: sess, devices, platform, root:
   uiRoot, focus, onError })` and `createRumbleListener(devices, settings)`; dispose both with the app; add
   `rumble?: {onEvents(ev, s)}` to LoopDeps and call it after `audio.onEvents` (try/catch -> onError); `rumble.stopAll()`
   on pause and at match end. Implement `SessionControl.setHumanDevice` fully in src/app/session.ts (an interim
   version handles only 'cpu' via Command.HAND_TO_CPU, which the sim already handles — see D-019): for a device list,
   update the binding, dispose that human's local sources and create new ones with `devices.createSource(id, human)`
   (extend app/localInput.ts as needed); return false online / with a custom input provider. Verify the PAD-03 card in
   the real app: unplug (simulated gamepad disconnect) -> pause card -> reconnect resumes / hand to touch / hand to CPU.
3. Input source settings and pause (PAD-02): devices.ts createBoundPadSource passes `settings: opts.settings` so remaps
   apply (check it is done); on session pause call releaseAll() on every input source synchronously and ignore a pause
   request while already paused.
4. Touch (TCH-07/TCH-08/TCH-09/TCH-03): in src/input/touch/index.ts after createClusterController:
   `overlay.bind({ cluster, stickConfig: stickCfg, touchSettings: touch, now })`. In src/input/devices.ts touch
   createSource: hide touch controls while a pad drives the same side with `createPadDriveWatcher` (snippet in the PAD
   report: watcher over `src.state`, pads, and the keys bound to that human; update it in pollFrame). In
   src/input/touch/attack.ts computeClusterLayout keep the pause button top right when mirrored
   (`out.pause.cx = w - sRight - margin - pr;`) and clear the todo in tch-09-overlay.test.ts.
5. Audio (AUD-03/AUD-05): router back sound (UiSound.BACK on router.back from a user action); `sfx.setCameraX` each
   frame from the renderer camera x getter (see above). Online crowd perspective stays a NET item.
6. Modes and screens: every local mode (kick-off, cup, practice kinds, shoot-out, same-iPad 1v1) starts, plays to its
   end screen, and Rematch / Change Teams / Quit work; half-time and full-time flows; pause menu tactics/subs reach the
   sim through queueCommand; settings screens change what they say (camera, HUD, audio volumes, controls, assist,
   accessibility) live and after reload.

Verify (vite build; Playwright Chromium, iPad viewport 1180x820 landscape, DPR 1; your own PW_DIST / PW_PORT):
- Full-match e2e at a short half length: (a) touch only, (b) controller only (simulated Gamepad API), in kick-off mode;
  quick runs for every other mode; same-iPad 1v1 controller vs controller and touch vs controller (two humans, no
  input crosstalk; only the pauser resumes).
- Settings persisted across reload; storage blocked still plays (in-memory).
- Build -> install -> offline: service worker serves the app with the network gone; update toast path.
- No console errors from the game in any run; no stuck inputs after pause/resume, blur, rotate, resize.
Run only your own tests and the existing tests of the folders you own (vitest maxWorkers 2).

Report: wiring done (each item above), e2e runs and results, screenshots reviewed (paths), bugs fixed, remaining
issues and CRs for INT-A / INT-C / NET.
