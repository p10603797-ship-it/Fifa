# QF-3 — Touch, controller and menus: QA-23..QA-30, FIX-06, FIX-07

Area (exclusive for this wave): `src/input/**`, `src/ui/focus*`, `src/ui/screens/controls*.ts`, `src/ui/screens/remap.ts`,
`src/sim/control/**` only for input-resolution defects (coordinate: QF-1 owns the rest of src/sim; say in your report
which sim/control files you changed).
Charter (BRIEF §9, §10, §14 input tests and glitch list input/switching):
- QA-23 multi-touch matrix (stick + every button, two buttons + stick, gesture + button); QA-24 pointercancel and
  interruptions mid-hold (rotation, background, resize, touches leaving the screen); QA-25 button swipes vs pitch
  gestures; QA-26 touch set pieces (aim, power, curve for each restart); QA-27 controller mapping row by row against §10
  (write a table test: each row -> expected sim action); QA-28 controller lifecycle (connect, disconnect, reconnect at a
  new index, two pads, non-standard mapping, disconnect during a penalty); QA-29 input latency and buffering
  (input-to-action ticks, buffered presses honoured); QA-30 menus by touch only and by controller only (every screen).
Playwright with mocked Gamepad API and synthetic multi-touch; Chromium only here (WebKit not installed: note it).
