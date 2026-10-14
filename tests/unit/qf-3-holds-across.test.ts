/**
 * QF-3 QA-23 (second pass): touch presses that are still down (or still in flight) when the sim context changes.
 * Section 9: "The right-hand cluster swaps the moment possession changes. A thumb already down keeps its old meaning
 * until it lifts." The sim reads HELD buttons by its context tick by tick, so before the fix:
 *  - THROUGH held for a through ball's power when the ball was stolen rushed OUR KEEPER off his line (THROUGH held in
 *    defence = keeper rush), PASS held contained, R1 held from a driven combo called the second defender;
 *  - a SHOOT touch that lifted (as a tap) after the ball was stolen was a standing tackle;
 *  - 2ND DEF held when we won the ball kept R1 down: a controlled sprint, and the next PASS tap a driven pass;
 *  - a SPRINT & TACKLE tap lifted after we won the ball was a SHOOT press = a shot.
 * All through the real touch source, mapper and sim (qf-3-touch-rig).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { Btn, type InputFrame } from '../../src/contracts/input';
import { ClusterSlot } from '../../src/contracts/touch';
import { T_INPUT } from '../../src/contracts/tuning';
import { endAction } from '../../src/sim/actions/dispatch';
import { takePossession } from '../../src/sim/core/kick';
import { createEventBuffer } from '../../src/sim/core/events';
import { makeScenario } from '../harness/scenario';
import { createTouchRig, type TouchRig } from './qf-3-touch-rig';

const P = 9;
const OPP = 19;
const D = 4;
const KEEPER = 0;
const TACKLES = [ActionKind.STAND_TACKLE, ActionKind.HARD_TACKLE, ActionKind.SLIDE_TACKLE, ActionKind.SHOULDER, ActionKind.PUSH_PULL];

/** P1 (home, attacking +x) controls #9 with the ball at (10, 0); away #19 stands right in front of him. CPU off. */
function attackRig(): TouchRig {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY,
    humans: [{ side: 0, slot: P }],
    players: [{ slot: P, x: 10, z: 0, fx: 1, fz: 0 }, { slot: OPP, x: 11.5, z: 0.5, fx: -1, fz: 0 }],
    ball: { owner: P, x: 10.4, y: 0.11, z: 0, lastTouchTeam: 0, lastTouch: P },
  });
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
  return createTouchRig(s);
}

/** P1 controls #4 goal-side of the away carrier #19 (who has the ball) at (-22.6, 0). CPU off. */
function defenceRig(): TouchRig {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY,
    humans: [{ side: 0, slot: D }],
    players: [{ slot: D, x: -24.5, z: 0, fx: 1, fz: 0 }, { slot: OPP, x: -22.6, z: 0, fx: -1, fz: 0 }],
    ball: { owner: OPP, x: -23.1, y: 0.11, z: 0, lastTouchTeam: 1, lastTouch: OPP },
  });
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
  return createTouchRig(s);
}

/** Give the ball to `to` at his feet (a tackle / interception): whatever `from` was doing is interrupted. */
function giveBall(r: TouchRig, from: number, to: number): void {
  const s = r.s;
  if (s.players[from]!.act !== ActionKind.NONE) endAction(s, from, 1);
  const q = s.players[to]!;
  s.ball.x = q.x + q.fx * 0.4; s.ball.z = q.z; s.ball.y = 0.11; s.ball.vx = 0; s.ball.vy = 0; s.ball.vz = 0;
  s.ball.passTarget = -1; s.ball.shotBy = -1;
  takePossession(s, to, createEventBuffer());
}

type Gesture = 'tap' | 'hold' | 'swipe-up' | 'swipe-down' | 'swipe-left' | 'swipe-right';
const GESTURES: Gesture[] = ['tap', 'hold', 'swipe-up', 'swipe-down', 'swipe-left', 'swipe-right'];

/**
 * Press `slot` with `g`; `change` happens while the finger is down (a tap: after its touch-down, before its lift;
 * a hold / swipe: once it is classified and holding). Returns the index of the first frame sampled after the change.
 */
function pressAcross(r: TouchRig, slot: ClusterSlot, g: Gesture, change: () => void, early = false): number {
  const p = r.slot(slot);
  r.down(2, p.x, p.y);
  if (g === 'tap') {
    r.wait(50);
    change();
    const at = r.frames.length;
    r.wait(50);
    r.up(2, p.x, p.y);
    return at;
  }
  if (g === 'hold') {
    r.wait(early ? 60 : 400);
    change();
    const at = r.frames.length;
    r.wait(400);
    r.up(2, p.x, p.y);
    return at;
  }
  const d = g === 'swipe-up' ? [0, -1] : g === 'swipe-down' ? [0, 1] : g === 'swipe-left' ? [-1, 0] : [1, 0];
  r.wait(17); r.move(2, p.x + d[0]! * 15, p.y + d[1]! * 15);
  r.wait(17); r.move(2, p.x + d[0]! * 40, p.y + d[1]! * 40);
  r.wait(early ? 17 : 200);
  change();
  const at = r.frames.length;
  r.wait(300);
  r.up(2, p.x + d[0]! * 40, p.y + d[1]! * 40);
  return at;
}

/** Press edges of `bit` in frames[from..] (the previous frame lacks it). */
function edges(frames: readonly InputFrame[], from: number, bit: number): number {
  let k = 0;
  for (let i = Math.max(1, from); i < frames.length; i++) {
    if ((frames[i]!.buttons & bit) !== 0 && (frames[i - 1]!.buttons & bit) === 0) k++;
  }
  return k;
}

/** Shortest run of consecutive frames holding `bit` that ENDS in frames[from..] (Infinity if none). */
function shortestRunEndingAfter(frames: readonly InputFrame[], from: number, bit: number): number {
  let best = Infinity;
  let run = 0;
  for (let i = 0; i < frames.length; i++) {
    if ((frames[i]!.buttons & bit) !== 0) run++;
    else {
      if (run > 0 && i >= from && run < best) best = run;
      run = 0;
    }
  }
  return best;
}

const ATTACK_SLOTS: [string, ClusterSlot][] = [['PASS', ClusterSlot.LOW], ['THROUGH', ClusterSlot.MID], ['SHOOT', ClusterSlot.HIGH]];

describe('QF-3 QA-23 attack presses still down when the ball is stolen keep their old meaning', () => {
  for (const [name, slot] of ATTACK_SLOTS) {
    for (const g of GESTURES) {
      it(`${name} ${g} across a stolen ball: no keeper rush, no contain, no second defender, no tackle`, () => {
        const r = attackRig();
        r.tick(2);
        let rushed = false, tackled = false, secondDef = false;
        const at = pressAcross(r, slot, g, () => giveBall(r, P, OPP));
        for (let i = 0; i < 40; i++) {
          r.tick();
          if (r.s.players[KEEPER]!.act === ActionKind.GK_RUSH) rushed = true;
          if (TACKLES.includes(r.s.players[P]!.act)) tackled = true;
          if (r.s.ctrl[0]!.secondDef >= 0) secondDef = true;
        }
        expect(r.s.ball.owner).toBe(OPP);
        expect(rushed, 'keeper rushed out').toBe(false);
        expect(tackled, 'tackle').toBe(false);
        expect(secondDef, 'second defender').toBe(false);
        for (let i = at; i < r.frames.length; i++) {
          expect(r.frames[i]!.buttons & (Btn.PASS | Btn.THROUGH | Btn.MOD_R), `frame ${i - at} after the steal`).toBe(0);
        }
        expect(edges(r.frames, at, Btn.SHOOT), 'SHOOT press after the steal').toBe(0);
      });
    }
  }

  it('THROUGH held for power when the ball is stolen never rushes our keeper out (before: GK_RUSH on the next tick)', () => {
    const r = attackRig();
    r.tick(2);
    const p = r.slot(ClusterSlot.MID);
    r.down(2, p.x, p.y);
    r.wait(400);
    expect(r.frames.at(-1)!.buttons & Btn.THROUGH).toBe(Btn.THROUGH);
    giveBall(r, P, OPP);
    r.tick(30);
    expect(r.s.players[KEEPER]!.act).not.toBe(ActionKind.GK_RUSH);
    expect(r.st.power).toBe(0);
    r.up(2, p.x, p.y);
    r.tick(3);
    expect(r.frames.at(-1)!.buttons).toBe(0);
  });

  it('a press made in defence keeps its meaning: THROUGH held from a 2ND DEF swipe down still rushes the keeper', () => {
    const r = defenceRig();
    r.tick(2);
    const p = r.slot(ClusterSlot.MID);
    r.down(2, p.x, p.y); r.wait(17); r.move(2, p.x, p.y + 15); r.wait(17); r.move(2, p.x, p.y + 40);
    let rushed = false;
    for (let i = 0; i < 10; i++) { r.tick(); if (r.s.players[KEEPER]!.act === ActionKind.GK_RUSH) rushed = true; }
    r.up(2, p.x, p.y + 40);
    expect(rushed).toBe(true);
  });

  it('a SHOOT hold across a stolen ball keeps SHOOT (same held meaning): a kick still charging keeps its power bar', () => {
    const r = attackRig();
    r.tick(2);
    const p = r.slot(ClusterSlot.HIGH);
    r.down(2, p.x, p.y);
    r.wait(400);
    giveBall(r, P, OPP);
    r.tick(5);
    expect(r.frames.at(-1)!.buttons & Btn.SHOOT).toBe(Btn.SHOOT);
    r.up(2, p.x, p.y);
    r.tick(2);
    expect(r.frames.at(-1)!.buttons).toBe(0);
  });
});

const DEFENCE_SLOTS: [string, ClusterSlot][] = [
  ['SWITCH', ClusterSlot.LOW], ['2ND DEF', ClusterSlot.MID], ['SLIDE', ClusterSlot.HIGH], ['SPRINT & TACKLE', ClusterSlot.BIG],
];

describe('QF-3 QA-23 defence presses still down when we win the ball keep their old meaning', () => {
  for (const [name, slot] of DEFENCE_SLOTS) {
    for (const g of GESTURES) {
      it(`${name} ${g} across a won ball: no shot or pass, no trigger run, no call for support, R1 / L1 never a tap`, () => {
        const r = defenceRig();
        r.tick(2);
        r.s.teams[0]!.runCallT = 0;
        r.s.teams[0]!.supportCallT = 0;
        let run = false, support = false, kicked = false;
        const at = pressAcross(r, slot, g, () => giveBall(r, OPP, D));
        for (let i = 0; i < 40; i++) {
          r.tick();
          const me = r.s.players[r.s.ctrl[0]!.slot]!;
          if (r.s.teams[0]!.runCallT > 0) run = true;
          if (r.s.teams[0]!.supportCallT > 0) support = true;
          if ((me.act === ActionKind.KICK || me.act === ActionKind.SHOT) && me.actKick !== KickKind.NONE) kicked = true;
        }
        expect(kicked, 'shot / pass').toBe(false);
        expect(run, 'trigger run').toBe(false);
        expect(support, 'call for support').toBe(false);
        for (const bit of [Btn.PASS, Btn.SHOOT, Btn.LOB, Btn.THROUGH]) expect(edges(r.frames, at, bit), `face ${bit} after the win`).toBe(0);
        // A modifier released in attack after a short hold is an L1 / R1 tap: every run that ends there is long.
        expect(shortestRunEndingAfter(r.frames, at, Btn.MOD_R)).toBeGreaterThanOrEqual(T_INPUT.tapTicks);
        // R1 never stays down in attack longer than its tap minimum (controlled sprint / driven combos).
        let tail = 0;
        for (let i = at; i < r.frames.length && (r.frames[i]!.buttons & Btn.MOD_R) !== 0; i++) tail++;
        expect(tail).toBeLessThanOrEqual(T_INPUT.tapTicks);
      });
    }
  }

  it('2ND DEF held while we win the ball: a PASS tap with another finger is a ground pass, never R1 + Cross = driven', () => {
    const r = defenceRig();
    r.tick(2);
    const sd = r.slot(ClusterSlot.MID);
    r.down(2, sd.x, sd.y);
    r.wait(400);
    expect(r.frames.at(-1)!.buttons & Btn.MOD_R).toBe(Btn.MOD_R);
    giveBall(r, OPP, D);
    r.tick(12); // the cluster is the attack set now; the thumb stays on the MID slot
    const pass = r.slot(ClusterSlot.LOW);
    r.down(3, pass.x, pass.y); r.wait(60); r.up(3, pass.x, pass.y);
    let kind = KickKind.NONE;
    for (let i = 0; i < 30 && kind === KickKind.NONE; i++) {
      r.tick();
      const me = r.s.players[D]!;
      if (me.act === ActionKind.KICK && me.actKick !== KickKind.NONE) kind = me.actKick;
    }
    r.up(2, sd.x, sd.y);
    expect(kind).toBe(KickKind.GROUND_PASS);
  });

  it('SPRINT & TACKLE held across a won ball keeps sprinting (R2 means sprint in both)', () => {
    const r = defenceRig();
    r.tick(2);
    const big = r.slot(ClusterSlot.BIG);
    r.down(2, big.x, big.y);
    r.wait(400);
    giveBall(r, OPP, D);
    r.tick(10);
    expect(r.frames.at(-1)!.buttons & Btn.SPRINT).toBe(Btn.SPRINT);
    r.up(2, big.x, big.y);
    r.tick(2);
    expect(r.frames.at(-1)!.buttons).toBe(0);
  });
});
