/**
 * [QF-16 third attempt] SIM-05 brace. Two players overlapping are separated by priority, then by mass; a ball carrier
 * walking the ball into an opponent therefore pushed him back at about half his walking speed every tick, so a human
 * walked a World Class / Legend defender standing in his path back 10 m in 10 s, into the six-yard box (QF-16
 * qf-16-box-walker). Now a walking carrier (intended speed below braceMaxSpeed) driving into an opponent who stands his
 * ground (on his feet, his intent giving way slower than braceGiveSpeed along the contact normal) is the one held off.
 * A running dribbler's barge stays a body duel (bracing against every carrier cut 1.6 shots a match from the bot game),
 * and so does a man who gives way. Intents, not velocities: the contact's normal damping hands the pushed man the
 * pusher's speed, so a velocity test never saw him standing. Only in a pair with a human-controlled player (the human
 * walker, or a human defender a CPU walker runs into): bot-v-bot contact is unchanged (bracing bot walkers took the
 * ladder's Legend v World Class 74 -> 63% over 100).
 */
import '../../src/sim/actions/dispatch';
import { describe, expect, it } from 'vitest';
import { ActionKind, MatchPhase } from '../../src/contracts/enums';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { LOCAL_TUNING as BODY, bodyContactTick } from '../../src/sim/players/bodies';
import { maxSpeed } from '../../src/sim/players/locomotion';
import { makeScenario } from '../harness/scenario';

const C = 9; // carrier (team 0), at the origin, the ball 0.45 m ahead
const D = 15; // opponent (team 1), overlapping him 0.6 m ahead

/** The carrier is human-controlled (controller 0) unless `human` says otherwise (-1: bot v bot; 'D': the defender). */
function scene(owner = C, human: 'C' | 'D' | 'none' = 'C'): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 3 });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    p.x = -40 + (i % 11) * 3; p.z = i < 11 ? -30 : 30; p.vx = 0; p.vz = 0;
    p.act = ActionKind.NONE; p.moveMode = MoveMode.STOP; p.ix = 0; p.iz = 0;
  }
  const c = s.players[C]!, d = s.players[D]!;
  c.x = 0; c.z = 0; c.fx = 1; c.fz = 0; c.vx = 1.2; c.moveMode = MoveMode.DIRECT; c.ix = 0.4; c.iz = 0;
  d.x = 0.6; d.z = 0; d.fx = -1; d.fz = 0;
  s.attrs[C]!.strength = 70; s.attrs[D]!.strength = 70;
  c.ctrl = human === 'C' ? 0 : -1; d.ctrl = human === 'D' ? 1 : -1;
  const b = s.ball;
  b.x = 0.45; b.z = 0; b.y = 0.11; b.vx = 1.2; b.vz = 0; b.vy = 0; b.grounded = 1;
  b.owner = owner; b.heldBy = -1; b.lastTouch = owner; b.lastTouchTeam = owner >= 0 ? s.players[owner]!.team : 0;
  return s;
}

/** One SIM-05 pass; returns how far each was moved along x. */
function push(s: SimState): { c: number; d: number } {
  const c0 = s.players[C]!.x, d0 = s.players[D]!.x;
  bodyContactTick(s, createEventBuffer());
  return { c: s.players[C]!.x - c0, d: s.players[D]!.x - d0 };
}

describe('QF-16 SIM-05 brace: a walking carrier does not push a man standing his ground', () => {
  it('reads its tuning', () => {
    expect(BODY.braceDriveSpeed).toBeGreaterThan(0);
    expect(BODY.braceGiveSpeed).toBeGreaterThan(0);
    expect(BODY.braceMaxSpeed).toBeGreaterThan(2);
    expect(BODY.braceMaxSpeed).toBeLessThan(4);
  });

  it('glitch: defender jockeys a dribbler for ever — the walking carrier is held off, the standing defender is not moved', () => {
    const s = scene();
    expect(maxSpeed(s, C, false) * 0.4).toBeLessThan(BODY.braceMaxSpeed);
    const m = push(s);
    // Before: the overlap split by mass, the defender pushed 0.04 m this tick (half), every tick he was walked into.
    expect(Math.abs(m.d)).toBeLessThan(1e-9);
    expect(m.c).toBeLessThan(-0.02);
  });

  it('a running dribbler (intended speed above braceMaxSpeed) is still a body duel', () => {
    const s = scene();
    const c = s.players[C]!;
    c.ix = 1; c.wantSprint = 1; c.vx = 5;
    expect(maxSpeed(s, C, true)).toBeGreaterThan(BODY.braceMaxSpeed);
    const m = push(s);
    expect(m.d).toBeGreaterThan(0.02);
    expect(m.c).toBeLessThan(-0.02);
  });

  it('a man who gives way (his intent backing off faster than braceGiveSpeed) is pushed as before', () => {
    const s = scene();
    const d = s.players[D]!;
    d.moveMode = MoveMode.DIRECT; d.ix = 0.6; d.iz = 0; // backing off toward +x at 0.6 x jog
    expect(maxSpeed(s, D, false) * 0.6).toBeGreaterThan(BODY.braceGiveSpeed);
    const m = push(s);
    expect(m.d).toBeGreaterThan(0.02);
  });

  it('a CPU walker into a human defender standing his ground is held off too; bot v bot the split is unchanged', () => {
    const h = scene(C, 'D');
    expect(Math.abs(push(h).d)).toBeLessThan(1e-9);
    const b = scene(C, 'none');
    expect(push(b).d).toBeGreaterThan(0.02);
  });

  it('without the ball, or with a man down, the split is unchanged', () => {
    const s = scene(-1);
    expect(push(s).d).toBeGreaterThan(0.02);
    const t = scene();
    t.players[D]!.act = ActionKind.STUMBLE;
    expect(push(t).d).toBeGreaterThan(0.02);
  });
});
