# PAD-07 — Glyphs, family detection, remap screen, rumble
Owns: `src/input/pad/glyphs.ts`, `src/input/pad/rumble.ts`, `src/ui/screens/remap.ts`. Spec: BRIEF §10 ("label by controller family:
PlayStation shapes, Xbox letters or Switch letters. Detect the family from gamepad.id, with a manual override in settings." "Rumble
on goal, post and hard tackle where vibrationActuator exists. It has a setting." "A pad without standard mapping gets a remap
screen: press the button for each action."), §2 (no commercial logos — draw glyphs as simple generated SVG shapes/letters).
Contracts: src/contracts/input.ts (InputFrame, Btn, quantAxis), app.ts (DeviceRegistry, FocusNavigator, MenuAction), settings.ts PadSettings, enums PadFamily, tuning T_PAD/T_INPUT. Your stub was created by FND-05 (read src/input/pad/*, src/input/devices.ts first). Standard mapping indices: 0 Cross/A, 1 Circle/B, 2 Square/X, 3 Triangle/Y, 4 L1/LB, 5 R1/RB, 6 L2/LT, 7 R2/RT, 8 Create/View, 9 Options/Menu, 10 L3, 11 R3, 12-15 D-pad up, down, left, right. Home and Share belong to iPadOS; bind nothing to them. Test with mock Gamepad objects in Node (pure functions) and in Playwright by overriding navigator.getGamepads via page.addInitScript.
Implement: family detection from gamepad.id strings (Sony/DualSense/DualShock/054c -> PLAYSTATION, Xbox/045e/XInput ->
XBOX, Nintendo/Pro Controller/057e -> SWITCH (note Switch letter positions differ: east = A), else GENERIC) + settings override;
glyph(family, Btn or button index) -> label + inline SVG (circle/cross/square/triangle shapes drawn by you; letters for others);
rumble(padKey, kind) using vibrationActuator.playEffect('dual-rumble') guarded, driven by sim events (GOAL, POST, TACKLE hard)
through an exported `createRumbleListener(registry, settings)` with onEvents(events, state); remap screen: for a pad with
mapping !== 'standard', walk through actions (PASS, SHOOT, LOB, THROUGH, MOD_L, MOD_R, SHIELD, SPRINT, PAUSE, D-pad) asking
to press a button for each, saving settings.controls.pad.remaps[id] (works by touch alone too; Back always works).
Tests: unit — id strings to family for a table of real-world-style ids (do not use real product logos), glyph table, rumble
event mapping; e2e — remap screen with a mocked non-standard pad.
