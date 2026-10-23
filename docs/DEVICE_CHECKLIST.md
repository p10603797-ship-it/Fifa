# DotKick device checklist (15 minutes on the iPad)

A script for one person with the iPad. It covers what automated tests cannot: the real frame rate, real fingers,
iPadOS gestures, a real controller, the installed app offline, and one online match. Work top to bottom; each step
says how long it takes, what to do, and what counts as a pass. At the end, paste the **results sheet** and the
**benchmark text** back.

## Before you start (not counted in the 15 minutes)

- The iPad is charged above 50 %, on a current iPadOS, **not** in Low Power Mode (**Settings > Battery**), and other
  apps are closed (swipe them away in the app switcher).
- You have the game's `https://` address (a published site, see the [README](../README.md#4-put-it-online-for-free)).
- A Bluetooth controller (PlayStation, Xbox or Switch Pro), charged.
- A second device with a browser for the online match: another iPad, an iPhone or a computer, on the internet.
- Wi-Fi on.

If anything fails: note the step, then open **Settings > Diagnostics** in the game and tap **Copy report**; paste that
text with your results. For anything that went wrong during a match, also tap **Save replay** there (it saves a file
that replays the match exactly).

## 1. Install (1 minute)

1. Open the address in **Safari**. Tap the screen to start. The start screen shows a hint about the Home Screen.
2. Tap **Share** (on some iPadOS versions inside the **•••** menu), then **Add to Home Screen**, then **Add**.
3. Close Safari's tab and open **DotKick** from the Home Screen.

**Pass:** the app opens full screen (no Safari toolbar), in landscape, with the DotKick icon on the Home Screen.

## 2. Benchmark (3 minutes)

1. In the Home Screen app: **Settings > Diagnostics > Run benchmark**. (In Safari the same benchmark runs when `?bench=1`
   is added to the address.)
2. Do not touch the screen. It plays a fixed bot-v-bot match for about 90 seconds after a short warm-up, including a
   crowded penalty area, a corner, a goal and a replay.
3. When the results panel appears, tap **Copy Results** and paste the text into your notes.

**Pass:** the panel says **PASS**. The targets: average 58 fps or more, 1 % low 50 fps or more, longest frame 33 ms or
less, sim 2.5 ms average and 4 ms worst, 80 draw calls or fewer, 200,000 triangles or fewer. Send the text either way.

## 3. Five-finger touch test (2 minutes)

1. **Settings > Diagnostics > Input tester**. Put five fingers on the touch area at once, then move them around, then
   lift them one at a time. Tap **Close tester** when done.
2. Back on the main menu, tap **Play now**. In the match, at the same time: hold the stick with the left thumb, hold
   **SPRINT** with the right thumb, and tap **PASS** and the pitch with other fingers. Then press PASS and SHOOT while
   still holding the stick and sprint.

**Pass:** the tester shows five separate touch points that follow your fingers and disappear when lifted. In the match
the player keeps running and sprinting while the other fingers pass and shoot; no touch steals another (the stick
never jumps to another finger, a button never fires from a pitch tap). Every button lights up the moment it is
touched.

## 4. Multitasking swipe in the middle of a sprint (2 minutes)

1. Still in the match: hold the stick fully forward and hold **SPRINT** so your player sprints.
2. Without lifting those thumbs, swipe up from the bottom edge with another finger to go to the Home Screen (or pause
   on the way up to open the app switcher).
3. Wait three seconds. Open DotKick again.
4. Repeat once with Control Center (swipe down from the top-right corner) during a sprint, then close Control Center.

**Pass:** on return the match is **paused** with the pause menu showing; the clock did not jump ahead. After
**Resume**, with no fingers on the screen, your player stands still and is not sprinting: nothing is stuck. The stick
and SPRINT work normally on the next touch. Sound comes back after you tap.

## 5. Controller: pair, play, disconnect mid-match (3 minutes)

1. Pause and quit to the main menu. Put the controller in pairing mode (PlayStation 5: hold **Create + PS**; PlayStation
   4: hold **Share + PS**; Xbox: hold the **Pair** button on top; Switch Pro: hold the **sync** button on top). Open
   **Settings > Bluetooth** on the iPad and tap the controller under **Other Devices**.
2. Go back to DotKick and press any button on the controller.
3. Start **Kick-Off**, and on side select move the controller to a side (left for home or right for away). Play 30
   seconds: move, sprint (R2 / RT), pass (Cross / A), shoot (Circle / B), switch player while defending (L1 / LB).
   The touch buttons should hide while the controller plays.
4. Turn the controller off in the middle of play (PlayStation: hold the **PS** button about 10 seconds; Xbox: hold the
   **Xbox** button about 6 seconds; Switch Pro: press its **sync** button once).
5. Turn it on again (press **PS** / **Xbox** / **Home** once) and press any button.
6. Turn it off once more, and this time choose to hand the side to **touch** on the card; play a few seconds by touch.

**Pass:** the menus and the match respond to the controller, with button names matching the controller. The match
**pauses at once** when the controller goes off and shows a reconnect card. A button press after it reconnects resumes
the match, and that press does not also pass or shoot. The hand-off to touch works, and touch controls come back.

## 6. Install and play offline (2 minutes)

1. Quit to the main menu. Turn on **Airplane Mode** (Control Center) and make sure Wi-Fi is off too.
2. Close DotKick completely: open the app switcher and swipe it away.
3. Open DotKick from the Home Screen. Tap **Play now** and play 30 seconds.
4. Turn Airplane Mode off again.

**Pass:** the app starts and the match plays normally with no network at all. (Online 1v1 is the only part that needs
the internet.)

## 7. One online match (2 minutes, plus the match)

1. On the iPad: **Play a Friend > Online**, then **Create room**. Note the 6-character code.
2. On the second device: open the same game address, then **Play a Friend > Online > Join room**, and enter the code
   (or open the share link from **Copy link** / **Share…**).
3. Both pick a club (**Your club**) and tap **Ready**; the iPad (host) sets the half length. Play at least two minutes
   (choose the shortest half length to finish a whole match).
4. Pause once from each side, and resume (only the player who paused can resume early).

**Pass:** the two devices connect, the match starts on both, the players move smoothly, and the score and clock agree
on both screens. If the connection pauses, a small waiting indicator shows and play continues by itself. Any error
shows a plain-language message. If it fails, write down the exact message and whether both devices were on the same
Wi-Fi; then try again with both on the same Wi-Fi or on a phone hotspot.

## Results sheet (copy, fill in, paste back)

```text
DotKick device checklist          Date:            iPad model:            iPadOS:
Game address:                     Game version (Settings > Diagnostics):

1. Install                 PASS / FAIL   notes:
2. Benchmark               PASS / FAIL   (paste the Copy Results text below)
3. Five-finger touch       PASS / FAIL   notes:
4. Multitasking swipe      PASS / FAIL   notes:
5. Controller + disconnect PASS / FAIL   controller model:          notes:
6. Offline                 PASS / FAIL   notes:
7. Online match            PASS / FAIL   second device:             same Wi-Fi? yes / no   notes:

Anything else that looked wrong (where, what you did, what happened):

Benchmark result:
<paste here>

Diagnostics report (only if something failed):
<paste here>
```

Anything that fails here is treated as a failing test: it is reproduced (from the replay file where there is one),
fixed, covered by a regression test, and the build is sent back for another run of the failing steps.
