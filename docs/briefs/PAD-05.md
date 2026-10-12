# PAD-05 — Right-stick skill moves and directional switching
Owns: `src/input/pad/rightStick.ts`. Spec: BRIEF §10 ("Right-stick skill moves, relative to the way the player faces: flick left
or right for a body feint; hold left or right for a ball roll; roll from forward to a side for a step-over; flick forward then
back for a heel flick; roll from back through a side to forward for a roulette. Drag-back is L1 + R1 + left stick flicked
backward (LB + RB on Xbox)."; Change player (directional): right stick; knock-on R2 + right-stick flick), T_PAD.rsHoldMs,
rsSequenceMs, T_INPUT.flickThreshold. Contracts: src/contracts/input.ts (InputFrame, Btn, quantAxis), app.ts (DeviceRegistry, FocusNavigator, MenuAction), settings.ts PadSettings, enums PadFamily, tuning T_PAD/T_INPUT. Your stub was created by FND-05 (read src/input/pad/*, src/input/devices.ts first). Standard mapping indices: 0 Cross/A, 1 Circle/B, 2 Square/X, 3 Triangle/Y, 4 L1/LB, 5 R1/RB, 6 L2/LT, 7 R2/RT, 8 Create/View, 9 Options/Menu, 10 L3, 11 R3, 12-15 D-pad up, down, left, right. Home and Share belong to iPadOS; bind nothing to them. Test with mock Gamepad objects in Node (pure functions) and in Playwright by overriding navigator.getGamepads via page.addInitScript.
Implement a recogniser over right-stick samples (per animation frame, pitch-space after rotation) relative to the controlled
player's facing (read from ctx.state: players[ctrl.slot].fx/fz) producing: skill (SkillMove) edges for the patterns, RS_FLICK
edge with the flick direction in ax/az (directional switch in defence / knock-on with SPRINT), RS_HOLD while held past the hold
threshold; drag-back from L1+R1+left-stick-back. Robust to noise: angular sectors with hysteresis, sequence timeouts.
Tests: synthetic stick paths for each pattern in each facing (incl. facing -x), no false positives from normal aiming, flick
vs hold vs roll discrimination.
