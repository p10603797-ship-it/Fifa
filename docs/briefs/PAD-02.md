# PAD-02 — Pad to InputFrame mapping (+ attack/movement/shooting rows)
Owns: `src/input/pad/mapper.ts` and tests `tests/controls/pad-02-*.test.ts`. Spec: BRIEF §10 Movement and dribbling, Attacking,
Shooting tables (all rows) and quality bar ("A modifier combo resolves when the face button is pressed, never when the modifier
is." "Input buffering: a press up to 6 ticks before the player can act still fires."). Contracts: src/contracts/input.ts (InputFrame, Btn, quantAxis), app.ts (DeviceRegistry, FocusNavigator, MenuAction), settings.ts PadSettings, enums PadFamily, tuning T_PAD/T_INPUT. Your stub was created by FND-05 (read src/input/pad/*, src/input/devices.ts first). Standard mapping indices: 0 Cross/A, 1 Circle/B, 2 Square/X, 3 Triangle/Y, 4 L1/LB, 5 R1/RB, 6 L2/LT, 7 R2/RT, 8 Create/View, 9 Options/Menu, 10 L3, 11 R3, 12-15 D-pad up, down, left, right. Home and Share belong to iPadOS; bind nothing to them. Test with mock Gamepad objects in Node (pure functions) and in Playwright by overriding navigator.getGamepads via page.addInitScript.
Implement PadInputSource.sample(out, ctx): face/shoulder/trigger buttons -> Btn bits (0 PASS, 1 SHOOT, 2 LOB, 3 THROUGH,
4 MOD_L, 5 MOD_R, 6 SHIELD (> 0.3), 7 SPRINT (> 0.3)); left stick -> mx/mz in pitch space (stick up = -z, right = +x, rotated by
projector.stickRotation()); right stick -> ax/az plus RS_FLICK/RS_HOLD/skill from PAD-05's recogniser (use its export);
D-pad sequences -> cmd/cmdArg via PAD-04's recogniser; Options -> pause callback; edges sampled per tick with presses that
happened between ticks never lost (latch presses until sampled). Remaps for non-standard pads from settings.controls.pad.remaps.
Then prove every row of §10 Movement, Attacking and Shooting tables end to end: drive the real step pipeline with frames from
your mapper (mock PadState sequences) and assert the started action/flags in the sim (where a sim module is still a stub,
assert the resolver's intent: p.act, p.actKick, flags). Name each test after the row.
Tests: as above + no lost quick taps between ticks, determinism of the frame stream.
