/**
 * Ball contact bookkeeping shared by every module that touches the ball. Lead-owned (FND-03 tests).
 * Always go through these helpers so lastTouch / possession / offside / back-pass data stay consistent.
 */
import { MatchPhase } from '../../contracts/enums';
import { KickKind } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import type { KickLaunch } from '../../contracts/systems';
import type { SimState } from '../../contracts/state';
import { T_KICK } from '../../contracts/tuning';
import { RESTART_PHASES } from '../../contracts/transitions';

/** Record a touch by `slot` (any contact). Clears a shot in flight when touched by someone else. */
export function recordTouch(s: SimState, slot: number): void {
  const b = s.ball;
  const p = s.players[slot]!;
  b.lastTouch = slot;
  b.lastTouchTeam = p.team;
  b.lastTouchTick = s.tick;
  b.touchedTick = s.tick;
  b.idleT = 0;
  p.lastTouchTick = s.tick;
  if (b.shotBy !== -1 && b.shotBy !== slot) b.shotBy = -1;
}

/** Give `slot` possession of the (nearby) ball. Emits POSSESSION when the possessing team changes. */
export function takePossession(s: SimState, slot: number, ev: EventSink): void {
  const b = s.ball;
  const prevTeam = b.owner >= 0 ? s.players[b.owner]!.team : b.lastTouchTeam;
  const team = s.players[slot]!.team;
  if (b.owner !== slot) b.ownerT = 0;
  b.owner = slot;
  recordTouch(s, slot);
  if (b.passTarget !== -1) b.passTarget = -1;
  if (prevTeam !== team) ev.emit(EventType.POSSESSION, team, slot);
}

/** Drop possession (ball becomes loose). */
export function releasePossession(s: SimState, ev: EventSink): void {
  const b = s.ball;
  if (b.owner === -1) return;
  b.owner = -1;
  b.ownerT = 0;
  if (b.heldBy !== -1) {
    ev.emit(EventType.KEEPER_HANDS, b.heldBy, 0);
    b.heldBy = -1;
  }
}

/**
 * Launch the ball from `slot`: sets velocity and spin, clears possession and hands, records the kick
 * (lastKick*), the pass target, shot info, and emits KICK (+ SHOT for shots). Marks restart.taken when the
 * restart taker plays the ball in a restart phase.
 */
export function applyKick(s: SimState, slot: number, l: KickLaunch, power: number, ev: EventSink): void {
  const b = s.ball;
  const p = s.players[slot]!;
  releasePossession(s, ev);
  recordTouch(s, slot);
  b.vx = l.vx; b.vy = l.vy; b.vz = l.vz;
  b.sx = l.sx; b.sy = l.sy; b.sz = l.sz;
  b.grounded = l.vy > T_KICK.liftVy ? 0 : b.grounded;
  b.bounces = 0;
  b.lastKickBy = slot;
  b.lastKickTeam = p.team;
  b.lastKickKind = l.kind;
  b.lastKickTick = s.tick;
  b.passTarget = l.target;
  b.passX = l.tx;
  b.passZ = l.tz;
  b.inNet = 0;
  ev.emit(EventType.KICK, slot, l.kind, power, 0, b.x, b.y, b.z);
  const shot = isShot(l.kind);
  if (shot) {
    b.shotBy = slot;
    b.shotTick = s.tick;
    b.shotOnTarget = l.onTarget;
    ev.emit(EventType.SHOT, slot, l.onTarget, 0);
  } else {
    b.shotBy = -1;
  }
  const m = s.match;
  if (RESTART_PHASES.includes(m.phase) && m.restart.taker === slot) m.restart.taken = 1;
  if (m.phase === MatchPhase.SHOOT_OUT && m.shootout.kicker === slot) m.restart.taken = 1;
}

function isShot(k: KickKind): boolean {
  return (k >= KickKind.SHOT_NORMAL && k <= KickKind.SHOT_LOW_DRIVEN) || k === KickKind.SHOT_TRIVELA || k === KickKind.HEADER_SHOT ||
    k === KickKind.VOLLEY_SHOT || k === KickKind.PENALTY || k === KickKind.FREE_KICK_SHOT;
}

/** True if the contact system already resolved a ball contact this tick. */
export function ballTouchedThisTick(s: SimState): boolean {
  return s.ball.touchedTick === s.tick;
}
