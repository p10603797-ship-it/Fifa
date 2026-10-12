# PAD-01 — Gamepad manager and device registry
Owns: `src/input/pad/manager.ts`, `src/input/devices.ts`. Spec: BRIEF §3 Controllers ("A pad appears only after one of its
buttons is pressed."), §10 Controller quality bar ("Poll every frame and detect edges. The stick dead zone is radial: 0.15
inner, 0.95 outer, rescaled. Triggers are analogue; sprint engages past 0.3." "Two pads at once, each bound to a side at side
select. Bind by pad identity, since indices change on reconnect." "Disconnect mid-match: auto-pause with a reconnect card."),
§11 side select (Touch, Controller 1, Controller 2, Keyboard icons). Contracts: src/contracts/input.ts (InputFrame, Btn, quantAxis), app.ts (DeviceRegistry, FocusNavigator, MenuAction), settings.ts PadSettings, enums PadFamily, tuning T_PAD/T_INPUT. Your stub was created by FND-05 (read src/input/pad/*, src/input/devices.ts first). Standard mapping indices: 0 Cross/A, 1 Circle/B, 2 Square/X, 3 Triangle/Y, 4 L1/LB, 5 R1/RB, 6 L2/LT, 7 R2/RT, 8 Create/View, 9 Options/Menu, 10 L3, 11 R3, 12-15 D-pad up, down, left, right. Home and Share belong to iPadOS; bind nothing to them. Test with mock Gamepad objects in Node (pure functions) and in Playwright by overriding navigator.getGamepads via page.addInitScript.
Implement: PadManager polling navigator.getGamepads() once per animation frame (pollFrame), PadState per known pad (stable
identity key from id + a per-session instance counter, reconnect matching by id), edge detection, radial dead zone with
rescale, triggers 0..1, connected/disconnected events (gamepadconnected/disconnected + polling diff); device registry exposing
'touch', 'keyboard', 'pad:<key>' with labels and family (glyphs.ts from PAD-07 for family detection — use its export if
present), subscribe notifications, lastActive device, createSource(id, human) for each kind; disconnect of a bound pad mid-match
calls a registry callback (session auto-pause; PAD-03 shows the card).
Tests: unit — dead zone maths, trigger threshold, connect-on-press, two pads, reconnect at a new index keeps the binding,
disconnect event; e2e with mocked pads.
