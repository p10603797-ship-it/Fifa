/**
 * QF-3 FIX-06: the touch stick strafe (section 9 "Double-tap and hold the stick for a face-up (strafe) dribble") sends
 * MOD_L, which the sim also reads as L1. Regression tests through the real controls, mapper and sim (qf-3-touch-rig):
 *  - a PASS / SHOOT / THROUGH tap while strafing kept MOD_L held, so the sim resolved L1 + Cross = pass and go,
 *    L1 + Circle = chip shot, L1 + Triangle = lobbed through ball;
 *  - a strafe released soon after its MOD_L began sent an L1 tap = "trigger a run";
 *  - a strafe on a loose ball pressed MOD_L where SIM-16 reads it as "change player".
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
import { ReqFlag } from '../../src/contracts/systems';
import { ClusterSlot } from '../../src/contracts/touch';
import { T_INPUT } from '../../src/contracts/tuning';
import { makeScenario } from '../harness/scenario';
import { createTouchRig, type TouchRig } from './qf-3-touch-rig';

const P = 9;

/** P1 (home, attacking +x) controls #9 with the ball at his feet at (10, 0); the CPU brains are off. */
function attack(): TouchRig {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY,
    humans: [{ side: 0, slot: P }],
    players: [{ slot: P, x: 10, z: 0, fx: 1, fz: 0 }],
    ball: { owner: P, x: 10.4, y: 0.11, z: 0, lastTouchTeam: 0, lastTouch: P },
  });
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
  return createTouchRig(s);
}

/** Double tap and hold the stick at (300, 500), then push it up (screen) and hold for holdMs. */
function strafe(r: TouchRig, holdMs: number): void {
  r.down(1, 300, 500); r.wait(40); r.up(1, 300, 500); r.wait(60);
  r.down(1, 300, 500);
  r.drag(1, 300, 500, 300, 440, 60, 3);
  r.wait(holdMs);
}

function tapSlot(r: TouchRig, slot: ClusterSlot, id = 2, ms = 60): void {
  const p = r.slot(slot);
  r.down(id, p.x, p.y); r.wait(ms); r.up(id, p.x, p.y);
}

/** Tick until the controlled player starts a kick (or n ticks); returns him. */
function untilKick(r: TouchRig, n = 30): { act: ActionKind; kind: KickKind; flags: number } {
  for (let i = 0; i < n; i++) {
    r.tick();
    const p = r.s.players[P]!;
    if (p.act !== ActionKind.NONE && p.actKick !== KickKind.NONE) return { act: p.act, kind: p.actKick, flags: p.actA };
  }
  return { act: ActionKind.NONE, kind: KickKind.NONE, flags: 0 };
}

/** Lengths of the runs of consecutive frames with MOD_L. */
function modLRuns(r: TouchRig, from = 0): number[] {
  const runs: number[] = [];
  let k = 0;
  for (let i = from; i < r.frames.length; i++) {
    if ((r.frames[i]!.buttons & Btn.MOD_L) !== 0) k++;
    else if (k > 0) { runs.push(k); k = 0; }
  }
  if (k > 0) runs.push(k);
  return runs;
}

describe('QF-3 FIX-06 touch strafe vs L1 combos', () => {
  it('strafe sends MOD_L with the stick (the face-up dribble still works)', () => {
    const r = attack();
    r.tick(2);
    strafe(r, 400);
    const f = r.frames.at(-1)!;
    expect(r.st.stickStrafe).toBe(true);
    expect(f.buttons & Btn.MOD_L).toBe(Btn.MOD_L);
    expect(f.mz).toBeLessThan(0);
  });

  it('a PASS tap while strafing is a ground pass, never pass and go (L1 + Cross)', () => {
    const r = attack();
    r.tick(2);
    strafe(r, 400);
    const from = r.frames.length;
    tapSlot(r, ClusterSlot.LOW);
    const k = untilKick(r);
    expect(k.kind).toBe(KickKind.GROUND_PASS);
    expect(k.flags & ReqFlag.PASS_AND_GO).toBe(0);
    // The frame that presses PASS carries no MOD_L, and the strafe sends none again while the stick stays down.
    const press = r.frames.findIndex((f, i) => i >= from && (f.buttons & Btn.PASS) !== 0);
    expect(press).toBeGreaterThan(0);
    expect(r.frames[press]!.buttons & Btn.MOD_L).toBe(0);
    r.tick(20);
    expect(r.frames.slice(press).every((f) => (f.buttons & Btn.MOD_L) === 0)).toBe(true);
  });

  it('a SHOOT tap while strafing is a normal shot, never a chip (L1 + Circle)', () => {
    const r = attack();
    r.tick(2);
    strafe(r, 400);
    tapSlot(r, ClusterSlot.HIGH);
    const k = untilKick(r);
    expect(k.kind).toBe(KickKind.SHOT_NORMAL);
  });

  it('a THROUGH tap while strafing is a ground through ball, never lobbed (L1 + Triangle)', () => {
    const r = attack();
    r.tick(2);
    strafe(r, 400);
    tapSlot(r, ClusterSlot.MID);
    const k = untilKick(r);
    expect(k.kind).toBe(KickKind.THROUGH_GROUND);
  });

  it('a PASS swipe down while strafing is still pass and go (the cell carries its own L1)', () => {
    const r = attack();
    r.tick(2);
    strafe(r, 400);
    const p = r.slot(ClusterSlot.LOW);
    r.down(2, p.x, p.y); r.wait(17); r.move(2, p.x, p.y + 15); r.wait(17); r.move(2, p.x, p.y + 40); r.wait(17); r.up(2, p.x, p.y + 40);
    const k = untilKick(r);
    expect(k.kind).toBe(KickKind.GROUND_PASS);
    expect(k.flags & ReqFlag.PASS_AND_GO).toBe(ReqFlag.PASS_AND_GO);
  });

  it('a strafe released right after its MOD_L began holds MOD_L for a full tap time: never an L1 tap (trigger run)', () => {
    for (let extra = 0; extra < T_INPUT.tapTicks + 2; extra++) {
      const r = attack();
      r.tick(2);
      const from = r.frames.length;
      r.s.teams[0]!.runCallT = 0;
      // Double tap and hold just past the strafe delay, then lift.
      strafe(r, (T_INPUT.tapTicks + 1 + extra) * (1000 / 60) - 60);
      r.up(1, 300, 440);
      let runs = 0;
      for (let i = 0; i < 30; i++) {
        r.tick();
        if (r.s.teams[0]!.runCallT > 0) runs++;
      }
      for (const len of modLRuns(r, from)) expect(len, `extra ${extra}`).toBeGreaterThanOrEqual(T_INPUT.tapTicks);
      expect(runs, `extra ${extra}: trigger run`).toBe(0);
    }
  });

  it('no strafe MOD_L on a loose ball (SIM-16 would read it as change player)', () => {
    const r = attack();
    r.tick(2);
    // Knock the ball loose ahead of #9 (nobody owns it, no pass target).
    const b = r.s.ball;
    b.owner = -1; b.passTarget = -1; b.x = 12; b.vx = 1; b.lastTouchTeam = 1;
    strafe(r, 300);
    expect(r.s.ctrl[0]!.slot).toBe(P);
    expect(r.frames.every((f) => (f.buttons & Btn.MOD_L) === 0)).toBe(true);
  });
});

describe('QF-3 FIX-06 THROUGH swipe down (L1 tap) on a loose ball', () => {
  function swipeDownThrough(r: TouchRig): void {
    const p = r.slot(ClusterSlot.MID);
    r.down(2, p.x, p.y); r.wait(17); r.move(2, p.x, p.y + 15); r.wait(17); r.move(2, p.x, p.y + 40); r.wait(17); r.up(2, p.x, p.y + 40);
  }

  it('with our ball it triggers a run', () => {
    const r = attack();
    r.tick(2);
    r.s.teams[0]!.runCallT = 0;
    swipeDownThrough(r);
    let run = false;
    for (let i = 0; i < 10; i++) { r.tick(); if (r.s.teams[0]!.runCallT > 0) run = true; }
    expect(run).toBe(true);
  });

  it('on a loose ball coming to him (ATTACK cluster) it does nothing: never a switch away from him', () => {
    const r = attack();
    r.tick(1);
    const b = r.s.ball;
    b.owner = -1; b.passTarget = -1; b.lastTouchTeam = 1; b.x = 6; b.vx = 3;
    r.tick(1);
    expect(r.st.mode).toBe(0); // ClusterMode.ATTACK: the ball is arriving at him
    const from = r.frames.length;
    swipeDownThrough(r);
    r.tick(6);
    expect(r.s.ctrl[0]!.slot).toBe(P);
    expect(r.frames.slice(from).every((f) => (f.buttons & Btn.MOD_L) === 0)).toBe(true);
  });
});
