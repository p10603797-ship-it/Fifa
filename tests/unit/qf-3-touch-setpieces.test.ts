/**
 * QF-3 QA-26: touch set pieces end to end (section 9 "Set pieces on touch"): the real touch source (pointer manager,
 * controls, mapper; qf-3-touch-rig) feeding the real sim, one test per restart and touch method, with aim, power and
 * curl checked where the brief gives them. Includes the FIX-06 regression (taps on the stick's half of the screen at
 * set pieces were swallowed by the floating stick) and the QA-29 regression (penalty taps waited out the double-tap
 * window).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { ClusterMode, ClusterSlot, TouchButtonId } from '../../src/contracts/touch';
import type { SimState } from '../../src/contracts/state';
import { NULL_SINK } from '../../src/sim/core/events';
import { awardRestart } from '../../src/sim/rules/restart';
import { makeScenario } from '../harness/scenario';
import { centreOn, createTouchRig, scr, type TouchRig } from './qf-3-touch-rig';

interface Kick { slot: number; act: ActionKind; kind: KickKind; power: number; curve: number; dirX: number; dirZ: number }

/** P1 on `side`; `kind` awarded to `team` at (x, z); ticks until the restart is ready; camera on the ball. */
function restart(kind: RestartKind, team: number, x: number, z: number, side = 0, period = 1): TouchRig {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side }], ball: { owner: -1, x, z, y: 0.11 }, match: { period },
  });
  if (period === 2) { s.teams[0]!.dir = -1; s.teams[1]!.dir = 1; }
  awardRestart(s, kind, team, x, z, NULL_SINK);
  const r = createTouchRig(s, { side });
  for (let i = 0; i < 400 && s.match.restart.ready !== 1; i++) r.tick();
  expect(s.match.restart.ready).toBe(1);
  centreOn(s.ball.x, s.ball.z);
  r.tick();
  return r;
}

/** Tick until the restart is taken (a kick started by anyone); returns the kick or null. */
function untilTaken(r: TouchRig, n = 90): Kick | null {
  const s = r.s;
  for (let i = 0; i < n; i++) {
    r.tick();
    for (let k = 0; k < 22; k++) {
      const p = s.players[k]!;
      if (p.actKick !== KickKind.NONE && p.act !== ActionKind.NONE && p.act !== ActionKind.SET_PIECE && p.act !== ActionKind.THROW_IN) {
        return { slot: k, act: p.act, kind: p.actKick, power: p.actPower, curve: p.actCurve, dirX: p.actDirX, dirZ: p.actDirZ };
      }
    }
  }
  return null;
}

/** Tick until the throw-in is taken; returns the ball's ground velocity just after the release, or null. */
function untilThrown(r: TouchRig, n = 120): { x: number; z: number } | null {
  for (let i = 0; i < n; i++) {
    r.tick();
    const b = r.s.ball;
    if (r.s.match.restart.taken === 1 && b.owner < 0 && b.heldBy < 0 && b.vx * b.vx + b.vz * b.vz > 1) return { x: b.vx, z: b.vz };
  }
  return null;
}

function tapAt(r: TouchRig, x: number, y: number, ms = 60): void {
  r.down(7, x, y); r.wait(ms); r.up(7, x, y);
}

function swipe(r: TouchRig, x0: number, y0: number, x1: number, y1: number, ms: number, bend = 0): void {
  r.down(8, x0, y0);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    r.wait(ms / steps);
    const k = i / steps;
    // bend: sideways offset (px) of a circular-ish arc, perpendicular to the chord.
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    const off = bend * 4 * k * (1 - k);
    r.move(8, x0 + dx * k + (-dy / len) * off, y0 + dy * k + (dx / len) * off);
  }
  r.up(8, x1, y1);
}

/** Nearest outfield teammate of the taker (not the taker). */
function nearestMate(s: SimState): number {
  const r = s.match.restart;
  const first = r.team === 0 ? 0 : 11;
  let best = -1, bd = Infinity;
  for (let k = first + 1; k < first + 11; k++) {
    if (k === r.taker) continue;
    const q = s.players[k]!;
    const d = (q.x - s.ball.x) ** 2 + (q.z - s.ball.z) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

describe('QF-3 QA-26 touch set pieces, one per restart and method', () => {
  it('kick-off: PASS', () => {
    const s = makeScenario({ humans: [{ side: 0 }] });
    const r = createTouchRig(s);
    for (let i = 0; i < 2000 && !(s.match.phase === MatchPhase.KICK_OFF && s.match.restart.ready === 1); i++) r.tick();
    expect(r.st.mode).toBe(ClusterMode.SET_PIECE);
    const p = r.slot(ClusterSlot.LOW);
    tapAt(r, p.x, p.y);
    const k = untilTaken(r);
    expect(k?.kind).toBe(KickKind.KICK_OFF);
    r.tick(30);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });

  it('FIX-06: with Gestures Only the kick-off is still taken by touch (PASS shows at set pieces, hides in play)', () => {
    const s = makeScenario({ humans: [{ side: 0 }] });
    const r = createTouchRig(s, { settings: { gesturesOnly: true } });
    for (let i = 0; i < 2000 && !(s.match.phase === MatchPhase.KICK_OFF && s.match.restart.ready === 1); i++) r.tick();
    expect(r.src.cluster.attack.live(TouchButtonId.PASS)).toBe(true);
    const p = r.slot(ClusterSlot.LOW);
    tapAt(r, p.x, p.y);
    const k = untilTaken(r);
    expect(k?.kind).toBe(KickKind.KICK_OFF);
    r.tick(30);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(r.st.mode).not.toBe(ClusterMode.SET_PIECE);
    expect(r.src.cluster.attack.live(TouchButtonId.PASS)).toBe(false);
    expect(r.src.cluster.attack.live(TouchButtonId.SHOOT)).toBe(false);
  });

  it('throw-in: PASS throws short; tap a teammate throws to him', () => {
    let r = restart(RestartKind.THROW_IN, 0, 10, 34);
    let p = r.slot(ClusterSlot.LOW);
    tapAt(r, p.x, p.y);
    expect(untilTaken(r)).not.toBeNull();
    expect(r.s.match.restart.taken).toBe(1);

    r = restart(RestartKind.THROW_IN, 0, 10, 34);
    const mate = nearestMate(r.s);
    const q = r.s.players[mate]!;
    p = scr(q.x, q.z);
    tapAt(r, p.x, p.y - 4);
    const v = untilThrown(r);
    expect(v).not.toBeNull();
    // Thrown toward the tapped teammate.
    const tx = q.x - r.s.match.restart.x, tz = q.z - r.s.match.restart.z;
    expect((v!.x * tx + v!.z * tz) / Math.hypot(tx, tz) / Math.hypot(v!.x, v!.z)).toBeGreaterThan(0.8);
  });

  it('FIX-06: a set-piece tap on the stick half of the screen is a pitch tap (goal kick to a teammate on the left)', () => {
    // Second half: home attacks -x, so a home goal kick is taken at +x and every teammate is on the left half.
    const r = restart(RestartKind.GOAL_KICK, 0, 47, 0, 0, 2);
    const s = r.s;
    expect(r.st.mode).toBe(ClusterMode.SET_PIECE);
    // A teammate on screen, on the stick's (left) half.
    let mate = -1;
    for (let k = 1; k < 11 && mate < 0; k++) {
      const o = scr(s.players[k]!.x, s.players[k]!.z);
      if (o.x > 60 && o.x < 540 && o.y > 60 && o.y < 760) mate = k;
    }
    expect(mate).toBeGreaterThan(0);
    const q = s.players[mate]!;
    const p = scr(q.x, q.z);
    tapAt(r, p.x, p.y - 4);
    const k = untilTaken(r);
    expect(k, 'goal kick taken by the tap').not.toBeNull();
    const tx = q.x - s.match.restart.x, tz = q.z - s.match.restart.z;
    expect((k!.dirX * tx + k!.dirZ * tz) / Math.hypot(tx, tz)).toBeGreaterThan(0.8);
  });

  it('a stick-zone tap in open play stays a stick tap (no pass to whoever is under the thumb)', () => {
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }], players: [{ slot: 9, x: 10, z: 0 }],
      ball: { owner: 9, x: 10.4, y: 0.11, z: 0, lastTouchTeam: 0 },
    });
    const r = createTouchRig(s);
    r.tick(2);
    const q = s.players[7]!;
    const p = scr(q.x, q.z);
    expect(p.x).toBeLessThan(590);
    tapAt(r, p.x, p.y);
    r.tick(30);
    expect(r.frames.every((f) => f.gesture === 0)).toBe(true);
    expect(s.players[9]!.act).toBe(ActionKind.NONE);
  });

  it('goal kick: PASS plays it', () => {
    const r = restart(RestartKind.GOAL_KICK, 0, -47, 0);
    const p = r.slot(ClusterSlot.LOW);
    tapAt(r, p.x, p.y);
    expect(untilTaken(r)).not.toBeNull();
  });

  it('corner: swipe from the ball into the box crosses there; a faster swipe goes higher', () => {
    const kinds: KickKind[] = [];
    const powers: number[] = [];
    for (const ms of [500, 110]) {
      const r = restart(RestartKind.CORNER, 0, 52.5, 34);
      const b = scr(r.s.ball.x, r.s.ball.z);
      const t = scr(46, 2);
      swipe(r, b.x, b.y, t.x, t.y, ms);
      const k = untilTaken(r);
      expect(k, `swipe ${ms} ms`).not.toBeNull();
      kinds.push(k!.kind);
      powers.push(k!.power);
      // Toward the box (up the screen = -z, a little -x).
      expect(k!.dirZ).toBeLessThan(-0.5);
    }
    expect(powers[1]!).toBeGreaterThan(powers[0]!);
    expect([KickKind.GROUND_CROSS, KickKind.LOW_CROSS, KickKind.CROSS]).toContain(kinds[0]);
    expect(kinds[1]).toBe(KickKind.CROSS);
  });

  it('corner: a curved swipe adds curl the way it bends; a straight one none', () => {
    const curls: number[] = [];
    for (const bend of [0, 60, -60]) {
      const r = restart(RestartKind.CORNER, 0, 52.5, 34);
      const b = scr(r.s.ball.x, r.s.ball.z);
      const t = scr(46, 2);
      swipe(r, b.x, b.y, t.x, t.y, 160, bend);
      const k = untilTaken(r);
      expect(k, `bend ${bend}`).not.toBeNull();
      curls.push(k!.curve);
    }
    expect(Math.abs(curls[0]!)).toBeLessThan(0.2);
    expect(Math.sign(curls[1]!)).toBe(-Math.sign(curls[2]!));
    expect(Math.abs(curls[1]!)).toBeGreaterThan(0.2);
  });

  it('corner: tap a spot in the box (stick half) crosses to it; PASS plays it short', () => {
    let r = restart(RestartKind.CORNER, 0, 52.5, 34);
    const t = scr(46, 0);
    expect(t.x).toBeLessThan(590);
    tapAt(r, t.x, t.y);
    let k = untilTaken(r);
    expect(k?.kind).toBe(KickKind.CROSS);

    r = restart(RestartKind.CORNER, 0, 52.5, 34);
    const p = r.slot(ClusterSlot.LOW);
    tapAt(r, p.x, p.y);
    k = untilTaken(r);
    expect([KickKind.GROUND_PASS, KickKind.DRIVEN_PASS]).toContain(k?.kind);
  });

  it('free kick at goal: swipe from the ball toward goal shoots; speed sets power; the preview shows while dragging', () => {
    const powers: number[] = [];
    for (const ms of [400, 120]) {
      const r = restart(RestartKind.FREE_KICK, 0, 30, 5);
      const b = scr(r.s.ball.x, r.s.ball.z);
      const t = scr(52.5, 1);
      r.down(8, b.x, b.y);
      r.drag(8, b.x, b.y, t.x, t.y, ms, 8);
      expect(r.st.previewCount, 'dotted preview while dragging').toBeGreaterThan(1);
      r.up(8, t.x, t.y);
      expect(r.st.previewCount).toBe(0);
      const k = untilTaken(r);
      expect(k?.act).toBe(ActionKind.SHOT);
      expect(k!.dirX).toBeGreaterThan(0.8);
      powers.push(k!.power);
    }
    expect(powers[1]!).toBeGreaterThan(powers[0]!);
  });

  it('wide free kick: tap a teammate passes to him', () => {
    const r = restart(RestartKind.FREE_KICK, 0, -10, 25);
    const mate = nearestMate(r.s);
    const q = r.s.players[mate]!;
    const p = scr(q.x, q.z);
    tapAt(r, p.x, p.y - 4);
    const k = untilTaken(r);
    expect(k).not.toBeNull();
    const tx = q.x - r.s.match.restart.x, tz = q.z - r.s.match.restart.z;
    expect((k!.dirX * tx + k!.dirZ * tz) / Math.hypot(tx, tz)).toBeGreaterThan(0.7);
  });

  it('penalty: swipe toward a corner shoots that way; a curved swipe is a finesse shot', () => {
    let r = restart(RestartKind.PENALTY, 0, 41.5, 0);
    let b = scr(r.s.ball.x, r.s.ball.z);
    let t = scr(52.5, -3);
    swipe(r, b.x, b.y, t.x, t.y, 120);
    let k = untilTaken(r);
    expect(k?.kind).toBe(KickKind.PENALTY);
    expect(k!.dirZ).toBeLessThan(0);

    r = restart(RestartKind.PENALTY, 0, 41.5, 0);
    b = scr(r.s.ball.x, r.s.ball.z);
    t = scr(52.5, 3);
    swipe(r, b.x, b.y, t.x, t.y, 160, 70);
    k = untilTaken(r);
    expect(k?.kind).toBe(KickKind.SHOT_FINESSE);
  });

  it('penalty keeper: a tap on either side of the keeper picks that dive side; a swipe too', () => {
    const cases: [string, (r: TouchRig) => void, number][] = [
      ['tap -z', (r) => { const kp = r.s.players[11]!; const p = scr(kp.x, kp.z - 3); tapAt(r, p.x, p.y); }, -1],
      ['tap +z', (r) => { const kp = r.s.players[11]!; const p = scr(kp.x - 2, kp.z + 3); tapAt(r, p.x, p.y); }, 1],
      ['swipe +z', (r) => swipe(r, 900, 300, 900, 450, 90), 1],
    ];
    for (const [label, act, side] of cases) {
      const r = restart(RestartKind.PENALTY, 0, 41.5, 0, 1);
      expect(r.s.ctrl[0]!.slot).toBe(r.s.teams[1]!.keeperSlot);
      act(r);
      r.tick(2);
      expect(r.s.match.restart.side, label).toBe(side);
    }
  });

  it('QA-29: a penalty keeper tap reaches the sim on the tick of its lift (no double-tap holdback)', () => {
    const r = restart(RestartKind.PENALTY, 0, 41.5, 0, 1);
    const kp = r.s.players[11]!;
    const p = scr(kp.x, kp.z - 3);
    const before = r.frames.length;
    r.down(7, p.x, p.y); r.wait(50); r.up(7, p.x, p.y);
    r.tick(1);
    const g = r.frames.slice(before).findIndex((f) => f.gesture !== 0);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(r.frames.length - before - 1 - g).toBeLessThanOrEqual(1);
    expect(r.s.match.restart.side).toBe(-1);
  });
});
