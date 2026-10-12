# PAD-04 — D-pad tactics and device-level sequences
Owns: `src/input/pad/sequences.ts`. Spec: BRIEF §10 Tactics table: Quick tactics D-pad up then up (offside trap), left (team
press), right (extra striker) or down (get in the box); Tactical focus D-pad right then up (default), left (defending) or right
(attacking); Quick substitution D-pad down then down; Corner tactics D-pad down then up (far post), left (edge of box), right
(crowd the keeper) or down (near post) during corners; T_PAD.dpadSequenceMs. Contracts: src/contracts/input.ts (InputFrame, Btn, quantAxis), app.ts (DeviceRegistry, FocusNavigator, MenuAction), settings.ts PadSettings, enums PadFamily, tuning T_PAD/T_INPUT. Your stub was created by FND-05 (read src/input/pad/*, src/input/devices.ts first). Standard mapping indices: 0 Cross/A, 1 Circle/B, 2 Square/X, 3 Triangle/Y, 4 L1/LB, 5 R1/RB, 6 L2/LT, 7 R2/RT, 8 Create/View, 9 Options/Menu, 10 L3, 11 R3, 12-15 D-pad up, down, left, right. Home and Share belong to iPadOS; bind nothing to them. Test with mock Gamepad objects in Node (pure functions) and in Playwright by overriding navigator.getGamepads via page.addInitScript.
Implement a deterministic recogniser over D-pad edges producing (cmd, cmdArg) per contracts Command (TACTIC_*, FOCUS_*,
QUICK_SUB, CORNER_*), context-aware (corner tactics only when the human's team takes a corner — read ctx.state), with a
visible pending-state API for the HUD (e.g. getPending(): 'tactics' | 'focus' | 'sub' | 'corner' | null) and timeout. Also
own the device-level double-press latch helper used by PAD-02 if needed. Quick sub opens the quick-sub prompt
(Command.QUICK_SUB; the app shows UI).
Tests: every sequence -> command, timeouts, interleaved buttons, corner context, unit with synthetic edge streams.
