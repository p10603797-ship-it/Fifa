/**
 * [GKP-03] Unit tests for the come-out brain (keeperComeOut decisions), startKeeperRush, the GK_RUSH / GK_PUNCH
 * handlers (collect, clear, smother, claim cancel, always ending) and the narrowing geometry, on crafted states.
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, HALF_LENGTH } from '../../src/contracts/constants';
import { ActionKind, ChallengeKind, ControllerKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { MoveMode } from '../../src/contracts/state';
import { T_GK } from '../../src/contracts/tuning';
import { actionsTick, beginAction } from '../../src/sim/actions/dispatch';
import { keeperTick } from '../../src/sim/keeper';
import { createEventBuffer, type EventBufferImpl } from '../../src/sim/core/events';
import {
  LOCAL_TUNING as L, RushMode, RushPhase, keeperCatchLimit, keeperClaimTop, keeperComeOut, keeperRushHeld,
  narrowingSpot, punchHandler, rushHandler, startKeeperRush,
} from '../../src/sim/keeper/sweeper';
import { ENDS, scene, type Scene } from '../scenario/gkp-03-helpers';

function events(e: EventBufferImpl): SimEvent[] {
  const r: SimEvent[] = [];
  for (let i = 0; i < e.count; i++) r.push({ ...e.get(i) });
  return r;
}

/** Run the come-out brain once (fresh tick). */
function brain(sc: Scene): SimEvent[] {
  const ev = createEventBuffer();
  sc.s.tick++;
  ev.begin(sc.s.tick);
  keeperComeOut(sc.s, sc.team, ev);
  return events(ev);
}

/** The whole keeper pipeline once (GKP-02 save decision first, as in sim/keeper/index.ts). */
function keeperPipeline(sc: Scene): void {
  const ev = createEventBuffer();
  sc.s.tick++;
  ev.begin(sc.s.tick);
  keeperTick(sc.s, sc.team, ev);
}

/** One dispatcher tick (actT++, handler update, end at actDur) for every acting player. */
function act(sc: Scene, ev: EventBufferImpl = createEventBuffer()): SimEvent[] {
  sc.s.tick++;
  ev.begin(sc.s.tick);
  actionsTick(sc.s, ev);
  return events(ev);
}

function keeper(sc: Scene) { return sc.s.players[sc.keeper]!; }

/** Put the keeper in GK_RUSH (mode, RUN phase) as startKeeperRush / the brain would. */
function rush(sc: Scene, mode: number): void {
  const p = keeper(sc);
  beginAction(p, ActionKind.GK_RUSH, L.rushMaxTicks, -1);
  p.actA = mode; p.actB = RushPhase.RUN; p.actPower = 0; p.actSlot = -1; p.actKick = KickKind.NONE;
}

describe('GKP-03 narrowing geometry', () => {
  it('stands on the goal-centre -> ball line, out early, never too close to the ball or too far out', () => {
    for (const dir of [1, -1]) {
      for (const [bu, bz] of [[18, 0], [12, 4], [8, -6], [4, 1], [2, 0.5], [30, 10]] as const) {
        const out = { x: 0, z: 0 };
        const bx = dir * (bu - HALF_LENGTH);
        narrowingSpot(dir, bx, bz, out);
        const gx = -dir * HALF_LENGTH;
        const d = Math.hypot(bx - gx, bz);
        const r = Math.hypot(out.x - gx, out.z);
        // On the line (cross product ~ 0) and between the goal and the ball.
        expect(Math.abs((out.x - gx) * bz - out.z * (bx - gx))).toBeLessThan(1e-6 * d * d + 1e-9);
        expect(r).toBeLessThanOrEqual(d);
        const u = dir * out.x + HALF_LENGTH;
        expect(u).toBeGreaterThanOrEqual(L.minDepth - 1e-9);
        expect(u).toBeLessThanOrEqual(L.narrowMaxDepth + 1e-9);
        if (d - L.narrowGapMin >= L.minDepth) expect(d - r).toBeGreaterThanOrEqual(L.narrowGapMin - 1e-9);
      }
    }
  });

  it('holds his ground as the attacker comes closer (backs off far less than the attacker advances)', () => {
    const at = (bu: number): number => {
      const o = { x: 0, z: 0 };
      narrowingSpot(1, bu - HALF_LENGTH, 0, o);
      return o.x + HALF_LENGTH;
    };
    expect(at(18) - at(8)).toBeLessThan(3);
    expect(at(12)).toBeGreaterThan(4);
    expect(at(18)).toBeGreaterThan(at(12));
  });
});

describe('GKP-03 come-out brain decisions', () => {
  it('starts an AI rush for a loose ball he reaches first inside the zone (all ends)', () => {
    for (const e of ENDS) {
      const sc = scene({ team: e.team, swap: e.swap });
      sc.loose(9, 2, -3, 0);
      brain(sc);
      expect(keeper(sc).act, e.name).toBe(ActionKind.GK_RUSH);
      expect(keeper(sc).actA).toBe(RushMode.AI_BALL);
      expect(keeper(sc).actB).toBe(RushPhase.RUN);
    }
  });

  it('never fights a defender: no rush when a defender gets there first or about as soon', () => {
    const sc = scene();
    sc.loose(9, 2, -3, 0);
    sc.place(sc.mate(3), 8, 2.5);
    brain(sc);
    expect(keeper(sc).act).toBe(ActionKind.NONE);
    // A defender only slightly slower than the keeper still keeps it (start margin).
    const sc2 = scene();
    sc2.loose(9, 2, -3, 0);
    sc2.place(sc2.mate(3), 13, 2);
    brain(sc2);
    expect(keeper(sc2).act).toBe(ActionKind.NONE);
  });

  it('aborts an AI rush when a defender will be there first (keep thresholds), at once', () => {
    const sc = scene();
    sc.loose(9, 2, -3, 0);
    brain(sc);
    expect(keeper(sc).act).toBe(ActionKind.GK_RUSH);
    sc.place(sc.mate(3), 8.5, 2.2);
    brain(sc);
    expect(keeper(sc).act).toBe(ActionKind.NONE);
  });

  it('leaves our own pass to its receiver (incl. a back-pass to him)', () => {
    for (const target of [3, 0]) {
      const sc = scene();
      sc.loose(9, 2, -3, 0, { by: sc.mate(6), target: target === 0 ? sc.keeper : sc.mate(target), kind: KickKind.GROUND_PASS });
      brain(sc);
      expect(keeper(sc).act).toBe(ActionKind.NONE);
    }
  });

  it('does nothing outside IN_PLAY, for a busy or stunned keeper, or a human-controlled keeper', () => {
    const cases: ((sc: Scene) => void)[] = [
      (sc) => { sc.s.match.phase = MatchPhase.THROW_IN; },
      (sc) => { beginAction(keeper(sc), ActionKind.GK_CATCH, 30, -1); },
      (sc) => { keeper(sc).stunT = 10; },
      (sc) => {
        const c = sc.s.ctrl[0]!;
        c.kind = ControllerKind.HUMAN; c.side = sc.team; c.slot = sc.keeper; keeper(sc).ctrl = 0;
      },
    ];
    for (const apply of cases) {
      const sc = scene();
      sc.loose(9, 2, -3, 0);
      apply(sc);
      const before = keeper(sc).act;
      brain(sc);
      expect(keeper(sc).act).toBe(before);
    }
  });

  it('ignores loose balls whose interception is outside the come-out zone', () => {
    const sc = scene();
    sc.loose(T_GK.rushDistance + 6, 2, 0, 0); // resting at the edge of the D
    brain(sc);
    expect(keeper(sc).act).toBe(ActionKind.NONE);
    const wide = scene();
    wide.loose(12, 27, 0, 0);
    brain(wide);
    expect(keeper(wide).act).toBe(ActionKind.NONE);
  });

  it('starts a one-on-one against an unmarked carrier in the box; not when covered, at a tight angle or retreating', () => {
    const base = (): Scene => {
      const sc = scene();
      sc.place(20, 15, 2, -5, 0);
      sc.owned(20, -0.8, 0, -5, 0);
      return sc;
    };
    const ok = base();
    brain(ok);
    expect(keeper(ok).act).toBe(ActionKind.GK_RUSH);
    expect(keeper(ok).actA).toBe(RushMode.AI_ONE_ON_ONE);
    expect(keeper(ok).actSlot).toBe(20);
    // A defender engaging him.
    const engaged = base();
    engaged.place(engaged.mate(4), 14, 3.5);
    brain(engaged);
    expect(keeper(engaged).act).toBe(ActionKind.NONE);
    // A defender goal-side in the channel.
    const goalSide = base();
    goalSide.place(goalSide.mate(4), 8, 1.2);
    brain(goalSide);
    expect(keeper(goalSide).act).toBe(ActionKind.NONE);
    // Tight angle.
    const tight = scene();
    tight.place(20, 4, 14, -1, -1);
    tight.owned(20, 0, -0.8);
    brain(tight);
    expect(keeper(tight).act).toBe(ActionKind.NONE);
    // Running away from goal.
    const away = scene();
    away.place(20, 15, 2, 5, 0);
    away.owned(20, 0.8, 0, 5, 0);
    brain(away);
    expect(keeper(away).act).toBe(ActionKind.NONE);
    // Too far out.
    const far = scene();
    far.place(20, L.oneOnOneDepth + 3, 0, -5, 0);
    far.owned(20, -0.8, 0, -5, 0);
    brain(far);
    expect(keeper(far).act).toBe(ActionKind.NONE);
  });

  it('plans a claim (GK_PUNCH) for a cross into the goal area within his reach', () => {
    for (const e of ENDS) {
      const sc = scene({ team: e.team, swap: e.swap, ku: 1, kz: 1 });
      sc.loose(8.5, 26, -3, -17, { y: 0.5, vy: 8.5, kind: KickKind.CROSS });
      brain(sc);
      const p = keeper(sc);
      expect(p.act, e.name).toBe(ActionKind.GK_PUNCH);
      expect(p.actB).toBe(sc.s.ball.lastTouchTick);
      expect(p.actCurve).toBeGreaterThanOrEqual(L.claimMinY);
      expect(p.actCurve).toBeLessThanOrEqual(keeperClaimTop(sc.s.attrs[sc.keeper]!));
      const u = sc.u(p.actX);
      expect(u).toBeGreaterThanOrEqual(L.claimMinDepth);
      expect(u).toBeLessThanOrEqual(L.claimZoneDepth);
    }
  });

  it('leaves a cross to a teammate already going up for it earlier', () => {
    const sc = scene({ ku: 1, kz: 1 });
    sc.loose(8.5, 26, -3, -17, { y: 0.5, vy: 8.5, kind: KickKind.CROSS });
    const m = sc.s.players[sc.mate(4)]!;
    beginAction(m, ActionKind.HEADER, 60, 20);
    m.actB = sc.s.ball.lastTouchTick;
    brain(sc);
    expect(keeper(sc).act).not.toBe(ActionKind.GK_PUNCH);
  });

  it('never claims a goal-bound lob (GKP-02 saves it), an opponent\'s shot, or a ball out of his reach', () => {
    // In the keeper pipeline GKP-02 sees the dropping lob first.
    const lob = scene({ ku: 6 });
    lob.loose(20, 0.5, -12, 0, { y: 1.5, vy: 5.5, kind: KickKind.SHOT_CHIP });
    keeperPipeline(lob);
    expect(keeper(lob).act).not.toBe(ActionKind.GK_PUNCH);
    // The brain alone never claims an opponent's shot ...
    const shot = scene({ ku: 6 });
    shot.loose(20, 0.5, -12, 0, { y: 1.5, vy: 5.5, kind: KickKind.SHOT_CHIP });
    shot.s.ball.shotBy = shot.att(9); shot.s.ball.shotOnTarget = 1;
    brain(shot);
    expect(keeper(shot).act).not.toBe(ActionKind.GK_PUNCH);
    // ... nor a flight that would end in his goal within its prediction.
    const near = scene({ ku: 1 });
    near.loose(9, 0.5, -10, 0, { y: 1.8, vy: 2.5, kind: KickKind.HEADER_PASS });
    brain(near);
    expect(keeper(near).act).not.toBe(ActionKind.GK_PUNCH);
    const high = scene({ ku: 1 });
    high.loose(8, 26, -2, -17, { y: 0.5, vy: 16, kind: KickKind.CROSS });
    brain(high);
    expect(keeper(high).act).not.toBe(ActionKind.GK_PUNCH);
  });
});

describe('GKP-03 startKeeperRush (user)', () => {
  it('starts a USER_HOLD rush when a controller of his team holds THROUGH, else a timed (gesture) rush', () => {
    const held = scene();
    held.place(20, 20, 0); held.owned(20);
    const c = held.s.ctrl[0]!;
    c.kind = ControllerKind.HUMAN; c.side = held.team; c.buttons = Btn.THROUGH;
    expect(keeperRushHeld(held.s, held.team)).toBe(true);
    expect(startKeeperRush(held.s, held.keeper, createEventBuffer())).toBe(1);
    expect(keeper(held).act).toBe(ActionKind.GK_RUSH);
    expect(keeper(held).actA).toBe(RushMode.USER_HOLD);
    const tap = scene();
    tap.place(20, 20, 0); tap.owned(20);
    expect(startKeeperRush(tap.s, tap.keeper, createEventBuffer())).toBe(1);
    expect(keeper(tap).actA).toBe(RushMode.USER_TIMED);
  });

  it('refuses when the ball is in hands, his team has it, play is stopped, he is busy, or the slot is not a keeper', () => {
    const refuse: ((sc: Scene) => number)[] = [
      (sc) => { sc.s.ball.heldBy = 15; sc.s.ball.owner = 15; return sc.keeper; },
      (sc) => { sc.owned(sc.mate(5)); return sc.keeper; },
      (sc) => { sc.s.match.phase = MatchPhase.CORNER; return sc.keeper; },
      (sc) => { beginAction(keeper(sc), ActionKind.GK_DIVE, 40, 10); return sc.keeper; },
      (sc) => { keeper(sc).stunT = 5; return sc.keeper; },
      () => 4,
      () => -1,
      () => 99,
    ];
    for (const r of refuse) {
      const sc = scene();
      sc.place(20, 20, 0); sc.owned(20);
      const slot = r(sc);
      const before = keeper(sc).act;
      expect(startKeeperRush(sc.s, slot, createEventBuffer())).toBe(0);
      expect(keeper(sc).act).toBe(before);
    }
  });

  it('takes over an AI rush in progress (returns 1, mode becomes the user\'s)', () => {
    const sc = scene();
    sc.loose(9, 2, -3, 0);
    brain(sc);
    expect(keeper(sc).actA).toBe(RushMode.AI_BALL);
    expect(startKeeperRush(sc.s, sc.keeper, createEventBuffer())).toBe(1);
    expect(keeper(sc).act).toBe(ActionKind.GK_RUSH);
    expect(keeper(sc).actA).toBe(RushMode.USER_TIMED);
    // The brain no longer touches a user rush.
    sc.place(sc.mate(3), 8.5, 2.2);
    brain(sc);
    expect(keeper(sc).actA).toBe(RushMode.USER_TIMED);
  });
});

describe('GKP-03 user hold takes over an AI rush', () => {
  it('while the opponents have the ball a held THROUGH makes an AI rush the user\'s; never on a loose ball', () => {
    const sc = scene();
    sc.place(20, 15, 2, -5, 0);
    sc.owned(20, -0.8, 0, -5, 0);
    brain(sc);
    expect(keeper(sc).actA).toBe(RushMode.AI_ONE_ON_ONE);
    const c = sc.s.ctrl[0]!;
    c.kind = ControllerKind.HUMAN; c.side = sc.team; c.buttons = Btn.THROUGH;
    brain(sc);
    expect(keeper(sc).act).toBe(ActionKind.GK_RUSH);
    expect(keeper(sc).actA).toBe(RushMode.USER_HOLD);
    // Loose ball: THROUGH may be a teammate's first-time through ball, the AI rush stays the AI's.
    const lo = scene();
    lo.loose(9, 2, -3, 0);
    brain(lo);
    expect(keeper(lo).actA).toBe(RushMode.AI_BALL);
    const c2 = lo.s.ctrl[0]!;
    c2.kind = ControllerKind.HUMAN; c2.side = lo.team; c2.buttons = Btn.THROUGH;
    brain(lo);
    expect(keeper(lo).actA).toBe(RushMode.AI_BALL);
  });
});

describe('GKP-03 GK_RUSH handler', () => {
  it('a held rush lasts while THROUGH is held (at least userMinTicks) and ends on release', () => {
    const sc = scene();
    sc.place(20, 25, 0); sc.owned(20);
    const c = sc.s.ctrl[0]!;
    c.kind = ControllerKind.HUMAN; c.side = sc.team; c.buttons = Btn.THROUGH;
    startKeeperRush(sc.s, sc.keeper, createEventBuffer());
    for (let i = 0; i < 40; i++) act(sc);
    expect(keeper(sc).act).toBe(ActionKind.GK_RUSH);
    expect(keeper(sc).moveMode).toBe(MoveMode.ARRIVE);
    expect(keeper(sc).tgtSpeed).toBeGreaterThan(7);
    c.buttons = 0;
    act(sc);
    expect(keeper(sc).act).toBe(ActionKind.NONE);
    expect(keeper(sc).moveMode).toBe(MoveMode.STOP);
    // A quick press still gives the minimum dash.
    c.buttons = Btn.THROUGH;
    startKeeperRush(sc.s, sc.keeper, createEventBuffer());
    c.buttons = 0;
    let n = 0;
    while (keeper(sc).act === ActionKind.GK_RUSH && n < 100) { act(sc); n++; }
    expect(n).toBe(L.userMinTicks);
  });

  it('a timed (gesture) rush ends after userTimedTicks', () => {
    const sc = scene();
    sc.place(20, 40, 0); sc.owned(20);
    startKeeperRush(sc.s, sc.keeper, createEventBuffer());
    let n = 0;
    while (keeper(sc).act === ActionKind.GK_RUSH && n < 500) { act(sc); n++; }
    expect(n).toBe(L.userTimedTicks);
  });

  it('ends when his team gets the ball, the ball is held, play stops, or a human takes over an AI rush', () => {
    const cases: ((sc: Scene) => void)[] = [
      (sc) => { sc.owned(sc.mate(5)); },
      (sc) => { sc.s.ball.heldBy = 11; sc.s.ball.owner = 11; },
      (sc) => { sc.s.match.phase = MatchPhase.GOAL_KICK; },
      (sc) => {
        const c = sc.s.ctrl[0]!;
        c.kind = ControllerKind.HUMAN; c.side = sc.team; c.slot = sc.keeper; keeper(sc).ctrl = 0;
      },
    ];
    for (const apply of cases) {
      const sc = scene();
      sc.loose(16, 2, -2, 0);
      rush(sc, RushMode.AI_BALL);
      act(sc);
      expect(keeper(sc).act).toBe(ActionKind.GK_RUSH);
      apply(sc);
      act(sc);
      expect(keeper(sc).act).toBe(ActionKind.NONE);
    }
  });

  it('collects a reachable loose ball in his area into his hands', () => {
    const sc = scene({ ku: 6 });
    sc.loose(6.6, 0.2, -2, 0);
    rush(sc, RushMode.AI_BALL);
    const ev = act(sc);
    expect(sc.s.ball.heldBy).toBe(sc.keeper);
    expect(keeper(sc).act).toBe(ActionKind.GK_HOLD);
    expect(ev.some((e) => e.type === EventType.KEEPER_HANDS && e.b === 1)).toBe(true);
  });

  it('outside his area: clears a pressured ball first time, leaves an unpressured one at his feet, blocks a fast one', () => {
    // Pressured: an attacker 4 m away.
    const sc = scene({ ku: 18 });
    sc.loose(18.6, 0, -2, 0);
    sc.place(20, 22, 0);
    rush(sc, RushMode.AI_BALL);
    const ev = act(sc);
    const kick = ev.find((e) => e.type === EventType.KICK && e.a === sc.keeper);
    expect(kick?.b).toBe(KickKind.CLEARANCE);
    expect(sc.dir * sc.s.ball.vx).toBeGreaterThan(10);
    expect(sc.s.ball.vy).toBeGreaterThan(5);
    expect(keeper(sc).act).toBe(ActionKind.NONE);
    expect(sc.s.ball.heldBy).toBe(-1);
    // Unpressured and slow, within control range: the rush ends (SIM-06 gives it to him at his feet).
    const calm = scene({ ku: 18 });
    calm.loose(18.5, 0, -1, 0);
    rush(calm, RushMode.AI_BALL);
    const ev2 = act(calm);
    expect(ev2.some((e) => e.type === EventType.KICK)).toBe(false);
    expect(keeper(calm).act).toBe(ActionKind.NONE);
    // Fast and pressured: blocked away from goal.
    const fast = scene({ ku: 18 });
    fast.loose(18.9, 0.1, -20, 0); // (no ball physics in these unit ticks: it is already at him)
    fast.place(20, 23, 0);
    rush(fast, RushMode.AI_BALL);
    let k3: SimEvent | undefined;
    for (let i = 0; i < 6 && !k3; i++) k3 = act(fast).find((e) => e.type === EventType.KICK && e.a === fast.keeper);
    expect(k3?.b).toBe(KickKind.DEFLECTION);
    expect(fast.dir * fast.s.ball.vx).toBeGreaterThan(0);
  });

  it('smothers a carrier\'s ball at his feet: wins it (TACKLE, KEEPER) into his hands inside the area', () => {
    for (const e of ENDS) {
      const sc = scene({ team: e.team, swap: e.swap, ku: 6 });
      const att = sc.att(9);
      sc.place(att, 8.6, 0.3, -4, 0);
      sc.owned(att, -1.2, 0, -4, 0);
      rush(sc, RushMode.AI_ONE_ON_ONE);
      let won: SimEvent | undefined;
      for (let i = 0; i < 20 && !won; i++) {
        const ev = act(sc);
        won = ev.find((x) => x.type === EventType.TACKLE && x.a === sc.keeper);
      }
      expect(won, e.name).toBeDefined();
      expect(won!.b).toBe(att);
      expect(won!.c).toBe(1);
      expect(won!.d).toBe(ChallengeKind.KEEPER);
      expect(sc.s.ball.heldBy).toBe(sc.keeper);
      expect(sc.s.players[att]!.noTouchT).toBeGreaterThan(0);
    }
  });

  it('a smother outside his area pushes the ball away (no hands) and he goes down (GKP-02 low dive)', () => {
    const sc = scene({ ku: 18.5 });
    const att = sc.att(9);
    sc.place(att, 21, 0.3, -4, 0);
    sc.owned(att, -1.2, 0, -4, 0);
    rush(sc, RushMode.AI_ONE_ON_ONE);
    let kick: SimEvent | undefined;
    for (let i = 0; i < 20 && !kick; i++) {
      kick = act(sc).find((x) => x.type === EventType.KICK && x.a === sc.keeper);
    }
    expect(kick?.b).toBe(KickKind.DEFLECTION);
    expect(sc.s.ball.heldBy).toBe(-1);
    expect(sc.s.ball.owner).toBe(-1);
    expect(sc.dir * sc.s.ball.vx).toBeGreaterThan(0);
    expect(keeper(sc).act).toBe(ActionKind.GK_DIVE);
    expect(keeper(sc).actA).toBe(0);
  });

  it('a missed smother with the attacker\'s body against him records a KEEPER challenge (TACKLE c=0), then he is down', () => {
    const sc = scene({ ku: 6 });
    const att = sc.att(9);
    sc.place(att, 7.4, 0, -6, 0);
    sc.owned(att, -0.7, 0, -6, 0);
    rush(sc, RushMode.AI_ONE_ON_ONE);
    act(sc);
    expect(keeper(sc).actB).toBe(RushPhase.SMOTHER);
    // The attacker flicks the ball away high over him before the window opens.
    const b = sc.s.ball;
    b.owner = -1; b.y = 1.5; b.vy = 4; b.vx = sc.vx(-2); b.vz = 6; b.lastTouch = att; b.lastTouchTick = sc.s.tick;
    const all: SimEvent[] = [];
    for (let i = 0; i < 20 && keeper(sc).act === ActionKind.GK_RUSH; i++) {
      // Keep the attacker against him.
      const p = sc.s.players[att]!;
      p.x = keeper(sc).x + sc.vx(0.5); p.z = keeper(sc).z;
      all.push(...act(sc));
    }
    const t = all.find((x) => x.type === EventType.TACKLE && x.a === sc.keeper);
    expect(t).toBeDefined();
    expect(t!.c).toBe(0);
    expect(t!.d).toBe(ChallengeKind.KEEPER);
    expect(keeper(sc).act).toBe(ActionKind.GK_DIVE);
  });

  it('every GK_RUSH ends (bounded) whatever happens, and leaves him free to move', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const sc = scene({ seed });
      const r = (k: number): number => ((seed * 7919 + k * 104729) % 1000) / 1000;
      sc.loose(2 + r(1) * 25, -15 + r(2) * 30, -8 * r(3), (r(4) - 0.5) * 8, { y: BALL_RADIUS + r(5) * 2, vy: r(6) * 4 });
      sc.place(sc.att(9), 3 + r(7) * 20, -10 + r(8) * 20, -3, 0);
      sc.place(sc.keeper, 1 + r(9) * 10, -5 + r(10) * 10);
      rush(sc, Math.floor(r(11) * 4));
      let n = 0;
      while (keeper(sc).act === ActionKind.GK_RUSH && n < L.rushMaxTicks + 5) { act(sc); n++; }
      expect(keeper(sc).act, `seed ${seed}`).not.toBe(ActionKind.GK_RUSH);
      expect(n).toBeLessThanOrEqual(L.rushMaxTicks);
      if (keeper(sc).act === ActionKind.NONE) expect(keeper(sc).moveMode).not.toBe(MoveMode.LOCKED);
      for (const v of [keeper(sc).x, keeper(sc).z, sc.s.ball.x, sc.s.ball.y, sc.s.ball.z]) expect(Number.isFinite(v)).toBe(true);
      expect(sc.u(keeper(sc).x)).toBeGreaterThan(0);
    }
  });
});

describe('GKP-03 GK_PUNCH handler', () => {
  function claim(sc: Scene): void {
    sc.loose(8.5, 26, -3, -17, { y: 0.5, vy: 8.5, kind: KickKind.CROSS });
    brain(sc);
    expect(keeper(sc).act).toBe(ActionKind.GK_PUNCH);
  }

  it('cancels before take-off when someone else touches the flight', () => {
    const sc = scene({ ku: 1, kz: 1 });
    claim(sc);
    act(sc);
    sc.s.ball.lastTouchTick = sc.s.tick;
    sc.s.ball.lastTouch = sc.att(3);
    act(sc);
    expect(keeper(sc).act).toBe(ActionKind.NONE);
  });

  it('in the air when the flight changes: he lands (no contact) and the action ends', () => {
    const sc = scene({ ku: 1, kz: 1 });
    claim(sc);
    const p = keeper(sc);
    while (p.act === ActionKind.GK_PUNCH && p.actT < p.actContact - L.takeoffTicks + 1) act(sc);
    expect(p.actA).toBe(1);
    sc.s.ball.lastTouchTick = sc.s.tick;
    act(sc);
    expect(p.actDone).toBe(2);
    let n = 0;
    while (p.act === ActionKind.GK_PUNCH && n < 100) { act(sc); n++; }
    expect(p.act).toBe(ActionKind.NONE);
    expect(n).toBeLessThanOrEqual(L.claimLandTicks + 1);
  });

  it('a claim that never meets the ball misses and ends on time', () => {
    const sc = scene({ ku: 1, kz: 1 });
    claim(sc);
    // Freeze the ball far away (the flight id unchanged): nothing to meet.
    const b = sc.s.ball;
    b.x = sc.x(40); b.vx = 0; b.vz = 0; b.vy = 0; b.y = 3;
    const p = keeper(sc);
    const dur = p.actDur;
    let n = 0;
    while (p.act === ActionKind.GK_PUNCH && n < 300) { act(sc); n++; }
    expect(n).toBeLessThanOrEqual(dur);
    expect(b.heldBy).toBe(-1);
  });

  it('catch limit and reach grow with the attributes', () => {
    const sc = scene();
    const a = sc.s.attrs[sc.keeper]!;
    a.gkHandling = 1; const lo = keeperCatchLimit(a, 1.5);
    a.gkHandling = 99; const hi = keeperCatchLimit(a, 1.5);
    expect(hi).toBeGreaterThan(lo);
    expect(keeperCatchLimit(a, 2.5)).toBeLessThan(hi);
    a.gkDiving = 1; const r1 = keeperClaimTop(a);
    a.gkDiving = 99; const r2 = keeperClaimTop(a);
    expect(r2).toBeGreaterThan(r1);
    expect(r1).toBeGreaterThan(2.3);
  });
});

describe('GKP-03 handlers are the registered ones', () => {
  it('rushHandler / punchHandler shells forward to the bound implementation', () => {
    const sc = scene();
    sc.place(20, 40, 0); sc.owned(20);
    startKeeperRush(sc.s, sc.keeper, createEventBuffer());
    const ev = createEventBuffer();
    ev.begin(sc.s.tick);
    keeper(sc).actT = L.userTimedTicks;
    rushHandler.update(sc.s, sc.keeper, ev);
    expect(keeper(sc).act).toBe(ActionKind.NONE);
    const sc2 = scene({ ku: 1, kz: 1 });
    sc2.loose(8.5, 26, -3, -17, { y: 0.5, vy: 8.5, kind: KickKind.CROSS });
    brain(sc2);
    sc2.s.match.phase = MatchPhase.CORNER;
    punchHandler.update(sc2.s, sc2.keeper, ev);
    expect(sc2.s.players[sc2.keeper]!.act).toBe(ActionKind.NONE);
  });
});
