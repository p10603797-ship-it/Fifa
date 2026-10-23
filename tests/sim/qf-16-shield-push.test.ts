/**
 * [QF-16] SIM-05 shielding: the shield hold keeps a challenger off the ball (the challenger is the one moved when the
 * bodies overlap), but it also let the shielder walk him back. A human holding SHIELD with his back to goal and the
 * stick toward the defender backed into him at walking pace and pushed him along: every CPU level's defender was walked
 * back about 11 m in 10 s (qf-16-shield-level). Now a shielder driving into a held-off challenger (faster than
 * shieldDriveSpeed along the contact normal) is the one held off; standing (or strafing) he still holds the challenger
 * off the ball.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, MatchPhase } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { LOCAL_TUNING as BODY } from '../../src/sim/players/bodies';
import { makeScenario, runTicks } from '../harness/scenario';

const C = 9; // P1, shielding with his back to the +x goal
const D = 15; // P2, the challenger, standing

function scene(seed: number): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: C }, { side: 1, slot: D }], seed });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    const k = i % 11;
    if (k === 0) { p.x = i < 11 ? -51 : 51; p.z = 0; } else { p.x = -45; p.z = -30 + k * 5.5 + (i < 11 ? 0 : 2); }
    p.vx = 0; p.vz = 0; p.fx = i < 11 ? 1 : -1; p.fz = 0; p.homeX = p.x; p.homeZ = p.z;
    p.act = ActionKind.NONE; p.moveMode = MoveMode.STOP;
  }
  const q = s.players[C]!;
  q.x = 0; q.z = 0; q.fx = -1; q.fz = 0; q.lastTouchTick = s.tick;
  const d = s.players[D]!;
  d.x = 0.85; d.z = 0.05 * (seed % 3 - 1); d.fx = -1; d.fz = 0;
  // Equal strength: the shield duel is the shielder's (+ shieldStrengthBonus), so he holds the challenger off.
  s.attrs[C]!.strength = 70; s.attrs[D]!.strength = 70;
  const b = s.ball;
  b.x = -0.5; b.z = 0; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = 0; b.vz = 0; b.vy = 0; b.grounded = 1;
  b.owner = C; b.ownerT = 0; b.heldBy = -1; b.lastTouch = C; b.lastTouchTeam = 0;
  return s;
}

describe('QF-16 SIM-05: a shielder does not walk a standing challenger back', () => {
  it('reads its tuning', () => {
    expect(BODY.shieldDriveSpeed).toBeGreaterThan(0);
    expect(BODY.shieldDriveSpeed).toBeLessThan(1);
  });

  it('glitch: defender jockeys a dribbler for ever — backing in with the shield held does not push a standing defender back', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const s = scene(seed);
      const d0 = s.players[D]!.x;
      // P1 holds SHIELD and backs into him (stick +x, toward the defender); P2 stands.
      runTicks(s, 120, (_t, _st, out) => { out[0]!.buttons |= Btn.SHIELD; out[0]!.mx = 40; }, { check: 'core' });
      // Before: the defender was pushed back at the shielder's walking pace (~1.3 m in 2 s); now he barely moves.
      expect(s.players[D]!.x - d0, `seed ${seed}`).toBeLessThan(0.3);
      expect(s.ball.owner).toBe(C);
    }
  });

  it('a standing shielder still holds a challenger walking into him off the ball', () => {
    const s = scene(1);
    const c0 = s.players[C]!.x;
    // P2 walks into the shielder's back; P1 stands with the shield held.
    runTicks(s, 120, (_t, _st, out) => { out[0]!.buttons |= Btn.SHIELD; out[1]!.mx = -40; }, { check: 'core' });
    expect(Math.abs(s.players[C]!.x - c0)).toBeLessThan(0.3);
    expect(s.ball.owner).toBe(C);
  });
});
