# PAD-08 — Keyboard scheme and menu focus navigation
Owns: `src/input/keyboard.ts`, `src/input/focus.ts`, `src/input/menuInput.ts`. Spec: BRIEF §10 ("Keyboard scheme for desktop
development, documented in the README."), §10 Menus (Confirm Cross/A; back Circle/B; move D-pad or left stick; switch tab L1/R1),
§12 UI rules ("Every screen works with touch alone and with a controller alone: a visible focus ring, a sensible focus order, and
Back always works."). Contracts: src/contracts/input.ts (InputFrame, Btn, quantAxis), app.ts (DeviceRegistry, FocusNavigator, MenuAction), settings.ts PadSettings, enums PadFamily, tuning T_PAD/T_INPUT. Your stub was created by FND-05 (read src/input/pad/*, src/input/devices.ts first). Standard mapping indices: 0 Cross/A, 1 Circle/B, 2 Square/X, 3 Triangle/Y, 4 L1/LB, 5 R1/RB, 6 L2/LT, 7 R2/RT, 8 Create/View, 9 Options/Menu, 10 L3, 11 R3, 12-15 D-pad up, down, left, right. Home and Share belong to iPadOS; bind nothing to them. Test with mock Gamepad objects in Node (pure functions) and in Playwright by overriding navigator.getGamepads via page.addInitScript.
Implement: KeyboardInputSource covering every Btn and movement (keep FND-05's table, add D-pad tactics keys 1-4/arrows+modifier,
right stick on IJKL or numpad, skill keys), documented in the file header and as a markdown table in docs/KEYBOARD.md (you own it);
FocusNavigator: spatial navigation (nearest candidate in the pressed direction by geometry, wrap within containers marked
data-focus-group), initial focus, focus ring styling hook (class), CONFIRM clicks, BACK -> subscribers then router.back,
TAB_PREV/NEXT for [data-tabs]; sliders/toggles adjust with LEFT/RIGHT when focused (data-focus-adjust); menuInput: pads (any
connected) + keyboard -> MenuAction with initial delay 300 ms and repeat 120 ms; Options -> START (pause).
Tests: unit — geometry selection (pure), repeat timing (fake clock); e2e — navigate main menu -> settings -> back with keyboard
only and with a mocked pad only.
