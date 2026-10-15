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

## Rendering and animation (QF-4)
- Swipe-hint labels of a held big button can sit over a neighbouring button's label (first matches only, while held).
- In 145 of 3200 kit pairings both teams' shorts are close in colour; shirts and keepers are always distinct.
- A human set-piece aim far (> ~25 deg) toward the side away from the camera can let the taker briefly cover the ball
  while lining up.
- Foot kicks on the run slide the support boot through the strike (the kick clip needs its own legs); at running speed
  the drawn runner can trail his sim position by up to 0.3 m (foot lock), markers follow the drawn position.
- A very fast head-on first touch (about 17 m/s closing) can leave the boot about 0.65 m from the ball; headers have no
  head reach (head 0.4-0.5 m from the ball at contact).
- The night look is subtle (lighting only).

## Match engine (QF-1, QF-9, QF-10)
- A tall player can visually overlap a goal post by up to about 4 cm (the goal-box confine uses the standard body
  radius); never inside the frame.
- A goal-line free-kick wall member whose slot is where the keeper stands is pushed a body-width off his slot, leaving a
  small gap at the end of the wall.
- At free kicks within 35 m of goal, "choose the taker" swaps the two players instantly (set-piece camera).
- If the 12 s restart timeout fires while a newly chosen taker is still running in, he is placed on his spot.
- A taker whose kick goes a different way from his line-up can side-step round the ball in a frozen kick pose for
  6-14 ticks before the strike.
- A dribbler who turns sharply and passes can draw the ball through his own body to the kicking spot (reads like a
  drag-back).

## Not verified in this environment
- WebKit (iPad Safari) and Firefox are not installed in the build container; every end-to-end run used Chromium. The
  iPad-specific behaviours (audio suspend timing, Low Power Mode, controller pairing, real WebRTC between devices) are in
  docs/DEVICE_CHECKLIST.md.
