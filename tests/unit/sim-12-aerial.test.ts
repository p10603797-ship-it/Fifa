/**
 * SIM-12 unit tests: aerialChance windows, starters, jump profile, the header / volley solvers (speeds, aim, passes,
 * clearances, purity) and the contact phase guards (keeper priority, one contact per tick, abort, no double contact).
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, GOAL_HALF_WIDTH, HALF_LENGTH } from '../../src/contracts/constants';
import { ActionKind, AssistLevel, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { createActionRequest, createKickLaunch, type ActionRequest } from '../../src/contracts/systems';
import { ACTION_HANDLERS, KICK_SOLVERS } from '../../src/sim/actions/registry';
import { ballTick } from '../../src/sim/ball/contact';
import { cloneState, diffState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { recordTouch } from '../../src/sim/core/kick';
import { ticksToReach } from '../../src/sim/players/locomotion';
import {
  AERIAL_TUNING, aerialChance, aerialContacts, aerialHeadY, aerialJumpHeight, aerialReachTicks, aerialSpot, headerHandler, solveHeader,
  solveVolley, startAerialClearance, startHeader, startVolley, volleyHandler,
} from '../../src/sim/kicks/aerial';
import { launchCross, place, quietScene } from '../scenario/sim-12-helpers';

const LT = AERIAL_TUNING;
const ATT = 9;
const DEF = 13;
const EV = createEventBuffer();

/** Advance the ball alone by one tick of sim physics (no players, no contacts). */
function stepBallOnly(s: SimState): void {
  s.tick++;
  EV.begin(s.tick);
  ballTick(s, EV);
}

function req(power = 0.5, dirX = 0, dirZ = 0, assist = AssistLevel.ASSISTED): ActionRequest {
  const r = createActionRequest();
  r.power = power; r.dirX = dirX; r.dirZ = dirZ; r.assist = assist;
  return r;
}

/** A cross toward (42, 0) for an attacker standing at (41, 0): a header chance a little later. */
function headerScene(seed = 7): SimState {
  const s = quietScene({ seed });
  place(s, ATT, 41, 0);
  launchCross(s, 7, 38, -28, 42, 0, 0.5, -1);
  return s;
}

/** A low, driven cross that reaches an attacker at (38, 2) at volley height. */
function volleyScene(seed = 7): SimState {
  const s = quietScene({ seed });
  place(s, ATT, 38, 2);
  launchCross(s, 7, 28, -18, 39.5, 2, 0.24, -1);
  return s;
}

/** Put slot into a HEADER / VOLLEY action that is at its contact, ball at (x, y, z) arriving with (vx, vy, vz). */
function atContact(
  s: SimState, slot: number, act: ActionKind, kind: KickKind, power: number, x: number, y: number, z: number,
  vx: number, vy: number, vz: number, flags = 0,
): void {
  const p = s.players[slot]!;
  p.act = act; p.actKick = kind; p.actPower = power; p.actT = 10; p.actContact = 10; p.actDur = 30; p.actDone = 0;
  p.actDirX = 0; p.actDirZ = 0; p.actSlot = -1; p.actA = flags; p.actCurve = y; p.actX = x; p.actZ = z;
  const b = s.ball;
  b.x = x; b.y = y; b.z = z; b.vx = vx; b.vy = vy; b.vz = vz; b.owner = -1; b.heldBy = -1; b.grounded = 0;
}

describe('SIM-12 aerialChance', () => {
  it('a dropping cross at head height is a header chance (1) for the player under it', () => {
    const s = headerScene();
    let c = 0;
    for (let i = 0; i < 150 && c === 0; i++) {
      c = aerialChance(s, ATT);
      if (c === 0) stepBallOnly(s);
    }
    expect(c).toBe(1);
  });

  it('a ball arriving at waist height is a volley chance (2)', () => {
    const s = volleyScene();
    let c = 0;
    for (let i = 0; i < 120 && c === 0; i++) {
      c = aerialChance(s, ATT);
      if (c === 0) stepBallOnly(s);
    }
    expect(c).toBe(2);
  });

  it('no chance: rolling ball, owned ball, ball in hands, play stopped, far away, own recent touch', () => {
    const s = headerScene();
    const ok = (): number => aerialChance(s, ATT);
    // Find the tick at which it becomes a chance, then break one condition at a time.
    for (let i = 0; i < 120 && ok() === 0; i++) stepBallOnly(s);
    expect(ok()).toBe(1);
    const b = s.ball;
    const snap = cloneState(s);
    b.grounded = 1; expect(ok()).toBe(0); b.grounded = 0;
    b.owner = 3; expect(ok()).toBe(0); b.owner = -1;
    b.heldBy = 11; expect(ok()).toBe(0); b.heldBy = -1;
    s.match.phase = MatchPhase.THROW_IN; expect(ok()).toBe(0); s.match.phase = MatchPhase.IN_PLAY;
    b.lastTouch = ATT; b.lastTouchTick = s.tick - 2; expect(ok()).toBe(0);
    b.lastTouchTick = s.tick - LT.retouchTicks - 1; expect(ok()).toBe(1);
    b.lastTouch = 7;
    place(s, ATT, 0, 0); expect(ok()).toBe(0);
    expect(aerialChance(snap, -1)).toBe(0);
    expect(aerialChance(snap, 99)).toBe(0);
  });

  it('a ball the player can only reach in more than chanceTicks is not a chance yet', () => {
    const s = headerScene();
    expect(aerialChance(s, ATT)).toBe(0); // just crossed: ~1.5 s away
    let n = 0;
    while (aerialChance(s, ATT) === 0 && n < 150) { stepBallOnly(s); n++; }
    const spot = { x: 0, z: 0 };
    expect(aerialSpot(s, ATT, spot)).toBe(1);
    expect(Math.hypot(spot.x - 41, spot.z)).toBeLessThan(6);
  });

  it('a tall, high-leaping player reaches a header a short player cannot', () => {
    const tallReach = { height: 196, heading: 95, agility: 90 };
    const shortReach = { height: 165, heading: 20, agility: 30 };
    // Ball peaking right over the player at ~2.45 m, still high when it has passed him.
    const mk = (attrs: object): SimState => {
      const s = quietScene({ seed: 3 });
      place(s, ATT, 40, 0, attrs);
      const b = s.ball;
      b.x = 36; b.y = 2.05; b.z = 0; b.vx = 14; b.vy = 2.8; b.vz = 0; b.grounded = 0; b.px = 36; b.py = 2.05; b.pz = 0;
      b.lastTouch = 7; b.lastTouchTeam = 0; b.lastTouchTick = 0;
      return s;
    };
    expect(aerialChance(mk(tallReach), ATT)).toBe(1);
    expect(aerialChance(mk(shortReach), ATT)).toBe(0);
  });
});

describe('SIM-12 starters', () => {
  it('startHeader refuses wrong kinds, busy players and balls without a chance', () => {
    const s = headerScene();
    const ev = createEventBuffer();
    expect(startHeader(s, ATT, KickKind.HEADER_SHOT, req(), ev)).toBe(0); // no chance yet (too far ahead)
    for (let i = 0; i < 150 && aerialChance(s, ATT) === 0; i++) stepBallOnly(s);
    expect(startHeader(s, ATT, KickKind.SHOT_NORMAL, req(), ev)).toBe(0);
    expect(startVolley(s, ATT, KickKind.HEADER_SHOT, req(), ev)).toBe(0);
    s.players[ATT]!.stunT = 5;
    expect(startHeader(s, ATT, KickKind.HEADER_SHOT, req(), ev)).toBe(0);
    s.players[ATT]!.stunT = 0;
    s.players[ATT]!.act = ActionKind.KICK;
    expect(startHeader(s, ATT, KickKind.HEADER_SHOT, req(), ev)).toBe(0);
    s.players[ATT]!.act = ActionKind.NONE;
    expect(startHeader(s, ATT, KickKind.HEADER_SHOT, req(0.7, 1, 0), ev)).toBe(1);
  });

  it('a started header carries its plan: kind, power, aim, contact spot, flight id, jump and budget', () => {
    const s = headerScene();
    const ev = createEventBuffer();
    for (let i = 0; i < 150 && aerialChance(s, ATT) === 0; i++) stepBallOnly(s);
    expect(startHeader(s, ATT, KickKind.HEADER_SHOT, req(0.7, 3, 4), ev)).toBe(1);
    const p = s.players[ATT]!;
    expect(p.act).toBe(ActionKind.HEADER);
    expect(p.actKick).toBe(KickKind.HEADER_SHOT);
    expect(p.actPower).toBeCloseTo(0.7);
    expect(p.actDirX).toBeCloseTo(0.6);
    expect(p.actDirZ).toBeCloseTo(0.8);
    expect(p.actB).toBe(s.ball.lastTouchTick);
    expect(p.actContact).toBeGreaterThanOrEqual(1);
    expect(p.actContact).toBeLessThanOrEqual(LT.horizon + 1);
    expect(p.actDur).toBeGreaterThanOrEqual(p.actContact + LT.lateTicks);
    expect(p.actCurve).toBeGreaterThan(1.2);
    expect(Math.hypot(p.actX - 41, p.actZ)).toBeLessThan(6);
  });

  it('startVolley plans a volley for a waist-high ball', () => {
    const s = volleyScene();
    const ev = createEventBuffer();
    for (let i = 0; i < 120 && aerialChance(s, ATT) === 0; i++) stepBallOnly(s);
    expect(startHeader(s, ATT, KickKind.HEADER_SHOT, req(), ev)).toBe(0);
    expect(startVolley(s, ATT, KickKind.VOLLEY_SHOT, req(0.5), ev)).toBe(1);
    const p = s.players[ATT]!;
    expect(p.act).toBe(ActionKind.VOLLEY);
    expect(p.actCurve).toBeGreaterThanOrEqual(LT.volleyMinY);
    expect(p.actCurve).toBeLessThanOrEqual(LT.volleyMaxY);
  });

  it('startAerialClearance starts a clearance header (flagged) or nothing', () => {
    const s = headerScene();
    const ev = createEventBuffer();
    expect(startAerialClearance(s, DEF, req(), ev)).toBe(0);
    place(s, DEF, 41, 0);
    for (let i = 0; i < 150 && aerialChance(s, DEF) === 0; i++) stepBallOnly(s);
    expect(startAerialClearance(s, DEF, req(), ev)).toBe(1);
    expect(s.players[DEF]!.act).toBe(ActionKind.HEADER);
    expect(s.players[DEF]!.actKick).toBe(KickKind.HEADER_PASS);
    expect(s.players[DEF]!.actA & 1).toBe(1);
  });
});

describe('SIM-12 jump profile', () => {
  it('the head rises to the planned height at the contact tick and lands afterwards', () => {
    const s = quietScene({});
    const p = s.players[ATT]!;
    const a = s.attrs[ATT]!;
    a.height = 180; a.heading = 70; a.agility = 70;
    const stand = 1.8 * LT.headFrac;
    p.act = ActionKind.HEADER; p.actContact = 30; p.actCurve = stand + 0.4; p.actT = 0;
    expect(aerialHeadY(s, ATT)).toBeCloseTo(stand, 6);
    let peak = 0;
    let peakT = -1;
    for (let t = 0; t <= 60; t++) {
      p.actT = t;
      const j = aerialJumpHeight(s, ATT);
      expect(j).toBeGreaterThanOrEqual(0);
      if (j > peak) { peak = j; peakT = t; }
    }
    expect(peak).toBeCloseTo(0.4, 2);
    expect(peakT).toBe(30);
    p.actT = 30 + 20;
    expect(aerialJumpHeight(s, ATT)).toBe(0); // landed (up time ~17 ticks)
    // Not in a header: standing head height, no jump.
    p.act = ActionKind.NONE;
    expect(aerialJumpHeight(s, ATT)).toBe(0);
    expect(aerialHeadY(s, ATT)).toBeCloseTo(stand, 6);
  });
});

describe('SIM-12 solvers', () => {
  it('registry: header / volley handlers and solvers are the real ones', () => {
    expect(ACTION_HANDLERS[ActionKind.HEADER]).toBe(headerHandler);
    expect(ACTION_HANDLERS[ActionKind.VOLLEY]).toBe(volleyHandler);
    expect(KICK_SOLVERS[KickKind.HEADER_SHOT]).toBe(solveHeader);
    expect(KICK_SOLVERS[KickKind.HEADER_PASS]).toBe(solveHeader);
    expect(KICK_SOLVERS[KickKind.VOLLEY_SHOT]).toBe(solveVolley);
    expect(KICK_SOLVERS[KickKind.VOLLEY_PASS]).toBe(solveVolley);
  });

  it('header shots launch at 10-20 m/s for every power, heading and incoming speed', () => {
    const out = createKickLaunch();
    let lo = 1e9, hi = 0;
    for (const heading of [1, 40, 75, 99]) {
      for (const power of [0, 0.3, 0.6, 0.9, 1]) {
        for (const vin of [6, 14, 24]) {
          const s = quietScene({ seed: heading * 7 + vin });
          s.attrs[ATT]!.heading = heading;
          place(s, ATT, 40, 2);
          atContact(s, ATT, ActionKind.HEADER, KickKind.HEADER_SHOT, power, 40.1, 2.0, 2, 0, -3, -vin);
          expect(solveHeader(s, ATT, out)).toBe(1);
          const v = Math.hypot(out.vx, out.vy, out.vz);
          lo = Math.min(lo, v); hi = Math.max(hi, v);
          expect(out.kind).toBe(KickKind.HEADER_SHOT);
          expect(out.vx).toBeGreaterThan(0); // toward the goal at +x
        }
      }
    }
    expect(lo).toBeGreaterThanOrEqual(10);
    expect(hi).toBeLessThanOrEqual(20);
  });

  it('volley shots launch at 20-30 m/s', () => {
    const out = createKickLaunch();
    let lo = 1e9, hi = 0;
    for (const sp of [1, 50, 99]) {
      for (const power of [0, 0.5, 1]) {
        const s = quietScene({ seed: sp + 3 });
        s.attrs[ATT]!.shotPower = sp; s.attrs[ATT]!.finishing = sp;
        place(s, ATT, 36, 0);
        atContact(s, ATT, ActionKind.VOLLEY, KickKind.VOLLEY_SHOT, power, 36.5, 0.8, 0, -2, -4, 12);
        expect(solveVolley(s, ATT, out)).toBe(1);
        const v = Math.hypot(out.vx, out.vy, out.vz);
        lo = Math.min(lo, v); hi = Math.max(hi, v);
        expect(out.kind).toBe(KickKind.VOLLEY_SHOT);
      }
    }
    expect(lo).toBeGreaterThanOrEqual(20);
    expect(hi).toBeLessThanOrEqual(30);
  });

  it('assisted header shots go at the goal mouth; good headers are on target more often than poor ones', () => {
    const out = createKickLaunch();
    const rate = (heading: number): number => {
      let on = 0;
      for (let i = 0; i < 60; i++) {
        const s = quietScene({ seed: 1000 + i });
        s.attrs[ATT]!.heading = heading;
        place(s, ATT, 42, -1 + (i % 3));
        atContact(s, ATT, ActionKind.HEADER, KickKind.HEADER_SHOT, 0.6, 42.1, 1.9, -1 + (i % 3), 0, -3, 14);
        solveHeader(s, ATT, out);
        on += out.onTarget;
      }
      return on / 60;
    };
    const good = rate(95);
    const poor = rate(15);
    expect(good).toBeGreaterThan(0.75);
    expect(good).toBeGreaterThan(poor);
  });

  it('the stick aims the header: stick toward the left post side ends left of centre', () => {
    const out = createKickLaunch();
    let left = 0;
    for (let i = 0; i < 20; i++) {
      const s = quietScene({ seed: 50 + i });
      s.attrs[ATT]!.heading = 90;
      place(s, ATT, 42, 0);
      atContact(s, ATT, ActionKind.HEADER, KickKind.HEADER_SHOT, 0.5, 42.1, 1.9, 0, 0, -3, 14, AssistLevel.ASSISTED << 2);
      const p = s.players[ATT]!;
      p.actDirX = 0.8; p.actDirZ = -0.6;
      solveHeader(s, ATT, out);
      // z where it reaches the goal line (straight-line horizontal path; no curl on headers).
      const tGoal = (HALF_LENGTH - 42.1) / out.vx;
      if (out.vz * tGoal < 0) left++;
      expect(out.tz).toBeLessThan(0);
      expect(out.tz).toBeGreaterThanOrEqual(-GOAL_HALF_WIDTH);
    }
    expect(left).toBeGreaterThanOrEqual(16);
  });

  it('a header pass with a teammate in the stick direction is aimed at him; clearances go away from goal', () => {
    const out = createKickLaunch();
    const s = quietScene({ seed: 4 });
    place(s, ATT, 10, 0);
    place(s, 10, 22, 6);
    atContact(s, ATT, ActionKind.HEADER, KickKind.HEADER_PASS, 0.5, 10.1, 1.9, 0, -8, -4, 0);
    s.players[ATT]!.actDirX = 0.9; s.players[ATT]!.actDirZ = 0.45;
    expect(solveHeader(s, ATT, out)).toBe(1);
    expect(out.kind).toBe(KickKind.HEADER_PASS);
    expect(out.target).toBe(10);
    expect(Math.hypot(out.tx - 22, out.tz - 6)).toBeLessThan(1);
    expect(Math.hypot(out.vx, out.vy, out.vz)).toBeLessThanOrEqual(LT.headerPassMaxSpeed + 1e-9);

    // Clearance by the away team defending +x: away from x = +52.5 (negative vx), upward, 13-19 m/s.
    const c = quietScene({ seed: 5 });
    place(c, DEF, 45, 1);
    atContact(c, DEF, ActionKind.HEADER, KickKind.HEADER_PASS, 0.8, 44.9, 2.0, 1, 10, -4, 6, 1);
    expect(solveHeader(c, DEF, out)).toBe(1);
    expect(out.vx).toBeLessThan(0);
    expect(out.vy).toBeGreaterThan(4);
    const v = Math.hypot(out.vx, out.vy, out.vz);
    expect(v).toBeGreaterThanOrEqual(LT.headerClearMin - 1e-9);
    expect(v).toBeLessThanOrEqual(LT.headerClearMax + 1e-9);
    expect(out.target).toBe(-1);
  });

  it('a human header pass in the own half with nobody to find becomes a clearance', () => {
    const out = createKickLaunch();
    const s = quietScene({ seed: 6 });
    for (let i = 1; i < 11; i++) place(s, i, 30, -30 + i * 5); // teammates far away in the other half
    place(s, ATT, -40, 0);
    atContact(s, ATT, ActionKind.HEADER, KickKind.HEADER_PASS, 0.5, -40.1, 1.9, 0, -10, -3, 0);
    s.players[ATT]!.actDirX = -1; s.players[ATT]!.actDirZ = 0; // stick toward the own goal
    solveHeader(s, ATT, out);
    expect(out.vx).toBeGreaterThan(0);
    expect(out.vy).toBeGreaterThan(4);
  });

  it('solvers change nothing but the RNG', () => {
    const out = createKickLaunch();
    for (const [act, kind] of [[ActionKind.HEADER, KickKind.HEADER_SHOT], [ActionKind.HEADER, KickKind.HEADER_PASS],
      [ActionKind.VOLLEY, KickKind.VOLLEY_SHOT], [ActionKind.VOLLEY, KickKind.VOLLEY_PASS]] as const) {
      const s = quietScene({ seed: 9 });
      place(s, ATT, 40, 0);
      atContact(s, ATT, act, kind, 0.5, 40.2, act === ActionKind.HEADER ? 1.9 : 0.8, 0, -2, -3, 12);
      const before = cloneState(s);
      (act === ActionKind.HEADER ? solveHeader : solveVolley)(s, ATT, out);
      s.rng.a = before.rng.a; s.rng.b = before.rng.b; s.rng.c = before.rng.c; s.rng.d = before.rng.d;
      expect(diffState(before, s)).toBeNull();
      expect(Number.isFinite(out.vx + out.vy + out.vz)).toBe(true);
    }
  });
});

describe('SIM-12 contact phase guards', () => {
  /** A header attempt by ATT on a flight whose ball passes through his head this tick. */
  function contactTick(): { s: SimState; ev: ReturnType<typeof createEventBuffer> } {
    const s = quietScene({ seed: 11 });
    place(s, ATT, 40, 0, { height: 180 }, 1);
    const p = s.players[ATT]!;
    const head = aerialHeadY(s, ATT);
    p.act = ActionKind.HEADER; p.actKick = KickKind.HEADER_SHOT; p.actPower = 0.6; p.actT = 12; p.actContact = 12;
    p.actDur = 40; p.actDone = 0; p.actCurve = head; p.actX = 40.1; p.actZ = 0; p.actA = 0; p.actSlot = -1;
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.grounded = 0;
    b.px = 39.9; b.py = head + 0.15; b.pz = 0.3; b.x = 40.2; b.y = head; b.z = 0; b.vx = -2; b.vy = -3; b.vz = -14;
    b.lastTouch = 7; b.lastTouchTeam = 0; b.lastTouchTick = 3; p.actB = 3;
    s.tick = 100;
    const ev = createEventBuffer();
    ev.begin(s.tick);
    return { s, ev };
  }

  it('the attempt meets the ball: AERIAL, KICK of HEADER_SHOT, attempt done, ball touched by him', () => {
    const { s, ev } = contactTick();
    aerialContacts(s, ev);
    const types = Array.from({ length: ev.count }, (_, i) => ev.get(i).type);
    expect(types).toContain(EventType.AERIAL);
    expect(types).toContain(EventType.KICK);
    expect(s.ball.lastTouch).toBe(ATT);
    expect(s.ball.lastKickKind).toBe(KickKind.HEADER_SHOT);
    expect(s.players[ATT]!.actDone).toBe(1);
    expect(s.ball.y).toBeGreaterThanOrEqual(BALL_RADIUS);
  });

  it('keeper priority: a ball already played this tick (GKP runs first) is not headed', () => {
    const { s, ev } = contactTick();
    s.ball.touchedTick = s.tick;
    aerialContacts(s, ev);
    expect(ev.count).toBe(0);
    expect(s.players[ATT]!.actDone).toBe(0);
    expect(s.ball.lastTouch).toBe(7);
  });

  it('no double contact: the winner cannot touch the same ball again on the following ticks', () => {
    const { s, ev } = contactTick();
    aerialContacts(s, ev);
    expect(s.ball.lastTouch).toBe(ATT);
    // Next tick, the ball still within reach (put it back on the head): nothing happens.
    s.tick++;
    ev.begin(s.tick);
    const b = s.ball;
    b.px = b.x; b.py = b.y; b.pz = b.z;
    aerialContacts(s, ev);
    let aerials = 0;
    for (let i = 0; i < ev.count; i++) if (ev.get(i).type === EventType.AERIAL) aerials++;
    expect(aerials).toBe(0);
  });

  it('an attempt aborts when someone else plays the ball first (flight changed)', () => {
    const { s } = contactTick();
    recordTouch(s, 3);
    ACTION_HANDLERS[ActionKind.HEADER]!.update(s, ATT, createEventBuffer());
    const p = s.players[ATT]!;
    expect(p.actDone).toBe(1);
    expect(p.actDur).toBeLessThanOrEqual(40);
    expect(p.actDur).toBeGreaterThanOrEqual(p.actT);
  });

  it('a ball already wholly over the touchline at the contact point is not played (out of play stays out)', () => {
    const s = quietScene({ seed: 12 });
    place(s, ATT, 10, 33.7, { height: 180 }, 1);
    const p = s.players[ATT]!;
    p.fx = 0; p.fz = 1;
    const head = aerialHeadY(s, ATT);
    p.act = ActionKind.HEADER; p.actKick = KickKind.HEADER_PASS; p.actPower = 0.6; p.actT = 12; p.actContact = 12;
    p.actDur = 40; p.actDone = 0; p.actCurve = head; p.actX = 10; p.actZ = 34.2; p.actA = 0; p.actSlot = -1;
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.grounded = 0;
    b.px = 9.8; b.py = head; b.pz = 34.2; b.x = 10.2; b.y = head; b.z = 34.25; b.vx = 20; b.vy = 0; b.vz = 2;
    b.lastTouch = 7; b.lastTouchTeam = 0; b.lastTouchTick = 3; p.actB = 3;
    b.cross = 2; b.crossX = 9.8; b.crossZ = 34.11; b.crossEnd = 0;
    s.tick = 100;
    const ev = createEventBuffer();
    ev.begin(s.tick);
    aerialContacts(s, ev);
    expect(ev.count).toBe(0);
    expect(s.ball.lastTouch).toBe(7);
    expect(s.ball.cross).toBe(2);
  });

  it('a ball that has wholly crossed the line before the contact point is not played; one in front of it is', () => {
    const { s, ev } = contactTick();
    // Same contact, but this tick's crossing recorded later in the segment (the ball would have gone out): undone.
    s.ball.cross = 2; s.ball.crossX = 40; s.ball.crossZ = 34.11;
    aerialContacts(s, ev);
    expect(s.ball.lastTouch).toBe(ATT);
    expect(s.ball.cross).toBe(0);
  });
});

describe('SIM-12 reach estimate', () => {
  it('mirrors SIM-04 ticksToReach (standing, running toward, across and away, tired)', () => {
    const s = quietScene({ seed: 1 });
    const p = s.players[ATT]!;
    let worst = 0;
    for (const sp of [0, 2, 5, 8]) {
      for (const heading of [0, 0.8, 1.6, 2.4, 3.1]) {
        for (const stamina of [1, 0.3]) {
          for (const [tx, tz] of [[3, 0], [0, 4], [-5, 2], [8, -6], [1, 1], [-2, -9]] as const) {
            place(s, ATT, 10, 0);
            p.vx = sp * Math.cos(heading); p.vz = sp * Math.sin(heading); p.stamina = stamina;
            const mine = aerialReachTicks(s, ATT, 10 + tx, tz);
            const ref = ticksToReach(s, ATT, 10 + tx, tz);
            worst = Math.max(worst, Math.abs(mine - ref));
          }
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1);
  });
});
