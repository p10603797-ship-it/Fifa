# DotKick keyboard scheme (desktop development)

The keyboard produces the same `InputFrame` as a controller (positional buttons, the Classic controller layout of
`docs/BRIEF.md` section 10): every key below stands for a pad position, so the context rules (attack, defence, keeper,
set pieces) are the pad's.
Source: `src/input/keyboard.ts` (match) and `src/input/menuInput.ts` (menus). Keys are read by physical position
(`KeyboardEvent.code`), so the letters are the US-layout positions whatever the keyboard layout.

## In a match

| Key | Pad (PlayStation / Xbox) | InputFrame | Attack / defence meaning |
|---|---|---|---|
| W A S D or arrow keys | left stick | `mx` / `mz` | move (W / Up = up the screen) |
| J | Cross / A | `Btn.PASS` | ground pass, header / contain (hold) / keeper throw |
| K | Circle / B | `Btn.SHOOT` | shoot (hold for power) / tackle, clearance |
| U | Square / X | `Btn.LOB` | lob, cross / slide tackle |
| I | Triangle / Y | `Btn.THROUGH` | through ball / keeper rush (hold) |
| Q | L1 / LB | `Btn.MOD_L` | chip and lob modifier, trigger a run (tap) / change player |
| E | R1 / RB | `Btn.MOD_R` | finesse / driven modifier, call for support (tap) / second defender (hold) |
| C | L2 / LT | `Btn.SHIELD` | shield / jockey |
| Shift (either) | R2 / RT | `Btn.SPRINT` | sprint; free kick: choose the taker |
| Space | (skip) | `Btn.SKIP` | skip a celebration, replay or establishing shot |
| Esc or P | Options / Menu | pause | pause menu |
| 1 / 2 / 3 / 4 | D-pad up / down / left / right | `cmd` (tactics) | quick tactics, tactical focus, quick sub, corner tactics |
| Ctrl or Alt + arrow key | D-pad in that direction | `cmd` (tactics) | same as 1-4 |
| Numpad 8 / 2 (or 5) / 4 / 6 | right stick up / down / left / right | `ax` / `az`, `Btn.RS_FLICK`, `Btn.RS_HOLD`, `skill` | skill moves, directional switch, knock-on (with Shift), free-kick curl, penalty dive |
| Numpad 7 / 9 / 1 / 3 | right stick diagonals | as above | |
| Alt (Option) + I / K / J / L | right stick up / down / left / right | as above | for laptops without a numpad |
| R | right stick held to a side | `skill = BALL_ROLL` | ball roll |
| F | right stick flicked to a side | `skill = BODY_FEINT` | body feint |
| T | right stick rolled forward to a side | `skill = STEP_OVER` | step-over |
| G | right stick rolled back, side, forward | `skill = ROULETTE` | roulette |
| H | right stick flicked forward then back | `skill = HEEL_FLICK` | heel flick |
| B | L1 + R1 + left stick back | `skill = DRAG_BACK` | drag-back |

Combos are the pad's combos with these keys: E + J driven pass, Q + K chip shot, Q + E + K power shot, C + K trivela
(outside-of-the-foot curler; C held at the K press), E held while running a controlled sprint (tight dribble), J then J
lofted pass, K then J fake shot, Shift + a right-stick tap knock-on, Q + E + a back tap on the movement keys a
drag-back, and so on (section 10 of `docs/BRIEF.md`).

### D-pad sequences (1-4)

| First | Second | Command |
|---|---|---|
| 1 (up) | 1 / 3 / 4 / 2 | offside trap / team press / extra striker / get in the box |
| 4 (right) | 1 / 3 / 4 | tactical focus default / defending / attacking |
| 2 (down) | 2 | quick substitution |
| 2 (down), own corner | 1 / 3 / 4 / 2 | far post / edge of the box / crowd the keeper / near post |

The second press must follow within 1.2 s (`T_PAD.dpadSequenceMs`); the HUD prompt shows the pending sequence.

### Skill keys

R, F, T and G go to the side you steer toward, relative to the way the controlled player faces (nothing held: his
right). They work exactly when the right-stick moves would: in play, with our ball or a loose one, never while the
keeper holds the ball. The numpad (or Alt + I J K L) right stick also performs every stick skill by the pad's
gestures (tap to a side = body feint, hold to a side = ball roll, and so on).

### Rules worth knowing

* A key's layer is fixed when it goes down: an arrow pressed with Ctrl or Alt stays a D-pad key until released (it
  never moves the player), and I J K L pressed with Alt stay right-stick keys (never face buttons).
* Every press counts once: a tap shorter than a frame is still seen; a quick release and re-press is two presses
  (double taps are never merged); holding a key never repeats a button, D-pad press, flick or skill.
* Switching window or tab, a hidden page, and releasing Cmd release every key (no stuck sprint or stick). Keys typed
  into a text field, Cmd combos and Ctrl + letter shortcuts never reach the game.
* Pausing and resuming release movement, the right stick and the D-pad; buttons still held then stay ignored until
  released, as on a pad.
* OS / browser combos to avoid: Ctrl + arrows on macOS (Mission Control) and Alt + arrows on Windows browsers
  (back / forward) may be taken before the page sees them; use 1-4 for the D-pad there. On Windows, Alt + D or
  Alt + F can move focus to the browser's address bar or menu; prefer the numpad for the right stick.

## In menus

| Key | Pad | Action |
|---|---|---|
| Arrow keys or W A S D | D-pad or left stick | move focus (repeats while held: first after 300 ms, then every 120 ms) |
| Enter, Space or J | Cross / A | confirm |
| Esc, Backspace or K | Circle / B | back |
| Q or Page Up | L1 / LB | previous tab |
| E or Page Down | R1 / RB | next tab |
| P | Options / Menu | pause / resume |
| Tab / Shift + Tab | (none) | browser focus order; the focus ring follows, so Enter confirms the control Tab reached |

On a slider or toggle, left and right change the value instead of moving focus. The focus ring appears with the first
key or controller press and disappears on the next touch or click. A held direction never runs away: switching window
or tab, a hidden page or releasing Cmd stops the repeat. Keys typed into a text field stay there (only Esc leaves it).
Ctrl, Alt and Cmd combinations are left to the browser.
