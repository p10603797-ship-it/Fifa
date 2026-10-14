/**
 * [QF-2] CR for QF-1 (src/sim/defend/tackle.ts interceptContacts / src/sim/players/firstTouch.ts receiveContacts):
 * a shot passes straight through the body of any outfield defender who is not the controlled player, the loose-ball
 * chaser or the pass target. interceptContacts only takes untouched PASSES (isFootPassKind), and receiveContacts'
 * candidates are only controlled players / keepers / the chaser / the pass target. So a second defender standing in
 * the shot's path is a ghost, while the controlled presser / chaser "receives" every shot passing within
 * T_TOUCH.receiveRadius (1.1 m) of him at any speed with no reaction time (over 10 Professional matches 40 of 76 CPU
 * shots had a man within 0.6 m of the line and every block came from the controlled presser; INT-A: "blockers rarely
 * block in the physics").
 * Proposed fix: let interceptContacts also take a fresh untouched shot (isShotKind): a path through an outfield
 * opponent's body (interceptBodyBlock x body radius) is a block on any tick for every defender, a reach entry rolls
 * interceptChance (its ball-speed factor already makes a 25 m/s shot hard to stop); and leave outfield opponents of a
 * fresh shot out of receiveContacts' candidates (as it already does for untouched low passes).
 * Marked it.fails until QF-1 lands it (then drop .fails).
 */
import { describe, expect, it } from 'vitest';
import { ControllerKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { makeScenario, runTicks } from '../harness/scenario';

/** A 25 m/s low shot along z = 0 past defender A (the loose-ball chaser, 2.5 m off the line) through B (x = 37). */
function shotThroughTwo(): { touched: number; a: number; b: number; bCtrl: number; bChaser: boolean } {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 3, humans: 0 });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    p.x = i < 11 ? -40 + i : -5 + (i - 11); p.z = -30 + i * 2.5; p.vx = 0; p.vz = 0;
  }
  s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
  for (const c of s.ctrl) { c.kind = ControllerKind.NONE; c.slot = -1; }
  for (const p of s.players) p.ctrl = -1;
  const k = s.players[11]!; k.x = 52; k.z = 0;
  s.players[9]!.x = 30; s.players[9]!.z = 0;
  const A = 14, B = 15;
  const ball = s.ball;
  ball.owner = -1; ball.heldBy = -1; ball.x = 30.6; ball.z = 0; ball.y = 0.3; ball.px = ball.x; ball.pz = 0; ball.py = 0.3;
  ball.vx = 25; ball.vz = 0; ball.vy = 1.2; ball.grounded = 0;
  ball.lastTouch = 9; ball.lastTouchTeam = 0; ball.lastTouchTick = s.tick; ball.lastKickBy = 9; ball.lastKickTeam = 0;
  ball.lastKickKind = KickKind.SHOT_NORMAL; ball.lastKickTick = s.tick; ball.shotBy = 9; ball.passTarget = -1;
  let touched = -1, bCtrl = -2, bChaser = false;
  runTicks(s, 20, (_t, st) => {
    const a = st.players[A]!, b = st.players[B]!;
    a.x = 33; a.z = 2.5; a.vx = 0; a.vz = 0; a.fx = -1; a.fz = 0;
    st.teams[1]!.chaser = A; st.teams[1]!.chaserT = 0; // TAI-07 keeps a fresh chaser for chaserMinTicks
    b.x = 37; b.z = 0.1; b.vx = 0; b.vz = 0; b.fx = -1; b.fz = 0;
  }, {
    until: (st) => {
      if (bCtrl === -2 && st.ball.x > 35) { bCtrl = st.players[B]!.ctrl; bChaser = st.teams[1]!.chaser === B; }
      if (st.ball.lastTouch !== 9 && touched < 0) touched = st.ball.lastTouch;
      return st.ball.x > 42;
    },
  });
  return { touched, a: A, b: B, bCtrl, bChaser };
}

describe('QF-2 CR (QF-1): shots and the bodies in their path', () => {
  it.fails('a shot fired straight through a defender who is neither controlled nor the chaser is stopped by his body', () => {
    const r = shotThroughTwo();
    expect(r.bCtrl).toBe(-1);
    expect(r.bChaser).toBe(false);
    expect(r.touched).toBe(r.b);
  });
});
