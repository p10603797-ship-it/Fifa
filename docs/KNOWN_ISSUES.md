# Known issues

Only cosmetic issues may be listed here (BRIEF §14). Nothing that affects match state, input or performance stays
open; those are fixed with a regression test. Each line names the area and where it was found.

## Audio and platform (QF-5)
- Menus can drop one frame (about 10-25 ms) once, in the first couple of seconds after the splash tap, while the
  crowd-bed loop's crossfade prefix renders. It never happens in play: the audio bank is finished while a match loads.
- Hiding the page drops the audio output to 0 at once before the context suspends; on some devices this may give a
  very short click as the app goes to the background.
- When a waiting update is replaced by a newer deploy while its toast is showing, a second "Update available" toast
  can stack under the first. Either Reload button works and reloads once into the newest build.

## Online 1v1 (QF-6)
- A guest that rejoined after a page reload sees full-time statistics (possession, shots, passes) counted from the
  rejoin tick. The score is correct.
- After a guest resync, the events of the re-simulated ticks fire again (a sound or HUD cue can repeat), the renderer
  interpolates one frame from the old state, and the two devices' statistics panels may differ slightly.
- A reloaded guest's first match frame pops from the initial state to the snapshot.
- When the same guest re-dials while in the lobby, the host may briefly see "Your friend left the room" just before the
  friend reappears.

## Not verified in this environment
- WebKit (iPad Safari) and Firefox are not installed in the build container; every end-to-end run used Chromium. The
  iPad-specific behaviours (audio suspend timing, Low Power Mode, controller pairing, real WebRTC between devices) are in
  docs/DEVICE_CHECKLIST.md.
