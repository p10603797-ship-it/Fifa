/**
 * [QF-16 third attempt] SIM-06: a ball under an opponent's feet. An opponent could take the owner's ball only between
 * touches, while it was out of the owner's reach (controlRadius 0.9 m + lookahead). A human walking the ball into a CPU
 * defender standing in front of him pushed it under the defender (0.03-0.2 m from his centre, the walker 0.75 m away)
 * and kept it there, walking him back into his six-yard box (QF-16 qf-16-box-walker). Now, while the owner walks or
 * jogs (slower than underMaxSpeed; QF-16 skeptic: 3 -> 6 m/s, a human jogging at full stick pushed a defender along
 * with the ball under his feet), a ball within underRadius of the nearest eligible opponent and nearer to him than to the
 * owner by underMargin is his to steal (slow relative to him) or block, even inside the owner's reach. A sprint
 * dribble keeps its touches (stealing under every dribbler cut 1.6 shots a match from the bot game); a shielding owner
 * still holds the challenger off (shieldBlocks). Only when the owner or the opponent is human-controlled: bot-v-bot
 * possession is unchanged.
 */
import '../../src/sim/actions/dispatch';
import { describe, expect, it } from 'vitest';
import { ActionKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { LOCAL_TUNING as POSS, dribbleTick } from '../../src/sim/players/possession';
import { makeScenario } from '../harness/scenario';

const C = 9; // owner (team 0) at the origin, walking +x
const D = 15; // opponent (team 1) standing 0.65 m ahead

function scene(ballX = 0.6, ownerSpeed = 1.2, humanOwner = true): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 4 });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    p.x = -40 + (i % 11) * 3; p.z = i < 11 ? -30 : 30; p.vx = 0; p.vz = 0;
    p.act = ActionKind.NONE; p.moveMode = MoveMode.STOP; p.noTouchT = 0; p.stunT = 0;
  }
  const c = s.players[C]!, d = s.players[D]!;
  c.x = 0; c.z = 0; c.fx = 1; c.fz = 0; c.vx = ownerSpeed; c.moveMode = MoveMode.DIRECT; c.ix = 0.4; c.iz = 0; c.touchCd = 5;
  d.x = 0.65; d.z = 0.02; d.fx = -1; d.fz = 0;
  c.ctrl = humanOwner ? 0 : -1; d.ctrl = -1;
  const b = s.ball;
  b.x = ballX; b.z = 0; b.y = 0.11; b.vx = ownerSpeed; b.vz = 0; b.vy = 0; b.grounded = 1;
  b.owner = C; b.heldBy = -1; b.lastTouch = C; b.lastTouchTeam = 0; b.touchedTick = -1;
  return s;
}

describe('QF-16 SIM-06: the ball under an opponent\'s feet is his', () => {
  it('reads its tuning', () => {
    expect(POSS.underRadius).toBeGreaterThan(0.1);
    expect(POSS.underRadius).toBeLessThan(0.5);
    expect(POSS.underMargin).toBeGreaterThan(0);
    // A jog (T_PLAYER: at most 9.6 x 0.6 = 5.76 m/s) is under it; a sprint dribble is not.
    expect(POSS.underMaxSpeed).toBeGreaterThan(5.76);
    expect(POSS.underMaxSpeed).toBeLessThan(7);
  });

  it('glitch: ball stuck between two players — a walker\'s ball under a standing defender\'s feet is taken by the defender', () => {
    const s = scene();
    const ev = createEventBuffer();
    dribbleTick(s, ev);
    // Before: inside the walker's reach (0.6 m < 0.9 m), so he kept it (the defender standing on it).
    expect(s.ball.owner).toBe(D);
    let poss = 0;
    for (let i = 0; i < ev.count; i++) if (ev.get(i).type === EventType.POSSESSION && ev.get(i).a === 1) poss++;
    expect(poss).toBe(1);
    expect(s.players[C]!.noTouchT).toBeGreaterThan(0);
  });

  it('a CPU walker\'s ball under a human defender\'s feet is his too; bot v bot the owner keeps it', () => {
    const h = scene(0.6, 1.2, false);
    h.players[D]!.ctrl = 1;
    dribbleTick(h, createEventBuffer());
    expect(h.ball.owner).toBe(D);
    const b = scene(0.6, 1.2, false);
    dribbleTick(b, createEventBuffer());
    expect(b.ball.owner).toBe(C);
  });

  it('a sprinting dribbler (faster than underMaxSpeed) keeps his touches', () => {
    const s = scene(0.6, 7);
    dribbleTick(s, createEventBuffer());
    expect(s.ball.owner).toBe(C);
  });

  // [QF-16 skeptic] underMaxSpeed 3 -> 6 m/s (a jog; the rule is human-only, so the bot game is unchanged).
  it('glitch: ball stuck between two players — a human jogging the ball into a defender (pushing him along at 4.7 m/s, the ball under his feet) loses it', () => {
    // Before: a human jogging diagonally at full stick pushed a Legend / Professional defender in front of him along at
    // 4-5 m/s for 4 s, the ball 0.2-0.3 m from the defender's centre, and kept it (owner faster than 3 m/s).
    const s = scene(0.6, 4.7);
    s.players[D]!.vx = 4.7;
    dribbleTick(s, createEventBuffer());
    expect(s.ball.owner).toBe(D);
  });

  it('not under him (no nearer to him than to the owner by underMargin, or beyond underRadius): the owner keeps it', () => {
    const s = scene(0.35);
    s.players[D]!.x = 0.6; // ball 0.35 from the owner, 0.25 from the defender
    dribbleTick(s, createEventBuffer());
    expect(s.ball.owner).toBe(C);
    const t = scene(0.45);
    t.players[D]!.x = 0.85; // 0.4 m from the defender: beyond underRadius
    dribbleTick(t, createEventBuffer());
    expect(t.ball.owner).toBe(C);
  });

  it('a defender in a tackle or down is not eligible (his own contacts resolve it)', () => {
    const s = scene();
    s.players[D]!.act = ActionKind.STUMBLE;
    dribbleTick(s, createEventBuffer());
    expect(s.ball.owner).toBe(C);
  });
});
