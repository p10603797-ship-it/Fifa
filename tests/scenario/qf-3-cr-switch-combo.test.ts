/**
 * QF-3 CR (src/sim/control/switching.ts, INT-A / QF-1 owned while INT-A runs): an L1 + face combo on a loose ball that
 * the sim itself treats as ours (controlContext = ATTACK: the ball is arriving at the controlled player, or he is
 * nearer than the opponents) switches control instead of making the combo. switchTickInner reads ANY MOD_L press edge
 * as "change player" whenever canManualSwitch holds, and canManualSwitch (attackContext: possession or our pass in
 * flight) is true for every loose ball. Touch sends every L1 combo in one frame (PASS swipe down = pass and go, SHOOT
 * swipe up = chip, SHOOT swipe right = power shot, THROUGH swipe up = lobbed through, PASS swipe left = driven lob),
 * so on a loose ball arriving at him those swipes hand the ball to another player; a pad pressing L1 + B together
 * does the same. Section 10: "A modifier combo resolves when the face button is pressed, never when the modifier is."
 *
 * Proposed fix (switching.ts switchTickInner):
 *   -  } else if ((pressed & Btn.MOD_L) !== 0 && ctl.switchLockT <= MANUAL_HOLD) {
 *   +  } else if ((pressed & Btn.MOD_L) !== 0 && ctl.switchLockT <= MANUAL_HOLD &&
 *   +      !((pressed & FACE_MASK) !== 0 && validSlot(ctl.slot) && controlContext(s, ctl.slot) === Ctx.ATTACK)) {
 *   (FACE_MASK, Ctx, controlContext from ./resolveShared). L1 alone still switches on a loose ball; with an opponent
 *   on the ball (Ctx.DEFENCE) L1 + face still switches as today.
 * When fixed, drop `.fails`.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
import { makeScenario, runTicks } from '../harness/scenario';

function looseArriving() {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY,
    humans: [{ side: 0, slot: 9 }],
    players: [{ slot: 9, x: 20, z: 0 }, { slot: 10, x: 24, z: 6 }],
    ball: { owner: -1, x: 15, y: 0.11, z: 0, vx: 4, vz: 0, lastTouchTeam: 1, passTarget: -1 },
  });
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
  return s;
}

describe('QF-3 CR switching: L1 + face combo on a loose ball arriving at the controlled player', () => {
  it.fails('L1 + Circle in one frame chips with #9 (control stays), it does not switch to #10', () => {
    const s = looseArriving();
    const first = s.tick + 1;
    let shot = KickKind.NONE;
    runTicks(s, 60, (tick, _st, out) => {
      if (tick === first) out[0]!.buttons = Btn.MOD_L | Btn.SHOOT;
      else if (tick < first + 4) out[0]!.buttons = Btn.SHOOT;
    }, { until: (st) => {
      const p = st.players[9]!;
      if (p.act !== ActionKind.NONE && p.actKick !== KickKind.NONE) shot = p.actKick;
      return shot !== KickKind.NONE;
    } });
    expect(s.ctrl[0]!.slot).toBe(9);
    expect(shot).toBe(KickKind.SHOT_CHIP);
  });

  it('control: L1 alone on the same loose ball still switches (that part is right)', () => {
    const s = looseArriving();
    const first = s.tick + 1;
    runTicks(s, 3, (tick, _st, out) => { if (tick === first) out[0]!.buttons = Btn.MOD_L; });
    expect(s.ctrl[0]!.slot).not.toBe(9);
  });
});
