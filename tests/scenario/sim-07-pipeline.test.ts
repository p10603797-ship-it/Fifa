/**
 * [SIM-07] First touch through the real tick pipeline (step): a pass reaches a human receiver who holds the stick,
 * the trap settles the ball ahead of him in that direction and he keeps it; a lobbed ball is chested down to his
 * feet; PASS_COMPLETE is emitted exactly once per pass.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { T_DRIBBLE, T_TOUCH } from '../../src/contracts/tuning';
import { TouchOutcome } from '../../src/sim/players/firstTouch';
import { findEvents, runTicks } from '../harness/scenario';
import { baseState, control, incoming, PASSER, RECV } from '../unit/sim-07-helpers';

function setup(seed: number) {
  const s = baseState(seed);
  s.match.phase = MatchPhase.IN_PLAY;
  control(s, RECV);
  s.attrs[RECV]!.ballControl = 80;
  return s;
}

describe('SIM-07 pipeline', () => {
  it('a pass to a human receiver holding the stick: clean trap toward the stick, kept, PASS_COMPLETE once', () => {
    const s = setup(11);
    incoming(s, RECV, { speed: 9, dist: 2.5 });
    s.ball.lastKickTick = s.tick; s.ball.lastTouchTick = s.tick; s.ball.touchedTick = s.tick;
    let trapTick = -1;
    let rel = { dx: 0, dz: 0, owner: -1 };
    const ev = runTicks(s, 60, (_t, _st, out) => {
      out[0]!.mz = 127; // stick down = +z
    }, {
      check: 'core',
      until: (st) => {
        const p = st.players[RECV]!;
        if (trapTick < 0 && p.act === ActionKind.FIRST_TOUCH) {
          trapTick = st.tick;
          expect(p.actA).toBe(TouchOutcome.CLEAN);
          expect(p.actDirZ).toBeGreaterThan(0.9);
        }
        if (trapTick > 0 && st.tick === trapTick + T_TOUCH.firstTouchTicks) {
          rel = { dx: st.ball.x - p.x, dz: st.ball.z - p.z, owner: st.ball.owner };
        }
        return false;
      },
    });
    expect(trapTick).toBeGreaterThan(0);
    const pc = findEvents(ev, EventType.PASS_COMPLETE);
    expect(pc).toHaveLength(1);
    expect(pc[0]!.a).toBe(RECV);
    expect(pc[0]!.b).toBe(PASSER);
    expect(findEvents(ev, EventType.KICK, (e) => e.b === KickKind.FIRST_TOUCH)).toHaveLength(1);
    // End of the window: the ball sits ahead of him toward the stick, within reach, and he still has it.
    expect(rel.owner).toBe(RECV);
    expect(rel.dz).toBeGreaterThan(0.2);
    expect(Math.abs(rel.dx)).toBeLessThan(0.8);
    expect(Math.hypot(rel.dx, rel.dz)).toBeLessThan(T_DRIBBLE.loseRadius);
    expect(s.ball.owner).toBe(RECV);
  });

  it('aerial chest trap: a dropping ball is cushioned to his feet and kept', () => {
    const s = setup(12);
    incoming(s, RECV, { speed: 6, y: 1.45, vy: -2.5, dist: 0.55 });
    let trapped = 0;
    let down = -1;
    runTicks(s, 60, undefined, {
      check: 'core',
      until: (st) => {
        const p = st.players[RECV]!;
        if (trapped === 0 && p.act === ActionKind.FIRST_TOUCH) {
          trapped = 1;
          expect(p.actCurve).toBeGreaterThan(T_DRIBBLE.controlHeight);
          expect(p.actA).toBe(TouchOutcome.CLEAN);
        }
        if (trapped === 1 && down < 0 && st.ball.y <= T_DRIBBLE.controlHeight && st.ball.vy <= 0) down = st.tick;
        return false;
      },
    });
    expect(trapped).toBe(1);
    expect(down).toBeGreaterThan(0);
    expect(s.ball.owner).toBe(RECV);
    const p = s.players[RECV]!;
    expect(Math.hypot(s.ball.x - p.x, s.ball.z - p.z)).toBeLessThan(T_DRIBBLE.loseRadius);
    expect(s.ball.y).toBeLessThanOrEqual(T_DRIBBLE.controlHeight);
  });

  it('a pass that stops short and is walked onto is still completed once (slow pick-up)', () => {
    const s = setup(13);
    // A soft ball dying just in front of him: below the first-touch speed when it arrives.
    incoming(s, RECV, { speed: 2.4, dist: 1.6 });
    s.ball.lastKickTick = s.tick - 50; s.ball.lastTouchTick = s.ball.lastKickTick; s.ball.touchedTick = s.ball.lastKickTick;
    const ev = runTicks(s, 90, undefined, { check: 'core' });
    expect(findEvents(ev, EventType.PASS_COMPLETE)).toHaveLength(1);
    expect(findEvents(ev, EventType.PASS_COMPLETE)[0]!.a).toBe(RECV);
    expect(s.ball.owner).toBe(RECV);
  });
});
