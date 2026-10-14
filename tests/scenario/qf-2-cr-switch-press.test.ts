/**
 * [QF-2 skeptic] CR for QF-1 / QF-3 (src/sim/control/switching.ts autoSwitchTick + the SIM-15 face-press resolution
 * order): a face-button press and a SIM-16 auto-switch in the same frame. The press was meant for the player the
 * controller had (the CPU / the user decided on him), but the switch runs first and the press is resolved for the new
 * player. Legend cup bot match, soak seed 4242 #7 (4-minute halves), t 20747: team 0 takes a throw-in 2 m from team 1's
 * defender 15 (controlled by CPU controller 3, in his own third); TAI-11 presses SHOOT to head it clear (an aerial
 * chance in the own third, which SIM-15 makes a clearance). SIM-16 auto-switches controller 3 to 14 in the same frame,
 * 14 is outside his own third, so SIM-15 resolves the press as an ATTACK header SHOT: a 0.75 s header action and a
 * SHOT event (counted in the match stats) from 67 m out.
 * Proposed fix (switching.ts autoSwitchTick): no auto-switch on a frame whose buttons have a fresh face press
 * (ctl.buttons & ~ctl.prevButtons & FACE_MASK) — the press belongs to the current player; or resolve this frame's face
 * press before the auto-switch. (A human pressing a clearance as the auto-switch fires gets the same.)
 * Fixture: the state at t 20746 (serializeState). Marked it.fails until the switching fix lands.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EventType } from '../../src/contracts/events';
import { deserializeState } from '../../src/sim/core/serialize';
import { runTicks } from '../harness/scenario';

describe('QF-2 CR (SIM-16): a face press is resolved for the player it was meant for', () => {
  it.fails('the CPU\'s clearance press for defender 15 is not turned into a header shot from his own half by the player SIM-16 switched to', () => {
    const s = deserializeState(readFileSync(new URL('./fixtures/qf-2-switch-press.state.json', import.meta.url), 'utf8'));
    expect(s.ctrl[3]!.slot).toBe(15);
    const ev = runTicks(s, 60, undefined, { check: 'core' });
    const shots = ev.filter((e) => e.type === EventType.SHOT).map((e) => `slot ${e.a}`);
    expect(shots).toEqual([]);
  });
});
