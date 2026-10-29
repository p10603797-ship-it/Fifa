# DotKick

DotKick is an original 11-a-side football game for the iPad. It runs in Safari or as a Home Screen app, plays
offline after the first visit, and works with touch, with up to two Bluetooth controllers, and with a keyboard on a
computer. You can play a full match against bots, or 1v1 against a friend on the same iPad or online with a room
code. Every team, player, kit and stadium is invented.

The whole game is one file, `dist/index.html`, plus a few small optional files beside it (the app manifest, the
offline helper `sw.js` and the icons). There is no server, no account, no ads and no tracking.

**Contents**

1. [Play it on the iPad in three steps](#1-play-it-on-the-ipad-in-three-steps)
2. [Run it on your computer](#2-run-it-on-your-computer)
3. [Open your own build on the iPad (HTTPS)](#3-open-your-own-build-on-the-ipad-https)
4. [Put it online for free](#4-put-it-online-for-free)
5. [Add it to the Home Screen and play offline](#5-add-it-to-the-home-screen-and-play-offline)
6. [Pair a controller](#6-pair-a-controller)
7. [Play a friend](#7-play-a-friend)
8. [Controls reference](#8-controls-reference)
9. [Troubleshooting](#9-troubleshooting)
10. [Privacy](#10-privacy)
11. [For developers](#11-for-developers)
12. [Credits and licences](#12-credits-and-licences)

---

## 1. Play it on the iPad in three steps

Once the game is online (section 4 shows two free ways):

1. On the iPad, open the game's `https://` address in **Safari**.
2. Tap the screen to start (this also turns the sound on). Tap the **Share** button, then **Add to Home Screen**,
   then **Add**.
3. Open **DotKick** from the Home Screen and tap **Play now**. Hold the iPad in landscape.

The Home Screen app runs full screen and keeps working without internet (except online 1v1).

---

## 2. Run it on your computer

You need a Mac, Windows or Linux computer with **Node.js 22 LTS** (version 20.19 or newer also works). Get the
installer from [nodejs.org](https://nodejs.org/). Node.js includes `npm`, the tool used below.

1. Get the code: either `git clone` the repository, or on GitHub press **Code**, then **Download ZIP**, and unzip it.
2. Open a terminal in the project folder (the folder that contains `package.json`).
   - Mac: in Finder, right-click the folder, then **Services > New Terminal at Folder** (or open Terminal, type
     `cd` and a space, drag the folder onto the window, and press Return).
   - Windows: open the folder in File Explorer, click the address bar, type `cmd` and press Enter.
3. Install the pinned dependencies (once, and again after you update the code):

   ```sh
   npm install
   ```

   npm may print funding or "vulnerabilities" notices. They concern the build tools on your computer, not the game
   (`npm audit --omit=dev` reports none for the game's own libraries), and do not stop anything from working.
4. Start the development server:

   ```sh
   npm run dev
   ```

   It prints two addresses. Open the `Local` one, `http://localhost:5173/`, in Chrome, Safari or Firefox. The
   `Network` one (for example `http://192.168.1.23:5173/`) is the same game for other devices on your Wi-Fi.
   Changes to the code reload the page by themselves. Stop the server with **Ctrl+C** in the terminal.
5. Make the real, single-file build:

   ```sh
   npm run build
   ```

   This writes the folder `dist/` (`index.html`, `manifest.webmanifest`, `sw.js` and `icons/`) and checks it: it
   fails if `index.html` is not self-contained or is over the 4 MB compressed budget. `dist/` is what you put online.
6. Try the build on your computer:

   ```sh
   npm run preview
   ```

   and open `http://localhost:4173/`. Stop it with **Ctrl+C**.

On a computer you play with the keyboard (see [Keyboard](#keyboard-computer)) or a USB or Bluetooth controller.

---

## 3. Open your own build on the iPad (HTTPS)

Safari only allows **Add to Home Screen as an offline app, offline play and controllers** on secure pages: an
`https://` address, or `localhost` on the same device. A plain `http://192.168.x.x` address from your computer
works for a quick look with touch, but not for those features. Pick one of these three ways. In all of them the
computer and the iPad must be on the same Wi-Fi network (except the tunnel, which works from anywhere).

### A. Quick look over Wi-Fi (http, touch only)

1. On the computer run `npm run dev`.
2. On the iPad open the `Network` address it printed, for example `http://192.168.1.23:5173/`.

Touch play works. The development server never installs the offline helper, and controllers and offline
install need HTTPS (way B or C).

### B. HTTPS on your Wi-Fi with a trusted local certificate (mkcert)

[mkcert](https://github.com/FiloSottile/mkcert) makes a certificate that your own devices trust. You set it up once.

1. Install mkcert on the computer. Mac with [Homebrew](https://brew.sh/): `brew install mkcert`. Windows with
   [Chocolatey](https://chocolatey.org/): `choco install mkcert`. Linux: see the mkcert page.
2. Create and trust the local certificate authority on the computer (once):

   ```sh
   mkcert -install
   ```

3. Find the computer's Wi-Fi address. Mac: `ipconfig getifaddr en0`. Windows: run `ipconfig` and read
   **IPv4 Address**. It looks like `192.168.1.23`. Use your own number everywhere `192.168.1.23` appears below.
4. In the project folder, make a certificate for that address. The files go next to the project folder, so they are
   never uploaded with the game:

   ```sh
   mkcert -cert-file ../dotkick-cert.pem -key-file ../dotkick-key.pem localhost 127.0.0.1 192.168.1.23
   ```

5. Teach the iPad to trust your certificates (once):
   1. Run `mkcert -CAROOT`. It prints a folder; in it is `rootCA.pem`. Send **only `rootCA.pem`** to the iPad
      (AirDrop or email). Never share `rootCA-key.pem`.
   2. On the iPad, open the file and allow the profile download.
   3. Open **Settings**. Tap **Profile Downloaded** near the top (or go to **General > VPN & Device Management**)
      and install the profile.
   4. Go to **Settings > General > About > Certificate Trust Settings** and turn on full trust for the mkcert
      certificate.
6. Build the game and serve `dist/` over HTTPS (the first time, npx asks to download `http-server`; answer `y`):

   ```sh
   npm run build
   npx http-server dist -S -C ../dotkick-cert.pem -K ../dotkick-key.pem -p 8443 -c-1
   ```

7. On the iPad open `https://192.168.1.23:8443/` in Safari. The page shows a padlock and no warning. You can now Add
   to Home Screen, test offline and use controllers. Stop the server with **Ctrl+C**. After a code change, run
   `npm run build` again and reload the page (the game also offers an **Update available** message with a
   **Reload** button).

### C. HTTPS through a tunnel (no certificate needed)

A tunnel gives your computer a temporary public `https://` address. Anyone who has that address can open your build
while the tunnel runs, so keep it to yourself and stop it when you are done.

1. Install Cloudflare's free `cloudflared` tool (Mac: `brew install cloudflared`; other systems: see Cloudflare's
   "Quick Tunnels" / TryCloudflare documentation).
2. Build and serve `dist/` on the computer:

   ```sh
   npm run build
   npx http-server dist -p 8080 -c-1
   ```

3. In a second terminal:

   ```sh
   cloudflared tunnel --url http://localhost:8080
   ```

4. It prints an address ending in `trycloudflare.com`. Open it in Safari on the iPad. Stop both commands with
   **Ctrl+C** when done.

Point a tunnel at the built game (as above), not at `npm run dev`: the development server refuses requests for
unknown host names.

---

## 4. Put it online for free

Both ways below publish the `dist/` folder on a free host with HTTPS. All paths in the build are relative, so it works
at the root of a site or in a sub-folder, on any static host. Nothing else is needed: no server code, no database, no
settings. More detail, other hosts and the exact workflow file are in [docs/DEPLOY.md](docs/DEPLOY.md).

First build the game on your computer: `npm run build` (section 2). You now have a `dist` folder.

### Way 1: drag and drop to a static host

Hosts such as **Netlify Drop** and **Cloudflare Pages (direct upload)** take a folder you drag onto a web page and
give you an `https://` address. Their pages change from time to time, so follow what you see on screen; the idea
is always the same.

**Netlify Drop**

1. On the computer, open [app.netlify.com/drop](https://app.netlify.com/drop) in a browser.
2. Drag the **`dist` folder itself** (the one with `index.html` directly inside it) onto the drop area. Do not drag
   the whole project folder.
3. Wait for the upload. Netlify shows the site's address, ending in `.netlify.app`.
4. Netlify keeps a site dropped without an account only for a short time. To keep it, sign up or log in (free) when
   the page asks, and claim the site.
5. To update later: run `npm run build` again, open the site in your Netlify dashboard, go to its **Deploys** page
   and drop the new `dist` folder there. The address stays the same.

**Cloudflare Pages**

1. Create a free Cloudflare account and open the dashboard.
2. Go to **Workers & Pages**, create a new **Pages** project, and choose to **upload your files directly** (Direct
   Upload) instead of connecting to Git.
3. Give the project a name, then drag the `dist` folder (or a zip of its contents) onto the upload area and deploy.
4. The site appears at `https://<project-name>.pages.dev`.
5. To update later: build again and create a new deployment of the same project with the new `dist` folder.

### Way 2: GitHub Pages (builds itself on every change)

GitHub builds the game for you and publishes it every time the code on the main branch changes. GitHub Pages is free
for **public** repositories (private repositories need a paid GitHub plan).

1. **Put the project on GitHub.** Create a free account at [github.com](https://github.com/), then a new
   repository (choose **Public**), and upload the project (with `git push`, or **Add file > Upload files** on the
   repository page; do not upload `node_modules` or `dist`).
2. **Add the workflow file.** The build recipe lives in `.github/workflows/pages.yml`. If your repository does not
   have it yet: on the repository page press **Add file > Create new file**, type the name
   `.github/workflows/pages.yml`, paste the file from
   [docs/DEPLOY.md, "The workflow file"](docs/DEPLOY.md#the-workflow-file), and press **Commit changes**.
3. **Turn on Pages.** Open the repository's **Settings > Pages**. Under **Build and deployment**, set **Source** to
   **GitHub Actions**.
4. **Run it.** Open the **Actions** tab. A run of **Deploy to GitHub Pages** starts after each push to `main` (or
   `master`). To start one by hand, click **Deploy to GitHub Pages**, then **Run workflow**. If a run failed because
   Pages was not turned on yet, open it and press **Re-run all jobs**.
5. **Open it.** When the run shows a green tick (a few minutes), the address is shown on the run's **deploy** step
   and in **Settings > Pages**. It looks like `https://<your-user-name>.github.io/<repository-name>/`.
6. **Updates.** Every push to the main branch publishes a new version. A player who has the game open, or installed
   on the Home Screen, gets an **Update available** message with a **Reload** button.

---

## 5. Add it to the Home Screen and play offline

1. Open the game's `https://` address in **Safari** on the iPad (other browsers on iPad cannot install it the same
   way).
2. Tap anywhere to start. The first visit shows a hint about the Home Screen.
3. Tap the **Share** button in Safari's toolbar (a square with an arrow pointing up; on some iPadOS versions it is
   inside the **•••** menu), scroll down and tap **Add to Home Screen**. If the sheet shows an **Open as Web App**
   switch, leave it on. Tap **Add**.
4. Open **DotKick** from the Home Screen. It opens full screen, without Safari's toolbars.
5. **Offline:** the game saves itself on the iPad during the first visit over HTTPS. To check, switch on Airplane
   Mode and open the Home Screen app: everything except online 1v1 works.

Good to know:

- The Home Screen app keeps its own settings and progress, separate from the Safari tab.
- When a new version is published, the game shows an **Update available** message with a **Reload** button the
  next time it is opened online.
- In a Safari tab you can tap **Play full screen** on the start screen; the Home Screen app is always full screen.
- The game plays in landscape. In portrait it pauses and asks you to turn the iPad. In a small window (Split View,
  Slide Over, Stage Manager) it pauses and asks for a larger window.

---

## 6. Pair a controller

DotKick supports up to two Bluetooth controllers: PlayStation (DualSense, DualShock 4), Xbox Wireless Controllers with
Bluetooth, Nintendo Switch Pro Controllers and most iPad-compatible ("MFi") controllers. The game must be opened over
HTTPS (an online address, or section 3 B or C).

1. **Put the controller in pairing mode.**
   - PlayStation 5 DualSense: hold **Create** and the **PS** button until the light bar flashes.
   - PlayStation 4 DualShock 4: hold **Share** and the **PS** button until the light bar flashes.
   - Xbox Wireless Controller: turn it on with the **Xbox** button, then hold the small **Pair** button on the top
     edge until the Xbox button flashes quickly.
   - Switch Pro Controller: hold the small **sync** button on the top edge until the lights move.
   - Other controllers: see their manual (some need an "Apple" or "iOS" mode).
2. **Pair it with the iPad.** Open **Settings > Bluetooth**, make sure Bluetooth is on, and tap the controller's name
   under **Other Devices**. It moves to **My Devices** as **Connected**.
3. **Wake it in the game.** Open DotKick and **press any button** on the controller. Browsers show a controller to a
   page only after one of its buttons is pressed, so the game cannot see it before that.
4. **Pick a side.** Before each match the side-select screen shows every input (Touch, Controller 1, Controller 2,
   Keyboard). Move your icon left for home, right for away, or leave it in the middle to sit out. A side with no human
   is played by the CPU. Player 1 is orange, player 2 is cyan.

Notes:

- Button names on screen follow the controller: shapes for PlayStation, letters for Xbox and Switch. Change it in
  **Settings > Controls > Button glyphs** if the game guesses wrong.
- The **PS / Xbox / Home** button and the **Share / Create** button belong to iPadOS. The game uses neither.
- If a controller disconnects during a match, the match pauses and shows a reconnect card. Press any button on it
  (or another controller) to carry on, or hand that side to touch or to the CPU.
- A controller without the standard layout gets a remap screen: **Settings > Controls > Controller remap**.
- Rumble on goals, the post and hard tackles can be switched off in **Settings > Controls > Rumble**.
- To unpair, open **Settings > Bluetooth**, tap **(i)** next to the controller, then **Forget This Device**.

---

## 7. Play a friend

Choose **Play a Friend** on the main menu, then **Same iPad** or **Online**.

### On the same iPad

Two people play on one iPad with one shared camera: **controller against controller**, or **touch against
controller** (two people cannot share one touch screen).

1. Pair the controllers (section 6) and press a button on each so the game sees it.
2. **Play a Friend > Same iPad**, then pick both teams and kits.
3. On side select, move one input to the left (home) and the other to the right (away). Player 1 is orange, player 2
   is cyan. The game will not start until each side has a player.
4. Choose the match settings and play. Either player can pause; only the player who paused can resume or quit.

At full time, **Rematch** plays the same teams again and **Change teams** goes back to team select.

### Online with a room code

Both devices need the internet. The first visit must be online over HTTPS (any published address works).

1. **Host:** **Play a Friend > Online**. Type a nickname if you like, then tap **Create room**. The room screen shows a
   6-character code and a share link with **Copy link** and **Share…** buttons. Keep this screen open.
2. **Friend:** open the same game address, then **Play a Friend > Online > Join room** and type the code (on screen, with
   a controller or with a keyboard); it joins by itself after the sixth character. Opening the share link goes
   straight to joining.
3. Both pick a club (**Your club**) and tap **Ready**. The host also chooses the match settings (half length, offside,
   fouls and cards, cup rules, night match, goal replays); the friend sees them. The match starts a moment after both
   are ready.
4. During the match each player has **3 pauses** of up to **30 seconds**; only the player who paused can resume early.
   If the game waits for the other device, a small **Waiting for...** pill shows and play continues by itself.
5. If the friend leaves or the connection drops, the game waits **20 seconds** for them to come back (a friend whose
   page reloaded can tap **Rejoin match**). After that you can **Finish against CPU** or **End match**.
6. At full time, **Rematch** takes both players back to the same room to ready up again; **Quit** leaves the room.

Online play uses the free public PeerJS service to introduce the two devices; read section 10 (Privacy) first. If
something goes wrong the game shows a plain message; section 9 lists what to do.

---

## 8. Controls reference

DotKick uses the familiar layouts of modern football games: a touch scheme like popular mobile football games, and
the "Classic" button layout of console football games on controllers. The **Tutorial** (in **Practice**, or
**Settings > Controls > Tutorial**) teaches the controls for whichever device you use.

### Touch

**Layout**

- **Left half: the stick.** It appears where your thumb lands. A small push jogs, a full push runs; let go to stop.
  Double-tap and hold the stick to dribble facing forward (strafe).
- **Bottom right: four buttons.** One large button with three smaller ones in an arc above it. They change the moment
  your team wins or loses the ball. A thumb that is already down keeps its old meaning until it lifts.
- **Top right: pause.**
- **Swipes on a button:** start on the button and slide a short way (about half a centimetre) up, down, left or
  right. During your first matches, holding a button for a quarter of a second shows its swipe directions.
- **Power:** hold PASS, THROUGH or SHOOT for more power; the power bar shows by your player and on the button. A
  thumb that slides off a held button keeps holding until it lifts.

**Attack buttons (your team has the ball)**

| Button | Tap or hold | Swipe up | Swipe down | Swipe left | Swipe right | Double-tap |
|---|---|---|---|---|---|---|
| PASS | Ground pass; hold for power | Lob pass; a cross in the crossing zone | Pass and go | Driven lob; a ground cross in the crossing zone | Driven ground pass; a low cross in the crossing zone | Dinked pass |
| THROUGH | Through ball; hold for power | Lobbed through ball | Trigger a teammate's run | | | Dinked through ball |
| SHOOT | Shot, volley or header; hold for power | Chip shot | Finesse shot | Fake shot | Power shot | |
| SPRINT (large: sprint and skill) | Hold to sprint; tap for a skill move | Skill move | Knock-on | Hard stop | Skill move | |

- Skill moves: tap, swipe up and swipe right each hold one move. Defaults: tap = step-over or body feint toward the
  stick, swipe up = roulette, swipe right = heel flick. Change them in **Settings > Controls** (Skill: tap, swipe up,
  swipe right).
- When your keeper holds the ball: PASS throws, THROUGH is a driven throw, SHOOT is a drop kick, and SPRINT drops the
  ball at his feet.

**Defence buttons (the other team has the ball)**

| Button | Tap | Hold | Swipe |
|---|---|---|---|
| TACKLE (large: sprint and tackle) | Standing tackle when goal-side of the carrier; push or pull when chasing | Sprint, and press the carrier when close | Left: hard tackle |
| SLIDE | Slide tackle | | |
| SWITCH | Switch to the best-placed defender | | Any direction: switch that way |
| 2ND DEF | Call a second defender | Keep him pressing | Down: keeper rushes out |

- Move the stick near the carrier without sprinting and your player contains him automatically (jockey).
- **CLEAR** replaces SLIDE when a first-time clearance is on: your player is about to reach a loose or high ball in
  your own third.

**Pitch gestures** (on by default; they work alongside the buttons and count only when they start away from the stick
and the buttons)

| Gesture | Result |
|---|---|
| Tap a teammate, or just behind him | Ground pass to feet |
| Tap the space in front of a teammate | Through ball into that space |
| Double-tap either of those | The lobbed version |
| In the crossing zone, double-tap toward a post | Cross to the near or far post |
| Swipe toward goal | Shot; a faster swipe is harder and higher |
| Curved swipe toward goal | Finesse shot that bends with the swipe; bent against the shooter's natural curl (right-footer: to the right) it is a trivela |
| Tap on the goal | Chip shot |
| Quick back-and-forth swipe toward goal | Power shot |
| Tap the opposing ball carrier | Press him |
| Swipe in your own half without the ball | Slide tackle |
| Swipe in your own half with the ball | Clearance |
| Double-tap the pitch when defending | Second defender |
| Tap your keeper when defending | Keeper rushes out |
| Tap a teammate when defending | Switch to him |

**Set pieces on touch**

| Situation | What to do |
|---|---|
| Kick-off | PASS |
| Corners and wide free kicks | Tap a teammate or a spot in the box, or swipe from the ball. Swipe speed sets the height; a curved swipe adds curl. PASS plays it short |
| Free kicks at goal | Swipe from the ball toward the goal. Speed sets power and height; the curve sets curl. A dotted line previews the start of the flight |
| Penalties (taking) | Swipe toward the part of the goal you want. Faster is harder to save but less accurate |
| Penalties (saving) | Tap or swipe the way the keeper should dive |
| Throw-ins and goal kicks | Tap a teammate, or use the buttons |

**Touch settings** (**Settings > Controls**): **Touch controls layout** (drag to move buttons and the stick; size,
spacing and reset), control opacity, floating or fixed stick, left-handed (mirror), pitch gestures on or off,
**Gestures only** (hides PASS, THROUGH and SHOOT), fast power bar, skill slots, and auto-switch. Touch controls hide
while a controller drives your side and come back on the next touch.

### Controller

Buttons are read by **position** (the standard controller layout), so every controller plays the same way. The names
of the positions:

| Position | PlayStation | Xbox | Switch |
|---|---|---|---|
| Bottom face button | Cross | A | B |
| Right face button | Circle | B | A |
| Left face button | Square | X | Y |
| Top face button | Triangle | Y | X |
| Left bumper / right bumper | L1 / R1 | LB / RB | L / R |
| Left trigger / right trigger | L2 / R2 | LT / RT | ZL / ZR |
| Menu button | Options | Menu | + |
| Sticks, D-pad | Left stick, right stick, D-pad | same | same |

The tables use PlayStation names with Xbox names beside them; on a Switch controller use the button in the same
position. A combo such as "R1 + Cross" means hold R1, then press Cross: combos resolve when the face button is
pressed. "Cross, Cross" means press it twice quickly.

**Movement and dribbling**

| Action | PlayStation | Xbox |
|---|---|---|
| Move player | Left stick | Left stick |
| Sprint | R2 (hold) | RT (hold) |
| Shield the ball / jockey | L2 (hold) | LT (hold) |
| Strafe dribble | L1 + left stick | LB + left stick |
| Controlled sprint (tight touches, a little slower than a full sprint) | R1 (hold) | RB (hold) |
| Stop the ball | Release left stick + R2 | Release left stick + RT |
| Stop and face goal | Release left stick + L1 | Release left stick + LB |
| Knock-on | R2 + right-stick flick | RT + right-stick flick |
| Skill moves | Right stick | Right stick |

Right-stick skill moves, relative to the way your player faces: flick left or right for a **body feint**; hold left or
right for a **ball roll**; roll from forward to a side for a **step-over**; flick forward then back for a **heel
flick**; roll from back through a side to forward for a **roulette**. **Drag-back**: L1 + R1 + left stick flicked
backward (LB + RB on Xbox).

**Attacking**

| Action | PlayStation | Xbox |
|---|---|---|
| Ground pass / header | Cross | A |
| Lob pass / cross / header | Square | X |
| Through ball | Triangle | Y |
| Shoot / volley / header | Circle | B |
| Driven ground pass | R1 + Cross | RB + A |
| Lofted ground pass | Cross, Cross | A, A |
| Lobbed through ball | L1 + Triangle | LB + Y |
| Lofted through ball | Triangle, Triangle | Y, Y |
| High lob | L1 + Square | LB + X |
| Driven lob / driven cross | L1 + R1 + Square | LB + RB + X |
| Ground cross | Square, Square | X, X |
| Pass and go | L1 + Cross | LB + A |
| Trigger a run | L1 (tap) | LB (tap) |
| Call for support | R1 (tap) | RB (tap) |
| Fake shot / fake pass | Circle or Square, then Cross | B or X, then A |
| Cancel advantage | L2 + R2 | LT + RT |

**Shooting**

| Action | PlayStation | Xbox |
|---|---|---|
| Shot (hold for power) | Circle | B |
| Finesse shot | R1 + Circle | RB + B |
| Chip shot | L1 + Circle | LB + B |
| Power shot | L1 + R1 + Circle | LB + RB + B |
| Trivela (outside-of-the-foot curler) | L2 + Circle | LT + B |
| Low driven shot | Circle, then tap Circle again during power-up | B, then tap B again during power-up |

**Defending**

| Action | PlayStation | Xbox |
|---|---|---|
| Change player | L1 | LB |
| Change player (directional) | Right stick | Right stick |
| Tackle; push or pull when chasing; shoulder challenge; clearance (by context) | Circle | B |
| Hard tackle | R1 + Circle | RB + B |
| Slide tackle | Square | X |
| Quick get-up after a slide | Square | X |
| Contain | Cross (hold) | A (hold) |
| Teammate contain (second defender) | R1 (hold) | RB (hold) |
| Jockey | L2 (hold) | LT (hold) |
| Sprint jockey | L2 + R2 | LT + RT |
| Rush the keeper out | Triangle (hold) | Y (hold) |

**Goalkeeper with the ball**

| Action | PlayStation | Xbox |
|---|---|---|
| Throw or pass | Cross | A |
| Driven throw | R1 + Cross | RB + A |
| Drop kick | Circle or Square | B or X |
| Driven kick | R1 + Square | RB + X |
| Drop the ball | Triangle | Y |
| Pick up the ball | R1 | RB |

**Tactics, set pieces and menus**

| Situation | Action | Input (PlayStation / Xbox where they differ) |
|---|---|---|
| Tactics | Quick tactics | D-pad up, then up (offside trap), left (team press), right (extra striker) or down (get in the box) |
| Tactics | Tactical focus | D-pad right, then up (default), left (defending) or right (attacking) |
| Tactics | Quick substitution | D-pad down, then down |
| Free kick | Aim; add curl or dip | Left stick; right stick |
| Free kick | Shoot; finesse; chip | Circle / B; R1 + Circle / RB + B; L1 + Circle / LB + B |
| Free kick | Ground pass; lob or cross | Cross / A; Square / X |
| Free kick | Choose the taker | R2 / RT |
| Defending a free kick | Wall jump; wall charge; move wall | Triangle / Y; Cross / A; L2 or R2 / LT or RT |
| Corner | Lob cross; short pass; aim; target reticle | Square / X; Cross / A; left stick; right stick |
| Corner | Corner tactics | D-pad down, then up (far post), left (edge of box), right (crowd the keeper) or down (near post) |
| Throw-in | Move along the line; short throw; long throw | Left stick; Cross / A; hold Square / X |
| Penalty | Aim; shoot; finesse; chip | Left stick; Circle / B; R1 + Circle / RB + B; L1 + Circle / LB + B |
| Saving a penalty | Move along the line; dive | Left stick; right stick |
| Any | Pause | Options / Menu |
| Menus | Confirm; back; move; switch tab | Cross / A; Circle / B; D-pad or left stick; L1 and R1 / LB and RB |

The second D-pad press of a tactics command must follow within 1.2 seconds; the screen shows the pending command.
A button pressed up to 6 frames (a tenth of a second) before your player can act still counts.

### Keyboard (computer)

The keyboard works like a controller: each key stands for a controller button, so all the combos above work with the
matching keys. Letters are by position on a US keyboard, whatever your keyboard layout. The full reference, with every
rule, is [docs/KEYBOARD.md](docs/KEYBOARD.md).

**In a match**

| Key | Controller (PlayStation / Xbox) | Attack / defence |
|---|---|---|
| W A S D or arrow keys | Left stick | Move |
| J | Cross / A | Ground pass, header / contain (hold) / keeper throw |
| K | Circle / B | Shoot (hold for power) / tackle, clearance |
| U | Square / X | Lob, cross / slide tackle |
| I | Triangle / Y | Through ball / keeper rush (hold) |
| Q | L1 / LB | Chip and lob modifier, trigger a run (tap) / change player |
| E | R1 / RB | Finesse and driven modifier, call for support (tap) / second defender (hold) |
| C | L2 / LT | Shield / jockey |
| Shift | R2 / RT | Sprint; free kick: choose the taker |
| Space | | Skip a celebration, replay or intro shot |
| Esc or P | Options / Menu | Pause |
| 1 / 2 / 3 / 4 | D-pad up / down / left / right | Quick tactics, tactical focus, quick sub, corner tactics |
| Ctrl or Alt + arrow key | D-pad in that direction | Same as 1-4 |
| Numpad 8 / 2 (or 5) / 4 / 6, and 7 / 9 / 1 / 3 | Right stick (and diagonals) | Skill moves, directional switch, knock-on (with Shift), free-kick curl, penalty dive |
| Alt (Option) + I / K / J / L | Right stick up / down / left / right | Same, for laptops without a numpad |
| R / F / T / G / H / B | Right-stick skills | Ball roll / body feint / step-over / roulette / heel flick / drag-back |

Examples: E + J driven pass, Q + K chip shot, Q + E + K power shot, C + K trivela, E held while running controlled sprint, J then J
lofted pass, K then J fake shot.
On macOS, Ctrl + arrows may open Mission Control, and on Windows Alt + arrows may go back or forward in the browser:
use 1-4 for the D-pad there.

**In menus**

| Key | Action |
|---|---|
| Arrow keys or W A S D | Move the focus (a slider or switch changes with left and right) |
| Enter, Space or J | Confirm |
| Esc, Backspace or K | Back |
| Q or Page Up / E or Page Down | Previous / next tab |
| P | Pause / resume |
| Tab / Shift + Tab | Browser focus order |

---

## 9. Troubleshooting

**The game runs at a jerky 30 frames per second, or shows a Low Power Mode hint.**
Low Power Mode limits Safari to 30 fps. Turn it off in **Settings > Battery** (or in Control Center). Also close
other heavy apps, and try **Settings > Graphics > Performance** in the game. A cold or charging-hot iPad can also slow
down.

**There is no sound.**
Sound can only start after you touch the screen: tap once. Turn the iPad's volume up and make sure Silent Mode is off
(Control Center). Check the sliders in the game's **Settings > Audio**. After a phone call, FaceTime or Siri, tap the
screen once to bring the sound back.

**My controller is not detected.**
- Press a button on it after the game has opened: browsers reveal a controller only after a button press.
- Check **Settings > Bluetooth** on the iPad: it should say **Connected**. A controller paired with a nearby console
  or computer may connect to that instead; turn that device's Bluetooth off or pair again.
- The page must be secure: an `https://` address or the Home Screen app. A plain `http://192.168...` address
  (section 3 A) may not see controllers.
- Charge it. If buttons do the wrong thing, check **Settings > General > Game Controller** on the iPad for custom
  button mappings, and use **Settings > Controls > Controller remap** in the game for unusual controllers.

**The controller disconnected in the middle of a match.**
The match pauses with a reconnect card. Turn the controller back on and press any button, or choose to hand that side
to touch or to the CPU.

**A swipe from the screen edge left the game, or the stick or sprint felt stuck.**
Swipes from the bottom edge and the top corners belong to iPadOS; the game keeps its controls clear of them and
releases every held control when the system takes a touch. For long sessions you can lock the iPad to the game with
**Settings > Accessibility > Guided Access**.

**The screen says to turn the iPad, or to make the window larger.**
The game plays in landscape only, and pauses in a window that is too small (Split View, Slide Over, Stage Manager).
Rotate the iPad or make the window bigger, then press **Resume**.

**It does not work offline.**
Open the game once while online over HTTPS (a published site, or section 3 B or C), wait for the main menu, then go
offline. The development server (`npm run dev`) and plain `http://` addresses never install the offline copy.

**My settings are not saved.**
Private Browsing (and some blocked-storage settings) keeps settings only until the tab closes; **Settings > Data**
shows the storage status. The Home Screen app and the Safari tab keep separate settings.

**It says "Update available".**
A newer version has been published. Tap **Reload** to switch to it now, or ignore it and get it next time.

**Online 1v1 problems** (the game explains each one on screen)

| Message is about | What to do |
|---|---|
| The matchmaking server cannot be reached | Check the internet connection and try again. Online play needs the free public PeerJS service. |
| Room code not found | Check the 6-character code with your friend; the host must keep the game open on the room screen. |
| Room is full | Someone else already joined that room. The host can create a new one. |
| Version mismatch | You run different versions. Both reload the page (accept **Update available**) and try again. |
| Connection blocked by the network | Some networks (school, office, hotel, some mobile networks) block direct connections. Use the same Wi-Fi, or one player's phone hotspot. |
| Your friend left or the connection dropped | The game waits 20 seconds for a rejoin, then offers to finish against the CPU or end the match. |

**Something went wrong** (a recovery screen appears).
Choose **Resume** if offered, otherwise **Restart match** or **Main menu**. To report it, tap **Copy diagnostics** and
paste the text in your message. **Settings > Diagnostics** can also save the last match as a replay file, which
reproduces the match exactly.

**Checking performance.**
Open the game with `?bench=1` after the address (for example `https://example.com/dotkick/?bench=1`) or use
**Settings > Diagnostics > Run benchmark**. It plays a 90-second bot match and shows PASS or FAIL with a **Copy
Results** button. The on-device script is [docs/DEVICE_CHECKLIST.md](docs/DEVICE_CHECKLIST.md).

---

## 10. Privacy

- No accounts, ads, analytics or tracking. The game makes no network requests while you play, except for online 1v1.
- Settings, records and cup progress stay on your iPad (browser storage). **Settings > Data** erases them.
- **Online 1v1 is peer to peer.** The two iPads connect directly to each other (WebRTC). A free public PeerJS
  matchmaking server introduces them, and when a direct link is impossible the traffic may pass through a public relay
  server. Only a nickname and game inputs are sent. There is no chat, and nothing is stored online.
- **Peer-to-peer play shows each player's IP address to the other** (and to those matchmaking and relay servers). An
  IP address can reveal your rough location and your internet provider. **Share room codes and links only with people
  you know.**

---

## 11. For developers

| Command | What it does |
|---|---|
| `npm run dev` | Development server with live reload (`http://localhost:5173/`, also on your network) |
| `npm run build` | Production build to `dist/`, then the post-build check (self-contained, size budget, offline helper version) |
| `npm run preview` | Serve `dist/` locally (`http://localhost:4173/`) |
| `npm run typecheck` | TypeScript strict check |
| `npm run lint` | ESLint |
| `npm test` | Unit and simulation tests (Vitest) |
| `npm run verify` | typecheck + lint + tests + a short soak (the definition-of-done gate) |
| `npm run soak` | 2,000 headless bot matches checking invariants |
| `npm run fuzz` | 500 matches with random inputs |
| `npm run bench` | Build, then the headless proxy benchmark (budgets for sim time, draw calls and triangles) |
| `npm run e2e` | Playwright end-to-end tests at iPad size: Chromium, plus WebKit when a WebKit browser is installed. They serve `dist/`, so run `npm run build` first |
| `npm run glitch-audit` | Checks that every glitch-list line of the brief has a named regression test |
| `npm run gen:data` | Regenerates the invented clubs and players (`src/data/clubs.generated.ts`) |
| `npm run icons` / `npm run icons:check` | Regenerates the app icons in `public/icons/` / checks they are up to date |

- The game is TypeScript (strict) with Vite and Three.js, no game engine. The match simulation is deterministic: the
  same seed and inputs give the same match on every device, which powers replays, online lockstep and soak tests.
  Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); decisions are in [docs/DECISIONS.md](docs/DECISIONS.md),
  progress in [docs/STATUS.md](docs/STATUS.md), performance in [docs/PERF_REPORT.md](docs/PERF_REPORT.md).
- Debug overlay (frame-time graph, sim and render times, draw calls, state hash, input viewer): press the backquote key
  (`` ` ``), or tap the top-left corner five times within two seconds.
- Benchmark: `?bench=1` (options: `benchSeconds`, `benchSeed`, `benchWarmup`).
- Online play uses the free public PeerJS broker by default; a self-hosted PeerServer is one config object
  (`src/net/config.ts`, see [docs/DEPLOY.md](docs/DEPLOY.md#self-hosted-peerjs-server-optional)).
- Hosting details and the GitHub Pages workflow: [docs/DEPLOY.md](docs/DEPLOY.md). On-device test script:
  [docs/DEVICE_CHECKLIST.md](docs/DEVICE_CHECKLIST.md).

---

## 12. Credits and licences

DotKick is an original game. Its pictures and sounds are generated in code. The only outside parts are open-source
libraries (Three.js and PeerJS, MIT licence) and two open fonts (Space Grotesk and JetBrains Mono, SIL Open Font
Licence 1.1). Names, addresses and licences of every source are in [docs/ASSETS.md](docs/ASSETS.md).

DotKick is not affiliated with, endorsed by or connected to any football game, league, club or player. The control
layouts follow common conventions of football games so the game feels familiar; no names, logos, art, audio or user
interface of any commercial game are used.
