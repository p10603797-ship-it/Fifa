# PAD-06 — Set-piece controller rows (end-to-end tests)
Owns: tests `tests/controls/pad-06-*.test.ts` (and helper `tests/controls/pad-06-helpers.ts`). Spec: BRIEF §10 Tactics, set pieces and
menus table: Free kick (aim left stick; curl/dip right stick; shoot B, finesse R1+B, chip L1+B; ground pass A; lob or cross X;
choose the taker R2), Defending a free kick (wall jump Y; wall charge A; move wall L2 or R2), Corner (lob cross X; short pass A;
aim left stick; target reticle right stick; corner tactics D-pad), Throw-in (move along the line left stick; short throw A; long
throw hold X), Penalty (aim left stick; shoot B; finesse R1+B; chip L1+B), Saving a penalty (move along the line left stick; dive
right stick). Contracts: src/contracts/input.ts (InputFrame, Btn, quantAxis), app.ts (DeviceRegistry, FocusNavigator, MenuAction), settings.ts PadSettings, enums PadFamily, tuning T_PAD/T_INPUT. Your stub was created by FND-05 (read src/input/pad/*, src/input/devices.ts first). Standard mapping indices: 0 Cross/A, 1 Circle/B, 2 Square/X, 3 Triangle/Y, 4 L1/LB, 5 R1/RB, 6 L2/LT, 7 R2/RT, 8 Create/View, 9 Options/Menu, 10 L3, 11 R3, 12-15 D-pad up, down, left, right. Home and Share belong to iPadOS; bind nothing to them. Test with mock Gamepad objects in Node (pure functions) and in Playwright by overriding navigator.getGamepads via page.addInitScript.
Write table-driven end-to-end tests: build set-piece scenarios (tests/harness/scenario.ts), feed pad-derived InputFrames (use
PAD-02's mapper with mock pad states) through the real step pipeline, and assert the outcome per row (restart aim state, action
started, ball launched with the right kind, wall jumped, keeper dive direction). Where a RUL module is still a stub, mark the test
with it.todo naming the dependency and report it — do not fake results. Re-run at the end and report pass/todo counts.
