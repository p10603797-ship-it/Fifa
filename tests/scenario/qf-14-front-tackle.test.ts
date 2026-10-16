/**
 * [QF-14] SIM-14 success model: a front standing tackle at a ball at the carrier's feet. With baseChance 0.5 an
 * equal-rated (75 v 75) challenge from in front, the ball within reach, won about 30% of the time (22% of all tackles
 * in Professional soak matches), and every lost one with the carrier's body in the zone was a foul: the CPU's patient
 * defender (qf-14-escort) holding a dribbler up had little to gain from the challenge it waits for. baseChance 0.7 (and
 * attrWeight 0.8: the attributes decide more of it): about half of them now, still well short of a sure thing, and an
 * exposed ball (a heavy touch, a turn) is won more often than a ball at his feet.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, MatchPhase } from '../../src/contracts/enums';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { LOCAL_TUNING as TK, winChance } from '../../src/sim/defend/tackle';
import { makeScenario } from '../harness/scenario';

const T = 15; // tackler, team 1
const V = 9; // carrier, team 0

/** Carrier at the origin facing +x with the ball `ballAhead` m in front; the tackler `gap` m in front of him. */
function scene(gap: number, ballAhead: number, tackle: number, resistAttr: number): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 3 });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    p.x = -45 + (i % 2) * 3; p.z = -30 + i * 2.8; p.vx = 0; p.vz = 0;
    p.act = ActionKind.NONE; p.moveMode = MoveMode.STOP; p.shielding = 0;
  }
  const v = s.players[V]!;
  v.x = 0; v.z = 0; v.fx = 1; v.fz = 0;
  const t = s.players[T]!;
  t.x = gap; t.z = 0; t.fx = -1; t.fz = 0;
  const a = s.attrs[T]!;
  a.standingTackle = tackle;
  const r = s.attrs[V]!;
  r.dribbling = resistAttr; r.ballControl = resistAttr; r.strength = resistAttr;
  const b = s.ball;
  b.x = ballAhead; b.z = 0; b.y = 0.11; b.vx = 0; b.vz = 0; b.owner = V; b.ownerT = 120; b.heldBy = -1;
  return s;
}

describe('QF-14 SIM-14: a front standing tackle at a close ball is a fair contest', () => {
  it('the base chance and attribute weight are the QF-14 ones', () => {
    expect(TK.baseChance).toBeGreaterThanOrEqual(0.65);
    expect(TK.attrWeight).toBeGreaterThanOrEqual(0.7);
  });

  it('an equal-rated front tackle at the ball at his feet wins about half the time (was about 30%)', () => {
    const s = scene(1.0, 0.3, 75, 75);
    const c = winChance(s, T, ActionKind.STAND_TACKLE, V, 0.7);
    expect(c).toBeGreaterThan(0.42);
    expect(c).toBeLessThan(0.6);
  });

  it('timing still matters: an exposed ball is won more often than a ball at his feet', () => {
    const tight = winChance(scene(1.4, 0.3, 75, 75), T, ActionKind.STAND_TACKLE, V, 1.1);
    const exposed = winChance(scene(1.4, 1.0, 75, 75), T, ActionKind.STAND_TACKLE, V, 0.4);
    expect(exposed).toBeGreaterThan(tight + 0.1);
  });

  it('attributes decide more of it: a 90 tackler against a 40 dribbler v a 40 tackler against a 90 dribbler', () => {
    const good = winChance(scene(1.0, 0.3, 90, 40), T, ActionKind.STAND_TACKLE, V, 0.7);
    const bad = winChance(scene(1.0, 0.3, 40, 90), T, ActionKind.STAND_TACKLE, V, 0.7);
    // 0.55 x (0.9 - 0.4) x 2 = 0.55 apart before the edge penalty with attrWeight 0.55; 0.8 now.
    expect(good - bad).toBeGreaterThan(0.6);
  });
});
