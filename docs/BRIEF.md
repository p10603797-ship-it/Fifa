
# DotKick — master build prompt

2026-10-12 · @philip
This is the complete build prompt for DotKick, an original 11-a-side football game that runs as a web app on iPad with touch and controller play, bots, and 1v1 against a friend. Everything below is written to the Claude session that builds it; paste the whole document in as the first message.

## 1. Mission and priorities

You are the lead engineer and orchestrator for DotKick. Build a complete, polished 11-a-side football game that plays in Safari on an iPad, in the style of modern console and mobile football games. Plan it, build it with a large team of sub-agents, test it hard, and hand back something I can open on my iPad and play.
When you finish I can:
- Open one HTTPS link, or the installed Home Screen app, and be in a match within a minute.
- Play a full 11v11 match against bots using on-screen controls laid out like EA SPORTS FC Mobile.
- Connect a Bluetooth controller and play with the EA SPORTS FC 26 Classic button layout.
- Play 1v1 against a friend, on the same iPad or online with a room code.
- Watch the match from a broadcast-style side camera, like the default camera in console football games.
- Play at 60 fps, never below 50 fps on an iPad (A16), with no stuck, broken or nonsensical game states.

Priorities, highest first. When two goals conflict, the higher one wins.
1. Stability: no crashes, soft-locks, stuck inputs or broken match states.
2. Frame rate: 60 fps target, 50 fps floor on iPad (A16).
3. Control feel: responsive, predictable input on touch and controller.
4. Gameplay and AI depth.
5. Visual and audio polish.
6. Extra modes.

Cut scope from the bottom of that list before shipping anything flaky from the top.
This brief makes the decisions so you do not have to stop and ask. Where it is silent, pick the option that best serves the priorities, record it in `docs/DECISIONS.md`, and keep going. Section 19 lists the few things worth stopping for.

## 2. Ground rules

- Working title: DotKick. Keep the name in one constant so it can be changed in one place.
- This is an original game. Do not use the names, logos, fonts, UI layouts, audio or art of FIFA, EA SPORTS FC or any other commercial game.
- No real clubs, leagues, competitions, players, kits, crests, stadiums, sponsors or broadcasters. Everything is invented.
- Only the control schemes follow existing games (sections 9 and 10), so the game feels familiar in the hands. On-screen button labels are plain words.
- Everything visible or audible is generated in code, or comes from a CC0 or OFL source recorded in `ASSETS.md` with its name, URL and licence.
- No accounts, ads, analytics or tracking. No API keys anywhere.
- No network requests at runtime, except the peer-to-peer connection for online 1v1.


## 3. Target device and hard limits

| Item | Requirement |
|---|---|
| Primary device | iPad (A16): 11-inch, 2360 × 1640 px, 60 Hz, Safari (WebKit) |
| Also runs on | Any iPad on a current iPadOS; desktop Chrome, Safari and Firefox for development |
| Orientation | Landscape, either way up. Portrait pauses and shows a rotate screen |
| Frame rate | 60 fps target; never below 50 fps during play on the primary device |
| Input | Multi-touch, up to two Bluetooth controllers, keyboard on desktop |
| Install | Works in a Safari tab and as a Home Screen web app (standalone, full screen) |
| Offline | Fully playable offline after the first load, except online 1v1 |
| Download | 4 MB or less compressed; main menu within 3 s on Wi-Fi |
| Memory | 300 MB or less in a match; 64 MB or less of textures |
| Backend | None. Static files over HTTPS |

iPadOS and Safari behaviours to handle. Each one is a common source of glitches.
- **Secure context.** Install, offline and controllers need HTTPS or localhost. The README explains how to reach a dev build from the iPad over HTTPS.
- **Viewport.** Use `viewport-fit=cover`, no user scaling, and respect `env(safe-area-inset-*)`. Keep controls 24 pt clear of the bottom edge and the top corners, where system gestures live.
- **Browser gestures off** on the game surface: `touch-action: none`, and no text selection, callout, tap highlight, double-tap zoom, pinch zoom, rubber-band scroll or long-press menu.
- **Touch lifecycle.** Use Pointer Events with pointer capture; each control tracks its own pointer id. `pointercancel`, lost capture, window blur and `visibilitychange` release every held input. iPadOS multitasking gestures cancel touches mid-hold; a stuck sprint or stick afterwards is a bug.
- **Windowing.** The game can run in a resized window. Layout and camera adapt to any aspect ratio from 4:3 to 21:9. Below a minimum playable size, pause and say so.
- **Audio.** It starts only after a user gesture. Resume the audio context after interruptions and when the page becomes visible.
- **Backgrounding.** On hidden: pause the match, stop the loop, mute. On return: show the pause menu. Never fast-forward missed time.
- **Low Power Mode** can cap Safari at 30 fps. Detect a steady 30 fps with idle frame time and show a one-time hint to turn it off.
- **WebGL context loss.** Pause, restore, rebuild GPU resources, then resume from the pause menu.
- **Controllers.** Use the Gamepad API with standard mapping. A pad appears only after one of its buttons is pressed. The Home and Share buttons belong to iPadOS; bind nothing to them.
- **Storage.** Keep settings and progress in `localStorage` or IndexedDB with a schema version and migrations. Fall back to memory if storage is blocked.
- **Full screen.** The Home Screen app is the full-screen route. In a Safari tab, offer a full-screen button where the API exists.


## 4. Tech stack and architecture

Stack:
- TypeScript in strict mode, Vite, and Three.js on WebGL2. No game engine and no physics library: the match simulation is custom.
- Menus and HUD in DOM and CSS over the canvas. No UI framework.
- Sound through the Web Audio API, synthesised in code.
- Online play through PeerJS (WebRTC data channels).
- Tests with Vitest (unit and simulation) and Playwright (WebKit and Chromium, with iPad touch emulation).
- Runtime dependencies: Three.js, PeerJS and the two fonts. Pin every version.
- Build output: one self-contained `index.html` with all JavaScript, CSS and fonts inlined. Beside it sit `manifest.webmanifest`, `sw.js` and icons for install and offline. The HTML must still run if those extras are missing.

Source layout:
```
src/
  contracts/  shared types, constants, events, tuning (lead-owned, frozen after Wave 0)
  sim/        deterministic match simulation
  ai/         team AI and CPU controllers (run inside the sim tick)
  input/      touch, gamepad, keyboard -> InputFrame
  render/     Three.js scene, animation, cameras, effects
  ui/         DOM menus and HUD
  audio/      Web Audio engine and synthesised sounds
  net/        lockstep, PeerJS transport, lobby
  modes/      kick-off, cup, shoot-out, practice
  data/       teams, players, formations
  platform/   PWA, storage, iPadOS hardening, diagnostics
  app/        boot, screen router, game loop
tests/        unit, scenario, soak, fuzz, e2e, perf
tools/        headless runner, benchmark, replay inspector
docs/         architecture, contracts, ownership, status, reports
```
Architecture rules. These make the game testable and glitch-resistant, so treat them as hard constraints.
1. **Deterministic fixed-step simulation.** `sim` advances in fixed 1/60 s ticks: `step(state, inputs)` returns events. The same seed and input stream give a bit-identical state hash on every run and in every browser. That buys reproducible bug reports, goal replays, online lockstep and trustworthy soak tests.
    - Inside `sim` and `ai`: no `Math.random` (use the seeded generator stored in state), no clocks, no DOM, no Three.js, and no reliance on object-key, Map or Set ordering accidents.
    - Do not call `Math.sin`, `cos`, `tan`, `atan2`, `pow`, `exp` or `log` there; engines can differ in the last bit. Use the project's own deterministic math module. Add, subtract, multiply, divide, `Math.sqrt`, `abs`, `min`, `max`, `floor`, `ceil`, `round` and `trunc` are safe.
    - State is plain data: typed arrays and flat objects that clone, serialise and hash quickly.

2. **One input format for every device.** Touch, controller, keyboard, network peer and CPU all produce the same `InputFrame` per tick for the side they control. It carries a movement vector, an aim vector, a bitfield of semantic buttons (pass, lob, through, shoot, sprint, shield or jockey, finesse modifier, chip modifier, switch, tackle, slide, second defender, keeper rush, tactics) and an optional gesture target (a tapped player or pitch point). Holds, double-taps and power bars are resolved inside `sim` from button edges, so they replay exactly. `sim` never knows which device produced an input.
3. **Sim owns timing, render follows.** Every action (pass, shot, tackle, dive) is a sim state with fixed tick counts for wind-up, contact and recovery. Animation is derived from sim state and never feeds back into it.
4. **Events out, nothing back in.** Each tick emits events: kick, bounce, post, net, whistle, foul, card, offside, save, goal, substitution, state change. Audio, HUD, effects, camera, stats and rumble consume events and never change sim state.
5. **Loop.** `requestAnimationFrame` adds real elapsed time, clamped to 100 ms, to an accumulator. Run zero to three ticks, then render by interpolating between the last two states. The game runs at the same speed on 60 Hz and 120 Hz screens.
6. **Tuning lives in data.** Every gameplay constant sits in `contracts/tuning.ts` with its unit and a comment.
7. **Debug tools ship in the build** behind a hidden toggle: frame-time graph, sim and render milliseconds, draw calls, input viewer (touch points, pad buttons and axes), state hash, and replay save and load (seed plus inputs).

Units and pitch: metres and seconds. The origin is the centre spot; x runs along the length, z across the width with positive z toward the main camera, and y is up. Pitch 105 × 68. Goal 7.32 wide × 2.44 high. Penalty area 40.32 × 16.5. Goal area 18.32 × 5.5. Penalty spot at 11. Centre circle and penalty arc radius 9.15. Ball radius 0.11.

## 5. Match rules and flow

- 11 v 11, two halves. Half length is selectable from 2 to 10 real minutes, default 4. The match clock is scaled to 45:00 per half and shows added time.
- Home attacks left to right in the first half. Sides swap at half-time.
- Restarts: kick-off, throw-in, goal kick, corner, free kick, penalty. Each restart is a state with a taker, a position for every player, a minimum distance for opponents (9.15 m; 2 m at throw-ins) and a timeout. If a human does not act within 12 s, the game takes a sensible default.
- Out of play and goals need the whole ball over the whole line. Test them as a swept segment between ticks so a fast ball cannot skip the line.
- Offside is on by default and can be switched off. Judge it at the moment a teammate plays the ball, against the second-last defender, the ball and the halfway line. Give the attacker the benefit of a small margin. No offside from goal kicks, throw-ins or corners. Flag it only when the offside player becomes involved. Restart with a free kick where he was.
- Fouls can be switched off for an arcade mode. Classify each challenge from who touched the ball first, contact direction, closing speed and whether it was a slide. Outcomes: clean win, foul, foul with yellow, foul with red, and a penalty inside the area.
- Advantage: play on for up to 3 s when the fouled team keeps a good position, then either wave it away or bring play back. A second yellow is a red.
- Sending off: the team plays short and the AI reshapes. If the keeper is sent off, the bench keeper replaces an outfield player; with no substitutions left, an outfield player goes in goal. A team reduced below 7 players forfeits 3–0.
- Substitutions: up to 5, at any stoppage, from the pause menu or the quick-sub prompt. A substituted player cannot return.
- Goalkeepers handle only inside their own area, cannot pick up a deliberate pass from a teammate's foot, and release the ball within 6 s.
- Accepted simplifications: no handball offences, no injuries, no drop balls, no video review, no visible referee. All free kicks are direct.
- Friendlies can end level. Cup matches go to extra time (two periods, each a third of the normal half) and then a shoot-out: five each, then sudden death, with every player taking one before anyone repeats.
- A half ends only when the ball is out of play or in a neutral area, not during a shot, a cross in flight or an attack in the final 25 m. Cap the extension at 20 real seconds.
- After a goal: celebration, replay, kick-off. Both are skippable and together last 12 s at most.

**State machine.** Write one explicit, table-driven machine with every legal transition listed. An illegal transition fails an assertion in tests.
```
PRE_MATCH -> KICK_OFF -> IN_PLAY
IN_PLAY  <-> THROW_IN | GOAL_KICK | CORNER | FREE_KICK | PENALTY
IN_PLAY   -> GOAL -> CELEBRATION -> REPLAY -> KICK_OFF
IN_PLAY   -> HALF_TIME -> KICK_OFF
IN_PLAY   -> FULL_TIME -> POST_MATCH
FULL_TIME -> EXTRA_TIME -> SHOOT_OUT -> POST_MATCH   (cup matches level at full time)
PAUSED overlays any state
```
**Watchdog.** If a stopped state outlasts its maximum time, or the ball lies unreachable or untouched for 8 s in play, force the nearest legal restart and log it. In soak tests a watchdog trigger is a failure. In the shipped game it is a safety net.

## 6. Gameplay systems


### Ball

- Free-ball physics: gravity, quadratic air drag, Magnus force from spin (curl, dip, backspin float), bounce with restitution and spin friction, and rolling resistance.
- Sub-step or sweep collisions so nothing tunnels at 36 m/s.
- Posts and crossbar are rigid cylinders. The net is a soft volume that absorbs the ball and holds it in the goal. From outside, the side netting and roof deflect the ball.
- Reference feel to tune from: ground pass 9–22 m/s; a 15 m/s pass rolls about 30 m; hard shot 25–36 m/s; goal kick carries 45–60 m; bounce height roughly halves each bounce.


### Players

- 360-degree analogue movement with acceleration, deceleration and a turn rate that tightens at low speed. Top speed is 7.0–9.6 m/s from the pace attributes; a jog is about 60% of that.
- Sprinting makes touches heavier and turns wider.
- Player bodies collide as soft circles weighted by strength. Shielding puts the body between ball and opponent.
- Stamina drains with sprinting and recovers slowly. Low stamina cuts speed, acceleration and accuracy, and shows on the HUD and team sheet.


### Possession and dribbling

- The ball stays its own physics object. A dribbler guides it with touches ahead of his feet, closer at a jog and further at a sprint, so it can be poked away between touches.
- First touch depends on ball speed and height, the control attribute, pressure, and whether sprint is held.
- Skill moves, eight to start: ball roll, step-over, body feint, drag-back, fake shot, roulette, heel flick, knock-on. Each has a fixed duration, an exit direction and a window where the ball can be won. A skill-star rating gates the harder ones.


### Passing

- Hold time fills a power bar. The target blends stick direction, the distance that power implies, and how open each receiver is. Assistance is a setting: Assisted (default), Semi, Manual.
- Types: ground, driven, dinked, lob, high lob, cross, ground cross, through ball, lobbed through ball. A through ball leads the runner into space, weighted so he meets it in stride.
- In the crossing zone, a lob becomes a cross aimed at the near post, far post or penalty spot from power and stick.
- The intended receiver moves to collect on his own until the user steers him.
- Error grows with weak attributes, a body facing away from the target, pressure, full sprint, the weaker foot and extreme power.


### Shooting

- Hold time sets power; the stick aims relative to the goal. Assisted aim biases toward the inside of the posts and away from the keeper.
- Types: normal, finesse (slower, curled, more accurate), chip, power shot (longer wind-up, fastest, least assistance), low driven, header, volley, first-time shot.
- Error comes from finishing and long-shot attributes, power above 80%, balance (the angle between run and shot), pressure, the weaker foot and ball height at contact.
- A fake shot cancels the wind-up into a touch.


### Defending

- Jockey: face the ball and strafe, slower but agile. Contain: hold to shadow the carrier at a distance. Second defender: call a teammate to close down.
- Standing tackle: a timed lunge with reach and recovery ticks. Success depends on timing, angle and attributes. A mistimed tackle misses, stumbles or fouls.
- Slide tackle: long reach, long recovery, high foul risk from behind.
- Also: hard tackle, shoulder challenge when running alongside, push or pull when chasing, contextual clearance, and interceptions when a pass crosses a defender's reach.
- Switching: nearest effective defender by default, with a short lock-out so it never flip-flops. Manual directional switch is always available. Auto-switch setting: Off, Air balls and loose balls, Auto. The next switch target shows a faint marker.


### Goalkeepers

- Positioning: on the arc between ball and goal centre, with depth adjusted for distance and angle. He comes out for through balls and one-on-ones, and claims or punches crosses in the goal area.
- Saves: reaction delay, dive reach and dive speed come from attributes. Results are catch, parry (away from danger when good), tip over, or beaten. A save is decided by whether he physically reaches the ball, never by a dice roll that ignores where the shot went.
- Distribution: throw, roll, drop kick, driven kick, and a quick release when a counter-attack is on.
- User control: rush out on hold, and full control of throws and kicks when he has the ball.
- Target with equal teams: 65–78% of shots on target saved.


## 7. AI: teammates and bots


### Team shape

This drives every player a human is not controlling, on both teams.
- Formations: 4-4-2, 4-3-3, 4-2-3-1, 3-5-2, 5-3-2 and 4-1-2-1-2. Each role has a home position that shifts with the ball, the team phase (build-up, attack, defend, transition) and the tactical focus.
- In possession: offer passing triangles, stretch the width, run in behind while staying onside, overlap from full-back when there is cover, and arrive late in the box from midfield. Trigger-run and call-for-support inputs override.
- Out of possession: stay compact, hold and step the back line together, press with the nearest man, cover with the next, mark zones and passing lanes, track runners, and make recovery runs after losing the ball.
- Loose balls: exactly one player per team is assigned to chase, chosen by arrival time and re-evaluated with hysteresis. Never two teammates colliding over it, and never nobody.
- Steering uses arrival behaviour, slowing into the target, so players stop on a spot instead of orbiting or jittering around it.
- Set pieces: scripted attacking and defending positions for corners, free kicks (a wall of 2–5 by distance and angle), throw-ins, goal kicks and kick-offs.


### CPU opponent

- The CPU plays through the same `InputFrame` as a human and obeys the same physics, stamina and error models. It gets no hidden stat boosts and never reads the human's inputs.
- On the ball it scores its options every few ticks: each pass candidate (completion chance, progress, danger created), through ball, cross, dribble into space, skill move, shield, clear, and shoot (an expected-goal estimate from distance, angle, pressure and keeper position).
- Off the ball it picks which defender to control, jockeys, times tackles after a reaction delay, calls the second defender, and occasionally fouls.
- Team styles (possession, counter-attack, direct, high press, wing play) weight those choices so clubs feel different.
- Six levels: Beginner, Amateur, Semi-Pro, Professional, World Class, Legend. They differ in reaction time, decision noise, look-ahead, execution error, pressing and tackle timing. They never differ in physics.


### Targets, proven by simulation

| Measure | Target |
|---|---|
| Difficulty ladder | Each level beats the one below in 65% or more of bot-v-bot matches |
| Goals per match | 2.0–3.6 on average |
| Shots per match | 14–26 |
| Possession | 40–60% for each side |
| Pass completion | 70–88% |
| Fouls per match | 6–16 |
| Offsides per match | 0–6 |
| Blow-outs | Fewer than 5% of matches decided by five or more goals |

The match bands are for equal teams at Professional with 4-minute halves, over 500 simulated matches.

## 8. Camera and presentation


### Main camera

This view is what makes it read as a football game, so get it right before polishing anything else.
- Default: a broadcast side camera on the near-touchline side, raised and looking down across the pitch. It is the same viewpoint as the default broadcast camera in console football games.
- Starting values, exposed as tuning data: height 24 m, 40 m behind the near touchline, vertical field of view 22 degrees.
- Readability check: a player at the centre spot is about 6% of the screen height, and roughly 45 m of the pitch length is visible on an iPad.
- Follow: the camera slides along the touchline at about 70% of the ball's x, clamped to ±32 m, and turns to look at the ball. At midfield the view is square-on; near either penalty area it angles toward the goal.
- Framing: the look-at point leads the ball by 3–6 m in the direction of play. The ball never sits in the bottom 15% of the screen or under the touch controls.
- Motion: critically damped smoothing of about 0.4 s, driven by interpolated render positions, never raw tick positions. Widen the field of view by up to 4 degrees for high or fast balls. No shake and no bob.
- Settings: camera type (Broadcast, Wide, Close, End to End), plus Height and Zoom sliders from 0 to 20.
- On screens wider than an iPad, show more pitch. In narrower windows, keep the vertical framing and lose width.


### Other cameras

- Set pieces: behind the taker for free kicks near goal, penalties and goal kicks; a raised corner view for corners; the main camera for throw-ins.
- Cut between cameras, or blend in under 0.3 s. Never fly across the pitch.
- Goal replays: two angles from a ring buffer of the last 8 s of render state. Skippable.
- Kick-off and full time get short, skippable establishing shots.
- Same-iPad 1v1 uses one shared main camera, as on a console.


### Look

- Stylised low-poly, clean and readable at iPad viewing distance. Readability beats realism: bold kit colours, clear numbers, strong contrast with the grass.
- Players are built in code from simple parts (head, torso, upper and lower arms and legs, boots) and animated procedurally. No external model or animation files are needed.
- Animation set: idle, jog, sprint, turn lean, pass, shot, power shot, finesse, header, volley, first touch, shield, standing tackle, slide and get-up, stumble, fall, throw-in, keeper ready, keeper dives (low, mid, high, each side), catch, parry, throw, kick, three celebrations, dejection.
- Run cycles advance with distance travelled so feet do not slide. Poses blend. The kicking foot meets the ball on the contact tick.
- Kits: home, away and keeper kits with a colour and a pattern (plain, stripes, hoops, halves, sash). An automatic clash check picks kits by colour distance, including against the grass and the other keeper.
- Pitch with mowing stripes and lines; goals with nets that ripple; one stadium with stands, a simple instanced crowd that reacts to events, original advertising boards, and day and floodlit-night lighting.
- On-pitch aids: a marker above each controlled player (one colour per human), a ring under the intended receiver, a faint marker on the next switch target, a landing marker for high balls, and edge-of-screen arrows for the ball when it is off screen.
- Shadows are blobs or cheap projections. Section 13 lists what is off-limits at the default quality tier.


### Sound

- All sound is synthesised with Web Audio or is CC0.
- A crowd bed whose intensity follows the match: build-up in the final third, shots, near misses, goals, lulls.
- Kicks scaled by power, post and bar, net, tackles, whistles (short for fouls, long for half time and full time), and menu sounds.
- Volume sliders for master, crowd, effects and menus. No commentary.


## 9. Touch controls

Touch follows the EA SPORTS FC Mobile scheme (the game formerly called FIFA Mobile): a floating virtual stick on the left, an arc of four action buttons on the right that changes between attack and defence, and optional tap and swipe gestures on the pitch.

### Layout

- Left half: a floating virtual stick that appears where the thumb lands. Stick deflection is analogue: partial tilt jogs, full tilt runs. Releasing it stops the player.
- Bottom right: one large button with three smaller buttons fanned in an arc above and to its left. Large button 96 pt, small buttons 76 pt, at least 12 pt apart, all inside the safe area.
- Top right: pause. The top centre is HUD only.
- The right-hand cluster swaps the moment possession changes. A thumb already down keeps its old meaning until it lifts.


### Attack buttons

| Button | Tap or hold | Swipe up | Swipe down | Swipe left | Swipe right | Double-tap |
|---|---|---|---|---|---|---|
| PASS | Ground pass; hold for power | Lob pass; a cross in the crossing zone | Pass and go | Driven lob; a ground cross in the crossing zone | Driven ground pass; a low cross in the crossing zone | Dinked pass |
| THROUGH | Through ball; hold for power | Lobbed through ball | Trigger a teammate's run |  |  | Dinked through ball |
| SHOOT | Shot, volley or header; hold for power | Chip shot | Finesse shot | Fake shot | Power shot |  |
| SPRINT & SKILL (large) | Hold to sprint; tap for a skill move | Skill move | Knock-on | Hard stop | Skill move |  |

- Skill slots: tap, swipe up and swipe right each hold one of the eight moves. Defaults: tap is a step-over or body feint toward the stick, swipe up is a roulette, swipe right is a heel flick. Slots are editable in settings.
- Double-tap and hold the stick for a face-up (strafe) dribble.
- With the keeper holding the ball: PASS throws, THROUGH is a driven throw, SHOOT is a drop kick, and SPRINT & SKILL drops the ball at his feet.


### Defence buttons

| Button | Tap | Hold | Swipe |
|---|---|---|---|
| SPRINT & TACKLE (large) | Standing tackle when goal-side of the carrier; push or pull when chasing | Sprint, and press the carrier when close | Left: hard tackle |
| SLIDE | Slide tackle |  |  |
| SWITCH | Switch to the best-placed defender |  | Any direction: switch that way |
| 2ND DEF | Call a second defender | Keep him pressing | Down: keeper rushes out |

- Moving the stick near the carrier without sprinting contains him automatically (jockey).
- CLEAR replaces SLIDE whenever a first-time clearance is on: your player is about to reach a loose or high ball in your own third.


### Pitch gestures

Gestures are on by default and work alongside the buttons. Each can be turned off, and a Gestures Only option hides PASS, THROUGH and SHOOT. A gesture counts only when it starts outside the stick zone and the button cluster.
| Gesture | Result |
|---|---|
| Tap a teammate, or just behind him | Ground pass to feet |
| Tap the space in front of a teammate | Through ball into that space |
| Double-tap either of those | The lobbed version |
| In the crossing zone, double-tap toward a post | Cross to the near or far post |
| Swipe toward goal | Shot; a faster swipe is harder and higher |
| Curved swipe toward goal | Finesse shot that bends with the swipe |
| Tap on the goal | Chip shot |
| Quick back-and-forth swipe toward goal | Power shot |
| Tap the opposing ball carrier | Press him |
| Swipe in your own half without the ball | Slide tackle |
| Swipe in your own half with the ball | Clearance |
| Double-tap the pitch when defending | Second defender |
| Tap your keeper when defending | Keeper rushes out |
| Tap a teammate when defending | Switch to him |


### Set pieces on touch

- Kick-off: PASS.
- Corners and wide free kicks: tap a teammate or a spot in the box, or swipe from the ball. Swipe speed sets height and a curved swipe adds curl. PASS plays it short.
- Free kicks at goal: swipe from the ball toward the goal. Speed sets power and height; curve sets curl. Show a dotted preview of the first part of the flight.
- Penalties: swipe toward the part of the goal you want. Faster is harder to save and less accurate. To save one, tap or swipe the way the keeper should dive.
- Throw-ins and goal kicks: tap a teammate, or use the buttons.


### Touch quality bar

- Every control responds on touch-down within one frame, with a visible pressed state. The power bar shows by the player and on the button.
- Five simultaneous touches work. Stick, buttons and gestures never steal each other's touches.
- A swipe that starts on a button is a button swipe, recognised at 24 pt of travel. Show direction hints on a 250 ms hold during the first few matches.
- A thumb that slides off a held button keeps the hold until it lifts.
- Controls editor in settings: drag to reposition, size, spacing, opacity, mirror for left-handers, fixed or floating stick, gestures on or off, fast power bar, auto-switch level, and reset.
- Touch controls hide when a controller is driving that side and return on the next screen touch.


## 10. Controller controls

Controllers use the EA SPORTS FC 26 Classic layout. Bind by position using the Standard Gamepad mapping, and label by controller family: PlayStation shapes, Xbox letters or Switch letters. Detect the family from `gamepad.id`, with a manual override in settings.
Standard mapping indices: 0 Cross/A, 1 Circle/B, 2 Square/X, 3 Triangle/Y, 4 L1/LB, 5 R1/RB, 6 L2/LT, 7 R2/RT, 8 Create/View, 9 Options/Menu, 10 L3, 11 R3, 12–15 D-pad up, down, left, right.

### Movement and dribbling

| Action | PlayStation | Xbox |
|---|---|---|
| Move player | Left stick | Left stick |
| Sprint | R2 (hold) | RT (hold) |
| Shield the ball / jockey | L2 (hold) | LT (hold) |
| Strafe dribble | L1 + left stick | LB + left stick |
| Controlled sprint | R1 (hold) | RB (hold) |
| Stop the ball | Release left stick + R2 | Release left stick + RT |
| Stop and face goal | Release left stick + L1 | Release left stick + LB |
| Knock-on | R2 + right-stick flick | RT + right-stick flick |
| Skill moves | Right stick | Right stick |

Right-stick skill moves, relative to the way the player faces: flick left or right for a body feint; hold left or right for a ball roll; roll from forward to a side for a step-over; flick forward then back for a heel flick; roll from back through a side to forward for a roulette. Drag-back is L1 + R1 + left stick flicked backward (LB + RB on Xbox).

### Attacking

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


### Shooting

| Action | PlayStation | Xbox |
|---|---|---|
| Shot (hold for power) | Circle | B |
| Finesse shot | R1 + Circle | RB + B |
| Chip shot | L1 + Circle | LB + B |
| Power shot | L1 + R1 + Circle | LB + RB + B |
| Low driven shot | Circle, then tap Circle again during power-up | B, then tap B again during power-up |


### Defending

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


### Goalkeeper with the ball

| Action | PlayStation | Xbox |
|---|---|---|
| Throw or pass | Cross | A |
| Driven throw | R1 + Cross | RB + A |
| Drop kick | Circle or Square | B or X |
| Driven kick | R1 + Square | RB + X |
| Drop the ball | Triangle | Y |
| Pick up the ball | R1 | RB |


### Tactics, set pieces and menus

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

FC 26 inputs not listed here (player lock, precision passes, flair moves, professional foul, be-a-pro controls) are out of scope.

### Controller quality bar

- Poll every frame and detect edges. The stick dead zone is radial: 0.15 inner, 0.95 outer, rescaled. Triggers are analogue; sprint engages past 0.3.
- A modifier combo resolves when the face button is pressed, never when the modifier is.
- Input buffering: a press up to 6 ticks before the player can act still fires.
- Two pads at once, each bound to a side at side select. Bind by pad identity, since indices change on reconnect.
- Disconnect mid-match: auto-pause with a reconnect card. Any pad button resumes. Offer to hand that side to touch or the CPU.
- Rumble on goal, post and hard tackle where `vibrationActuator` exists. It has a setting.
- A pad without standard mapping gets a remap screen: press the button for each action.
- Keyboard scheme for desktop development, documented in the README.


## 11. Modes and playing a friend


### Modes

| Mode | What it is |
|---|---|
| Kick-Off | You against the CPU. Pick teams, kits, difficulty, half length, friendly or cup rules, day or night, and rule toggles |
| Play a Friend | 1v1 on the same iPad, or online with a room code |
| Cup | An 8- or 16-team knockout against bots, for one or two humans. Other ties use a quick ratings-based result. Progress saves |
| Shoot-out | Straight to penalties |
| Practice | Free play against a keeper with no clock, set-piece practice, and a guided tutorial for whichever input device is in use |


### Side select

Before every match, each connected input (Touch, Controller 1, Controller 2, Keyboard) shows as an icon that slides left for home, right for away, or stays in the centre to sit out. A side with no humans is played by the CPU. Player 1's marker is ember orange and player 2's is cyan.

### 1v1 on the same iPad

- Supported pairings: controller against controller, and touch against controller.
- Two people cannot share one touch screen, so do not build split-touch controls.
- One shared camera and one pause menu. Either player can pause; only the player who paused can resume or quit.


### 1v1 online

Build this last. Nothing else may depend on it, and local play must work with the network code removed.
- Flow: the host taps Create Room and gets a 6-character code and a share link. The friend enters the code or opens the link. Both pick teams and ready up. The host owns the match settings.
- Transport: PeerJS, peer to peer over WebRTC data channels. Default to the free public PeerJS broker and its default ICE servers. Keep broker and ICE settings in one config object so a self-hosted PeerServer can replace them. No keys.
- Netcode: deterministic lockstep with input delay. Each side sends its `InputFrame` for a future tick, and the sim advances only when both inputs for a tick have arrived.
- Delay starts at 3 ticks and adapts to measured round-trip time, between 2 and 8 ticks.
- Inputs travel on an unordered channel with the last 10 frames repeated in every packet, so a lost packet needs no resend. Lobby, pause and resync messages use a second, reliable channel.
- Late input: hold the sim and show a small waiting indicator. Never guess the other player's input.
- Desync guard: both sides exchange a state hash every 30 ticks. On a mismatch the host sends a full state snapshot, the guest hard-syncs, and both log the seed, tick and inputs.
- Pausing: 3 pauses each, capped at 30 s. On a disconnect, wait 20 s for a rejoin, then offer the remaining player Finish against CPU or End Match.
- Every failure has a plain-language screen: broker unreachable, code not found, room full, version mismatch, and connection blocked by the network (suggest the same Wi-Fi or a phone hotspot).
- Privacy: no chat, no accounts, nothing stored remotely. Only a nickname and game inputs are sent. The README notes that peer-to-peer play shows each player's IP address to the other, so codes should go only to people you know.


## 12. Menus, HUD and the Dot design system


### Visual identity

- Background: deep ink `#07070D`. Accent: ember orange `#FF6B35`.
- UI type: Space Grotesk. Clock, scores, stats and any numbers: JetBrains Mono with tabular figures. Both fonts are open-licence; subset them to Latin and inline them.
- Signature element: an animated dot-field canvas behind the menus. It stops completely during matches so it never costs a frame.
- Dark surfaces, thin hairlines, generous spacing. Use ember sparingly: focus, selection and primary actions.
- Derive the rest of the palette (surfaces, borders, text tiers, success, warning, error, the cyan for player 2) from those two colours, and keep every token as a CSS variable in one file.
- Scoreboard and menus are original layouts. Do not imitate any commercial game's UI.


### Screens

Splash (tap to start, which also unlocks audio and shows an Add to Home Screen hint) → Main menu → Mode setup → Team and kit select → Side select → Match settings → Loading with control tips → Match → Half-time → Full time (stats, player of the match, Rematch, Change Teams, Quit).
- Pause menu: resume, team management (formation, substitutions by drag or select-and-swap, stamina shown), tactics, camera, controls, sound, restart, quit.
- Settings: Controls, Camera, Match defaults, Audio, Graphics (Auto, Performance, Balanced, Quality; FPS counter; resolution scale), Accessibility (high-contrast kits, larger HUD, reduced camera motion, colour-blind-safe markers), Data reset, and Diagnostics (benchmark, input tester, replay save and load, version).


### In-match HUD

- Scoreboard top left: 3-letter team codes, score, clock, added time.
- Radar bottom centre, with a toggle. Controlled-player name and stamina sit beside it: player 1 on the left, player 2 on the right.
- Power bar by the player, mirrored on the pressed touch button.
- Toasts for goals, cards, substitutions and offside. Set-piece hints for the first few uses of each restart.
- Nothing overlaps the touch controls, the safe areas or the ball's usual screen region at any aspect ratio.


### UI rules

- Every screen works with touch alone and with a controller alone: a visible focus ring, a sensible focus order, and Back always works.
- Touch targets are 60 pt or larger.
- HUD updates must not cost frames. Write to the DOM only when a value changes, animate with transform and opacity only, and draw the radar on a small 2D canvas at 20 Hz.


## 13. Performance plan

Targets on iPad (A16) at default settings, measured during play, not in menus.
| Metric | Target |
|---|---|
| Average frame rate | 58 fps or more |
| 1% low frame rate | 50 fps or more |
| Longest frame in play | 33 ms or less |
| Sim plus AI per tick | 2.5 ms average, 4 ms worst case |
| Draw calls per frame | 80 or fewer |
| Triangles per frame | 200,000 or fewer |
| Heap growth in play | None that is steady; no garbage-collection pause over 4 ms |
| After a 20-minute match | All targets still met |


### How to hit them

- **Instancing.** Draw all 22 players with instanced meshes, one per body part, with per-instance transform and colour. Instance or merge the crowd, boards and pitch-side objects. Kits and numbers come from one generated texture atlas.
- **Cheap shading.** Unlit or Lambert-style materials with one directional light plus ambient. At the default tier: no real-time shadow maps, no post-processing, no reflections.
- **Resolution.** Render the 3D canvas at 0.75 of device pixels on iPad to start. Scale dynamically between 0.6 and 1.0 from a smoothed frame-time signal with hysteresis. The DOM HUD stays at native resolution.
- **Context.** `powerPreference: 'high-performance'`, an opaque canvas, no stencil buffer, no preserved drawing buffer. Use anti-aliasing only if the budget holds.
- **No allocation in hot paths.** Preallocated vectors and pools, typed-array state, and no closures, array helpers, string building or object spreads per tick or per frame.
- **Warm-up.** During loading, compile every shader, upload every texture, and run each animation and effect once off screen. The first slide tackle or replay in a match must not hitch.
- **AI budgeting.** Stagger expensive evaluations (pass scans, shape updates) across ticks on a fixed, deterministic schedule.
- **Quality tiers.** Auto picks Performance, Balanced or Quality from a 2-second startup test, then adapts. Quality may add one shadow map and multisampling, and steps down if it cannot hold 50 fps.
- **One loop.** A single `requestAnimationFrame` loop drives everything. No timers drive visuals.


### Proving it

You cannot hold an iPad, so build the instruments.
- **Benchmark mode** at `?bench=1` and in Settings → Diagnostics. It runs a fixed-seed, 90-second bot-v-bot match through the worst cases: a crowded penalty area, a corner, a goal with net ripple, a replay.
- It reports average fps, 1% and 0.1% lows, longest frame, sim ms, render ms, draw calls, triangles, resolution scale, quality tier, device and browser. It shows PASS or FAIL against the table and has a Copy Results button.
- **Proxy gate.** Run the benchmark headless in Chromium with 4x CPU throttling. Fail the build if the sim, draw-call or triangle budgets are exceeded.
- **Final gate.** I run the benchmark on my iPad and paste the result back (section 19). If it fails, you fix it and I run it again.


## 14. Quality plan: zero known glitches

The bar is zero known bugs at hand-off. Every defect any agent finds is fixed and gets a regression test. Only cosmetic issues may be listed in `KNOWN_ISSUES.md`; nothing that affects match state, input or performance may stay open.

### How it is enforced

1. **Invariants**, checked every tick in test and soak builds and compiled out of the release build:
    - Every number in state is finite. Ball and players stay inside world bounds.
    - Exactly one match state, only legal transitions, and no state past its maximum duration.
    - At most one ball owner, and he is on the pitch.
    - 7–11 players per team on the pitch with exactly one keeper each. Substituted and sent-off players never act.
    - Each human's controlled player is valid, on the pitch and on his team.
    - No player stays in an action past its tick budget. No two players overlap beyond tolerance for more than 1 s.
    - The score changes only on a goal event, each goal counts once, and the clock never runs backwards.
    - A keeper handles only inside his own area.
    - Exactly one loose-ball chaser per team while the ball is free.

2. **Soak.** At least 2,000 full bot-v-bot matches, headless and in parallel workers, across seeds, teams, formations, difficulties and rule toggles. Required: zero exceptions, zero invariant failures, zero watchdog triggers, and statistics inside the bands in section 7.
3. **Fuzz.** 500 matches where one or both sides send random and hostile input: button mashing, direction flips every tick, every button at once, pause spam in every state, substitutions at every stoppage, quit and rematch. Same zero-failure requirement.
4. **Determinism.** The same seed and inputs give the same hash across three runs each in Chromium, WebKit and Firefox. A saved replay plays back identically after a reload.
5. **Rules tests.** Table-driven scenarios for offside, goal-line and touchline crossings, every foul class, advantage, every restart, cards and send-offs, extra time and shoot-out order.
6. **Input tests** in Playwright: multi-touch combinations; `pointercancel` in the middle of every hold; touches leaving the screen; rotation, backgrounding and resize mid-hold; mocked pads connecting, disconnecting, reconnecting at a new index, two at once, and non-standard mapping.
7. **End to end.** Boot, every menu path by touch alone and by controller alone, a full short match, rematch and quit, in WebKit and Chromium at iPad size with zero console errors or warnings.
8. **Runtime safety net** in the shipped game: a global error handler that pauses to a recovery screen (resume, restart match, copy diagnostics), the watchdog from section 5, and context-loss recovery.


### The glitch list

Each line below needs a named regression test.
- **Ball stuck:** between two players, under a sliding player, on the roof of the net, behind the goal, wedged against a post or board, resting on the goal line.
- **Goals:** not given when the ball crosses and bounces out; counted twice; given through the side netting; scored direct from a throw-in.
- **Keeper:** holds the ball forever, carries it over his own line, handles outside the area, dives after the ball has passed, fights a defender for the same ball, stays stuck in a dive.
- **Players:** orbit or jitter around a target; two teammates chase or nobody does; run in place against each other; walk through the goal frame or net; stay off the pitch after a throw-in or celebration.
- **Switching:** flip-flops between two players; switches away from the player about to receive; lands on a sent-off or substituted player.
- **Restarts:** taker missing or sent off; opponents inside the required distance blocking forever; ball out of play during a restart; restart given to the wrong team; two restarts queued; kick-off with players in the wrong half.
- **Offside:** given from a throw-in, goal kick or corner, or against a player in his own half.
- **Discipline:** advantage that never resolves; card shown to the wrong player; 12 players after a substitution; a team below 7 players not ending the match.
- **Clock:** half ends during a shot in flight; timer drift; game runs fast after a pause, a tab switch or on a 120 Hz display.
- **Camera:** jitter, snapping at restarts, losing a high ball, dipping below ground or into the stand, ball hidden under touch controls.
- **Input:** stuck sprint or stick after `pointercancel`; button swipe read as a pitch gesture; power bar stuck full; both players pausing at once; controller disconnect during a penalty.
- **Audio:** silent after returning from the background; crowd loop clicking; sounds stacking after a pause.
- **Online:** desync; both sides waiting forever; rematch starting with stale state.


## 15. Teams and data

- 20 fictional clubs, each with an invented name, a unique 3-letter code, a simple generated geometric crest, home, away and keeper kits, a preferred formation and a style. Overall ratings spread from 62 to 88 so there are favourites and underdogs.
- 18 players per club: 11 starters and 7 substitutes, including 2 keepers. Names come from mixed-origin name lists and must not match real footballers; screen the output against famous names.
- Outfield attributes, 1–99: acceleration, sprint speed, agility, ball control, dribbling, short passing, long passing, crossing, vision, finishing, shot power, long shots, curve, heading, standing tackle, sliding tackle, interceptions, strength, stamina, composure.
- Keeper attributes: diving, handling, reflexes, positioning, kicking.
- Also per player: height, preferred foot, weak foot (1–5), skill moves (1–5), position and shirt number.
- Every attribute must visibly change play. Delete any that does not.
- Data comes from a seeded generator script and is committed, so teams stay the same between builds.
- Balance check by simulation over 200 matches: an 88-rated club beats a 62-rated club at least 80% of the time, and equal clubs split close to evenly.


## 16. Running the team: 200 agents

Use sub-agents for almost all of the work. The roster in sections 17 and 18 has 200 assignments. Plan for all 200, run as many at once as your environment allows, and queue the rest. Speed comes from parallel work that never collides, so these rules matter more than the headcount.

### Rules

1. **You orchestrate.** You own the plan, the contracts, the merge queue and the final call on quality. Keep your own context for decisions; delegate the reading, building and testing.
2. **Foundations before fan-out.** Nobody builds features until Wave 0 has produced a compiling project, frozen contracts, a walking skeleton, the test harness, and five docs: `ARCHITECTURE.md`, `CONTRACTS.md`, `OWNERSHIP.md`, `TUNING.md` and `STATUS.md`. The skeleton is a ball, 22 capsules, the broadcast camera, and one player moved by touch and by controller.
3. **Exclusive file ownership.** Each assignment owns named files or folders, recorded in `OWNERSHIP.md`. No two agents ever edit the same file. Shared contracts change only through you: agents send change requests, and you batch and apply them between waves.
4. **Self-contained briefs.** Each agent starts with no memory of this document. Every brief states the goal and why it matters, the files it owns, the contract interfaces it implements and may call, the relevant excerpt of this document (controls rows, tuning targets, glitch-list lines), the tests it must add, its performance budget, and the report to return.
5. **Standard report.** Every agent returns what it built, its test output, open risks, and any contract change requests.
6. **Isolation and merging.** Each agent works in its own branch or worktree where the environment supports it. Merges pass through one queue gated by `npm run verify`: type-check, lint, unit tests, sim scenarios, determinism check and a 10-match short soak. A red gate goes back to its owner.
7. **Parallel batches.** Launch as many agents per message as the environment accepts, and refill slots as agents finish instead of waiting for a whole wave. If concurrency is capped, treat the roster as a queue. If you cannot spawn sub-agents at all, work through the same assignments yourself in roster order.
8. **Builders do not mark their own work.** QA assignments go to agents that did not write the code under test. A QA agent returns failing tests and a diagnosis; the fix goes to the fix agent for that area.
9. **Adjusting the roster.** Split or merge assignments when reality demands it. Keep the total near 200, keep ownership exclusive, and never drop a QA assignment to save time.
10. **Track everything** in `STATUS.md`: assignment id, state, test evidence, open issues. At the end it is the audit trail.
11. **Failed agents.** If an agent fails, returns partial work or drifts off-brief, re-issue the assignment with a sharper brief. Do not absorb its work into your own context.


### Waves

| Wave | Purpose | Assignments | Exit gate |
|---|---|---|---|
| 0 | Foundations | 6 | Skeleton runs, contracts are frozen, verify is green |
| 1 | Build every module in parallel | 120 | Each module passes its own tests against the contracts |
| 2 | Integration | 10 | A full match plays start to finish on touch and on controller |
| 3 | QA swarm | 44 | Every charter has run and every finding has a failing test |
| 4 | Fix, performance, polish | 14 | Zero open defects, budgets met, soak and fuzz clean |
| 5 | Sign-off | 6 | Definition of done confirmed independently |

That is 200 assignments. Waves 3 and 4 loop until Wave 4's gate holds. Online 1v1 (the NET squad) may trail the rest of Wave 1; start it once the sim core is stable.

## 17. Agent roster: foundations and build squads (126)

One line per assignment. Each id is one agent with its own files.

### Wave 0: Foundations, FND (6)

- `FND-01` Toolchain: Vite, strict TypeScript, lint, Vitest, Playwright, single-file build, npm scripts.
- `FND-02` Contracts: `InputFrame`, sim state layout, event types, pitch constants, tuning file, module interfaces.
- `FND-03` Deterministic core: seeded generator, trig and atan2 tables, pooled vector maths, state hash and snapshot.
- `FND-04` App shell: boot, screen router, fixed-step loop with interpolation, pause and visibility handling.
- `FND-05` Walking skeleton: pitch plane, capsule players, ball, broadcast camera, one player moved by touch and by pad.
- `FND-06` Test harness: headless sim runner, invariant checker, replay record and playback, soak and fuzz runners, benchmark harness.


### Wave 1: Sim core, SIM (15)

- `SIM-01` Ball flight: gravity, drag, Magnus, spin decay.
- `SIM-02` Ball contact: bounce, roll, friction, posts, bar, net volume, swept collision.
- `SIM-03` Pitch geometry: lines, areas, goal volumes, out-of-play and goal detection.
- `SIM-04` Locomotion: acceleration, turning, sprint, jockey movement, stamina.
- `SIM-05` Body contact: player collisions, shielding, shoulder-to-shoulder.
- `SIM-06` Possession and dribble touches.
- `SIM-07` First touch, trapping and aerial control.
- `SIM-08` Ground, driven and dinked passes: targeting, power, error.
- `SIM-09` Lobs and crosses.
- `SIM-10` Through balls, ground and lobbed.
- `SIM-11` Shooting: power, aim assist, error model, all shot types.
- `SIM-12` Headers, volleys and aerial duels.
- `SIM-13` Skill moves and fake shot.
- `SIM-14` Tackles: standing, hard, slide, push and pull, clearance, interceptions.
- `SIM-15` Player switching, and action input resolution (holds, double-taps, combos, buffering).


### Wave 1: Rules, RUL (11)

- `RUL-01` Match state machine, clock, halves, added time, extra time, kick-off.
- `RUL-02` Throw-ins.
- `RUL-03` Goal kicks.
- `RUL-04` Corners.
- `RUL-05` Free kicks and walls.
- `RUL-06` Penalties in play.
- `RUL-07` Penalty shoot-out.
- `RUL-08` Offside.
- `RUL-09` Foul classification, advantage, cards, send-offs.
- `RUL-10` Substitutions, playing short, forfeit.
- `RUL-11` Watchdog and restart safety: timeouts, legal positions, queued restarts.


### Wave 1: Goalkeepers, GKP (6)

- `GKP-01` Positioning.
- `GKP-02` Saves: reaction, dive, catch, parry, tip.
- `GKP-03` Coming out: through balls, one-on-ones, crosses, punches.
- `GKP-04` Distribution AI.
- `GKP-05` User keeper control: rush, throws and kicks, pick-up, back-pass rule, 6-second release.
- `GKP-06` Keeper at set pieces: walls, penalties, corners.


### Wave 1: Team AI, TAI (14)

- `TAI-01` Formations and role home positions.
- `TAI-02` Attacking support play and passing angles.
- `TAI-03` Attacking runs: in behind, overlaps, late arrivals, onside timing.
- `TAI-04` Defensive shape and back-line control.
- `TAI-05` Pressing, cover, marking, tracking runners.
- `TAI-06` Transitions: counter-attacks and recovery runs.
- `TAI-07` Loose-ball assignment and arrival steering.
- `TAI-08` CPU ball-carrier decision engine.
- `TAI-09` CPU pass, cross and through-ball evaluation.
- `TAI-10` CPU shooting, dribbling and skill choices.
- `TAI-11` CPU defending: player choice, jockey, tackle timing.
- `TAI-12` Difficulty levels and team styles.
- `TAI-13` Set-piece AI, attacking and defending.
- `TAI-14` Tactics and focus effects; receiver lock and teammate assist for human sides.


### Wave 1: Touch input, TCH (9)

- `TCH-01` Pointer manager: multi-touch, capture, cancel safety, zones.
- `TCH-02` Floating virtual stick.
- `TCH-03` Attack buttons: tap, hold, double-tap, swipe.
- `TCH-04` Defence and keeper buttons, and the attack-defence swap.
- `TCH-05` Pitch gestures: tap, double-tap, swipe, curved swipe, back-and-forth swipe.
- `TCH-06` Set-piece touch controls and flight preview.
- `TCH-07` Touch to `InputFrame` mapping and its tests.
- `TCH-08` Controls editor and touch settings.
- `TCH-09` Touch overlay rendering, press feedback, hints, auto-hide.


### Wave 1: Controller input, PAD (8)

- `PAD-01` Gamepad manager: polling, connect and disconnect, slots, dead zones.
- `PAD-02` Attack mapping.
- `PAD-03` Defence and keeper mapping.
- `PAD-04` Modifiers, combos, double-taps, D-pad tactics.
- `PAD-05` Right-stick skill moves and directional switching.
- `PAD-06` Set-piece mapping.
- `PAD-07` Glyphs, family detection, remap screen, rumble.
- `PAD-08` Keyboard scheme and the menu focus-navigation engine.


### Wave 1: Rendering, GFX (16)

- `GFX-01` Renderer setup: context options, resize, pixel ratio, context-loss recovery.
- `GFX-02` Dynamic resolution and quality tiers.
- `GFX-03` Pitch: grass stripes, lines, wear.
- `GFX-04` Goals and nets with ripple.
- `GFX-05` Stadium, boards, sky, day and night lighting.
- `GFX-06` Crowd: instanced and reactive.
- `GFX-07` Player model and instancing.
- `GFX-08` Kits, numbers, crests, texture atlas, clash check.
- `GFX-09` Animation: locomotion.
- `GFX-10` Animation: kicks, headers, touches, throw-ins.
- `GFX-11` Animation: tackles, falls, keeper, celebrations.
- `GFX-12` Animation mapping and blending from sim state.
- `GFX-13` Ball, shadows, on-pitch markers and indicators.
- `GFX-14` Main broadcast camera.
- `GFX-15` Set-piece, intro and replay cameras.
- `GFX-16` Replay buffer and playback; small effects.


### Wave 1: UI, UIX (12)

- `UIX-01` Design tokens, fonts, dot-field background, base components.
- `UIX-02` Splash and main menu.
- `UIX-03` Team and kit select.
- `UIX-04` Side select and device assignment.
- `UIX-05` Match settings and loading screen.
- `UIX-06` Scoreboard, clock, toasts.
- `UIX-07` Radar, player name and stamina, power bar.
- `UIX-08` Pause menu and team management.
- `UIX-09` Settings screens.
- `UIX-10` Half-time and full-time stats, player of the match.
- `UIX-11` Cup and practice screens.
- `UIX-12` Tutorial and control hints.


### Wave 1: Audio, AUD (5)

- `AUD-01` Audio engine: unlock, buses, mixing, interruption recovery.
- `AUD-02` Crowd bed and reactions.
- `AUD-03` Ball, body and goal-frame sounds.
- `AUD-04` Whistles and match stings.
- `AUD-05` Menu sounds and the event-to-sound map.


### Wave 1: Data, DAT (5)

- `DAT-01` Club generator: names, codes, crests, styles.
- `DAT-02` Player generator: names, positions, attributes.
- `DAT-03` Kit designs and colours.
- `DAT-04` Formation, role and tactic preset data.
- `DAT-05` Rating balance and the attribute-effect audit.


### Wave 1: Online, NET (8)

- `NET-01` Lockstep core: input queues, delay, stall handling.
- `NET-02` PeerJS transport, channels, config.
- `NET-03` Room codes, share links, lobby flow.
- `NET-04` Adaptive delay, redundancy, round-trip measurement.
- `NET-05` Hash exchange, desync detection, snapshot resync.
- `NET-06` Pause, disconnect, rejoin, finish against CPU.
- `NET-07` Online screens: lobby, status, errors.
- `NET-08` Network simulator and two-instance test harness: latency, jitter, loss.


### Wave 1: Modes, MOD (5)

- `MOD-01` Kick-Off flow and match configuration.
- `MOD-02` Cup: draw, bracket, quick results, save.
- `MOD-03` Shoot-out mode.
- `MOD-04` Practice arena and set-piece practice.
- `MOD-05` Stats tracking, match summary data, records.


### Wave 1: Platform, PLT (6)

- `PLT-01` PWA: manifest, icons, service worker, offline, update flow.
- `PLT-02` iPadOS hardening: viewport, gestures, safe areas, orientation, resize.
- `PLT-03` Storage, settings schema, migrations.
- `PLT-04` Single-file build, size budget, font subsetting and inlining.
- `PLT-05` Recovery screen, diagnostics, input tester, benchmark screen.
- `PLT-06` README, deploy guides, credits and licences.


## 18. Agent roster: integration, QA, fix and sign-off (74)


### Wave 2: Integration, INT (10)

- `INT-01` Sim, rules and AI together: a full match loop running headless.
- `INT-02` Input to sim: touch and pad through to actions, for both sides.
- `INT-03` Sim to render: animation, markers and camera in a live match.
- `INT-04` Sim events to audio, HUD, stats and rumble.
- `INT-05` Menus to match and back, for every mode.
- `INT-06` Set pieces end to end on both input types.
- `INT-07` Side select, mixed devices and same-iPad 1v1.
- `INT-08` Online 1v1 end to end.
- `INT-09` Settings applied everywhere and kept across reloads.
- `INT-10` Build, install and offline end to end.


### Wave 3: QA swarm, QA (44)

Simulation and rules:
- `QA-01` Ball-stuck scenarios from the glitch list.
- `QA-02` Goal-line and touchline detection at every speed and angle.
- `QA-03` Post, bar and net collisions; tunnelling.
- `QA-04` Offside correctness table.
- `QA-05` Fouls, advantage and cards.
- `QA-06` Every restart: positions, timeouts, wrong team, queued restarts.
- `QA-07` Penalties and shoot-out order.
- `QA-08` Substitutions, send-offs, playing short, keeper sent off, forfeit.
- `QA-09` Clock, half-end logic, extra time.
- `QA-10` Player overlap and goal-frame penetration.
- `QA-11` Dribbling, first touch and possession hand-over.
- `QA-12` Passing accuracy bands and receiver lock.
- `QA-13` Shooting bands and keeper save rate.
- `QA-14` Stamina and attribute-effect audit.

AI and goalkeepers:
- `QA-15` Loose-ball chasing and orbiting.
- `QA-16` Player switching behaviour.
- `QA-17` Defensive line and marking sanity.
- `QA-18` Attacking movement and onside timing.
- `QA-19` Difficulty ladder verification.
- `QA-20` Match-statistics bands across clubs and styles.
- `QA-21` Keeper glitches from the glitch list.
- `QA-22` Keeper distribution and back-pass handling.

Input:
- `QA-23` Multi-touch matrix.
- `QA-24` `pointercancel` and interruption sweep.
- `QA-25` Button swipes against pitch gestures.
- `QA-26` Touch set pieces.
- `QA-27` Controller mapping checked row by row against section 10.
- `QA-28` Controller lifecycle: connect, disconnect, reconnect, two pads, new index.
- `QA-29` Input latency and buffering measurements.
- `QA-30` Menus by touch only and by controller only.

Rendering and camera:
- `QA-31` Camera framing, jitter, high balls, restarts.
- `QA-32` Animation sync, foot sliding, visible teleports.
- `QA-33` Kit clashes, readability, and HUD overlap at every aspect ratio.
- `QA-34` Draw-call, triangle and texture budgets per scene.
- `QA-35` Context loss, resize, rotation.

Performance:
- `QA-36` Allocation and garbage-collection audit.
- `QA-37` Sim and AI tick-time profiling in worst cases.
- `QA-38` Benchmark under CPU throttling; dynamic resolution behaviour.
- `QA-39` Load time, bundle size, warm-up hitches.

Platform, audio, online and campaigns:
- `QA-40` Install, offline, update, storage failure.
- `QA-41` Audio lifecycle.
- `QA-42` Online: desync, latency, loss, disconnects.
- `QA-43` Determinism across browsers and replays.
- `QA-44` Soak and fuzz campaign owner: runs the 2,000 and 500 matches and triages every failure.


### Wave 4: Fix, performance, polish, FIX (14)

- `FIX-01` Sim core fixes.
- `FIX-02` Rules and restart fixes.
- `FIX-03` Goalkeeper fixes.
- `FIX-04` Team AI fixes.
- `FIX-05` CPU and difficulty tuning.
- `FIX-06` Touch input fixes.
- `FIX-07` Controller fixes.
- `FIX-08` Rendering and animation fixes.
- `FIX-09` Camera tuning.
- `FIX-10` UI and HUD fixes.
- `FIX-11` Audio and platform fixes.
- `FIX-12` Online fixes.
- `FIX-13` Performance optimisation pass.
- `FIX-14` Game-feel tuning against the reference values: pass speeds, shot power curve, turn rates, tackle windows.


### Wave 5: Sign-off, SGN (6)

- `SGN-01` Definition-of-done audit against this document, line by line.
- `SGN-02` Controls audit: every row of sections 9 and 10 exercised.
- `SGN-03` Fresh soak, fuzz and determinism run on the final build.
- `SGN-04` Final benchmark and budget report.
- `SGN-05` Originality and licence audit: names, art, audio, fonts, dependencies.
- `SGN-06` Docs audit: README, controls reference, device checklist, known issues.


## 19. Deliverables, definition of done and final report


### Deliverables

- The source repository with scripts: `npm run dev`, `build`, `verify`, `soak`, `fuzz` and `bench`.
- `dist/index.html`: the whole game in one file. Beside it: `manifest.webmanifest`, `sw.js` and icons. Relative paths only, so it works from any folder on any static HTTPS host.
- `README.md`: run it locally; put it online free in two step-by-step ways (a drag-and-drop static host and GitHub Pages); open it on the iPad and add it to the Home Screen; pair a controller; the full touch and controller reference; troubleshooting.
- `docs/`: `ARCHITECTURE`, `CONTRACTS`, `OWNERSHIP`, `TUNING`, `DECISIONS`, `STATUS`, `TEST_REPORT`, `PERF_REPORT`, `KNOWN_ISSUES`, `ASSETS` and `DEVICE_CHECKLIST`.
- `DEVICE_CHECKLIST.md`: a 15-minute script for me on the iPad. Benchmark; five-finger touch test; a multitasking swipe in the middle of a sprint; pair a controller and disconnect it mid-match; install and play offline; one online match.


### Definition of done

All of these are true on the final commit.
1. `npm run verify` is green, and the 2,000-match soak and 500-match fuzz are clean.
2. Every row in the touch and controller tables works and has a test.
3. A full match in each mode completes on touch alone and on controller alone, in WebKit and Chromium at iPad size, with zero console errors.
4. Same-iPad 1v1 works for controller against controller and touch against controller.
5. Online 1v1 completes a full match in the two-instance harness at 80 ms each way, 20 ms jitter and 5% loss, with no desync.
6. Performance budgets hold in the throttled proxy benchmark, and the on-device benchmark is built and documented.
7. Every line of the glitch list has a passing, named test.
8. `KNOWN_ISSUES.md` holds nothing that affects match state, input or performance.
9. The originality and licence audit passed, and the game makes no network requests at runtime except online 1v1.
10. `dist/index.html` runs from a plain static server with nothing else beside it.
11. `STATUS.md` shows all 200 assignments closed, or re-scoped with a reason.


### Final report

When you finish, reply with:
- Where the build is, and how to open it on the iPad in three steps.
- Test and performance evidence with real numbers: soak and fuzz totals, statistics bands, determinism result, proxy benchmark.
- Anything re-scoped, and why.
- The device checklist.

Then ask me to run the benchmark on my iPad and paste the result. If my numbers miss the targets, or I report a glitch, treat it as a failing test: reproduce it from the replay file, fix it, add a regression test and rebuild.

### When to stop and ask me

- A missing permission or tool you cannot work around.
- Anything that would publish publicly, such as deploying to a host or creating a repository.
- A conflict in this document that changes what gets built.

For everything else: decide, record it in `docs/DECISIONS.md`, and continue.
