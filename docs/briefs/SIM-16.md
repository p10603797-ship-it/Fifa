# SIM-16 — Player switching
Owns: `src/sim/control/switching.ts`. Replace the Wave 0 baseline (keep ensureControlledPlayer, switchTo,
bestSwitchTarget, switchTick). Spec: BRIEF §6 Defending ("Switching: nearest effective defender by default, with a
short lock-out so it never flip-flops. Manual directional switch is always available. Auto-switch setting: Off, Air
balls and loose balls, Auto. The next switch target shows a faint marker."), §10 L1 change player, RS directional;
glitch list "Switching: flip-flops between two players; switches away from the player about to receive; lands on a
sent-off or substituted player".
Implement for every controller (humans and CPU brains; CPU uses AUTO):
- Ownership rules: in possession, control follows the ball carrier (switch on gaining possession); when a teammate
  is the intended receiver of our pass (ball.passTarget same team), switch to him when the pass is struck (Assisted)
  or on reception (Off) — and never switch away from him while the ball travels to him; keeper takes control when he
  holds the ball in hands (so the human distributes).
- Manual switch (MOD_L press in defence, or touch SWITCH tap = MOD_L): best effective defender = the one who can
  affect the play soonest (arrival time to the ball/carrier's path via SIM-04 ticksToReach, goal-side bonus),
  excluding the current one; lock-out switchLockTicks; directional RS flick (Btn.RS_FLICK + ax/az) picks the
  teammate most aligned with the flick direction from the current player.
- Auto-switch: OFF never except possession rules; AIR_AND_LOOSE when the ball is airborne or loose and another
  teammate will clearly reach it first; AUTO also when the current defender is beaten. Hysteresis + lock-out so it
  never flip-flops. ctrl.nextSwitch = who manual switch would pick (HUD faint marker).
- Two humans on the same side never control the same player. Never select inactive (sent off) players; a
  substituted slot gets a fresh player — keep control only if valid.
- `switchTo` emits SWITCH, maintains p.ctrl/ctrl.slot (clear previous), resets the previous player's intent to AI.
Tests (named after each glitch line), plus: possession follow, receiver switching, keeper in hands, manual vs
directional, lock-out timing, two humans same side, determinism.
