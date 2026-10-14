/**
 * QF-3 QA-27 / QA-23 (second pass), end to end through the real touch source, mapper and sim (qf-3-touch-rig): every
 * touch swipe that is an L1 combo (PASS down = pass and go, PASS left = driven lob, SHOOT up = chip, SHOOT right = power
 * shot, THROUGH up = lobbed through ball) on a loose ball rolling to the controlled player. Touch sends L1 and the face
 * button in one frame, and SIM-16 read that L1 press as "change player" on every loose ball: the swipe handed control
 * to a teammate and the kick never happened. Fixed in src/sim/control/switching.ts (modifierCombo).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
import { ReqFlag } from '../../src/contracts/systems';
import { ClusterMode, ClusterSlot } from '../../src/contracts/touch';
import { makeScenario } from '../harness/scenario';
import { createTouchRig, type TouchRig } from './qf-3-touch-rig';

const P = 9;

/** P1 controls #9 at (20, 0); a loose ball (last touched by the away side) rolls to him from 3 m; #10 is free. */
function looseArriving(): TouchRig {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY,
    humans: [{ side: 0, slot: P }],
    players: [{ slot: P, x: 20, z: 0, fx: -1, fz: 0 }, { slot: 10, x: 24, z: 6 }],
    ball: { owner: -1, x: 17, y: 0.11, z: 0, vx: 6, vz: 0, lastTouchTeam: 1, passTarget: -1 },
  });
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
  return createTouchRig(s);
}

const COMBOS: [string, ClusterSlot, number, number, (k: KickKind, flags: number) => boolean][] = [
  ['PASS swipe down (pass and go)', ClusterSlot.LOW, 0, 1, (k, f) => k === KickKind.GROUND_PASS && (f & ReqFlag.PASS_AND_GO) !== 0],
  ['PASS swipe left (driven lob)', ClusterSlot.LOW, -1, 0, (k) => k === KickKind.DRIVEN_LOB],
  ['SHOOT swipe up (chip)', ClusterSlot.HIGH, 0, -1, (k) => k === KickKind.SHOT_CHIP],
  ['SHOOT swipe right (power shot)', ClusterSlot.HIGH, 1, 0, (k) => k === KickKind.SHOT_POWER],
  ['THROUGH swipe up (lobbed through ball)', ClusterSlot.MID, 0, -1, (k) => k === KickKind.THROUGH_LOBBED],
];

describe('QF-3 QA-27 touch L1 combos on a loose ball rolling to the controlled player', () => {
  for (const [name, slot, dx, dy, ok] of COMBOS) {
    it(`${name}: control stays with him and he plays the combo (never a switch to a teammate)`, () => {
      const r = looseArriving();
      r.tick(1);
      expect(r.st.mode).toBe(ClusterMode.ATTACK);
      const p = r.slot(slot);
      r.down(2, p.x, p.y); r.wait(17); r.move(2, p.x + dx * 15, p.y + dy * 15); r.wait(17);
      r.move(2, p.x + dx * 40, p.y + dy * 40); r.wait(17); r.up(2, p.x + dx * 40, p.y + dy * 40);
      let kind = KickKind.NONE, flags = 0;
      for (let i = 0; i < 60 && kind === KickKind.NONE; i++) {
        r.tick();
        expect(r.s.ctrl[0]!.slot, `tick ${i}: control moved`).toBe(P);
        const q = r.s.players[P]!;
        if (q.act !== ActionKind.NONE && q.actKick !== KickKind.NONE) { kind = q.actKick; flags = q.actA; }
      }
      // The combo went out as one frame: L1 with the face button.
      expect(r.frames.some((f) => (f.buttons & Btn.MOD_L) !== 0 && (f.buttons & (Btn.PASS | Btn.SHOOT | Btn.LOB | Btn.THROUGH)) !== 0)).toBe(true);
      expect(ok(kind, flags), `kick ${kind} flags ${flags}`).toBe(true);
    });
  }

  it('control: L1 alone (a SWITCH tap) still changes player on a loose ball nearer the opponents', () => {
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY,
      humans: [{ side: 0, slot: 4 }],
      players: [{ slot: 4, x: -30, z: 10 }, { slot: 5, x: -21, z: 1 }, { slot: 18, x: -19, z: 0 }],
      ball: { owner: -1, x: -19.5, y: 0.11, z: 0, lastTouchTeam: 1, passTarget: -1 },
    });
    for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
    const r = createTouchRig(s);
    r.tick(1);
    expect(r.st.mode).toBe(ClusterMode.DEFENCE);
    const p = r.slot(ClusterSlot.LOW);
    r.down(2, p.x, p.y); r.wait(60); r.up(2, p.x, p.y);
    r.tick(6);
    expect(r.s.ctrl[0]!.slot).not.toBe(4);
  });
});
