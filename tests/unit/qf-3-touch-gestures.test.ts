/**
 * QF-3 FIX-06 / QA-25: every row of the section 9 pitch-gesture table end to end through the real touch source
 * (gesture recogniser -> mapper conversion: gSlot, gFlags, gdx/gdz, gPower, gCurve) and the real sim (SIM-15
 * resolveGesture and the kickers). Each test is named after its row. Gestures start on the right half of the screen
 * (outside the stick zone and the cluster), as section 9 requires.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { ClusterMode, ClusterSlot } from '../../src/contracts/touch';
import { NULL_SINK } from '../../src/sim/core/events';
import { keeperPickUp } from '../../src/sim/keeper/handling';
import { makeScenario } from '../harness/scenario';
import { centreOn, createTouchRig, scr, type TouchRig } from './qf-3-touch-rig';

/** Everyone parked far away except the actors; CPU brains off. */
function park(s: SimState, keep: number[]): void {
  for (let i = 0; i < 22; i++) {
    if (keep.includes(i)) continue;
    const p = s.players[i]!;
    const team = i < 11 ? 0 : 1;
    if (i % 11 === 0) { p.x = team === 0 ? -50 : 50; p.z = 0; continue; }
    p.x = team === 0 ? -40 : 40; p.z = -30 + (i % 11) * 5.5;
  }
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
}

/** P1 controls #9 with the ball at (x, z); teammate #10 at (mx, mz). */
function attack(x = 10, z = 0, mx = 25, mz = -8): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }],
    players: [{ slot: 9, x, z, fx: 1, fz: 0 }, { slot: 10, x: mx, z: mz }],
    ball: { owner: 9, x: x + 0.4, y: 0.11, z, lastTouchTeam: 0, lastTouch: 9 },
  });
  park(s, [9, 10]);
  return s;
}

/** P1 controls #4 at (dx, dz); the away #18 carries the ball at (cx, cz). */
function defence(dx = -24, dz = 2, cx = -20, cz = 0): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 4 }],
    players: [{ slot: 4, x: dx, z: dz }, { slot: 18, x: cx, z: cz, fx: -1, fz: 0 }, { slot: 5, x: -15, z: 12 }],
    ball: { owner: 18, lastTouchTeam: 1, lastTouch: 18, x: cx - 0.4, y: 0.11, z: cz },
  });
  park(s, [4, 18, 5, 0]);
  s.players[0]!.x = -50; s.players[0]!.z = 0;
  return s;
}

function tap(r: TouchRig, x: number, y: number): void {
  r.down(30, x, y); r.wait(50); r.up(30, x, y);
}
function doubleTap(r: TouchRig, x: number, y: number): void {
  tap(r, x, y); r.wait(80); tap(r, x + 2, y + 2);
}
function swipe(r: TouchRig, pts: [number, number][], ms: number): void {
  r.down(31, pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) { r.wait(ms / (pts.length - 1)); r.move(31, pts[i]![0], pts[i]![1]); }
  r.up(31, pts.at(-1)![0], pts.at(-1)![1]);
}
/** Straight swipe as 8 points. */
const line = (x0: number, y0: number, x1: number, y1: number, bend = 0): [number, number][] =>
  Array.from({ length: 9 }, (_, i) => {
    const k = i / 8, dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy), off = bend * 4 * k * (1 - k);
    return [x0 + dx * k + (-dy / len) * off, y0 + dy * k + (dx / len) * off] as [number, number];
  });

/** Tick until `slot` starts an action (other than SHIELD); returns act / kick, or NONE. */
function untilAct(r: TouchRig, slot: number, n = 40): { act: ActionKind; kind: KickKind; target: number } {
  for (let i = 0; i < n; i++) {
    r.tick();
    const p = r.s.players[slot]!;
    if (p.act !== ActionKind.NONE && p.act !== ActionKind.SHIELD) return { act: p.act, kind: p.actKick, target: p.actSlot };
  }
  return { act: ActionKind.NONE, kind: KickKind.NONE, target: -1 };
}

describe('QF-3 section 9 pitch gestures end to end', () => {
  it('Tap a teammate: ground pass to feet', () => {
    const r = createTouchRig(attack());
    r.tick(2);
    const m = r.s.players[10]!, p = scr(m.x, m.z);
    tap(r, p.x, p.y - 5);
    const a = untilAct(r, 9);
    expect(a.kind).toBe(KickKind.GROUND_PASS);
    expect(a.target).toBe(10);
  });

  it('Tap the space in front of a teammate: through ball into that space', () => {
    const r = createTouchRig(attack());
    r.tick(2);
    const m = r.s.players[10]!, p = scr(m.x + 7, m.z);
    tap(r, p.x, p.y);
    expect(untilAct(r, 9).kind).toBe(KickKind.THROUGH_GROUND);
  });

  it('Double-tap a teammate: the lobbed version', () => {
    const r = createTouchRig(attack());
    r.tick(2);
    const m = r.s.players[10]!, p = scr(m.x, m.z);
    doubleTap(r, p.x, p.y - 5);
    expect([KickKind.LOB_PASS, KickKind.DINKED_PASS]).toContain(untilAct(r, 9).kind);
  });

  it('In the crossing zone, double-tap toward a post: cross', () => {
    const r = createTouchRig(attack(42, 26, 45, 2));
    centreOn(42, 15);
    r.tick(2);
    const p = scr(48.5, -3.66);
    doubleTap(r, p.x, p.y);
    expect([KickKind.CROSS, KickKind.LOW_CROSS, KickKind.GROUND_CROSS]).toContain(untilAct(r, 9).kind);
  });

  it('Swipe toward goal: shot; a faster swipe is harder', () => {
    const powers: number[] = [];
    for (const ms of [300, 90]) {
      const r = createTouchRig(attack(30, 0));
      centreOn(30, 0);
      r.tick(2);
      swipe(r, line(700, 420, 900, 400), ms);
      const a = untilAct(r, 9);
      expect(a.act).toBe(ActionKind.SHOT);
      expect(a.kind).toBe(KickKind.SHOT_NORMAL);
      powers.push(r.s.players[9]!.actPower);
    }
    expect(powers[1]!).toBeGreaterThan(powers[0]!);
  });

  it('Curved swipe toward goal: finesse shot', () => {
    const r = createTouchRig(attack(30, 0));
    centreOn(30, 0);
    r.tick(2);
    swipe(r, line(700, 420, 900, 400, 50), 160);
    expect(untilAct(r, 9).kind).toBe(KickKind.SHOT_FINESSE);
  });

  it('Tap on the goal: chip shot', () => {
    const r = createTouchRig(attack(30, 0));
    centreOn(30, 0);
    r.tick(2);
    const g = scr(52.5, 0);
    tap(r, g.x - 3, g.y - 8);
    expect(untilAct(r, 9).kind).toBe(KickKind.SHOT_CHIP);
  });

  it('Quick back-and-forth swipe toward goal: power shot', () => {
    const r = createTouchRig(attack(30, 0));
    centreOn(30, 0);
    r.tick(2);
    swipe(r, [[800, 410], [760, 410], [720, 410], [770, 410], [830, 410], [890, 410], [940, 410]], 180);
    expect(untilAct(r, 9).kind).toBe(KickKind.SHOT_POWER);
  });

  it('Swipe in your own half with the ball: clearance', () => {
    const r = createTouchRig(attack(-35, 0));
    centreOn(-30, 0);
    r.tick(2);
    swipe(r, line(700, 420, 950, 380), 120);
    expect(untilAct(r, 9).kind).toBe(KickKind.CLEARANCE);
  });

  it('Tap the opposing ball carrier: press him', () => {
    const r = createTouchRig(defence(-24, 2, -20, 0));
    centreOn(-30, 0);
    r.tick(2);
    const c = r.s.players[18]!, p = scr(c.x, c.z);
    tap(r, p.x, p.y - 5);
    r.tick(30);
    // The controlled player closes him down.
    const d = r.s.players[4]!, q = r.s.players[18]!;
    expect(Math.hypot(d.x - q.x, d.z - q.z)).toBeLessThan(Math.hypot(-24 + 20, 2));
  });

  it('Swipe in your own half without the ball: slide tackle', () => {
    const r = createTouchRig(defence(-21.5, 1.2, -20, 0));
    centreOn(-30, 0);
    r.tick(2);
    swipe(r, line(700, 420, 900, 380), 120);
    expect(untilAct(r, 4).act).toBe(ActionKind.SLIDE_TACKLE);
  });

  it('Double-tap the pitch when defending: second defender', () => {
    const r = createTouchRig(defence());
    centreOn(-30, 0);
    r.tick(2);
    doubleTap(r, 800, 600);
    r.tick(25);
    expect(r.s.ctrl[0]!.secondDef).toBeGreaterThanOrEqual(0);
  });

  it('Tap your keeper when defending: keeper rushes out', () => {
    const r = createTouchRig(defence(-30, 2, -38, 0));
    centreOn(-56, 0);
    r.tick(2);
    const k = r.s.players[0]!, p = scr(k.x, k.z);
    expect(p.x).toBeGreaterThan(590);
    tap(r, p.x, p.y - 5);
    expect(untilAct(r, 0, 40).act).toBe(ActionKind.GK_RUSH);
  });

  it('Tap a teammate when defending: switch to him', () => {
    const r = createTouchRig(defence());
    centreOn(-30, 0);
    r.tick(2);
    const m = r.s.players[5]!, p = scr(m.x, m.z);
    expect(p.x).toBeGreaterThan(590);
    tap(r, p.x, p.y - 5);
    r.tick(25);
    expect(r.s.ctrl[0]!.slot).toBe(5);
  });
});

describe('QF-3 section 9 keeper row by touch (keeper holding the ball)', () => {
  function keeper(): SimState {
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 0 }],
      players: [{ slot: 0, x: -47, z: 0, fx: 1, fz: 0 }, { slot: 5, x: -30, z: 8 }],
      ball: { owner: 0, x: -46.6, y: 0.11, z: 0, lastTouchTeam: 1, lastTouch: 15 },
    });
    park(s, [0, 5]);
    keeperPickUp(s, 0, NULL_SINK); // GKP-05: into his hands (a ball last touched by an opponent: no back-pass)
    expect(s.ball.heldBy).toBe(0);
    return s;
  }
  for (const [label, slot, act, kinds] of [
    ['PASS throws', ClusterSlot.LOW, ActionKind.GK_THROW, [KickKind.GK_THROW, KickKind.GK_ROLL]],
    ['THROUGH is a driven throw', ClusterSlot.MID, ActionKind.GK_THROW, [KickKind.GK_DRIVEN_THROW]],
    ['SHOOT is a drop kick', ClusterSlot.HIGH, ActionKind.GK_KICK, [KickKind.GK_DROP_KICK]],
  ] as const) {
    it(`Keeper with the ball: ${label}`, () => {
      const r = createTouchRig(keeper());
      r.tick(2);
      expect(r.st.mode).toBe(ClusterMode.KEEPER);
      const p = r.slot(slot);
      r.down(2, p.x, p.y); r.wait(60); r.up(2, p.x, p.y);
      let got: { act: ActionKind; kind: KickKind } | null = null;
      for (let i = 0; i < 60 && !got; i++) {
        r.tick();
        const k = r.s.players[0]!;
        if (k.act === ActionKind.GK_THROW || k.act === ActionKind.GK_KICK) got = { act: k.act, kind: k.actKick };
      }
      expect(got?.act).toBe(act);
      expect(kinds).toContain(got!.kind);
    });
  }
  it('Keeper with the ball: SPRINT & SKILL drops the ball at his feet', () => {
    const r = createTouchRig(keeper());
    r.tick(2);
    const p = r.slot(ClusterSlot.BIG);
    r.down(2, p.x, p.y); r.wait(60); r.up(2, p.x, p.y);
    r.tick(20);
    expect(r.s.ball.heldBy).toBe(-1);
    expect(r.s.ball.owner).toBe(0);
  });
});
