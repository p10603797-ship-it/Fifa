/**
 * [SIM-07] First touch, trapping and aerial control: receiveContacts / touchQuality / FIRST_TOUCH handler, tested on
 * hand-built arrivals (one contact stage per call). Pipeline scenarios live in tests/scenario/sim-07-*.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { MoveMode } from '../../src/contracts/state';
import { T_BALL, T_DRIBBLE, T_TOUCH } from '../../src/contracts/tuning';
import { ACTION_HANDLERS } from '../../src/sim/actions/registry';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { createEventBuffer } from '../../src/sim/core/events';
import { rngNext, rngSeed } from '../../src/sim/core/rng';
import { maxSpeed } from '../../src/sim/players/locomotion';
import {
  firstTouchHandler, isUntouchedPass, LOCAL_TUNING as L, receiveContacts, touchQuality, TouchOutcome, trapLead,
} from '../../src/sim/players/firstTouch';
import {
  baseState, contactTick, control, DT, GK1, incoming, MATE, OPP, OPP2, outcome, PASSER, RECV, resetPlayer, RX, RZ, trials,
} from './sim-07-helpers';

const N = 400;

function kinds(evs: { type: EventType }[], t: EventType): number {
  return evs.filter((e) => e.type === t).length;
}

describe('SIM-07 receiveContacts: clean traps', () => {
  it('a soft pass is trapped cleanly: possession, FIRST_TOUCH window, KICK(FIRST_TOUCH) and PASS_COMPLETE', () => {
    const s = baseState(3);
    incoming(s, RECV, { speed: 8 });
    const ev = contactTick(s);
    const p = s.players[RECV]!;
    expect(s.ball.owner).toBe(RECV);
    expect(s.ball.lastTouch).toBe(RECV);
    expect(s.ball.touchedTick).toBe(s.tick);
    expect(s.ball.passTarget).toBe(-1);
    expect(p.act).toBe(ActionKind.FIRST_TOUCH);
    expect(p.actA).toBe(TouchOutcome.CLEAN);
    expect(p.actDur).toBe(T_TOUCH.firstTouchTicks);
    expect(p.actKick).toBe(KickKind.FIRST_TOUCH);
    expect(p.actSlot).toBe(PASSER);
    const kick = ev.filter((e) => e.type === EventType.KICK);
    expect(kick).toHaveLength(1);
    expect(kick[0]!.a).toBe(RECV);
    expect(kick[0]!.b).toBe(KickKind.FIRST_TOUCH);
    const pc = ev.filter((e) => e.type === EventType.PASS_COMPLETE);
    expect(pc).toHaveLength(1);
    expect(pc[0]!.a).toBe(RECV);
    expect(pc[0]!.b).toBe(PASSER);
    // A reception is not a new kick: lastKick* still name the passer (offside / back-pass bookkeeping).
    expect(s.ball.lastKickBy).toBe(PASSER);
    expect(s.ball.lastKickKind).toBe(KickKind.GROUND_PASS);
  });

  it('soft passes are always clean, even for poor controllers, over many seeds', () => {
    for (const control of [1, 40, 75, 99]) {
      const c = trials(N, (s) => {
        s.attrs[RECV]!.ballControl = control;
        incoming(s, RECV, { speed: 7 });
      });
      expect(c.clean, `ballControl ${control}`).toBe(N);
    }
  });

  it('a standing receiver cushions the ball at his feet toward the stick: the settle spot is touchAheadClose ahead', () => {
    const s = baseState(5);
    control(s, RECV);
    const p = s.players[RECV]!;
    p.moveMode = MoveMode.DIRECT; p.ix = 0; p.iz = 1;
    incoming(s, RECV, { speed: 9 });
    contactTick(s);
    expect(outcome(s, RECV)).toBe('clean');
    expect(p.actDirX).toBeCloseTo(0, 9);
    expect(p.actDirZ).toBeCloseTo(1, 9);
    expect(p.actX).toBeCloseTo(RX, 6);
    expect(p.actZ).toBeCloseTo(RZ + T_DRIBBLE.touchAheadClose, 6);
    // The ball now rolls toward that spot (from x = RX + 0.9 back across and to +z), not on along the pass.
    expect(s.ball.vz).toBeGreaterThan(0);
    expect(s.ball.vx).toBeLessThan(0);
    expect(Math.hypot(s.ball.vx, s.ball.vz)).toBeLessThan(L.settleMaxSpeed + 1e-9);
    expect(s.ball.sx === 0 && s.ball.sy === 0 && s.ball.sz === 0).toBe(true);
  });

  it('the settled ball reaches the spot ahead of him when the window ends (rolling model)', () => {
    const s = baseState(6);
    control(s, RECV);
    const p = s.players[RECV]!;
    p.moveMode = MoveMode.DIRECT; p.ix = 1; p.iz = 0;
    incoming(s, RECV, { speed: 10, fromX: 0, fromZ: 1 });
    contactTick(s);
    expect(outcome(s, RECV)).toBe('clean');
    // Integrate the ground roll for the window (SIM-02 rolling: rollDecel + rollDamping * v).
    const b = s.ball;
    let x = b.x, z = b.z, vx = b.vx, vz = b.vz;
    for (let t = 0; t < p.actDur; t++) {
      const v = Math.hypot(vx, vz);
      if (v < 1e-9) break;
      let nv = v - (T_BALL.rollDecel + T_BALL.rollDamping * v) * DT;
      if (nv < 0) nv = 0;
      x += (vx / v) * 0.5 * (v + nv) * DT; z += (vz / v) * 0.5 * (v + nv) * DT;
      vx *= nv / v; vz *= nv / v;
    }
    expect(Math.hypot(x - p.actX, z - p.actZ)).toBeLessThan(0.15);
    expect(p.actX - RX).toBeCloseTo(T_DRIBBLE.touchAheadClose, 6);
  });

  it('trap lead grows with speed: close standing, jog lead at a jog, sprint lead at top speed', () => {
    const s = baseState(7);
    const p = s.players[RECV]!;
    expect(trapLead(s, RECV)).toBeCloseTo(T_DRIBBLE.touchAheadClose, 9);
    p.vx = maxSpeed(s, RECV, false);
    expect(trapLead(s, RECV)).toBeCloseTo(T_DRIBBLE.touchAheadJog, 9);
    p.vx = maxSpeed(s, RECV, true);
    expect(trapLead(s, RECV)).toBeCloseTo(T_DRIBBLE.touchAheadSprint, 9);
  });

  it('a sprinting receiver taking a through ball in stride settles it further ahead, in his running direction', () => {
    const jog = baseState(8);
    const spr = baseState(8);
    for (const [s, sprint] of [[jog, 0], [spr, 1]] as const) {
      control(s, RECV);
      const p = s.players[RECV]!;
      p.vx = maxSpeed(s, RECV, sprint === 1); p.moveMode = MoveMode.DIRECT; p.ix = 1; p.wantSprint = sprint;
      // Ball coming from behind him, a little faster than he runs.
      incoming(s, RECV, { speed: p.vx + 3, fromX: -1, fromZ: 0, face: false });
      s.attrs[RECV]!.ballControl = 99;
      contactTick(s);
      expect(outcome(s, RECV)).toBe('clean');
      expect(p.actDirX).toBeCloseTo(1, 9);
    }
    const lj = jog.players[RECV]!.actX - jog.players[RECV]!.x;
    const ls = spr.players[RECV]!.actX - spr.players[RECV]!.x;
    expect(ls).toBeGreaterThan(lj + 1);
  });

  it('an AI receiver with no stick settles along his run (velocity), else along his facing', () => {
    const s = baseState(9);
    const p = s.players[RECV]!;
    p.vx = 0; p.vz = -3; // running toward -z
    incoming(s, RECV, { speed: 8 });
    contactTick(s);
    expect(outcome(s, RECV)).toBe('clean');
    expect(p.actDirZ).toBeCloseTo(-1, 9);
    const s2 = baseState(9);
    incoming(s2, RECV, { speed: 8, fromX: 0, fromZ: -1 }); // faces -z, standing
    contactTick(s2);
    expect(outcome(s2, RECV)).toBe('clean');
    expect(s2.players[RECV]!.actDirZ).toBeCloseTo(-1, 9);
  });
});

describe('SIM-07 quality', () => {
  it('touchQuality is pure and falls with speed, height, pressure, sprint, facing away; rises with ballControl', () => {
    const s = baseState(11);
    const p = s.players[RECV]!;
    incoming(s, RECV, { speed: 12, pass: false });
    const rng = { ...s.rng };
    const base = touchQuality(s, RECV, 12, 0.11);
    expect(s.rng).toEqual(rng);
    expect(touchQuality(s, RECV, 12, 0.11)).toBe(base);
    expect(base).toBeGreaterThan(0);
    expect(base).toBeLessThanOrEqual(1);
    expect(touchQuality(s, RECV, 20, 0.11)).toBeLessThan(base);
    expect(touchQuality(s, RECV, 4, 0.11)).toBeGreaterThan(base);
    expect(touchQuality(s, RECV, 12, 1.4)).toBeLessThan(base);
    s.attrs[RECV]!.ballControl = 95;
    expect(touchQuality(s, RECV, 12, 0.11)).toBeGreaterThan(base);
    s.attrs[RECV]!.ballControl = 30;
    expect(touchQuality(s, RECV, 12, 0.11)).toBeLessThan(base);
    s.attrs[RECV]!.ballControl = 60;
    const q60 = touchQuality(s, RECV, 12, 0.11);
    p.wantSprint = 1;
    expect(touchQuality(s, RECV, 12, 0.11)).toBeLessThan(q60);
    p.wantSprint = 0;
    resetPlayer(s, OPP, RX - 1, RZ + 0.5); // an opponent at his shoulder
    expect(touchQuality(s, RECV, 12, 0.11)).toBeLessThan(q60);
    resetPlayer(s, OPP, -40, 20);
    p.fx = -1; p.fz = 0; // back to the ball
    expect(touchQuality(s, RECV, 12, 0.11)).toBeLessThan(q60);
    // Degenerate inputs stay in range.
    expect(touchQuality(s, RECV, Number.NaN, Number.NaN)).toBeGreaterThanOrEqual(0);
    expect(touchQuality(s, RECV, 1e9, 1e9)).toBe(0);
    expect(touchQuality(s, -1, 5, 0.1)).toBe(0);
  });

  it('hard balls bounce off weak players more often (deterministic RNG over many seeds)', () => {
    const run = (control: number) => trials(N, (s) => {
      s.attrs[RECV]!.ballControl = control;
      incoming(s, RECV, { speed: 20 });
    });
    const weak = run(35);
    const strong = run(90);
    expect(weak.none + strong.none).toBe(0);
    expect(strong.clean).toBeGreaterThan(0.9 * N);
    expect(weak.heavy + weak.miss).toBeGreaterThan(0.6 * N);
    expect(weak.heavy).toBeGreaterThan(0.3 * N);
    // Deterministic: the same seeds give the same counts.
    expect(run(35)).toEqual(weak);
  });

  it('sprinting makes the first touch heavier (sprint held, same ball)', () => {
    const run = (sprint: number) => trials(N, (s) => {
      s.attrs[RECV]!.ballControl = 60;
      s.players[RECV]!.wantSprint = sprint;
      incoming(s, RECV, { speed: 14 });
    });
    const calm = run(0);
    const sprint = run(1);
    expect(sprint.heavy + sprint.miss).toBeGreaterThan(calm.heavy + calm.miss + 0.1 * N);
  });

  it('pressure makes the first touch heavier', () => {
    const run = (press: boolean) => trials(N, (s) => {
      s.attrs[RECV]!.ballControl = 60;
      if (press) resetPlayer(s, OPP, RX - 0.8, RZ + 0.4); else resetPlayer(s, OPP, -40, 20);
      incoming(s, RECV, { speed: 15 });
    });
    const free = run(false);
    const pressed = run(true);
    expect(pressed.clean).toBeLessThan(free.clean - 0.1 * N);
  });
});

describe('SIM-07 heavy touches and misses', () => {
  it('a heavy touch knocks the ball 1..heavyTouchMax m with deterministic error; possession is not kept', () => {
    let heavy = 0;
    const dists: number[] = [];
    const s = baseState(1);
    for (let seed = 1; seed <= N; seed++) {
      resetPlayer(s, RECV, RX, RZ);
      s.attrs[RECV]!.ballControl = 30;
      rngSeed(s.rng, seed);
      incoming(s, RECV, { speed: 21 });
      const ev = contactTick(s);
      if (outcome(s, RECV) !== 'heavy') continue;
      heavy++;
      const b = s.ball;
      const p = s.players[RECV]!;
      expect(b.owner).toBe(-1);
      expect(b.lastTouch).toBe(RECV);
      expect(b.lastKickBy).toBe(RECV);
      expect(b.lastKickKind).toBe(KickKind.FIRST_TOUCH);
      expect(b.passTarget).toBe(-1);
      expect(p.noTouchT).toBe(L.heavyNoTouchTicks);
      expect(p.actDur).toBe(T_TOUCH.firstTouchTicks);
      expect(kinds(ev, EventType.KICK)).toBe(1);
      expect(kinds(ev, EventType.PASS_COMPLETE)).toBe(L.heavyCountsAsComplete);
      // Standing receiver: the push rolls the ball dist = v^2 / (2 rollDecel) from him.
      const v2 = b.vx * b.vx + b.vz * b.vz;
      const dist = v2 / (2 * T_BALL.rollDecel);
      expect(dist).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(dist).toBeLessThanOrEqual(T_TOUCH.heavyTouchMax + 1e-9);
      expect(b.vy).toBe(0);
      dists.push(dist);
    }
    expect(heavy).toBeGreaterThan(N / 4);
    // The error really varies (not one fixed knock).
    expect(Math.max(...dists) - Math.min(...dists)).toBeGreaterThan(0.5);
  });

  it('a heavy chest touch pops the ball up', () => {
    const s = baseState(1);
    let seen = 0;
    for (let seed = 1; seed <= 200 && seen === 0; seed++) {
      resetPlayer(s, RECV, RX, RZ);
      s.attrs[RECV]!.ballControl = 20;
      rngSeed(s.rng, seed);
      incoming(s, RECV, { speed: 16, y: 1.3, vy: -2, dist: 0.5 });
      contactTick(s);
      if (outcome(s, RECV) !== 'heavy') continue;
      seen++;
      expect(s.ball.vy).toBe(L.heavyPopVy);
      expect(s.ball.grounded).toBe(0);
      expect(s.players[RECV]!.actCurve).toBeGreaterThan(T_DRIBBLE.controlHeight);
    }
    expect(seen).toBe(1);
  });

  it('a miss leaves the ball untouched and the player cannot try again while it passes', () => {
    const s = baseState(1);
    let misses = 0;
    for (let seed = 1; seed <= N; seed++) {
      resetPlayer(s, RECV, RX, RZ);
      s.attrs[RECV]!.ballControl = 1;
      rngSeed(s.rng, seed);
      incoming(s, RECV, { speed: 28, dist: 0.4, lateral: 0.95 });
      const vx = s.ball.vx;
      const touched = s.ball.touchedTick;
      const ev = contactTick(s);
      if (outcome(s, RECV) !== 'miss') continue;
      misses++;
      expect(ev).toHaveLength(0);
      expect(s.ball.vx).toBe(vx);
      expect(s.ball.touchedTick).toBe(touched);
      expect(s.players[RECV]!.act).toBe(ActionKind.NONE);
      // Next tick, still in reach: no second attempt.
      s.ball.px = s.ball.x; s.ball.x += s.ball.vx * DT;
      expect(contactTick(s)).toHaveLength(0);
    }
    expect(misses).toBeGreaterThan(N / 4);
  });
});

describe('SIM-07 balls fired straight at a player', () => {
  it('come off him (heavy) instead of slipping through: misses only happen at the edge of his reach', () => {
    const straight = trials(N, (s) => {
      s.attrs[RECV]!.ballControl = 1;
      incoming(s, RECV, { speed: 28 });
    });
    expect(straight.miss).toBe(0);
    expect(straight.heavy).toBe(N - straight.clean);
    const edge = trials(N, (s) => {
      s.attrs[RECV]!.ballControl = 1;
      incoming(s, RECV, { speed: 28, dist: 0.4, lateral: 0.95 });
    });
    expect(edge.miss).toBeGreaterThan(N / 2);
  });
});

describe('SIM-07 aerial control', () => {
  it('aerial chest trap: a dropping ball at chest height is cushioned down, possession kept, longer window', () => {
    const c = trials(N, (s) => {
      s.attrs[RECV]!.ballControl = 80;
      incoming(s, RECV, { speed: 7, y: 1.35, vy: -3, dist: 0.5 });
    });
    expect(c.clean).toBeGreaterThan(0.95 * N);
    const s = baseState(2);
    s.attrs[RECV]!.ballControl = 80;
    incoming(s, RECV, { speed: 7, y: 1.35, vy: -3, dist: 0.5 });
    contactTick(s);
    const p = s.players[RECV]!;
    expect(outcome(s, RECV)).toBe('clean');
    expect(p.actCurve).toBeGreaterThan(1.2);
    expect(p.actDur).toBe(T_TOUCH.firstTouchTicks + L.aerialExtraTicks);
    expect(s.ball.vy).toBe(L.cushionVy);
    expect(s.ball.grounded).toBe(0);
  });

  it('the chest reach is smaller than the foot reach, and nothing above trapHeight is trapped', () => {
    const s = baseState(2);
    incoming(s, RECV, { speed: 7, y: 1.35, vy: -1, dist: T_TOUCH.receiveRadius * L.chestReachMul + 0.15, fromZ: 0 });
    s.ball.px = s.ball.x; s.ball.pz = s.ball.z; // not moving across his body this tick
    expect(contactTick(s)).toHaveLength(0);
    expect(outcome(s, RECV)).toBe('none');
    const s2 = baseState(2);
    incoming(s2, RECV, { speed: 7, y: T_TOUCH.trapHeight + 0.2, vy: -1, dist: 0.2 });
    expect(contactTick(s2)).toHaveLength(0);
    // The same ball at foot height is in reach.
    const s3 = baseState(2);
    incoming(s3, RECV, { speed: 7, y: 0.3, vy: -1, dist: T_TOUCH.receiveRadius * L.chestReachMul + 0.15 });
    s3.ball.px = s3.ball.x; s3.ball.pz = s3.ball.z;
    contactTick(s3);
    expect(outcome(s3, RECV)).toBe('clean');
  });

  it('a slow ball in the air is still a first touch (airborne), a slow ground ball is not (SIM-06 pick-up)', () => {
    const s = baseState(2);
    incoming(s, RECV, { speed: 1.5, y: 0.5, vy: -2, dist: 0.6, pass: false });
    control(s, RECV);
    contactTick(s);
    expect(outcome(s, RECV)).toBe('clean');
    const s2 = baseState(2);
    incoming(s2, RECV, { speed: 2, dist: 0.6, pass: false });
    control(s2, RECV);
    expect(contactTick(s2)).toHaveLength(0);
    expect(s2.ball.owner).toBe(-1);
  });
});

describe('SIM-07 candidates', () => {
  it('a teammate who is not the target, chaser or controlled lets the ball run (dummy); a loose ball needs a candidate', () => {
    const s = baseState(1);
    incoming(s, RECV, { speed: 9, pass: false });
    expect(contactTick(s)).toHaveLength(0);
    const s2 = baseState(1);
    incoming(s2, RECV, { speed: 9, pass: false });
    s2.teams[0]!.chaser = RECV;
    contactTick(s2);
    expect(outcome(s2, RECV)).toBe('clean');
    const s3 = baseState(1);
    incoming(s3, RECV, { speed: 9, pass: false });
    control(s3, RECV);
    contactTick(s3);
    expect(outcome(s3, RECV)).toBe('clean');
  });

  it("the passer's team chaser lets a pass meant for someone else run on to the target", () => {
    const s = baseState(1);
    incoming(s, RECV, { speed: 9, target: MATE });
    resetPlayer(s, MATE, 30, 0);
    s.teams[0]!.chaser = RECV;
    expect(contactTick(s)).toHaveLength(0);
    // ... but a controlled player takes it.
    const s2 = baseState(1);
    incoming(s2, RECV, { speed: 9, target: MATE });
    resetPlayer(s2, MATE, 30, 0);
    control(s2, RECV);
    contactTick(s2);
    expect(outcome(s2, RECV)).toBe('clean');
  });

  it('outfield opponents leave a low untouched pass to SIM-14 interceptions, but can chest down a higher one', () => {
    const s = baseState(1);
    resetPlayer(s, OPP, RX, RZ + 5);
    incoming(s, OPP, { speed: 9, target: RECV });
    s.teams[1]!.chaser = OPP;
    expect(contactTick(s)).toHaveLength(0);
    expect(s.ball.owner).toBe(-1);
    const s2 = baseState(1);
    resetPlayer(s2, OPP, RX, RZ + 5);
    incoming(s2, OPP, { speed: 7, target: RECV, y: 1.3, vy: -1, dist: 0.4 });
    s2.teams[1]!.chaser = OPP;
    s2.attrs[OPP]!.ballControl = 90;
    const ev = contactTick(s2);
    expect(outcome(s2, OPP)).toBe('clean');
    expect(kinds(ev, EventType.PASS_COMPLETE)).toBe(0);
    expect(kinds(ev, EventType.POSSESSION)).toBe(1);
    // A loose ball (not a pass) is fair game at any height.
    const s3 = baseState(1);
    resetPlayer(s3, OPP, RX, RZ + 5);
    incoming(s3, OPP, { speed: 9, pass: false });
    s3.teams[1]!.chaser = OPP;
    contactTick(s3);
    expect(outcome(s3, OPP)).toBe('clean');
  });

  it('the keeper receives only when GKP did not claim (busy in a GK action = not a candidate)', () => {
    const s = baseState(1);
    resetPlayer(s, GK1, RX, RZ + 5);
    incoming(s, GK1, { speed: 9, target: RECV });
    s.attrs[GK1]!.ballControl = 80;
    contactTick(s);
    expect(outcome(s, GK1)).toBe('clean');
    const s2 = baseState(1);
    resetPlayer(s2, GK1, RX, RZ + 5);
    incoming(s2, GK1, { speed: 9, target: RECV });
    s2.players[GK1]!.act = ActionKind.GK_CATCH; s2.players[GK1]!.actDur = 30;
    expect(contactTick(s2)).toHaveLength(0);
    expect(s2.players[GK1]!.act).toBe(ActionKind.GK_CATCH);
  });

  it('the passer cannot trap his own kick within selfKickTicks; stunned / dispossessed / busy players never trap', () => {
    const s = baseState(1);
    incoming(s, RECV, { speed: 9, pass: false });
    control(s, RECV);
    s.ball.lastKickBy = RECV; s.ball.lastKickTeam = 0; s.ball.lastKickTick = s.tick - 2;
    expect(contactTick(s)).toHaveLength(0);
    for (const tweak of ['stun', 'noTouch', 'busy', 'inactive'] as const) {
      const t = baseState(1);
      incoming(t, RECV, { speed: 9 });
      const p = t.players[RECV]!;
      if (tweak === 'stun') p.stunT = 5;
      if (tweak === 'noTouch') p.noTouchT = 5;
      if (tweak === 'busy') { p.act = ActionKind.STAND_TACKLE; p.actDur = 20; }
      if (tweak === 'inactive') p.active = 0;
      expect(contactTick(t), tweak).toHaveLength(0);
      expect(t.ball.owner, tweak).toBe(-1);
    }
  });

  it('first-time actions: a receiver already winding up a kick is not trapped; the ball is left for the kick', () => {
    for (const act of [ActionKind.KICK, ActionKind.SHOT, ActionKind.VOLLEY]) {
      const s = baseState(1);
      control(s, RECV);
      const p = s.players[RECV]!;
      p.act = act; p.actDur = 20; p.actContact = 8; p.actT = 3; p.actDone = 0; p.actCharging = 1;
      incoming(s, RECV, { speed: 10, dist: 1.25 });
      const vx = s.ball.vx;
      const ev = contactTick(s);
      expect(p.act).toBe(act);
      expect(s.ball.owner).toBe(-1);
      expect(s.ball.vx).toBe(vx);
      expect(s.ball.touchedTick).not.toBe(s.tick);
      // The pass reached him: completed exactly once (edge), not again next tick.
      expect(kinds(ev, EventType.PASS_COMPLETE)).toBe(1);
      s.ball.px = s.ball.x; s.ball.pz = s.ball.z; s.ball.x += s.ball.vx * DT;
      expect(kinds(contactTick(s), EventType.PASS_COMPLETE)).toBe(0);
    }
  });

  it('the ball reaches the candidate it meets first along its path this tick (no double contact)', () => {
    // Ball from x = 12.5 to 12.0 this tick (30 m/s toward -x). Slot 10 (controlled) at (12.8, 0.3) is in reach from the
    // start of the segment; the target RECV (lower slot) at (10.6, 0) only from x = 11.7. Slot 10 is met first.
    const FIRST = 10;
    for (const swap of [false, true]) {
      const s = baseState(1);
      resetPlayer(s, FIRST, swap ? 10.6 : 12.8, swap ? 0 : 0.3);
      resetPlayer(s, RECV, swap ? 12.8 : 10.6, swap ? 0.3 : 0);
      control(s, FIRST);
      incoming(s, RECV, { speed: 30, face: false });
      const b = s.ball;
      b.x = 12.0; b.z = 0; b.px = 12.5; b.pz = 0; b.vx = -30; b.vz = 0;
      const ev = contactTick(s);
      const first = swap ? RECV : FIRST;
      const second = swap ? FIRST : RECV;
      const touched = (i: number) => s.players[i]!.act === ActionKind.FIRST_TOUCH || s.players[i]!.noTouchT > 0;
      expect(touched(first), `swap ${swap}`).toBe(true);
      expect(touched(second), `swap ${swap}`).toBe(false);
      expect(kinds(ev, EventType.KICK)).toBeLessThanOrEqual(1);
    }
  });
});

describe('SIM-07 one contact per tick', () => {
  it('does nothing when another stage already touched the ball this tick', () => {
    const s = baseState(1);
    incoming(s, RECV, { speed: 9 });
    s.ball.touchedTick = s.tick + 1; // contactTick runs on tick + 1: e.g. an interception resolved just before
    const before = JSON.stringify(s.ball);
    expect(contactTick(s)).toHaveLength(0);
    expect(s.players[RECV]!.act).toBe(ActionKind.NONE);
    expect(JSON.stringify(s.ball)).toBe(before.replace(/"cross":\d+/, '"cross":0'));
  });

  it('a second call in the same tick is a no-op (PASS_COMPLETE once)', () => {
    const s = baseState(1);
    incoming(s, RECV, { speed: 9 });
    const ev = contactTick(s);
    expect(kinds(ev, EventType.PASS_COMPLETE)).toBe(1);
    const evb = createEventBuffer();
    evb.begin(s.tick);
    receiveContacts(s, evb);
    expect(evb.count).toBe(0);
  });

  it('never acts outside live play, on an owned / held / netted ball, or on a ball over a line this tick', () => {
    const cases: [string, (s: ReturnType<typeof baseState>) => void][] = [
      ['goal phase', (s) => { s.match.phase = MatchPhase.GOAL; }],
      ['restart not taken', (s) => { s.match.phase = MatchPhase.FREE_KICK; s.match.restart.taken = 0; }],
      ['shoot-out', (s) => { s.match.phase = MatchPhase.SHOOT_OUT; }],
      ['owned', (s) => { s.ball.owner = PASSER; }],
      ['held', (s) => { s.ball.heldBy = GK1; s.ball.owner = GK1; }],
      ['in net', (s) => { s.ball.inNet = 1; }],
    ];
    for (const [name, tweak] of cases) {
      const s = baseState(1);
      incoming(s, RECV, { speed: 9 });
      tweak(s);
      expect(contactTick(s), name).toHaveLength(0);
      expect(s.players[RECV]!.act, name).toBe(ActionKind.NONE);
    }
    // Over the touchline this tick: the rules award the throw-in (contactTick clears cross, so call directly).
    const s = baseState(1);
    incoming(s, RECV, { speed: 9 });
    s.tick++;
    s.ball.cross = 2;
    const evb = createEventBuffer();
    evb.begin(s.tick);
    receiveContacts(s, evb);
    expect(evb.count).toBe(0);
    // A taken restart is live (the free-kick pass is received before the rules flip to IN_PLAY).
    const r = baseState(1);
    incoming(r, RECV, { speed: 9 });
    r.match.phase = MatchPhase.FREE_KICK; r.match.restart.taken = 1;
    contactTick(r);
    expect(outcome(r, RECV)).toBe('clean');
  });
});

describe('SIM-07 PASS_COMPLETE', () => {
  it('only for a teammate of the passer receiving an untouched pass kind', () => {
    // Teammate, untouched pass: yes.
    const s = baseState(1);
    incoming(s, RECV, { speed: 9 });
    expect(kinds(contactTick(s), EventType.PASS_COMPLETE)).toBe(1);
    // Touched since the kick (deflection): no.
    const d = baseState(1);
    incoming(d, RECV, { speed: 9 });
    d.ball.lastTouch = OPP; d.ball.lastTouchTeam = 1; d.ball.lastTouchTick = d.tick - 5;
    control(d, RECV);
    const ev = contactTick(d);
    expect(outcome(d, RECV)).toBe('clean');
    expect(kinds(ev, EventType.PASS_COMPLETE)).toBe(0);
    // A shot is not a pass.
    const sh = baseState(1);
    incoming(sh, RECV, { speed: 9, kind: KickKind.SHOT_NORMAL });
    control(sh, RECV);
    expect(kinds(contactTick(sh), EventType.PASS_COMPLETE)).toBe(0);
    expect(isUntouchedPass(sh.ball)).toBe(false);
  });

  it('a slow untouched pass picked up by a free teammate is completed (and taken for him)', () => {
    const s = baseState(1);
    resetPlayer(s, RECV, 30, 0);
    resetPlayer(s, MATE, RX, RZ);
    incoming(s, MATE, { speed: 1.5, dist: 0.5, target: RECV });
    const ev = contactTick(s);
    expect(s.ball.owner).toBe(MATE);
    expect(s.players[MATE]!.act).toBe(ActionKind.NONE); // no first-touch window for a slow ball
    const pc = ev.filter((e) => e.type === EventType.PASS_COMPLETE);
    expect(pc).toHaveLength(1);
    expect(pc[0]!.a).toBe(MATE);
    expect(pc[0]!.b).toBe(PASSER);
    // An opponent nearer than the teammate: left to SIM-06 (no event, no possession here).
    const o = baseState(1);
    resetPlayer(o, MATE, RX, RZ);
    resetPlayer(o, RECV, 30, 0);
    resetPlayer(o, OPP2, RX + 0.6, RZ);
    incoming(o, MATE, { speed: 1.5, dist: 0.8, target: RECV });
    expect(contactTick(o)).toHaveLength(0);
    expect(o.ball.owner).toBe(-1);
  });

  it('heavy touches count as completed passes when heavyCountsAsComplete = 1; misses never do', () => {
    const c = { heavy: 0, miss: 0, heavyPc: 0, missPc: 0 };
    const s = baseState(1);
    for (let seed = 1; seed <= N; seed++) {
      resetPlayer(s, RECV, RX, RZ);
      s.attrs[RECV]!.ballControl = 25;
      rngSeed(s.rng, seed);
      incoming(s, RECV, { speed: 22, dist: 0.4, lateral: 0.8 });
      const n = kinds(contactTick(s), EventType.PASS_COMPLETE);
      const o = outcome(s, RECV);
      if (o === 'heavy') { c.heavy++; c.heavyPc += n; }
      if (o === 'miss') { c.miss++; c.missPc += n; }
    }
    expect(c.heavy).toBeGreaterThan(0);
    expect(c.miss).toBeGreaterThan(0);
    expect(c.heavyPc).toBe(L.heavyCountsAsComplete === 1 ? c.heavy : 0);
    expect(c.missPc).toBe(0);
  });
});

describe('SIM-07 FIRST_TOUCH action', () => {
  it('the registry holds the handler; the window caps movement, cancels sprint and ends after firstTouchTicks', () => {
    expect(ACTION_HANDLERS[ActionKind.FIRST_TOUCH]).toBe(firstTouchHandler);
    const s = baseState(1);
    control(s, RECV);
    incoming(s, RECV, { speed: 9 });
    contactTick(s);
    const p = s.players[RECV]!;
    expect(p.act).toBe(ActionKind.FIRST_TOUCH);
    const evb = createEventBuffer();
    let ticks = 0;
    while (p.act === ActionKind.FIRST_TOUCH && ticks < 100) {
      p.moveMode = MoveMode.DIRECT; p.ix = 1; p.iz = 0; p.wantSprint = 1; // the resolver writes the stick every tick
      actionsTick(s, evb);
      ticks++;
      if (p.act === ActionKind.FIRST_TOUCH || ticks === T_TOUCH.firstTouchTicks) {
        expect(Math.hypot(p.ix, p.iz)).toBeCloseTo(L.slowFraction, 9);
        expect(p.ix).toBeGreaterThan(0);
        expect(p.wantSprint).toBe(0);
      }
    }
    expect(ticks).toBe(T_TOUCH.firstTouchTicks);
    expect(p.act).toBe(ActionKind.NONE);
    expect(p.actA).toBe(0);
    expect(p.moveMode).toBe(MoveMode.DIRECT); // free to move
  });

  it('ARRIVE intents are capped at slowFraction of jog speed during the window', () => {
    const s = baseState(1);
    incoming(s, RECV, { speed: 9 });
    contactTick(s);
    const p = s.players[RECV]!;
    p.moveMode = MoveMode.ARRIVE; p.tgtX = 40; p.tgtZ = 0; p.tgtSpeed = 9;
    actionsTick(s, createEventBuffer());
    expect(p.tgtSpeed).toBeCloseTo(maxSpeed(s, RECV, false) * L.slowFraction, 9);
    const cap = p.tgtSpeed;
    actionsTick(s, createEventBuffer());
    expect(p.tgtSpeed).toBe(cap); // idempotent
  });

  it('a clean trap whose ball is poked away ends the window at once', () => {
    const s = baseState(1);
    incoming(s, RECV, { speed: 9 });
    contactTick(s);
    const p = s.players[RECV]!;
    expect(p.act).toBe(ActionKind.FIRST_TOUCH);
    s.ball.owner = OPP; // stolen
    actionsTick(s, createEventBuffer());
    expect(p.act).toBe(ActionKind.NONE);
  });

  it('a heavy-touch window runs its full length (he never owned the ball)', () => {
    const s = baseState(1);
    let found = false;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      resetPlayer(s, RECV, RX, RZ);
      s.attrs[RECV]!.ballControl = 20;
      rngSeed(s.rng, seed);
      incoming(s, RECV, { speed: 20 });
      contactTick(s);
      found = outcome(s, RECV) === 'heavy';
    }
    expect(found).toBe(true);
    const p = s.players[RECV]!;
    const evb = createEventBuffer();
    for (let t = 1; t < T_TOUCH.firstTouchTicks; t++) {
      actionsTick(s, evb);
      expect(p.act).toBe(ActionKind.FIRST_TOUCH);
    }
    actionsTick(s, evb);
    expect(p.act).toBe(ActionKind.NONE);
  });
});

describe('SIM-07 determinism', () => {
  it('same seed, same arrival -> identical ball, player and RNG state', () => {
    const run = () => {
      const s = baseState(42);
      s.attrs[RECV]!.ballControl = 45;
      rngSeed(s.rng, 777);
      incoming(s, RECV, { speed: 17, fromX: 0.8, fromZ: 0.6 });
      resetPlayer(s, OPP, RX - 1.5, RZ - 1);
      const ev = contactTick(s);
      return JSON.stringify({ b: s.ball, p: s.players[RECV], r: s.rng, ev });
    };
    expect(run()).toBe(run());
  });

  it('every first touch consumes exactly four RNG draws, whatever the outcome', () => {
    const s = baseState(1);
    const ref = baseState(1);
    for (let seed = 1; seed <= 60; seed++) {
      resetPlayer(s, RECV, RX, RZ);
      s.attrs[RECV]!.ballControl = 30;
      rngSeed(s.rng, seed);
      rngSeed(ref.rng, seed);
      incoming(s, RECV, { speed: 20 });
      contactTick(s);
      // Four draws on the reference stream.
      for (let k = 0; k < 4; k++) rngNext(ref.rng);
      expect(s.rng).toEqual(ref.rng);
    }
  });
});

describe('SIM-07 helpers', () => {
  it('isUntouchedPass follows the kick bookkeeping', () => {
    const s = baseState(1);
    incoming(s, RECV, { speed: 9 });
    expect(isUntouchedPass(s.ball)).toBe(true);
    s.ball.lastTouchTick++;
    expect(isUntouchedPass(s.ball)).toBe(false);
    s.ball.lastTouchTick--;
    s.ball.lastKickKind = KickKind.FIRST_TOUCH;
    expect(isUntouchedPass(s.ball)).toBe(false);
    s.ball.lastKickKind = KickKind.THROUGH_GROUND;
    s.ball.lastKickBy = -1;
    expect(isUntouchedPass(s.ball)).toBe(false);
  });
});
