# PAD-03 — Pad reconnect flow (+ defence/keeper rows)
Owns: `src/input/pad/reconnect.ts` and tests `tests/controls/pad-03-*.test.ts`. Spec: BRIEF §10 Defending and Goalkeeper with the
ball tables, quality bar ("Disconnect mid-match: auto-pause with a reconnect card. Any pad button resumes. Offer to hand that side
to touch or the CPU."), glitch "controller disconnect during a penalty". Contracts: src/contracts/input.ts (InputFrame, Btn, quantAxis), app.ts (DeviceRegistry, FocusNavigator, MenuAction), settings.ts PadSettings, enums PadFamily, tuning T_PAD/T_INPUT. Your stub was created by FND-05 (read src/input/pad/*, src/input/devices.ts first). Standard mapping indices: 0 Cross/A, 1 Circle/B, 2 Square/X, 3 Triangle/Y, 4 L1/LB, 5 R1/RB, 6 L2/LT, 7 R2/RT, 8 Create/View, 9 Options/Menu, 10 L3, 11 R3, 12-15 D-pad up, down, left, right. Home and Share belong to iPadOS; bind nothing to them. Test with mock Gamepad objects in Node (pure functions) and in Playwright by overriding navigator.getGamepads via page.addInitScript.
Implement the reconnect flow module used by the session: on a bound pad's disconnect mid-match -> session.pause(-1) and show a
reconnect card (DOM card inside #ui or the HUD root: "Controller 1 disconnected — press any button on a controller to continue,
or hand this side to: Touch / CPU"); any pad button (same or another pad) rebinds and resumes; hand-off to touch rebinds the
human to the touch device; hand-off to CPU converts that controller to CPU for the rest of the match (expose a session hook
request as a change request if SessionControl lacks it — propose `setHumanDevice(human, deviceIds | 'cpu')`). Then prove every
row of §10 Defending and Goalkeeper-with-the-ball tables end to end through the sim (like PAD-02).
Tests: unit tests for the flow state machine; e2e with mocked pads (disconnect during play and during a penalty).
